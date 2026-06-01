/**
 * Tests for services/quotaManager.js — the per-work-order reservation model
 * (review R4 #1) under the HOLD-UNTIL-ROLLOVER lifecycle (review R5).
 *
 *   effective_used(period) = adobe_floor(period) + Σ active reservations(period)
 *
 * R5 lifecycle (replaces R4.1's deactivate-on-terminal, which the design review
 * proved over-ships): an Adobe-ACCEPTED reservation is NEVER dropped mid-period.
 * It is held until the UTC day/month rolls over (Adobe's counter resets then
 * too), at which point it auto-expires by period-keying. There is NO timer- or
 * floor-delta-based drop — every such heuristic over-ships under a concurrent
 * external Adobe consumer (no per-tool attribution on the org-wide /quota).
 *
 *   reserve()      → active=1, accepted=0 (pending: committed locally, not acked)
 *   markAccepted() → accepted=1           (Adobe acked the POST; counts on Adobe)
 *   release()      → active=0 IFF accepted=0 (refund only un-accepted work)
 *   reactivate()   → active=1, accepted=1 (a 'failed' WO Adobe actually processed)
 *   (complete() is REMOVED — terminal status no longer touches quota.)
 *
 * Uses a temp SQLite file.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-quota-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

const { initDb, q, db } = await import('../src/db.js');
const { reserve, release, reactivate, markAccepted, peek, seedFloor } =
  await import('../src/services/quotaManager.js');

const DAILY = 1_000_000;
const MONTHLY = 3_000_000;

let n = 0;
const org = () => `org-${++n}@AcmeOrg`;          // unique org per test (shared DB)
const R = (o, wo, count, daily = DAILY, monthly = MONTHLY) =>
  reserve({ workOrderId: wo, imsOrgId: o, count, dailyLimit: daily, monthlyLimit: monthly });

function todayUtc()  { const d = new Date(); return d.toISOString().slice(0, 10); }
function monthUtc()  { const d = new Date(); return d.toISOString().slice(0, 7); }
// A day in the CURRENT UTC month that is NOT today — so a reservation dated here
// counts in this month's monthly sum but not today's daily sum. Rollover-proof
// (works on the 1st of the month too: it picks the 2nd). Day 1 and day 2 exist
// in every month. (Review R8 #3 — replaces a hardcoded date that broke at UTC
// month rollover.)
function otherDayThisMonth() {
  const d = new Date();
  const ym = d.toISOString().slice(0, 7);
  const otherDay = d.getUTCDate() === 1 ? 2 : 1;
  return { date: `${ym}-${String(otherDay).padStart(2, '0')}`, month: ym };
}

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
  for (let i = 0; i < 10; i++) assert.equal(R(o, `wo${i}`, 300_000, 5_000_000, MONTHLY).granted, true);
  const r = R(o, 'woX', 300_000, 5_000_000, MONTHLY);   // 3.3M > 3M
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'monthly');
});

// ─── accept / release / reactivate ──────────────────────────────────────────

test('markAccepted flips a reservation to accepted; it stays active and counted', () => {
  const o = org();
  R(o, 'wo1', 400_000);
  markAccepted('wo1');
  assert.equal(q().getReservation.get('wo1').accepted, 1);
  assert.equal(q().getReservation.get('wo1').active, 1);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 400_000, 'accepted work still counts');
});

test('release deactivates an UN-accepted reservation and frees the quota', () => {
  const o = org();
  R(o, 'wo1', 600_000);                       // accepted=0 (pending)
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 600_000);
  release('wo1');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0, 'un-accepted reservation frees quota');
});

test('release REFUSES to deactivate an ACCEPTED reservation (no refund of Adobe-processed work)', () => {
  const o = org();
  R(o, 'wo1', 600_000);
  markAccepted('wo1');                         // Adobe acked it
  release('wo1');                              // must be a no-op
  assert.equal(q().getReservation.get('wo1').active, 1, 'accepted reservation must NOT be released');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 600_000, 'quota stays held — Adobe spent it');
});

test('R8 #1: markAccepted reactivates a (racily) released reservation — Adobe-acked work is never left uncounted', () => {
  // The blocker: if release-absent slips in during a WO's in-flight POST, the
  // reservation goes active=0; the delayed Adobe 2xx then calls markAccepted.
  // Pre-R8 markAccepted only set accepted=1 (NOT active=1), so the spend stayed
  // uncounted → over-ship. markAccepted now re-activates the hold defensively.
  const o = org();
  R(o, 'wo1', 100_000);                         // active=1, accepted=0
  release('wo1');                                // active=0 (simulated race)
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0);
  markAccepted('wo1');                           // Adobe 2xx arrives
  const row = q().getReservation.get('wo1');
  assert.equal(row.active, 1, 'markAccepted re-activates the hold (defense-in-depth)');
  assert.equal(row.accepted, 1);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 100_000, 'the Adobe spend is counted again — no over-ship');
});

test('reactivate restores a released reservation AS accepted', () => {
  const o = org();
  R(o, 'wo1', 500_000);
  release('wo1');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 0);
  reactivate('wo1');                           // recovery: Adobe actually processed it
  const row = q().getReservation.get('wo1');
  assert.equal(row.active, 1);
  assert.equal(row.accepted, 1, 'a reactivated WO was processed by Adobe → accepted');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 500_000);
});

// ─── R5 core: hold-until-rollover (no mid-period drop) ───────────────────────

test('R5 finding #1: an accepted reservation is HELD on terminal status — capacity is not reopened mid-period', () => {
  // The pre-R5 bug: the monitor deactivated an accepted reservation when the WO
  // reached a terminal Adobe state, reopening capacity before the floor caught
  // up → over-ship. R5 removes complete(); the reservation stays active.
  const o = org();
  q().maxDailyFloor.run(o, todayUtc(), 900_000);   // 900k external already consumed
  assert.equal(R(o, 'A', 100_000, DAILY, null).granted, true);   // floor900 + A100 = 1.0M
  markAccepted('A');                                // Adobe acked A; it's now terminal-bound
  // No complete()/drop happens. A new order must be DENIED — true usage is 1.0M.
  assert.equal(peek(o, DAILY, null).daily.used, 1_000_000);
  assert.equal(R(o, 'B', 100_000, DAILY, null).granted, false,
    'must deny — A is held, 900k+100k = cap; reopening A would over-ship');
});

test('R5: seedFloor only MAXes the floor — it never drops a held reservation', () => {
  const o = org();
  R(o, 'A', 300_000); markAccepted('A');
  // Adobe /quota now reports 300k (it has assimilated A). seedFloor MAXes.
  seedFloor(o, 300_000, 300_000);
  // SAFE transient over-defer: floor(300k) + active(300k) = 600k. A is NOT
  // dropped (no attribution proves the 300k floor is OURS vs external). This
  // resolves at period rollover, never by an unsafe mid-period drop.
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 600_000,
    'held + floor double-counts until rollover — the SAFE direction (over-defer)');
});

// ─── period rollover: reservations auto-expire by period-keying ──────────────

test('R5: a prior-DAY reservation does not count in today\'s daily usage', () => {
  const o = org();
  q().upsertReservation.run({ workOrderId: 'ywo', imsOrgId: o, utcDate: '2000-01-01', utcMonth: monthUtc(), count: 100_000 });
  markAccepted('ywo');
  R(o, 'today', 200_000);
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 200_000,
    'yesterday\'s reservation is a different utc_date — not in today\'s daily sum');
});

test('R5: a prior-MONTH reservation does not count in the current month (auto-expiry at rollover)', () => {
  const o = org();
  q().upsertReservation.run({ workOrderId: 'lastmonth', imsOrgId: o, utcDate: '2000-01-15', utcMonth: '2000-01', count: 500_000 });
  markAccepted('lastmonth');
  R(o, 'thismonth', 200_000);
  assert.equal(peek(o, DAILY, MONTHLY).monthly.used, 200_000,
    'last month\'s held reservation auto-expires from this month\'s monthly sum');
});

// ─── seedFloor keeps reservations separate from the floor ────────────────────

test('R5: seedFloor does not absorb our reservations; releasing un-accepted frees only ours', () => {
  const o = org();
  R(o, 'orphan', 100_000);                 // our reservation (pending), not in Adobe's number yet
  seedFloor(o, 900_000, null);             // others consumed 900k
  assert.equal(peek(o, DAILY, null).daily.used, 1_000_000, 'floor(900k) + our orphan(100k)');
  assert.equal(R(o, 'A', 100_000, DAILY, null).granted, false, 'no room: 900k + 100k = cap');

  release('orphan');                       // Adobe never processed it (still pending) → frees ours only
  assert.equal(peek(o, DAILY, null).daily.used, 900_000, 'back to Adobe floor, not below');
  assert.equal(R(o, 'B', 100_000, DAILY, null).granted, true);
  assert.equal(peek(o, DAILY, null).daily.used, 1_000_000);
});

// ─── job-delete: status-aware (finding #2) ───────────────────────────────────

test('R5 finding #2: job-delete keeps an accepted (sent) tombstone but clears a never-sent reservation', () => {
  const o = `del-org@AcmeOrg`;
  q().insertCred.run({ id: 'del-cred', label: 'D', clientName: null, environment: 'prod',
    region: 'VA7', imsOrgId: o, clientId: 'del-client',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  q().insertJob.run({ id: 'del-job', name: 'D', credsId: 'del-cred', sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null, dailyLimit: DAILY, monthlyLimit: MONTHLY, uploadPath: null, totalSourceIds: 0 });
  // WO-sent: shipped to Adobe (status 'submitted'); WO-planned: never sent.
  q().insertWorkOrder.run({ id: 'wo-sent', jobId: 'del-job', dayIndex: 1, datasetIds: 'ALL',
    targetServicesJson: null, namespacesIdentities: '[]', identifierCount: 100_000, status: 'submitted' });
  q().insertWorkOrder.run({ id: 'wo-planned', jobId: 'del-job', dayIndex: 1, datasetIds: 'ALL',
    targetServicesJson: null, namespacesIdentities: '[]', identifierCount: 50_000, status: 'planned' });

  R(o, 'wo-sent', 100_000); markAccepted('wo-sent');   // Adobe spent it
  R(o, 'wo-planned', 50_000);                          // never sent (pending)
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 150_000);

  q().deleteReservationsForJob.run({ jobId: 'del-job' });   // status-aware
  // The accepted/sent reservation is KEPT (Adobe spent it — refunding would over-ship);
  // the never-sent planned reservation is cleared.
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 100_000,
    'sent tombstone survives delete; never-sent reservation is refunded');

  q().deleteJob.run('del-job');                        // cascades work_orders away
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 100_000, 'tombstone still counts after the WO row is gone');
});

// ─── startup GC: inactive + prior-month orphans only (finding #2 variant) ────

test('R5 finding #2: startup GC removes inactive + prior-month orphans, keeps a current-month active tombstone', () => {
  const o = `gc-org@AcmeOrg`;
  // (a) inactive orphan → removed.
  q().upsertReservation.run({ workOrderId: 'gc-inactive', imsOrgId: o, utcDate: todayUtc(), utcMonth: monthUtc(), count: 10_000 });
  release('gc-inactive');
  // (b) current-month ACTIVE accepted orphan (a force-delete tombstone) → KEPT.
  q().upsertReservation.run({ workOrderId: 'gc-tombstone', imsOrgId: o, utcDate: todayUtc(), utcMonth: monthUtc(), count: 80_000 });
  markAccepted('gc-tombstone');
  // (c) prior-month active orphan → removed (already non-counting this month).
  q().upsertReservation.run({ workOrderId: 'gc-old', imsOrgId: o, utcDate: '2000-01-01', utcMonth: '2000-01', count: 70_000 });
  markAccepted('gc-old');

  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 80_000, 'only the current-month tombstone counts');
  q().gcOrphanReservations.run(monthUtc());

  assert.equal(q().getReservation.get('gc-inactive'), undefined, 'inactive orphan GC\'d');
  assert.equal(q().getReservation.get('gc-old'), undefined, 'prior-month orphan GC\'d');
  assert.ok(q().getReservation.get('gc-tombstone'), 'current-month active tombstone survives GC');
  assert.equal(peek(o, DAILY, MONTHLY).daily.used, 80_000, 'tombstone still held after GC');
});

// ─── migration / upgrade backfill (finding #3 + synthesis must-fix) ──────────

test('R5 finding #3: migration folds legacy used→adobe_floor and marks legacy in-flight reservations accepted', () => {
  const o = 'legacy-org@AcmeOrg';
  const today = todayUtc(), month = monthUtc();
  // Pre-R4 ledger: consumption recorded in `used`, adobe_floor still 0.
  db.prepare(`INSERT INTO quota_usage (ims_org_id, utc_date, used, adobe_floor) VALUES (?,?,?,0)`).run(o, today, 100_000);
  db.prepare(`INSERT INTO quota_usage_monthly (ims_org_id, utc_year_month, used, adobe_floor) VALUES (?,?,?,0)`).run(o, month, 250_000);
  // Pre-R5 in-flight reservation: active, accepted defaulted to 0, on a SENT WO.
  q().insertCred.run({ id: 'leg-cred', label: 'L', clientName: null, environment: 'prod',
    region: 'VA7', imsOrgId: o, clientId: 'leg-client',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  q().insertJob.run({ id: 'leg-job', name: 'L', credsId: 'leg-cred', sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null, dailyLimit: DAILY, monthlyLimit: MONTHLY, uploadPath: null, totalSourceIds: 0 });
  q().insertWorkOrder.run({ id: 'leg-wo', jobId: 'leg-job', dayIndex: 1, datasetIds: 'ALL',
    targetServicesJson: null, namespacesIdentities: '[]', identifierCount: 100_000, status: 'submitted' });
  q().upsertReservation.run({ workOrderId: 'leg-wo', imsOrgId: o, utcDate: today, utcMonth: month, count: 100_000 });
  assert.equal(q().getReservation.get('leg-wo').accepted, 0, 'precondition: legacy row has accepted=0');

  initDb();   // re-run migrations + backfills (must be idempotent)

  assert.equal(q().getDailyFloor.get(o, today).adobe_floor, 100_000, 'legacy daily used folded into adobe_floor');
  assert.equal(q().getMonthlyFloor.get(o, month).adobe_floor, 250_000, 'legacy monthly used folded into adobe_floor');
  assert.equal(q().getReservation.get('leg-wo').accepted, 1,
    'legacy in-flight reservation (sent WO) promoted to accepted so release() can\'t refund it');
});

// ─── multi-day: full monthly throughput within the cap (the real workflow) ───

test('R5: multi-day shipping toward the monthly cap grants correctly (the operator\'s real job)', () => {
  const o = org();
  const monthly = 3_000_000;
  // "Day 1": a prior day THIS month (held, accepted) — counts monthly, not today's daily.
  const d1 = otherDayThisMonth();
  for (let i = 0; i < 10; i++) {
    q().upsertReservation.run({ workOrderId: `d1-${i}`, imsOrgId: o, utcDate: d1.date, utcMonth: d1.month, count: 100_000 });
    markAccepted(`d1-${i}`);
  }
  // "Day 2" (today): Adobe assimilated day-1 → monthly floor = 1M. effective = floor(1M) + held(1M) = 2M.
  q().maxMonthlyFloor.run(o, d1.month, 1_000_000);
  // A day-2 reservation of 570k (the user's actual remainder) must GRANT: 2M + 570k = 2.57M ≤ 3M.
  const r = reserve({ workOrderId: 'd2', imsOrgId: o, count: 570_000,
    dailyLimit: DAILY, monthlyLimit: monthly });
  assert.equal(r.granted, true, '2.57M ≤ 3M monthly — the real 1.57M job ships fine across two days');
});
