/**
 * Final-review fix (2026-10-06): a batch failure in ANY wave — not only the
 * last — must mark the job 'failed' with the reason.
 *
 * `await streamIds(...)` sat outside the try/catch that records 'failed'. A
 * failing Identity Graph batch surfaces through drainWave() inside onRow, so a
 * failure in any wave except the final partial one escaped it: runExpansion
 * rejected while the job stayed 'expanding' with no last_error and frozen
 * progress. The plan gate then said "still running" (false), resume-expansion
 * refused (it needs 'failed'), and only an app restart recovered. A 6.8M-profile
 * run is ~6,800 batches, so a mid-stream failure is the likely one.
 */

process.env.IDENTITY_BATCH_SIZE = '2';      // 10 sources → 5 batches
process.env.IDENTITY_CONCURRENCY = '1';     // WAVE_SIZE = 2 → the failure lands mid-stream

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-midstream-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-midstream-up-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';

before(() => { initDb(); });
after(() => {
  nock.cleanAll();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

test('a batch failing in an early wave marks the job failed with the reason (not stuck "expanding")', async () => {
  const credsId = storeCreds({ label: 'Mid', environment: 'prod', region: 'VA7',
    imsOrgId: 'mid-org@AcmeOrg', clientId: 'mid-client', clientSecret: 'secret' });
  const csv = path.join(uploadDir, 'mid.csv');
  fs.writeFileSync(csv, Array.from({ length: 10 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`).join('\n') + '\n');
  const jobId = 'mid-job';
  q().insertJob.run({ id: jobId, name: 'Mid', credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: csv, totalSourceIds: 10 });

  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 6, code: 'email', name: 'Email', custom: false, status: 'ACTIVE' },
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
  let calls = 0;
  nock(REGION).persist().post('/data/core/identity/clusters/members').reply((_u, body) => {
    calls++;
    if (calls === 2) return [400, { title: 'Bad Request', detail: 'simulated graph rejection' }];
    return [200, { version: '1.1.0', clusters: body.compositeXids.map(x => ({
      compositeXid: { nsid: 11124296, id: x.id }, members: [{ nsid: 6, id: `${x.id}@x.com` }] })) }];
  });

  await assert.rejects(() => runExpansion({ jobId, uploadPath: csv, sourceNamespace: 'hashedKocid',
    sourceNamespaceId: 11124296, credsId, sandboxName: 'prod', column: 0 }));

  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'failed', 'a mid-stream batch failure must not leave the job "expanding"');
  assert.match(job.last_error || '', /simulated graph rejection|HTTP 400/, 'the operator sees why it stopped');
  assert.ok(calls < 5, 'the stream stopped at the failure instead of querying every batch');
});
