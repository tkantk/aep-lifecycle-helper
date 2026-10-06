/**
 * Fix 4a (2026-10-06 review): a plan may only be built from a FINISHED
 * expansion.
 *
 * Before: POST /:id/plan had no status check and the UI offered "Build plan"
 * for any job without work orders. Planning a job that was still expanding — or
 * whose expansion had FAILED part-way — planned only the identities found so
 * far, flipped the job to 'ready' (which also disabled runSubmission's "still
 * expanding" guard), and once anything shipped, re-plan was forbidden: the rest
 * of the identities could never be deleted.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-plan-gate-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { planWorkOrders, PlanNotReadyError } = await import('../src/runner/submission.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server, baseUrl;
before(async () => {
  initDb();
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  nock.enableNetConnect();
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

let seq = 0;
function jobWithIdentities(status) {
  seq++;
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'G', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `gate-org-${seq}@AdobeOrg`, clientId: `gate-client-${seq}`,
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `Gate ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 2 });
  bulkInsertIdentities([[jobId, 'email', 6, `a${seq}@x.com`, `k${seq}`]]);   // partial data from a run that hasn't finished
  if (status) q().updateJobStatus.run(status, status === 'failed' ? 'Identity Graph batch failed' : null, jobId);
  return jobId;
}
const plan = (jobId) => planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });

for (const status of [null /* 'created' */, 'expanding', 'failed']) {
  test(`planner refuses a job whose expansion is ${status ?? 'created'} — no work orders, status untouched`, () => {
    const jobId = jobWithIdentities(status);
    const before = q().getJob.get(jobId);
    assert.throws(() => plan(jobId), (err) => {
      assert.ok(err instanceof PlanNotReadyError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'not_expanded');
      return true;
    });
    assert.equal(q().countWorkOrdersByStatus.all(jobId).length, 0, 'nothing was planned');
    const after = q().getJob.get(jobId);
    assert.equal(after.status, before.status, 'job status unchanged (still blocks submission)');
    assert.equal(after.last_error, before.last_error, 'the expansion error stays visible');
  });
}

for (const status of ['expanded', 'ready']) {
  test(`planner accepts a job that finished expansion (${status})`, () => {
    const jobId = jobWithIdentities(status);
    assert.equal(plan(jobId).planned, 1);
  });
}

function postJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write('{}'); req.end();
  });
}

for (const status of ['expanding', 'failed']) {
  test(`POST /:id/plan returns 409 not_expanded for a ${status} job, before contacting Adobe`, async () => {
    const jobId = jobWithIdentities(status);
    const res = await postJson(`/api/jobs/${jobId}/plan`);   // net connect to Adobe is disabled: any call would throw
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'not_expanded');
    assert.match(res.body.message, /expansion/i);
  });
}
