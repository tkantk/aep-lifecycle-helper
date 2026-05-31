/**
 * Tests for services/quotaManager.js — the per-work-order reservation model
 * (review R4 #1). effective_used(period) = adobe_floor(period)
 *   + Σ active reservations(period). Reservations are keyed by work-order id so
 * release/complete are exact and period-correct. Uses a temp SQLite file.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-quota-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

const { initDb, q } = await import('../src/db.js');
const { reserve, release, reactivate, complete, peek, seedFloor } =
  await import('../src/services/quotaManager.js');

const DAILY = 1_000_000;
const MONTHLY = 3_000_000;

let n = 0;
const org = () => `org-${++n}@AcmeOrg`;          // unique org per test (shared DB)
const R = (o, wo, count, daily = DAILY, monthly = MONTHLY) =>
  reserve({ workOrderId: wo, imsOrgId: o, count, dailyLimit: daily, monthlyLimit: monthly });

before(() => { initDb(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

// ─── basic grant / deny ─────────────────────────────────────────────────────

test('reserve grants within caps and records a per-WO reservation', () => {
  const o = org();
  const r = R(o, 'wo1', 400_000);
  assert.equal(r.granted, true);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 400_000);
});

test('reserve denies on daily overflow without recording', () => {
  const o = org();
  assert.equal(R(o, 'wo1', 700_000).granted, true);
  const r = R(o, 'wo2', 400_000);   // 1.1M > 1M
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'daily');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 700_000, 'denied reserve must not be recorded');
});

test('reserve denies on monthly overflow', () => {
  const o = org();
  // 11 orders of 300k against a 3M monthly cap → 12th (would be 3.3M, but daily
  // caps at 1M/day so use a high daily) is denied monthly.
  for (let i = 0; i < 10; i++) assert.equal(R(o, `wo${i}`, 300_000, 5_000_000, MONTHLY).granted, true);
  const r = R(o, 'woX', 300_000, 5_000_000, MONTHLY);   // 3.3M > 3M
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'monthly');
});

// ─── release / complete / reactivate ────────────────────────────────────────

test('release deactivates the WO reservation and frees the quota', () => {
  const o = org();
  R(o, 'wo1', 600_000);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 600_000);
  release('wo1');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0, 'released reservation frees quota');
});

test('reactivate restores a released reservation', () => {
  const o = org();
  R(o, 'wo1', 500_000);
  release('wo1');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0);
  reactivate('wo1');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 500_000);
});

test('complete moves a reservation into adobe_floor with effective unchanged', () => {
  const o = org();
  R(o, 'wo1', 400_000);
  const before = peek(o, DAILY, MONTHLY).daily.used;
  complete('wo1');
  const after = peek(o, DAILY, MONTHLY).daily.used;
  assert.equal(after, before, 'effective used unchanged (active → floor)');
  // The reservation is now inactive; the floor carries it.
  assert.equal(q().getReservation.get('wo1').active, 0);
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
  assert.equal(q().getDailyFloor.get(o, today)?.adobe_floor, 400_000);
});

// ─── review #1: same-day delayed release must not lose ownership ─────────────

test('R4 #1: seedFloor does not absorb our reservations; delayed release frees only ours', () => {
  const o = org();
  R(o, 'orphan', 100_000);                 // our reservation, not yet in Adobe's number
  seedFloor(o, 900_000, null);             // others consumed 900k
  assert.equal(peek(o, DAILY, null).daily.used, 1_000_000, 'floor(900k) + our orphan(100k)');

  // A new order would exceed the cap → DENIED (no room; true usage already 1M).
  assert.equal(R(o, 'A', 100_000, DAILY, null).granted, false,
    'no room: 900k others + 100k orphan = cap');

  // The orphan is rolled back (Adobe never processed it) — frees ONLY its 100k.
  release('orphan');
  assert.equal(peek(o, DAILY, null).daily.used, 900_000, 'back to Adobe floor, not below');

  // Now a new order fits exactly.
  assert.equal(R(o, 'B', 100_000, DAILY, null).granted, true);
  assert.equal(peek(o, DAILY, null).daily.used, 1_000_000);
});

// ─── cross-day: release uses the reservation's OWN period ───────────────────

test('R4 #1: releasing a prior-day reservation does not touch today\'s usage', () => {
  const o = org();
  // Directly seed a reservation dated "yesterday" (a different utc_date).
  q().upsertReservation.run({ workOrderId: 'ywo', imsOrgId: o, utcDate: '2000-01-01', utcMonth: '2000-01', count: 100_000 });
  R(o, 'todaywo', 200_000);
  const todayBefore = peek(o, DAILY, MONTHLY).daily.used;
  assert.equal(todayBefore, 200_000, 'yesterday reservation is a different period, not in today');

  release('ywo');   // release the yesterday WO
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 200_000,
    'releasing a prior-day reservation must not decrement today');
  assert.equal(q().getReservation.get('ywo').active, 0, 'and it did deactivate the right (yesterday) row');
});

// ─── multi-month: completion prevents double-count → full cap usable ─────────

test('R4 #1: completing work + seedFloor reflecting it does not double-count the monthly floor', () => {
  const o = org();
  const monthly = 2_000_000;
  // Ship 1M (10 WOs of 100k), complete them — each complete() bumps the monthly
  // floor by 100k (1M total moved from active reservations into the floor).
  for (let i = 0; i < 10; i++) {
    assert.equal(R(o, `c${i}`, 100_000, DAILY, monthly).granted, true);
    complete(`c${i}`);
  }
  assert.equal(peek(o, DAILY, monthly).monthly.used, 1_000_000, 'completion moved 1M into the floor');
  // Adobe's /quota now reports that same 1M consumed. seedFloor MAX must NOT add
  // on top of the completion bumps — otherwise the monthly cap would halve.
  seedFloor(o, 1_000_000, 1_000_000);
  assert.equal(peek(o, DAILY, monthly).monthly.used, 1_000_000,
    'no double-count: MAX(1M floor, 1M Adobe) stays 1M, not 2M');
});
