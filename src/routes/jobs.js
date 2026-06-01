import { Router } from 'express';
import { q, prepareStreamIdentitiesBySource } from '../db.js';
import { planWorkOrders, runSubmission } from '../runner/submission.js';
import { reconcileJobOrphans, releaseAbsentOrphan } from '../runner/recovery.js';
import { isWorkOrderReconciling } from '../runner/postingState.js';
import { peek as peekQuota } from '../services/quotaManager.js';
import { getOrgQuota } from '../services/quotaApi.js';
import { decryptCreds } from '../utils/crypto.js';
import { liveProgress } from '../runner/expansion.js';
import { writeCsv } from '../utils/csv.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { registerUuidParamGuards } from '../middleware/security.js';
import path from 'node:path';
import fs from 'node:fs';

const router = Router();
registerUuidParamGuards(router);   // :id is the job UUID (used by /export, /plan, /submit, etc.)

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

    const byNamespace = q().countIdentitiesByNamespace.all(job.id);
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
    });
    res.json({ ...result, quota });
  } catch (err) {
    if (err.name === 'ReplanForbiddenError') {
      return res.status(409).json({ error: 'replan_forbidden', message: err.message });
    }
    next(err);
  }
});

/** Kick off submission (fire-and-forget). Poll /work-orders for status.
 *  Body: { dayIndex?: number, monthIndex?: number }. Omit both to ship "the
 *  next available bucket" (lowest month with un-shipped WOs, Day 1 of that
 *  month). */
router.post('/:id/submit', async (req, res, next) => {
  try {
    const { dayIndex, monthIndex } = req.body || {};
    const job = q().getJob.get(req.params.id);
    if (!job) {
      const err = new Error('job not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'job not found';
      return next(err);
    }

    // The actual submission runs async — we kick it off and return 200. So a
    // preflight failure (e.g. quota_unavailable) isn't lost, PERSIST it to the
    // job on rejection, making it observable via GET /api/jobs/:id instead of
    // only logged (review finding #10). The UI polls and surfaces
    // job.last_error. On a SUCCESSFUL run, runSubmission's final
    // updateJobStatus(..., null, ...) clears last_error — so we deliberately do
    // NOT clear here (a clear-at-start could be wiped by a no-op concurrent
    // submit and erase a real error).
    runSubmission({ jobId: job.id, dayIndex, monthIndex }).catch(err => {
      logger.error({ jobId: job.id, err: err.message, code: err.code }, 'submission run crashed');
      try {
        const prefix = err.code === 'quota_unavailable' ? 'Submit blocked: ' : 'Submit failed: ';
        q().setJobError.run(prefix + (err.message || String(err)), job.id);
      } catch (e) { logger.warn({ jobId: job.id, err: e.message }, 'failed to persist submit error'); }
    });
    res.json({ ok: true, async: true });
  } catch (err) { next(err); }
});

router.get('/:id/work-orders', (req, res, next) => {
  try {
    const rows = q().getAllOrdersForJob.all(req.params.id).map(r => {
      const groups = JSON.parse(r.namespaces_identities || '[]');
      return {
        ...r,
        namespaces: groups.map(g => ({
          code: g.namespace.code || null,
          id: g.namespace.id || null,
          count: g.ids.length,
        })),
        // Strip the full id lists from the list view - too chatty for the UI
        namespaces_identities: undefined,
      };
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
 *  - stillFailed    → 'failed' WO confirmed absent in Adobe → left as 'failed'
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

/** Export all expanded identities as CSV.
 *  Uses a FRESH prepared Statement (not q().streamIdentitiesBySource) so two
 *  overlapping export requests — or one export overlapping the planner —
 *  can't collide on the shared cached Statement's single-iterator-per-stmt
 *  rule in better-sqlite3 ("This statement is busy executing a query"). */
router.get('/:id/export', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const outPath = path.join(config.outputDir, `job_${jobId}_identities.csv`);
    const rows = prepareStreamIdentitiesBySource().iterate(jobId);
    function* iter() {
      for (const r of rows) {
        yield {
          source_id: r.source_id,
          namespace_code: r.ns_code || '',
          namespace_id: r.ns_id || '',
          identity: r.identity_id,
        };
      }
    }
    await writeCsv(outPath, ['source_id', 'namespace_code', 'namespace_id', 'identity'], iter());
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
    const wos = q().getAllOrdersForJob.all(jobId);
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
        `Cannot delete: ${reasons.join('; ')}. Run Reconcile first to settle their Adobe status, ` +
        `or pass ?force=true to delete anyway — forcing may lose quota tracking for work Adobe actually performed.`
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
