/** The pure analysis core + shared SQL (2026-10-07): import-free so the Excel
 *  report's worker thread can use them without opening the app database. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const core = await import('../src/runner/analysisCore.js');
const sql = await import('../src/runner/analysisSql.js');
const dbPath = path.join(os.tmpdir(), `aep-test-core-${Date.now()}.db`);
after(() => { for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } } });

test('the core and the SQL modules import nothing (worker-safe)', () => {
  for (const f of ['../src/runner/analysisCore.js', '../src/runner/analysisSql.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^\s*import[\s{]/m, `${f} must not import anything`);
  }
});

test('analysis.js re-exports the same functions (callers unchanged)', async () => {
  process.env.DB_PATH = dbPath;
  const analysis = await import('../src/runner/analysis.js');
  assert.equal(analysis.classifySource, core.classifySource);
  assert.equal(analysis.describeSourceIdentities, core.describeSourceIdentities);
  assert.equal(analysis.ANALYSIS_CATEGORIES, core.ANALYSIS_CATEGORIES);
});

test('resolveSourceNamespace: stored nsid wins, else the stored source row, else the typed code', () => {
  const job = { source_namespace: 'hashedKocid', source_namespace_id: 5000 };
  assert.deepEqual(core.resolveSourceNamespace(job), { code: 'hashedKocid', id: 5000 });
  const legacy = { source_namespace: 'HASHEDKOCID', source_namespace_id: null };
  assert.deepEqual(core.resolveSourceNamespace(legacy, { ns_code: 'hashedKocid', ns_id: 5000 }), { code: 'hashedKocid', id: 5000 });
  assert.deepEqual(core.resolveSourceNamespace(legacy, undefined), { code: 'HASHEDKOCID', id: null });
});

test('categoryChunkReader walks one category largest-first and keeps ties across chunk edges', () => {
  const rows = [['L06', 4], ['L07', 4], ['L01', 3], ['L02', 3], ['L03', 3], ['L04', 2], ['L05', 2]]
    .map(([source_id, identities_total]) => ({ source_id, identities_total }));
  const first = { all: ({ limit }) => rows.slice(0, limit) };
  const sameSize = { all: ({ size, after, limit }) => rows.filter(r => r.identities_total === size && r.source_id > after).slice(0, limit) };
  const smaller = { all: ({ size, limit }) => rows.filter(r => r.identities_total < size).slice(0, limit) };
  const next = core.categoryChunkReader({ first, sameSize, smaller }, { jobId: 'j', category: 'linked', chunkSize: 2 });
  const got = [];
  for (let last = null, chunk; (chunk = next(last)).length; last = chunk[chunk.length - 1]) got.push(chunk.map(r => r.source_id));
  assert.deepEqual(got, [['L06', 'L07'], ['L01', 'L02'], ['L03', 'L04'], ['L05']]);
});

test('the shared SQL carries the parameters its callers bind', () => {
  assert.match(sql.SA_CATEGORY_FIRST_SQL, /@jobId[\s\S]*@category[\s\S]*@limit/);
  assert.match(sql.SA_CATEGORY_SAME_SIZE_SQL, /@size[\s\S]*@after/);
  assert.match(sql.SA_CATEGORY_SMALLER_SQL, /identities_total < @size/);
  assert.match(sql.TOP_CLUSTERS_SQL, /ORDER BY identities_total DESC, source_id LIMIT \?/);
});
