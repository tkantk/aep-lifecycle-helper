import { db, q } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Month-aware re-bucketer for un-shipped work orders.
 *
 * Phase 2 (2026-05-15) — see docs/CHANGELOG.md.
 *
 * The planner emits work orders in deterministic creation order. Each work
 * order is ≤ 100,000 identifiers (Adobe hard cap, CLAUDE.md I3). The job of
 * the redistributor is to assign each un-shipped work order a `(day_index,
 * month_index)` label that respects the org's CURRENT Adobe quota state
 * (fetched live via `services/quotaApi.js`).
 *
 * Why we re-bucket instead of computing once at plan time:
 *   - Adobe quota is org-wide. If someone else also deletes against the org
 *     between Plan and Submit, the live `remaining` shrinks. The
 *     originally-planned "Day 2 → Month 2" might no longer fit; redistribute
 *     pushes it to Month 3.
 *   - Monthly rollover (1st of month at 00:00 GMT) refreshes the cap.
 *     Redistribute run after rollover sees the fresh `monthly.remaining` and
 *     packs more work into the current month.
 *   - Daily rollover (00:00 GMT) likewise refreshes the daily cap.
 *
 * What stays immutable:
 *   - The identity content of a work order. Once a WO is inserted into
 *     `work_orders`, its `namespaces_identities` JSON never changes — that
 *     would be re-emitting (CLAUDE.md I10).
 *   - Shipped work orders' `(day_index, month_index)`. Their historical
 *     submission window is preserved; only the un-shipped tail is re-labelled.
 *
 * Algorithm:
 *   1. Walk un-shipped (status ∈ {planned, deferred}) WOs in rowid order.
 *   2. Track running consumption against three caps:
 *        - `dayRem`     — identifiers left in the current day window
 *        - `monthRem`   — identifiers left in the current month window
 *        - `dailyFresh` — fresh daily cap once we advance to next day
 *        - `monthlyFresh` — fresh monthly cap once we advance to next month
 *      The current day/month start with `quota.daily.remaining` and
 *      `quota.monthly.remaining` (the live Adobe values, which already
 *      exclude whatever we shipped before this run).
 *   3. For each WO:
 *        a. If it doesn't fit in `dayRem`, advance to the next day
 *           (`day++`, `dayRem = dailyFresh`).
 *        b. If it doesn't fit in `monthRem`, advance to the next month
 *           (`month++`, `day = 1`, `dayRem = dailyFresh`,
 *           `monthRem = monthlyFresh`). The check happens AFTER the day-fit
 *           check because a single WO is always ≤ daily cap (100k ≤ 1M).
 *        c. Assign the WO `(day, month)` and decrement the running caps.
 *   4. Persist all updates inside a single SQLite transaction so a crash
 *      mid-redistribute leaves the previous labels intact.
 *
 * Returns `{ months, days, shifted, perMonthCounts }` so callers can render
 * a "projected timeline" or a toast/modal when month_index extends beyond
 * the previously-projected value.
 */

function safeInt(v, fallback) {
  const n = Number(v);
  // Treat 0 as invalid (suspended org / no entitlement) and fall through to
  // the fallback. If Adobe ever legitimately reports quota=0, we'd use the
  // env-configured fallback cap rather than silently over-submitting.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {string} jobId
 * @param {{ daily?: {remaining?:number, quota?:number}, monthly?: {remaining?:number, quota?:number}|null }} quota
 *   The shape returned by `services/quotaApi.js::getOrgQuota`. Either field
 *   may be null/missing; in that case we fall back to the job's stored
 *   `daily_limit` / `monthly_limit` configured on the row.
 * @returns {{ months: number, days: number, totalUnshipped: number,
 *             totalIdentifiers: number, perMonthCounts: number[] }}
 */
export function redistributeUnshippedOrders(jobId, quota) {
  const job = q().getJob.get(jobId);
  if (!job) throw new Error(`redistribute: job not found: ${jobId}`);

  // Effective caps. Adobe's /quota is the truth when present; the job-row
  // values are only used when Adobe data is missing (e.g. first-run before
  // a successful /quota call). Both checks tolerate `0`-as-disabled per
  // the existing convention. NOTE: these are the RAW caps — QUOTA_SAFETY_BUFFER
  // (R6 #3) is intentionally NOT applied here. The redistributor only assigns
  // (month_index, day_index) LABELS; the authoritative quota gate is reserve()
  // in submission.js, which DOES use the buffered caps. Keeping bucket labels
  // buffer-independent means a buffer can only DEFER work to a later window
  // (safe), never over-ship.
  const dailyFresh = safeInt(
    quota?.daily?.quota,
    safeInt(job.daily_limit, config.dailyIdentifierLimit)
  );
  // Monthly is ALWAYS tracked (review R4 #4 removed "0 = disable monthly" —
  // Adobe always enforces a monthly cap). Live /quota wins; job row + config
  // are fallbacks.
  const monthlyFresh = safeInt(
    quota?.monthly?.quota,
    safeInt(job.monthly_limit, config.monthlyIdentifierLimit)
  );

  // First-period remainders — live values from Adobe if we have them,
  // otherwise full fresh caps.
  let dayRem   = Number.isFinite(quota?.daily?.remaining)   ? Number(quota.daily.remaining)   : dailyFresh;
  let monthRem = monthlyFresh == null
    ? null
    : (Number.isFinite(quota?.monthly?.remaining) ? Number(quota.monthly.remaining) : monthlyFresh);

  // Clamp negatives to 0 (can't happen via Adobe's API but guard defensive-
  // ly). We deliberately do NOT apply a "minimum useful remaining" floor here:
  // work orders can be much smaller than the daily/monthly cap, so even a
  // small remaining value can hold real work. Flooring to 0 when remaining is,
  // say, 80k would skip that 80k unnecessarily (F-001).
  if (dayRem < 0)                       dayRem   = 0;
  if (monthRem != null && monthRem < 0) monthRem = 0;

  const orders = q().getUnshippedOrdersForJob.all(jobId);
  if (orders.length === 0) {
    q().setProjectedMonths.run(0, jobId);
    return { months: 0, days: 0, totalUnshipped: 0, totalIdentifiers: 0, perMonthCounts: [] };
  }

  // CONTINUE numbering past whatever has already shipped, instead of resetting
  // the un-shipped tail to "Day 1" (2026-06-03 day-label continuity). After a
  // Day-1 window ships, the remaining work must read as "Day 2", matching the
  // operator's mental model — otherwise the Submit button appears to go
  // backwards, which is confusing on a destructive tool. This is a LABEL-only
  // offset: it changes neither identity content nor the reserve() quota gate, so
  // the no-over-ship guarantee is untouched. Shipped WOs stay immutable; the
  // submitter still ships the lowest un-shipped (month, day) bucket first.
  const shippedMax = q().getMaxShippedWindow.get(jobId);
  let month = shippedMax ? shippedMax.mm : 1;
  let day   = shippedMax ? shippedMax.dd + 1 : 1;
  // perMonthCounts is 0-indexed by (month-1); pad leading months that are fully
  // shipped (no un-shipped work) so counts land in the right slot.
  const perMonthCounts = Array(month).fill(0);
  let totalIdentifiers = 0;

  const tx = db.transaction(() => {
    for (const wo of orders) {
      const count = wo.identifier_count;
      totalIdentifiers += count;

      // (a) Daily fit. A WO that doesn't fit pushes us to the next day,
      //     which starts with a fresh daily cap.
      if (count > dayRem) {
        day++;
        dayRem = dailyFresh;
      }
      // (b) Monthly fit. If the WO still doesn't fit even in the next day's
      //     fresh daily capacity because the month is exhausted, advance
      //     month (which resets day to 1 and refreshes both caps).
      if (monthRem != null && count > monthRem) {
        month++;
        day = 1;
        dayRem = dailyFresh;
        monthRem = monthlyFresh;
        perMonthCounts[month - 1] = 0;
      }
      // (c) Place the WO.
      q().setOrderMonthDay.run(month, day, wo.id);
      dayRem -= count;
      if (monthRem != null) monthRem -= count;
      perMonthCounts[month - 1] = (perMonthCounts[month - 1] || 0) + count;
    }
  });
  tx();

  // The maximum day_index assigned in the LAST month — useful for the UI
  // header. (`day` at end-of-loop is exactly that.)
  const maxDayInFinalMonth = day;

  q().setProjectedMonths.run(month, jobId);

  logger.info({
    jobId, months: month, daysInLastMonth: maxDayInFinalMonth,
    totalUnshipped: orders.length, totalIdentifiers,
  }, 'redistributor: completed');

  return {
    months: month,
    days: maxDayInFinalMonth,
    totalUnshipped: orders.length,
    totalIdentifiers,
    perMonthCounts,
  };
}
