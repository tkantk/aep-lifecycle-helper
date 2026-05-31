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

test('explicit future-bucket submit cannot over-ship past Adobe remaining', async () => {
  // Review blocker #1 (explicit-bucket path): with 100k remaining, the
  // redistributor puts WO0 in day 1 and WO1+WO2 in day 2. An operator viewing
  // "Day 2" submits dayIndex=2 explicitly. The ledger seed caps it at remaining,
  // so at most one 100k WO ships, never both.
  const { jobId } = seedJobWithOrders([100_000, 100_000, 100_000]);
  mockIms();
  mockOrgQuota({ dailyRemaining: 100_000 });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++; return { workorderId: `DI-${posts}`, status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });

  // First run buckets the WOs (and ships day-1). Then explicitly submit day 2.
  await runSubmission({ jobId });                          // ships day-1 WO (100k)
  await runSubmission({ jobId, dayIndex: 2, monthIndex: 1 }); // explicit future bucket

  assert.equal(posts, 1, 'explicit Day-2 submit must not ship beyond Adobe remaining (already exhausted)');
});

test('two sequential no-bucket runs do not over-ship past Adobe remaining (ledger seeded to consumed)', async () => {
  // Review blocker #1: Adobe reports 100k remaining today (consumed 900k by
  // OTHER tools). The local ledger starts at 0 and reserve compares against the
  // FULL cap, so without seeding the ledger to Adobe's consumed, a second run
  // (Adobe /quota.consumed still lagging at 900k) re-buckets and ships another
  // 100k — 200k total against a 100k remaining. The fix seeds the ledger UP to
  // consumed (MAX) each run, so only 100k ever ships until Adobe's number moves.
  const { jobId } = seedJobWithOrders([100_000, 100_000, 100_000]);
  mockIms();
  mockOrgQuota({ dailyRemaining: 100_000 });   // consumed = 900k, quota = 1M
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++; return { workorderId: `DI-${posts}`, status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });

  await runSubmission({ jobId });   // ships the single day-1 WO (100k)
  await runSubmission({ jobId });   // must NOT ship a second 100k — remaining is exhausted

  assert.equal(posts, 1, 'only Adobe\'s reported remaining (100k = 1 WO) may ever ship while consumed stays 900k');
  const submitted = q().getAllOrdersForJob.all(jobId).filter(o => o.status === 'submitted');
  assert.equal(submitted.length, 1);
});

test('runSubmission fails closed when daily consumed is malformed (not a finite number)', async () => {
  // Review finding #3: consumed:"not-a-number" was coerced to 0, faking full
  // remaining. Now the entry is invalid → daily missing → fail closed.
  const { jobId } = seedJobWithOrders([100_000]);
  mockIms();
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, {
    quotas: [{ name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 'not-a-number', quota: 1_000_000 }],
  });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++; return { workorderId: 'DI-x', status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });
  await assert.rejects(() => runSubmission({ jobId }),
    err => { assert.equal(err.code, 'quota_unavailable'); return true; });
  assert.equal(posts, 0, 'no WO may ship on a malformed daily entitlement');
});

test('runSubmission fails closed when job tracks monthly but Adobe reports no monthly entitlement', async () => {
  // Review finding #3: a job with a monthly cap must not ship when Adobe's
  // /quota lacks a valid monthly dimension (we would otherwise track monthly
  // against a guessed/absent number).
  const { jobId } = seedJobWithOrders([100_000]);   // seedJobWithOrders sets monthly_limit 3M (tracks monthly)
  mockIms();
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, {
    quotas: [{ name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 }],
  });
  let posts = 0;
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply(200, () => {
    posts++; return { workorderId: 'DI-x', status: 'received', createdAt: '2026-05-31T00:00:00Z' };
  });
  await assert.rejects(() => runSubmission({ jobId }),
    err => { assert.equal(err.code, 'quota_unavailable'); return true; });
  assert.equal(posts, 0, 'no WO may ship when the monthly dimension is required but missing');
});

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
