import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { runSubmission } from './submission.js';

/**
 * Auto-resume scheduler (Phase 3, 2026-05-15).
 *
 * The motivating problem: client-facing jobs frequently span multiple months
 * (e.g. 10M expanded identities against a 2M/month entitlement = 5 months).
 * Each month's batch can only ship after the org-wide monthly quota resets at
 * 00:00 GMT on the 1st. Asking the operator to come back manually for each
 * month is fragile and easy to forget.
 *
 * This scheduler reads three operator-configurable settings:
 *   - enabled        — opt-in switch (default OFF; destructive workflow)
 *   - localTime      — HH:MM in the operator's local timezone (default '09:00')
 *   - days           — 'every-day' | 'weekdays' | 'first-of-month'
 *
 * Then once per minute it asks `shouldFireNow()` whether this is a valid
 * firing moment. The function returns true exactly when:
 *   1. enabled === true
 *   2. today is allowed by `days`
 *   3. current local time is at or past today's HH:MM
 *   4. we haven't already fired since today's HH:MM (last_run_at < fire time)
 *
 * When firing, the scheduler calls `runSubmission({ jobId })` for every job
 * that has un-shipped (planned + deferred) work orders. Each `runSubmission`
 * internally re-fetches Adobe `/quota` and re-buckets via the redistributor —
 * so even if quota changed since the last run, the right work ships.
 *
 * Bootstrap behaviour: on `startScheduler()` we run an immediate tick. If the
 * operator's laptop was closed at the scheduled time (a thing they explicitly
 * called out), the catch-up tick fires as soon as the app starts — provided
 * the fire window has elapsed today and we haven't already fired since.
 *
 * Concurrency: per-tick `running` flag prevents reentrancy across overlapping
 * setIntervals (which can happen on a paused machine that wakes up). Per-job
 * concurrency is already handled inside `runSubmission` via its `inFlight` Set.
 */

const TICK_INTERVAL_MS = 60_000;
const VALID_DAYS = new Set(['every-day', 'weekdays', 'first-of-month']);
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

let timer = null;
let running = false;

// ─── Settings I/O ────────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  enabled:   false,
  localTime: '09:00',
  days:      'every-day',
  lastRunAt: null,
  lastRunSummary: null,
});

function safeParseJSON(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Read the auto_resume_* settings into a single object. Missing keys fall
 * back to defaults; first-run callers get a sensible disabled config.
 */
export function getAutoResumeSettings() {
  const rows = q().listAppSettingsByPrefix.all('auto_resume_%');
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled:        map.auto_resume_enabled === 'true',
    localTime:      map.auto_resume_local_time || DEFAULTS.localTime,
    days:           VALID_DAYS.has(map.auto_resume_days) ? map.auto_resume_days : DEFAULTS.days,
    lastRunAt:      map.auto_resume_last_run_at || null,
    lastRunSummary: safeParseJSON(map.auto_resume_last_run_summary, null),
  };
}

/**
 * Persist updated settings. Caller passes a partial object; we merge with
 * existing values so callers don't have to round-trip every field.
 */
export function setAutoResumeSettings(partial) {
  const current = getAutoResumeSettings();
  const merged = {
    enabled:   partial.enabled !== undefined ? !!partial.enabled : current.enabled,
    localTime: partial.localTime || current.localTime,
    days:      partial.days || current.days,
    lastRunAt: partial.lastRunAt !== undefined ? partial.lastRunAt : current.lastRunAt,
    lastRunSummary: partial.lastRunSummary !== undefined ? partial.lastRunSummary : current.lastRunSummary,
  };

  // Validation (defensive — routes already validate, but this guards
  // programmatic callers too).
  if (!HHMM_RE.test(merged.localTime)) throw new Error(`Invalid localTime: ${merged.localTime}`);
  if (!VALID_DAYS.has(merged.days))    throw new Error(`Invalid days value: ${merged.days}`);

  const entries = [
    ['auto_resume_enabled',           String(merged.enabled)],
    ['auto_resume_local_time',        merged.localTime],
    ['auto_resume_days',              merged.days],
    ['auto_resume_last_run_at',       merged.lastRunAt || ''],
    ['auto_resume_last_run_summary',  merged.lastRunSummary ? JSON.stringify(merged.lastRunSummary) : ''],
  ];
  for (const [k, v] of entries) q().upsertAppSetting.run(k, v);
  return merged;
}

// ─── Firing logic ────────────────────────────────────────────────────────

/**
 * Returns true exactly when the scheduler should fire RIGHT NOW given the
 * settings and an injectable `now` (defaults to system clock). Exported so
 * unit tests can sweep every gate with explicit times.
 */
export function shouldFireNow(settings, now = new Date()) {
  if (!settings.enabled) return false;

  // Day filter — getDay()/getDate() use the local timezone, which is what
  // the operator picked when entering localTime.
  if (settings.days === 'weekdays') {
    const wd = now.getDay();           // 0 = Sunday, 6 = Saturday
    if (wd === 0 || wd === 6) return false;
  } else if (settings.days === 'first-of-month') {
    if (now.getDate() !== 1) return false;
  }

  const m = HHMM_RE.exec(settings.localTime || DEFAULTS.localTime);
  if (!m) return false;
  const fire = new Date(now);
  fire.setHours(Number(m[1]), Number(m[2]), 0, 0);

  // Not yet today's fire time.
  if (now < fire) return false;

  // Already fired since today's fire time? Skip.
  // Both `last` (ISO string → UTC-absolute) and `fire` (local setHours →
  // UTC-absolute) are compared as absolute timestamps, so the comparison is
  // timezone-consistent. Known edge case: on DST fall-back days the scheduler
  // may fire twice at the same HH:MM local time (clock repeats that hour).
  // This is acceptable; a duplicate submission run is idempotent because
  // runSubmission skips already-submitted WOs.
  if (settings.lastRunAt) {
    const last = new Date(settings.lastRunAt);
    if (!isNaN(last) && last >= fire) return false;
  }
  return true;
}

/**
 * Compute the next datetime the scheduler will fire, given current settings
 * and a starting moment. Used by the UI to render "Next run: ..." so the
 * operator can verify their schedule is what they expect.
 */
export function nextFireTime(settings, now = new Date()) {
  if (!settings.enabled) return null;
  const m = HHMM_RE.exec(settings.localTime);
  if (!m) return null;

  // Walk forward day-by-day looking for the next allowed weekday/date.
  const candidate = new Date(now);
  candidate.setHours(Number(m[1]), Number(m[2]), 0, 0);
  // If we've already passed today's fire time AND today has already fired
  // (or doesn't pass the day filter), start tomorrow.
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);

  // Walk forward up to 32 days; the longest valid pause is "first-of-month"
  // which is at most 31 days away from any starting point.
  for (let i = 0; i < 32; i++) {
    const allowed = (() => {
      if (settings.days === 'every-day') return true;
      if (settings.days === 'weekdays')  return candidate.getDay() !== 0 && candidate.getDay() !== 6;
      if (settings.days === 'first-of-month') return candidate.getDate() === 1;
      return false;
    })();
    if (allowed) return candidate.toISOString();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(Number(m[1]), Number(m[2]), 0, 0);
  }
  return null;   // shouldn't happen; defensive
}

// ─── Tick — process every job with un-shipped work ───────────────────────

/**
 * Iterate jobs with un-shipped work, call `runSubmission` for each. Returns
 * a per-tick summary so the UI can display "Last ran: processed 3 jobs,
 * shipped 5 WOs, deferred 2." A single job failure (e.g. quota_unavailable,
 * missing creds, Adobe outage) is logged and the loop continues — one bad
 * job shouldn't block the rest.
 */
async function runResumeForAllJobs() {
  const jobs = q().listJobsWithUnshippedWOs.all();
  const summary = {
    jobsConsidered: jobs.length,
    jobsProcessed:  0,
    jobsSkipped:    0,
    totalSubmitted: 0,
    totalDeferred:  0,
    totalFailed:    0,
    errors: [],
  };

  if (jobs.length === 0) {
    logger.info('auto-resume: no jobs with un-shipped work — nothing to do this tick');
    return summary;
  }

  for (const job of jobs) {
    try {
      const res = await runSubmission({ jobId: job.id });
      summary.jobsProcessed++;
      summary.totalSubmitted += res.submitted || 0;
      summary.totalDeferred  += res.deferred  || 0;
      summary.totalFailed    += res.failed    || 0;
      logger.info({
        jobId: job.id, name: job.name,
        submitted: res.submitted, deferred: res.deferred, failed: res.failed,
        months: res.months, shiftedFromPrevious: res.shiftedFromPrevious,
      }, 'auto-resume: job processed');
    } catch (err) {
      summary.jobsSkipped++;
      summary.errors.push({
        jobId: job.id,
        name:  job.name,
        code:  err.code || 'unknown',
        err:   err.message || String(err),
      });
      logger.warn({
        jobId: job.id, name: job.name, err: err.message, code: err.code,
      }, 'auto-resume: job failed, continuing with next');
    }
  }
  return summary;
}

async function tick() {
  if (running) {
    logger.warn('auto-resume: tick already running, skipping reentry');
    return;
  }
  running = true;
  try {
    const settings = getAutoResumeSettings();
    if (!shouldFireNow(settings)) return;

    const startedAt = new Date();
    logger.info({
      localTime: settings.localTime, days: settings.days,
    }, 'auto-resume: firing');

    const summary = await runResumeForAllJobs();
    setAutoResumeSettings({
      lastRunAt: startedAt.toISOString(),
      lastRunSummary: summary,
    });
    logger.info({ summary }, 'auto-resume: tick complete');
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'auto-resume: tick failed');
  } finally {
    running = false;
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

export function startScheduler() {
  if (timer) {
    logger.warn('auto-resume scheduler already started; ignoring duplicate start');
    return;
  }
  // Immediate catch-up tick for the "laptop was closed at scheduled time" case.
  // Fires only if shouldFireNow() agrees — i.e. we won't fire at 02:00 if
  // operator set 09:00.
  void tick();
  timer = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  logger.info({ intervalMs: TICK_INTERVAL_MS }, 'auto-resume scheduler started');
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    // Reset the reentrancy flag so a subsequent startScheduler() call gets a
    // clean state. Without this, if a tick was still awaiting when stop() was
    // called (e.g. in tests that cycle the scheduler), running=true would
    // silently suppress the next catch-up tick (F-004).
    running = false;
    logger.info('auto-resume scheduler stopped');
  }
}

// Exported for tests that want to drive a tick by hand.
export const __testInternal__ = { tick, runResumeForAllJobs };
