import { Router } from 'express';
import { q } from '../db.js';
import { planWorkOrders, runSubmission, summarizeNamespaceGroups, assertPlannable, isSubmissionInFlight, resolvePlanScope } from '../runner/submission.js';
import { reconcileJobOrphans, releaseAbsentOrphan, resumeExpansionForJob, retryRejectedWorkOrder } from '../runner/recovery.js';
import { isWorkOrderReconciling } from '../runner/postingState.js';
import { peek as peekQuota } from '../services/quotaManager.js';
import { getOrgQuota } from '../services/quotaApi.js';
import { decryptCreds } from '../utils/crypto.js';
import { liveProgress } from '../runner/expansion.js';
import { registerAnalysisRoutes } from './analysisRoutes.js';
import { exportIdentitiesCsv } from '../runner/identityExport.js';
import { discardAnalysisReport } from '../runner/analysisReport.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { registerUuidParamGuards, UUID_RE } from '../middleware/security.js';
import path from 'node:path';
import fs from 'node:fs';

const router = Router();
registerUuidParamGuards(router);   // :id is the job UUID (used by /export, /plan, /submit, etc.)
registerAnalysisRoutes(router);    // /:id/analysis* — identity analysis (2026-10-06)

router.get('/', (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    res.json(q().listJobs.all(limit, offset));
  } catch (err) { next(err); }
});

/** Active-submissions feed for the Monitor tab.
 *  Returns:
 *    - rows:      list of jobs with ≥1 Adobe-acked work order, enriched
 *                 with aggregate counts. Sorted in-flight-first, then
 *                 by latest WO activity DESC. Capped by `limit`.
 *    - totals:    job-level dashboard counts (in_flight / has_failed /
 *                 all_completed / total) across ALL monitor-eligible jobs
 *                 matching the same search + sandbox filter — NOT capped.
 *    - sandboxes: distinct sandboxes among monitor-eligible jobs (search
 *                 filter applied, sandbox filter NOT applied) with per-
 *                 sandbox job count, for the filter chip row.
 *  Query params: ?limit=N (default 20, cap 100), ?search=…, ?sandbox=…
 */
router.get('/monitor', (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const search = String(req.query.search || '').trim();
    const sandbox = String(req.query.sandbox || '').trim();
    res.json({
      rows:      q().listMonitorJobs.all({ limit, search, sandbox }),
      totals:    q().monitorTotals.get({ search, sandbox }) || { in_flight: 0, has_failed: 0, all_completed: 0, total: 0 },
      sandboxes: q().monitorSandboxes.all({ search }),
    });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    // countIdentitiesByNamespace is a nested GROUP-BY over EVERY
    // expanded_identities row for the job (millions on a large job), and
    // better-sqlite3 runs it SYNCHRONOUSLY — freezing the single-threaded event
    // loop (UI + monitor) until it finishes. Real 2026-06-01 prod incident:
    // clicking a 1.6M-identity job "did nothing for a long time, then suddenly
    // opened". Only the Expand tab consumes byNamespace, so the hot
    // job-load/switch path skips it by default — opt in with ?breakdown=1.
    const byNamespace = req.query.breakdown === '1'
      ? q().countIdentitiesByNamespace.all(job.id)
      : null;
    const byWorkOrderStatus = q().countWorkOrdersByStatus.all(job.id)
      .reduce((a, r) => ({ ...a, [r.status]: r.count }), {});

    let quota = null;
    try {
      const creds = await decryptCreds(job.creds_id);
      quota = peekQuota(creds.imsOrgId, job.daily_limit, job.monthly_limit);
    } catch { /* credentials may have been removed */ }

    res.json({
      job: {
        ...job,
        target_services: job.target_services_json ? JSON.parse(job.target_services_json) : null,
      },
      breakdown: { byNamespace, byWorkOrderStatus },
      quota,
    });
  } catch (err) { next(err); }
});

/** Live expansion progress - avoids DB round-trip for hot reads. */
router.get('/:id/progress', (req, res) => {
  const live = liveProgress.get(req.params.id);
  const job = q().getJob.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({
    status: job.status,
    processed: live?.processed ?? job.processed_count,
    found: live?.found ?? job.found_count,
    total: job.total_source_ids,
    // What the expansion is doing right now (2026-10-09): 'resuming' (skipping
    // IDs already expanded: checked / skipped rows) or 'expanding'; `waiting` =
    // { inFlight, oldestMs } while no batch has come back from Adobe for a while.
    phase: live?.phase ?? null,
    checked: live?.checked ?? 0,
    skipped: live?.skipped ?? 0,
    waiting: live?.waiting ?? null,
  });
});

/** Build (or rebuild) the work-order plan. Refuses if any work order has
 *  already been submitted to Adobe — prevents duplicate irreversible deletes.
 *
 *  Phase 2: fetches Adobe /quota first so the planner can bucket work into
 *  months that match the org's current entitlement. If /quota fails AND we
 *  have no cache (24h hard floor), this returns 503 — the operator can't
 *  plan against unknown quota for a destructive workflow. */
router.post('/:id/plan', async (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }

    // Refuse BEFORE contacting Adobe when expansion hasn't finished (fix 4).
    // planWorkOrders enforces the same rule; this just fails fast.
    assertPlannable(job);
    // Scope (2026-10-06): validated up front too — an unknown value is a 400,
    // and "linked identities" on an expansion-off job is a 409 scope_unavailable.
    const scope = req.body?.scope;
    resolvePlanScope(job, scope);

    // Fetch live quota. If the credential is gone, fall back to job-row caps.
    let quota = null;
    try {
      const creds = await decryptCreds(job.creds_id);
      quota = await getOrgQuota(creds, { refresh: false });
    } catch (err) {
      if (err.code === 'quota_unavailable') {
        const e = new Error('Cannot plan: Adobe /quota is unreachable and no recent cache exists. Resolve connectivity, then retry.');
        e.status = 503; e.code = 'quota_unavailable'; e.publicMessage = e.message;
        return next(e);
      }
      // Credential decrypt failure or other — log and proceed with static caps.
      logger.warn({ jobId: job.id, err: err.message }, 'plan: /quota fetch failed, falling back to static caps');
    }

    const result = planWorkOrders({
      jobId: job.id,
      datasetIds: job.dataset_ids,
      dailyLimit: job.daily_limit,
      targetServices: job.target_services_json ? JSON.parse(job.target_services_json) : null,
      quota,
      scope,
    });
    res.json({ ...result, quota });
  } catch (err) {
    if (err.name === 'ReplanForbiddenError') {
      return res.status(409).json({ error: 'replan_forbidden', message: err.message });
    }
    next(err);   // PlanNotReadyError carries status 409 + code 'not_expanded'
  }
});

/** Resume a FAILED identity expansion where it stopped (2026-10-06 fix 4).
 *  Only for a job that failed during expansion and has no work orders (a plan
 *  built on top would not include the identities the resume adds). Sources
 *  that already have rows are skipped. Fire-and-forget; poll /progress. */
router.post('/:id/resume-expansion', (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    const refuse = (status, code, msg) => {
      const err = new Error(msg);
      err.status = status; err.code = code; err.publicMessage = msg;
      return next(err);
    };
    if (!job) return refuse(404, 'not_found', 'job not found');
    if (job.status !== 'failed') {
      return refuse(409, 'bad_state', `Only a job whose expansion failed can be resumed (this job is "${job.status}").`);
    }
    if (q().countWorkOrdersByStatus.all(job.id).length > 0) {
      return refuse(409, 'has_work_orders',
        'This job already has work orders, so its expansion cannot be resumed — the plan would not ' +
        'include the identities a resume adds. Upload the CSV as a new job instead.');
    }
    if (!job.upload_path || !fs.existsSync(job.upload_path)) {
      return refuse(409, 'upload_missing', 'The uploaded CSV for this job is no longer on disk — upload it again as a new job.');
    }

    // Leave 'failed' synchronously so a second click is refused (409 bad_state)
    // instead of starting a second, overlapping run.
    q().updateJobStatus.run('expanding', null, job.id);
    resumeExpansionForJob(job).catch(err => {
      logger.error({ jobId: job.id, err: err.message }, 'resume-expansion: run failed');
      // runExpansion records its own failures; this covers anything that threw
      // before it could (e.g. credentials no longer decryptable).
      if (q().getJob.get(job.id)?.status === 'expanding') {
        q().updateJobStatus.run('failed', `resume failed: ${err.message}`, job.id);
      }
    });
    logger.info({ jobId: job.id }, 'resume-expansion: started');
    res.json({ ok: true, resumed: true });
  } catch (err) { next(err); }
});

/** Kick off submission (fire-and-forget). Poll /work-orders for status.
 *  Body: { workOrderIds: string[] } — the EXACT work orders the operator
 *  confirmed (the Submit tab sends these). The server ships only those that
 *  are still planned/deferred, gated by the quota ledger as always; it never
 *  substitutes a different batch (2026-10-06 fix 1).
 *  Legacy body { dayIndex, monthIndex } still works (bucket resolved before
 *  re-labelling); omit everything to ship the next window (scheduler path). */
const MAX_SUBMIT_IDS = 1000;
router.post('/:id/submit', async (req, res, next) => {
  try {
    const { dayIndex, monthIndex, workOrderIds } = req.body || {};
    const job = q().getJob.get(req.params.id);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }

    // A request runSubmission would silently skip must be refused VISIBLY: the
    // route answers {ok:true} before the run starts, so an early no-op return
    // there would never reach the operator (2026-10-06 review).
    const busy = (code, msg) => {
      const err = new Error(msg);
      err.status = 409; err.code = code; err.publicMessage = msg;
      return next(err);
    };
    if (isSubmissionInFlight(job.id)) {
      return busy('submission_in_progress',
        'A submission for this job is still running. Wait until its work orders show submitted or deferred, then submit the next batch.');
    }
    if (job.status === 'expanding') {
      return busy('expansion_running', 'This job\'s identity expansion is still running — nothing can be submitted until it finishes.');
    }

    // Validate synchronously so a malformed request never starts a run.
    if (workOrderIds !== undefined) {
      const invalid = (msg) => {
        const err = new Error(msg);
        err.status = 400; err.code = 'invalid_work_order_ids'; err.publicMessage = msg;
        return next(err);
      };
      if (!Array.isArray(workOrderIds) || workOrderIds.length === 0) {
        return invalid('workOrderIds must be a non-empty array of work-order IDs');
      }
      if (workOrderIds.length > MAX_SUBMIT_IDS) {
        return invalid(`workOrderIds may list at most ${MAX_SUBMIT_IDS} work orders`);
      }
      if (!workOrderIds.every(id => typeof id === 'string' && UUID_RE.test(id))) {
        return invalid('every workOrderIds entry must be a work-order UUID');
      }
      const ownIds = new Set(q().listWorkOrderMetaForJob.all(job.id).map(w => w.id));
      const foreign = workOrderIds.filter(id => !ownIds.has(id));
      if (foreign.length > 0) {
        return invalid(`${foreign.length} of the submitted work-order IDs do not belong to this job`);
      }
    }

    // The actual submission runs async — we kick it off and return 200. So a
    // preflight failure (e.g. quota_unavailable) isn't lost, PERSIST it to the
    // job on rejection, making it observable via GET /api/jobs/:id instead of
    // only logged (review finding #10). The UI polls and surfaces
    // job.last_error. On a SUCCESSFUL run, runSubmission's final
    // updateJobStatus(..., null, ...) clears last_error — so we deliberately do
    // NOT clear here (a clear-at-start could be wiped by a no-op concurrent
    // submit and erase a real error).
    runSubmission({ jobId: job.id, dayIndex, monthIndex, workOrderIds }).catch(err => {
      logger.error({ jobId: job.id, err: err.message, code: err.code }, 'submission run crashed');
      try {
        const prefix = err.code === 'quota_unavailable' ? 'Submit blocked: ' : 'Submit failed: ';
        q().setJobError.run(prefix + (err.message || String(err)), job.id);
      } catch (e) { logger.warn({ jobId: job.id, err: e.message }, 'failed to persist submit error'); }
    });
    res.json({ ok: true, async: true });
  } catch (err) { next(err); }
});

// Polled every 2 s by the Submit tab, so it must stay cheap at any job size:
// metadata columns only, with per-namespace counts from ns_summary_json. The
// identity list itself (~6 MB per 100k-identifier order) is never read here —
// except ONCE for a legacy row planned before ns_summary_json existed, whose
// summary is computed and persisted so later polls skip the parse.
router.get('/:id/work-orders', (req, res, next) => {
  try {
    const rows = q().listWorkOrderMetaForJob.all(req.params.id).map(r => {
      let namespaces;
      if (r.ns_summary_json) {
        namespaces = JSON.parse(r.ns_summary_json);
      } else {
        const payload = q().getWorkOrderPayload.get(r.id)?.namespaces_identities || '[]';
        namespaces = summarizeNamespaceGroups(JSON.parse(payload));
        q().setWorkOrderNsSummary.run(JSON.stringify(namespaces), r.id);
      }
      const { ns_summary_json: _summary, ...rest } = r;
      return { ...rest, namespaces };
    });
    res.json(rows);
  } catch (err) { next(err); }
});

/** Approve a specific month's work orders: flip awaiting_approval → planned.
 *  Body: { monthIndex: number } (must be ≥ 2; Month 1 is always auto-approved).
 *  Returns { ok: true, approved: N, monthIndex: N } — count of WOs newly made
 *  eligible for submission. */
router.post('/:id/approve-month', (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }

    const monthIndex = Number(req.body?.monthIndex);
    if (!Number.isInteger(monthIndex) || monthIndex < 2) {
      const err = new Error('monthIndex must be an integer ≥ 2 (Month 1 needs no approval)');
      err.status = 400; err.code = 'invalid_request'; err.publicMessage = err.message;
      return next(err);
    }

    const result = q().approveMonth.run(job.id, monthIndex);
    if (result.changes === 0) {
      const err = new Error(`No work orders awaiting approval for Month ${monthIndex}`);
      err.status = 404; err.code = 'not_found'; err.publicMessage = err.message;
      return next(err);
    }

    logger.info({ jobId: job.id, monthIndex, approved: result.changes }, 'month approved for submission');
    res.json({ ok: true, approved: result.changes, monthIndex });
  } catch (err) { next(err); }
});

/** Reconcile every work order on the job that has no `adobe_workorder_id`
 *  AND status in ('submitting', 'failed') against Adobe by displayName.
 *
 *  Critical use case: a 60s axios timeout on submit can leave the WO marked
 *  `failed` locally even though Adobe processed the request — operator sees
 *  fewer WOs in our UI than in Adobe's Data Lifecycle UI. This route looks
 *  each one up and corrects the local record (recording the Adobe WO ID
 *  and re-reserving the quota that the previous `failed` path released).
 *
 *  Response: { matched, rolledBack, indeterminate, stillFailed, perWoError, total }
 *
 *  - matched        → found in Adobe, status now 'submitted', Adobe ID recorded
 *                     (markAccepted, or reactivate if it was 'failed')
 *  - indeterminate  → a 'submitting' WO with NO match (absence unproven — async
 *                     creation may lag) OR a 400 from the lookup. Left in
 *                     'submitting' with its reservation HELD for operator
 *                     reconciliation; NEVER auto-rolled-back (review R6 #1).
 *  - stillFailed    → 'failed' WO not listed in Adobe — left as 'failed' but
 *                     AMBIGUOUS (a no-match doesn't prove absence, R6 #1); stays
 *                     failure_definitive=0 so ordinary delete fail-closes (R11)
 *  - rolledBack     → always 0 (R6 #1 removed auto-rollback; field kept for
 *                     response-shape stability)
 *  - perWoError     → other failures (credentials missing, network) — left as-is
 */
router.post('/:id/reconcile', async (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }
    const result = await reconcileJobOrphans(job.id);
    logger.info({ jobId: job.id, ...result }, 'reconcile complete');
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

/** Operator-confirmed resolution for an indeterminate orphan (review R7 #1).
 *  The operator must have VERIFIED in Adobe's Data Lifecycle UI (by the WO's
 *  persisted displayName) that the work order does not exist there. Requires
 *  `{ confirmedAbsent: true }`. Releases the held reservation and resets the WO
 *  to 'planned' for a clean retry. Fail-closed: refuses any WO Adobe acked
 *  (has an Adobe ID, or an accepted reservation) — see releaseAbsentOrphan. */
router.post('/:id/work-orders/:woId/release-absent', (req, res, next) => {
  try {
    if (req.body?.confirmedAbsent !== true) {
      const err = new Error('confirmedAbsent: true is required — verify in Adobe that this work order does not exist before releasing it for retry (releasing a WO Adobe actually processed would create a duplicate delete)');
      err.status = 400; err.code = 'confirmation_required'; err.publicMessage = err.message;
      return next(err);
    }
    const result = releaseAbsentOrphan(req.params.id, req.params.woId);
    res.json(result);
  } catch (err) { next(err); }
});

/** Re-queue a work order Adobe definitively REJECTED (HTTP 4xx before
 *  processing, or a local validation failure) so the next Submit retries it
 *  (2026-10-06 fix 5). Refuses anything whose outcome is not proven
 *  rejected — see recovery.js::retryRejectedWorkOrder. */
router.post('/:id/work-orders/:woId/retry-rejected', (req, res, next) => {
  try {
    res.json(retryRejectedWorkOrder(req.params.id, req.params.woId));
  } catch (err) { next(err); }
});

/** Export all expanded identities as CSV.
 *  Uses a FRESH prepared Statement (not q().streamIdentitiesBySource) so two
 *  overlapping export requests — or one export overlapping the planner —
 *  can't collide on the shared cached Statement's single-iterator-per-stmt
 *  rule in better-sqlite3 ("This statement is busy executing a query"). */
router.get('/:id/export', async (req, res, next) => {
  // Built in a worker thread on its own read-only connection (2026-10-06):
  // SQLite groups every stored row before the first one — minutes on a large
  // job — and on the main thread that froze the server (and, iterating the
  // main connection, made concurrent writes throw "connection is busy").
  try {
    const jobId = req.params.id;
    const outPath = path.join(config.outputDir, `job_${jobId}_identities.csv`);
    await exportIdentitiesCsv({ jobId, outPath });
    res.download(outPath);
  } catch (err) { next(err); }
});

/** Hard-delete a job and everything associated with it: expanded identities,
 *  work orders, the uploaded CSV in data/uploads/, and any exported CSV in
 *  data/output/.
 *
 *  Refuses by default (HTTP 409) if any work order is still in flight to
 *  Adobe — those are real, irreversible destructive operations Adobe is
 *  currently executing and the local row is the only place we track the
 *  Adobe-issued workorder ID. Pass ?force=true (or ?force=1) to delete
 *  anyway; the Adobe-side deletions continue independently — only local
 *  tracking is lost.
 *
 *  States considered "in flight" (block without --force):
 *    submitting → POST to Adobe in progress
 *    submitted, received, validated, ingested → Adobe is processing it
 *  Also blocked without --force (review R11 #1):
 *    any WO with a reconciliation lookup in flight (deleting races it)
 *    a 'failed' WO with NO Adobe ID that is NOT a definitive 4xx — an
 *      ambiguous legacy/timeout outcome Adobe may actually have processed
 *  Safe to delete without --force:
 *    planned, deferred, awaiting_approval → never went to Adobe
 *    completed / Adobe-acked failed (has an ID) → terminal, reservation kept
 *      as a tombstone; definitive-4xx failed → Adobe never created it
 *
 *  Does NOT refund quota. The local ledger reflects what Adobe actually
 *  processed; force-deleting an in-flight WO doesn't un-consume that quota
 *  on Adobe's side, so we mustn't credit it back locally either. */
router.delete('/:id', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const job = q().getJob.get(jobId);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }

    const force = req.query.force === 'true' || req.query.force === '1';

    const IN_FLIGHT_STATES = new Set([
      'submitting', 'submitted', 'received', 'validated', 'ingested',
    ]);
    const wos = q().listWorkOrderMetaForJob.all(jobId);
    const inFlight = wos.filter(w => IN_FLIGHT_STATES.has(w.status));
    if (inFlight.length > 0 && !force) {
      const distinctStatuses = [...new Set(inFlight.map(w => w.status))].join(', ');
      const err = new Error(
        `Cannot delete: ${inFlight.length} work order(s) are still in flight to Adobe ` +
        `(${distinctStatuses}). Wait for them to reach a terminal state, or pass ` +
        `?force=true to delete anyway. Forcing does NOT cancel the Adobe-side deletions — ` +
        `it only removes local tracking, so you lose visibility into completion.`
      );
      err.status = 409; err.code = 'in_flight';
      err.publicMessage = err.message;
      err.inFlightCount = inFlight.length;
      return next(err);
    }

    // R11 #1 — fail closed on AMBIGUOUS work orders whose Adobe outcome isn't
    // settled, so an ordinary delete can't erase quota tracking for work Adobe
    // actually did. Two cases:
    //   (a) a reconciliation lookup is in flight for a WO — deleting now would
    //       race it (the lookup may find the WO in Adobe + re-reserve quota);
    //   (b) a 'failed' WO with NO Adobe ID that is NOT a definitive 4xx
    //       rejection — a legacy/timeout outcome Adobe may have processed.
    // The synchronous check + delete below means no reconcile can interleave
    // between this check and the cascade. ?force=true is the explicit operator
    // override (you may lose quota tracking for work Adobe actually did).
    const reconciling     = wos.filter(w => isWorkOrderReconciling(w.id));
    const ambiguousFailed = wos.filter(w => w.status === 'failed' && !w.adobe_workorder_id && !w.failure_definitive);
    if ((reconciling.length > 0 || ambiguousFailed.length > 0) && !force) {
      const reasons = [];
      if (reconciling.length > 0)     reasons.push(`${reconciling.length} being reconciled with Adobe right now`);
      if (ambiguousFailed.length > 0) reasons.push(`${ambiguousFailed.length} failed locally but never confirmed absent in Adobe (Adobe may have processed them)`);
      const err = new Error(
        `Cannot delete: ${reasons.join('; ')}. Run Reconcile — it auto-settles any work order Adobe ` +
        `actually has (recording its ID). For any that stay unconfirmed, Adobe's list is ` +
        `eventually-consistent so a missing entry does NOT prove absence: verify in Adobe's Data ` +
        `Lifecycle UI, then pass ?force=true to delete anyway (forcing may lose quota tracking for ` +
        `work Adobe actually performed).`
      );
      err.status = 409; err.code = 'unsettled';
      err.publicMessage = err.message;
      err.reconcilingCount = reconciling.length;
      err.ambiguousFailedCount = ambiguousFailed.length;
      return next(err);
    }

    // Drop this job's quota reservations FIRST (while its work_orders still
    // exist for the status subquery). STATUS-AWARE (review R5 #2): never-sent
    // (planned/deferred/awaiting_approval) and already-inactive reservations are
    // refunded; an ACTIVE reservation for a WO that WAS sent to Adobe is KEPT as
    // a tombstone (Adobe spent that quota — refunding it would over-ship). The
    // tombstone survives the cascade (no FK) and expires at period rollover.
    q().deleteReservationsForJob.run({ jobId });
    // CASCADE FK constraints on expanded_identities + work_orders collapse all
    // dependent rows in this single statement (the deletion is atomic).
    // Stop an Excel-report build for this job and remove its file (the
    // analysis rows go with the cascade below).
    discardAnalysisReport(jobId);
    q().deleteJob.run(jobId);

    // Best-effort filesystem cleanup. Failures here aren't fatal — the DB
    // rows are already gone — but we log them.
    if (job.upload_path) {
      try { await fs.promises.unlink(job.upload_path); }
      catch (e) { logger.warn({ jobId, path: job.upload_path, err: e.message }, 'upload cleanup failed (non-fatal)'); }
    }
    const exportPath = path.join(config.outputDir, `job_${jobId}_identities.csv`);
    try { await fs.promises.unlink(exportPath); }
    catch (e) { if (e.code !== 'ENOENT') logger.warn({ jobId, path: exportPath, err: e.message }, 'export cleanup failed (non-fatal)'); }

    logger.warn({
      jobId, force,
      workOrders: wos.length,
      inFlight: inFlight.length,
    }, 'job deleted');
    res.json({
      ok: true,
      deleted: jobId,
      workOrdersRemoved: wos.length,
      inFlightWorkOrdersOrphaned: inFlight.length,
    });
  } catch (err) { next(err); }
});

export default router;
