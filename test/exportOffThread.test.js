/**
 * Export CSV never freezes the server (2026-10-06 final review, Important #2).
 *
 * The job-wide identity export lists each distinct identity once, by its first
 * source, so SQLite must group EVERY stored row before it returns the first one
 * — minutes on a 36M-row job. On the main thread that froze the whole server
 * (a running submission's Adobe responses, the monitor, the UI) for the whole
 * grouping, long enough for request timeouts to fire mid-submit. It now runs in
 * a worker thread on its own read-only connection; the file is unchanged.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-export-thread-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-export-thread-out-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = outDir;

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

let server, baseUrl;
before(async () => {
  initDb();
  const app = express();
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
});

function makeJob(sources) {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'X', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `x-${credsId}@AdobeOrg`, clientId: `x-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'export', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: sources });
  return jobId;
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => s += c);
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    }).on('error', reject);
  });
}

test('Export CSV runs off the main thread: the event loop keeps ticking and the file is unchanged', async () => {
  const SOURCES = 120_000;
  const jobId = makeJob(SOURCES);
  // Stored like expansion writes them: the source row, the source again as a
  // cluster member, two linked identities, and one identity shared by every
  // pair of sources (so the job-wide de-duplication is exercised).
  let rows = [];
  for (let i = 0; i < SOURCES; i++) {
    const s = `k${String(i).padStart(7, '0')}`;
    rows.push([jobId, 'hashedKocid', 5000, s, s], [jobId, 'hashedKocid', 5000, s, s],
      [jobId, 'email', 6, `${s}@x.com`, s], [jobId, 'ECID', 4, `e${i}`, s],
      [jobId, 'phone', 7, `p${Math.floor(i / 2)}`, s]);
    if (rows.length >= 100_000) { bulkInsertIdentities(rows); rows = []; }
  }
  bulkInsertIdentities(rows);
  const distinct = SOURCES * 3 + SOURCES / 2;

  let maxLag = 0, last = performance.now();
  const probe = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now; }, 5);
  const r = await get(`/api/jobs/${jobId}/export`);
  clearInterval(probe);

  assert.equal(r.status, 200);
  const lines = r.body.trim().split(/\r?\n/);
  assert.equal(lines[0], 'source_id,namespace_code,namespace_id,identity');
  assert.equal(lines.length - 1, distinct, 'each distinct identity exactly once');
  assert.deepEqual(lines.slice(1, 5), [
    'k0000000,ECID,4,e0', 'k0000000,email,6,k0000000@x.com', 'k0000000,hashedKocid,5000,k0000000', 'k0000000,phone,7,p0',
  ], 'ordered by first source, then namespace — as before');
  assert.ok(!lines.some(l => l.startsWith('k0000001,phone,7,p0')), 'a shared identity is listed under its first source only');
  assert.ok(maxLag < 150, `the event loop was blocked for ${Math.round(maxLag)} ms during the export`);
});

test('Export CSV of an unknown job: unchanged (an empty file)', async () => {
  const r = await get(`/api/jobs/${uuid()}/export`);
  assert.equal(r.status, 200);
  assert.equal(r.body.trim(), '');
});
