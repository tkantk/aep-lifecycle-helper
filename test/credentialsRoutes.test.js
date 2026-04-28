/**
 * Integration tests for the credentials routes:
 *   - PATCH /api/config/credentials/:id  (Option B's persistence path)
 *   - DELETE /api/config/credentials/:id (job-attached 409 protection)
 *
 * Boots a minimal Express app with just the config router on a random
 * port and makes real HTTP requests via Node's built-in http module
 * (no supertest dependency needed).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';

const dbPath = path.join(os.tmpdir(), `aep-test-cred-routes-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const configRouter = (await import('../src/routes/config.js')).default;

let server;
let baseUrl;

before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── Tiny fetch-like helper (no external deps) ────────────────────────────────

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(baseUrl + pathname);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function seedCred(overrides = {}) {
  seq++;
  return storeCreds({
    label: `Test ${seq}`,
    clientName: 'Acme',
    environment: 'Production',
    region: 'va7',
    imsOrgId: `org-${seq}@AcmeOrg`,
    clientId: `client-${seq}`,
    clientSecret: 'super-secret',
    ...overrides,
  });
}

function seedJobReferencing(credsId) {
  seq++;
  const jobId = `job-${seq}`;
  q().insertJob.run({
    id: jobId, name: `Job ${seq}`, credsId,
    sandboxName: 'sbx', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: null, totalSourceIds: 0,
  });
  return jobId;
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

test('PATCH /credentials/:id updates label, client_name, and region', async () => {
  const id = seedCred({ label: 'Original', clientName: 'Old Co', region: 'va7' });

  const res = await request('PATCH', `/api/config/credentials/${id}`, {
    label: 'Renamed', clientName: 'New Co', region: 'nld2',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const row = q().getCred.get(id);
  assert.equal(row.label, 'Renamed');
  assert.equal(row.client_name, 'New Co');
  assert.equal(row.region, 'nld2');
});

test('PATCH never overwrites the encrypted client secret', async () => {
  const id = seedCred();
  const before = q().getCred.get(id);

  await request('PATCH', `/api/config/credentials/${id}`, {
    label: 'just renaming', clientName: null, region: 'va7',
  });

  const after = q().getCred.get(id);
  // Buffers compare by content — assert all three secret-related columns
  // are byte-for-byte identical to before the PATCH.
  assert.deepEqual(after.client_secret_enc, before.client_secret_enc);
  assert.deepEqual(after.client_secret_iv,  before.client_secret_iv);
  assert.deepEqual(after.client_secret_tag, before.client_secret_tag);
});

test('PATCH on a non-existent id returns 404', async () => {
  const res = await request('PATCH', '/api/config/credentials/does-not-exist', {
    label: 'Anything', clientName: null, region: 'va7',
  });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
});

test('PATCH with missing label returns 400', async () => {
  const id = seedCred();
  const res = await request('PATCH', `/api/config/credentials/${id}`, {
    clientName: 'Whatever', region: 'va7',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /label/i);
});

test('PATCH does not change identity fields (env, ims_org, client_id)', async () => {
  // Even if the body sneaks in identity fields, the route must not propagate
  // them — those are the unique-key columns and changing them would silently
  // route to a different credential row.
  const id = seedCred({ environment: 'Production', imsOrgId: 'keep-me@AcmeOrg' });
  const before = q().getCred.get(id);

  await request('PATCH', `/api/config/credentials/${id}`, {
    label: 'Renamed',
    clientName: 'New',
    region: 'va7',
    // The route ignores these keys; included here to lock the contract.
    environment: 'Stage',
    imsOrgId: 'sneaky@OtherOrg',
    clientId: 'sneaky-client',
  });

  const after = q().getCred.get(id);
  assert.equal(after.environment, before.environment);
  assert.equal(after.ims_org_id,   before.ims_org_id);
  assert.equal(after.client_id,    before.client_id);
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

test('DELETE /credentials/:id removes the credential when no jobs reference it', async () => {
  const id = seedCred();

  const res = await request('DELETE', `/api/config/credentials/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  assert.equal(q().getCred.get(id), undefined);
});

test('DELETE returns 409 when one or more jobs reference the credential', async () => {
  const id = seedCred();
  seedJobReferencing(id);
  seedJobReferencing(id);

  const res = await request('DELETE', `/api/config/credentials/${id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'credential_in_use');
  assert.equal(res.body.jobCount, 2);
  assert.match(res.body.message, /Cannot delete/);

  // The credential MUST still exist after the rejected delete.
  assert.ok(q().getCred.get(id), 'credential should still exist');
});
