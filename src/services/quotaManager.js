import { db, q } from '../db.js';

/**
 * Two-dimension (daily + monthly) quota safety-net, per-work-order.
 *
 * MODEL (review R4 #1 + R5 hold-until-rollover lifecycle):
 *
 *   effective_used(period) = adobe_floor(period) + Σ active reservations(period)
 *
 *   • adobe_floor — Adobe's org-wide observed consumed for the period. Raised
 *     ONLY by seedFloor (MAX with live /quota consumed). Tracked SEPARATELY from
 *     our reservations so it can never absorb/lose them.
 *   • reservations — ONE row per work order (count + its own utc_date /
 *     utc_year_month + an `accepted` flag).
 *       reserve()      → active=1, accepted=0  (pending: committed locally, not acked)
 *       markAccepted() → accepted=1            (Adobe acked the POST; quota spent)
 *       release()      → active=0 IFF accepted=0  (refund un-accepted work only)
 *       reactivate()   → active=1, accepted=1  (a 'failed' WO Adobe DID process)
 *
 * R5 CRITICAL — why there is NO mid-period drop / no complete():
 *   Adobe's /quota is org-wide and eventually-consistent with NO per-tool
 *   attribution. A floor RISE is never proof that OUR specific accepted work
 *   entered it — a concurrent external hygiene job in the same org can push the
 *   floor up while ours still lags. So every timer-based or floor-delta
 *   "assimilation drop" (and the R4.1 deactivate-on-terminal) can deactivate a
 *   reservation whose count is NOT yet in the floor → effective understates true
 *   consumption → the next reserve OVER-SHIPS an irreversible delete. A 5-agent
 *   adversarial design review (2026-05-31) reproduced this for every drop
 *   heuristic. The only provably-safe rule: HOLD an accepted reservation until
 *   the UTC day/month ROLLS OVER (Adobe's period counter resets then too), at
 *   which point the period-keyed SUM simply stops matching it. Over-defer
 *   (holding slightly too long) is SAFE and self-corrects at rollover; over-ship
 *   is irreversible. Monthly is ALWAYS tracked (review R4 #4).
 */

function utcToday() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function utcYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dailyEffective(imsOrgId, today) {
  const floor  = q().getDailyFloor.get(imsOrgId, today)?.adobe_floor || 0;
  const active = q().sumActiveDaily.get(imsOrgId, today)?.s || 0;
  return floor + active;
}
function monthlyEffective(imsOrgId, month) {
  const floor  = q().getMonthlyFloor.get(imsOrgId, month)?.adobe_floor || 0;
  const active = q().sumActiveMonthly.get(imsOrgId, month)?.s || 0;
  return floor + active;
}

/** UI/safety-net peek: effective used + remaining for the current period. */
export function peek(imsOrgId, dailyLimit, monthlyLimit) {
  const dUsed = dailyEffective(imsOrgId, utcToday());
  const mUsed = monthlyEffective(imsOrgId, utcYearMonth());
  return {
    daily:   { used: dUsed, remaining: Math.max(0, dailyLimit - dUsed), limit: dailyLimit },
    monthly: monthlyLimit != null
      ? { used: mUsed, remaining: Math.max(0, monthlyLimit - mUsed), limit: monthlyLimit }
      : null,
    used: dUsed, remaining: Math.max(0, dailyLimit - dUsed), limit: dailyLimit,
  };
}

/**
 * Raise adobe_floor (MAX) to Adobe's live reported consumption. Kept SEPARATE
 * from our reservations so it can never absorb/lose them. Called at the top of
 * every submit run with the fresh /quota numbers. `monthlyConsumed = null`
 * skips the monthly floor (only when the caller genuinely has no monthly
 * dimension — post-R4 this is rare).
 */
export function seedFloor(imsOrgId, dailyConsumed, monthlyConsumed) {
  db.transaction(() => {
    if (Number.isFinite(dailyConsumed) && dailyConsumed > 0) {
      q().maxDailyFloor.run(imsOrgId, utcToday(), dailyConsumed);
    }
    if (monthlyConsumed != null && Number.isFinite(monthlyConsumed) && monthlyConsumed > 0) {
      q().maxMonthlyFloor.run(imsOrgId, utcYearMonth(), monthlyConsumed);
    }
  })();
}

/**
 * Reserve `count` for `workOrderId`. Grants iff effective_used + count stays
 * within BOTH caps. On grant, records an active per-WO reservation. Re-reserving
 * the same WO (e.g. a deferred WO retried) re-activates its row with the new
 * period/count. monthlyLimit may be null only when monthly tracking is off.
 */
// IMPORTANT (review R5): this function MUST stay fully synchronous. better-
// sqlite3 is synchronous, so the effective-sum reads below and upsertReservation
// run as one atomic span — Node cannot schedule another p-limit submit task's
// reserve() in between, so two concurrent reserves can't both read a stale sum
// and both grant. Introducing ANY `await` between the dailyEffective/monthly
// reads and upsertReservation would reintroduce a TOCTOU over-ship race.
export function reserve({ workOrderId, imsOrgId, count, dailyLimit, monthlyLimit }) {
  const today = utcToday();
  const month = utcYearMonth();
  const dailyUsed   = dailyEffective(imsOrgId, today);
  const monthlyUsed = monthlyLimit != null ? monthlyEffective(imsOrgId, month) : 0;

  if (dailyUsed + count > dailyLimit) {
    return { granted: false, reason: 'daily',
      used: dailyUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyUsed, monthlyLimit };
  }
  if (monthlyLimit != null && monthlyUsed + count > monthlyLimit) {
    return { granted: false, reason: 'monthly',
      used: dailyUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyUsed, monthlyLimit, monthlyRemaining: Math.max(0, monthlyLimit - monthlyUsed) };
  }

  q().upsertReservation.run({ workOrderId, imsOrgId, utcDate: today, utcMonth: month, count });

  return { granted: true, reserved: count,
    used: dailyUsed + count, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed - count),
    monthlyUsed: monthlyUsed + count, monthlyLimit,
    monthlyRemaining: monthlyLimit != null ? Math.max(0, monthlyLimit - monthlyUsed - count) : null };
}

/**
 * Adobe ACKED the POST for this work order (2xx) — it has spent the quota.
 * Promote the reservation to accepted so it can never be released and is HELD
 * until period rollover (review R5). Called after a successful submit and when
 * recovery matches an orphan to an existing Adobe work order. Idempotent.
 */
export function markAccepted(workOrderId) {
  q().markAcceptedReservation.run(workOrderId);
}

/**
 * Release a work order's reservation. Called when Adobe did NOT process it: a
 * 4xx rejection, a durability-write failure before the POST, or an operator
 * confirming an uncertain orphan is absent (release-absent, R7 #1). Recovery
 * NEVER auto-releases on a no-match (R6 #1). GUARDED (review R5 #2): the
 * underlying statement only deactivates a reservation with accepted=0, so a
 * reservation Adobe has acked can NEVER be refunded (refunding it would
 * over-ship). Keyed by WO id, so it frees the reservation's OWN period (no
 * cross-day mis-decrement). Idempotent; a no-op on an accepted reservation.
 */
export function release(workOrderId) {
  q().releaseReservation.run(workOrderId);
}

/** Re-activate a previously-released reservation AS accepted (recovery: a
 *  'failed' WO was actually processed by Adobe, so it spent the quota and must
 *  be held). Keeps the original period/count. */
export function reactivate(workOrderId) {
  q().reactivateReservation.run(workOrderId);
}
