import fs from 'node:fs';
import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { runExpansion } from './expansion.js';
import { getWorkOrder } from '../services/hygiene.js';
import { decryptCreds } from '../utils/crypto.js';
import { release, reactivate } from '../services/quotaManager.js';

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
      // Resume against the SAME column the operator chose at upload (review
      // blocker #4). source_column is stored as TEXT (index or header name);
      // re-apply the upload route's isNaN/Number coercion.
      column: (() => {
        const c = job.source_column ?? '0';
        return isNaN(c) ? c : Number(c);
      })(),
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
      // Display name assigned in submission.js: `Delete ${job.name} - WO ${wo.id}`
      // Use the full UUID so the match is unambiguous even if the job name
      // contains the substring " - WO " (F-009).
      const displayName = `Delete ${wo.j_name} - WO ${wo.id}`;
      const found = await findAdobeWorkOrderByDisplayNamePrefix({
        creds,
        sandboxName: wo.j_sandbox_name,
        prefix: displayName,
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
        // deactivate the WO's reservation (Adobe didn't process it) and roll
        // back — release is keyed by WO id, so it frees exactly this WO's
        // reservation in its own period (review R4 #1).
        release(wo.id);
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
 * Extract the work-order array from Adobe's list-endpoint response.
 *
 * Adobe's documented (2026-05) shape is `{ results: [...], total, count,
 * _links }`. We also accept a bare array and the legacy `workorders` / `items`
 * containers for forward/backward compatibility. Returns:
 *   - the array (possibly empty)  → recognized shape; absence of a match is
 *                                   a TRUSTWORTHY "not found"
 *   - null                        → shape NOT recognized; the caller must
 *                                   treat this as indeterminate and NOT roll
 *                                   back (we can't prove absence).
 */
function extractWorkOrderList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['results', 'workorders', 'items', 'children']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return null;
}

/**
 * Best-effort lookup of an existing Adobe work order by exact displayName.
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
    const list = extractWorkOrderList(data);
    // CRITICAL (fail closed): if we don't recognize the response shape we
    // CANNOT conclude the order is absent. Returning null here would roll the
    // orphan back to 'planned' and re-submit — a duplicate irreversible
    // delete if Adobe had actually processed the original POST. Adobe's live
    // list endpoint returns matches under `results`; older/other shapes used
    // `workorders`/`items`/a bare array. Anything else → INDETERMINATE.
    if (list === null) return LOOKUP_INDETERMINATE;
    // Use exact match now that the full UUID is embedded in the displayName
    // (F-009). The API filter may return approximate results; we re-check here.
    const match = list.find(w => (w.displayName || '') === prefix);
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

/**
 * Per-job orphan reconciliation triggered by `POST /api/jobs/:id/reconcile`.
 *
 * Looks at every WO for `jobId` that has no `adobe_workorder_id` AND status
 * in ('submitting', 'failed'), and for each one tries an Adobe-side lookup
 * by `displayName`. Three outcomes per WO:
 *
 *   - MATCHED   → Adobe has the WO. Record the Adobe ID and flip status to
 *                 'submitted'. If the WO was previously in 'failed' status,
 *                 RE-reserve the quota the buggy old release() call gave
 *                 back (via direct ledger upsert — bypasses the cap because
 *                 Adobe already spent it; our ledger needs to mirror reality).
 *
 *   - ABSENT (submitting) → Adobe responded successfully and the WO is not
 *                 there. Roll back to 'planned' and release the still-held
 *                 quota — next submit run can retry.
 *   - ABSENT (failed)     → Genuinely failed. Leave as-is.
 *
 *   - INDETERMINATE (Adobe rejected our lookup with 400) → leave as-is for
 *                 both statuses; next reconcile retries.
 *
 * Use case: the 2026-05-29 production incident where 3 work orders timed
 * out at the 60s axios timeout, got marked 'failed' (releasing their
 * quota), but Adobe actually received and processed them — operator saw
 * 10 WOs in Adobe's UI but only 7 in ours. This route lets the operator
 * reconcile without restarting the server.
 */
export async function reconcileJobOrphans(jobId) {
  const orphans = q().listReconcilableOrphansForJob.all(jobId);
  if (orphans.length === 0) {
    return { total: 0, matched: 0, rolledBack: 0, indeterminate: 0, stillFailed: 0, perWoError: 0 };
  }

  logger.info({ jobId, count: orphans.length }, 'reconcile: scanning orphans for job');

  let matched = 0, rolledBack = 0, indeterminate = 0, stillFailed = 0, perWoError = 0;

  for (const wo of orphans) {
    try {
      const creds = await decryptCreds(wo.j_creds_id);
      const displayName = `Delete ${wo.j_name} - WO ${wo.id}`;
      const found = await findAdobeWorkOrderByDisplayNamePrefix({
        creds,
        sandboxName: wo.j_sandbox_name,
        prefix: displayName,
      });

      if (found === LOOKUP_INDETERMINATE) {
        indeterminate++;
        logger.warn({ localId: wo.id, prevStatus: wo.status },
          'reconcile: lookup indeterminate (Adobe rejected list query); leaving as-is');
        continue;
      }

      if (found) {
        // Re-reserve quota for previously-'failed' WOs. The old buggy
        // catch-all release() in submission.js gave back quota that Adobe
        // had actually spent. Direct ledger upsert (bypasses the cap) is
        // the right tool — we're correcting the ledger to match reality,
        // not reserving fresh capacity.
        if (wo.status === 'failed') {
          // The WO was marked 'failed' (its reservation deactivated) but Adobe
          // actually processed it — re-activate the WO's reservation so the
          // ledger reflects the real spend (review R4 #1). The next seedFloor
          // (reading live /quota) and the monitor's complete() then move it into
          // adobe_floor. If there's no reservation row (legacy), this is a no-op
          // and the floor still picks it up via /quota on the next submit.
          reactivate(wo.id);
        }
        q().updateWorkOrderSubmitted.run({
          id: wo.id,
          adobeWorkorderId: found.workorderId,
          adobeStatus: found.status,
          bundleId: found.bundleId,
          submittedAt: found.createdAt,
        });
        matched++;
        logger.info({ localId: wo.id, adobeId: found.workorderId, prevStatus: wo.status },
          'reconcile: matched WO to existing Adobe work order');
        continue;
      }

      // Not found in Adobe.
      if (wo.status === 'submitting') {
        // Safe to roll back — Adobe didn't get it. Deactivate the WO's
        // reservation (keyed by WO id) so the next submit run can retry cleanly
        // (review R4 #1).
        release(wo.id);
        q().rollbackWorkOrderToPlanned.run(
          'reconcile: not found in Adobe — rolled back to planned', wo.id);
        rolledBack++;
        logger.info({ localId: wo.id }, 'reconcile: orphan rolled back to planned');
      } else {
        // status='failed' AND Adobe confirms absence → genuinely failed.
        stillFailed++;
        logger.info({ localId: wo.id }, 'reconcile: failed WO confirmed absent in Adobe; leaving as failed');
      }
    } catch (err) {
      perWoError++;
      logger.warn({ localId: wo.id, err: err.message },
        'reconcile: per-WO failure; leaving as-is');
    }
  }

  return { total: orphans.length, matched, rolledBack, indeterminate, stillFailed, perWoError };
}

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
