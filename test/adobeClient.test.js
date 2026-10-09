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

test('retry: an Identity Graph lookup that times out is retried, each attempt with the full timeout (2026-10-09)', async () => {
  // One slow Adobe reply used to fail the whole expansion: axios-retry skips
  // timeouts (ECONNABORTED), and without shouldResetTimeout a retry would only
  // get the time left over (none).
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .post('/data/core/identity/clusters/members').delay(700)
    .reply(() => { calls++; return [200, { version: '1.1.0', clusters: [] }]; })
    .post('/data/core/identity/clusters/members').delay(150)    // fits a FRESH 400 ms, not the remainder
    .reply(() => { calls++; return [200, { version: '1.1.0', clusters: [] }]; });
  const client = createAdobeClient(creds, 'sbx');
  const res = await client.post(`${AEP_HOST}/data/core/identity/clusters/members`, { compositeXids: [] },
    { idempotent: true, timeout: 400, retryOnTimeout: true, 'axios-retry': { shouldResetTimeout: true } });   // as identityGraph sends it
  assert.equal(res.status, 200);
  assert.equal(calls, 2, 'the timed-out lookup was asked again');
});

test('retry: a work-order POST that times out is NOT retried — Adobe may have received it', async () => {
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .post('/data/core/hygiene/workorder').delay(700).reply(() => { calls++; return [200, {}]; })
    .post('/data/core/hygiene/workorder').reply(() => { calls++; return [200, {}]; });
  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(() => client.post(`${AEP_HOST}/data/core/hygiene/workorder`, {}, { timeout: 400 }), /timeout/);
  await new Promise(r => setTimeout(r, 900));       // a retry, if any, would have been sent by now
  assert.equal(calls, 1, 'never resend a deletion request after a timeout');
});

test('retry: other read-only calls that time out still fail fast (Monitor and quota checks rely on it)', async () => {
  // Only Identity Graph lookups opt in to timeout retries (retryOnTimeout). A
  // retried GET would stretch the Monitor tick's 15 s budget and the submit
  // quota check — both are meant to fail fast and try again later.
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .get('/data/core/hygiene/workorder/WO-1').delay(700).reply(() => { calls++; return [200, {}]; })
    .get('/data/core/hygiene/workorder/WO-1').reply(() => { calls++; return [200, {}]; });
  const client = createAdobeClient(creds, 'sbx');
  await assert.rejects(() => client.get(`${AEP_HOST}/data/core/hygiene/workorder/WO-1`, { timeout: 400 }), /timeout/);
  await new Promise(r => setTimeout(r, 900));
  assert.equal(calls, 1, 'a GET that timed out is not retried');
});

test('retry: an operating-system ETIMEDOUT on a GET is retried as a network error (final review #1)', async () => {
  // axios's own timeouts are ECONNABORTED; ETIMEDOUT only comes from the OS (a
  // TCP connect timeout or a dropped connection) and master retried it on GETs.
  mockAuthOk();
  let calls = 0;
  nock(AEP_HOST)
    .get('/data/core/idnamespace/identities').replyWithError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 1.2.3.4:443' })
    .get('/data/core/idnamespace/identities').reply(() => { calls++; return [200, []]; });
  const client = createAdobeClient(creds, 'sbx');
  client.interceptors.request.use((cfg) => { calls++; return cfg; });
  const res = await client.get(`${AEP_HOST}/data/core/idnamespace/identities`);
  assert.equal(res.status, 200);
  assert.equal(calls, 3, 'one failed attempt, then a retry that succeeded');
});

test('a sign-in (IMS) failure never resolves the request with the sign-in reply — it fails as "not sent" (final review #8)', async () => {
  // The token fetch's AxiosError carries the IMS request's config, so axios-retry
  // "retried" the IMS call through this client and the work-order POST resolved
  // with { access_token } — recorded as submitted though it was never sent.
  const fresh = { clientId: 'c429-test', imsOrgId: 'o429@AcmeOrg', clientSecret: 's' };
  let imsCalls = 0, woCalls = 0;
  nock(IMS_HOST).post('/ims/token/v3').reply(() => { imsCalls++; return [429, { error: 'too_many_requests' }]; });
  nock(IMS_HOST).persist().post('/ims/token/v3').reply(() => { imsCalls++; return [200, { access_token: 'tok', expires_in: 3600 }]; });
  nock(AEP_HOST).persist().post('/data/core/hygiene/workorder').reply(() => { woCalls++; return [201, { workorderId: 'DI-1' }]; });
  const client = createAdobeClient(fresh, 'sbx');
  await assert.rejects(() => client.post(`${AEP_HOST}/data/core/hygiene/workorder`, { displayName: 'x' }), (err) => {
    assert.equal(err.code, 'IMS_TOKEN_FAILED');
    assert.equal(err.notSent, true);
    assert.match(err.message, /not sent/);
    return true;
  });
  assert.deepEqual([imsCalls, woCalls], [1, 0], 'no IMS call is "retried" through the Adobe client; nothing was sent');
});

test('a 401 retry carries the fresh token, not the stale one (final review #7)', async () => {
  const fresh = { clientId: 'c401-test', imsOrgId: 'o401@AcmeOrg', clientSecret: 's' };
  let n = 0;
  nock(IMS_HOST).persist().post('/ims/token/v3').reply(() => [200, { access_token: `tok${++n}`, expires_in: 3600 }]);
  const seen = [];
  nock(AEP_HOST)
    .get('/data/foundation/sandbox-management/').reply(function () { seen.push(this.req.headers.authorization); return [401, { message: 'expired' }]; })
    .get('/data/foundation/sandbox-management/').reply(function () { seen.push(this.req.headers.authorization); return [200, { sandboxes: [] }]; });
  const client = createAdobeClient(fresh, null);
  const res = await client.get(`${AEP_HOST}/data/foundation/sandbox-management/`);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['Bearer tok1', 'Bearer tok2'], 'the retry used the token fetched after the 401');
});

// A real local server: nock can't cut a reply off mid-body.
async function cutOffServer(mode) {
  const http = await import('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    if (hits === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' });
      res.write('{"version":"1.1.0","clus');
      setTimeout(() => (mode === 'close' ? res.socket.end() : res.socket.destroy()), 30);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1.1.0', clusters: [] }));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/data/core/identity/clusters/members`, hits: () => hits, close: () => server.close() };
}

test('a lookup whose 2xx reply breaks off mid-body is retried (final review #4)', async () => {
  for (const mode of ['close', 'destroy']) {
    mockAuthOk();
    const srv = await cutOffServer(mode);
    try {
      const client = createAdobeClient({ clientId: `cut-${mode}`, imsOrgId: 'cut@AcmeOrg', clientSecret: 's' }, 'sbx');
      const res = await client.post(srv.url, { compositeXids: [] },
        { idempotent: true, retryOnTimeout: true, 'axios-retry': { shouldResetTimeout: true } });
      assert.equal(res.status, 200, mode);
      assert.equal(srv.hits(), 2, `${mode}: asked again after the cut-off`);
    } finally { srv.close(); }
  }
});

test('a work-order POST whose 2xx reply breaks off is NOT resent, and its error never reads "HTTP 200 OK"', async () => {
  mockAuthOk();
  const srv = await cutOffServer('close');
  try {
    const client = createAdobeClient({ clientId: 'cut-wo', imsOrgId: 'cut@AcmeOrg', clientSecret: 's' }, 'sbx');
    await assert.rejects(() => client.post(srv.url, { displayName: 'x' }), (err) => {
      assert.doesNotMatch(err.message, /HTTP 200/);
      return true;
    });
    assert.equal(srv.hits(), 1, 'Adobe answered 2xx — the request was received; never send it twice');
  } finally { srv.close(); }
});
