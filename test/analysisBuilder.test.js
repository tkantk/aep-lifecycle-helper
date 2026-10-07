/**
 * Analysis builder (2026-10-06): a per-uploaded-ID report of who else is in its
 * Identity Graph cluster, built in chunks after a cluster expansion. It is a
 * review report only — it never changes the job, its plan or its work orders.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-analysis-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { classifySource, buildAnalysis, isAnalysisBuilding } = await import('../src/runner/analysis.js');
const { runStartupRecovery } = await import('../src/runner/recovery.js');
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

const KOC = { code: 'hashedKocid', id: 5000 };
const r = (ns, id, v) => ({ ns_code: ns, ns_id: id, identity_id: v });
const inList = new Set(['A', 'B', 'C', 'D', 'E']);
const classify = (sourceId, rows, sourceNs = KOC) =>
  classifySource({ sourceId, sourceNs, rows, isInList: (v) => inList.has(v) });

test('classifySource: the four categories, dedup, namespace counts, self excluded', () => {
  assert.equal(classify('A', [r('hashedKocid', 5000, 'A')]).category, 'source_only');
  const b = classify('B', [r('hashedKocid', 5000, 'B'), r('email', 6, 'b@x'), r('ECID', 4, 'e1'),
    r('ECID', 4, 'e1'), r('hashedKocid', 5000, 'B')]);
  assert.deepEqual([b.category, b.identitiesTotal, b.linkedTotal, b.nsCounts],
    ['linked', 3, 2, { email: 1, ECID: 1 }]);
  const c = classify('C', [r('hashedKocid', 5000, 'C'), r('hashedKocid', 5000, 'D'), r('email', 6, 'c@x')]);
  assert.deepEqual([c.category, c.otherInList, c.otherNotInList], ['merged_in_list', 1, 0]);
  const e = classify('E', [r('hashedKocid', 5000, 'E'), r('hashedKocid', 5000, 'X'), r('hashedKocid', 5000, 'D')]);
  assert.deepEqual([e.category, e.otherInList, e.otherNotInList], ['merged_outside_list', 1, 1]);
  // Members may carry only the nsid.
  assert.equal(classify('A', [r(null, 5000, 'A'), r(null, 5000, 'Z')]).category, 'merged_outside_list');
});

test('classifySource: the source namespace matches case-insensitively when no nsid is known', () => {
  const got = classify('A', [r('hashedKocid', 5000, 'A'), r('hashedKocid', 5000, 'Z')],
    { code: 'HASHEDKOCID', id: null });
  assert.equal(got.category, 'merged_outside_list', 'a typed code in another case must not hide a merged profile');
});

let seq = 0;
function seed({ mode = 'cluster', status = 'expanded', sourceNamespace = 'hashedKocid', nsid = 5000 } = {}) {
  seq++;
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'A', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `an-${seq}@AdobeOrg`, clientId: `an-${seq}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `An ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace, sourceNamespaceId: nsid, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 5 });
  q().setJobExpansionMode.run(mode, jobId);
  // Rows as expansion writes them: the source row first, then every cluster
  // member (Adobe's member list includes the source itself).
  const S = (s, members) => [[jobId, 'hashedKocid', 5000, s, s], ...members.map(([ns, id, v]) => [jobId, ns, id, v, s])];
  bulkInsertIdentities([
    ...S('A', []),
    ...S('B', [['email', 6, 'b@x'], ['ECID', 4, 'eb']]),
    ...S('C', [['hashedKocid', 5000, 'C'], ['hashedKocid', 5000, 'D'], ['email', 6, 'cd@x']]),
    ...S('D', [['hashedKocid', 5000, 'D'], ['hashedKocid', 5000, 'C'], ['email', 6, 'cd@x']]),
    ...S('E', [['hashedKocid', 5000, 'X'], ['phone', 7, '+1']]),
  ]);
  q().updateJobStatus.run(status, null, jobId);
  q().setFoundCount.run(10, jobId);     // expansion's job-wide DISTINCT identity count
  return jobId;
}
const rows = (jobId) => Object.fromEntries(
  db.prepare('SELECT * FROM source_analysis WHERE job_id = ? ORDER BY source_id').all(jobId).map(x => [x.source_id, x]));

test('buildAnalysis classifies every uploaded ID across pages and stores totals', async () => {
  const jobId = seed();
  const summary = await buildAnalysis(jobId, { pageSize: 2 });       // force 3 pages
  const got = rows(jobId);
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.category])),
    { A: 'source_only', B: 'linked', C: 'merged_in_list', D: 'merged_in_list', E: 'merged_outside_list' });
  assert.equal(got.E.other_not_in_list, 1, 'X only appears as a member — it is NOT in the list');
  assert.deepEqual(JSON.parse(got.B.ns_counts_json), { email: 1, ECID: 1 });
  assert.deepEqual([got.C.identities_total, got.C.linked_total], [3, 2], 'the duplicated self member is counted once');
  assert.deepEqual(summary.byCategory, { source_only: 1, linked: 1, merged_in_list: 2, merged_outside_list: 1 });
  assert.deepEqual(summary.otherProfiles, { inList: 2, notInList: 1 });
  assert.equal(summary.sources, 5);
  assert.equal(summary.identities, 10, "the job's distinct identities (found_count) — shared ones counted once");
  assert.deepEqual(summary.byNamespace, { email: 3, ECID: 1, hashedKocid: 3, phone: 1 });
  const ja = q().getJobAnalysis.get(jobId);
  assert.equal(ja.status, 'ready');
  assert.equal(ja.sources_done, 5);
  assert.deepEqual(JSON.parse(ja.summary_json).byCategory, summary.byCategory);
  assert.equal(q().getJob.get(jobId).status, 'expanded', 'the job itself is never touched');
});

test('legacy job (typed code in another case, no stored nsid) still detects merged profiles', async () => {
  const jobId = seed({ sourceNamespace: 'HASHEDKOCID', nsid: null });
  await buildAnalysis(jobId);
  assert.equal(rows(jobId).E.category, 'merged_outside_list');
  assert.equal(rows(jobId).C.category, 'merged_in_list');
});

test('a rebuild replaces the rows (no duplicates, reflects new data)', async () => {
  const jobId = seed();
  await buildAnalysis(jobId);
  bulkInsertIdentities([[jobId, 'email', 6, 'a@x', 'A']]);
  await buildAnalysis(jobId);
  assert.equal(rows(jobId).A.category, 'linked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_analysis WHERE job_id = ?').get(jobId).n, 5);
});

test('expansion-off and unexpanded jobs are not analysed', async () => {
  await assert.rejects(() => buildAnalysis(seed({ mode: 'none' })), (e) => e.code === 'analysis_unavailable');
  await assert.rejects(() => buildAnalysis(seed({ status: 'expanding' })), (e) => e.code === 'analysis_unavailable');
});

test('one build per job at a time', async () => {
  const jobId = seed();
  const first = buildAnalysis(jobId, { pageSize: 1 });
  assert.equal(isAnalysisBuilding(jobId), true);
  await assert.rejects(() => buildAnalysis(jobId), (e) => e.code === 'analysis_running');
  await first;
  assert.equal(isAnalysisBuilding(jobId), false);
});

test('a failing build is recorded on the analysis only; the job is untouched', async () => {
  const jobId = seed();
  db.exec('ALTER TABLE source_analysis RENAME TO source_analysis_tmp');
  try { await assert.rejects(() => buildAnalysis(jobId)); }
  finally { db.exec('ALTER TABLE source_analysis_tmp RENAME TO source_analysis'); }
  const ja = q().getJobAnalysis.get(jobId);
  assert.equal(ja.status, 'failed');
  assert.ok(ja.error);
  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'expanded');
  assert.equal(job.last_error, null);
});

test('a job deleted mid-build stops the build quietly', async () => {
  const jobId = seed();
  const p = buildAnalysis(jobId, { pageSize: 1 });      // first page runs synchronously
  q().deleteJob.run(jobId);
  assert.equal(await p, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_analysis WHERE job_id = ?').get(jobId).n, 0);
  assert.equal(isAnalysisBuilding(jobId), false);
});

test('a build interrupted by a restart is marked failed at startup', async () => {
  const jobId = seed();
  q().upsertJobAnalysisStart.run(jobId, 5);
  await runStartupRecovery();
  const ja = q().getJobAnalysis.get(jobId);
  assert.equal(ja.status, 'failed');
  assert.match(ja.error, /restart/);
});

function post(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write('{}'); req.end();
  });
}

test('POST /api/jobs/:id/analysis starts a build; 409 while running or when unavailable', async () => {
  assert.equal((await post(`/api/jobs/${uuid()}/analysis`)).status, 404);
  const off = await post(`/api/jobs/${seed({ mode: 'none' })}/analysis`);
  assert.equal(off.status, 409);
  assert.equal(off.body.error, 'analysis_unavailable');
  const jobId = seed();
  const ok = await post(`/api/jobs/${jobId}/analysis`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.started, true);
  if (isAnalysisBuilding(jobId)) {
    const busy = await post(`/api/jobs/${jobId}/analysis`);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, 'analysis_running');
  }
  for (let i = 0; i < 200 && q().getJobAnalysis.get(jobId)?.status !== 'ready'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(q().getJobAnalysis.get(jobId).status, 'ready');
});
