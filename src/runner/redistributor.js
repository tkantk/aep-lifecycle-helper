import { db, q } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { projectedUsage, SHIPPED_WORK_COUNTS_TWICE_UNTIL_MONTH_END } from '../services/quotaManager.js';

/**
 * Month-aware re-bucketer for un-shipped work orders.
 *
 * Phase 2 (2026-05-15); capacity model + calendar months rewritten 2026-10-06
 * — see docs/CHANGELOG.md.
 *
 * The planner emits work orders in deterministic creation order. Each work
 * order is ≤ 100,000 identifiers (Adobe hard cap, CLAUDE.md I3). This module
 * assigns each un-shipped work order a `(month_index, day_index)` LABEL — the
 * submission window it is expected to ship in. Labels drive what the operator
 * sees (Plan / Submit tabs) and the scheduler's "next window" pick; they never
 * gate anything themselves. The only quota gate is reserve() at submit time.
 *
 * Capacity model — the SAME numbers reserve() gates on (2026-10-06 fix 2):
 *   - caps are buffered exactly like submission.js: floor(quota × (1 − buffer))
 *     with QUOTA_SAFETY_BUFFER;
 *   - "already used" for the current UTC day/month is projectedUsage(): MAX(stored
 *     floor, live consumed) + this tool's active (held) reservations.
 * Sizing buckets from Adobe's raw `remaining` instead (the old model) planned
 * work reserve() would then refuse: a 10 % buffer deferred one order every day,
 * and held reservations deferred whole planned days.
 *
 * Calendar months (2026-10-06 fix 3): Month N = jobs.plan_anchor_month + (N-1)
 * calendar months (UTC). The un-shipped tail starts in the CURRENT calendar
 * month; day numbering continues past the last shipped window only while that
 * window is in the current month. (Before, months were counted from the last
 * shipped month, so November's work read "Month 1, Day 4".)
 *
 * Walk, in creation (rowid) order:
 *   Phase A — approved work (planned + deferred). The first window has the
 *     capacity left NOW (cap − projected usage); every later day starts with a
 *     fresh daily cap and every later month with a fresh monthly cap. A window is
 *     never left empty: if an order doesn't fit and nothing was placed in the
 *     current window yet, the window keeps its label with a fresh day's capacity.
 *   Phase B — awaiting_approval work continues the same walk but never lands in
 *     Month 1 (it is future-month work the operator has not approved), so
 *     "Approve Month N" always approves what is labelled N.
 *
 * What stays immutable: identity content (namespaces_identities) of every work
 * order, and the labels of shipped work orders (CLAUDE.md I10).
 *
 * Returns { months, days, totalUnshipped, totalIdentifiers, perMonthCounts,
 *           anchorMonth, currentMonthIndex }.
 */

function safeInt(v, fallback) {
  const n = Number(v);
  // Treat 0 as invalid (suspended org / no entitlement) and fall through to
  // the fallback. If Adobe ever legitimately reports quota=0, we'd use the
  // env-configured fallback cap rather than silently over-submitting.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Adobe's consumed for a /quota entry; derived as quota − remaining when a
// caller passes only those (older call sites / tests). null when unknown.
function consumedOf(entry) {
  if (!entry) return null;
  if (typeof entry.consumed === 'number' && Number.isFinite(entry.consumed)) return entry.consumed;
  if (typeof entry.quota === 'number' && typeof entry.remaining === 'number' &&
      Number.isFinite(entry.quota) && Number.isFinite(entry.remaining)) {
    return Math.max(0, entry.quota - entry.remaining);
  }
  return null;
}

const YM_RE = /^(\d{4})-(\d{2})$/;
function utcYearMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthsBetween(fromYm, toYm) {
  const [, fy, fm] = YM_RE.exec(fromYm).map(Number);
  const [, ty, tm] = YM_RE.exec(toYm).map(Number);
  return (ty - fy) * 12 + (tm - fm);
}
function daysInMonth(ym) {
  const [, y, m] = YM_RE.exec(ym).map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of the next month = last day of this one
}
function addMonths(ym, n) {
  const [, y, m] = YM_RE.exec(ym).map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/**
 * @param {string} jobId
 * @param {{ daily?: {consumed?:number, remaining?:number, quota?:number}, monthly?: {consumed?:number, remaining?:number, quota?:number}|null }} quota
 *   The shape returned by `services/quotaApi.js::getOrgQuota`. Either field may
 *   be null/missing; caps then fall back to the job row / config, and "used"
 *   falls back to the local ledger alone.
 */
export function redistributeUnshippedOrders(jobId, quota) {
  const job = q().getJob.get(jobId);
  if (!job) throw new Error(`redistribute: job not found: ${jobId}`);

  // Caps exactly as reserve() is given them in submission.js. Live /quota wins;
  // the job row and config are fallbacks. Monthly is ALWAYS tracked (R4 #4).
  const buffer = config.quotaSafetyBuffer || 0;
  const dailyRaw   = safeInt(quota?.daily?.quota,   safeInt(job.daily_limit,   config.dailyIdentifierLimit));
  const monthlyRaw = safeInt(quota?.monthly?.quota, safeInt(job.monthly_limit, config.monthlyIdentifierLimit));
  const dayCap   = Math.floor(dailyRaw   * (1 - buffer));
  const monthCap = Math.floor(monthlyRaw * (1 - buffer));

  // Highest (month, day) window that has ALREADY shipped to Adobe.
  const shippedMax = q().getMaxShippedWindow.get(jobId);

  // Calendar anchor. A job planned before plan_anchor_month existed gets one
  // that makes its latest shipped month the current month (its labels so far
  // were counted from that month), persisted so it never moves again.
  const nowYm = utcYearMonth();
  let anchor = YM_RE.test(job.plan_anchor_month || '') ? job.plan_anchor_month : null;
  if (!anchor) {
    anchor = addMonths(nowYm, -((shippedMax?.mm ?? 1) - 1));
    q().setPlanAnchorMonth.run(anchor, jobId);
  }
  const currentMonthIndex = Math.max(1, monthsBetween(anchor, nowYm) + 1);

  const approved = q().getUnshippedOrdersForJob.all(jobId);    // planned + deferred, rowid order
  const awaiting = q().getAwaitingOrdersForJob.all(jobId);     // awaiting_approval, rowid order
  if (approved.length + awaiting.length === 0) {
    q().setProjectedMonths.run(0, jobId);
    return { months: 0, days: 0, totalUnshipped: 0, totalIdentifiers: 0, perMonthCounts: [],
      anchorMonth: anchor, currentMonthIndex };
  }

  // First window: the current calendar month, continuing the day numbering of
  // a window already shipped in it. Its capacity is what reserve() would grant
  // RIGHT NOW, whatever its label.
  let month, day;
  if (shippedMax && shippedMax.mm >= currentMonthIndex) {
    month = shippedMax.mm;
    day = shippedMax.dd + 1;
  } else {
    month = currentMonthIndex;
    day = 1;
  }
  // Each day window is one UTC day, so track the window's calendar day-of-month:
  // a month never gets more windows than it has days left (a plan made on
  // Oct 29 has Oct 29, 30 and 31 — a 4th window is November's).
  const monthLength = (m) => daysInMonth(addMonths(anchor, m - 1));
  let dom = month === currentMonthIndex ? new Date().getUTCDate() : 1;
  let monthLen = monthLength(month);
  const imsOrgId = q().getCred.get(job.creds_id)?.ims_org_id ?? null;
  const used = projectedUsage({
    imsOrgId,
    dailyConsumed: consumedOf(quota?.daily),
    monthlyConsumed: consumedOf(quota?.monthly),
  });
  let dayRem = Math.max(0, dayCap - used.daily);
  let monthRem = Math.max(0, monthCap - used.monthly);
  let placedInDay = 0;
  let windowTotal = 0;      // identifiers placed in the current day window

  const perMonthCounts = [];
  let totalIdentifiers = 0;
  const changes = [];

  // Next calendar month: day labels restart, fresh daily + monthly caps.
  const nextMonth = () => {
    month++;
    day = 1;
    dom = 1;
    monthLen = monthLength(month);
    dayRem = dayCap;
    monthRem = monthCap;
    placedInDay = 0;
    windowTotal = 0;
  };
  // Next UTC day. Once a window has shipped, Adobe's consumed AND the held
  // reservation both count it for the rest of the month (R5 hold — see
  // SHIPPED_WORK_COUNTS_TWICE_UNTIL_MONTH_END), so it is charged a second time
  // here. The day LABEL only advances if the window holds work — never an
  // empty label.
  const nextDay = () => {
    if (SHIPPED_WORK_COUNTS_TWICE_UNTIL_MONTH_END) monthRem -= windowTotal;
    if (placedInDay > 0) day++;
    dom++;
    dayRem = dayCap;
    placedInDay = 0;
    windowTotal = 0;
    if (dom > monthLen) nextMonth();
  };

  const place = (wo) => {
    const count = wo.identifier_count;
    if (count > dayRem) nextDay();          // (a) daily fit
    if (count > monthRem) nextMonth();      // (b) monthly fit
    // (c) Place it.
    if (wo.month_index !== month || wo.day_index !== day) changes.push([month, day, wo.id]);
    dayRem -= count;
    monthRem -= count;
    placedInDay++;
    windowTotal += count;
    perMonthCounts[month - 1] = (perMonthCounts[month - 1] || 0) + count;
    totalIdentifiers += count;
  };

  for (const wo of approved) place(wo);
  // Future-month work never shares the plan's first month with approved work.
  if (awaiting.length > 0 && month < 2) nextMonth();
  for (const wo of awaiting) place(wo);

  // Persist label changes atomically (a crash mid-way keeps the old labels).
  db.transaction(() => {
    for (const [m, d, id] of changes) q().setOrderMonthDay.run(m, d, id);
  })();

  for (let i = 0; i < month; i++) perMonthCounts[i] = perMonthCounts[i] || 0;
  q().setProjectedMonths.run(month, jobId);

  logger.info({
    jobId, months: month, daysInLastMonth: day, anchorMonth: anchor, currentMonthIndex,
    totalUnshipped: approved.length + awaiting.length, totalIdentifiers, relabelled: changes.length,
  }, 'redistributor: completed');

  return {
    months: month,
    days: day,                       // last day label used in the final month
    totalUnshipped: approved.length + awaiting.length,
    totalIdentifiers,
    perMonthCounts,
    anchorMonth: anchor,
    currentMonthIndex,
  };
}
