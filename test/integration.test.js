/**
 * End-to-end integration test. Exercises:
 *   CSV upload → expansion (Identity Graph mocked) → plan → submit (hygiene
 *   mocked) → DB state verification.
 *
 * Every Adobe endpoint is intercepted via nock so no real network traffic
 * is generated. A temp SQLite file keeps state isolated.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-integ-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-upload-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
// Disable the low retry backoff so tests run fast even if a mock is wrong.
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');
const { planWorkOrders, runSubmission } = await import('../src/runner/submission.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';
const REGION  = 'https://platform-va7.adobe.io';

before(() => { initDb(); });

afterEach(() => { nock.cleanAll(); clearQuotaCache(); });

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function setupJob() {
  seq++;
  const credsId = storeCreds({
    label: `Integ ${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `integ-org-${seq}@AcmeOrg`, clientId: `integ-client-${seq}`,
    clientSecret: 'secret',
  });

  const csv = path.join(uploadDir, `source-${seq}.csv`);
  fs.writeFileSync(csv, 'src-a\nsrc-b\nsrc-c\n');

  const jobId = `integ-job-${seq}`;
  q().insertJob.run({
    id: jobId, name: `Integration ${seq}`,
    credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000,
    uploadPath: csv, totalSourceIds: 3,
  });
  return { credsId, jobId, csv };
}

function mockIms() {
  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'test-tok', expires_in: 86400 });
}

function mockNamespacesEndpoint() {
  // region-scoped per config.aep.identityRegion=va7
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 4, code: 'ECID', name: 'Experience Cloud ID', custom: false, status: 'ACTIVE' },
    { id: 6, code: 'email', name: 'Email', custom: false, status: 'ACTIVE' },
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
}

// Phase 2: runSubmission now refreshes Adobe /quota before each run. Mock
// it with a generous default so submission flows that don't care about
// quota specifics aren't blocked by the live-fetch requirement.
function mockOrgQuota({ dailyRemaining = 1_000_000, monthlyRemaining = 3_000_000 } = {}) {
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, {
    quotas: [
      { name: 'dailyConsumerDeleteIdentitiesQuota',   consumed: 1_000_000 - dailyRemaining,   quota: 1_000_000 },
      { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 3_000_000 - monthlyRemaining, quota: 3_000_000 },
    ],
  });
}

// quotaApi caches results in-memory per imsOrgId. After each test we
// clear the cache so the next test's mock is consulted fresh.
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');

function mockClustersResponse() {
  // Observed AEP v1.1.0 shape: {version, clusters:[{compositeXid, members:[]}]}
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, {
    version: '1.1.0',
    clusters: [
      {
        compositeXid: { nsid: 11124296, id: 'src-a' },
        members: [
          { nsid: 11124296, id: 'src-a' },
          { nsid: 6, id: 'alice@example.com' },
          { nsid: 4, id: 'ecid-a-1' },
        ],
      },
      {
        compositeXid: { nsid: 11124296, id: 'src-b' },
        members: [
          { nsid: 11124296, id: 'src-b' },
          { nsid: 6, id: 'bob@example.com' },
        ],
      },
      {
        compositeXid: { nsid: 11124296, id: 'src-c' },
        members: [
          { nsid: 4, id: 'ecid-c-1' },
          { nsid: 4, id: 'ecid-c-2' },
        ],
      },
    ],
  });
}

function mockWorkOrderPost() {
  nock(GATEWAY).post('/data/core/hygiene/workorder').reply(200, {
    workorderId: 'DI-integ-test-001',
    status: 'received',
    bundleId: 'BN-integ-001',
    operationCount: 8,
    createdAt: '2026-04-23T10:00:00Z',
    targetServices: ['profile','datalake','identity','ajo'],
    datasetId: 'ALL',
    displayName: 'integ-test',
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('integration: expansion parses new-shape response and writes linked identities', async () => {
  const { credsId, jobId } = setupJob();

  mockIms();
  mockNamespacesEndpoint();
  mockClustersResponse();

  await runExpansion({
    jobId,
    uploadPath: q().getJob.get(jobId).upload_path,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    credsId, sandboxName: 'prod', column: 0,
  });

  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'expanded');
  assert.equal(job.processed_count, 3);

  const byNs = q().countIdentitiesByNamespace.all(jobId);
  const counts = Object.fromEntries(byNs.map(r => [r.namespace, r.count]));
  // hashedKocid: src-a, src-b, src-c = 3 (members + source rows dedup via unique idx)
  // email: alice, bob = 2
  // ECID: ecid-a-1, ecid-c-1, ecid-c-2 = 3
  assert.equal(counts.hashedKocid, 3);
  assert.equal(counts.email, 2);
  assert.equal(counts.ECID, 3);
});

test('integration: plan → submit wires correct payload to Adobe', async () => {
  const { credsId, jobId } = setupJob();

  mockIms();
  mockNamespacesEndpoint();
  mockClustersResponse();
  mockOrgQuota();

  await runExpansion({
    jobId,
    uploadPath: q().getJob.get(jobId).upload_path,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    credsId, sandboxName: 'prod', column: 0,
  });

  const plan = planWorkOrders({
    jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null,
  });
  assert.equal(plan.planned, 1);

  // Capture the POST body so we can assert on its shape.
  let capturedBody;
  nock(GATEWAY).post('/data/core/hygiene/workorder', body => {
    capturedBody = body;
    return true;
  }).reply(200, {
    workorderId: 'DI-integ-test-001',
    status: 'received',
    bundleId: 'BN-integ-001',
    operationCount: 8,
    createdAt: '2026-04-23T10:00:00Z',
  });

  const res = await runSubmission({ jobId });
  assert.equal(res.submitted, 1);
  assert.equal(res.failed, 0);

  // Verify the payload Adobe received.
  assert.equal(capturedBody.action, 'delete_identity');
  assert.equal(capturedBody.datasetId, 'ALL');
  assert.ok(Array.isArray(capturedBody.namespacesIdentities));
  // Every group should have both code and id for canonicalized namespaces
  for (const g of capturedBody.namespacesIdentities) {
    assert.ok(g.namespace.code || g.namespace.id != null,
      `group missing namespace identification: ${JSON.stringify(g)}`);
    assert.ok(g.ids.length > 0, 'group with no ids should never be emitted');
  }

  // Work order in DB should reflect the Adobe response
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted');
  assert.equal(wo.adobe_workorder_id, 'DI-integ-test-001');
});

test('integration: resume after crash skips already-expanded source IDs', async () => {
  const { credsId, jobId } = setupJob();

  // Simulate a prior crash that left one source already processed.
  bulkInsertIdentities([
    [jobId, 'hashedKocid', 11124296, 'src-a', 'src-a'],
    [jobId, 'email', 6, 'alice@example.com', 'src-a'],
  ]);
  q().updateJobStatus.run('expanding', null, jobId);

  // When we resume, Adobe should only be asked about src-b and src-c
  // (NOT src-a, since it's already in expanded_identities).
  let clustersCallBody;
  mockIms();
  mockNamespacesEndpoint();
  nock(REGION).post('/data/core/identity/clusters/members', body => {
    clustersCallBody = body;
    return true;
  }).reply(200, {
    version: '1.1.0',
    clusters: [
      { compositeXid: { nsid: 11124296, id: 'src-b' }, members: [
        { nsid: 6, id: 'bob@example.com' }, { nsid: 11124296, id: 'src-b' },
      ]},
      { compositeXid: { nsid: 11124296, id: 'src-c' }, members: [
        { nsid: 4, id: 'ecid-c-1' },
      ]},
    ],
  });

  const processedRows = q().processedSourceIdsForJob.all(jobId);
  const skipSourceIds = new Set(processedRows.map(r => r.source_id));
  assert.ok(skipSourceIds.has('src-a'));

  await runExpansion({
    jobId,
    uploadPath: q().getJob.get(jobId).upload_path,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    credsId, sandboxName: 'prod', column: 0,
    skipSourceIds,
  });

  // Verify Adobe was only asked about src-b and src-c
  assert.equal(clustersCallBody.compositeXids.length, 2);
  const askedIds = clustersCallBody.compositeXids.map(x => x.id).sort();
  assert.deepEqual(askedIds, ['src-b', 'src-c']);

  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'expanded');
});
