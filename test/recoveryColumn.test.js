/**
 * Review blocker #4: the CSV source column chosen at upload time was never
 * persisted on the job, and recovery.js hardcoded `column: 0`. A crash during
 * expansion of a job whose identifiers live in (say) column 1 would resume
 * against column 0 — expanding identifiers the operator never selected.
 *
 * This test seeds an 'expanding' job whose source column is 1, runs the
 * recovery resume path, and asserts Adobe is asked about the column-1 values.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-reccol-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-reccol-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { resumeExpandingJobs } = await import('../src/runner/recovery.js');

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

async function waitForStatus(jobId, status, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (q().getJob.get(jobId).status === status) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for job ${jobId} to reach ${status} (now ${q().getJob.get(jobId).status})`);
}

test('resume uses the persisted source column, not hardcoded column 0', async () => {
  const credsId = storeCreds({
    label: 'RecCol', environment: 'prod', region: 'VA7',
    imsOrgId: 'reccol-org@AcmeOrg', clientId: 'reccol-client', clientSecret: 'secret',
  });

  // Two-column CSV: column 0 is junk, the REAL identifiers are in column 1.
  const csv = path.join(uploadDir, 'two-col.csv');
  fs.writeFileSync(csv, 'junk0,realA\njunk1,realB\n');

  const jobId = 'reccol-job-1';
  q().insertJob.run({
    id: jobId, name: 'RecCol', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: csv, totalSourceIds: 2,
  });
  q().setJobSourceColumn.run('1', jobId);   // operator picked column index 1
  q().updateJobStatus.run('expanding', null, jobId);

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
  let askedIds = null;
  nock(REGION).post('/data/core/identity/clusters/members', body => {
    askedIds = body.compositeXids.map(x => x.id).sort();
    return true;
  }).reply(200, { version: '1.1.0', clusters: [
    { compositeXid: { nsid: 11124296, id: 'realA' }, members: [{ nsid: 11124296, id: 'realA' }] },
    { compositeXid: { nsid: 11124296, id: 'realB' }, members: [{ nsid: 11124296, id: 'realB' }] },
  ]});

  await resumeExpandingJobs();
  await waitForStatus(jobId, 'expanded');

  assert.deepEqual(askedIds, ['realA', 'realB'],
    'recovery must expand the persisted column-1 values, not column-0 junk');
});
