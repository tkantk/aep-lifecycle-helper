import fs from 'node:fs';
import { q, db } from '../db.js';
import { logger } from '../utils/logger.js';
import { runExpansion } from './expansion.js';
import { getWorkOrder } from '../services/hygiene.js';
import { decryptCreds } from '../utils/crypto.js';
import { reactivate, markAccepted, release } from '../services/quotaManager.js';
import { isWorkOrderPosting, markReconciling, unmarkReconciling, isWorkOrderReconciling } from './postingState.js';

/**
 * Compare-and-swap wrapper for a reconcile write (review R9 #1). A reconcile
 * reads the orphan, then AWAITS an Adobe lookup; during that await the operator
 * could release + retry the WO. Applying the (now stale) lookup result would
 * corrupt local state. So every reconcile write goes through here: in one
 * transaction, re-read the WO's `attempt`; only run the writes if it still
 * equals the value snapshotted before the lookup. Returns true if applied,
 * false if the result was stale and discarded.
 */
function applyIfUnchanged(woId, snapshotAttempt, writeFn) {
  return db.transaction(() => {
    const cur = q().getWorkOrderAttempt.get(woId);
    if (!cur || cur.attempt !== snapshotAttempt) return false;   // changed during the lookup → stale
    writeFn();
    return true;
  })();
}

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
 *      Reconciliation: best-effort attempt to locate by the exact persisted
 *      displayName (R6 #2) via Adobe's list endpoint. If FOUND, record the Adobe
 *      ID + markAccepted and move on. If NOT found, we do NOT conclude absence —
 *      work-order creation is async with no read-after-write guarantee, so a
 *      missing entry may just be lag. We leave the WO in 'submitting' and HOLD
 *      its reservation (INDETERMINATE, review R6 #1); the operator reconciles.
 *      Auto-rolling back would risk a duplicate irreversible delete on retry.
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
 * On FOUND → record Adobe ID + markAccepted (monitor takes over).
 * On "not found" → INDETERMINATE: leave in 'submitting', hold the reservation
 *   (absence is NOT proven — async creation may lag); operator reconciles.
 * On transient error / 400 indeterminate → leave as-is; next startup retries.
 */
export async function reconcileOrphanWorkOrders() {
  const orphans = q().listSubmittingOrphanOrders.all();
  if (orphans.length === 0) return 0;

  logger.info({ count: orphans.length }, 'recovery: reconciling orphan submitting work orders');

  // Mark EVERY snapshotted orphan as reconciling UP FRONT (synchronously, before
  // the first await), so release-absent is refused for any of them from the
  // moment this run starts until each is individually processed — closing the
  // window where the operator could release+retry a WO before the loop reaches
  // it (review R9 #1). The guard is REFCOUNTED, so we must unmark each WO exactly
  // ONCE per run; `marked` tracks what this run still holds so the per-WO finally
  // and the outer safety-net finally can't double-decrement (R9 follow-up).
  const marked = new Set();
  for (const wo of orphans) { markReconciling(wo.id); marked.add(wo.id); }

  try {
    for (const wo of orphans) {
      try {
        // Skip a WO whose POST is still in flight in this process — let it settle
        // (its own 2xx/catch will resolve it); reconciling it now would race the
        // POST. The next reconcile picks it up if still unresolved.
        if (isWorkOrderPosting(wo.id)) continue;

        const snapshotAttempt = wo.attempt ?? 0;
        const creds = await decryptCreds(wo.j_creds_id);
        // Prefer the EXACT displayName persisted before the POST (R6 #2) — it
        // matches Adobe's stored value even when a long job name was truncated.
        // Fall back to reconstruction for legacy rows submitted before R6 (their
        // name was `Delete <job.name> - WO <uuid>`).
        const displayName = wo.display_name || `Delete ${wo.j_name} - WO ${wo.id}`;
        const found = await findAdobeWorkOrderByDisplayNamePrefix({
          creds,
          sandboxName: wo.j_sandbox_name,
          prefix: displayName,
        });

        if (found === __testInternal__.LOOKUP_INDETERMINATE) {
          // Adobe couldn't tell us whether this orphan exists — leaving it
          // in 'submitting' is the safe choice. A subsequent startup will
          // retry the lookup. (No write → no CAS needed.)
          logger.warn({ localId: wo.id },
            'recovery: lookup indeterminate (400 from list endpoint); leaving orphan in submitting');
        } else if (found) {
          // CAS: only apply if the WO didn't change during the awaited lookup
          // (operator release+retry would have bumped `attempt`) — review R9 #1.
          const applied = applyIfUnchanged(wo.id, snapshotAttempt, () => {
            q().updateWorkOrderSubmitted.run({
              id: wo.id,
              adobeWorkorderId: found.workorderId,
              adobeStatus: found.status,
              bundleId: found.bundleId,
              submittedAt: found.createdAt,
            });
            // Adobe HAS this WO → promote the still-pending reservation to
            // accepted so it's held, not refunded by a later release (review R5).
            markAccepted(wo.id);
          });
          if (applied) {
            logger.info({ localId: wo.id, adobeId: found.workorderId },
              'recovery: matched orphan to existing Adobe work order');
          } else {
            logger.warn({ localId: wo.id },
              'recovery: discarded a STALE lookup result — WO changed during the lookup (R9 #1)');
          }
        } else {
          // Adobe's list responded but shows no match. This does NOT prove Adobe
          // never received the (uncertain) POST — work-order creation is async
          // with no read-after-write guarantee, so the WO may simply not be
          // listed yet. Rolling back + releasing would risk a DUPLICATE
          // irreversible delete (review R6 #1). Treat as INDETERMINATE: hold the
          // reservation, keep the WO in 'submitting'. CAS-guarded so a stale
          // no-match can't revert a WO that changed during the lookup.
          applyIfUnchanged(wo.id, snapshotAttempt, () => {
            q().updateWorkOrderStatus.run('submitting',
              'submission outcome unconfirmed: not yet listed in Adobe (async creation may lag). ' +
              'Left for operator reconciliation — verify in Adobe before any retry.', wo.id);
          });
          logger.warn({ localId: wo.id },
            'recovery: orphan not yet listed in Adobe — INDETERMINATE, left in submitting (no rollback, no release)');
        }
      } catch (err) {
        // Transient error — leave the orphan alone and retry on next startup.
        logger.warn({ localId: wo.id, err: err.message },
          'recovery: reconciliation failed; leaving orphan for next restart');
      } finally {
        // This WO is fully processed — release THIS run's reconcile hold for it
        // (exactly once; `marked.delete` returns false if already unmarked).
        if (marked.delete(wo.id)) unmarkReconciling(wo.id);
      }
    }
  } finally {
    // Safety net: release this run's hold on any WO not reached by a per-WO
    // finally (e.g. an unexpected throw in the loop) — each exactly once.
    for (const id of marked) unmarkReconciling(id);
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
 *   - null                  → Adobe responded successfully but the order is not
 *                             listed. This does NOT prove absence (async creation
 *                             may lag, no read-after-write contract) — the caller
 *                             treats it as INDETERMINATE and does NOT roll back.
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
 *   - NO MATCH (submitting) → absence is NOT proven (async creation may lag, no
 *                 read-after-write contract). INDETERMINATE: hold the reservation,
 *                 leave in 'submitting' for operator reconciliation (review R6 #1).
 *                 We never auto-roll-back — that risked a duplicate on retry.
 *   - NO MATCH (failed)     → a 4xx-rejected WO genuinely never processed. Leave
 *                 as-is (failed WOs are not re-submitted).
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

  // Guard release-absent for every snapshotted orphan for the whole run (R9 #1).
  // Refcounted + per-run `marked` set so the per-WO and outer finally unmark each
  // exactly once (R9 follow-up — concurrent reconciles must not over-decrement).
  const marked = new Set();
  for (const wo of orphans) { markReconciling(wo.id); marked.add(wo.id); }

  try {
    for (const wo of orphans) {
      try {
        if (isWorkOrderPosting(wo.id)) continue;     // let an in-flight POST settle

        const snapshotAttempt = wo.attempt ?? 0;
        const creds = await decryptCreds(wo.j_creds_id);
        // Exact persisted name (R6 #2), fallback to reconstruction for legacy rows.
        const displayName = wo.display_name || `Delete ${wo.j_name} - WO ${wo.id}`;
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
          // CAS: only apply if the WO didn't change during the awaited lookup
          // (operator release+retry would have bumped `attempt`) — review R9 #1.
          const applied = applyIfUnchanged(wo.id, snapshotAttempt, () => {
            if (wo.status === 'failed') {
              // 'failed' but Adobe actually processed it → re-activate the
              // reservation AS accepted (held until rollover, review R5).
              reactivate(wo.id);
            } else {
              // 'submitting' found in Adobe → the POST went through; promote the
              // still-pending reservation to accepted so it isn't refunded.
              markAccepted(wo.id);
            }
            q().updateWorkOrderSubmitted.run({
              id: wo.id,
              adobeWorkorderId: found.workorderId,
              adobeStatus: found.status,
              bundleId: found.bundleId,
              submittedAt: found.createdAt,
            });
          });
          if (applied) {
            matched++;
            logger.info({ localId: wo.id, adobeId: found.workorderId, prevStatus: wo.status },
              'reconcile: matched WO to existing Adobe work order');
          } else {
            logger.warn({ localId: wo.id },
              'reconcile: discarded a STALE lookup result — WO changed during the lookup (R9 #1)');
          }
          continue;
        }

        // Not found in Adobe.
        if (wo.status === 'submitting') {
          // No-match does NOT prove absence (async creation, no read-after-write
          // guarantee). INDETERMINATE — hold the reservation, keep 'submitting'
          // (review R6 #1). CAS-guarded against a stale revert.
          indeterminate++;
          applyIfUnchanged(wo.id, snapshotAttempt, () => {
            q().updateWorkOrderStatus.run('submitting',
              'submission outcome unconfirmed: not yet listed in Adobe (async creation may lag). ' +
              'Verify in Adobe before any retry.', wo.id);
          });
          logger.warn({ localId: wo.id },
            'reconcile: orphan not yet listed in Adobe — INDETERMINATE, left in submitting (no rollback)');
        } else {
          // status='failed' AND Adobe confirms absence → genuinely failed.
          stillFailed++;
          logger.info({ localId: wo.id }, 'reconcile: failed WO confirmed absent in Adobe; leaving as failed');
        }
      } catch (err) {
        perWoError++;
        logger.warn({ localId: wo.id, err: err.message },
          'reconcile: per-WO failure; leaving as-is');
      } finally {
        if (marked.delete(wo.id)) unmarkReconciling(wo.id);
      }
    }
  } finally {
    for (const id of marked) unmarkReconciling(id);
  }

  return { total: orphans.length, matched, rolledBack, indeterminate, stillFailed, perWoError };
}

/**
 * OPERATOR-CONFIRMED resolution for an indeterminate orphan (review R7 #1).
 *
 * Recovery deliberately NEVER auto-rolls-back an uncertain 'submitting' WO (a
 * no-match doesn't prove Adobe absence — R6 #1). That leaves a genuinely-absent
 * WO stuck until a HUMAN verifies, in Adobe's Data Lifecycle UI, that the work
 * order really does not exist there. This function is that human's escape hatch:
 * once they've confirmed absence, release the held reservation and reset the WO
 * to 'planned' so the next submit retries it cleanly.
 *
 * It is fail-closed against acting on work Adobe actually processed:
 *   - 404 if the WO doesn't belong to this job.
 *   - refuses (409) if the WO already has an adobe_workorder_id (Adobe acked it).
 *   - refuses (409) if the WO is NOT 'submitting'.
 *   - refuses (409) if its POST is CURRENTLY IN FLIGHT in this process (review
 *     R8 #1): 'submitting' means both "POST in flight" and "settled uncertain",
 *     and releasing a reservation whose POST may still 2xx would lose the hold
 *     and over-ship. We act only on a SETTLED uncertain orphan.
 *   - refuses (409) if a RECONCILIATION lookup is in flight for it (review R9 #1):
 *     that lookup is asking Adobe whether it already has the WO; releasing +
 *     retrying before the answer could create a DUPLICATE delete.
 *   - refuses (409) if its reservation is `accepted` (Adobe spent the quota).
 * It also bumps the WO's `attempt` counter so any reconcile that snapshotted the
 * old value discards its now-stale lookup result (CAS, review R9 #1).
 * The validation + guarded release + status reset run in ONE SQLite transaction
 * (review R8 #2) so a failure can never leave the reservation released while the
 * WO is still 'submitting'. The caller (route) additionally requires an explicit
 * confirmation flag.
 */
export function releaseAbsentOrphan(jobId, woId) {
  return db.transaction(() => {
    const wo = q().getWorkOrderByIdAndJob.get(woId, jobId);
    if (!wo) {
      const e = new Error('work order not found for this job');
      e.status = 404; e.code = 'not_found'; e.publicMessage = e.message; throw e;
    }
    if (wo.adobe_workorder_id) {
      const e = new Error('this work order has an Adobe work-order ID — Adobe accepted it, so it cannot be marked absent');
      e.status = 409; e.code = 'already_accepted'; e.publicMessage = e.message; throw e;
    }
    if (wo.status !== 'submitting') {
      const e = new Error(`only an unconfirmed 'submitting' work order can be marked absent (this one is '${wo.status}')`);
      e.status = 409; e.code = 'bad_state'; e.publicMessage = e.message; throw e;
    }
    if (isWorkOrderPosting(woId)) {
      const e = new Error('this work order\'s submission is still in flight to Adobe — wait for it to settle, then reconcile before marking it absent');
      e.status = 409; e.code = 'posting'; e.publicMessage = e.message; throw e;
    }
    if (isWorkOrderReconciling(woId)) {
      // A reconcile is actively asking Adobe whether it ALREADY has this WO.
      // Releasing + retrying now could create a duplicate if the lookup comes
      // back FOUND (review R9 #1). Make the operator wait for the answer.
      const e = new Error('a reconciliation lookup is in progress for this work order — wait for it to finish (it may find the WO in Adobe), then retry');
      e.status = 409; e.code = 'reconciling'; e.publicMessage = e.message; throw e;
    }
    const resv = q().getReservation.get(woId);
    if (resv && resv.accepted === 1) {
      const e = new Error('this work order\'s reservation is marked accepted (Adobe spent the quota) — it cannot be released');
      e.status = 409; e.code = 'accepted'; e.publicMessage = e.message; throw e;
    }
    release(woId);                                 // guarded WHERE accepted=0
    // Bump the attempt counter so any reconcile whose lookup is in flight (and
    // snapshotted the old attempt) discards its now-stale result (review R9 #1).
    q().bumpWorkOrderAttempt.run(woId);
    q().updateWorkOrderStatus.run('planned', null, woId);
    logger.info({ jobId, woId }, 'operator confirmed orphan absent in Adobe → released + reset to planned for retry');
    return { ok: true, woId, status: 'planned' };
  })();
}

/** Top-level entrypoint called by src/index.js after the DB is ready. */
export async function runStartupRecovery() {
  try {
    // GC orphan quota reservations (no surviving work order) that no longer
    // count: inactive ones, OR prior-month tombstones (already excluded from the
    // current-month SUM). A CURRENT-month active tombstone from a force-deleted
    // in-flight job is KEPT — Adobe spent it; it must keep counting until
    // rollover (review R5 #2).
    const currentMonth = new Date().toISOString().slice(0, 7);
    const gced = q().gcOrphanReservations.run(currentMonth).changes;
    if (gced > 0) logger.info({ orphanReservations: gced }, 'startup: GC\'d non-counting orphan quota reservations');

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
