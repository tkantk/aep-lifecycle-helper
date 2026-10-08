/** The identity-analysis Excel workbook (2026-10-07), read back with ExcelJS. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { writeAnalysisWorkbook, joinCell, dataNamespaces, REPORT_SHEETS, EXCEL_MAX_CELL_CHARS } from '../src/runner/analysisWorkbook.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-workbook-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const KOC = { code: 'hashedKocid', id: 5000 };
const r = (ns, id, v) => ({ ns_code: ns, ns_id: id, identity_id: v });
const identities = {
  C: [r('hashedKocid', 5000, 'C'), r('hashedKocid', 5000, 'D'), r('email', 6, 'cd@x.com')],
  D: [r('hashedKocid', 5000, 'D'), r('hashedKocid', 5000, 'C'), r('email', 6, 'cd@x.com')],
  E: [r('hashedKocid', 5000, 'E'), r('hashedKocid', 5000, 'X'), r('email', 6, 'e2@x.com'), r('email', 6, 'e1@x.com'),
      r('phone', 7, '=cmd'), r('Email', 66, 'Line1\nLine2 "q"')],
  F: [r('hashedKocid', 5000, 'F'), r('hashedKocid', 5000, 'X'), r(null, 777, 'n-1'), r('crm', 9, 'not-in-summary')],
  G: [r('hashedKocid', 5000, 'G'), r('hashedKocid', 5000, 'Y'),
      ...Array.from({ length: 1500 }, (_, k) => r('email', 6, `user${String(k).padStart(4, '0')}@example.com`))],
};
const inList = new Set(['C', 'D', 'E', 'F', 'G']);
const sa = (source_id, category, identities_total, other_not_in_list) => ({ source_id, category, identities_total, other_not_in_list });
const analysisRows = {
  merged_outside_list: [sa('G', 'merged_outside_list', 1502, 1), sa('E', 'merged_outside_list', 6, 1), sa('F', 'merged_outside_list', 4, 1)],
  merged_in_list: [sa('C', 'merged_in_list', 3, 0), sa('D', 'merged_in_list', 3, 0)],
};
const summary = { sources: 7, identities: 1521, byCategory: { source_only: 1, linked: 1, merged_in_list: 2, merged_outside_list: 3 },
  byNamespace: { email: 1504, hashedKocid: 5, phone: 1, Email: 1, 'nsid:777': 1 }, otherProfiles: { inList: 2, notInList: 3 } };
const meta = { jobId: 'job-1', jobName: 'kocid-oct', createdAt: '2026-10-07 09:00:00', sandbox: 'prod', sourceNamespace: 'hashedKocid',
  expansionMode: 'cluster', deleteScope: 'cluster', totalSourceIds: 7, foundCount: 1521,
  analysisBuiltAt: '2026-10-07 10:42 UTC', generatedAt: '2026-10-07 11:05 UTC' };
const readersFor = (rows) => ({
  async *categoryChunks(cat) { const list = rows[cat] || []; for (let i = 0; i < list.length; i += 2) yield list.slice(i, i + 2); },
  identitiesOf: (s) => identities[s] || [],
  isInList: (v) => inList.has(v),
  topClusters: (n) => Object.values(rows).flat().sort((a, b) => b.identities_total - a.identities_total).slice(0, n),
});
async function build(opts = {}) {
  const filename = path.join(dir, `r-${Math.random().toString(36).slice(2)}.xlsx`);
  const progress = [];
  const res = await writeAnalysisWorkbook({ filename, meta, summary, sourceNs: KOC, readers: readersFor(analysisRows),
    onProgress: (n) => progress.push(n), ...opts });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filename);
  return { wb, res, progress };
}
const values = (row) => row.values.slice(1);
const findCell = (ws, text) => { let hit = null; ws.eachRow(row => row.eachCell(c => { if (!hit && c.value === text) hit = c; })); return hit; };

test('joinCell joins with "; " and cuts at Excel\'s cell limit with an exact remainder', () => {
  assert.equal(joinCell([]), '');
  assert.equal(joinCell(['a', 'b']), 'a; b');
  const many = Array.from({ length: 1500 }, (_, k) => `user${String(k).padStart(4, '0')}@example.com`);
  const cut = joinCell(many);
  assert.ok(cut.length <= EXCEL_MAX_CELL_CHARS, String(cut.length));
  const m = cut.match(/… \(\+(\d+) more\)$/);
  assert.ok(m, cut.slice(-40));
  assert.equal(cut.slice(0, cut.lastIndexOf(' …')).split('; ').length + Number(m[1]), 1500);
});

test('dataNamespaces: every namespace but the source one, most common first', () => {
  assert.deepEqual(dataNamespaces(summary, KOC), ['email', 'Email', 'nsid:777', 'phone']);
});

test('sheets, Summary dashboard values and the distinct outside-profile tile', async () => {
  const { wb, res, progress } = await build();
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Summary', REPORT_SHEETS.merged_outside_list, REPORT_SHEETS.merged_in_list]);
  const s = wb.getWorksheet('Summary');
  assert.match(String(s.getCell('A1').value), /Identity Analysis — kocid-oct/);
  assert.equal(s.views[0].showGridLines, false);
  assert.equal(s.pageSetup.orientation, 'landscape');
  const tile = (label) => { const c = findCell(s, label); return s.getCell(c.row + 1, c.col).value; };
  assert.equal(tile('UPLOADED IDS'), 7);
  assert.equal(tile('PROFILES NOT IN YOUR LIST'), 2, 'X is shared by E and F: counted once (the analysis sum says 3)');
  const linked = findCell(s, 'Linked identities');
  assert.equal(s.getCell(linked.row, 3).value, 1);
  assert.ok(Math.abs(s.getCell(linked.row, 4).value - 1 / 7) < 1e-9);
  assert.equal(s.getCell(findCell(s, 'email').row, 3).value, 1504);
  const top = findCell(s, 'TOP 25 LARGEST CLUSTERS');
  assert.equal(s.getCell(top.row + 2, 2).value, 'G');
  assert.equal(s.getCell(findCell(s, 'Sandbox').row, 3).value, 'prod');
  assert.deepEqual([res.rows, res.outsideProfiles, progress.at(-1)], [5, 2, 5]);
});

test('merged sheets: one row per ID, largest first, identities per namespace, text cells, cut long cells', async () => {
  const { wb } = await build();
  const out = wb.getWorksheet(REPORT_SHEETS.merged_outside_list);
  assert.deepEqual(values(out.getRow(1)), ['hashedKocid', 'Category', 'Identities', 'Profiles NOT in list', 'Profiles in list',
    'email', 'Email', 'nsid:777', 'phone', 'Other namespaces']);
  assert.deepEqual([2, 3, 4].map(n => out.getRow(n).getCell(1).value), ['G', 'E', 'F']);
  const e = out.getRow(3);
  assert.deepEqual([e.getCell(4).value, e.getCell(5).value ?? '', e.getCell(6).value], ['X', '', 'e1@x.com; e2@x.com']);
  assert.equal(e.getCell(7).value, 'Line1\nLine2 "q"', 'stored verbatim');
  assert.equal(e.getCell(9).value, '=cmd');
  assert.equal(e.getCell(9).type, ExcelJS.ValueType.String, 'a formula-looking value is text, never a formula');
  const f = out.getRow(4);
  assert.equal(f.getCell(8).value, 'n-1');
  assert.equal(f.getCell(10).value, 'crm: not-in-summary', 'a namespace missing from the summary is never dropped');
  const g = out.getRow(2).getCell(6).value;
  assert.ok(g.length <= EXCEL_MAX_CELL_CHARS && /more\)$/.test(g));
  assert.equal(out.views[0].state, 'frozen');
  assert.equal(out.getRow(3).getCell(1).font?.name, 'Arial', 'data cells use a font every viewer has (not the Office-only default)');
  assert.equal(out.getRow(3).getCell(6).font?.name, 'Arial');
  assert.ok(out.autoFilter);
  const inl = wb.getWorksheet(REPORT_SHEETS.merged_in_list);
  assert.deepEqual([inl.getRow(2).getCell(1).value, inl.getRow(2).getCell(5).value], ['C', 'D']);
  for (const ws of [out, inl]) ws.eachRow((row, n) => {
    if (n > 1) for (const c of [4, 5]) assert.ok(!String(row.getCell(c).value ?? '').split('; ').includes(row.getCell(1).value), 'never its own ID');
  });
});

test('a category longer than a sheet continues on "(2)"; an empty category gets a note row', async () => {
  const split = await build({ maxRowsPerSheet: 2 });
  assert.deepEqual(split.wb.worksheets.map(w => w.name),
    ['Summary', REPORT_SHEETS.merged_outside_list, `${REPORT_SHEETS.merged_outside_list} (2)`, REPORT_SHEETS.merged_in_list]);
  assert.equal(split.wb.getWorksheet(`${REPORT_SHEETS.merged_outside_list} (2)`).getRow(2).getCell(1).value, 'F');
  assert.ok(`${REPORT_SHEETS.merged_outside_list} (10)`.length <= 31);
  const filename = path.join(dir, 'empty.xlsx');
  await writeAnalysisWorkbook({ filename, meta, summary, sourceNs: KOC,
    readers: readersFor({ merged_outside_list: analysisRows.merged_outside_list, merged_in_list: [] }) });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filename);
  assert.equal(wb.getWorksheet(REPORT_SHEETS.merged_in_list).getRow(2).getCell(1).value, 'No uploaded IDs in this category.');
});

test('rows stream to the file as they are written — memory never holds the whole sheet', async () => {
  // ~40k merged IDs with ~1.5 KB of identities each (~60 MB of sheet XML). Before
  // the fix nothing was compressed or written until the final commit, so the
  // worker held every row in memory (~1 GB at 0.9M rows).
  const N = 40_000;
  const big = { merged_outside_list: [], merged_in_list: [] };
  const ids = {};
  for (let i = 0; i < N; i++) {
    const s = `s${String(i).padStart(7, '0')}${'0123456789abcdef'.repeat(3)}`;
    big.merged_in_list.push(sa(s, 'merged_in_list', 12, 0));
    ids[s] = [r('hashedKocid', 5000, s), r('hashedKocid', 5000, `p${i}`),
      ...Array.from({ length: 10 }, (_, k) => r('email', 6,
        `${createHash('md5').update(`${i}:${k}`).digest('hex')}.${createHash('md5').update(`${k}:${i}`).digest('hex')}@example.com`))];
  }
  const filename = path.join(dir, 'stream.xlsx');
  let sizeAtLastProgress = 0;
  const readers = {
    async *categoryChunks(cat) { const list = big[cat]; for (let i = 0; i < list.length; i += 500) yield list.slice(i, i + 500); },
    identitiesOf: (s) => ids[s] || [],
    isInList: () => true,
    topClusters: () => [],
  };
  await writeAnalysisWorkbook({ filename, meta, summary, sourceNs: KOC, readers,
    onProgress: (n) => { if (n === N) { try { sizeAtLastProgress = fs.statSync(filename).size; } catch { sizeAtLastProgress = 0; } } } });
  const finalSize = fs.statSync(filename).size;
  assert.ok(sizeAtLastProgress >= finalSize * 0.6,
    `only ${sizeAtLastProgress} of ${finalSize} bytes reached the file before the final commit`);
});
