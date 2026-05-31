/**
 * Tests for services/quotaManager.js — reserve / release / peek across both
 * daily and monthly ledgers. Uses a temp SQLite file so state is isolated
 * per test run.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-quota-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

const { initDb } = await import('../src/db.js');
const { reserve, release, peek, seedFloor } = await import('../src/services/quotaManager.js');

const ORG = 'test-org@AcmeOrg';
const DAILY = 1_000_000;
const MONTHLY = 3_000_000;

before(() => { initDb(); });

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── seedFloor vs release (review #3) ──────────────────────────────────────────

test('release after seedFloor cannot drop the ledger below Adobe\'s observed floor', () => {
  // Review #3: Adobe reports 900k consumed. A delayed orphan release must NOT
  // pull `used` below 900k, or a later reserve would over-ship past the cap.
  const org = 'r3-seedfloor-org@AcmeOrg';
  seedFloor(org, 900_000, null);                 // adobe_floor = used = 900k
  assert.equal(peek(org, DAILY, null).daily.used, 900_000);

  // A delayed release (e.g. orphan rollback of a prior 100k reservation).
  release(org, 100_000, null);
  assert.equal(peek(org, DAILY, null).daily.used, 900_000,
    'release must clamp at the Adobe floor (900k), not drop to 800k');

  // A fresh 200k reservation must now be DENIED (900k + 200k > 1M).
  const r = reserve(org, 200_000, DAILY, null);
  assert.equal(r.granted, false, 'reserve past Adobe remaining must be denied (no over-ship)');
});

test('release still frees OUR reservations that sit above the floor', () => {
  const org = 'r3-seedfloor-org2@AcmeOrg';
  seedFloor(org, 500_000, null);                 // floor 500k
  assert.equal(reserve(org, 100_000, DAILY, null).granted, true);  // used 600k
  assert.equal(peek(org, DAILY, null).daily.used, 600_000);
  release(org, 100_000, null);                    // undo our 100k
  assert.equal(peek(org, DAILY, null).daily.used, 500_000, 'back down to the floor, not below');
});

// ─── peek ─────────────────────────────────────────────────────────────────────

test('peek: fresh org returns zero used on both daily and monthly', () => {
  const r = peek('fresh-org@AcmeOrg', DAILY, MONTHLY);
  assert.equal(r.daily.used, 0);
  assert.equal(r.daily.remaining, DAILY);
  assert.equal(r.monthly.used, 0);
  assert.equal(r.monthly.remaining, MONTHLY);
});

test('peek: monthly=null means monthly dimension is disabled', () => {
  const r = peek('noml-org@AcmeOrg', DAILY, null);
  assert.equal(r.daily.used, 0);
  assert.equal(r.monthly, null);
});

test('peek: back-compat fields (used/remaining/limit) still return daily', () => {
  const r = peek('bc-org@AcmeOrg', DAILY, MONTHLY);
  assert.equal(r.used, 0);
  assert.equal(r.remaining, DAILY);
  assert.equal(r.limit, DAILY);
});

// ─── reserve (daily only, monthly=null) ───────────────────────────────────────

test('reserve: monthly=null keeps behaviour identical to daily-only mode', () => {
  const org = 'single-dim-org@AcmeOrg';
  const r1 = reserve(org, 400, 1000, null);
  assert.equal(r1.granted, true);
  assert.equal(r1.used, 400);

  const r2 = reserve(org, 700, 1000, null);
  assert.equal(r2.granted, false);
  assert.equal(r2.reason, 'daily');
});

// ─── reserve (both dimensions) ────────────────────────────────────────────────

test('reserve: grants when both daily and monthly have room', () => {
  const r = reserve(ORG, 500_000, DAILY, MONTHLY);
  assert.equal(r.granted, true);
  assert.equal(r.used, 500_000);
  assert.equal(r.monthlyUsed, 500_000);
  assert.equal(r.remaining, DAILY - 500_000);
  assert.equal(r.monthlyRemaining, MONTHLY - 500_000);
});

test('reserve: rejects with reason="daily" when daily would overflow', () => {
  const org = 'daily-tight-org@AcmeOrg';
  reserve(org, 800_000, DAILY, MONTHLY);
  const r = reserve(org, 250_000, DAILY, MONTHLY);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'daily');
});

test('reserve: rejects with reason="monthly" when monthly would overflow even though daily is fine', () => {
  const org = 'monthly-tight-org@AcmeOrg';
  const tightMonthly = 100_000;
  reserve(org, 90_000, DAILY, tightMonthly);
  const r = reserve(org, 20_000, DAILY, tightMonthly);
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'monthly');
  assert.equal(r.monthlyUsed, 90_000);
});

test('reserve: denial does not increment either ledger', () => {
  const org = 'deny-noop-org@AcmeOrg';
  reserve(org, 50, 100, 1000);
  const r = reserve(org, 60, 100, 1000);  // daily would overflow
  assert.equal(r.granted, false);
  const p = peek(org, 100, 1000);
  assert.equal(p.daily.used, 50);    // unchanged
  assert.equal(p.monthly.used, 50);
});

// ─── release ──────────────────────────────────────────────────────────────────

test('release: decrements both daily and monthly ledgers when monthlyLimit passed', () => {
  const org = 'release-both-org@AcmeOrg';
  reserve(org, 200, 1000, 5000);
  const before = peek(org, 1000, 5000);
  assert.equal(before.daily.used, 200);
  assert.equal(before.monthly.used, 200);

  release(org, 200, 5000);
  const after = peek(org, 1000, 5000);
  assert.equal(after.daily.used, 0);
  assert.equal(after.monthly.used, 0);
});

test('release: with monthlyLimit=null, monthly ledger is NOT touched', () => {
  // This is the regression: a job with monthly tracking disabled (null)
  // must not decrement monthly counters from other jobs on the same org.
  const org = 'mixed-org@AcmeOrg';

  // Job A reserves monthly (tracking ON): monthly = 500
  reserve(org, 500, 10_000, 50_000);
  assert.equal(peek(org, 10_000, 50_000).monthly.used, 500);

  // Job B reserves daily-only (monthly tracking OFF): daily += 200, monthly unchanged
  reserve(org, 200, 10_000, null);
  assert.equal(peek(org, 10_000, 50_000).daily.used, 700);
  assert.equal(peek(org, 10_000, 50_000).monthly.used, 500);

  // Job B fails and releases — must NOT decrement monthly (which still
  // belongs to Job A).
  release(org, 200, null);
  const after = peek(org, 10_000, 50_000);
  assert.equal(after.daily.used, 500, 'daily must drop by 200');
  assert.equal(after.monthly.used, 500, 'monthly must remain at Job A reservation');
});

test('release: floor at zero (can\'t go negative)', () => {
  const org = 'floor-org@AcmeOrg';
  reserve(org, 10, 1000, 5000);
  release(org, 999, 5000);
  const p = peek(org, 1000, 5000);
  assert.equal(p.daily.used, 0);
  assert.equal(p.monthly.used, 0);
});

// ─── Sequential, atomic behaviour ─────────────────────────────────────────────

test('reserve: sequential calls cannot over-allocate in either dimension', () => {
  const org = 'seq-org@AcmeOrg';
  const dayLimit = 100;
  const monthLimit = 350;

  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(reserve(org, 30, dayLimit, monthLimit));
  }

  const granted = results.filter(r => r.granted);
  const denied = results.filter(r => !r.granted);

  // 100/30 = 3 full grants → 90 used, 4th of 30 would hit 120>100 → denied.
  // No subsequent call can succeed either (daily is always the gate).
  assert.equal(granted.length, 3);
  assert.equal(denied.length, 7);
  // All denials here are for daily — monthly limit (350) is never hit because
  // daily blocks first.
  assert.ok(denied.every(r => r.reason === 'daily'));

  const p = peek(org, dayLimit, monthLimit);
  assert.equal(p.daily.used, 90);
  assert.equal(p.monthly.used, 90);
});
