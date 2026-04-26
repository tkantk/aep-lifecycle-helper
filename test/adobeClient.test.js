/**
 * Tests for services/adobeClient.js response-interceptor error enrichment.
 *
 * Ensures that 4xx/5xx responses from AEP endpoints surface the Adobe-provided
 * error text (and a permission hint on 403) instead of axios's generic
 * "Request failed with status code NNN" so operators with limited product
 * profiles can self-diagnose.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { createAdobeClient } from '../src/services/adobeClient.js';

const IMS_HOST = 'https://ims-na1.adobelogin.com';
const AEP_HOST = 'https://platform.adobe.io';
const creds = { clientId: 'tc', imsOrgId: 'org@AcmeOrg', clientSecret: 'sec' };

afterEach(() => nock.cleanAll());

function mockAuthOk() {
  nock(IMS_HOST)
    .persist()
    .post('/ims/token/v3')
    .reply(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
}

test('enrichAdobeError: pulls message from { message } shape', async () => {
  mockAuthOk();
  nock(AEP_HOST)
    .get('/data/core/hygiene/workorder?limit=1')
    .reply(403, { error_code: '403013', message: 'Profile lacks Data Hygiene permission' });

  const client = createAdobeClient(creds, 'sandbox-a');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/core/hygiene/workorder?limit=1`),
    (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.match(err.message, /Profile lacks Data Hygiene permission/);
      assert.match(err.message, /Data Hygiene product profile/);  // the hint
      assert.equal(err.response.status, 403);
      return true;
    },
  );
});

test('enrichAdobeError: pulls message from RFC 7807 { detail } shape', async () => {
  mockAuthOk();
  nock(AEP_HOST)
    .get('/data/foundation/sandbox-management/')
    .reply(403, { title: 'Forbidden', detail: 'Not a member of Sandbox Admin group', status: 403 });

  const client = createAdobeClient(creds, null);
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/foundation/sandbox-management/`),
    (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.match(err.message, /Not a member of Sandbox Admin group/);
      assert.match(err.message, /Sandbox Administration/);  // the hint
      return true;
    },
  );
});

test('enrichAdobeError: falls back to error_description (IMS-style)', async () => {
  mockAuthOk();
  nock(AEP_HOST)
    .get('/data/core/idnamespace/identities')
    .reply(400, { error: 'invalid_request', error_description: 'sandbox header is required' });

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/core/idnamespace/identities`),
    (err) => {
      assert.match(err.message, /HTTP 400/);
      assert.match(err.message, /sandbox header is required/);
      // No hint appended for 400s (only 403 gets the product-profile pointer)
      assert.doesNotMatch(err.message, /product profile/);
      return true;
    },
  );
});

test('enrichAdobeError: handles { errors: [...] } array shape', async () => {
  mockAuthOk();
  // Use 404 rather than 5xx so axiosRetry doesn't exhaust the nock mock on retries.
  nock(AEP_HOST)
    .get('/data/foundation/catalog/dataSets')
    .reply(404, { errors: [{ message: 'dataset not found', code: 'DSNF' }] });

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/foundation/catalog/dataSets`),
    (err) => {
      assert.match(err.message, /HTTP 404/);
      assert.match(err.message, /dataset not found/);
      return true;
    },
  );
});

test('enrichAdobeError: plain-string body passes through', async () => {
  mockAuthOk();
  // 404 (non-retried) keeps the nock interceptor intact. The enrichment logic
  // is status-agnostic, so using 404 still exercises the string-body path.
  nock(AEP_HOST)
    .get('/data/core/hygiene/workorder?limit=1')
    .reply(404, 'Endpoint not found');

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/core/hygiene/workorder?limit=1`),
    (err) => {
      assert.match(err.message, /HTTP 404/);
      assert.match(err.message, /Endpoint not found/);
      return true;
    },
  );
});

test('enrichAdobeError: preserves original axios message on err.originalMessage', async () => {
  mockAuthOk();
  nock(AEP_HOST).get('/x').reply(403, { message: 'no access' });

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/x`),
    (err) => {
      assert.match(err.originalMessage, /Request failed with status code 403/);
      return true;
    },
  );
});

test('enrichAdobeError: 403 without known path still gets a generic hint', async () => {
  mockAuthOk();
  nock(AEP_HOST).get('/data/unknown/endpoint').reply(403, { message: 'denied' });

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.get(`${AEP_HOST}/data/unknown/endpoint`),
    (err) => {
      assert.match(err.message, /check the product profile/);
      return true;
    },
  );
});

// ─── Idempotency-aware retries ───────────────────────────────────────────────

test('retry: non-idempotent POST (default) does NOT retry on 5xx', async () => {
  mockAuthOk();
  // Register only ONE 503 response. If the client retries, the second call
  // will miss the mock and surface a "no match" error instead — that's our
  // signal that retry happened.
  let calls = 0;
  nock(AEP_HOST)
    .post('/data/core/hygiene/workorder')
    .reply(() => { calls++; return [503, { message: 'service unavailable' }]; });

  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(
    () => client.post(`${AEP_HOST}/data/core/hygiene/workorder`, { foo: 1 }),
    (err) => {
      assert.match(err.message, /HTTP 503/);
      return true;
    },
  );
  assert.equal(calls, 1, 'hygiene POST must NOT retry on 5xx (single call expected)');
});

test('retry: idempotent POST DOES retry on 5xx and eventually succeeds', async () => {
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .post('/data/core/identity/clusters/members')
    .times(3)
    .reply(() => {
      calls++;
      if (calls < 3) return [503, { message: 'transient' }];
      return [200, { version: '1.1.0', clusters: [] }];
    });

  const client = createAdobeClient(creds, 'sbx');
  const res = await client.post(
    `${AEP_HOST}/data/core/identity/clusters/members`,
    { compositeXids: [] },
    { idempotent: true },
  );
  assert.equal(res.status, 200);
  assert.equal(calls, 3, 'identity-graph POST should retry transient 5xx');
});

test('retry: non-idempotent POST does NOT retry on network error', async () => {
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .post('/data/core/hygiene/workorder')
    .replyWithError({ code: 'ECONNRESET', message: 'socket hang up' })
    .post('/data/core/hygiene/workorder')
    .reply(200, {});

  // axios-retry sees the network error; our guard must block the retry.
  const client = createAdobeClient(creds, 'sbx');
  client.interceptors.request.use((cfg) => { calls++; return cfg; });
  await assert.rejects(
    () => client.post(`${AEP_HOST}/data/core/hygiene/workorder`, {}),
    (err) => {
      assert.match(err.message || '', /socket hang up|ECONNRESET/);
      return true;
    },
  );
  assert.equal(calls, 1, 'non-idempotent POST must not retry on network error');
});

test('retry: GET retries on 5xx (always idempotent)', async () => {
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .get('/data/foundation/sandbox-management/')
    .times(2)
    .reply(() => {
      calls++;
      if (calls < 2) return [503, { message: 'transient' }];
      return [200, { sandboxes: [] }];
    });

  const client = createAdobeClient(creds, 'sbx');
  const res = await client.get(`${AEP_HOST}/data/foundation/sandbox-management/`);
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});
