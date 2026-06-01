/**
 * Tests for runner/submission.js::planWorkOrders.
 *
 * Seeds expanded_identities directly and asserts on the work_orders rows
 * that the planner produces. Uses a temp SQLite DB for isolation.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-plan-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
// Prevent config from needing real paths for upload / output dirs
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, bulkInsertIdentities, prepareStreamIdentitiesBySource, q } = await import('../src/db.js');
const { planWorkOrders } = await import('../src/runner/submission.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let credSeq = 0;
function insertCred() {
  credSeq++;
  const id = `cred-${credSeq}`;
  q().insertCred.run({
    id,
    label: 'Test',
    clientName: null,
    environment: 'prod',
    region: 'VA7',
    imsOrgId: `org-${credSeq}@AcmeOrg`,
    clientId: `client-${credSeq}`,
    enc: Buffer.from('fake-encrypted-secret'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  });
  return id;
}

let jobSeq = 0;
function insertJob(overrides = {}) {
  jobSeq++;
  const jobId = `job-${jobSeq}`;
  const credId = insertCred();
  q().insertJob.run({
    id: jobId,
    name: `Test Job ${jobSeq}`,
    credsId: credId,
    sandboxName: 'test-sandbox',
    datasetIds: 'ALL',
    targetServicesJson: null,
    sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null,
    dailyLimit: 1_000_000,
    monthlyLimit: null,
    uploadPath: null,
    totalSourceIds: 0,
    ...overrides,
  });
  return jobId;
}

function seedIdentities(jobId, clusters) {
  // clusters: Array<{ sourceId: string, members: Array<{ ns_code, ns_id, identity_id }> }>
  const rows = [];
  for (const { sourceId, members } of clusters) {
    for (const m of members) {
      rows.push([jobId, m.ns_code ?? null, m.ns_id ?? null, m.identity_id, sourceId]);
    }
  }
  bulkInsertIdentities(rows);
  return rows.length;
}

function getWorkOrders(jobId) {
  return q().getAllOrdersForJob.all(jobId);
}

function totalIdsInOrder(wo) {
  const groups = JSON.parse(wo.namespaces_identities);
  return groups.reduce((sum, g) => sum + g.ids.length, 0);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

before(() => { initDb(); });

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('planWorkOrders: single small cluster → one work order, day 1', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
      { ns_code: 'hashedKocid', ns_id: 999, identity_id: 'src1' },
    ]},
    { sourceId: 'src2', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'b@x.com' },
    ]},
  ]);

  const { planned, days } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });

  assert.equal(planned, 1);
  assert.equal(days, 1);

  const orders = getWorkOrders(jobId);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].day_index, 1);
  assert.equal(orders[0].status, 'planned');
  assert.equal(totalIdsInOrder(orders[0]), 3);
});

test('planWorkOrders: payload includes both code and id in namespace object', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
    ]},
  ]);

  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });

  const [wo] = getWorkOrders(jobId);
  const groups = JSON.parse(wo.namespaces_identities);
  const emailGroup = groups.find(g => g.namespace.code === 'email');
  assert.ok(emailGroup, 'email group must exist');
  assert.equal(emailGroup.namespace.id, 6);
});

test('planWorkOrders: targetServices stored in work order JSON', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [{ ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' }]},
  ]);

  planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000,
    targetServices: ['identity', 'profile', 'ajo'],
  });

  const [wo] = getWorkOrders(jobId);
  const svc = JSON.parse(wo.target_services_json);
  assert.deepEqual(new Set(svc), new Set(['identity', 'profile', 'ajo']));
});

test('planWorkOrders: cluster stays together when it fits in one work order', () => {
  const jobId = insertJob();
  // Two clusters, each small enough to fit together in one 100k order
  seedIdentities(jobId, [
    { sourceId: 'src1', members: Array.from({ length: 40_000 }, (_, i) =>
      ({ ns_code: 'email', ns_id: 6, identity_id: `e1-${i}` })) },
    { sourceId: 'src2', members: Array.from({ length: 40_000 }, (_, i) =>
      ({ ns_code: 'email', ns_id: 6, identity_id: `e2-${i}` })) },
  ]);

  const { planned } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });

  // 80k total < 100k → should pack into 1 order
  assert.equal(planned, 1);
  const [wo] = getWorkOrders(jobId);
  assert.equal(totalIdsInOrder(wo), 80_000);
});

test('planWorkOrders: cluster that would overflow a work order triggers flush first', () => {
  const jobId = insertJob();
  // Cluster A: 70k, Cluster B: 50k → together 120k > 100k → two orders
  seedIdentities(jobId, [
    { sourceId: 'srcA', members: Array.from({ length: 70_000 }, (_, i) =>
      ({ ns_code: 'email', ns_id: 6, identity_id: `a-${i}` })) },
    { sourceId: 'srcB', members: Array.from({ length: 50_000 }, (_, i) =>
      ({ ns_code: 'phone', ns_id: 7, identity_id: `b-${i}` })) },
  ]);

  const { planned } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });

  assert.equal(planned, 2);
  const orders = getWorkOrders(jobId);
  assert.equal(totalIdsInOrder(orders[0]), 70_000);
  assert.equal(totalIdsInOrder(orders[1]), 50_000);
});

test('planWorkOrders: giant cluster (> 100k) is split across multiple orders', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'srcBig', members: Array.from({ length: 250_000 }, (_, i) =>
      ({ ns_code: 'email', ns_id: 6, identity_id: `big-${i}` })) },
  ]);

  const { planned } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });

  // 250k / 100k = 3 orders (100k + 100k + 50k)
  assert.equal(planned, 3);
  const orders = getWorkOrders(jobId);
  const sizes = orders.map(totalIdsInOrder);
  assert.equal(sizes[0], 100_000);
  assert.equal(sizes[1], 100_000);
  assert.equal(sizes[2], 50_000);
});

test('planWorkOrders: day_index advances when dailyLimit is exceeded', () => {
  // 3 clusters of 70k each:
  //   - Each cluster is too big to merge with its neighbour inside a single work
  //     order (70 + 70 = 140 > 100k per-order cap), so the planner produces 3 orders.
  //   - dailyLimit = 150k fits two orders (140k), so the 3rd order rolls into day 2.
  const jobId = insertJob({ dailyLimit: 150_000 });
  seedIdentities(jobId, [
    { sourceId: 'srcX', members: Array.from({ length: 70_000 }, (_, i) =>
      ({ ns_code: 'email', ns_id: 6, identity_id: `x-${i}` })) },
    { sourceId: 'srcY', members: Array.from({ length: 70_000 }, (_, i) =>
      ({ ns_code: 'phone', ns_id: 7, identity_id: `y-${i}` })) },
    { sourceId: 'srcZ', members: Array.from({ length: 70_000 }, (_, i) =>
      ({ ns_code: 'ECID', ns_id: 4, identity_id: `z-${i}` })) },
  ]);

  const { planned, days } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 150_000, targetServices: null,
  });

  assert.equal(planned, 3);
  assert.equal(days, 2);
  const orders = getWorkOrders(jobId);
  assert.equal(orders[0].day_index, 1);
  assert.equal(orders[1].day_index, 1);
  assert.equal(orders[2].day_index, 2);
});

test('planWorkOrders: refuses to re-plan once any order has been submitted', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
    ]},
  ]);

  // First plan succeeds.
  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });
  const [firstWo] = getWorkOrders(jobId);
  assert.equal(firstWo.status, 'planned');

  // Simulate that this work order shipped to Adobe.
  q().updateWorkOrderSubmitted.run({
    id: firstWo.id,
    adobeWorkorderId: 'DI-real-adobe-id',
    adobeStatus: 'received',
    bundleId: null,
    submittedAt: '2026-04-26T00:00:00Z',
  });

  // Now re-planning must throw — re-emitting work orders for identities
  // already shipped would cause duplicate irreversible deletes.
  assert.throws(
    () => planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null }),
    err => {
      assert.equal(err.name, 'ReplanForbiddenError');
      assert.equal(err.status, 409);
      assert.match(err.message, /Cannot re-plan/);
      return true;
    },
  );

  // The submitted order MUST still exist after the failed re-plan.
  const after = getWorkOrders(jobId);
  assert.equal(after.length, 1);
  assert.equal(after[0].adobe_workorder_id, 'DI-real-adobe-id');
});

test('planWorkOrders: re-planning is allowed when only deferred orders exist', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
    ]},
  ]);

  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });
  const [wo] = getWorkOrders(jobId);
  q().updateWorkOrderStatus.run('deferred', 'quota exhausted', wo.id);

  // Deferred orders never went to Adobe — re-planning is safe.
  assert.doesNotThrow(() =>
    planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null }),
  );
});

test('planWorkOrders: re-planning REPLACES deferred orders (no duplicate deletes)', () => {
  // Blocker #1: a deferred WO that survives a re-plan plus the freshly
  // re-emitted planned WO BOTH cover the same identity. On the next submit
  // both ship → duplicate irreversible delete. deletePlannedOrders must
  // clear 'deferred' rows too, so re-planning is a true replace.
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
    ]},
  ]);

  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });
  const [wo] = getWorkOrders(jobId);
  q().updateWorkOrderStatus.run('deferred', 'quota exhausted', wo.id);

  // Re-plan with the SAME expanded identities still in the table.
  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });

  const orders = getWorkOrders(jobId);
  assert.equal(orders.length, 1,
    're-plan must replace the deferred order, not leave it alongside a new planned one');
  // And the single identity appears exactly once across all orders.
  const totalIds = orders.reduce((n, o) => n + totalIdsInOrder(o), 0);
  assert.equal(totalIds, 1, 'identity must appear exactly once after re-plan');
});

test('planWorkOrders: re-planning clears old planned orders (M2 fix)', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
    ]},
  ]);

  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });
  const firstRun = getWorkOrders(jobId);
  assert.equal(firstRun.length, 1);

  // Plan again — should NOT double the orders
  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });
  const secondRun = getWorkOrders(jobId);

  assert.equal(secondRun.length, 1, 'Re-planning must replace, not append, work orders');
});

test('planWorkOrders: empty expanded_identities produces zero orders', () => {
  const jobId = insertJob();
  // no identities seeded

  const { planned, days, months } = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });

  assert.equal(planned, 0);
  // Phase 2: zero unshipped work orders now correctly produces zero days
  // and zero months. The pre-Phase-2 planner returned `days: 1` even with
  // no work — a quirk of always starting the day counter at 1.
  assert.equal(days, 0);
  assert.equal(months, 0);
  assert.equal(getWorkOrders(jobId).length, 0);
});

test('planWorkOrders: identifier_count column matches actual ids in payload', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
      { ns_code: 'phone', ns_id: 7, identity_id: '+15551234' },
      { ns_code: 'hashedKocid', ns_id: 999, identity_id: 'src1' },
    ]},
  ]);

  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });

  const [wo] = getWorkOrders(jobId);
  assert.equal(wo.identifier_count, totalIdsInOrder(wo));
  assert.equal(wo.identifier_count, 3);
});

// Regression: prior to the 2026-05-29 fix, both the planner and the
// /export route used q().streamIdentitiesBySource — a single cached
// prepared Statement. better-sqlite3 only allows one active iterator
// per Statement, so two overlapping exports (or planner-during-export)
// threw "This statement is busy executing a query" (see jobs.js:217
// error logs from the 1.6M-row run). The fix exposes a factory that
// returns a fresh Statement per caller. This test locks that in.
test('prepareStreamIdentitiesBySource: concurrent iterators do not collide', () => {
  const jobId = insertJob();
  seedIdentities(jobId, [
    { sourceId: 'src1', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'a@x.com' },
      { ns_code: 'phone', ns_id: 7, identity_id: '+15551234' },
    ]},
    { sourceId: 'src2', members: [
      { ns_code: 'email', ns_id: 6, identity_id: 'b@x.com' },
    ]},
  ]);

  // Two FRESH Statements iterated in interleaved fashion. If they shared
  // any internal state (which is exactly the bug we are guarding against),
  // the second .iterate() or the first .next() after the second iterator
  // opened would throw "This statement is busy executing a query".
  const it1 = prepareStreamIdentitiesBySource().iterate(jobId);
  const it2 = prepareStreamIdentitiesBySource().iterate(jobId);

  const rows1 = [];
  const rows2 = [];
  let r1 = it1.next();
  let r2 = it2.next();
  while (!r1.done || !r2.done) {
    if (!r1.done) { rows1.push(r1.value); r1 = it1.next(); }
    if (!r2.done) { rows2.push(r2.value); r2 = it2.next(); }
  }

  assert.equal(rows1.length, 3);
  assert.equal(rows2.length, 3);
  assert.deepEqual(
    rows1.map(r => r.identity_id).sort(),
    rows2.map(r => r.identity_id).sort()
  );
});
