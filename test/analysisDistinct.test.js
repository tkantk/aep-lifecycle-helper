/**
 * Distinct identity counts in the analysis (2026-10-14). The user saw fewer
 * hashedKocids than emails on the Summary although every hashedKocid was found:
 * the per-namespace numbers were summed per uploaded ID, so the uploaded IDs
 * themselves were left out and an identity shared by several uploaded IDs was
 * counted once for each. "Profiles NOT in your file" was likewise a per-ID sum
 * in the app but a distinct count in the Excel. Now each identity is counted
 * once, the uploaded IDs included, and the parts add up to the job's distinct
 * identities. An analysis built before this gets the counts from its next
 * Excel report build (no rebuild, no calls to Adobe).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-distinct-${Date.now()}.db`);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-distinct-out-'));
process.env.DB_PATH = dbPath; process.env.UPLOAD_DIR = os.tmpdir(); process.env.OUTPUT_DIR = outDir;

const { initDb, q, db, bulkInsertIdentities } = await import('../src/db.js');
const { buildAnalysis, analysisPhase, _seams } = await import('../src/runner/analysis.js');
const { splitDistinctNamespaces } = await import('../src/runner/analysisCore.js');
const report = await import('../src/runner/analysisReport.js');

before(() => initDb());
after(() => {
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ }
});

// A (only itself) · B (linked: email + ECID) · C and D (merged with each other,
// sharing one email) · E (merged with X, NOT uploaded; a phone) · N (not in the
// identity graph: one own row). Distinct: 6 uploaded + X + 2 emails + 1 ECID +
// 1 phone = 11.
function seed() {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'D', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `dist-${credsId}@AdobeOrg`, clientId: `dist-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'kocid oct.csv', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 6 });
  // Rows as expansion writes them: the uploaded ID first, then every cluster member (the ID itself included).
  const S = (s, members) => [[jobId, 'hashedKocid', 5000, s, s], ...members.map(([ns, id, v]) => [jobId, ns, id, v, s])];
  bulkInsertIdentities([
    ...S('A', [['hashedKocid', 5000, 'A']]),
    ...S('B', [['hashedKocid', 5000, 'B'], ['email', 6, 'b@x'], ['ECID', 4, 'eb']]),
    ...S('C', [['hashedKocid', 5000, 'C'], ['hashedKocid', 5000, 'D'], ['email', 6, 'cd@x']]),
    ...S('D', [['hashedKocid', 5000, 'D'], ['hashedKocid', 5000, 'C'], ['email', 6, 'cd@x']]),
    ...S('E', [['hashedKocid', 5000, 'E'], ['hashedKocid', 5000, 'X'], ['phone', 7, '+1']]),
    [jobId, 'hashedKocid', 5000, 'N', 'N'],
  ]);
  q().setFoundCount.run(q().countDistinctIdentities.get(jobId).n, jobId);   // as expansion does when it finishes
  q().updateJobStatus.run('expanded', null, jobId);
  return jobId;
}
const EXPECTED = { uploaded: 6, outsideProfiles: 1, byNamespace: { email: 2, ECID: 1, phone: 1 }, mergedWithUploaded: 2 };
const parts = (d) => d.uploaded + d.outsideProfiles + Object.values(d.byNamespace).reduce((a, b) => a + b, 0);
async function settle(jobId, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const s = report.reportState(jobId); if (s.status !== 'building') return s; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('report build did not finish');
}
const findCell = (ws, text) => { let hit = null; ws.eachRow(row => row.eachCell(c => { if (!hit && c.value === text) hit = c; })); return hit; };

test('splitDistinctNamespaces: the source namespace splits into uploaded IDs and profiles NOT in the file', () => {
  const groups = [
    { ns_code: 'hashedKocid', ns_id: 5000, n: 9 },
    { ns_code: null, ns_id: 5000, n: 1 },            // a member that carries only the nsid
    { ns_code: 'email', ns_id: 6, n: 4 },
    { ns_code: null, ns_id: 777, n: 2 },
  ];
  assert.deepEqual(splitDistinctNamespaces(groups, { code: 'hashedKocid', id: 5000 }, 3),
    { uploaded: 7, outsideProfiles: 3, byNamespace: { email: 4, 'nsid:777': 2 } });
  assert.deepEqual(splitDistinctNamespaces([{ ns_code: 'hashedKocid', ns_id: 5000, n: 5 }], { code: 'HASHEDKOCID', id: null }, 1),
    { uploaded: 4, outsideProfiles: 1, byNamespace: {} }, 'a typed code in another case still matches the source namespace');
});

test('the analysis counts each identity once, the uploaded IDs included, adding up to the distinct identities', async () => {
  const jobId = seed();
  const summary = await buildAnalysis(jobId, { pageSize: 2 });       // several pages
  assert.deepEqual(summary.distinct, EXPECTED);
  assert.equal(summary.identities, 11);
  assert.equal(parts(summary.distinct), summary.identities, 'the parts add up to the distinct identities');
  assert.deepEqual(JSON.parse(q().getJobAnalysis.get(jobId).summary_json).distinct, EXPECTED, 'stored for the Analysis tab');
});

test('the Excel Summary: clear tiles, and identities by namespace each counted once with a total', async () => {
  const jobId = seed();
  await buildAnalysis(jobId);
  report.startAnalysisReport(jobId);
  const st = await settle(jobId);
  assert.equal(st.status, 'ready', st.error);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(report.reportPath(jobId));
  const s = wb.getWorksheet('Summary');
  const tile = (label) => { const c = findCell(s, label); assert.ok(c, `tile ${label}`); return [s.getCell(c.row + 1, c.col).value, s.getCell(c.row + 2, c.col).value]; };
  assert.deepEqual(tile('⚠ MERGED WITH A PROFILE NOT IN YOUR FILE'), [1, 'of your uploaded IDs'],
    'the tile has the category\'s own name — "your IDs merged" meant two numbers (review #6)');
  assert.equal(tile('⚠ PROFILES NOT IN YOUR FILE')[0], 1);
  assert.equal(tile('DISTINCT IDENTITIES')[0], 11);
  const row = (label) => { const c = findCell(s, label); assert.ok(c, `row ${label}`); return s.getCell(c.row, 3).value; };
  assert.equal(row('hashedKocid · your uploaded IDs'), 6);
  assert.equal(row('hashedKocid · profiles NOT in your file'), 1);
  assert.deepEqual([row('email'), row('ECID'), row('phone')], [2, 1, 1], 'the shared email is counted once');
  assert.equal(row('Total'), 11);
  assert.equal(findCell(s, 'hashedKocid (other profiles)'), null, 'the old per-ID sum is gone');
});

test('an analysis built before the distinct counts gets them from its next Excel report build', async () => {
  const jobId = seed();
  await buildAnalysis(jobId);
  const before = q().getJobAnalysis.get(jobId);
  const legacy = JSON.parse(before.summary_json);
  delete legacy.distinct;
  db.prepare('UPDATE job_analysis SET summary_json = ? WHERE job_id = ?').run(JSON.stringify(legacy), jobId);
  report.startAnalysisReport(jobId);
  const st = await settle(jobId);
  assert.equal(st.status, 'ready', st.error);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(report.reportPath(jobId));
  const s = wb.getWorksheet('Summary');
  assert.equal(s.getCell(findCell(s, 'hashedKocid · your uploaded IDs').row, 3).value, 6, 'the report counts them itself');
  const after = q().getJobAnalysis.get(jobId);
  assert.deepEqual(JSON.parse(after.summary_json).distinct, EXPECTED, 'and stores them for the Analysis tab');
  assert.equal(after.finished_at, before.finished_at, 'the analysis itself is unchanged');
  assert.equal(report.reportState(jobId).status, 'ready', 'so the report stays valid');
});

test('the counting runs in worker threads that never open the app database and sort on disk', () => {
  for (const f of ['analysisCountsWorker.js', 'analysisCounts.js', 'analysisReaders.js']) {
    const src = fs.readFileSync(new URL(`../src/runner/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from '\.\.\/(db|config)\.js'/, f);
  }
  assert.match(fs.readFileSync(new URL('../src/runner/analysisCountsWorker.js', import.meta.url), 'utf8'), /temp_store = FILE/);
  assert.match(fs.readFileSync(new URL('../src/runner/analysisReportWorker.js', import.meta.url), 'utf8'), /temp_store = FILE/);
});

// ─── Final review (2026-10-14) ───────────────────────────────────────────

test('a workbook built before this change is out of date: never served, and a plain build makes a new one (review #1)', async () => {
  // The 6.8M job's report was 'ready' for its unchanged analysis, so Download kept
  // serving the old per-ID sums and nothing ever counted the distinct identities.
  const jobId = seed();
  await buildAnalysis(jobId);
  report.startAnalysisReport(jobId);
  assert.equal((await settle(jobId)).status, 'ready');
  const a = q().getJobAnalysis.get(jobId);
  db.prepare('UPDATE job_analysis SET report_built_for = ? WHERE job_id = ?').run(a.finished_at, jobId);   // as the old code stored it
  assert.equal(report.reportState(jobId).status, null, 'stale: the card offers "Build Excel report" again');
  assert.equal(report.startAnalysisReport(jobId).status, 'building', 'a plain build (no rebuild flag) builds it afresh');
  assert.equal((await settle(jobId)).status, 'ready');
});

test('if counting identities per namespace fails, the analysis still finishes and records why (review #2)', async () => {
  const jobId = seed();
  const orig = _seams.countDistinct;
  _seams.countDistinct = async () => { throw new Error('database or disk is full'); };
  try {
    const summary = await buildAnalysis(jobId);
    assert.equal(summary.distinct, undefined);
    assert.equal(summary.distinctError, 'database or disk is full', 'the app says why, not "built before"');
    assert.equal(q().getJobAnalysis.get(jobId).status, 'ready');
  } finally { _seams.countDistinct = orig; }
});

test('while the build counts identities per namespace it says so (no frozen 100%) (review #4)', async () => {
  const jobId = seed();
  const orig = _seams.countDistinct;
  let release;
  _seams.countDistinct = (...args) => new Promise((resolve, reject) => { release = () => orig(...args).then(resolve, reject); });
  try {
    const building = buildAnalysis(jobId);
    for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(analysisPhase(jobId), 'counting');
    release();
    const summary = await building;
    assert.deepEqual(summary.distinct, EXPECTED);
    assert.equal(analysisPhase(jobId), null);
  } finally { _seams.countDistinct = orig; }
});

test('if keeping the counts fails, the finished report is still kept (review #3)', async () => {
  const jobId = seed();
  await buildAnalysis(jobId);
  const legacy = JSON.parse(q().getJobAnalysis.get(jobId).summary_json);
  delete legacy.distinct;
  db.prepare('UPDATE job_analysis SET summary_json = ? WHERE job_id = ?').run(JSON.stringify(legacy), jobId);
  const orig = q().setAnalysisSummary;
  q().setAnalysisSummary = { run() { throw new Error('disk I/O error'); } };
  try {
    report.startAnalysisReport(jobId);
    const st = await settle(jobId);
    assert.equal(st.status, 'ready', st.error);
    assert.ok(fs.existsSync(report.reportPath(jobId)), 'a 7-minute build is not thrown away');
  } finally { q().setAnalysisSummary = orig; }
});
