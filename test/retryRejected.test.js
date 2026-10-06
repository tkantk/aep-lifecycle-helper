/**
 * Fix 5 (2026-10-06 review): a work order Adobe definitively REJECTED can be
 * retried; an AMBIGUOUS 4xx is never treated as a rejection.
 *
 * Before: every 4xx marked the order failed/definitive and released its quota,
 * and there was no way to retry it (re-plan is forbidden once anything ships), so
 * its ~100k identities were stranded. Worse, a 408 (e.g. a corporate proxy that
 * timed out AFTER forwarding the request) or a 409 does not prove Adobe never
 * created the order — releasing it under-counts quota and retrying it could
 * duplicate an irreversible delete. A pre-network validation error, meanwhile,
 * was classified UNCERTAIN (no HTTP status) and left 'submitting' with quota held
 * although nothing was ever sent.
 */

process.env.WORK_ORDER_CONCURRENCY = '1';

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-retry-rej-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runSubmission } = await import('../src/runner/submission.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');
const { markPosting, unmarkPosting } = await import('../src/runner/postingState.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';

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
afterEach(() => { nock.cleanAll(); clearQuotaCache(); });
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

let seq = 0;
function seedJob({ datasetIds = 'ALL' } = {}) {
  seq++;
  const credsId = storeCreds({ label: `Rej ${seq}`, environment: 'Production', region: 'va7',
    imsOrgId: `rej-org-${seq}@AdobeOrg`, clientId: `rej-client-${seq}`, clientSecret: 's' });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `Rej ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 0 });
  q().updateJobStatus.run('ready', null, jobId);
  const woId = uuid();
  q().insertWorkOrder.run({ id: woId, jobId, dayIndex: 1, datasetIds, targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 1, status: 'planned' });
  return { jobId, woId, org: `rej-org-${seq}@AdobeOrg` };
}
function mockAdobe(postStatus, postBody = { title: 'nope' }) {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [
    { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 },
    { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 3_000_000 },
  ] });
  const posts = [];
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply((_u, body) => {
    posts.push(body.displayName);
    return postStatus === 200
      ? [200, { workorderId: `DI-${posts.length}`, status: 'received', createdAt: new Date().toISOString() }]
      : [postStatus, postBody];
  });
  return posts;
}
const wo = (jobId, woId) => q().getWorkOrderByIdAndJob.get(woId, jobId);

for (const status of [408, 409]) {
  test(`HTTP ${status} is UNCERTAIN: order stays submitting and its quota stays held`, async () => {
    const { jobId, woId } = seedJob();
    mockAdobe(status);
    const r = await runSubmission({ jobId, workOrderIds: [woId] });
    assert.equal(r.failed, 1);
    const row = wo(jobId, woId);
    assert.equal(row.status, 'submitting', 'left for reconciliation — Adobe may have created it');
    assert.equal(row.failure_definitive, 0);
    assert.equal(q().getReservation.get(woId).active, 1, 'quota NOT released');
  });
}

test('HTTP 400 is a definitive rejection: failed, definitive, quota released', async () => {
  const { jobId, woId } = seedJob();
  mockAdobe(400);
  await runSubmission({ jobId, workOrderIds: [woId] });
  const row = wo(jobId, woId);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_definitive, 1);
  assert.equal(q().getReservation.get(woId).active, 0);
});

test('a pre-network validation error is definitive (nothing sent), not left submitting', async () => {
  const { jobId, woId } = seedJob({ datasetIds: 'ALL,abc' });   // invalid: ALL combined with ids
  const posts = mockAdobe(200);
  const r = await runSubmission({ jobId, workOrderIds: [woId] });
  assert.equal(posts.length, 0, 'never reached Adobe');
  assert.equal(r.failed, 1);
  const row = wo(jobId, woId);
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_definitive, 1);
  assert.equal(q().getReservation.get(woId).active, 0, 'refunded: Adobe never saw it');
});

function post(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write('{}'); req.end();
  });
}
const retry = (jobId, woId) => post(`/api/jobs/${jobId}/work-orders/${woId}/retry-rejected`);

test('retry-rejected re-queues a definitively rejected order, which then ships', async () => {
  const { jobId, woId } = seedJob();
  mockAdobe(400);
  await runSubmission({ jobId, workOrderIds: [woId] });
  nock.cleanAll(); clearQuotaCache();
  const attemptBefore = wo(jobId, woId).attempt;

  const res = await retry(jobId, woId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, woId, status: 'planned' });
  const row = wo(jobId, woId);
  assert.equal(row.status, 'planned');
  assert.equal(row.failure_definitive, 0);
  assert.equal(row.last_error, null);
  assert.equal(row.attempt, attemptBefore + 1);

  const posts = mockAdobe(200);
  const r = await runSubmission({ jobId, workOrderIds: [woId] });
  assert.equal(r.submitted, 1);
  assert.equal(posts.length, 1);
});

test('retry-rejected accepts a local (never-sent) failure', async () => {
  const { jobId, woId } = seedJob();
  q().markWorkOrderFailedDefinitive.run('work order payload unreadable: Unexpected token', woId);
  assert.equal((await retry(jobId, woId)).status, 200);
});

test('retry-rejected refuses a "definitive" row whose recorded status was ambiguous (legacy 408)', async () => {
  const { jobId, woId } = seedJob();
  // Pre-2026-10-06 code marked EVERY 4xx definitive — including a proxy 408.
  q().markWorkOrderFailedDefinitive.run('HTTP 408 Request Timeout: upstream timed out', woId);
  const res = await retry(jobId, woId);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'ambiguous_rejection');
  assert.equal(wo(jobId, woId).status, 'failed', 'left alone');
});

test('retry-rejected refuses anything that is not a definitive rejection', async () => {
  const cases = [
    ['planned', (id) => {}],
    ['submitted', (id) => q().updateWorkOrderSubmitted.run({ id, adobeWorkorderId: 'DI-x', adobeStatus: 'received', bundleId: null, submittedAt: null })],
    ['ambiguous failed', (id) => q().updateWorkOrderStatus.run('failed', 'timeout of 60000ms exceeded', id)],
    ['submitting', (id) => q().updateWorkOrderStatus.run('submitting', null, id)],
  ];
  for (const [label, setup] of cases) {
    const { jobId, woId } = seedJob();
    setup(woId);
    const res = await retry(jobId, woId);
    assert.equal(res.status, 409, label);
  }
});

test('retry-rejected refuses while the order is being POSTed, and for another job\'s order', async () => {
  const { jobId, woId } = seedJob();
  q().markWorkOrderFailedDefinitive.run('HTTP 400 Bad Request: x', woId);
  markPosting(woId);
  try {
    assert.equal((await retry(jobId, woId)).status, 409);
  } finally { unmarkPosting(woId); }
  const other = seedJob();
  assert.equal((await retry(other.jobId, woId)).status, 404);
});
