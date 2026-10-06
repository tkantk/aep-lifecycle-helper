/**
 * Fix 4b (2026-10-06 review): a FAILED expansion can be resumed.
 *
 * A 6.8M-profile job is ~6,800 Identity Graph calls over hours on a flaky
 * network; one batch failing after its retries fails the whole job. Startup
 * recovery only resumed 'expanding' jobs, so the operator's only options were to
 * re-upload and start over, or (before fix 4a) plan the partial data.
 * POST /api/jobs/:id/resume-expansion continues it, skipping every source that
 * already has rows — checked per row in SQLite, not by loading millions of IDs
 * into a JS Set.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-resume-exp-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-resume-up-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { liveProgress } = await import('../src/runner/expansion.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';

let server, baseUrl;
before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { nock.cleanAll(); });
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

function post(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write('{}'); req.end();
  });
}
async function waitForStatusNot(jobId, status, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (q().getJob.get(jobId).status !== status) return q().getJob.get(jobId);
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} still ${status} after ${timeoutMs} ms`);
}

let seq = 0;
/** A job whose first expansion processed src-a, then failed. */
function failedJob({ withUpload = true } = {}) {
  seq++;
  const credsId = storeCreds({ label: `Res ${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `res-org-${seq}@AcmeOrg`, clientId: `res-client-${seq}`, clientSecret: 'secret' });
  const csv = path.join(uploadDir, `res-${seq}.csv`);
  if (withUpload) fs.writeFileSync(csv, 'src-a\nsrc-b\nsrc-c\n');
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `Res ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: csv, totalSourceIds: 3 });
  bulkInsertIdentities([
    [jobId, 'hashedKocid', 11124296, 'src-a', 'src-a'],
    [jobId, 'email', 6, 'alice@example.com', 'src-a'],
  ]);
  q().incrementJobCounters.run(1, 2, 1, jobId);     // processed=1, found=2, members=1 from the first run
  q().updateJobStatus.run('failed', 'expansion batch failed: socket hang up', jobId);
  return jobId;
}

test('resume-expansion continues a failed job, asking Adobe only about unprocessed sources', async () => {
  const jobId = failedJob();
  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 6, code: 'email', name: 'Email', custom: false, status: 'ACTIVE' },
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
  let asked = null;
  nock(REGION).post('/data/core/identity/clusters/members', (body) => { asked = body.compositeXids.map(x => x.id).sort(); return true; })
    .reply(200, { version: '1.1.0', clusters: [
      { compositeXid: { nsid: 11124296, id: 'src-b' }, members: [{ nsid: 6, id: 'bob@example.com' }] },
      { compositeXid: { nsid: 11124296, id: 'src-c' }, members: [{ nsid: 6, id: 'carol@example.com' }] },
    ] });

  const res = await post(`/api/jobs/${jobId}/resume-expansion`);
  assert.equal(res.status, 200);
  assert.equal(res.body.resumed, true);
  assert.equal(q().getJob.get(jobId).status === 'expanding' || q().getJob.get(jobId).status === 'expanded', true,
    'the job leaves "failed" immediately, so a second click cannot start a second run');

  const job = await waitForStatusNot(jobId, 'expanding');
  assert.equal(job.status, 'expanded');
  assert.deepEqual(asked, ['src-b', 'src-c'], 'already-expanded src-a is not re-queried');
  assert.equal(job.processed_count, 3, 'counters continue from the first run');
  assert.equal(liveProgress.get(jobId)?.processed, 3, 'live progress shows the cumulative total, not just this run');
});

test('resume-expansion refuses a job that did not fail', async () => {
  for (const status of ['expanded', 'expanding', 'ready']) {
    const jobId = failedJob();
    q().updateJobStatus.run(status, null, jobId);
    const res = await post(`/api/jobs/${jobId}/resume-expansion`);
    assert.equal(res.status, 409, status);
    assert.equal(res.body.error, 'bad_state', status);
  }
});

test('resume-expansion refuses a job that already has work orders', async () => {
  const jobId = failedJob();
  q().insertWorkOrder.run({ id: uuid(), jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: '[]', identifierCount: 1, status: 'planned' });
  const res = await post(`/api/jobs/${jobId}/resume-expansion`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'has_work_orders');
  assert.equal(q().getJob.get(jobId).status, 'failed');
});

test('resume-expansion refuses when the uploaded CSV is gone', async () => {
  const jobId = failedJob({ withUpload: false });
  const res = await post(`/api/jobs/${jobId}/resume-expansion`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'upload_missing');
});

test('resume-expansion 404s an unknown job', async () => {
  const res = await post(`/api/jobs/${uuid()}/resume-expansion`);
  assert.equal(res.status, 404);
});
