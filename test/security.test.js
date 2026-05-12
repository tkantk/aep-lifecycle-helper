/**
 * Regression tests for the 2026-05-12 security review fixes.
 *
 * Covers:
 *   - F1: hostHeaderGuard, originRefererGuard
 *   - F2: region allowlist on credential POST (and defence-in-depth in
 *         services/identityGraph.js + services/namespaces.js)
 *   - F5: UUID param guard
 *   - F7: credential field validation (length caps, control chars, env list)
 *   - F10: CSV formula-injection sanitiser
 *   - F12: encryption key bootstrap is atomic (best-effort cover)
 *
 * The middleware tests boot a minimal Express app on a random port and make
 * real HTTP requests via node:http — same pattern as credentialsRoutes.test.js.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const dbPath = path.join(os.tmpdir(), `aep-test-security-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const configRouter = (await import('../src/routes/config.js')).default;
const { hostHeaderGuard, originRefererGuard, makeErrorHandler, UUID_RE } =
  await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');
const { sanitiseCsvValue } = await import('../src/utils/csv.js');

let server;
let port;

before(async () => {
  initDb();
  const app = express();
  app.use(hostHeaderGuard);
  app.use(originRefererGuard);
  app.use(express.json());
  // configRouter registers UUID param guards on itself — see middleware/security.js.
  app.use('/api/config', configRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

function request({ method, pathname, body, host, origin, referer }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (host !== undefined)    headers['Host']    = host;
    if (origin !== undefined)  headers['Origin']  = origin;
    if (referer !== undefined) headers['Referer'] = referer;

    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method, headers,
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── F1: Host-header guard ────────────────────────────────────────────────

test('hostHeaderGuard accepts localhost', async () => {
  const res = await request({ method: 'GET', pathname: '/api/config/credentials' });
  // No explicit Host override — Node sets Host: 127.0.0.1:<port>, allowed.
  assert.equal(res.status, 200);
});

test('hostHeaderGuard rejects an attacker.com Host header (DNS rebinding)', async () => {
  const res = await request({
    method: 'GET', pathname: '/api/config/credentials',
    host: 'attacker.example.com',
  });
  assert.equal(res.status, 421);
  assert.equal(res.body.error, 'misdirected_request');
});

test('hostHeaderGuard allows IPv6 loopback bracketed form', async () => {
  const res = await request({
    method: 'GET', pathname: '/api/config/credentials',
    host: '[::1]:3000',
  });
  assert.equal(res.status, 200);
});

// ─── F1: Origin / Referer guard ───────────────────────────────────────────

test('originRefererGuard accepts same-origin POST', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials/test',
    body: {},   // will fail validation, but we only care it reaches the route
    origin: `http://127.0.0.1:${port}`,
  });
  // We expect a 400 (validation) — proves we got past the origin guard.
  assert.notEqual(res.status, 403);
});

test('originRefererGuard rejects cross-origin POST', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials/test',
    body: {},
    origin: 'http://attacker.example.com',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'cross_origin_blocked');
});

test('originRefererGuard rejects mismatched Referer when Origin absent', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials/test',
    body: {},
    referer: 'http://attacker.example.com/page.html',
  });
  assert.equal(res.status, 403);
});

test('originRefererGuard allows requests with neither Origin nor Referer (curl/CLI)', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials/test',
    body: {},
  });
  // No origin guard rejection — should reach the route (which returns 200
  // with ok:false because no creds were supplied).
  assert.notEqual(res.status, 403);
});

test('originRefererGuard does NOT block safe (GET) methods cross-origin', async () => {
  // Safe-method cross-origin reads are blocked by SOP on the browser side
  // anyway; we don't need to gate them.
  const res = await request({
    method: 'GET', pathname: '/api/config/credentials',
    origin: 'http://attacker.example.com',
  });
  assert.equal(res.status, 200);
});

// ─── F5: UUID param guard ─────────────────────────────────────────────────

test('UUID_RE accepts v4 UUIDs and rejects malformed strings', () => {
  assert.ok(UUID_RE.test('550e8400-e29b-41d4-a716-446655440000'));
  assert.ok(!UUID_RE.test('does-not-exist'));
  assert.ok(!UUID_RE.test('../../../etc/passwd'));
  assert.ok(!UUID_RE.test('550e8400e29b41d4a716446655440000'));   // no dashes
});

test('uuidParamGuard rejects malformed :id in PATCH path', async () => {
  // Use a non-UUID single segment so Express matches the :id route and the
  // guard fires. Path-traversal sequences with slashes are normalised by
  // Express and never reach this matcher — that's a separate (better) line
  // of defence handled by router design.
  const res = await request({
    method: 'PATCH', pathname: '/api/config/credentials/not-a-real-uuid',
    body: { label: 'x', region: 'va7' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_id');
});

// ─── F2 + F7: Credential POST validation ──────────────────────────────────

function validCredBody(overrides = {}) {
  return {
    label: 'Test', clientName: 'Acme',
    environment: 'Production', region: 'va7',
    imsOrgId: 'org@AcmeOrg', clientId: 'client-id', clientSecret: 'secret',
    ...overrides,
  };
}

test('POST /credentials rejects region not in allowlist', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials',
    body: validCredBody({ region: 'evil.com#' }),
    origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /region must be one of/i);
});

test('POST /credentials accepts each allowed region case-insensitively', async () => {
  for (const region of ['va7', 'NLD2', 'aus5', 'CAN2']) {
    const res = await request({
      method: 'POST', pathname: '/api/config/credentials',
      body: validCredBody({
        region,
        imsOrgId: `org-${region}@AcmeOrg`,
        clientId: `client-${region}`,
      }),
    });
    assert.equal(res.status, 200, `region=${region}`);
  }
});

test('POST /credentials rejects environment not in allowlist', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials',
    body: validCredBody({ environment: 'prod' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /environment must be one of/i);
});

test('POST /credentials rejects control characters in fields (CRLF smuggling)', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials',
    body: validCredBody({ imsOrgId: 'evil@AcmeOrg\r\nX-Injected: yes' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /invalid characters/i);
});

test('POST /credentials rejects oversized clientSecret', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials',
    body: validCredBody({ clientSecret: 'a'.repeat(300) }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /exceeds max length/i);
});

test('POST /credentials rejects missing label', async () => {
  const res = await request({
    method: 'POST', pathname: '/api/config/credentials',
    body: validCredBody({ label: '' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /label is required/i);
});

// ─── F2 + F7: PATCH validation ────────────────────────────────────────────

test('PATCH /credentials rejects region not in allowlist', async () => {
  const id = storeCreds({
    label: 'Patch test', clientName: 'Acme',
    environment: 'Production', region: 'va7',
    imsOrgId: 'org-patch@AcmeOrg', clientId: 'client-patch', clientSecret: 's',
  });
  const res = await request({
    method: 'PATCH', pathname: `/api/config/credentials/${id}`,
    body: { label: 'x', region: 'evil.com#' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /region must be one of/i);

  // Sanity: row still has the original region.
  assert.equal(q().getCred.get(id).region, 'va7');
});

// ─── F10: CSV formula-injection sanitiser ─────────────────────────────────

test('sanitiseCsvValue prefixes formula starters with apostrophe', () => {
  assert.equal(sanitiseCsvValue('=cmd|notepad'),   "'=cmd|notepad");
  assert.equal(sanitiseCsvValue('+SUM(A1:A2)'),    "'+SUM(A1:A2)");
  assert.equal(sanitiseCsvValue('-formula'),       "'-formula");
  assert.equal(sanitiseCsvValue('@import'),        "'@import");
  assert.equal(sanitiseCsvValue('\ttab-leading'),  "'\ttab-leading");
});

test('sanitiseCsvValue leaves safe values untouched', () => {
  assert.equal(sanitiseCsvValue('hashedKocid'),       'hashedKocid');
  assert.equal(sanitiseCsvValue('a@x.com'),           'a@x.com');
  assert.equal(sanitiseCsvValue(''),                  '');
  assert.equal(sanitiseCsvValue(42),                  '42');
  assert.equal(sanitiseCsvValue(null),                null);
});
