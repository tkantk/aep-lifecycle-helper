import pLimit from 'p-limit';
import { v4 as uuid } from 'uuid';
import { submitWorkOrder, normalizeDisplayName } from '../services/hygiene.js';
import { reserve, release, markAccepted, seedFloor } from '../services/quotaManager.js';
import { getOrgQuota } from '../services/quotaApi.js';
import { redistributeUnshippedOrders } from './redistributor.js';
import { q, db, prepareStreamIdentitiesBySource, setWorkOrderSubmittingDurable } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { decryptCreds } from '../utils/crypto.js';
import { markPosting, unmarkPosting } from './postingState.js';

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
    // Fail CLOSED on an unrecognized entitlement (review finding #6). A 200
    // whose shape we don't understand leaves quotaSnapshot.daily = null; the
    // old code then silently fell back to the static job.daily_limit and
    // shipped. For an irreversible delete we must refuse rather than guess.
    // (A stale-but-recognized cache within the 24h floor is fine — it still
    // carries a real daily.quota.)
    if (!quotaSnapshot?.daily || !(Number(quotaSnapshot.daily.quota) > 0)) {
      const e = new Error('Cannot submit: Adobe /quota returned no recognized daily entitlement.');
      e.code = 'quota_unavailable';
      throw e;
    }

    // Adobe ALWAYS enforces a monthly cap (review R4 #4 removed the
    // "0 = disable monthly" option), so a valid monthly entitlement is REQUIRED
    // before any destructive submit.
    if (!quotaSnapshot?.monthly || !(Number(quotaSnapshot.monthly.quota) > 0)) {
      const e = new Error('Cannot submit: Adobe /quota returned no recognized monthly entitlement.');
      e.code = 'quota_unavailable';
      throw e;
    }

    // The destructive boundary requires a FRESH /quota (review R4 #2). A stale
    // snapshot (served from cache after a failed live refresh) is fine for the
    // UI banner and for planning, but org-wide EXTERNAL usage can advance during
    // an Adobe outage — shipping against an obsolete snapshot risks
    // over-consuming a cap the operator can't see. Refuse and retry later.
    if (quotaSnapshot.stale) {
      const e = new Error('Cannot submit: Adobe /quota is unreachable; refusing to ship against a stale (cached) snapshot.');
      e.code = 'quota_unavailable';
      throw e;
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
    let orders;
    if (useMonth && useDay) {
      orders = q().getOrdersByMonthAndDay.all(jobId, useMonth, useDay)
        .filter(o => ['planned', 'deferred'].includes(o.status));
    } else if (useDay) {
      orders = q().getOrdersByDay.all(jobId, useDay).filter(o => ['planned', 'deferred'].includes(o.status));
    } else {
      // No explicit bucket (the auto-resume scheduler, and the default UI
      // "Submit" click). Ship ONLY the current window — the lowest
      // (month_index, day_index) bucket among un-shipped orders. After the
      // redistribute() above, that bucket is sized to Adobe's live daily
      // `remaining`. Shipping every planned order here (the old behavior)
      // ignored the bucketing and over-submitted beyond Adobe's remaining
      // for today — review blocker #3. The next run (next scheduler tick /
      // next UTC day) re-buckets and ships the following window.
      const unshipped = q().getPlannedOrders.all(jobId); // sorted month,day,rowid
      if (unshipped.length === 0) {
        orders = [];
      } else {
        const first = unshipped[0];
        const m = first.month_index ?? 1;
        const d = first.day_index ?? 1;
        orders = unshipped.filter(o => (o.month_index ?? 1) === m && (o.day_index ?? 1) === d);
      }
    }

    // Live caps from the (fresh, validated-above) /quota snapshot. Both
    // dimensions are guaranteed present by the guards above. The optional safety
    // buffer (review R6 #3) holds back a fraction as headroom for concurrent
    // EXTERNAL writers we can't see between this once-per-run snapshot and our
    // submit — our zero-over-ship guarantee otherwise assumes exclusive access.
    const buffer = config.quotaSafetyBuffer || 0;
    const liveDailyLimit   = Math.floor(quotaSnapshot.daily.quota   * (1 - buffer));
    const liveMonthlyLimit = Math.floor(quotaSnapshot.monthly.quota * (1 - buffer));
    if (buffer > 0) {
      logger.info({ jobId, buffer, liveDailyLimit, liveMonthlyLimit },
        'applying quota safety buffer for external writers');
    }

    // Raise the Adobe-observed floor (MAX) to the live consumed numbers BEFORE
    // any reserve, so reserve() enforces Adobe's true remaining. The floor is
    // tracked SEPARATELY from our per-WO reservations (review R4 #1), so it can
    // never absorb/lose them.
    seedFloor(creds.imsOrgId, quotaSnapshot.daily.consumed, quotaSnapshot.monthly.consumed);

    q().updateJobStatus.run('submitting', null, jobId);

    let submitted = 0, deferred = 0, failed = 0;

    const tasks = orders.map(wo => limit(async () => {
      // Per-WO reservation (review R4 #1, R5 lifecycle): keyed by wo.id so
      // reserve/markAccepted/release are exact and period-correct.
      const res = reserve({
        workOrderId: wo.id, imsOrgId: creds.imsOrgId, count: wo.identifier_count,
        dailyLimit: liveDailyLimit, monthlyLimit: liveMonthlyLimit,
      });
      if (!res.granted) {
        const reason = res.reason === 'monthly'
          ? `monthly quota: ${res.monthlyUsed}/${res.monthlyLimit} used`
          : `daily quota: ${res.used}/${res.limit} used`;
        q().updateWorkOrderStatus.run('deferred', reason, wo.id);
        deferred++;
        return;
      }

      try {
        // The EXACT displayName Adobe will store. UUID FIRST so the unique key
        // survives Adobe's 255-char truncation even for a long job name — orphan
        // recovery matches on this value (review R6 #2). normalizeDisplayName is
        // the SHARED, idempotent transform submitWorkOrder also applies, so the
        // stored copy byte-equals what Adobe receives (incl. trailing-whitespace).
        const displayName = normalizeDisplayName(`WO ${wo.id} - Delete ${job.name}`);

        // Durably commit the reserve + 'submitting' intent + the exact
        // displayName before the non-idempotent POST (review #8 + R6 #2), via a
        // synchronous=FULL commit rather than a (reader-blocking) wal_checkpoint
        // (review #6). Fail CLOSED: if the durable write errors, do NOT POST —
        // release and defer for retry.
        if (!setWorkOrderSubmittingDurable(wo.id, displayName)) {
          release(wo.id);
          q().updateWorkOrderStatus.run(
            'deferred', 'durability not confirmed; will retry next run', wo.id);
          deferred++;
          return;
        }

        // Mark the in-flight window OPEN (review R8 #1): from here until the POST
        // settles (success or error, see the finally below), release-absent must
        // refuse to touch this WO. The catch + settlement run synchronously after
        // the await returns, so the WO stays guarded through markAccepted / the
        // uncertain-error write with no interleaving release possible.
        markPosting(wo.id);

        const namespacesIdentities = JSON.parse(wo.namespaces_identities);
        const targetServices = wo.target_services_json ? JSON.parse(wo.target_services_json) : undefined;

        const result = await submitWorkOrder({
          creds,
          sandboxName: job.sandbox_name,
          datasetId: wo.dataset_ids || job.dataset_ids,
          displayName,
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
        // Adobe ACKED this POST (2xx) — promote the reservation to accepted so
        // it can never be released and is HELD until period rollover (review
        // R5). It must NOT be dropped on terminal status (the monitor no longer
        // touches quota) nor refunded by a later release/delete.
        markAccepted(wo.id);
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
          release(wo.id);
          // Mark DEFINITIVE (review R11 #1): a 4xx means Adobe never created the
          // WO (no quota spent), so it's unambiguously safe to delete later —
          // unlike an uncertain timeout (kept 'submitting') or a legacy 'failed'.
          q().markWorkOrderFailedDefinitive.run(err.message, wo.id);
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
      } finally {
        // In-flight window CLOSED — the POST has settled (2xx → markAccepted, or
        // error → catch handled it, all synchronously above). The WO is now in a
        // settled state and release-absent may act on it if it's an uncertain
        // orphan (review R8 #1). unmark is a no-op if it was never marked
        // (deferred / durability-failed paths return before markPosting()).
        unmarkPosting(wo.id);
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
