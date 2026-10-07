/**
 * A slow disk never turns one analysis step into a long pause (2026-10-06 scale
 * check). The build and the detail download both read each uploaded ID's
 * identities, whose rows are scattered across the table: at 6.8M IDs on a cold
 * cache one 2,000-ID build page took ~0.56 s and one 1,000-ID detail chunk
 * ~0.7 s — the whole server waits meanwhile (submissions included). Simulated
 * here by making every identity-row read cost CPU time.
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

const dbPath = path.join(os.tmpdir(), `aep-test-analysis-slow-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { buildAnalysis } = await import('../src/runner/analysis.js');
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
});

function seed(sources) {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'S', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `slow-${credsId}@AdobeOrg`, clientId: `slow-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'slow', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: sources });
  const rows = [];
  for (let i = 0; i < sources; i++) {
    const s = `s${String(i).padStart(6, '0')}`;
    rows.push([jobId, 'hashedKocid', 5000, s, s], [jobId, 'email', 6, `${s}@x.com`, s]);
  }
  bulkInsertIdentities(rows);
  q().updateJobStatus.run('expanded', null, jobId);
  return jobId;
}

// Every identity-row read costs `perRowMs` of CPU — a cold, slow disk.
function slowIdentityReads(perRowMs) {
  const st = q().identitiesForSourceRange;
  const orig = st.all;
  st.all = function (...args) {
    const rows = orig.apply(this, args);
    const until = performance.now() + rows.length * perRowMs;
    while (performance.now() < until) { /* simulated I/O */ }
    return rows;
  };
  return () => { delete st.all; };
}
function lagProbe() {
  let max = 0, last = performance.now();
  const t = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last - 5); last = now; }, 5);
  return () => { clearInterval(t); return max; };
}

test('the analysis build keeps every step short on a slow disk', async () => {
  const jobId = seed(3000);
  const restore = slowIdentityReads(0.2);          // a 2,000-ID page (4,000 rows) = 0.8 s in one step
  const stop = lagProbe();
  let summary;
  try { summary = await buildAnalysis(jobId); } finally { restore(); }
  const maxLag = stop();
  assert.equal(summary.sources, 3000);
  assert.equal(summary.byCategory.linked, 3000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_analysis WHERE job_id = ?').get(jobId).n, 3000);
  assert.ok(maxLag < 300, `the event loop was blocked for ${Math.round(maxLag)} ms by one build step`);
});

test('a detail download pauses between uploaded IDs on a slow disk', async () => {
  const jobId = seed(1500);
  await buildAnalysis(jobId);
  const restore = slowIdentityReads(0.5);          // 1 ms per ID: a 1,000-ID chunk = 1 s in one step
  const stop = lagProbe();
  let body = '';
  try {
    body = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/jobs/${jobId}/analysis/export?kind=detail`, (res) => {
        let s = ''; res.setEncoding('utf8');
        res.on('data', c => s += c); res.on('end', () => resolve(s));
      }).on('error', reject);
    });
  } finally { restore(); }
  const maxLag = stop();
  const lines = body.trim().split(/\r?\n/);
  assert.equal(lines.length - 1, 3000, 'every identity of every uploaded ID');
  assert.equal(new Set(lines.slice(1).map(l => l.split(',')[0])).size, 1500);
  assert.ok(maxLag < 300, `the event loop was blocked for ${Math.round(maxLag)} ms by one download step`);
});
