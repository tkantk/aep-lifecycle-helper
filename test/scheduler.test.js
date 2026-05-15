/**
 * Phase 3 scheduler tests.
 *
 * Two layers:
 *   1. Pure-function `shouldFireNow` and `nextFireTime` exercises every
 *      gate (enabled / days / time / lastRunAt) with explicit `now`
 *      injection. No DB, no Adobe, no timers.
 *   2. Settings round-trip via the GET + PUT routes — including invalid-
 *      input rejection (per F7 / Phase 1 conventions).
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const dbPath = path.join(os.tmpdir(), `aep-test-scheduler-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb } = await import('../src/db.js');
const {
  shouldFireNow, nextFireTime,
  getAutoResumeSettings, setAutoResumeSettings,
} = await import('../src/runner/scheduler.js');
const settingsRouter = (await import('../src/routes/settings.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server, baseUrl;

before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

beforeEach(() => {
  // Reset settings to defaults between tests so state doesn't leak.
  setAutoResumeSettings({
    enabled: false, localTime: '09:00', days: 'every-day',
    lastRunAt: null, lastRunSummary: null,
  });
});

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const url = new URL(baseUrl + pathname);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── shouldFireNow: pure function ────────────────────────────────────────

test('shouldFireNow returns false when disabled', () => {
  const settings = { enabled: false, localTime: '09:00', days: 'every-day', lastRunAt: null };
  const now = new Date('2026-05-15T10:00:00');   // 10am local
  assert.equal(shouldFireNow(settings, now), false);
});

test('shouldFireNow returns true when fire time has passed and no prior run today', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'every-day', lastRunAt: null };
  // 9:30am local — past today's 9:00 fire time, never fired before.
  const now = new Date(2026, 4, 15, 9, 30, 0);
  assert.equal(shouldFireNow(settings, now), true);
});

test('shouldFireNow returns false BEFORE fire time today', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'every-day', lastRunAt: null };
  const now = new Date(2026, 4, 15, 8, 59, 0);  // 8:59am local
  assert.equal(shouldFireNow(settings, now), false);
});

test('shouldFireNow returns false when already fired since today\'s fire time', () => {
  const today9am = new Date(2026, 4, 15, 9, 0, 0);
  const settings = {
    enabled: true, localTime: '09:00', days: 'every-day',
    lastRunAt: today9am.toISOString(),   // we fired at 9am
  };
  const now = new Date(2026, 4, 15, 14, 0, 0);   // 2pm — should NOT fire again today
  assert.equal(shouldFireNow(settings, now), false);
});

test('shouldFireNow returns true when last fire was BEFORE today\'s fire time', () => {
  const yesterday9am = new Date(2026, 4, 14, 9, 0, 0);
  const settings = {
    enabled: true, localTime: '09:00', days: 'every-day',
    lastRunAt: yesterday9am.toISOString(),
  };
  const now = new Date(2026, 4, 15, 9, 1, 0);   // today, 9:01am — yesterday's fire counted; need today's
  assert.equal(shouldFireNow(settings, now), true);
});

test('shouldFireNow: weekdays-only skips Saturday and Sunday', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'weekdays', lastRunAt: null };
  const sat = new Date(2026, 4, 16, 10, 0, 0);   // 2026-05-16 is a Saturday
  const sun = new Date(2026, 4, 17, 10, 0, 0);
  const mon = new Date(2026, 4, 18, 10, 0, 0);
  assert.equal(shouldFireNow(settings, sat), false);
  assert.equal(shouldFireNow(settings, sun), false);
  assert.equal(shouldFireNow(settings, mon), true);
});

test('shouldFireNow: first-of-month fires only on the 1st', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'first-of-month', lastRunAt: null };
  const first = new Date(2026, 5, 1, 10, 0, 0);   // June 1
  const second = new Date(2026, 5, 2, 10, 0, 0);  // June 2
  const fifteenth = new Date(2026, 5, 15, 10, 0, 0);
  assert.equal(shouldFireNow(settings, first), true);
  assert.equal(shouldFireNow(settings, second), false);
  assert.equal(shouldFireNow(settings, fifteenth), false);
});

test('shouldFireNow: malformed localTime fails closed (returns false)', () => {
  const settings = { enabled: true, localTime: 'not-a-time', days: 'every-day', lastRunAt: null };
  const now = new Date(2026, 4, 15, 10, 0, 0);
  assert.equal(shouldFireNow(settings, now), false);
});

// ─── nextFireTime: projection ────────────────────────────────────────────

test('nextFireTime returns null when disabled', () => {
  const settings = { enabled: false, localTime: '09:00', days: 'every-day' };
  assert.equal(nextFireTime(settings, new Date(2026, 4, 15, 10, 0, 0)), null);
});

test('nextFireTime: every-day before fire-time today → today at 09:00', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'every-day' };
  const now = new Date(2026, 4, 15, 8, 0, 0);   // 8am
  const next = new Date(nextFireTime(settings, now));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 15);
});

test('nextFireTime: every-day after fire-time → tomorrow at 09:00', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'every-day' };
  const now = new Date(2026, 4, 15, 10, 0, 0);   // 10am
  const next = new Date(nextFireTime(settings, now));
  assert.equal(next.getDate(), 16);
  assert.equal(next.getHours(), 9);
});

test('nextFireTime: weekdays-only after Friday\'s fire → Monday', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'weekdays' };
  // Friday 2026-05-15 at 10am; next should be Monday 2026-05-18 at 09:00.
  const fri = new Date(2026, 4, 15, 10, 0, 0);
  const next = new Date(nextFireTime(settings, fri));
  assert.equal(next.getDay(), 1);   // Monday
  assert.equal(next.getDate(), 18);
});

test('nextFireTime: first-of-month from mid-month → 1st of next month', () => {
  const settings = { enabled: true, localTime: '09:00', days: 'first-of-month' };
  const now = new Date(2026, 4, 15, 8, 0, 0);   // May 15
  const next = new Date(nextFireTime(settings, now));
  assert.equal(next.getDate(), 1);
  assert.equal(next.getMonth(), 5);   // June
});

// ─── Route validation ────────────────────────────────────────────────────

test('GET /api/settings/auto-resume returns defaults on first run', async () => {
  const res = await request('GET', '/api/settings/auto-resume');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.localTime, '09:00');
  assert.equal(res.body.days, 'every-day');
  assert.equal(res.body.lastRunAt, null);
  // nextFireAt should be null because disabled.
  assert.equal(res.body.nextFireAt, null);
});

test('PUT /api/settings/auto-resume accepts a complete valid payload', async () => {
  const res = await request('PUT', '/api/settings/auto-resume', {
    enabled: true, localTime: '13:30', days: 'weekdays',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.localTime, '13:30');
  assert.equal(res.body.days, 'weekdays');
  assert.ok(res.body.nextFireAt, 'enabled config should compute a nextFireAt');
});

test('PUT /api/settings/auto-resume accepts a partial payload (just enabled)', async () => {
  // First set time + days
  await request('PUT', '/api/settings/auto-resume', { localTime: '08:30', days: 'first-of-month' });
  // Then partial — only flip enabled.
  const res = await request('PUT', '/api/settings/auto-resume', { enabled: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.localTime, '08:30');
  assert.equal(res.body.days, 'first-of-month');
});

test('PUT rejects invalid localTime format', async () => {
  const res = await request('PUT', '/api/settings/auto-resume', { localTime: '9am' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /HH:MM/i);
});

test('PUT rejects invalid days value', async () => {
  const res = await request('PUT', '/api/settings/auto-resume', { days: 'on-mondays' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /days must be one of/i);
});

test('PUT rejects non-boolean enabled', async () => {
  const res = await request('PUT', '/api/settings/auto-resume', { enabled: 'yes' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /boolean/i);
});

test('PUT does not let callers write lastRunAt / lastRunSummary', async () => {
  // These fields are reserved for the scheduler itself. Caller attempts
  // to set them should be silently ignored (route doesn't even read them).
  const res = await request('PUT', '/api/settings/auto-resume', {
    enabled: true,
    lastRunAt: '2026-01-01T00:00:00.000Z',
    lastRunSummary: { jobsProcessed: 999 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.lastRunAt, null);
  assert.equal(res.body.lastRunSummary, null);
});
