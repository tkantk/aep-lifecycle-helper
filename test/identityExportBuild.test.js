/**
 * Expansion "Export CSV" built in the background (2026-10-09). The button used to
 * navigate to GET /export, which built the WHOLE file before sending a byte —
 * the browser waited minutes on a big job — and SQLite sorted every row in RAM
 * (~+1.1 GB per 1M uploaded IDs, ~6 GB at 6.8M) on the laptop the browser runs
 * on. Now: POST starts a background build (sorting on disk), GET /jobs/:id
 * reports its progress, and GET /export sends the finished file.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-export-build-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-export-build-out-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = outDir;

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { markInterruptedExports, exportPath } = await import('../src/runner/identityExport.js');
const { runExpansion } = await import('../src/runner/expansion.js');
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
afterEach(() => nock.cleanAll());
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function call(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, { method }, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => s += c);
      res.on('end', () => { let body = s; try { body = JSON.parse(s); } catch { /* csv */ } resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}
/** A job with `n` sources × (self twice + email + ECID); `shared` sources also share one phone. */
function makeJob(n = 2000, { name = 'kocid oct.csv', status = 'expanded' } = {}) {
  const credsId = storeCreds({ label: 'X', environment: 'prod', region: 'VA7', imsOrgId: `x-${uuid()}@AcmeOrg`, clientId: `x-${uuid()}`, clientSecret: 's' });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name, credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: n });
  const rows = [];
  for (let i = 0; i < n; i++) {
    const s = `k${String(i).padStart(7, '0')}`;
    rows.push([jobId, 'hashedKocid', 5000, s, s], [jobId, 'hashedKocid', 5000, s, s], [jobId, 'email', 6, `${s}@x.com`, s], [jobId, 'ECID', 4, `e${s}`, s]);
    if (i < 3) rows.push([jobId, 'phone', 7, 'p0', s]);
  }
  bulkInsertIdentities(rows);
  const distinct = db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT COALESCE(ns_code,''), COALESCE(ns_id,0), identity_id FROM expanded_identities WHERE job_id = ?)").get(jobId).n;
  q().setFoundCount.run(distinct, jobId);
  q().updateJobStatus.run(status, null, jobId);
  return { jobId, distinct, credsId };
}
async function exportOf(jobId) { return (await call('GET', `/api/jobs/${jobId}`)).body.export; }
async function readyOf(jobId, ms = 20000) {
  const t = Date.now();
  for (;;) {
    const e = await exportOf(jobId);
    if (e?.status !== 'building') return e;
    if (Date.now() - t > ms) throw new Error('export never finished');
    await sleep(25);
  }
}

test('POST starts a background build and returns at once; the finished file then downloads instantly', async () => {
  const { jobId, distinct } = makeJob(3000);
  const t = Date.now();
  const r = await call('POST', `/api/jobs/${jobId}/export`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'building');
  assert.ok(Date.now() - t < 1000, 'answers before the file is built');
  const done = await readyOf(jobId);
  assert.equal(done.status, 'ready', JSON.stringify(done));
  assert.deepEqual([done.rowsDone, done.rowsTotal], [distinct, distinct], 'progress counts the distinct identities');
  assert.ok(done.bytes > 0 && done.finishedAt);
  const dl = await call('GET', `/api/jobs/${jobId}/export`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'], /filename="kocid_oct_identities\.csv"/);
  const lines = dl.body.trim().split(/\r?\n/);
  assert.equal(lines[0], 'source_id,namespace_code,namespace_id,identity');
  assert.equal(lines.length - 1, distinct, 'each distinct identity once');
  assert.ok(!lines.some(l => l.startsWith('k0000001,phone,7,p0')), 'a shared identity is listed under its first source only');
  const mtime = fs.statSync(exportPath(jobId)).mtimeMs;
  await call('GET', `/api/jobs/${jobId}/export`);
  assert.equal(fs.statSync(exportPath(jobId)).mtimeMs, mtime, 'a second download sends the same file — no rebuild');
});

test('one build at a time: the same job → 409 export_building; another job → 409 export_busy', async () => {
  const a = makeJob(20000), b = makeJob(10);
  assert.equal((await call('POST', `/api/jobs/${a.jobId}/export`)).body.status, 'building');
  const again = await call('POST', `/api/jobs/${a.jobId}/export`);
  assert.deepEqual([again.status, again.body.error], [409, 'export_building']);
  const other = await call('POST', `/api/jobs/${b.jobId}/export`);
  assert.deepEqual([other.status, other.body.error], [409, 'export_busy']);
  assert.equal((await readyOf(a.jobId)).status, 'ready');
  assert.equal((await call('POST', `/api/jobs/${b.jobId}/export`)).body.status, 'building', 'free again once it finished');
  await readyOf(b.jobId);
});

test('?rebuild=1 builds a fresh file; without it a ready export is returned as is', async () => {
  const { jobId } = makeJob(50);
  await call('POST', `/api/jobs/${jobId}/export`);
  const first = await readyOf(jobId);
  assert.equal((await call('POST', `/api/jobs/${jobId}/export`)).body.status, 'ready');
  assert.equal((await call('POST', `/api/jobs/${jobId}/export?rebuild=1`)).body.status, 'building');
  const second = await readyOf(jobId);
  assert.ok(second.finishedAt >= first.finishedAt);
});

test('not while the expansion is running', async () => {
  const { jobId } = makeJob(10, { status: 'expanding' });
  const r = await call('POST', `/api/jobs/${jobId}/export`);
  assert.deepEqual([r.status, r.body.error], [409, 'export_not_ready']);
});

test('an expansion run (e.g. Resume) discards the export — the identities are about to change', async () => {
  const { jobId, credsId } = makeJob(20);
  await call('POST', `/api/jobs/${jobId}/export`);
  await readyOf(jobId);
  assert.ok(fs.existsSync(exportPath(jobId)));
  nock('https://ims-na1.adobelogin.com').persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock('https://platform-va7.adobe.io').persist().get('/data/core/idnamespace/identities').reply(500, { message: 'down' });
  await assert.rejects(() => runExpansion({ jobId, uploadPath: '/nonexistent.csv', sourceNamespace: 'hashedKocid',
    sourceNamespaceId: 5000, credsId, sandboxName: 'prod', column: 0, skipSourceIds: { has: () => true } }));
  assert.ok(!fs.existsSync(exportPath(jobId)), 'the file is removed');
  assert.equal((await exportOf(jobId)).status, null);
});

test('deleting the job removes its export', async () => {
  const { jobId } = makeJob(20);
  await call('POST', `/api/jobs/${jobId}/export`);
  await readyOf(jobId);
  assert.equal((await call('DELETE', `/api/jobs/${jobId}`)).status, 200);
  assert.ok(!fs.existsSync(exportPath(jobId)));
});

test('a build interrupted by a restart is marked failed at startup', async () => {
  const { jobId } = makeJob(5);
  db.prepare("UPDATE jobs SET export_status = 'building', export_started_at = datetime('now') WHERE id = ?").run(jobId);
  fs.writeFileSync(`${exportPath(jobId)}.tmp`, 'partial');
  assert.ok(markInterruptedExports() >= 1);
  const e = await exportOf(jobId);
  assert.equal(e.status, 'failed');
  assert.match(e.error, /restart/);
  assert.ok(!fs.existsSync(`${exportPath(jobId)}.tmp`));
});

test('GET /export with no export yet builds it first — scripts keep working — and keeps the file', async () => {
  const { jobId, distinct } = makeJob(30);
  const dl = await call('GET', `/api/jobs/${jobId}/export`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.trim().split(/\r?\n/).length - 1, distinct);
  assert.equal((await exportOf(jobId)).status, 'ready');
});

test('the export sorts on disk, not in RAM (measured: +1.1 GB → +0.2 GB per 1M IDs, and faster)', () => {
  const src = fs.readFileSync(new URL('../src/runner/identityExportWorker.js', import.meta.url), 'utf8');
  assert.match(src, /temp_store = FILE/);
  assert.doesNotMatch(src, /temp_store = MEMORY/);
});
