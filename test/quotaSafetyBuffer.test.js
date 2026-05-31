/**
 * Review R6 #3: QUOTA_SAFETY_BUFFER holds back a fraction of each Adobe quota as
 * headroom for concurrent EXTERNAL writers (other UI users / API clients / a
 * second helper instance in the same org) that this tool cannot see between its
 * once-per-run /quota snapshot and its submit. A WO that fits the FULL cap but
 * not the BUFFERED cap must be DEFERRED, never shipped.
 *
 * The env var must be set BEFORE importing config (read once at module load).
 */

process.env.QUOTA_SAFETY_BUFFER = '0.1';   // reserve 10%

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-buffer-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { config } = await import('../src/config.js');
const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runSubmission } = await import('../src/runner/submission.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';

before(() => { initDb(); });
afterEach(() => { nock.cleanAll(); clearQuotaCache(); });
after(() => { for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } } });

test('config parses and clamps QUOTA_SAFETY_BUFFER', () => {
  assert.equal(config.quotaSafetyBuffer, 0.1);
});

test('a WO that fits the full cap but not the buffered cap is DEFERRED, not shipped', () => {
  const credsId = storeCreds({
    label: 'Buf', environment: 'prod', region: 'VA7',
    imsOrgId: 'buf-org@AcmeOrg', clientId: 'buf-client', clientSecret: 'secret',
  });
  const jobId = 'buf-job';
  q().insertJob.run({ id: jobId, name: 'Buf', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 0 });
  q().updateJobStatus.run('ready', null, jobId);
  // 950k fits the full 1M cap but exceeds the buffered 900k cap.
  q().insertWorkOrder.run({ id: `${jobId}-wo-0`, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 950_000, status: 'planned' });

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, {
    quotas: [
      { name: 'dailyConsumerDeleteIdentitiesQuota',   consumed: 0, quota: 1_000_000 },
      { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 3_000_000 },
    ],
  });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++; return { workorderId: 'DI-buf', status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });

  return runSubmission({ jobId }).then(res => {
    assert.equal(posts, 0, 'a 950k WO must not ship against a buffered 900k daily cap');
    assert.equal(res.submitted, 0);
    assert.equal(res.deferred, 1, 'it is deferred for a later window');
    const wo = q().getAllOrdersForJob.all(jobId)[0];
    assert.equal(wo.status, 'deferred');
  });
});
