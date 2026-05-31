/**
 * Review finding #10: POST /api/jobs/:id/submit kicks off submission async and
 * returns {ok:true}. A preflight failure (quota_unavailable) must NOT be a
 * silent false success — it is persisted to job.last_error so the operator can
 * observe it via GET /api/jobs/:id.
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

const dbPath = path.join(os.tmpdir(), `aep-test-submit-route-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '4000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');
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

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(baseUrl + pathname);
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname,
      method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

test('submit persists a quota_unavailable preflight failure to job.last_error', async () => {
  const credsId = storeCreds({
    label: 'SubmitErr', environment: 'prod', region: 'VA7',
    imsOrgId: 'submiterr-org@AcmeOrg', clientId: 'submiterr-client', clientSecret: 'secret',
  });
  const jobId = uuid();
  q().insertJob.run({
    id: jobId, name: 'SubmitErr', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run('ready', null, jobId);
  q().insertWorkOrder.run({
    id: `${jobId}-wo`, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 100, status: 'planned',
  });

  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  // Malformed /quota: no recognized daily entitlement -> runSubmission throws quota_unavailable.
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [] });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => { posts++; return { workorderId: 'DI', status: 'received' }; });

  const res = await request('POST', `/api/jobs/${jobId}/submit`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.async, true);

  const errored = await waitFor(() => {
    const lastError = q().getJob.get(jobId).last_error;
    return lastError && /Submit blocked/.test(lastError) ? lastError : null;
  });
  assert.ok(errored, 'job.last_error must be populated with the quota failure');
  assert.equal(posts, 0, 'no work order may ship on a quota_unavailable preflight');
});
