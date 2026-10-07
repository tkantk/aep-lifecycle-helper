/**
 * Expansion-off mode (2026-10-06): a job can delete ONLY the uploaded IDs.
 * The Identity Graph is never called; the namespace is still validated against
 * the registry (fail closed); the all-empty-graph refusal — which exists to catch
 * a wrong-region CLUSTER job — does not apply to an intentional IDs-only job.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-exp-off-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-exp-off-up-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');
const uploadRouter = (await import('../src/routes/upload.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';

let server, baseUrl;
before(async () => {
  initDb();
  const app = express();
  app.use('/api/upload', uploadRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => nock.cleanAll());
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

let seq = 0;
function makeJob(mode, ids = ['k1', 'k2', 'k3']) {
  seq++;
  const credsId = storeCreds({ label: `Off ${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `off-org-${seq}@AcmeOrg`, clientId: `off-client-${seq}`, clientSecret: 'secret' });
  const csv = path.join(uploadDir, `off-${seq}.csv`);
  fs.writeFileSync(csv, ids.join('\n') + '\n');
  const jobId = `off-job-${seq}`;
  q().insertJob.run({ id: jobId, name: `Off ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: csv, totalSourceIds: ids.length });
  q().setJobExpansionMode.run(mode, jobId);
  return { jobId, credsId, csv };
}
function mockRegistry() {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 6, code: 'email', name: 'Email', custom: false, status: 'ACTIVE' },
    { id: 5000, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
}

test('new jobs default to expansion_mode "cluster" (today\'s behaviour)', () => {
  const { jobId } = makeJob('cluster');
  q().insertJob.run({ id: 'default-mode', name: 'd', credsId: q().getJob.get(jobId).creds_id, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1, monthlyLimit: 1, uploadPath: null, totalSourceIds: 0 });
  assert.equal(q().getJob.get('default-mode').expansion_mode, 'cluster');
});

test('expansion OFF stores exactly the uploaded IDs and never calls the Identity Graph', async () => {
  const { jobId, credsId, csv } = makeJob('none', ['k1', 'k2', 'k3', 'k2']);   // duplicate in the CSV
  mockRegistry();
  let graphCalls = 0;
  nock(REGION).persist().post('/data/core/identity/clusters/members').reply(() => { graphCalls++; return [500, {}]; });
  await runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    credsId, sandboxName: 'prod', column: 0 });
  assert.equal(graphCalls, 0, 'no Identity Graph call in expansion-off mode');
  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'expanded', 'the all-empty-graph refusal does not apply to an intentional IDs-only job');
  assert.equal(job.source_namespace_id, 5000, 'the registry-resolved nsid is persisted on the job');
  const rows = db.prepare('SELECT DISTINCT ns_code, ns_id, identity_id, source_id FROM expanded_identities WHERE job_id = ? ORDER BY identity_id').all(jobId);
  assert.deepEqual(rows.map(r => [r.ns_code, r.ns_id, r.identity_id, r.source_id]),
    [['hashedKocid', 5000, 'k1', 'k1'], ['hashedKocid', 5000, 'k2', 'k2'], ['hashedKocid', 5000, 'k3', 'k3']]);
});

test('expansion OFF still fails closed when the namespace is not in the registry', async () => {
  const { jobId, credsId, csv } = makeJob('none');
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [{ id: 6, code: 'email', name: 'Email', custom: false, status: 'ACTIVE' }]);
  await assert.rejects(() => runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null, credsId, sandboxName: 'prod', column: 0 }));
  assert.equal(q().getJob.get(jobId).status, 'failed');
});

test('expansion ON keeps the all-empty-graph refusal (unchanged)', async () => {
  const { jobId, credsId, csv } = makeJob('cluster', ['k1']);
  mockRegistry();
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0',
    clusters: [{ compositeXid: { nsid: 5000, id: 'k1' }, members: [] }] });
  await assert.rejects(() => runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null, credsId, sandboxName: 'prod', column: 0 }));
  assert.equal(q().getJob.get(jobId).status, 'failed');
});

test('expansion OFF resume skips IDs already stored', async () => {
  const { jobId, credsId, csv } = makeJob('none', ['k1', 'k2']);
  bulkInsertIdentities([[jobId, 'hashedKocid', 5000, 'k1', 'k1']]);
  mockRegistry();
  await runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000,
    credsId, sandboxName: 'prod', column: 0, skipSourceIds: new Set(['k1']) });
  const n = db.prepare("SELECT COUNT(*) AS n FROM expanded_identities WHERE job_id = ? AND source_id = 'k1'").get(jobId).n;
  assert.equal(n, 1);
  assert.equal(q().getJob.get(jobId).status, 'expanded');
});

function upload(fields) {
  const fd = new FormData();
  fd.append('file', new Blob(['u1\nu2\n'], { type: 'text/csv' }), 'ids.csv');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${baseUrl}/api/upload`, { method: 'POST', body: fd }).then(async r => ({ status: r.status, body: await r.json() }));
}

test('POST /api/upload validates expansionMode and stores it on the job', async () => {
  const { credsId } = makeJob('cluster');
  const bad = await upload({ credsId, sandboxName: 'prod', expansionMode: 'everything' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_expansion_mode');
  mockRegistry();
  const ok = await upload({ credsId, sandboxName: 'prod', expansionMode: 'none' });
  assert.equal(ok.status, 200);
  assert.equal(q().getJob.get(ok.body.jobId).expansion_mode, 'none');
  // Let the upload's background expansion finish so it can't consume the next
  // test's HTTP mocks.
  for (let i = 0; i < 300 && q().getJob.get(ok.body.jobId).status === 'expanding'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(q().getJob.get(ok.body.jobId).status, 'expanded');
});

test('a successful cluster expansion builds the analysis in the background; an IDs-only one does not', async () => {
  const { jobId, credsId, csv } = makeJob('cluster', ['k1', 'k2']);
  mockRegistry();
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0', clusters: [
    { compositeXid: { nsid: 5000, id: 'k1' }, members: [{ nsid: 5000, id: 'k1' }, { nsid: 6, id: 'k1@x.com' }] },
    { compositeXid: { nsid: 5000, id: 'k2' }, members: [{ nsid: 5000, id: 'k2' }, { nsid: 5000, id: 'zz' }] },
  ] });
  await runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    credsId, sandboxName: 'prod', column: 0 });
  assert.equal(q().getJob.get(jobId).status, 'expanded');
  for (let i = 0; i < 200 && q().getJobAnalysis.get(jobId)?.status !== 'ready'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  const ja = q().getJobAnalysis.get(jobId);
  assert.equal(ja?.status, 'ready');
  assert.deepEqual(JSON.parse(ja.summary_json).byCategory,
    { source_only: 0, linked: 1, merged_in_list: 0, merged_outside_list: 1 });

  const off = makeJob('none', ['k1']);
  mockRegistry();
  await runExpansion({ jobId: off.jobId, uploadPath: off.csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    credsId: off.credsId, sandboxName: 'prod', column: 0 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(q().getJobAnalysis.get(off.jobId), undefined, 'no analysis for an IDs-only job');
});
