/** Excel report endpoints (2026-10-07). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-report-routes-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-report-routes-out-'));
process.env.DB_PATH = dbPath; process.env.UPLOAD_DIR = os.tmpdir(); process.env.OUTPUT_DIR = outDir;
const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { buildAnalysis } = await import('../src/runner/analysis.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server, baseUrl;
before(async () => {
  initDb();
  const app = express(); app.use(express.json()); app.use('/api/jobs', jobsRouter); app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
});

async function seed({ build = true } = {}) {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'R', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `rr-${credsId}@AdobeOrg`, clientId: `rr-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'kocid-oct.csv', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 2 });
  bulkInsertIdentities([[jobId, 'hashedKocid', 5000, 'A', 'A'], [jobId, 'hashedKocid', 5000, 'X', 'A'], [jobId, 'email', 6, 'a@x', 'A'],
    [jobId, 'hashedKocid', 5000, 'B', 'B'], [jobId, 'email', 6, 'b@x', 'B']]);
  q().updateJobStatus.run('expanded', null, jobId);
  if (build) await buildAnalysis(jobId);
  return jobId;
}
function call(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, { method }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const isJson = (res.headers['content-type'] || '').includes('application/json');
        resolve({ status: res.statusCode, headers: res.headers, body: isJson ? JSON.parse(buf.toString('utf8') || 'null') : buf });
      });
    });
    req.on('error', reject); req.end();
  });
}
async function untilReady(jobId) {
  for (let i = 0; i < 500; i++) {
    const r = await call('GET', `/api/jobs/${jobId}/analysis`);
    if (r.body.report?.status !== 'building') return r.body.report;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('timeout');
}

test('POST builds the report; GET /analysis shows its state; the download is an .xlsx named after the job', async () => {
  const jobId = await seed();
  assert.equal((await call('GET', `/api/jobs/${jobId}/analysis`)).body.report.status, null);
  const early = await call('GET', `/api/jobs/${jobId}/analysis/report`);
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'report_not_ready');
  const start = await call('POST', `/api/jobs/${jobId}/analysis/report`);
  assert.equal(start.status, 200);
  assert.equal(start.body.status, 'building');
  const state = await untilReady(jobId);
  assert.equal(state.status, 'ready');
  assert.equal(state.rowsDone, 1);
  const dl = await call('GET', `/api/jobs/${jobId}/analysis/report`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /spreadsheetml\.sheet/);
  assert.match(dl.headers['content-disposition'], /attachment; filename="kocid-oct_identity_analysis\.xlsx"/);
  assert.equal(dl.body.subarray(0, 2).toString('latin1'), 'PK', 'an xlsx is a zip');
  assert.equal((await call('POST', `/api/jobs/${jobId}/analysis/report`)).body.status, 'ready');
  assert.equal((await call('POST', `/api/jobs/${jobId}/analysis/report?rebuild=1`)).body.status, 'building');
  await untilReady(jobId);
});

test('404 for an unknown job; 409 analysis_not_ready before the analysis exists', async () => {
  assert.equal((await call('POST', `/api/jobs/${uuid()}/analysis/report`)).status, 404);
  const r = await call('POST', `/api/jobs/${await seed({ build: false })}/analysis/report`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'analysis_not_ready');
});
