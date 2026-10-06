/**
 * Tests for src/runner/redistributor.js — the month-aware re-bucketer.
 *
 * Sets up a clean in-memory SQLite, seeds a job + N synthetic work orders,
 * runs redistribute against a few canonical quota scenarios, and asserts
 * the new (month_index, day_index) assignments.
 *
 * Phase 2 (2026-05-15).
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-redist-${Date.now()}.db`);
process.env.DB_PATH = dbPath;

// Day windows are bounded by the days left in the calendar month (2026-10-06),
// so pin "now" mid-month: these scenarios need at most 2 windows in Month 1.
const RealDate = Date;
const PINNED = new RealDate('2026-05-12T09:00:00Z').getTime() - RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + PINNED); else super(...a); }
  static now() { return RealDate.now() + PINNED; }
};

const { initDb, db, q } = await import('../src/db.js');
const { redistributeUnshippedOrders } = await import('../src/runner/redistributor.js');

let credsId;
let cleanup = [];

function seedCreds() {
  const id = uuid();
  db.prepare(`
    INSERT INTO credentials (id, label, environment, region, ims_org_id, client_id,
                             client_secret_enc, client_secret_iv, client_secret_tag)
    VALUES (?, 'test', 'Production', 'va7', 'org@AcmeOrg', 'cid', x'00', x'00', x'00')
  `).run(id);
  return id;
}

function seedJob({ dailyLimit = 1_000_000, monthlyLimit = 2_000_000 } = {}) {
  const id = uuid();
  q().insertJob.run({
    id, name: `test-${id.slice(0, 8)}`, credsId,
    sandboxName: 'sbx', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit, monthlyLimit, uploadPath: null, totalSourceIds: 0,
  });
  return id;
}

/** Insert N work orders, each with `size` identifiers, status=planned. */
function seedWorkOrders(jobId, sizes) {
  for (const size of sizes) {
    q().insertWorkOrder.run({
      id: uuid(),
      jobId,
      dayIndex: 1,       // dummy — redistribute overwrites
      datasetIds: 'ALL',
      targetServicesJson: null,
      namespacesIdentities: '[]',
      identifierCount: size,
      status: 'planned',
    });
  }
}

before(() => {
  initDb();
  credsId = seedCreds();
});

beforeEach(() => {
  // Each test uses a fresh job so state doesn't leak.
});

// ─── 100k WOs, fresh org, 1M/day, 2M/month ────────────────────────────────

// Under the R5 hold (SHIPPED_WORK_COUNTS_TWICE_UNTIL_MONTH_END) work shipped in a
// month counts twice in reserve()'s view for the rest of it: after Day 1 ships
// 1M, a 2M month reads 1M (Adobe) + 1M (held) = full. So a 2M cap ships 1M/month.
test('redistribute: 4M identifiers (40×100k) with 2M/mo cap → spans 4 months under the R5 hold', () => {
  const jobId = seedJob();
  seedWorkOrders(jobId, Array(40).fill(100_000));   // 40 × 100k = 4M

  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 2_000_000, quota: 2_000_000 },
  };
  const result = redistributeUnshippedOrders(jobId, quota);

  assert.equal(result.months, 4);
  assert.equal(result.totalUnshipped, 40);
  assert.equal(result.totalIdentifiers, 4_000_000);

  // Per-month: 10 WOs × 100k = 1M each (Day 1 of each month; Day 2 would see the month full).
  assert.deepEqual(result.perMonthCounts, [1_000_000, 1_000_000, 1_000_000, 1_000_000]);

  // Spot-check that DB rows have month_index set correctly.
  const rows = q().getAllOrdersForJob.all(jobId);
  const monthCount = rows.reduce((acc, r) => {
    acc[r.month_index] = (acc[r.month_index] || 0) + 1;
    return acc;
  }, {});
  assert.equal(monthCount[1], 10);
  assert.equal(monthCount[2], 10);
});

test('redistribute: 10M (100×100k) with 2M/mo cap → 10 months, 1 day each (R5 hold)', () => {
  const jobId = seedJob();
  seedWorkOrders(jobId, Array(100).fill(100_000));

  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 2_000_000, quota: 2_000_000 },
  };
  const result = redistributeUnshippedOrders(jobId, quota);
  assert.equal(result.months, 10);
  assert.deepEqual(result.perMonthCounts, Array(10).fill(1_000_000));

  const rows = q().getAllOrdersForJob.all(jobId);
  // Each month holds one 1M day (10 WOs) — a 2nd day would see the month full.
  for (let m = 1; m <= 10; m++) {
    const inMonth = rows.filter(r => r.month_index === m);
    assert.equal(inMonth.length, 10, `Month ${m}: 10 WOs`);
    const days = new Set(inMonth.map(r => r.day_index));
    assert.deepEqual([...days], [1], `Month ${m}: day 1 only`);
  }
});

// ─── Live quota shrinks → pushes work to later months ─────────────────────

test('redistribute: month-1 remaining of 500k pushes excess to month 2', () => {
  const jobId = seedJob();
  // 30 × 100k = 3M total; cap is 2M/mo
  seedWorkOrders(jobId, Array(30).fill(100_000));

  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 500_000,   quota: 2_000_000 },   // someone else used 1.5M this month
  };
  const result = redistributeUnshippedOrders(jobId, quota);

  // Month 1 only has 500k remaining → 5 WOs. Each later 2M month ships 1M
  // (R5 hold), so 10 + 10 WOs, and Month 4 holds the last 5 (500k).
  assert.equal(result.months, 4);
  assert.deepEqual(result.perMonthCounts, [500_000, 1_000_000, 1_000_000, 500_000]);
});

test('redistribute: when daily.remaining is partial, today fits less than tomorrow', () => {
  const jobId = seedJob();
  seedWorkOrders(jobId, Array(15).fill(100_000));   // 1.5M

  const quota = {
    daily:   { remaining: 300_000, quota: 1_000_000 }, // today: 3 WOs fit
    monthly: { remaining: 2_000_000, quota: 2_000_000 },
  };
  const result = redistributeUnshippedOrders(jobId, quota);

  // Day 1 = 3 WOs (300k, today's remainder), Day 2 = 10 WOs (1M). By Day 3 the
  // 2M month reads 1.3M shipped twice (R5 hold) = full → the last 2 go to Month 2.
  assert.equal(result.months, 2);
  const rows = q().getAllOrdersForJob.all(jobId);
  const byDay = rows.filter(r => r.month_index === 1)
    .reduce((a, r) => { a[r.day_index] = (a[r.day_index] || 0) + 1; return a; }, {});
  assert.equal(byDay[1], 3);
  assert.equal(byDay[2], 10);
  assert.equal(rows.filter(r => r.month_index === 2).length, 2);
});

// ─── Shipped WOs are untouched ────────────────────────────────────────────

test('redistribute: shipped WOs keep their stored (month_index, day_index)', () => {
  const jobId = seedJob();
  seedWorkOrders(jobId, Array(5).fill(100_000));
  // Mark first 2 as submitted, mock month=1 day=1.
  const all = q().getAllOrdersForJob.all(jobId);
  q().setOrderMonthDay.run(1, 1, all[0].id);
  q().setOrderMonthDay.run(1, 1, all[1].id);
  db.prepare(`UPDATE work_orders SET status='submitted', adobe_workorder_id='DI-x' WHERE id IN (?, ?)`)
    .run(all[0].id, all[1].id);

  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 100_000,   quota: 2_000_000 },   // very tight to force shifts
  };
  redistributeUnshippedOrders(jobId, quota);

  // Shipped WOs remain at (1,1). Unshipped (3 of them) re-bucketed.
  const fresh = q().getAllOrdersForJob.all(jobId);
  const shipped = fresh.filter(r => r.status === 'submitted');
  const unshipped = fresh.filter(r => r.status !== 'submitted');
  assert.equal(shipped.length, 2);
  shipped.forEach(r => { assert.equal(r.month_index, 1); assert.equal(r.day_index, 1); });
  // First unshipped fits in 100k remaining → month 1, day 1 (still room in the day).
  // Next 2 spill into month 2.
  assert.equal(unshipped[0].month_index, 1);
  assert.equal(unshipped[1].month_index, 2);
  assert.equal(unshipped[2].month_index, 2);
});

// ─── No monthly cap → single-month ────────────────────────────────────────

test('redistribute: monthly is ALWAYS tracked — falls back to config cap (review R4 #4)', () => {
  // Even with monthly_limit 0 (the removed "disable" value) and no Adobe
  // monthly in the snapshot, the redistributor falls back to the config monthly
  // cap (3M) and splits the 5M of work across months — monthly is never
  // "disabled".
  const jobId = seedJob({ monthlyLimit: 0 });
  seedWorkOrders(jobId, Array(50).fill(100_000));   // 5M

  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: null,   // Adobe didn't report monthly → fall back to the 3M config cap
  };
  const result = redistributeUnshippedOrders(jobId, quota);
  assert.ok(result.months >= 2, `5M against a 3M fallback monthly cap must span ≥2 months, got ${result.months}`);
});

// ─── Job state ───────────────────────────────────────────────────────────

test('redistribute: writes projected_months to the jobs row', () => {
  const jobId = seedJob();
  seedWorkOrders(jobId, Array(30).fill(100_000));   // 3M at 1M/month (2M cap, R5 hold) = 3 months
  const quota = {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 2_000_000, quota: 2_000_000 },
  };
  redistributeUnshippedOrders(jobId, quota);
  const job = q().getJob.get(jobId);
  assert.equal(job.projected_months, 3);
});

test('redistribute: no unshipped WOs is a no-op returning months=0', () => {
  const jobId = seedJob();
  const result = redistributeUnshippedOrders(jobId, {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 2_000_000, quota: 2_000_000 },
  });
  assert.equal(result.months, 0);
  assert.equal(result.totalUnshipped, 0);
});

// ─── Day-label continuity (2026-06-03) ─────────────────────────────────────
// Real prod confusion: after Day 1's window shipped, the operator clicked to
// submit "Day 2" but the button said "Day 1". The redistributor numbered the
// un-shipped tail from day=1, ignoring already-shipped windows. It must instead
// CONTINUE numbering past the highest shipped window so the label stays "Day 2".

/** Mark a WO shipped in (month, day): set its label + an Adobe id. */
function seedShippedWorkOrder(jobId, month, day, size) {
  const id = uuid();
  q().insertWorkOrder.run({
    id, jobId, dayIndex: day, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: '[]', identifierCount: size, status: 'planned',
  });
  q().setOrderMonthDay.run(month, day, id);
  q().updateWorkOrderSubmitted.run({
    id, adobeWorkorderId: `DI-${id}`, adobeStatus: 'received', bundleId: null,
    submittedAt: '2026-05-29T00:00:00Z',
  });
  return id;
}

test('redistribute: un-shipped tail continues to Day 2 (does NOT reset to Day 1)', () => {
  const jobId = seedJob({ dailyLimit: 1_000_000, monthlyLimit: 5_000_000 });
  // 10 shipped WOs of 100k = the 1,000,000 already sent as "Day 1".
  const shipped = [];
  for (let i = 0; i < 10; i++) shipped.push(seedShippedWorkOrder(jobId, 1, 1, 100_000));
  // 7 un-shipped WOs ≈ 607k — fits one fresh day.
  seedWorkOrders(jobId, Array(7).fill(86_769));   // 607,383 < 1,000,000

  redistributeUnshippedOrders(jobId, {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 5_000_000, quota: 5_000_000 },
  });

  const unshipped = q().getUnshippedOrdersForJob.all(jobId);
  assert.equal(unshipped.length, 7);
  for (const wo of unshipped) {
    assert.equal(wo.month_index, 1, 'stays in month 1');
    assert.equal(wo.day_index, 2, 'continues to Day 2 — not reset to Day 1');
  }
  // Shipped WOs are immutable (still Day 1).
  for (const id of shipped) {
    const wo = db.prepare('SELECT day_index FROM work_orders WHERE id = ?').get(id);
    assert.equal(wo.day_index, 1, 'shipped WO label is immutable');
  }
});

test('redistribute: un-shipped tail stays Day 2 even when today’s daily.remaining is 0 (shipped consumed it)', () => {
  // Edge case (reviewer finding): if Day 1 shipped TODAY and Adobe reports
  // daily.remaining = 0, the pending tail must still read Day 2 — not jump to
  // Day 3 because today's depleted remaining (which belongs to the shipped
  // work) double-penalised the tail's first, NEW-day window.
  const jobId = seedJob({ dailyLimit: 1_000_000, monthlyLimit: 5_000_000 });
  for (let i = 0; i < 10; i++) seedShippedWorkOrder(jobId, 1, 1, 100_000);   // Day 1 = 1,000,000 shipped
  seedWorkOrders(jobId, Array(7).fill(86_769));                              // 607,383 pending

  redistributeUnshippedOrders(jobId, {
    daily:   { remaining: 0,          quota: 1_000_000 },   // today's daily fully consumed by Day 1
    monthly: { remaining: 4_000_000,  quota: 5_000_000 },   // monthly still has room
  });

  const unshipped = q().getUnshippedOrdersForJob.all(jobId);
  assert.equal(unshipped.length, 7);
  for (const wo of unshipped) {
    assert.equal(wo.month_index, 1, 'stays in month 1');
    assert.equal(wo.day_index, 2, 'the next day window is Day 2, not bumped to Day 3 by an exhausted remaining');
  }
});

test('redistribute: with NO shipped WOs, numbering still starts at Day 1', () => {
  const jobId = seedJob({ dailyLimit: 1_000_000, monthlyLimit: 5_000_000 });
  seedWorkOrders(jobId, Array(5).fill(100_000));   // 500k, one day
  redistributeUnshippedOrders(jobId, {
    daily:   { remaining: 1_000_000, quota: 1_000_000 },
    monthly: { remaining: 5_000_000, quota: 5_000_000 },
  });
  const unshipped = q().getUnshippedOrdersForJob.all(jobId);
  for (const wo of unshipped) assert.equal(wo.day_index, 1, 'fresh job starts at Day 1');
});
