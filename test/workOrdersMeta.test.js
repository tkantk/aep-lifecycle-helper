/**
 * Scale fix (2026-10-06 review, fix 6): list / poll paths must not read or
 * parse each work order's full identity list.
 *
 * At 6.8M source profiles a job has ~260 work orders and ~1.57 GB of
 * `namespaces_identities` JSON. GET /api/jobs/:id/work-orders (polled every 2 s
 * by the Submit tab) used to SELECT * and JSON.parse all of it — measured
 * 1.4–1.6 s of blocked event loop per call. The per-namespace counts it needs
 * are now stored once at plan time in `work_orders.ns_summary_json`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-wo-meta-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { planWorkOrders } = await import('../src/runner/submission.js');
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
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + pathname, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

let seq = 0;
function insertJob(status = 'expanded') {
  seq++;
  const credsId = uuid();
  q().insertCred.run({
    id: credsId, label: 'T', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `meta-org-${seq}@AdobeOrg`, clientId: `meta-client-${seq}`,
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });
  const jobId = uuid();
  q().insertJob.run({
    id: jobId, name: `Meta ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run(status, null, jobId);
  return jobId;
}

test('planner stores a per-namespace summary on every work order', () => {
  const jobId = insertJob();
  bulkInsertIdentities([
    [jobId, 'hashedKocid', 5000, 'k1', 'k1'],
    [jobId, 'email', 6, 'a@x.com', 'k1'],
    [jobId, 'email', 6, 'b@x.com', 'k1'],
    [jobId, null, 77, 'custom-1', 'k1'],
  ]);
  planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null });

  const [wo] = q().getAllOrdersForJob.all(jobId);
  assert.ok(wo.ns_summary_json, 'ns_summary_json must be written at plan time');
  const summary = JSON.parse(wo.ns_summary_json);
  const byKey = Object.fromEntries(summary.map(s => [s.code || `nsid:${s.id}`, s]));
  assert.deepEqual(byKey.email, { code: 'email', id: 6, count: 2 });
  assert.deepEqual(byKey.hashedKocid, { code: 'hashedKocid', id: 5000, count: 1 });
  assert.deepEqual(byKey['nsid:77'], { code: null, id: 77, count: 1 });
});

test('GET /work-orders serves counts from the summary, never parsing the identity list', async () => {
  const jobId = insertJob('ready');
  const woId = uuid();
  q().insertWorkOrder.run({
    id: woId, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    // Deliberately NOT valid JSON: if the route still parsed the payload it would 500.
    namespacesIdentities: '{{not json — the route must not touch this column',
    identifierCount: 3, status: 'planned',
  });
  q().setWorkOrderNsSummary.run(JSON.stringify([{ code: 'email', id: 6, count: 3 }]), woId);

  const res = await get(`/api/jobs/${jobId}/work-orders`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.deepEqual(res.body[0].namespaces, [{ code: 'email', id: 6, count: 3 }]);
  assert.equal('namespaces_identities' in res.body[0], false, 'identity list must never be sent to the UI');
  assert.equal('ns_summary_json' in res.body[0], false, 'raw summary column is an internal detail');
});

test('GET /work-orders back-fills the summary once for a legacy row planned before the column existed', async () => {
  const jobId = insertJob('ready');
  const woId = uuid();
  q().insertWorkOrder.run({
    id: woId, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([
      { namespace: { code: 'email', id: 6 }, ids: ['a@x.com', 'b@x.com'] },
      { namespace: { id: 77 }, ids: ['c1'] },
    ]),
    identifierCount: 3, status: 'planned',
  });
  assert.equal(q().getWorkOrderByIdAndJob.get(woId, jobId).ns_summary_json, null);

  const res = await get(`/api/jobs/${jobId}/work-orders`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body[0].namespaces, [
    { code: 'email', id: 6, count: 2 },
    { code: null, id: 77, count: 1 },
  ]);
  const stored = JSON.parse(q().getWorkOrderByIdAndJob.get(woId, jobId).ns_summary_json);
  assert.deepEqual(stored, res.body[0].namespaces, 'summary persisted so the next poll skips the parse');
});

test('metadata queries never return the identity list; payload is fetched per work order', () => {
  const jobId = insertJob('ready');
  const woId = uuid();
  const payload = JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['z@x.com'] }]);
  q().insertWorkOrder.run({
    id: woId, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: payload, identifierCount: 1, status: 'planned',
  });
  q().updateWorkOrderSubmitted.run({ id: woId, adobeWorkorderId: 'DI-meta', adobeStatus: 'received', bundleId: null, submittedAt: null });

  for (const row of [
    ...q().listWorkOrderMetaForJob.all(jobId),
    ...q().listOpenWorkOrders.all().filter(r => r.id === woId),
  ]) {
    assert.equal('namespaces_identities' in row, false, 'metadata rows must not carry the identity list');
  }
  const open = q().listOpenWorkOrders.all().find(r => r.id === woId);
  assert.ok(open, 'monitor still sees the open work order');
  assert.equal(open.adobe_workorder_id, 'DI-meta');
  assert.ok(open.j_creds_id && open.j_sandbox_name, 'monitor still gets creds + sandbox');
  assert.equal(q().getWorkOrderPayload.get(woId).namespaces_identities, payload);
});

test('metadata list keeps the (month, day, insertion) order the UI groups by', () => {
  const jobId = insertJob('ready');
  const ids = [uuid(), uuid(), uuid()];
  for (const id of ids) {
    q().insertWorkOrder.run({ id, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
      namespacesIdentities: '[]', identifierCount: 1, status: 'planned' });
  }
  q().setOrderMonthDay.run(2, 1, ids[0]);
  q().setOrderMonthDay.run(1, 2, ids[1]);
  q().setOrderMonthDay.run(1, 1, ids[2]);
  assert.deepEqual(q().listWorkOrderMetaForJob.all(jobId).map(r => r.id), [ids[2], ids[1], ids[0]]);
  db.prepare('DELETE FROM work_orders WHERE job_id = ?').run(jobId);
});
