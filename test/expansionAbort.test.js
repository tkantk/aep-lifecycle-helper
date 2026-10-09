/**
 * A failed run stops at once (final review #3, 2026-10-09). With timeout retries,
 * the other batches of the failed batch's group kept retrying for up to ~12 min
 * (6 × 120 s + backoff) before the job was marked failed: Resume was refused, the
 * tab said "Waiting for Adobe", and the job's error could be a straggler's timeout
 * instead of the real first failure.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-abort-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-abort-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.IDENTITY_BATCH_SIZE = '1';          // one ID per batch: both batches in the same group
process.env.IDENTITY_CONCURRENCY = '2';
process.env.IDENTITY_TIMEOUT_MS = '2000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';
const NSID = 11124296;

before(() => initDb());
afterEach(() => nock.cleanAll());
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

test('one failed batch stops the run at once: stragglers are cancelled, and the job keeps the FIRST error', async () => {
  const credsId = storeCreds({ label: 'AB', environment: 'prod', region: 'VA7', imsOrgId: 'abort@AcmeOrg', clientId: 'abort', clientSecret: 's' });
  const csv = path.join(uploadDir, 'ab.csv');
  fs.writeFileSync(csv, 'slow-1\nfail-1\n');          // the slow batch is FIRST in the group
  q().insertJob.run({ id: 'abort-job', name: 'AB', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: NSID, dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv, totalSourceIds: 2 });
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).persist().get('/data/core/idnamespace/identities').reply(200, [
    { id: NSID, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' }]);
  let slowCalls = 0;
  nock(REGION).persist().post('/data/core/identity/clusters/members', (b) => b.compositeXids[0].id === 'slow-1')
    .delay(10_000).reply(() => { slowCalls++; return [200, { version: '1.1.0', clusters: [] }]; });  // always times out → retried
  nock(REGION).persist().post('/data/core/identity/clusters/members', (b) => b.compositeXids[0].id === 'fail-1')
    .reply(200, { version: '1.1.0', clusters: [], unprocessedXids: ['fail-1'] });                      // fails at once
  const t = Date.now();
  await assert.rejects(() => runExpansion({ jobId: 'abort-job', uploadPath: csv, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: NSID, credsId, sandboxName: 'prod', column: 0 }), /could not process/);
  const took = Date.now() - t;
  const job = q().getJob.get('abort-job');
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /could not process/, 'the real first failure, not a straggler\'s timeout');
  assert.ok(took < 3000, `marked failed after ${took} ms — the slow batch's retries were cancelled`);
});
