import { db, q } from '../db.js';

/**
 * Two-dimension quota ledger stored in SQLite.
 *
 * Adobe Data Hygiene enforces BOTH a daily AND a monthly identifier cap.
 * Defaults (entitlement-dependent):
 *   - Daily:   1,000,000 identifiers / day (free tier)
 *   - Monthly: varies — typical base contract ≈ 3,000,000 / month; Shield
 *              add-ons go higher; some smaller contracts go lower.
 *
 * We track usage per (ims_org_id, period-key) so that:
 *   - resuming after a restart doesn't lose count
 *   - multiple jobs across the day / month respect the shared caps
 *   - the Submit page can show exactly how much headroom is left
 *
 * Rollover is automatic — each new UTC day or UTC month starts a new row.
 *
 * `reserve` checks BOTH dimensions before granting. If either would overflow,
 * the reservation is denied and the caller should mark the work order
 * `deferred` (see runner/submission.js). `release` gives quota back on both
 * dimensions and is ONLY safe to call when we're certain Adobe did not
 * receive the request — see CLAUDE.md I5 and the ENOTFOUND edge case.
 */

function utcToday() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function utcYearMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function peek(imsOrgId, dailyLimit, monthlyLimit) {
  const dailyRow   = q().getQuota.get(imsOrgId, utcToday());
  const monthlyRow = q().getMonthlyQuota.get(imsOrgId, utcYearMonth());
  const dailyUsed   = dailyRow?.used   || 0;
  const monthlyUsed = monthlyRow?.used || 0;
  return {
    daily: {
      used: dailyUsed,
      remaining: Math.max(0, dailyLimit - dailyUsed),
      limit: dailyLimit,
    },
    monthly: monthlyLimit != null ? {
      used: monthlyUsed,
      remaining: Math.max(0, monthlyLimit - monthlyUsed),
      limit: monthlyLimit,
    } : null,
    // Back-compat fields for callers that only know about daily
    used:      dailyUsed,
    remaining: Math.max(0, dailyLimit - dailyUsed),
    limit:     dailyLimit,
  };
}

/**
 * Reserve `count` against today's quota atomically. Checks BOTH daily and
 * (if supplied) monthly limits. Returns granted=false if either would overflow
 * — caller should defer until the offending period rolls over.
 *
 * When both checks pass, both ledgers are incremented in a single SQLite
 * transaction so we never end up with daily incremented and monthly not.
 */
export function reserve(imsOrgId, count, dailyLimit, monthlyLimit) {
  const today = utcToday();
  const month = utcYearMonth();

  const dailyUsed   = q().getQuota.get(imsOrgId, today)?.used || 0;
  const monthlyUsed = monthlyLimit != null
    ? (q().getMonthlyQuota.get(imsOrgId, month)?.used || 0)
    : 0;

  if (dailyUsed + count > dailyLimit) {
    return {
      granted: false,
      reason: 'daily',
      used: dailyUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyUsed, monthlyLimit,
    };
  }
  if (monthlyLimit != null && monthlyUsed + count > monthlyLimit) {
    return {
      granted: false,
      reason: 'monthly',
      used: dailyUsed, limit: dailyLimit, remaining: Math.max(0, dailyLimit - dailyUsed),
      monthlyUsed, monthlyLimit,
      monthlyRemaining: Math.max(0, monthlyLimit - monthlyUsed),
    };
  }

  // Increment BOTH ledgers atomically. Without the transaction the comment
  // above was aspirational: a crash between the two .run() calls (with
  // synchronous=NORMAL) could durably persist the daily increment but not the
  // monthly one, permanently under-counting the monthly ledger (review
  // finding #7).
  db.transaction(() => {
    q().upsertQuota.run(imsOrgId, today, count);
    if (monthlyLimit != null) q().upsertMonthlyQuota.run(imsOrgId, month, count);
  })();

  return {
    granted: true,
    reserved: count,
    used: dailyUsed + count,
    limit: dailyLimit,
    remaining: Math.max(0, dailyLimit - dailyUsed - count),
    monthlyUsed: monthlyUsed + count,
    monthlyLimit,
    monthlyRemaining: monthlyLimit != null ? Math.max(0, monthlyLimit - monthlyUsed - count) : null,
  };
}

/**
 * Release `count` back to the daily ledger, and to the monthly ledger only
 * if monthly tracking was active when reserve() ran. Pass the same
 * monthlyLimit you passed to reserve() (null/undefined = monthly tracking
 * was off).
 *
 * Without the monthlyLimit gate, releasing for a job with monthly tracking
 * disabled would still decrement the monthly counter, eating headroom from
 * unrelated jobs on the same org that DID have monthly tracking on.
 *
 * Only call when we're certain Adobe did not receive the submit request
 * (pre-network validation failure, or a failure that's safe to assume was
 * local). Network timeouts are NOT safe to release on — see the ENOTFOUND
 * edge case documented in docs/ARCHITECTURE.md §8.
 */
export function release(imsOrgId, count, monthlyLimit) {
  db.transaction(() => {
    q().decQuota.run(count, imsOrgId, utcToday());
    if (monthlyLimit != null) {
      q().decMonthlyQuota.run(count, imsOrgId, utcYearMonth());
    }
  })();
}
