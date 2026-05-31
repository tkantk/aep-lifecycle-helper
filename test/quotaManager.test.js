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

test('complete deactivates the reservation (no additive floor bump)', () => {
  const o = org();
  R(o, 'wo1', 400_000);
  complete('wo1');
  // The reservation is inactive; it is NOT additively bumped into the floor —
  // a completed WO is already in Adobe's /quota and is picked up by the next
  // seedFloor. Bumping here would double-count against seedFloor's MAX.
  assert.equal(q().getReservation.get('wo1').active, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(q().getDailyFloor.get(o, today)?.adobe_floor ?? 0, 0, 'no additive bump');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0, 'effective drops (floor 0 + no active)');
});

test('R4 review HIGH: complete + external consumption cannot over-ship (no MAX-vs-bump loss)', () => {
  // reserve+complete 'a' (300k), an external tool consumes 600k, Adobe /quota
  // then reports 900k (it includes our completed 'a'). A new 'b' of 400k would
  // make 1.3M and MUST be denied. The old additive bump let MAX swallow 'a' and
  // wrongly granted 'b'.
  const o = org();
  R(o, 'a', 300_000); complete('a');
  seedFloor(o, 900_000, null);              // 600k external + 300k our completed 'a'
  assert.equal(peek(o, DAILY, null).daily.used, 900_000);
  assert.equal(R(o, 'b', 400_000, DAILY, null).granted, false, 'must deny — 1.3M > 1M cap');
});

test('R4 review MEDIUM: seedFloor seeing an active WO then completing it does not permanently double-count', () => {
  // Adobe counts 'a' fast: seedFloor sees 300k while 'a' is still active →
  // transient over-count (floor 300k + active 300k = 600k). complete('a') must
  // resolve it to 300k, not leave a permanent 600k (which would under-grant).
  const o = org();
  R(o, 'a', 300_000);
  seedFloor(o, 300_000, null);
  assert.equal(peek(o, DAILY, null).daily.used, 600_000, 'transient over-count while active + in floor');
  complete('a');
  assert.equal(peek(o, DAILY, null).daily.used, 300_000, 'resolves to 300k, not a permanent 600k');
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

// ─── job-delete / orphan cleanup (review R4.1) ──────────────────────────────

test('deleting a job clears its reservations; startup GC removes orphans', () => {
  const o = `del-org@AcmeOrg`;
  // Minimal job + work order so the reservation has a referent.
  q().insertCred.run({ id: 'del-cred', label: 'D', clientName: null, environment: 'prod',
    region: 'VA7', imsOrgId: o, clientId: 'del-client',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  q().insertJob.run({ id: 'del-job', name: 'D', credsId: 'del-cred', sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null, dailyLimit: DAILY, monthlyLimit: MONTHLY, uploadPath: null, totalSourceIds: 0 });
  q().insertWorkOrder.run({ id: 'del-wo', jobId: 'del-job', dayIndex: 1, datasetIds: 'ALL',
    targetServicesJson: null, namespacesIdentities: '[]', identifierCount: 100_000, status: 'submitting' });

  R(o, 'del-wo', 100_000);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 100_000);

  // Job-delete path: clear reservations, then the job (cascades the WO away).
  q().deleteReservationsForJob.run('del-job');
  q().deleteJob.run('del-job');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0, 'active reservation must not survive a job delete');

  // And the startup GC removes any reservation with no work order (force-delete).
  q().upsertReservation.run({ workOrderId: 'ghost-wo', imsOrgId: o, utcDate: new Date().toISOString().slice(0,10), utcMonth: new Date().toISOString().slice(0,7), count: 50_000 });
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 50_000);
  q().gcOrphanReservations.run();
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0, 'orphan reservation (no WO) GC\'d at startup');
});

// ─── multi-month: completion prevents double-count → full cap usable ─────────

test('R4 #1: multi-month — completed work is accounted via the floor, not double-counted', () => {
  const o = org();
  const monthly = 2_000_000;
  // Ship 1M (10 WOs of 100k) and complete them — complete() just deactivates;
  // the completed work is reflected by Adobe's /quota, picked up by seedFloor.
  for (let i = 0; i < 10; i++) {
    assert.equal(R(o, `c${i}`, 100_000, DAILY, monthly).granted, true);
    complete(`c${i}`);
  }
  // Adobe's /quota now reports the 1M consumed.
  seedFloor(o, 1_000_000, 1_000_000);
  assert.equal(peek(o, DAILY, monthly).monthly.used, 1_000_000,
    'monthly used = floor(1M) + active(0) = 1M — no double-count');
  // The remaining 1M of the monthly cap is still usable (no halving).
  assert.equal(R(o, 'next', 100_000, 5_000_000, monthly).granted, true);
});
