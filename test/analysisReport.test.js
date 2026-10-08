/** Excel report lifecycle (2026-10-07): built in a worker thread, one at a time,
 *  kept until the analysis is rebuilt or the job deleted, never served stale. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import express from 'express';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-report-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-report-out-'));
process.env.DB_PATH = dbPath; process.env.UPLOAD_DIR = os.tmpdir(); process.env.OUTPUT_DIR = outDir;

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { buildAnalysis } = await import('../src/runner/analysis.js');
const report = await import('../src/runner/analysisReport.js');
const { runStartupRecovery } = await import('../src/runner/recovery.js');
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

// pairs P (merged in list), O + outside X (merged NOT in list), L (linked)
async function seed(n = 300, { build = true } = {}) {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'R', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `rep-${credsId}@AdobeOrg`, clientId: `rep-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'kocid oct.csv', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 3 * n });
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = `P${String(i).padStart(6, '0')}`, mate = `P${String(i ^ 1).padStart(6, '0')}`, o = `O${String(i).padStart(6, '0')}`, l = `L${String(i).padStart(6, '0')}`;
    rows.push([jobId, 'hashedKocid', 5000, p, p], [jobId, 'hashedKocid', 5000, mate, p], [jobId, 'email', 6, `${p}@x.com`, p]);
    rows.push([jobId, 'hashedKocid', 5000, o, o], [jobId, 'hashedKocid', 5000, `X${i % 7}`, o], [jobId, 'email', 6, `${o}@x.com`, o]);
    rows.push([jobId, 'hashedKocid', 5000, l, l], [jobId, 'email', 6, `${l}@x.com`, l]);
  }
  bulkInsertIdentities(rows);
  q().updateJobStatus.run('expanded', null, jobId);
  if (build) await buildAnalysis(jobId);
  return jobId;
}
async function settle(jobId, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const s = report.reportState(jobId); if (s.status !== 'building') return s; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('report build did not finish');
}

test('worker-side modules never import db.js or config.js', () => {
  for (const f of ['analysisWorkbook.js', 'analysisReportWorker.js']) {
    const src = fs.readFileSync(new URL(`../src/runner/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/(db|config)\.js'/, f);
  }
});

test('a report builds in a worker: file ready, merged IDs only, the event loop stays free', async () => {
  const jobId = await seed(3000);
  let maxLag = 0, last = performance.now();
  const probe = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now; }, 5);
  assert.equal(report.startAnalysisReport(jobId).status, 'building');
  const s = await settle(jobId);
  clearInterval(probe);
  assert.equal(s.status, 'ready', s.error);
  assert.deepEqual([s.rowsDone, s.rowsTotal], [6000, 6000]);
  assert.ok(s.bytes > 0 && fs.existsSync(report.reportPath(jobId)));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(report.reportPath(jobId));
  assert.deepEqual(wb.worksheets.map(w => [w.name, w.rowCount]),
    [['Summary', wb.getWorksheet('Summary').rowCount], ['⚠ Merged · NOT in list', 3001], ['Merged · in list', 3001]]);
  assert.ok(maxLag < 150, `event loop blocked ${Math.round(maxLag)} ms`);
});

test('one build at a time; a ready report is reused unless rebuilt', async () => {
  const a = await seed(2000), b = await seed(10);
  report.startAnalysisReport(a);
  assert.throws(() => report.startAnalysisReport(a), e => e.code === 'report_building' && e.status === 409);
  assert.throws(() => report.startAnalysisReport(b), e => e.code === 'report_busy' && e.status === 409);
  await settle(a);
  const mtime = fs.statSync(report.reportPath(a)).mtimeMs;
  assert.equal(report.startAnalysisReport(a).status, 'ready');
  assert.equal(fs.statSync(report.reportPath(a)).mtimeMs, mtime, 'not rebuilt');
  assert.equal(report.startAnalysisReport(a, { rebuild: true }).status, 'building');
  assert.equal((await settle(a)).status, 'ready');
});

test('no report without a ready analysis', async () => {
  const jobId = await seed(5, { build: false });
  assert.throws(() => report.startAnalysisReport(jobId), e => e.code === 'analysis_not_ready' && e.status === 409);
});

test('rebuilding the analysis discards the report, even mid-build', async () => {
  const jobId = await seed(3000);
  report.startAnalysisReport(jobId);
  await buildAnalysis(jobId);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(report.reportState(jobId).status, null);
  assert.ok(!fs.existsSync(report.reportPath(jobId)) && !fs.existsSync(`${report.reportPath(jobId)}.tmp`));
});

test('a missing file or an older analysis makes the report absent', async () => {
  const jobId = await seed(20);
  report.startAnalysisReport(jobId); await settle(jobId);
  fs.unlinkSync(report.reportPath(jobId));
  assert.equal(report.reportState(jobId).status, null);
  report.startAnalysisReport(jobId); await settle(jobId);
  db.prepare("UPDATE job_analysis SET finished_at = '2000-01-01 00:00:00' WHERE job_id = ?").run(jobId);
  assert.equal(report.reportState(jobId).status, null);
});

test('deleting the job removes its report', async () => {
  const jobId = await seed(20);
  report.startAnalysisReport(jobId); await settle(jobId);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/api/jobs/${jobId}`, { method: 'DELETE' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 200);
  assert.ok(!fs.existsSync(report.reportPath(jobId)));
});

test('a build interrupted by a restart is marked failed and its partial file removed', async () => {
  const jobId = await seed(5);
  q().startReport.run({ jobId, rowsTotal: 10, builtFor: q().getJobAnalysis.get(jobId).finished_at });
  fs.writeFileSync(`${report.reportPath(jobId)}.tmp`, 'partial');
  await runStartupRecovery();
  const s = report.reportState(jobId);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /restart/);
  assert.ok(!fs.existsSync(`${report.reportPath(jobId)}.tmp`));
});

test('the download name comes from the job name', () => {
  assert.equal(report.reportDownloadName({ id: 'x', name: 'kocid oct.csv' }), 'kocid_oct_identity_analysis.xlsx');
  assert.equal(report.reportDownloadName({ id: 'abc-123', name: null }), 'abc-123_identity_analysis.xlsx');
});

test('a job planned before scopes existed reads "linked identities" in the report, never "not planned"', async () => {
  const jobId = await seed(5);
  q().setPlannedOrders.run(3, jobId);                // planned under the old code: delete_scope stays NULL
  q().updateJobStatus.run('submitted', null, jobId);
  report.startAnalysisReport(jobId);
  assert.equal((await settle(jobId)).status, 'ready');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(report.reportPath(jobId));
  const sub = String(wb.getWorksheet('Summary').getCell('B4').value);
  assert.match(sub, /Plan: uploaded IDs \+ linked identities/, sub);
  assert.doesNotMatch(sub, /not planned/);
});
