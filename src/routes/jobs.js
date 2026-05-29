import { Router } from 'express';
import { q, prepareStreamIdentitiesBySource } from '../db.js';
import { planWorkOrders, runSubmission } from '../runner/submission.js';
import { peek as peekQuota } from '../services/quotaManager.js';
import { getOrgQuota } from '../services/quotaApi.js';
import { decryptCreds } from '../utils/crypto.js';
import { liveProgress } from '../runner/expansion.js';
import { writeCsv } from '../utils/csv.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { registerUuidParamGuards } from '../middleware/security.js';
import path from 'node:path';

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

    // The actual submission runs async — we kick it off, return 200, and the
    // UI polls /work-orders for progress. Errors (including quota_unavailable
    // from runSubmission's pre-flight refresh) are logged; the operator sees
    // the deferred/failed state on the next /work-orders poll.
    runSubmission({ jobId: job.id, dayIndex, monthIndex }).catch(err =>
      logger.error({ jobId: job.id, err: err.message, code: err.code }, 'submission run crashed'));
    res.json({ ok: true });
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

export default router;
