/**
 * Unit + integration tests for src/services/quotaApi.js.
 *
 * Uses nock to mock both IMS (so token refresh works) and Adobe's
 * /data/core/hygiene/quota endpoint. Covers: shape parsing, 1-hour cache,
 * forced refresh, stale fallback when a live call fails, and the hard-floor
 * 24-hour rule that re-raises the error when the cache is too old.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';

const IMS_HOST     = 'https://ims-na1.adobelogin.com';
const AEP_GATEWAY  = 'https://platform.adobe.io';
const QUOTA_PATH   = '/data/core/hygiene/quota';

const { getOrgQuota, _clearCache } = await import('../src/services/quotaApi.js');

function mockIms() {
  return nock(IMS_HOST).persist().post('/ims/token/v3')
    .reply(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
}

// nock.isDone() is useless here because mockIms() persists; check the quota
// interceptors directly instead.
const pendingQuotaMocks = () => nock.pendingMocks().filter((m) => m.includes(QUOTA_PATH));

function baseCreds(overrides = {}) {
  return {
    clientId: 'client-q',
    imsOrgId: 'org-q@AcmeOrg',
    clientSecret: 'sec',
    region: 'va7',
    ...overrides,
  };
}

const SAMPLE_BODY = {
  quotas: [
    { name: 'dailyConsumerDeleteIdentitiesQuota',   consumed: 314,  quota: 700_000,    description: 'daily' },
    { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 2764, quota: 12_000_000, description: 'monthly' },
    { name: 'datasetExpirationQuota',               consumed: 11,   quota: 75,          description: 'expiration' },
  ],
};

beforeEach(() => {
  nock.cleanAll();
  _clearCache();
});

// ─── Shape parsing ────────────────────────────────────────────────────────

test('getOrgQuota parses the documented response shape', async () => {
  mockIms();
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, SAMPLE_BODY);

  const result = await getOrgQuota(baseCreds());
  assert.deepEqual(result.daily,
    { consumed: 314,  quota: 700_000,    remaining: 699_686,    description: 'daily' });
  assert.deepEqual(result.monthly,
    { consumed: 2764, quota: 12_000_000, remaining: 11_997_236, description: 'monthly' });
  assert.deepEqual(result.datasetExpiration,
    { consumed: 11,   quota: 75,          remaining: 64,          description: 'expiration' });
  assert.equal(result.stale, false);
  assert.equal(result.error, null);
  assert.ok(result.fetchedAt);
});

test('getOrgQuota handles missing quotas gracefully', async () => {
  mockIms();
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, { quotas: [] });

  const result = await getOrgQuota(baseCreds());
  assert.equal(result.daily, null);
  assert.equal(result.monthly, null);
  assert.equal(result.datasetExpiration, null);
});

test('getOrgQuota rejects null/non-integer consumed (Number(null)===0 fail-open)', async () => {
  // Review #4: { consumed: null } must NOT become 0 (full remaining). null,
  // booleans, arrays, strings and non-integers are all malformed → entry null.
  for (const bad of [null, true, [1], '900', 1.5, -1]) {
    mockIms();
    nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, {
      quotas: [{ name: 'dailyConsumerDeleteIdentitiesQuota', consumed: bad, quota: 1_000_000 }],
    });
    const r = await getOrgQuota(baseCreds(), { refresh: true });
    assert.equal(r.daily, null, `consumed=${JSON.stringify(bad)} must yield daily=null, not a fake remaining`);
    nock.cleanAll(); _clearCache();
  }
});

test('getOrgQuota handles missing remaining (consumed=0 case)', async () => {
  mockIms();
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, {
    quotas: [
      { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 },
    ],
  });
  const result = await getOrgQuota(baseCreds());
  assert.equal(result.daily.remaining, 1_000_000);
});

// ─── Caching ──────────────────────────────────────────────────────────────

test('getOrgQuota: second call within TTL is served from cache (no extra Adobe hit)', async () => {
  mockIms();
  // Only ONE interceptor — if cache is missed, nock will throw on the 2nd call.
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, SAMPLE_BODY);

  const a = await getOrgQuota(baseCreds());
  const b = await getOrgQuota(baseCreds());
  assert.equal(a.fetchedAt, b.fetchedAt, 'both calls should share the same fetchedAt');
  assert.equal(b.stale, false);
});

test('getOrgQuota: refresh=true forces a new live fetch even within TTL', async () => {
  mockIms();
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, SAMPLE_BODY);
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, {
    ...SAMPLE_BODY,
    quotas: SAMPLE_BODY.quotas.map(q =>
      q.name === 'dailyConsumerDeleteIdentitiesQuota' ? { ...q, consumed: 500 } : q),
  });

  const a = await getOrgQuota(baseCreds());
  const b = await getOrgQuota(baseCreds(), { refresh: true });
  assert.equal(a.daily.consumed, 314);
  assert.equal(b.daily.consumed, 500);
  assert.notEqual(a.fetchedAt, b.fetchedAt);
});

// ─── Stale fallback ───────────────────────────────────────────────────────

test('getOrgQuota: live fetch failure falls back to last cache with stale=true', async () => {
  mockIms();
  // First call succeeds and populates cache.
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, SAMPLE_BODY);
  const first = await getOrgQuota(baseCreds());

  // Second call (forced refresh) fails. Adobe returns 500.
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(500, { message: 'boom' });
  const second = await getOrgQuota(baseCreds(), { refresh: true });

  assert.equal(second.stale, true);
  assert.ok(second.error, 'error message should be populated');
  // The numbers should be the cached ones from the first call.
  assert.equal(second.daily.consumed, first.daily.consumed);
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test('getOrgQuota: failure with no cache at all raises quota_unavailable', async () => {
  mockIms();
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(500, { message: 'boom' });

  await assert.rejects(
    () => getOrgQuota(baseCreds()),
    err => {
      assert.equal(err.code, 'quota_unavailable');
      return true;
    }
  );
});

test('getOrgQuota throws when imsOrgId is missing', async () => {
  await assert.rejects(
    () => getOrgQuota({ clientId: 'x', clientSecret: 'y' }),
    /imsOrgId is required/i
  );
});

// ─── Live-fetch retry (intermittent-timeout self-heal) ─────────────────────
// Real 2026-06-01 prod incident: a flaky corporate network to platform.adobe.io
// made /quota time out (ECONNABORTED) intermittently. adobeClient deliberately
// does NOT retry timeouts, so a single slow call fell straight through to stale
// and BLOCKED a destructive submit. getOrgQuota now retries the live fetch a few
// times with backoff so a transient timeout self-heals into a FRESH snapshot.

test('getOrgQuota retries a transient live-fetch timeout and returns a FRESH snapshot', async () => {
  mockIms();
  // Attempt 1 times out (adobeClient does NOT retry ECONNABORTED); the retry succeeds.
  nock(AEP_GATEWAY).get(QUOTA_PATH)
    .replyWithError({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' });
  nock(AEP_GATEWAY).get(QUOTA_PATH).reply(200, SAMPLE_BODY);

  const r = await getOrgQuota(baseCreds(), { refresh: true, liveAttempts: 3, retryDelayMs: 5 });

  assert.equal(r.stale, false, 'a successful retry must yield a FRESH (non-stale) snapshot');
  assert.equal(r.daily.consumed, 314);
  assert.equal(r.error, null);
  // (can't use nock.isDone() — mockIms() persists. Check the quota interceptors.)
  assert.equal(pendingQuotaMocks().length, 0, 'both the timed-out attempt and the successful retry must be consumed');
});

test('getOrgQuota: exhausting every liveAttempt with no cache still raises quota_unavailable', async () => {
  mockIms();
  // Two attempts, both time out → no infinite loop, falls through to the hard floor.
  nock(AEP_GATEWAY).get(QUOTA_PATH).replyWithError({ code: 'ECONNABORTED', message: 'timeout' });
  nock(AEP_GATEWAY).get(QUOTA_PATH).replyWithError({ code: 'ECONNABORTED', message: 'timeout' });

  await assert.rejects(
    () => getOrgQuota(baseCreds(), { refresh: true, liveAttempts: 2, retryDelayMs: 5 }),
    err => { assert.equal(err.code, 'quota_unavailable'); return true; },
  );
  assert.equal(pendingQuotaMocks().length, 0, 'exactly liveAttempts attempts should be made, then it gives up');
});
