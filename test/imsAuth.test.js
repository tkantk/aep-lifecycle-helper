/**
 * Tests for services/imsAuth.js — token caching and thundering-herd guard.
 *
 * Uses nock to intercept IMS HTTP calls without touching real Adobe endpoints.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { getAccessToken, invalidateToken } from '../src/services/imsAuth.js';

const IMS_HOST = 'https://ims-na1.adobelogin.com';
const creds = { clientId: 'test-client', imsOrgId: 'test-org@AcmeOrg', clientSecret: 'test-secret' };

afterEach(() => {
  nock.cleanAll();
  invalidateToken(creds);
});

function mockIms(token = 'test-token', expiresIn = 86400) {
  return nock(IMS_HOST)
    .post('/ims/token/v3')
    .reply(200, { access_token: token, token_type: 'bearer', expires_in: expiresIn });
}

// ─── Basic token fetch ────────────────────────────────────────────────────────

test('getAccessToken: fetches token from IMS on first call', async () => {
  mockIms('first-token');
  const token = await getAccessToken(creds);
  assert.equal(token, 'first-token');
});

test('getAccessToken: returns cached token on subsequent calls (no extra IMS request)', async () => {
  mockIms('cached-token');

  const t1 = await getAccessToken(creds);
  const t2 = await getAccessToken(creds);

  assert.equal(t1, 'cached-token');
  assert.equal(t2, 'cached-token');
  assert.ok(nock.isDone(), 'IMS should only be called once');
});

// ─── Cache invalidation ───────────────────────────────────────────────────────

test('invalidateToken: forces a fresh IMS call on next getAccessToken', async () => {
  mockIms('original-token');
  await getAccessToken(creds);

  invalidateToken(creds);
  mockIms('fresh-token');
  const token = await getAccessToken(creds);

  assert.equal(token, 'fresh-token');
  assert.ok(nock.isDone());
});

// ─── Thundering-herd coalescing ───────────────────────────────────────────────

test('getAccessToken: multiple concurrent calls share one in-flight request', async () => {
  // nock configured with .once() — if IMS were called more than once this would throw
  nock(IMS_HOST)
    .post('/ims/token/v3')
    .once()
    .reply(200, { access_token: 'shared-token', expires_in: 86400 });

  const [t1, t2, t3] = await Promise.all([
    getAccessToken(creds),
    getAccessToken(creds),
    getAccessToken(creds),
  ]);

  assert.equal(t1, 'shared-token');
  assert.equal(t2, 'shared-token');
  assert.equal(t3, 'shared-token');
  assert.ok(nock.isDone(), 'IMS must be called exactly once for all three concurrent callers');
});

// ─── Error handling ───────────────────────────────────────────────────────────

test('getAccessToken: rejects when IMS returns an error', async () => {
  nock(IMS_HOST)
    .post('/ims/token/v3')
    .reply(401, { error: 'invalid_client', error_description: 'Bad credentials' });

  await assert.rejects(() => getAccessToken(creds), /Request failed with status code 401/);
});

test('getAccessToken: cache is cleared after an IMS failure so next call retries', async () => {
  nock(IMS_HOST).post('/ims/token/v3').reply(500, 'Internal Error');

  await assert.rejects(() => getAccessToken(creds));

  // After a failure, inflight entry is cleared; a fresh call should hit IMS again
  mockIms('recovery-token');
  const token = await getAccessToken(creds);
  assert.equal(token, 'recovery-token');
});

test('getAccessToken: throws when IMS omits access_token field', async () => {
  nock(IMS_HOST)
    .post('/ims/token/v3')
    .reply(200, { token_type: 'bearer', expires_in: 86400 });   // no access_token

  await assert.rejects(() => getAccessToken(creds), /no access_token/i);
});
