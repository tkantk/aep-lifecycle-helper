/**
 * Plan scope (2026-10-06): delete the uploaded IDs + all linked identities
 * (default, unchanged) or ONLY the uploaded IDs. Expansion-off jobs can only be
 * planned IDs-only. The scope is recorded on the job and can change only by a
 * re-plan, which stays forbidden once anything has shipped.
 */
process.env.MAX_IDS_PER_WORK_ORDER = '10';     // small orders so packing is visible

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-plan-scope-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { planWorkOrders, PlanScopeError, ReplanForbiddenError } = await import('../src/runner/submission.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server, baseUrl;
before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
});

let seq = 0;
function job({ mode = 'cluster', nsid = 5000, sources = 3, linked = true } = {}) {
  seq++;
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'S', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `scope-${seq}@AdobeOrg`, clientId: `scope-${seq}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `Scope ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: nsid,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: sources });
  q().setJobExpansionMode.run(mode, jobId);
  const rows = [];
  for (let i = 1; i <= sources; i++) {
    const s = `k${String(i).padStart(3, '0')}`;
    rows.push([jobId, 'hashedKocid', nsid, s, s]);
    if (linked && mode === 'cluster') rows.push([jobId, 'email', 6, `${s}@x.com`, s]);
  }
  bulkInsertIdentities(rows);
  q().updateJobStatus.run('expanded', null, jobId);
  return jobId;
}
const plan = (jobId, scope) => planWorkOrders({ jobId, datasetIds: 'ALL', dailyLimit: 1_000_000, targetServices: null, scope });
const payloads = (jobId) => q().getAllOrdersForJob.all(jobId).map(w => JSON.parse(w.namespaces_identities));

test('default scope for an expansion-on job is unchanged: uploaded + linked identities', () => {
  const jobId = job();
  const r = plan(jobId);
  assert.equal(r.scope, 'cluster');
  assert.equal(q().getJob.get(jobId).delete_scope, 'cluster');
  const codes = new Set(payloads(jobId).flat().map(g => g.namespace.code));
  assert.deepEqual([...codes].sort(), ['email', 'hashedKocid']);
});

test('"uploaded IDs only" plans exactly the distinct uploaded IDs, in the source namespace', () => {
  const jobId = job({ sources: 25 });
  const r = plan(jobId, 'source_only');
  assert.equal(r.scope, 'source_only');
  assert.equal(q().getJob.get(jobId).delete_scope, 'source_only');
  const groups = payloads(jobId);
  assert.deepEqual(groups.map(g => g.length), [1, 1, 1], 'one namespace group per order');
  for (const [g] of groups) assert.deepEqual(g.namespace, { code: 'hashedKocid', id: 5000 });
  const ids = groups.flatMap(([g]) => g.ids);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.ok(ids.every(v => /^k\d{3}$/.test(v)), 'no linked identity is ever included');
  assert.deepEqual(q().getAllOrdersForJob.all(jobId).map(w => w.identifier_count), [10, 10, 5]);
});

test('an expansion-off job defaults to IDs only and refuses the cluster scope', () => {
  const jobId = job({ mode: 'none' });
  assert.throws(() => plan(jobId, 'cluster'),
    (e) => e instanceof PlanScopeError && e.status === 409 && e.code === 'scope_unavailable');
  assert.equal(q().countWorkOrdersByStatus.all(jobId).length, 0);
  assert.equal(plan(jobId).scope, 'source_only');
});

test('legacy job without a stored nsid: IDs-only orders carry the namespace code only', () => {
  const jobId = job({ nsid: null, sources: 2 });
  plan(jobId, 'source_only');
  for (const [g] of payloads(jobId)) assert.deepEqual(g.namespace, { code: 'hashedKocid' });
});

test('scope can change by re-planning only before anything ships', () => {
  const jobId = job();
  plan(jobId, 'cluster');
  plan(jobId, 'source_only');
  assert.equal(q().getJob.get(jobId).delete_scope, 'source_only');
  const [wo] = q().getAllOrdersForJob.all(jobId);
  q().updateWorkOrderSubmitted.run({ id: wo.id, adobeWorkorderId: 'DI-x', adobeStatus: 'received', bundleId: null, submittedAt: null });
  assert.throws(() => plan(jobId, 'cluster'), ReplanForbiddenError);
  assert.equal(q().getJob.get(jobId).delete_scope, 'source_only');
});

test('a re-plan without a scope keeps the scope of the current plan (never silently widens it)', () => {
  const jobId = job({ sources: 4 });
  plan(jobId, 'source_only');
  const again = plan(jobId);                      // e.g. "Re-plan against live quota"
  assert.equal(again.scope, 'source_only');
  assert.equal(q().getJob.get(jobId).delete_scope, 'source_only');
  assert.ok(payloads(jobId).flat().every(g => g.namespace.code === 'hashedKocid'), 'still no linked identity');
  plan(jobId, 'cluster');                         // an explicit choice still changes it
  assert.equal(plan(jobId).scope, 'cluster');
});

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

test('POST /plan validates scope; 409 for the cluster scope on an expansion-off job', async () => {
  const bad = await post(`/api/jobs/${job()}/plan`, { scope: 'everything' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_scope');
  const off = await post(`/api/jobs/${job({ mode: 'none' })}/plan`, { scope: 'cluster' });
  assert.equal(off.status, 409);
  assert.equal(off.body.error, 'scope_unavailable');
  const ok = await post(`/api/jobs/${job()}/plan`, { scope: 'source_only' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.scope, 'source_only');
});
