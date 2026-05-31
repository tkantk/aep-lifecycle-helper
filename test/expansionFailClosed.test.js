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

test('expansion fails closed when the Identity Graph returns zero linked members (empty {clusters:[]})', async () => {
  // Review finding #2 (R2): a 200 {clusters:[]} (wrong region / wrong nsid /
  // empty graph) must NOT yield a source-only deletion plan. The job is marked
  // failed, not expanded.
  const credsId = storeCreds({
    label: 'EmptyGraph', environment: 'prod', region: 'VA7',
    imsOrgId: 'emptygraph-org@AcmeOrg', clientId: 'emptygraph-client', clientSecret: 'secret',
  });
  const csv = path.join(uploadDir, 'eg.csv');
  fs.writeFileSync(csv, 'src-a\nsrc-b\n');
  const jobId = 'emptygraph-job';
  q().insertJob.run({
    id: jobId, name: 'EmptyGraph', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv, totalSourceIds: 2,
  });

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
  // Adobe returns NO clusters at all — the wrong-region/empty fingerprint.
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0', clusters: [] });

  await assert.rejects(() => runExpansion({
    jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    credsId, sandboxName: 'prod', column: 0,
  }));

  assert.equal(q().getJob.get(jobId).status, 'failed',
    'an all-empty graph must mark the job failed, not expanded');
});

test('empty-graph fail-closed also fires on a RESUME (crash mid-empty-expansion does not bypass it)', async () => {
  // Review re-review (#2): the guard must NOT be skipped just because this is a
  // resume (skipSourceIds set). A wrong-region job that crashed mid-expansion
  // would otherwise resume and be marked 'expanded' with a source-only plan.
  // The persisted graph_members_seen counter makes the check correct across
  // the crash boundary.
  const credsId = storeCreds({
    label: 'EmptyResume', environment: 'prod', region: 'VA7',
    imsOrgId: 'emptyresume-org@AcmeOrg', clientId: 'emptyresume-client', clientSecret: 'secret',
  });
  const csv = path.join(uploadDir, 'er.csv');
  fs.writeFileSync(csv, 'src-a\nsrc-b\n');
  const jobId = 'emptyresume-job';
  q().insertJob.run({
    id: jobId, name: 'EmptyResume', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv, totalSourceIds: 2,
  });
  // Simulate the prior fresh run: it processed src-a, found ZERO linked members
  // (empty graph), then crashed before the completion guard ran.
  q().incrementJobCounters.run(1, 1, 0, jobId);   // processed=1, found=1, members=0
  q().updateJobStatus.run('expanding', null, jobId);

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 11124296, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
  ]);
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0', clusters: [] });

  await assert.rejects(() => runExpansion({
    jobId, uploadPath: csv, sourceNamespace: 'hashedKocid', sourceNamespaceId: 11124296,
    credsId, sandboxName: 'prod', column: 0,
    skipSourceIds: new Set(['src-a']),   // RESUME
  }));

  assert.equal(q().getJob.get(jobId).status, 'failed',
    'a resume of an all-empty expansion must still fail closed');
});

test('expansion fails closed when the source code is absent from the registry even if an nsid is supplied (review #5)', async () => {
  // Registry maps id 411 to "actualCode". The operator supplied code
  // "missingCode" + nsid 411. Pre-fix, the supplied nsid bypassed the
  // code-existence check and expansion proceeded against the wrong namespace.
  const credsId = storeCreds({
    label: 'Mismatch', environment: 'prod', region: 'VA7',
    imsOrgId: 'mismatch-org@AcmeOrg', clientId: 'mismatch-client', clientSecret: 'secret',
  });
  const csv = path.join(uploadDir, 'mm.csv');
  fs.writeFileSync(csv, 'src-a\n');
  const jobId = 'mismatch-job';
  q().insertJob.run({
    id: jobId, name: 'Mismatch', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'missingCode', sourceNamespaceId: 411,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv, totalSourceIds: 1,
  });

  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).get('/data/core/idnamespace/identities').reply(200, [
    { id: 411, code: 'actualCode', name: 'Actual', custom: true, status: 'ACTIVE' },
  ]);
  // Identity Graph MUST NOT be called — validation fails before any batch.
  const clusters = nock(REGION).post('/data/core/identity/clusters/members').reply(200, { clusters: [] });

  await assert.rejects(() => runExpansion({
    jobId, uploadPath: csv, sourceNamespace: 'missingCode', sourceNamespaceId: 411,
    credsId, sandboxName: 'prod', column: 0,
  }), /not found in the sandbox's namespace registry/i);

  assert.equal(q().getJob.get(jobId).status, 'failed');
  assert.ok(!clusters.isDone(), 'must not call the Identity Graph for an unregistered source namespace');
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
