import { db, q } from '../db.js';

/**
 * Two-dimension (daily + monthly) quota safety-net, per-work-order.
 *
 * MODEL (review R4 #1 — replaces the aggregate `used` counter that conflated
 * our reservations with Adobe's observed usage and lost reservation ownership):
 *
 *   effective_used(period) = adobe_floor(period) + Σ active reservations(period)
 *
 *   • adobe_floor — Adobe's org-wide observed consumed for the period. Raised
 *     by seedFloor (MAX with live /quota consumed) and, when one of OUR work
 *     orders completes, by complete() (additive += that WO's count, moving it
 *     out of active reservations and into the floor). MAX and += compose: MAX
 *     never lowers, so once Adobe's /quota reflects a completed WO the floor
 *     stays the same (no double-count).
 *   • reservations — ONE row per work order (count + its own utc_date /
 *     utc_year_month). reserve() inserts an active row; release() deactivates
 *     it (Adobe didn't process it) using the WO's OWN period (so a cross-day
 *     release frees the right period); complete() moves it into the floor.
 *
 * This makes reserve() enforce Adobe's true remaining (cap - effective_used)
 * and keeps every release/complete exact and period-correct. Monthly is ALWAYS
 * tracked (review R4 #4 removed the "0 = disable monthly" option).
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
 * Release a work order's reservation — Adobe did NOT process it (rollback /
 * 4xx rejection / orphan-not-found). Deactivates the row by WO id, so it frees
 * the reservation's OWN period (no cross-day mis-decrement). Idempotent.
 */
export function release(workOrderId) {
  q().deactivateReservation.run(workOrderId);
}

/** Re-activate a previously-released reservation (recovery: a 'failed' WO was
 *  actually processed by Adobe). Keeps the original period/count. */
export function reactivate(workOrderId) {
  q().reactivateReservation.run(workOrderId);
}

/**
 * A work order reached a terminal Adobe state. Adobe has long since counted it
 * (a 'completed'/'failed' terminal is days after the request was accepted, and
 * accepted requests count immediately), so it is already reflected in Adobe's
 * `/quota` — i.e. in `adobe_floor` once the next `seedFloor` runs. We therefore
 * just DEACTIVATE its reservation, removing it from the active sum so it isn't
 * counted twice (once via adobe_floor, once via the active reservation).
 *
 * We deliberately do NOT additively bump adobe_floor here: seedFloor sets the
 * floor to Adobe's ABSOLUTE consumed via MAX, and an additive bump would either
 * be swallowed by a later MAX (losing the count → over-ship) or stack on top of
 * a MAX that already included this WO (permanent double-count → over-defer).
 * Deactivate-only keeps `effective = adobe_floor + Σ active` exact in steady
 * state; the only residual is a SAFE transient over-defer for a WO that Adobe
 * has counted but that we haven't deactivated yet (it never over-ships).
 */
export function complete(workOrderId) {
  q().deactivateReservation.run(workOrderId);
}
