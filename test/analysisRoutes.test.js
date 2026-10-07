/**
 * Analysis read API + CSV downloads (2026-10-06): paging/filter/search over the
 * per-uploaded-ID report, a drill-down of one cluster, and two streamed CSVs.
 * Also pins that CSV downloads never make concurrent database writes fail
 * ("This database connection is busy executing a query").
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-analysis-routes-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-analysis-out-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = outDir;

const { initDb, q, bulkInsertIdentities } = await import('../src/db.js');
const { buildAnalysis } = await import('../src/runner/analysis.js');
const { __internal__: chunks } = await import('../src/routes/analysisRoutes.js');
const { db } = await import('../src/db.js');
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
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
});

let seq = 0;
function makeJob({ mode = 'cluster' } = {}) {
  seq++;
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'R', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `ar-${seq}@AdobeOrg`, clientId: `ar-${seq}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `AR ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 5 });
  q().setJobExpansionMode.run(mode, jobId);
  q().updateJobStatus.run('expanded', null, jobId);
  return jobId;
}
// A: only itself · B: linked · C, D: merged with each other (both uploaded) ·
// E: merged with X (NOT uploaded) and a phone whose value is a spreadsheet formula.
function seedFive(jobId) {
  const S = (s, members) => [[jobId, 'hashedKocid', 5000, s, s], ...members.map(([ns, id, v]) => [jobId, ns, id, v, s])];
  bulkInsertIdentities([
    ...S('A', []),
    ...S('B', [['email', 6, 'b@x'], ['ECID', 4, 'eb']]),
    ...S('C', [['hashedKocid', 5000, 'C'], ['hashedKocid', 5000, 'D'], ['email', 6, 'cd@x']]),
    ...S('D', [['hashedKocid', 5000, 'D'], ['hashedKocid', 5000, 'C'], ['email', 6, 'cd@x']]),
    ...S('E', [['hashedKocid', 5000, 'X'], ['phone', 7, '=cmd']]),
  ]);
  q().setFoundCount.run(10, jobId);
  return jobId;
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', c => s += c);
      res.on('end', () => {
        let body = s;
        if ((res.headers['content-type'] || '').includes('application/json')) body = s ? JSON.parse(s) : null;
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    }).on('error', reject);
  });
}
const ids = (r) => r.body.rows.map(x => x.source_id);

let ready, unbuilt;
before(async () => {
  ready = seedFive(makeJob());
  await buildAnalysis(ready);
  unbuilt = seedFive(makeJob());
});

test('GET /analysis reports availability, status and the summary', async () => {
  const u = await get(`/api/jobs/${unbuilt}/analysis`);
  assert.equal(u.status, 200);
  assert.equal(u.body.available, true);
  assert.equal(u.body.status, null);
  assert.equal(u.body.summary, null);
  const off = await get(`/api/jobs/${makeJob({ mode: 'none' })}/analysis`);
  assert.equal(off.body.available, false);
  assert.match(off.body.reason, /expansion was off/i);
  const r = await get(`/api/jobs/${ready}/analysis`);
  assert.equal(r.body.status, 'ready');
  assert.equal(r.body.sourcesDone, 5);
  assert.deepEqual(r.body.summary.byCategory, { source_only: 1, linked: 1, merged_in_list: 2, merged_outside_list: 1 });
  assert.equal((await get(`/api/jobs/${uuid()}/analysis`)).status, 404);
});

test('GET /analysis/sources: size order, category filter, id order + paging, prefix search', async () => {
  const all = await get(`/api/jobs/${ready}/analysis/sources`);
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 5);
  assert.deepEqual(ids(all), ['B', 'C', 'D', 'E', 'A'], 'largest clusters first, then by ID');
  assert.deepEqual(all.body.rows[0].ns_counts, { email: 1, ECID: 1 });
  const merged = await get(`/api/jobs/${ready}/analysis/sources?category=merged_in_list`);
  assert.deepEqual([ids(merged), merged.body.total], [['C', 'D'], 2]);
  const page = await get(`/api/jobs/${ready}/analysis/sources?sort=id&limit=2&offset=2`);
  assert.deepEqual([ids(page), page.body.total], [['C', 'D'], 5]);
  const found = await get(`/api/jobs/${ready}/analysis/sources?search=E`);
  assert.deepEqual([ids(found), found.body.total], [['E'], 1]);
  const none = await get(`/api/jobs/${ready}/analysis/sources?search=Q`);
  assert.deepEqual([ids(none), none.body.total], [[], 0]);
  const outside = await get(`/api/jobs/${ready}/analysis/sources?category=merged_outside_list&search=E`);
  assert.deepEqual([ids(outside), outside.body.total], [['E'], 1]);
});

test('GET /analysis/sources rejects bad parameters and unbuilt analyses', async () => {
  for (const qs of ['limit=0', 'limit=501', 'limit=abc', 'offset=-1', 'category=bogus', 'sort=bogus']) {
    const r = await get(`/api/jobs/${ready}/analysis/sources?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error, 'invalid_query', qs);
  }
  const nb = await get(`/api/jobs/${unbuilt}/analysis/sources`);
  assert.equal(nb.status, 409);
  assert.equal(nb.body.error, 'analysis_not_ready');
});

test('GET /analysis/sources/:sourceId lists one cluster with each identity\'s relation', async () => {
  const e = await get(`/api/jobs/${ready}/analysis/sources/E`);
  assert.equal(e.status, 200);
  assert.equal(e.body.category, 'merged_outside_list');
  assert.deepEqual(e.body.identities.map(i => [i.relation, i.namespace, i.value, i.inList]), [
    ['self', 'hashedKocid', 'E', undefined],
    ['other_profile', 'hashedKocid', 'X', false],
    ['linked', 'phone', '=cmd', undefined],
  ]);
  const c = await get(`/api/jobs/${ready}/analysis/sources/C`);
  assert.deepEqual(c.body.identities.filter(i => i.relation === 'other_profile').map(i => [i.value, i.inList]), [['D', true]]);
  assert.equal(c.body.identities.filter(i => i.relation === 'self').length, 1, 'the duplicated self member is listed once');
  assert.equal((await get(`/api/jobs/${ready}/analysis/sources/NOPE`)).status, 404);
});

const lines = (csv) => csv.trim().split(/\r?\n/);

test('summary CSV: one row per uploaded ID with a count column per namespace', async () => {
  const r = await get(`/api/jobs/${ready}/analysis/export?kind=summary`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /attachment; filename="job_[0-9a-f-]+_analysis_summary\.csv"/);
  const [header, ...rows] = lines(r.body);
  assert.equal(header, 'hashedKocid,category,identities_total,linked_total,other_profiles_in_list,other_profiles_not_in_list,' +
    'ns:email,ns:hashedKocid,ns:ECID,ns:phone');
  assert.equal(rows.length, 5);
  assert.ok(rows.includes('B,linked,3,2,0,0,1,0,1,0'), rows.join(' | '));
  assert.ok(rows.includes('E,merged_outside_list,3,2,0,1,0,1,0,1'), rows.join(' | '));
  const only = await get(`/api/jobs/${ready}/analysis/export?kind=summary&category=merged_in_list`);
  assert.deepEqual(lines(only.body).slice(1).map(l => l.split(',')[0]), ['C', 'D']);
});

test('detail CSV: every identity of the flagged IDs, sanitised; category filter', async () => {
  const r = await get(`/api/jobs/${ready}/analysis/export?kind=detail`);
  assert.equal(r.status, 200);
  const [header, ...rows] = lines(r.body);
  assert.equal(header, 'hashedKocid,category,namespace,namespace_id,identity,relation,other_profile_in_list');
  assert.ok(!rows.some(l => l.startsWith('A,')), 'IDs that are only themselves are left out by default');
  assert.ok(rows.includes("E,merged_outside_list,phone,7,'=cmd,linked,"), 'a formula-looking value is neutralised');
  assert.ok(rows.includes('E,merged_outside_list,hashedKocid,5000,X,other_profile,no'));
  assert.ok(rows.includes('C,merged_in_list,hashedKocid,5000,D,other_profile,yes'));
  const outside = await get(`/api/jobs/${ready}/analysis/export?kind=detail&category=merged_outside_list`);
  assert.deepEqual([...new Set(lines(outside.body).slice(1).map(l => l.split(',')[0]))], ['E']);
  assert.equal(lines(outside.body).length - 1, 3);
});

test('export rejects bad parameters and unbuilt analyses', async () => {
  for (const qs of ['kind=everything', 'kind=detail&category=bogus']) {
    const r = await get(`/api/jobs/${ready}/analysis/export?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error, 'invalid_query', qs);
  }
  const nb = await get(`/api/jobs/${unbuilt}/analysis/export?kind=summary`);
  assert.equal(nb.status, 409);
  assert.equal(nb.body.error, 'analysis_not_ready');
});

// Read the response slowly so the server hits back-pressure mid-download.
function slowGet(p) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + p, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; res.pause(); setTimeout(() => res.resume(), 1); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('CSV downloads never make concurrent database writes fail', async () => {
  const big = makeJob();
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    const s = `s${String(i).padStart(5, '0')}`;
    rows.push([big, 'hashedKocid', 5000, s, s], [big, 'hashedKocid', 5000, s, s]);
    for (let k = 0; k < 5; k++) rows.push([big, 'email', 6, `${s}-${k}@x.com`, s]);
  }
  bulkInsertIdentities(rows);
  await buildAnalysis(big);
  const other = makeJob();

  for (const [url, expectedLines] of [
    [`/api/jobs/${big}/export`, 24_000],                          // existing Export CSV: each distinct identity once
    [`/api/jobs/${big}/analysis/export?kind=detail`, 24_000],     // self + 5 linked per uploaded ID
  ]) {
    let errors = 0, writes = 0, running = true;
    let firstError = null;
    const tick = () => {
      if (!running) return;
      try { q().updateJobStatus.run('expanded', null, other); writes++; }
      catch (e) { errors++; firstError ??= e.message; }
      setImmediate(tick);
    };
    setImmediate(tick);
    const r = await slowGet(url);
    running = false;
    assert.equal(r.status, 200, url);
    assert.equal(lines(r.body).length - 1, expectedLines, url);
    assert.ok(writes > 0, url);
    assert.equal(errors, 0, `${url}: ${errors} concurrent write(s) failed: ${firstError}`);
  }
});

// ── Download chunking at scale (6.8M-ID scale check, 2026-10-06) ─────────
// A single-category download used to walk the whole job in ID order for every
// chunk (a 1% category scanned ~500k rows per 5,000-row chunk: 2.6 s event-loop
// blocks at 6.8M IDs). It must walk idx_sa_job_cat_size instead.

test('a single-category download walks the category index, never the whole job', async () => {
  const st = chunks.chunkStatement('one');
  const plans = (Array.isArray(st) ? st : [st]).flatMap(s =>
    db.prepare(`EXPLAIN QUERY PLAN ${s.source}`).all({ jobId: ready, category: 'linked', after: '', limit: 10, size: 3 })
      .map(r => r.detail));
  assert.ok(plans.length > 0);
  for (const d of plans) assert.match(d, /USING (COVERING )?INDEX idx_sa_job_cat_size \(job_id=\? AND category=\?/, d);
});

test('single-category chunks: each ID exactly once, largest clusters first, ties kept across chunk edges', async () => {
  const jobId = makeJob();
  const S = (s, extra) => [[jobId, 'hashedKocid', 5000, s, s], ...Array.from({ length: extra }, (_, k) => [jobId, 'email', 6, `${s}-${k}@x`, s])];
  bulkInsertIdentities([...S('L01', 2), ...S('L02', 2), ...S('L03', 2), ...S('L04', 1), ...S('L05', 1), ...S('L06', 3), ...S('L07', 3)]);
  await buildAnalysis(jobId);
  const got = [];
  for await (const c of chunks.analysisChunks(jobId, 'one', 'linked', 2)) got.push(c.map(r => r.source_id));
  assert.deepEqual(got.flat(), ['L06', 'L07', 'L01', 'L02', 'L03', 'L04', 'L05']);
  assert.ok(got.every(c => c.length <= 2));
});
