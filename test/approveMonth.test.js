/**
 * Tests for POST /api/jobs/:id/approve-month
 *
 * Boots a minimal Express app with the jobs router and exercises the
 * approve-month route. Uses a temp SQLite DB for isolation.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-approve-month-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

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

// ─── Tiny HTTP helper ─────────────────────────────────────────────────────────

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

// ─── Seed helpers ─────────────────────────────────────────────────────────────

let seq = 0;

function seedCred() {
  seq++;
  const id = uuid();
  q().insertCred.run({
    id,
    label: `Test Cred ${seq}`,
    clientName: null,
    environment: 'Production',
    region: 'va7',
    imsOrgId: `org-${seq}@AcmeOrg`,
    clientId: `client-${seq}`,
    enc: Buffer.from('fake-encrypted-secret'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  });
  return id;
}

function seedJob(overrides = {}) {
  seq++;
  const jobId = uuid();
  const credsId = seedCred();
  q().insertJob.run({
    id: jobId,
    name: `Approve Month Test Job ${seq}`,
    credsId,
    sandboxName: 'test-sandbox',
    datasetIds: 'ALL',
    targetServicesJson: null,
    sourceNamespace: 'hashedKocid',
    sourceNamespaceId: null,
    dailyLimit: 1_000_000,
    monthlyLimit: null,
    uploadPath: null,
    totalSourceIds: 0,
    ...overrides,
  });
  return jobId;
}

function seedWorkOrder(jobId, { status = 'planned', monthIndex = 1, dayIndex = 1 } = {}) {
  const woId = uuid();
  q().insertWorkOrder.run({
    id: woId,
    jobId,
    dayIndex,
    datasetIds: 'ALL',
    targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 1,
    status,
  });
  // Set month_index via the setOrderMonthDay statement
  q().setOrderMonthDay.run(monthIndex, dayIndex, woId);
  return woId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('approve-month: 200 — approves Month 2, returns ok + approved count', async () => {
  const jobId = seedJob();
  // Month 1 — planned (already eligible)
  seedWorkOrder(jobId, { status: 'planned', monthIndex: 1, dayIndex: 1 });
  // Month 2 — awaiting_approval
  const wo2a = seedWorkOrder(jobId, { status: 'awaiting_approval', monthIndex: 2, dayIndex: 1 });
  const wo2b = seedWorkOrder(jobId, { status: 'awaiting_approval', monthIndex: 2, dayIndex: 1 });

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.monthIndex, 2);
  assert.equal(res.body.approved, 2);

  // Verify the DB rows flipped to 'planned'
  const row2a = q().getAllOrdersForJob.all(jobId).find(r => r.id === wo2a);
  const row2b = q().getAllOrdersForJob.all(jobId).find(r => r.id === wo2b);
  assert.equal(row2a.status, 'planned');
  assert.equal(row2b.status, 'planned');
  assert.equal(row2a.last_error, null);
});

test('approve-month: 200 — only flips awaiting_approval, leaves other statuses unchanged', async () => {
  const jobId = seedJob();
  // Month 3: one awaiting_approval + one already-planned (e.g. already approved)
  const woWaiting = seedWorkOrder(jobId, { status: 'awaiting_approval', monthIndex: 3, dayIndex: 1 });
  const woPlanned = seedWorkOrder(jobId, { status: 'planned', monthIndex: 3, dayIndex: 1 });

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 3 });

  assert.equal(res.status, 200);
  assert.equal(res.body.approved, 1);  // only the awaiting_approval one changed

  const orders = q().getAllOrdersForJob.all(jobId);
  const waiting = orders.find(r => r.id === woWaiting);
  const planned = orders.find(r => r.id === woPlanned);
  assert.equal(waiting.status, 'planned');
  assert.equal(planned.status, 'planned');  // unchanged
});

test('approve-month: 400 — monthIndex = 1 is rejected (Month 1 never needs approval)', async () => {
  const jobId = seedJob();

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 1 });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /≥ 2/);
});

test('approve-month: 400 — monthIndex = 0 is rejected', async () => {
  const jobId = seedJob();

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 0 });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /≥ 2/);
});

test('approve-month: 400 — non-integer monthIndex is rejected', async () => {
  const jobId = seedJob();

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 2.5 });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /integer/i);
});

test('approve-month: 400 — missing monthIndex is rejected', async () => {
  const jobId = seedJob();

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, {});

  assert.equal(res.status, 400);
});

test('approve-month: 404 — no WOs awaiting approval for that month', async () => {
  const jobId = seedJob();
  // Month 2 has a planned WO but NOT awaiting_approval
  seedWorkOrder(jobId, { status: 'planned', monthIndex: 2, dayIndex: 1 });

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 2 });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /No work orders awaiting approval/i);
});

test('approve-month: 404 — job not found', async () => {
  // Use a valid UUID that does not exist in the DB
  const fakeJobId = '00000000-0000-0000-0000-000000000000';

  const res = await request('POST', `/api/jobs/${fakeJobId}/approve-month`, { monthIndex: 2 });

  assert.equal(res.status, 404);
  assert.match(res.body.message, /not found/i);
});

test('approve-month: does NOT touch submitted/completed/failed WOs', async () => {
  const jobId = seedJob();
  // Month 2 has only a submitted WO (already shipped — must not be touched)
  const woSubmitted = seedWorkOrder(jobId, { status: 'awaiting_approval', monthIndex: 2, dayIndex: 1 });
  // Manually mark it as submitted
  q().updateWorkOrderStatus.run('submitted', null, woSubmitted);

  const res = await request('POST', `/api/jobs/${jobId}/approve-month`, { monthIndex: 2 });

  assert.equal(res.status, 404);  // no awaiting_approval rows to flip

  const row = q().getAllOrdersForJob.all(jobId).find(r => r.id === woSubmitted);
  assert.equal(row.status, 'submitted');  // unchanged
});
