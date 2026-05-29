import pLimit from 'p-limit';
import { v4 as uuid } from 'uuid';
import { submitWorkOrder } from '../services/hygiene.js';
import { reserve, release } from '../services/quotaManager.js';
import { getOrgQuota } from '../services/quotaApi.js';
import { redistributeUnshippedOrders } from './redistributor.js';
import { q, db, prepareStreamIdentitiesBySource } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { decryptCreds } from '../utils/crypto.js';

// Module-level set guards against two concurrent runSubmission calls for the
// same job in the same process (e.g. user double-clicks the Submit button).
const inFlight = new Set();

/**
 * Work-order planning and submission.
 *
 * The planner has to respect three orthogonal constraints at once:
 *
 *   A. ≤ 100,000 identities per work order   (Adobe hard limit)
 *   B. ≤ dailyLimit identities per calendar day  (Adobe daily cap)
 *   C. Keep identities from the same cluster together when it still fits,
 *      to minimize the number of work orders Profile Service has to
 *      reconcile downstream.
 *
 * Strategy:
 *   - Read identities in (source_id, ns_code) order - so all members of
 *     one cluster arrive contiguously.
 *   - Build "cluster bundles" on the fly. When adding a bundle would push
 *     the current work order past 100k, flush the order first.
 *   - When a single cluster is > 100k (rare but possible), the bundle is
 *     split across orders - acceptable because they still reference the
 *     same cluster by identity.
 *   - Day assignment happens as orders are flushed: if the current day's
 *     total + this order's size > dailyLimit, advance the day.
 */

/**
 * Build the work-order plan from expanded_identities.
 *
 * @param {object} p
 * @param {string} p.jobId
 * @param {string} p.datasetIds        "ALL" | "id1,id2,..."
 * @param {number} p.dailyLimit
 * @param {string[]|null} p.targetServices  e.g. ["identity","profile","ajo"]
 * @returns {{planned:number, days:number}}
 */
export class ReplanForbiddenError extends Error {
  constructor(message) { super(message); this.name = 'ReplanForbiddenError'; this.status = 409; }
}

export function planWorkOrders({ jobId, datasetIds, dailyLimit, targetServices, quota = null }) {
  // SAFETY: refuse to re-plan if any non-planned/non-deferred work orders exist
  // for this job. Otherwise re-running planning would re-emit work orders for
  // identities that were ALREADY submitted to Adobe, causing duplicate
  // irreversible deletions. (The planner builds from expanded_identities,
  // which still contains every identity regardless of whether it shipped.)
  // Deferred orders are fine to leave in place — they're just waiting for
  // quota rollover and never went to Adobe.
  const existing = q().countWorkOrdersByStatus.all(jobId);
  const blocking = existing.filter(r =>
    !['planned', 'deferred', 'awaiting_approval'].includes(r.status) && r.count > 0
  );
  if (blocking.length > 0) {
    const summary = blocking.map(r => `${r.status}=${r.count}`).join(', ');
    throw new ReplanForbiddenError(
      `Cannot re-plan: this job already has work orders in non-planned states (${summary}). ` +
      `Re-planning would risk duplicate irreversible deletions.`
    );
  }

  // Clear any previously planned (not yet submitted) orders before rebuilding the plan.
  // Without this, a second call to /plan would insert duplicate work orders that would
  // all be submitted to Adobe, causing duplicate irreversible deletions.
  q().deletePlannedOrders.run(jobId);

  const maxPerOrder = config.maxIdsPerWorkOrder;
  const targetServicesJson = targetServices?.length ? JSON.stringify(targetServices) : null;

  // ─── Accumulator state ────────────────────────────────────────────────
  // `current` is the work-order being built. Namespaces are keyed by CODE
  // (falling back to `nsid:<n>` when code is null) so custom namespaces
  // that only return numeric ids still dedup correctly.
  let current = makeEmptyOrder();

  let dayIndex = 1;
  let plannedThisDay = 0;
  let planned = 0;

  // `bundle` holds the identities of the current cluster being assembled.
  // When we cross a source_id boundary in the stream, we commit the bundle
  // to `current` (flushing `current` first if the bundle wouldn't fit).
  let bundle = [];
  let bundleSourceId = null;

  // Phase 1 accumulator: built up during streaming iteration, then bulk-
  // inserted in a single transaction in Phase 2 (see below). Keeping this
  // out of the DB during iteration is what lets us use .iterate() — the
  // big memory win over the previous .all()-then-write approach.
  const pendingOrders = [];

  const commitBundle = () => {
    if (bundle.length === 0) return;

    // If this bundle fits into the current order, merge it.
    if (current.total + bundle.length <= maxPerOrder) {
      for (const row of bundle) addToOrder(current, row);
    } else {
      // Flush what we have and start fresh with this bundle.
      flushOrder();
      if (bundle.length > maxPerOrder) {
        // Giant cluster: split it across multiple orders.
        for (let i = 0; i < bundle.length; i += maxPerOrder) {
          const slice = bundle.slice(i, i + maxPerOrder);
          for (const row of slice) addToOrder(current, row);
          if (current.total >= maxPerOrder) flushOrder();
        }
      } else {
        for (const row of bundle) addToOrder(current, row);
      }
    }
    bundle = [];
    bundleSourceId = null;
  };

  const flushOrder = () => {
    if (current.total === 0) return;
    if (plannedThisDay + current.total > dailyLimit) {
      dayIndex++;
      plannedThisDay = 0;
    }
    plannedThisDay += current.total;

    const groups = [...current.byNs.values()];
    pendingOrders.push({
      id: uuid(),
      jobId,
      dayIndex,
      datasetIds,
      targetServicesJson,
      namespacesIdentities: JSON.stringify(groups),
      identifierCount: current.total,
      status: 'planned',
    });
    planned++;
    current = makeEmptyOrder();
  };

  // ─── Two-phase planning ───────────────────────────────────────────────
  // Phase 1: stream identities with .iterate() — no DB writes during the
  //   loop, so better-sqlite3's "connection busy" lock doesn't trip.
  //   Builds work-order plans into `pendingOrders` (an array of JS objects).
  //   Streaming avoids materialising the deduplicated identity set in JS
  //   heap; on a 6M-unique-identity job that's ~480 MB → ~120 MB (plan only).
  //
  // Phase 2: bulk-insert all work orders in a single db.transaction so all
  //   rows are flushed to WAL in one fsync rather than one per WO. On
  //   Windows (where each fsync can take 10-50ms under Defender), this
  //   cuts planning time from ~minutes to ~seconds for 1500+ WO jobs.
  //
  // The two phases MUST stay strictly separated: better-sqlite3 locks the
  // connection while an iterator is active, so any insertWorkOrder.run()
  // call inside the iterate() loop would throw "This database connection
  // is busy executing a query".
  //
  // Use a fresh Statement (not the cached one) so a concurrent export
  // request can't collide with us, and vice versa. See the rationale on
  // prepareStreamIdentitiesBySource in db.js.
  for (const row of prepareStreamIdentitiesBySource().iterate(jobId)) {
    if (row.source_id !== bundleSourceId) {
      commitBundle();
      bundleSourceId = row.source_id;
    }
    bundle.push(row);
  }
  commitBundle();
  flushOrder();

  db.transaction(() => {
    for (const wo of pendingOrders) q().insertWorkOrder.run(wo);
  })();

  q().setPlannedOrders.run(planned, jobId);
  q().updateJobStatus.run('ready', null, jobId);

  // Phase 2: assign month_index + correct day_index using LIVE Adobe quota
  // (or the job's static caps if no quota was passed in / Adobe was
  // unreachable when the route handler called us). The bucket-based
  // dailyIndex computed above is a rough sketch — redistribute is the
  // authoritative numbering and the one the Plan UI reads.
  const previousMonths = q().getJob.get(jobId)?.projected_months ?? null;
  const distribution = redistributeUnshippedOrders(jobId, quota);
  const shifted = previousMonths != null && distribution.months > previousMonths;

  // Mark WOs in Month 2+ as awaiting_approval — they require explicit operator
  // sign-off before shipping. Month 1 stays 'planned' and is immediately eligible.
  q().markFutureMonthsAwaitingApproval.run(jobId);

  logger.info({
    jobId, planned,
    initialDays: dayIndex,
    finalMonths: distribution.months,
    finalDaysInLastMonth: distribution.days,
  }, 'planning complete');

  return {
    planned,
    days: distribution.days,                          // days within the last month
    months: distribution.months,                      // total months
    perMonthCounts: distribution.perMonthCounts,      // identifiers per month
    totalIdentifiers: distribution.totalIdentifiers,
    shiftedFromPrevious: shifted,
    previousMonths,
  };
}

function makeEmptyOrder() { return { byNs: new Map(), total: 0 }; }

function addToOrder(order, row) {
  // row: { ns_code, ns_id, identity_id, source_id }
  const key = row.ns_code || `nsid:${row.ns_id}`;
  let group = order.byNs.get(key);
  if (!group) {
    const namespace = {};
    if (row.ns_code) namespace.code = row.ns_code;
    if (row.ns_id != null) namespace.id = row.ns_id;
    group = { namespace, ids: [] };
    order.byNs.set(key, group);
  }
  group.ids.push(row.identity_id);
  order.total++;
}

/**
 * Submit planned work orders for a job.
 *
 * Quota is reserved atomically per-order in SQLite. If quota is exhausted,
 * the order is marked 'deferred' and left untouched - rerun after UTC midnight.
 *
 * Phase 2 changes:
 *   - Re-fetch Adobe /quota before picking work, and re-bucket un-shipped
 *     WOs against the live numbers. This is the "if someone else's app
 *     consumed quota since we planned, push our work to a later window"
 *     behavior the client asked for.
 *   - Accept `monthIndex` alongside `dayIndex`. When both are passed, only
 *     WOs in that exact bucket are submitted. The default (neither) means
 *     "ship the next-available bucket" — Day 1 of the lowest month with
 *     un-shipped WOs.
 *   - Returns extra metadata about the redistribution so callers can
 *     surface "your plan shifted from N to M months" notifications.
 */
export async function runSubmission({ jobId, dayIndex, monthIndex } = {}) {
  if (inFlight.has(jobId)) {
    logger.warn({ jobId }, 'submission already in progress, skipping duplicate call');
    return { submitted: 0, deferred: 0, failed: 0 };
  }
  inFlight.add(jobId);

  try {
    const job = q().getJob.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // Skip jobs that are still expanding — they may have stale planned/deferred
    // WOs from a previous run, but the identity content is not yet complete.
    // The scheduler could otherwise submit those WOs while expansion is still
    // adding identities in the same process (crash + restart edge case).
    if (job.status === 'expanding') {
      logger.info({ jobId }, 'runSubmission: job is still expanding — skipping');
      return { submitted: 0, deferred: 0, failed: 0 };
    }

    const creds = await decryptCreds(job.creds_id);
    const limit = pLimit(config.workOrderConcurrency);

    // ─── Live quota refresh + re-bucket ───────────────────────────────
    // Always pull fresh /quota before submitting. If the live call fails
    // and we have no cache, getOrgQuota throws `quota_unavailable` — we
    // bubble that up so the caller can block the submission. If a recent
    // cache exists (<24h) we proceed with `stale: true` data; the operator
    // saw the stale warning in the UI.
    const previousMonths = job.projected_months ?? null;
    let quotaSnapshot = null;
    try {
      quotaSnapshot = await getOrgQuota(creds, { refresh: true });
    } catch (err) {
      if (err.code === 'quota_unavailable') {
        const e = new Error('Cannot submit: Adobe /quota is unreachable and no recent cache exists.');
        e.code = 'quota_unavailable';
        throw e;
      }
      throw err;
    }
    const distribution = redistributeUnshippedOrders(jobId, quotaSnapshot);
    const shifted = previousMonths != null && distribution.months > previousMonths;

    // Include 'deferred' rows alongside 'planned' — deferred orders were
    // denied quota on a previous run and never went to Adobe. After UTC
    // rollover (daily) or month rollover (monthly), they're safe to retry.
    //
    // Bucket selection: a (month, day) pair, or just day for backward
    // compat with callers that don't know about monthIndex yet (legacy
    // jobs default to month_index 1).
    const useMonth = Number(monthIndex) || null;
    const useDay   = Number(dayIndex)   || null;
    const orders = (useMonth && useDay)
      ? q().getOrdersByMonthAndDay.all(jobId, useMonth, useDay)
          .filter(o => ['planned', 'deferred'].includes(o.status))
      : useDay
        ? q().getOrdersByDay.all(jobId, useDay).filter(o => ['planned', 'deferred'].includes(o.status))
        : q().getPlannedOrders.all(jobId);

    // Use live quota cap values for the local reserve() ledger so the safety
    // net is consistent with what Adobe will actually enforce (F-003). Fall
    // back to job-row values only when the live snapshot is unavailable.
    const liveDailyLimit   = quotaSnapshot?.daily?.quota   || job.daily_limit;
    const liveMonthlyLimit = job.monthly_limit === null || job.monthly_limit === 0
      ? (quotaSnapshot?.monthly?.quota ? quotaSnapshot.monthly.quota : null)
      : (quotaSnapshot?.monthly?.quota || job.monthly_limit);

    q().updateJobStatus.run('submitting', null, jobId);

    let submitted = 0, deferred = 0, failed = 0;

    const tasks = orders.map(wo => limit(async () => {
      const res = reserve(creds.imsOrgId, wo.identifier_count, liveDailyLimit, liveMonthlyLimit);
      if (!res.granted) {
        const reason = res.reason === 'monthly'
          ? `monthly quota: ${res.monthlyUsed}/${res.monthlyLimit} used`
          : `daily quota: ${res.used}/${res.limit} used`;
        q().updateWorkOrderStatus.run('deferred', reason, wo.id);
        deferred++;
        return;
      }

      try {
        q().updateWorkOrderStatus.run('submitting', null, wo.id);

        const namespacesIdentities = JSON.parse(wo.namespaces_identities);
        const targetServices = wo.target_services_json ? JSON.parse(wo.target_services_json) : undefined;

        const result = await submitWorkOrder({
          creds,
          sandboxName: job.sandbox_name,
          datasetId: wo.dataset_ids || job.dataset_ids,
          displayName: `Delete ${job.name} - WO ${wo.id}`,
          description: `Bulk delete (Job ${jobId.slice(0, 8)}, Day ${wo.day_index})`,
          targetServices,
          namespacesIdentities,
        });

        q().updateWorkOrderSubmitted.run({
          id: wo.id,
          adobeWorkorderId: result.workorderId,
          adobeStatus: result.status,
          bundleId: result.bundleId,
          submittedAt: result.createdAt,
        });
        submitted++;
        logger.info({
          localId: wo.id, adobeId: result.workorderId, count: result.operationCount,
        }, 'work order submitted');
      } catch (err) {
        // CRITICAL: distinguish "Adobe rejected" from "Adobe MAY have
        // processed but we never saw the response". The hygiene POST is
        // non-idempotent (CLAUDE.md I11), which means a timeout or
        // network drop can leave Adobe with the request in flight even
        // though our axios call threw. If we mark such a WO 'failed' and
        // release its quota, two bad things happen:
        //   1. The deletion actually completes on Adobe's side without
        //      us knowing — we lose the Adobe work-order ID and the
        //      operator can't reconcile from the UI.
        //   2. Our local quota ledger under-counts what Adobe spent;
        //      the next submit run can over-shoot the daily/monthly cap.
        //
        // Decision rule:
        //   • err.response.status in [400, 500)  → Adobe definitively
        //     rejected the payload (validation error / auth / etc.).
        //     Mark 'failed' + release quota.
        //   • Anything else (5xx, timeout, ECONNRESET, ECONNREFUSED,
        //     no .response at all) → UNCERTAIN. Leave the WO in
        //     'submitting' (already set at the top of this try block)
        //     with the error stored in last_error. The startup orphan
        //     recovery (or the upcoming POST /reconcile route) will look
        //     these up by displayName-prefix on Adobe and either record
        //     the real Adobe ID or confirm absence. Do NOT release
        //     quota — Adobe may have spent it.
        const status = err.response?.status;
        const isAdobeRejection = status != null && status >= 400 && status < 500;

        if (isAdobeRejection) {
          release(creds.imsOrgId, wo.identifier_count, liveMonthlyLimit);
          q().updateWorkOrderStatus.run('failed', err.message, wo.id);
          failed++;
          logger.error({ localId: wo.id, status, err: err.message },
            'submission failed (Adobe rejected — 4xx)');
        } else {
          // Keep status='submitting' so listSubmittingOrphanOrders picks
          // it up on next startup. Persist last_error so the operator can
          // see what happened in the UI without grepping logs.
          q().updateWorkOrderStatus.run('submitting', err.message, wo.id);
          failed++;
          logger.warn({ localId: wo.id, status: status ?? '(no response)', err: err.message },
            'submission UNCERTAIN (timeout/network/5xx) — Adobe may have processed it. Left in submitting status; orphan-reconcile will check Adobe via displayName on next startup or via POST /api/jobs/:id/reconcile.');
        }
      }
    }));

    await Promise.all(tasks);

    const status = failed > 0 ? 'partial' : (deferred > 0 ? 'submitting' : 'submitted');
    q().updateJobStatus.run(status, null, jobId);
    return {
      submitted, deferred, failed,
      // Phase 2 metadata: the UI surfaces a toast when months shifted from
      // the previously-projected value, and renders the live quota that
      // gated this submission.
      months: distribution.months,
      previousMonths,
      shiftedFromPrevious: shifted,
      quotaSnapshot: quotaSnapshot ? {
        daily:   quotaSnapshot.daily,
        monthly: quotaSnapshot.monthly,
        stale:   quotaSnapshot.stale,
        fetchedAt: quotaSnapshot.fetchedAt,
      } : null,
    };
  } finally {
    inFlight.delete(jobId);
  }
}
