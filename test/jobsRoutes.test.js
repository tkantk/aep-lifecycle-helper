/**
 * Integration tests for DELETE /api/jobs/:id.
 *
 * Boots a minimal Express app with the jobs router on a random port and
 * makes real HTTP requests via Node's built-in http module. Same pattern
 * as test/credentialsRoutes.test.js — no supertest dependency.
 *
 * Coverage:
 *   - 404 when job doesn't exist
 *   - 409 when work orders are in flight to Adobe (no force flag)
 *   - 200 + cascade delete when no in-flight WOs
 *   - 200 + force-delete when in-flight WOs and ?force=true
 *   - Cascade actually removes expanded_identities + work_orders
 *   - Uploaded CSV file is unlinked on delete
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-jobs-routes-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `aep-test-jobs-uploads-${Date.now()}`);
process.env.OUTPUT_DIR = path.join(os.tmpdir(), `aep-test-jobs-output-${Date.now()}`);
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });
fs.mkdirSync(process.env.OUTPUT_DIR, { recursive: true });

const { initDb, q } = await import('../src/db.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server;
let baseUrl;

before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
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

// ─── Fetch-like helper ────────────────────────────────────────────────────────

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(baseUrl + pathname);
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + (url.search || ''),
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

let credSeq = 0;
function insertCred() {
  credSeq++;
  const id = uuid();
  q().insertCred.run({
    id,
    label: 'Test',
    clientName: null,
    environment: 'prod',
    region: 'VA7',
    imsOrgId: `org-${credSeq}@AcmeOrg`,
    clientId: `client-${credSeq}`,
    enc: Buffer.from('fake'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  });
  return id;
}

function insertJob({ uploadPath } = {}) {
  const jobId = uuid();
  q().insertJob.run({
    id: jobId,
    name: `Test Job ${jobId.slice(0, 8)}`,
    credsId: insertCred(),
    sandboxName: 'test-sandbox',
    datasetIds: 'ALL',
    targetServicesJson: null,
    sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null,
    dailyLimit: 1_000_000,
    monthlyLimit: null,
    uploadPath: uploadPath || null,
    totalSourceIds: 0,
  });
  return jobId;
}

function insertWorkOrder(jobId, status, dayIndex = 1) {
  const id = uuid();
  q().insertWorkOrder.run({
    id, jobId, dayIndex, datasetIds: 'ALL',
    targetServicesJson: null,
    namespacesIdentities: '[]',
    identifierCount: 1,
    status,
  });
  return id;
}

function insertIdentity(jobId) {
  q().insertIdentity.run(jobId, 'email', 6, `id-${Math.random()}`, `src-${Math.random()}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('DELETE /api/jobs/:id returns 404 when job not found', async () => {
  const res = await request('DELETE', `/api/jobs/${uuid()}`);
  assert.equal(res.status, 404);
  // makeErrorHandler returns the route-set `err.code` as response `error`.
  assert.equal(res.body.error, 'not_found');
});

test('DELETE /api/jobs/:id rejects malformed UUID with 400', async () => {
  const res = await request('DELETE', '/api/jobs/not-a-uuid');
  assert.equal(res.status, 400);
});

test('DELETE /api/jobs/:id deletes job with no work orders', async () => {
  const jobId = insertJob();
  insertIdentity(jobId);
  insertIdentity(jobId);

  const before = q().getJob.get(jobId);
  assert.ok(before, 'job exists before delete');

  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.deleted, jobId);

  // Job row gone
  assert.equal(q().getJob.get(jobId), undefined);
  // Cascaded identities gone too
  assert.equal(q().countDistinctIdentities.get(jobId).n, 0);
});

test('DELETE /api/jobs/:id cascades through work_orders + expanded_identities', async () => {
  const jobId = insertJob();
  insertWorkOrder(jobId, 'planned');
  insertWorkOrder(jobId, 'planned');
  insertWorkOrder(jobId, 'completed');
  for (let i = 0; i < 5; i++) insertIdentity(jobId);

  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.workOrdersRemoved, 3);

  assert.equal(q().getAllOrdersForJob.all(jobId).length, 0);
  assert.equal(q().countDistinctIdentities.get(jobId).n, 0);
});

test('DELETE /api/jobs/:id returns 409 when work orders are in flight to Adobe', async () => {
  const jobId = insertJob();
  insertWorkOrder(jobId, 'planned');     // safe (never shipped)
  insertWorkOrder(jobId, 'submitting');  // in flight — should block
  insertWorkOrder(jobId, 'completed');   // terminal

  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'in_flight');
  assert.match(res.body.message, /in flight to Adobe/i);

  // Job still exists — the 409 must NOT have deleted anything.
  assert.ok(q().getJob.get(jobId));
});

test('DELETE /api/jobs/:id?force=true deletes anyway when WOs are in flight', async () => {
  const jobId = insertJob();
  insertWorkOrder(jobId, 'planned');
  insertWorkOrder(jobId, 'submitted');   // in flight

  const res = await request('DELETE', `/api/jobs/${jobId}?force=true`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.inFlightWorkOrdersOrphaned, 1);

  assert.equal(q().getJob.get(jobId), undefined);
});

test('DELETE /api/jobs/:id treats planned/deferred/awaiting_approval/completed/failed as safe', async () => {
  const jobId = insertJob();
  insertWorkOrder(jobId, 'planned');
  insertWorkOrder(jobId, 'deferred');
  insertWorkOrder(jobId, 'awaiting_approval');
  insertWorkOrder(jobId, 'completed');
  insertWorkOrder(jobId, 'failed');

  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);   // none of these are "in flight to Adobe"
});

test('DELETE /api/jobs/:id unlinks the uploaded CSV', async () => {
  const uploadPath = path.join(process.env.UPLOAD_DIR, `upload-${Date.now()}.csv`);
  fs.writeFileSync(uploadPath, 'hashedKocid\nabc\ndef\n');
  assert.ok(fs.existsSync(uploadPath), 'upload exists before delete');

  const jobId = insertJob({ uploadPath });
  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(uploadPath), false, 'upload was unlinked');
});

test('DELETE /api/jobs/:id is OK when uploaded CSV is already missing', async () => {
  // Simulate a previously-deleted-from-disk upload — the DB still has the
  // path, but the file is gone. Delete should still succeed (cleanup
  // failures are non-fatal).
  const uploadPath = path.join(process.env.UPLOAD_DIR, `missing-${Date.now()}.csv`);
  // Do NOT create the file.
  const jobId = insertJob({ uploadPath });
  const res = await request('DELETE', `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);
});
