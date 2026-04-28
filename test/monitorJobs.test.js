/**
 * Tests for db.listMonitorJobs — the active-submissions feed used by the
 * Monitor tab. Covers:
 *   - filtering: only jobs with at least one Adobe-acked work order are returned
 *   - aggregate counts (submitted / in_flight / completed / failed) per job
 *   - sort order: latest work-order activity DESC (NOT job creation time)
 *   - search: case-insensitive substring match on job name
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-monitor-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db } = await import('../src/db.js');

before(() => initDb());

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function seedCred() {
  seq++;
  const id = `cred-mon-${seq}`;
  q().insertCred.run({
    id, label: `Test ${seq}`, clientName: null,
    environment: 'prod', region: 'va7',
    imsOrgId: `org-mon-${seq}@AcmeOrg`, clientId: `client-mon-${seq}`,
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });
  return id;
}

function seedJob(name, sandboxName = 'sbx') {
  seq++;
  const jobId = `job-mon-${seq}`;
  q().insertJob.run({
    id: jobId, name, credsId: seedCred(),
    sandboxName, datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: null, totalSourceIds: 0,
  });
  return jobId;
}

function seedWorkOrder(jobId, opts = {}) {
  const {
    status = 'planned',
    adobeWorkorderId = null,
    adobeStatus = null,
    identifierCount = 100,
    dayIndex = 1,
    updatedAt = null,
  } = opts;
  seq++;
  const id = `wo-mon-${seq}`;
  q().insertWorkOrder.run({
    id, jobId, dayIndex,
    datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: '[]',
    identifierCount, status,
  });
  if (adobeWorkorderId) {
    db.prepare(`UPDATE work_orders
                   SET adobe_workorder_id = ?, adobe_status = ?, status = ?
                 WHERE id = ?`)
      .run(adobeWorkorderId, adobeStatus, status, id);
  }
  if (updatedAt) {
    db.prepare(`UPDATE work_orders SET updated_at = ? WHERE id = ?`).run(updatedAt, id);
  }
  return id;
}

function ids(rows) { return rows.map(r => r.id); }

// ─── Tests ────────────────────────────────────────────────────────────────────

test('listMonitorJobs: excludes jobs that have no Adobe-acked work orders', () => {
  // Job A: only planned/expanded, never submitted
  const jobA = seedJob('expansion-only');
  seedWorkOrder(jobA, { status: 'planned' });

  // Job B: has one submitted work order with an Adobe ID
  const jobB = seedJob('with-adobe-id');
  seedWorkOrder(jobB, {
    status: 'submitted',
    adobeWorkorderId: 'DI-real-id-1',
    adobeStatus: 'received',
    updatedAt: '2026-04-28 12:00:00',
  });

  const rows = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  const found = ids(rows);
  assert.ok(!found.includes(jobA), 'expansion-only job must be excluded');
  assert.ok(found.includes(jobB),  'submitted job must be included');
});

test('listMonitorJobs: within in-flight bucket, sorts by latest activity DESC', () => {
  // Two in-flight jobs (received status). The one with newer activity must
  // come first; this exercises the secondary sort key.
  const jobOlder = seedJob('older-in-flight');
  seedWorkOrder(jobOlder, {
    adobeWorkorderId: 'DI-old-active',
    adobeStatus: 'received',
    updatedAt: '2026-01-01 00:00:00',
  });

  const jobNewer = seedJob('newer-in-flight');
  seedWorkOrder(jobNewer, {
    adobeWorkorderId: 'DI-new-active',
    adobeStatus: 'received',
    updatedAt: '2026-04-28 23:59:59',
  });

  const rows = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  const ours = rows.filter(r => [jobOlder, jobNewer].includes(r.id));
  assert.equal(ours.length, 2);
  assert.equal(ours[0].id, jobNewer, 'most-recently active job comes first within the in-flight bucket');
  assert.equal(ours[1].id, jobOlder);
});

test('listMonitorJobs: in-flight jobs sort BEFORE terminal jobs even when terminals are more recent', () => {
  // The "in-flight first" priority is the whole point of Option 1 in the
  // 2026-04-28 redesign: a freshly-completed job must NOT push a still-
  // pending one off-screen. Here jobTerminal has the newer updated_at but
  // is fully completed; jobInFlight has older activity but is still in
  // flight. jobInFlight must come first.
  const jobTerminal = seedJob('completed-recently');
  seedWorkOrder(jobTerminal, {
    adobeWorkorderId: 'DI-terminal-recent',
    adobeStatus: 'completed',
    updatedAt: '2026-04-28 23:59:59',
  });

  const jobInFlight = seedJob('in-flight-old');
  seedWorkOrder(jobInFlight, {
    adobeWorkorderId: 'DI-inflight-old',
    adobeStatus: 'received',
    updatedAt: '2026-01-01 00:00:00',
  });

  const rows = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  const ours = rows.filter(r => [jobTerminal, jobInFlight].includes(r.id));
  assert.equal(ours.length, 2);
  assert.equal(ours[0].id, jobInFlight,
    'in-flight job must come first even though the completed one had more recent activity');
  assert.equal(ours[1].id, jobTerminal);
});

test('listMonitorJobs: aggregate counts (submitted, in_flight, completed, failed)', () => {
  const job = seedJob('aggregate-test');
  // 4 work orders with Adobe IDs: 1 received, 1 submitted, 1 completed, 1 failed
  seedWorkOrder(job, { adobeWorkorderId: 'DI-1', adobeStatus: 'received' });
  seedWorkOrder(job, { adobeWorkorderId: 'DI-2', adobeStatus: 'submitted' });
  seedWorkOrder(job, { adobeWorkorderId: 'DI-3', adobeStatus: 'completed' });
  seedWorkOrder(job, { adobeWorkorderId: 'DI-4', adobeStatus: 'failed' });
  // 1 work order without an Adobe ID — must be ignored entirely.
  seedWorkOrder(job, { status: 'planned' });

  const rows = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  const row = rows.find(r => r.id === job);
  assert.ok(row, 'aggregate-test job should be in the result');
  assert.equal(row.submitted_count,    4, '4 work orders have Adobe IDs');
  assert.equal(row.in_flight_count,    2, 'received + submitted are in flight');
  assert.equal(row.completed_count,    1);
  assert.equal(row.adobe_failed_count, 1);
});

test('listMonitorJobs: search filter is case-insensitive substring on job name', () => {
  const jobA = seedJob('Coca-Cola Monthly Wipe');
  seedWorkOrder(jobA, { adobeWorkorderId: 'DI-coke', adobeStatus: 'received' });

  const jobB = seedJob('PepsiCo Quarterly');
  seedWorkOrder(jobB, { adobeWorkorderId: 'DI-pepsi', adobeStatus: 'received' });

  const cocaResults = q().listMonitorJobs.all({ limit: 50, search: 'cocA', sandbox: '' });
  assert.ok(cocaResults.some(r => r.id === jobA));
  assert.ok(!cocaResults.some(r => r.id === jobB));

  const allResults = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  assert.ok(allResults.some(r => r.id === jobA));
  assert.ok(allResults.some(r => r.id === jobB));
});

test('listMonitorJobs: respects the limit parameter', () => {
  // Seed 3 fresh jobs with submitted work orders
  for (let i = 0; i < 3; i++) {
    const j = seedJob(`limit-test-${i}`);
    seedWorkOrder(j, { adobeWorkorderId: `DI-limit-${i}`, adobeStatus: 'received' });
  }
  const rows = q().listMonitorJobs.all({ limit: 2, search: '', sandbox: '' });
  assert.equal(rows.length, 2);
});

test('listMonitorJobs: sandbox filter scopes results to the matching sandbox', () => {
  const americas = seedJob('Americas Wipe', 'americas-uat');
  seedWorkOrder(americas, { adobeWorkorderId: 'DI-am', adobeStatus: 'received' });

  const europe = seedJob('Europe Wipe', 'eu-prod');
  seedWorkOrder(europe, { adobeWorkorderId: 'DI-eu', adobeStatus: 'received' });

  const americasOnly = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: 'americas-uat' });
  const ids_am = ids(americasOnly);
  assert.ok(ids_am.includes(americas));
  assert.ok(!ids_am.includes(europe), 'eu-prod job must not appear when sandbox=americas-uat');

  const europeOnly = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: 'eu-prod' });
  const ids_eu = ids(europeOnly);
  assert.ok(!ids_eu.includes(americas));
  assert.ok(ids_eu.includes(europe));

  const all = q().listMonitorJobs.all({ limit: 50, search: '', sandbox: '' });
  const ids_all = ids(all);
  assert.ok(ids_all.includes(americas), 'sandbox="" must return all sandboxes');
  assert.ok(ids_all.includes(europe));
});

// ─── monitorTotals ────────────────────────────────────────────────────────────

test('monitorTotals: each job lands in exactly one bucket (in_flight | has_failed | all_completed)', () => {
  // Seed three jobs with deterministic shapes against a unique sandbox so
  // we can isolate them from any state seeded by earlier tests.
  const SBX = 'totals-test-sandbox';

  // Job 1: at least one in-flight WO → in_flight bucket (regardless of others)
  const j1 = seedJob('totals-1', SBX);
  seedWorkOrder(j1, { adobeWorkorderId: 'T1-a', adobeStatus: 'received' });
  seedWorkOrder(j1, { adobeWorkorderId: 'T1-b', adobeStatus: 'completed' });

  // Job 2: no in-flight, but at least one failed → has_failed bucket
  const j2 = seedJob('totals-2', SBX);
  seedWorkOrder(j2, { adobeWorkorderId: 'T2-a', adobeStatus: 'completed' });
  seedWorkOrder(j2, { adobeWorkorderId: 'T2-b', adobeStatus: 'failed' });

  // Job 3: only completed → all_completed bucket
  const j3 = seedJob('totals-3', SBX);
  seedWorkOrder(j3, { adobeWorkorderId: 'T3-a', adobeStatus: 'completed' });

  const t = q().monitorTotals.get({ search: '', sandbox: SBX });
  assert.equal(t.in_flight,     1, 'one in-flight job');
  assert.equal(t.has_failed,    1, 'one job with failed (no in-flight)');
  assert.equal(t.all_completed, 1, 'one fully-completed job');
  assert.equal(t.total,         3);
});

test('monitorTotals: search and sandbox filters apply', () => {
  const SBX = 'filter-totals-sandbox';
  const a = seedJob('Alpha Filter', SBX);
  seedWorkOrder(a, { adobeWorkorderId: 'F-a', adobeStatus: 'received' });
  const b = seedJob('Beta Filter', SBX);
  seedWorkOrder(b, { adobeWorkorderId: 'F-b', adobeStatus: 'received' });

  const totalsAll = q().monitorTotals.get({ search: '', sandbox: SBX });
  assert.equal(totalsAll.total, 2);

  const totalsAlpha = q().monitorTotals.get({ search: 'alpha', sandbox: SBX });
  assert.equal(totalsAlpha.total, 1, 'search restricts the universe of jobs counted');
});

// ─── monitorSandboxes ─────────────────────────────────────────────────────────

test('monitorSandboxes: returns distinct sandboxes among submitted jobs with per-sandbox counts', () => {
  const SBX_X = 'distinct-sbx-x';
  const SBX_Y = 'distinct-sbx-y';

  const x1 = seedJob('X One', SBX_X);
  seedWorkOrder(x1, { adobeWorkorderId: 'X1', adobeStatus: 'received' });
  const x2 = seedJob('X Two', SBX_X);
  seedWorkOrder(x2, { adobeWorkorderId: 'X2', adobeStatus: 'completed' });
  const y1 = seedJob('Y One', SBX_Y);
  seedWorkOrder(y1, { adobeWorkorderId: 'Y1', adobeStatus: 'received' });
  // Decoy: job in the same sandbox but never submitted — must not contribute.
  const y_decoy = seedJob('Y Decoy', SBX_Y);
  seedWorkOrder(y_decoy, { status: 'planned' });

  const list = q().monitorSandboxes.all({ search: '' });
  const xRow = list.find(r => r.name === SBX_X);
  const yRow = list.find(r => r.name === SBX_Y);
  assert.ok(xRow, `${SBX_X} should appear`);
  assert.ok(yRow, `${SBX_Y} should appear`);
  assert.equal(xRow.count, 2);
  assert.equal(yRow.count, 1, 'decoy job (no Adobe ID) must not be counted');
});

test('monitorSandboxes: respects the search filter (so chip counts reflect the active search)', () => {
  const SBX = 'search-sandbox-list';
  const a = seedJob('Searchable A', SBX);
  seedWorkOrder(a, { adobeWorkorderId: 'S-a', adobeStatus: 'received' });
  const b = seedJob('Different Name', SBX);
  seedWorkOrder(b, { adobeWorkorderId: 'S-b', adobeStatus: 'received' });

  const filtered = q().monitorSandboxes.all({ search: 'Searchable' });
  const row = filtered.find(r => r.name === SBX);
  assert.ok(row);
  assert.equal(row.count, 1, 'sandbox count must reflect the active name search');
});
