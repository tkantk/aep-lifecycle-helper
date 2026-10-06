/**
 * Fixes 2 + 3 (2026-10-06 review): day/month buckets are sized with the SAME
 * numbers reserve() gates on, months are anchored to the calendar, and
 * awaiting-approval orders are re-bucketed too.
 *
 * Before: the redistributor sized buckets from Adobe's raw `remaining`, while
 * reserve() (the real gate) counts Adobe's consumed + this tool's held
 * reservations and applies QUOTA_SAFETY_BUFFER. Planned days therefore held
 * work reserve() would refuse ("Day 3 — 10 deferred" with real headroom; with a
 * 10 % buffer every 10-order day shipped 9 and deferred 1). Month labels were
 * counted from the last shipped month, so after a rollover November's work was
 * labelled "Month 1, Day 4", and awaiting-approval orders kept plan-time labels.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-redist-cap-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const RealDate = Date;
let offsetMs = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offsetMs); else super(...a); }
  static now() { return RealDate.now() + offsetMs; }
}
globalThis.Date = FakeDate;
const setClock = (iso) => { offsetMs = new RealDate(iso).getTime() - RealDate.now(); };

const { initDb, db, q, bulkInsertIdentities } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { redistributeUnshippedOrders } = await import('../src/runner/redistributor.js');
const { reserve, markAccepted, seedFloor } = await import('../src/services/quotaManager.js');
const { planWorkOrders } = await import('../src/runner/submission.js');

before(() => { initDb(); });
after(() => {
  globalThis.Date = RealDate;
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

let seq = 0;
function seedJob() {
  seq++;
  const credsId = uuid();
  const org = `cap-org-${seq}@AdobeOrg`;
  db.prepare(`INSERT INTO credentials (id, label, environment, region, ims_org_id, client_id,
    client_secret_enc, client_secret_iv, client_secret_tag)
    VALUES (?, 't', 'Production', 'va7', ?, ?, x'00', x'00', x'00')`).run(credsId, org, `cap-client-${seq}`);
  const jobId = uuid();
  q().insertJob.run({
    id: jobId, name: `cap ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 10_000_000, uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run('ready', null, jobId);
  return { jobId, org };
}
function seedOrders(jobId, n, size = 100_000, status = 'planned') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = uuid();
    ids.push(id);
    q().insertWorkOrder.run({ id, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
      namespacesIdentities: '[]', identifierCount: size, status });
  }
  return ids;
}
/** A shipped order this tool already sent (Adobe-acked, reservation held), labelled (m, d). */
function seedShipped(jobId, org, m, d, size = 100_000) {
  const [id] = seedOrders(jobId, 1, size);
  q().setOrderMonthDay.run(m, d, id);
  reserve({ workOrderId: id, imsOrgId: org, count: size, dailyLimit: 1e12, monthlyLimit: 1e12 });
  markAccepted(id);
  q().updateWorkOrderSubmitted.run({ id, adobeWorkorderId: `DI-${id}`, adobeStatus: 'received', bundleId: null, submittedAt: null });
  return id;
}
const quota = (dailyConsumed, monthlyConsumed, monthly = 10_000_000) => ({
  daily:   { quota: 1_000_000, consumed: dailyConsumed, remaining: 1_000_000 - dailyConsumed },
  monthly: { quota: monthly, consumed: monthlyConsumed, remaining: monthly - monthlyConsumed },
});
const labels = (jobId) => q().getAllOrdersForJob.all(jobId)
  .filter(w => !w.adobe_workorder_id)
  .reduce((acc, w) => { const k = `M${w.month_index}D${w.day_index}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});

test('current month is sized like reserve(): held reservations count, so the plan holds only what will ship', () => {
  setClock('2026-10-05T09:00:00Z');
  const { jobId, org } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  for (let i = 0; i < 20; i++) seedShipped(jobId, org, 1, 1 + Math.floor(i / 10));   // 2M shipped earlier this month (held)
  seedFloor(org, 0, 2_000_000);                                                       // Adobe already counts them too
  seedOrders(jobId, 80);                                                              // 8M still to ship

  const r = redistributeUnshippedOrders(jobId, quota(0, 2_000_000));
  // reserve() sees 2M (Adobe) + 2M (held) = 4M of 10M. Today's daily is spent
  // (the 2M was held today), so October ships from tomorrow, and each day's
  // 1M then counts twice (Adobe + held): Oct 6, 7, 8 → 3M, then the month is full.
  assert.equal(r.perMonthCounts[0], 3_000_000, 'Month 1 holds exactly what reserve() will grant this month');
  assert.equal(r.perMonthCounts[1], 5_000_000);
});

test('first day is sized like reserve(): today\'s held reservations shrink it', () => {
  setClock('2026-10-06T09:00:00Z');
  const { jobId, org } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  for (let i = 0; i < 3; i++) seedShipped(jobId, org, 1, 1);    // 300k shipped earlier TODAY, held
  seedFloor(org, 300_000, 300_000);                             // ...and already in Adobe's counters
  seedOrders(jobId, 12);

  redistributeUnshippedOrders(jobId, quota(300_000, 300_000));
  // reserve() sees 300k + 300k = 600k used today → 4 more fit today.
  assert.equal(labels(jobId).M1D2, 4, 'the next window holds what can still ship today');
  assert.equal(labels(jobId).M1D3, 8);
});

test('safety buffer: a 10-order day is sized to the buffered cap (9), not the raw cap', () => {
  setClock('2026-10-07T09:00:00Z');
  const prev = config.quotaSafetyBuffer;
  config.quotaSafetyBuffer = 0.1;
  try {
    const { jobId } = seedJob();
    q().setPlanAnchorMonth.run('2026-10', jobId);
    seedOrders(jobId, 20);
    redistributeUnshippedOrders(jobId, quota(0, 0));
    assert.equal(labels(jobId).M1D1, 9, 'reserve() grants 900k/day with a 10 % buffer');
  } finally {
    config.quotaSafetyBuffer = prev;
  }
});

test('months follow the calendar: after rollover the tail is "Month 2, Day 1", not "Month 1, Day 3"', () => {
  setClock('2026-10-20T09:00:00Z');
  const { jobId, org } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  for (let i = 0; i < 20; i++) seedShipped(jobId, org, 1, 1 + Math.floor(i / 10));   // shipped Oct 20 + 21
  seedOrders(jobId, 15);

  setClock('2026-11-02T09:00:00Z');                 // new calendar month: October's holds no longer count
  const r = redistributeUnshippedOrders(jobId, quota(0, 0));
  assert.deepEqual(labels(jobId), { M2D1: 10, M2D2: 5 });
  assert.equal(r.currentMonthIndex, 2);
  assert.equal(r.anchorMonth, '2026-10');
});

test('awaiting-approval orders are re-bucketed with the rest, never into Month 1', () => {
  setClock('2026-10-08T09:00:00Z');
  const { jobId } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  seedOrders(jobId, 20);                              // Month 1 work (approved)
  const awaiting = seedOrders(jobId, 20, 100_000, 'awaiting_approval');
  for (const id of awaiting) q().setOrderMonthDay.run(2, 1, id);   // stale plan-time label

  // Someone else used most of October: only 1M left this month.
  redistributeUnshippedOrders(jobId, quota(0, 9_000_000));
  const rows = q().getAllOrdersForJob.all(jobId);
  const aw = rows.filter(w => w.status === 'awaiting_approval');
  assert.ok(aw.every(w => w.month_index >= 2), 'awaiting work never lands in the current plan month');
  const approved = rows.filter(w => w.status === 'planned');
  assert.equal(approved.filter(w => w.month_index === 1).length, 10, 'October holds the 1M that is left');
  // The other 10 approved orders take November's Day 1; the awaiting work is
  // queued BEHIND them (Days 2-3), not left on its stale plan-time "Day 1".
  assert.deepEqual(approved.filter(w => w.month_index === 2).map(w => w.day_index), Array(10).fill(1));
  assert.deepEqual([...new Set(aw.map(w => `${w.month_index}:${w.day_index}`))].sort(), ['2:2', '2:3']);
  // Approving "Month 2" still works by label.
  const res = q().approveMonth.run(jobId, 2);
  assert.ok(res.changes > 0);
});

test('a job planned before this change gets an anchor that keeps its shipped month current', () => {
  setClock('2026-10-09T09:00:00Z');
  const { jobId, org } = seedJob();                 // plan_anchor_month NULL (legacy)
  for (let i = 0; i < 10; i++) seedShipped(jobId, org, 1, 1);
  seedOrders(jobId, 5);
  redistributeUnshippedOrders(jobId, quota(0, 0));
  assert.equal(q().getJob.get(jobId).plan_anchor_month, '2026-10');
  assert.deepEqual(labels(jobId), { M1D2: 5 }, 'legacy job keeps continuing its current month');
});

test('planning stamps the calendar month the plan starts in', () => {
  setClock('2027-02-14T09:00:00Z');
  const { jobId } = seedJob();
  q().updateJobStatus.run('expanded', null, jobId);
  bulkInsertIdentities([[jobId, 'email', 6, 'a@x.com', 'k1']]);
  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null, quota: quota(0, 0) });
  assert.equal(q().getJob.get(jobId).plan_anchor_month, '2027-02');
});

test('a late-month plan gets only as many day windows as the month has days left', () => {
  setClock('2026-10-29T09:00:00Z');                 // Oct 29, 30, 31 left
  const { jobId } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  seedOrders(jobId, 68);
  const r = redistributeUnshippedOrders(jobId, quota(0, 0, 30_000_000));
  const l = labels(jobId);
  assert.deepEqual(Object.keys(l).filter(k => k.startsWith('M1')).sort(), ['M1D1', 'M1D2', 'M1D3'],
    '"Month 1 (Oct)" may not claim days that are in November');
  assert.equal(r.perMonthCounts[0], 3_000_000);
  assert.equal(r.months, 2, 'the rest is Month 2 (Nov) — so it needs Month-2 approval');
});

test('the plan follows the R5 hold: work shipped this month counts twice for the rest of it', () => {
  // reserve() sees Adobe's consumed (which includes our shipped work once Adobe
  // counts it) PLUS our held reservations — so a 10M month holds ~5M of ours.
  setClock('2026-10-05T09:00:00Z');
  const { jobId } = seedJob();
  q().setPlanAnchorMonth.run('2026-10', jobId);
  seedOrders(jobId, 68);
  const r = redistributeUnshippedOrders(jobId, quota(0, 0, 10_000_000));
  assert.equal(r.perMonthCounts[0], 5_000_000, 'Days 1-5 in October');
  assert.equal(r.perMonthCounts[1], 1_800_000, 'the rest in November');
});
