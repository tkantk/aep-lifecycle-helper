import { Router } from 'express';
import { q } from '../db.js';
import { planWorkOrders, runSubmission } from '../runner/submission.js';
import { peek as peekQuota } from '../services/quotaManager.js';
import { decryptCreds } from '../utils/crypto.js';
import { liveProgress } from '../runner/expansion.js';
import { writeCsv } from '../utils/csv.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'node:path';

const router = Router();

router.get('/', (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    res.json(q().listJobs.all(limit, offset));
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
 *  already been submitted to Adobe — prevents duplicate irreversible deletes. */
router.post('/:id/plan', async (req, res, next) => {
  try {
    const job = q().getJob.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const result = planWorkOrders({
      jobId: job.id,
      datasetIds: job.dataset_ids,
      dailyLimit: job.daily_limit,
      targetServices: job.target_services_json ? JSON.parse(job.target_services_json) : null,
    });
    res.json(result);
  } catch (err) {
    if (err.name === 'ReplanForbiddenError') {
      return res.status(409).json({ error: 'replan_forbidden', message: err.message });
    }
    next(err);
  }
});

/** Kick off submission (fire-and-forget). Poll /work-orders for status. */
router.post('/:id/submit', async (req, res, next) => {
  try {
    const { dayIndex } = req.body;
    const job = q().getJob.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });

    runSubmission({ jobId: job.id, dayIndex }).catch(err =>
      logger.error({ jobId: job.id, err: err.message }, 'submission run crashed'));
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

/** Export all expanded identities as CSV. */
router.get('/:id/export', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const outPath = path.join(config.outputDir, `job_${jobId}_identities.csv`);
    const rows = q().streamIdentitiesBySource.iterate(jobId);
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
