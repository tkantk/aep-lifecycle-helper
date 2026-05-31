/**
 * Tests for runner/submission.js::runSubmission bucket selection.
 *
 * Review blocker #3: when runSubmission is called with NO (month, day) bucket
 * — which is exactly how the auto-resume scheduler invokes it — the old code
 * loaded EVERY planned/deferred order and gated only on a local ledger seeded
 * from the full daily cap (not Adobe's live `remaining`). The redistributor
 * had already bucketed work to respect Adobe's remaining, but the no-bucket
 * submit path ignored those buckets and over-submitted beyond what Adobe had
 * left for today. The fix: the no-bucket path ships only the current
 * (lowest-month, lowest-day) window the redistributor produced.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-buckets-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runSubmission } = await import('../src/runner/submission.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';

before(() => { initDb(); });
afterEach(() => { nock.cleanAll(); clearQuotaCache(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

let seq = 0;
function seedJobWithOrders(orderCounts) {
  seq++;
  const credsId = storeCreds({
    label: `Buckets ${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `buckets-org-${seq}@AcmeOrg`, clientId: `buckets-client-${seq}`,
    clientSecret: 'secret',
  });
  const jobId = `buckets-job-${seq}`;
  q().insertJob.run({
    id: jobId, name: `Buckets ${seq}`, credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000,
    uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run('ready', null, jobId);
  orderCounts.forEach((count, i) => {
    q().insertWorkOrder.run({
      id: `${jobId}-wo-${i}`, jobId, dayIndex: 1,
      datasetIds: 'ALL', targetServicesJson: null,
      // identifier_count drives bucketing/quota; the actual id list is kept
      // tiny so the mocked POST stays small (hygiene validates the array, not
      // the count column).
      namespacesIdentities: JSON.stringify([
        { namespace: { code: 'email', id: 6 }, ids: [`wo${i}@x.com`] },
      ]),
      identifierCount: count, status: 'planned',
    });
  });
  return { jobId };
}

function mockIms() {
  nock(IMS).post('/ims/token/v3').reply(200, { access_token: 'test-tok', expires_in: 86400 });
}
function mockOrgQuota({ dailyRemaining, monthlyRemaining = 3_000_000 }) {
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, {
    quotas: [
      { name: 'dailyConsumerDeleteIdentitiesQuota',   consumed: 1_000_000 - dailyRemaining,   quota: 1_000_000 },
      { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 3_000_000 - monthlyRemaining, quota: 3_000_000 },
    ],
  });
}

test('runSubmission fails closed when /quota has no recognized daily entitlement', async () => {
  // Review finding #6: a 200 whose shape we don't recognize (no daily quota
  // entry) used to leave quotaSnapshot.daily = null, and submission silently
  // fell back to the static job.daily_limit and shipped anyway. A destructive
  // submit must STOP on an unrecognized entitlement, not guess.
  const { jobId } = seedJobWithOrders([100_000]);

  mockIms();
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [] });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++;
    return { workorderId: 'DI-x', status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });

  await assert.rejects(
    () => runSubmission({ jobId }),
    err => { assert.equal(err.code, 'quota_unavailable'); return true; },
  );
  assert.equal(posts, 0, 'no work order may ship when the daily entitlement is unrecognized');
});

test('runSubmission with no bucket ships only the current day window (not all planned)', async () => {
  // 3 work orders of 100k each. Adobe says only 100k remains today, so the
  // redistributor packs WO0 into (month 1, day 1) and WO1+WO2 into day 2.
  // A no-bucket submit must ship ONLY day 1 (1 POST), leaving day-2 work for
  // the next run / next UTC day.
  const { jobId } = seedJobWithOrders([100_000, 100_000, 100_000]);

  mockIms();
  mockOrgQuota({ dailyRemaining: 100_000 });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++;
    return { workorderId: `DI-${posts}`, status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });

  const res = await runSubmission({ jobId });

  assert.equal(res.submitted, 1, 'only today\'s (day-1) bucket should ship');
  assert.equal(posts, 1, 'exactly one POST must reach Adobe');

  const orders = q().getAllOrdersForJob.all(jobId);
  const submitted = orders.filter(o => o.status === 'submitted');
  const planned   = orders.filter(o => o.status === 'planned');
  assert.equal(submitted.length, 1);
  assert.equal(planned.length, 2, 'day-2 work orders must remain planned for a later window');
});
