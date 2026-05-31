/**
 * Review finding #10: expansion was too optimistic about the namespace
 * registry. If the registry GET failed it logged a warning and kept going
 * WITHOUT canonicalization — so linked identities couldn't get their code,
 * the source namespace's nsid couldn't be resolved, and the Identity Graph
 * would very likely return empty clusters. The operator would then delete
 * ONLY the source ids while the linked email/phone/CRMID survived — the exact
 * silent-partial-delete failure mode region routing (I9) exists to prevent.
 *
 * Fix: fail CLOSED — abort the job (status 'failed') and never call the
 * Identity Graph when the registry can't be loaded.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-failclosed-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-failclosed-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '4000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';

before(() => { initDb(); });
afterEach(() => { nock.cleanAll(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

test('expansion fails closed when the namespace registry cannot be loaded', async () => {
  const credsId = storeCreds({
    label: 'FailClosed', environment: 'prod', region: 'VA7',
    imsOrgId: 'failclosed-org@AcmeOrg', clientId: 'failclosed-client', clientSecret: 'secret',
  });
  const csv = path.join(uploadDir, 'fc.csv');
  fs.writeFileSync(csv, 'src-a\nsrc-b\n');
  const jobId = 'failclosed-job';
  q().insertJob.run({
    id: jobId, name: 'FailClosed', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv, totalSourceIds: 2,
  });

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  // Registry endpoint fails on every attempt (5xx, exhausting retries).
  nock(REGION).get('/data/core/idnamespace/identities').times(6).reply(503, 'down');
  // The Identity Graph MUST NOT be called — if it is, nock throws "no match".
  const clusters = nock(REGION).post('/data/core/identity/clusters/members').reply(200, { clusters: [] });

  await assert.rejects(() => runExpansion({
    jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    credsId, sandboxName: 'prod', column: 0,
  }));

  assert.equal(q().getJob.get(jobId).status, 'failed', 'job must be marked failed, not left expanding');
  assert.ok(!clusters.isDone(), 'Identity Graph must NOT be called when the registry is unavailable');
});
