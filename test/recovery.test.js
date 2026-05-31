/**
 * Tests for runner/recovery.js — startup reconciliation of jobs / work orders
 * left mid-flight by a previous crash.
 *
 * These are "DB-level" integration tests: we seed SQLite rows to simulate the
 * crash state, then call the recovery functions and assert on post-state.
 * Adobe API calls are mocked via nock where the reconciliation code reaches
 * out.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-recovery-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { reconcileOrphanWorkOrders, resumeExpandingJobs } = await import('../src/runner/recovery.js');
const { reserve, peek } = await import('../src/services/quotaManager.js');

const GATEWAY = 'https://platform.adobe.io';

before(() => { initDb(); });

afterEach(() => { nock.cleanAll(); });

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function seedCredAndJob({ status = 'submitting', name = 'test-job' } = {}) {
  seq++;
  const credsId = storeCreds({
    label: `Test ${seq}`,
    environment: 'prod',
    region: 'VA7',
    imsOrgId: `org-${seq}@AcmeOrg`,
    clientId: `client-${seq}`,
    clientSecret: 'secret-value',
  });
  const jobId = `job-${seq}`;
  q().insertJob.run({
    id: jobId, name, credsId,
    sandboxName: 'test-sandbox', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run(status, null, jobId);
  return { credsId, jobId };
}

function seedOrphanWorkOrder(jobId, localId) {
  q().insertWorkOrder.run({
    id: localId, jobId, dayIndex: 1,
    datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([
      { namespace: { code: 'email', id: 6 }, ids: ['a@x.com','b@x.com'] },
    ]),
    identifierCount: 2,
    status: 'submitting',   // stuck mid-submit
  });
}

function mockIms() {
  nock('https://ims-na1.adobelogin.com')
    .post('/ims/token/v3')
    .reply(200, { access_token: 'tok-abc', expires_in: 86400 });
}

// ─── reconcileOrphanWorkOrders ────────────────────────────────────────────────

test('reconcile: Adobe has no matching displayName → roll back to planned', async () => {
  const { jobId } = seedCredAndJob({ name: 'match-miss' });
  const localId = `wo-miss-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { workorders: [] });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'planned');
  assert.match(wo.last_error || '', /rolled back/);
});

test('reconcile: Adobe finds matching work order → record Adobe ID', async () => {
  const { jobId } = seedCredAndJob({ name: 'match-hit' });
  const localId = `wo-hit-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  // Display name now uses the full local UUID (F-009 fix).
  const displayName = `Delete match-hit - WO ${localId}`;

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, {
      workorders: [{
        workorderId: 'DI-recovered-abc-123',
        displayName,
        status: 'received',
        bundleId: 'BN-xyz',
        createdAt: '2026-04-23T10:00:00Z',
      }],
    });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted');
  assert.equal(wo.adobe_workorder_id, 'DI-recovered-abc-123');
});

test('reconcile: Adobe\'s documented {results:[...]} shape is matched (not rolled back)', async () => {
  // Adobe's live Data Hygiene list endpoint returns the matches under a
  // top-level `results` array (plus `total`/`count`/`_links`), NOT
  // `workorders`/`items`. The pre-fix code only looked for the latter two,
  // so a genuinely-processed work order was reported ABSENT and rolled
  // back → next submit duplicated the irreversible delete.
  const { jobId } = seedCredAndJob({ name: 'results-shape' });
  const localId = `wo-results-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  const displayName = `Delete results-shape - WO ${localId}`;

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, {
      results: [{
        workorderId: 'DI-results-shape-1',
        displayName,
        status: 'received',
        bundleId: 'BN-results',
        createdAt: '2026-05-31T10:00:00Z',
      }],
      total: 1,
      count: 1,
      _links: {},
    });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted', 'WO present in Adobe under `results` must be recorded, never rolled back');
  assert.equal(wo.adobe_workorder_id, 'DI-results-shape-1');
});

test('reconcile: unrecognized 200 response shape is indeterminate (fail closed, no rollback)', async () => {
  // If Adobe returns a 200 whose shape we DON'T recognize (future API change,
  // a renamed container, an error envelope with HTTP 200), we must NOT
  // conclude the order is absent — that would roll back + release quota and
  // risk a duplicate on the next submit. Unknown shape → leave it submitting.
  const { jobId } = seedCredAndJob({ name: 'unknown-shape' });
  const localId = `wo-unknown-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { somethingElse: 'we do not understand this', data: { nested: true } });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting',
    'unrecognized 200 shape must stay submitting (fail closed) so we never risk a duplicate');
  assert.equal(wo.adobe_workorder_id, null);

  // Cleanup so it doesn't pollute later whole-DB orphan counts.
  q().updateWorkOrderStatus.run('failed', 'test cleanup', wo.id);
});

test('reconcile: Adobe 400 on lookup leaves orphan in submitting (no roll-back, no quota release)', async () => {
  // Regression: the lookup returning null on 400 used to roll the orphan
  // back to planned, which on next submit could create a duplicate Adobe
  // work order if the original POST had actually been processed. The fix
  // returns LOOKUP_INDETERMINATE on 400, leaving the row alone.
  const { jobId } = seedCredAndJob({ name: 'four-hundred' });
  const localId = `wo-400-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(400, { message: 'displayName filter not supported in this API version' });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  // MUST still be submitting — not rolled back to planned.
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting',
    'orphan must stay submitting on lookup-indeterminate so we don\'t risk duplicates');
  assert.equal(wo.adobe_workorder_id, null);

  // Cleanup: remove this orphan so it doesn't pollute later tests that
  // count rows from listSubmittingOrphanOrders across the whole DB.
  q().updateWorkOrderStatus.run('failed', 'test cleanup', wo.id);
});

test('reconcile: transient error leaves orphan alone for next startup', async () => {
  const { jobId } = seedCredAndJob({ name: 'transient' });
  const localId = `wo-trans-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .times(6)   // axios-retry will retry up to 5 times on 5xx
    .reply(503, 'Service Unavailable');

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  // Orphan should still be in submitting state so a later restart can retry.
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting');
  assert.equal(wo.adobe_workorder_id, null);
});

test('reconcile: rollback releases the WO reservation on BOTH dimensions (review R4 #1)', async () => {
  // The per-WO reservation records both the daily and monthly period; an
  // orphan rollback (Adobe didn't process it) deactivates it by WO id, freeing
  // both dimensions exactly — no monthly leak, no cross-period mis-decrement.
  const { jobId } = seedCredAndJob({ name: 'monthly-leak' });
  const imsOrgId = `org-${seq}@AcmeOrg`;
  const localId = `wo-mleak-${seq}`;
  seedOrphanWorkOrder(jobId, localId);          // identifier_count = 2
  const COUNT = 2;

  // Submission reserved this WO against both dimensions.
  const r = reserve({ workOrderId: localId, imsOrgId, count: COUNT, dailyLimit: 1_000_000, monthlyLimit: 3_000_000 });
  assert.equal(r.granted, true);
  assert.equal(peek(imsOrgId, 1_000_000, 3_000_000).daily.used, COUNT);
  assert.equal(peek(imsOrgId, 1_000_000, 3_000_000).monthly.used, COUNT);

  mockIms();
  // persist: this run reconciles EVERY orphan in the DB (including any left
  // 'submitting' by earlier tests); all must get the empty-results response.
  nock(GATEWAY).persist()
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { results: [], total: 0, count: 0 });

  await reconcileOrphanWorkOrders();

  const after = peek(imsOrgId, 1_000_000, 3_000_000);
  assert.equal(after.daily.used, 0, 'daily reservation released');
  assert.equal(after.monthly.used, 0, 'monthly reservation released too (no leak)');
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'planned');
});

// ─── resumeExpandingJobs ──────────────────────────────────────────────────────

test('resume: job with no upload file is marked failed', async () => {
  const { jobId } = seedCredAndJob({ status: 'expanding', name: 'no-file' });
  // upload_path was null in seedCredAndJob → fs.existsSync returns false.

  const count = await resumeExpandingJobs();
  assert.equal(count, 1);

  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /upload file/i);
});

test('resume: empty expanding list is a no-op', async () => {
  const count = await resumeExpandingJobs();
  assert.equal(count, 0);
});
