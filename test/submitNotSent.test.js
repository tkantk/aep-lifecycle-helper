/**
 * Work orders that were never sent, or that came back without a work-order ID,
 * must never be recorded as submitted (final review #8, 2026-10-09).
 *
 * Before: a sign-in (IMS) failure while re-fetching the token made the work-order
 * POST resolve with the IMS reply, and the order was marked 'submitted' with no
 * Adobe ID and its quota accepted — nothing was deleted and nothing would ever
 * reconcile it.
 */
process.env.WORK_ORDER_CONCURRENCY = '1';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-notsent-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';
process.env.QUOTA_PREFLIGHT_RETRY_DELAY_MS = '1';

const { initDb, q, db } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runSubmission } = await import('../src/runner/submission.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';

before(() => initDb());
after(() => {
  nock.cleanAll();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});
beforeEach(() => { nock.cleanAll(); clearQuotaCache(); });

function quota() {
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [
    { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 },
    { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 3_000_000 },
  ] });
}
let seq = 0;
function seedOneOrder() {
  seq++;
  const credsId = storeCreds({ label: `NS ${seq}`, environment: 'Production', region: 'va7',
    imsOrgId: `ns-org-${seq}@AdobeOrg`, clientId: `ns-client-${seq}`, clientSecret: 's' });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `NS ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 0 });
  q().updateJobStatus.run('ready', null, jobId);
  const id = uuid();
  q().insertWorkOrder.run({ id, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 1, status: 'planned' });
  return { jobId, id };
}
const wo = (id) => db.prepare('SELECT status, adobe_workorder_id, failure_definitive, last_error FROM work_orders WHERE id = ?').get(id);
const activeReservation = (id) => db.prepare('SELECT active FROM quota_reservations WHERE work_order_id = ?').get(id)?.active ?? 0;

test('a work order whose sign-in fails before sending is released for retry — never "submitted"', async () => {
  const { jobId, id } = seedOneOrder();
  quota();
  let ims = 0, posts = 0;
  // 1st token: the quota check. After Adobe's 401 the client re-fetches → IMS throttles.
  nock(IMS).post('/ims/token/v3').reply(() => { ims++; return [200, { access_token: 'tok-a', expires_in: 86400 }]; });
  nock(IMS).post('/ims/token/v3').reply(() => { ims++; return [429, { error: 'too_many_requests' }]; });
  nock(IMS).persist().post('/ims/token/v3').reply(() => { ims++; return [200, { access_token: 'tok-b', expires_in: 86400 }]; });
  nock(GATEWAY).post('/data/core/hygiene/workorder').reply(() => { posts++; return [401, { message: 'token expired' }]; });
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(() => { posts++; return [201, { workorderId: 'DI-1', status: 'received' }]; });
  const r = await runSubmission({ jobId, workOrderIds: [id] });
  const w = wo(id);
  assert.notEqual(w.status, 'submitted', `recorded as ${JSON.stringify(w)}`);
  assert.deepEqual([w.status, w.adobe_workorder_id, w.failure_definitive], ['failed', null, 1], 'definitively not created → retryable');
  assert.match(w.last_error, /not sent/);
  assert.equal(activeReservation(id), 0, 'its quota is released');
  assert.equal(posts, 1, 'only the attempt Adobe refused with 401 reached Adobe');
  assert.equal(r.submitted, 0);
});

test('a 2xx reply without a work-order ID is uncertain — kept for reconcile, never "submitted"', async () => {
  const { jobId, id } = seedOneOrder();
  quota();
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(201, { status: 'received' });
  const r = await runSubmission({ jobId, workOrderIds: [id] });
  const w = wo(id);
  assert.deepEqual([w.status, w.adobe_workorder_id], ['submitting', null], `recorded as ${JSON.stringify(w)}`);
  assert.match(w.last_error, /no work-order ID/i);
  assert.equal(activeReservation(id), 1, 'quota stays held until reconcile settles it');
  assert.equal(r.submitted, 0);
});
