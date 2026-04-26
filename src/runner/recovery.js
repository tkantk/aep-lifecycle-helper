import fs from 'node:fs';
import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { runExpansion } from './expansion.js';
import { getWorkOrder } from '../services/hygiene.js';
import { decryptCreds } from '../utils/crypto.js';
import { release } from '../services/quotaManager.js';

/**
 * Startup reconciliation for jobs and work orders left in flight when the
 * process was killed.
 *
 * Two concerns:
 *
 *   1. JOBS stuck in status='expanding'
 *      Rows were partially written to expanded_identities before the crash.
 *      We resume expansion, skipping source IDs already processed (fast set
 *      lookup via expanded_identities).
 *
 *   2. WORK ORDERS stuck in status='submitting' WITHOUT adobe_workorder_id
 *      The process died after reserve() but before (or during) the POST.
 *      Adobe may have received it or may not have — we don't know.
 *      Reconciliation: best-effort attempt to locate by displayName prefix via
 *      Adobe's list endpoint. If found, record the Adobe ID and move on. If
 *      not found, roll back to status='planned' and release the quota — the
 *      next submit run will reserve + retry cleanly.
 *
 *  Work orders with adobe_workorder_id (already submitted) don't need
 *  reconciliation — the 60s monitor tick picks them up and polls normally.
 */

/** Resume any jobs whose status is still 'expanding'. */
export async function resumeExpandingJobs() {
  const jobs = q().listExpandingJobs.all();
  if (jobs.length === 0) return 0;

  logger.info({ count: jobs.length }, 'recovery: resuming jobs stuck in expanding');

  for (const job of jobs) {
    if (!job.upload_path || !fs.existsSync(job.upload_path)) {
      logger.warn({ jobId: job.id, uploadPath: job.upload_path },
        'recovery: cannot resume expansion — upload file missing; marking failed');
      q().updateJobStatus.run('failed', 'upload file no longer exists on disk', job.id);
      continue;
    }

    // Build fast lookup of already-processed source IDs.
    const processedRows = q().processedSourceIdsForJob.all(job.id);
    const skipSourceIds = new Set(processedRows.map(r => r.source_id));

    // Fire-and-forget; progress is tracked in the DB. Errors are logged by
    // runExpansion itself.
    runExpansion({
      jobId: job.id,
      uploadPath: job.upload_path,
      sourceNamespace: job.source_namespace,
      sourceNamespaceId: job.source_namespace_id,
      credsId: job.creds_id,
      sandboxName: job.sandbox_name,
      column: 0,
      skipSourceIds,
    }).catch(err => {
      logger.error({ jobId: job.id, err: err.message }, 'recovery: resume failed');
    });
  }
  return jobs.length;
}

/**
 * Reconcile work orders stuck in 'submitting' with no adobe_workorder_id.
 * On success → no DB change (monitor takes over).
 * On "not found" → roll back to planned + release quota.
 * On transient error (network) → leave as-is; next startup retries.
 */
export async function reconcileOrphanWorkOrders() {
  const orphans = q().listSubmittingOrphanOrders.all();
  if (orphans.length === 0) return 0;

  logger.info({ count: orphans.length }, 'recovery: reconciling orphan submitting work orders');

  for (const wo of orphans) {
    try {
      const creds = await decryptCreds(wo.j_creds_id);
      const found = await findAdobeWorkOrderByDisplayNamePrefix({
        creds,
        sandboxName: wo.j_sandbox_name,
        // Display name prefix we assign in submission.js is:
        //   `Delete ${job.name} - WO ${wo.id.slice(0, 8)}`
        // The 8-char prefix of the local UUID is the unique part.
        prefix: `Delete ${wo.j_name} - WO ${wo.id.slice(0, 8)}`,
      });

      if (found === __testInternal__.LOOKUP_INDETERMINATE) {
        // Adobe couldn't tell us whether this orphan exists — leaving it
        // in 'submitting' is the safe choice. A subsequent startup will
        // retry the lookup. Operators can also reconcile manually via the
        // Adobe UI by searching for the displayName prefix.
        logger.warn({ localId: wo.id },
          'recovery: lookup indeterminate (400 from list endpoint); leaving orphan in submitting');
      } else if (found) {
        q().updateWorkOrderSubmitted.run({
          id: wo.id,
          adobeWorkorderId: found.workorderId,
          adobeStatus: found.status,
          bundleId: found.bundleId,
          submittedAt: found.createdAt,
        });
        logger.info({ localId: wo.id, adobeId: found.workorderId },
          'recovery: matched orphan to existing Adobe work order');
      } else {
        // Adobe responded successfully and the order is not there. Safe to
        // release quota and roll back. Pass job's monthly_limit so we don't
        // decrement the monthly ledger on jobs that had it disabled.
        release(creds.imsOrgId, wo.identifier_count, wo.j_monthly_limit);
        q().rollbackWorkOrderToPlanned.run('rolled back after process crash', wo.id);
        logger.info({ localId: wo.id }, 'recovery: rolled back orphan to planned');
      }
    } catch (err) {
      // Transient error — leave the orphan alone and retry on next startup.
      logger.warn({ localId: wo.id, err: err.message },
        'recovery: reconciliation failed; leaving orphan for next restart');
    }
  }
  return orphans.length;
}

/** Sentinel returned by the lookup when Adobe's list endpoint refused our
 *  query (400). We can't conclude "Adobe never received the orphan" from a
 *  failed listing — the orphan might exist on Adobe's side under a real
 *  workorderId. The reconciler must leave the row alone in that case so a
 *  later run can retry, instead of rolling back + duplicating on resubmit. */
const LOOKUP_INDETERMINATE = Symbol('lookup-indeterminate');

/**
 * Best-effort lookup of an existing Adobe work order by displayName prefix.
 * Uses the list endpoint (GET /data/core/hygiene/workorder).
 *
 * Returns:
 *   - the matching summary  → "found"
 *   - null                  → Adobe responded successfully and the order
 *                             does NOT exist (safe to roll back + release)
 *   - LOOKUP_INDETERMINATE  → Adobe rejected our query (400). We don't know
 *                             whether the original POST was processed, so
 *                             the caller must NOT roll back.
 */
async function findAdobeWorkOrderByDisplayNamePrefix({ creds, sandboxName, prefix }) {
  // Import lazily to avoid a circular: hygiene.js imports adobeClient which
  // imports imsAuth which doesn't touch this module, but recovery might be
  // imported during bootstrap before hygiene is fully resolved.
  const { createAdobeClient } = await import('../services/adobeClient.js');
  const { config } = await import('../config.js');

  const client = createAdobeClient(creds, sandboxName);
  const url = `${config.aep.gateway}/data/core/hygiene/workorder?displayName=${encodeURIComponent(prefix)}&limit=20`;
  try {
    const { data } = await client.get(url);
    const list = Array.isArray(data) ? data : (data?.workorders || data?.items || []);
    const match = list.find(w => (w.displayName || '').startsWith(prefix));
    if (!match) return null;
    return {
      workorderId: match.workorderId || match.id,
      status: match.status,
      bundleId: match.bundleId,
      createdAt: match.createdAt,
    };
  } catch (err) {
    // 400 = Adobe rejected the listing query (e.g. filter param not
    // supported in this API version). The original POST may or may not
    // have been processed; we can't tell. Signal indeterminacy so the
    // caller leaves the orphan untouched. A later startup can retry once
    // the filter works again, or an operator can reconcile manually.
    if (err.response?.status === 400) return LOOKUP_INDETERMINATE;
    throw err;
  }
}

export const __testInternal__ = { LOOKUP_INDETERMINATE };

/** Top-level entrypoint called by src/index.js after the DB is ready. */
export async function runStartupRecovery() {
  try {
    const [expanded, reconciled] = await Promise.all([
      resumeExpandingJobs(),
      reconcileOrphanWorkOrders(),
    ]);
    if (expanded > 0 || reconciled > 0) {
      logger.info({ expandingResumed: expanded, orphansReconciled: reconciled },
        'startup recovery complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'startup recovery error — continuing anyway');
  }
}
