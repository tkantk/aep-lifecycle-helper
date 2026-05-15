import { Router } from 'express';
import {
  getAutoResumeSettings,
  setAutoResumeSettings,
  nextFireTime,
} from '../runner/scheduler.js';

const router = Router();

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VALID_DAYS = new Set(['every-day', 'weekdays', 'first-of-month']);

function fail(message, code = 'invalid_request') {
  const err = new Error(message);
  err.status = 400; err.code = code; err.publicMessage = message;
  return err;
}

/**
 * GET /api/settings/auto-resume
 * Returns current settings + the next computed fire time so the UI doesn't
 * have to duplicate the schedule math.
 */
router.get('/auto-resume', (_req, res, next) => {
  try {
    const settings = getAutoResumeSettings();
    res.json({
      ...settings,
      nextFireAt: nextFireTime(settings),
    });
  } catch (err) { next(err); }
});

/**
 * PUT /api/settings/auto-resume
 * Body: { enabled?: boolean, localTime?: 'HH:MM', days?: 'every-day' | 'weekdays' | 'first-of-month' }
 * Validates and merges with existing settings. lastRunAt / lastRunSummary are
 * NOT writable from this route — only the scheduler itself updates them.
 */
router.put('/auto-resume', (req, res, next) => {
  try {
    const body = req.body || {};
    const partial = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return next(fail('enabled must be a boolean'));
      }
      partial.enabled = body.enabled;
    }
    if (body.localTime !== undefined) {
      if (typeof body.localTime !== 'string' || !HHMM_RE.test(body.localTime)) {
        return next(fail('localTime must be HH:MM in 24-hour format (e.g. "09:00")'));
      }
      partial.localTime = body.localTime;
    }
    if (body.days !== undefined) {
      if (!VALID_DAYS.has(body.days)) {
        return next(fail(`days must be one of: ${[...VALID_DAYS].join(', ')}`));
      }
      partial.days = body.days;
    }

    const merged = setAutoResumeSettings(partial);
    res.json({
      ...merged,
      nextFireAt: nextFireTime(merged),
    });
  } catch (err) { next(err); }
});

export default router;
