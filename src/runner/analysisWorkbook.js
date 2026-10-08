import ExcelJS from 'exceljs';
import { describeSourceIdentities, sourceNsMatcher } from './analysisCore.js';

/**
 * The identity-analysis Excel report (2026-10-07): a "Summary" dashboard sheet in
 * Adobe colours, then one sheet per merged category listing every uploaded ID with
 * all of its identities in ONE row (one column per namespace), and one-column lists
 * of the uploaded IDs not found in AEP / with no reply from AEP (2026-10-08). Streamed with
 * ExcelJS (rows are written and released as they go); runs in a worker thread
 * (analysisReportWorker.js), so it must not import db.js / config.js. Identity
 * values are TEXT cells, never formulas. The writer waits for the zip to catch up
 * after every chunk (letZipCatchUp), so memory stays flat at any size.
 */
export const EXCEL_MAX_DATA_ROWS = 1_048_575;   // 1,048,576 rows per sheet incl. the header
export const EXCEL_MAX_CELL_CHARS = 32_767;
// Tab names stay ≤ 31 chars even with an overflow suffix up to " (10)".
export const REPORT_SHEETS = { merged_outside_list: '⚠ Merged · NOT in file', merged_in_list: 'Merged · in file',
  not_found: 'Not found in AEP', no_reply: 'No reply from AEP' };
export const CATEGORY_LABEL = {
  not_found: 'Not found in AEP', source_only: 'Only itself', linked: 'Linked identities',
  merged_in_list: 'Merged with a profile in your file', merged_outside_list: '⚠ Merged with a profile NOT in your file',
};
const CATEGORY_MEANING = {
  not_found: 'AEP has no identities for it — deleted on its own.',
  source_only: 'In AEP, nothing else linked.',
  linked: 'Its own email, ECID, phone… no other profile.',
  merged_in_list: 'That profile is being deleted too.',
  merged_outside_list: "Deleting also removes that profile's identities.",
};
// An analysis built before "Not found in AEP" existed (no not_found key): those IDs
// are still counted under "Only itself" — say so rather than show 0 (final review #4).
const legacyAnalysis = (summary) => !Object.prototype.hasOwnProperty.call(summary.byCategory || {}, 'not_found');
const LEGACY_NOT_FOUND = 'This analysis was built before "Not found in AEP" existed — rebuild the analysis, then this report, to see these IDs.';
const NO_REPLY_LABEL = 'No reply from AEP';
const NO_REPLY_MEANING = "AEP didn't answer for it, even when asked again — not in the plan.";
const ORDER = ['not_found', 'source_only', 'linked', 'merged_in_list', 'merged_outside_list'];
const COLOR = { navy: 'FF000B1D', red: 'FFFA0F00', blue: 'FF1473E6', purple: 'FF9256D9', orange: 'FFE68619',
  grey50: 'FFF5F5F5', grey200: 'FFE1E1E1', grey500: 'FF8E8E8E', grey600: 'FF6E6E6E', grey700: 'FF4B4B4B', ink: 'FF1F1F1F', white: 'FFFFFFFF' };
const CATEGORY_COLOR = { not_found: COLOR.grey700, source_only: COLOR.grey500, linked: COLOR.blue, merged_in_list: COLOR.purple, merged_outside_list: COLOR.orange };
const CATEGORY_TINT = { not_found: 'FFEAEAEA', source_only: 'FFF0F0F0', linked: 'FFE8F1FC', merged_in_list: 'FFF2EBFA', merged_outside_list: 'FFFCEFE2' };
const BAR = 20;                                   // cells per in-cell bar
const FIRST_BAR = 5, LAST_COL = 26;               // E..X = bar, Z = notes
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
// Arial: sans-serif in every viewer (Calibri ships only with Office — elsewhere it falls back to a serif).
const font = (o = {}) => ({ name: 'Arial', size: 10, color: { argb: COLOR.ink }, ...o });
// Bytes of a streaming sheet not yet compressed into the file: still in ExcelJS's
// own buffers (the zip hasn't reached this entry yet) or queued on the zip's input.
// ExcelJS hands data on without back-pressure, so the writer waits on this.
function pendingBytes(ws) {
  const s = ws.stream;
  let n = 0;
  for (const b of s.buffers || []) n += b.length || 0;
  // archiver feeds the zip through readable-stream's PassThrough, which has no
  // writableLength/readableLength getters — read its stream state directly.
  for (const p of s.pipes || []) {
    n += (p.writableLength ?? p._writableState?.length ?? 0) + (p.readableLength ?? p._readableState?.length ?? 0);
  }
  return n;
}
const ZIP_BACKLOG = 8 * 1024 * 1024;
/** Let the zip compress and write what we've produced before producing more —
 *  memory stays flat however many rows there are. */
async function letZipCatchUp(ws) {
  await new Promise(resolve => setImmediate(resolve));
  while (pendingBytes(ws) > ZIP_BACKLOG) await new Promise(resolve => setTimeout(resolve, 5));
}

const scopeText = (s) => (s === 'source_only' ? 'Plan: uploaded IDs only'
  : s === 'cluster' ? 'Plan: uploaded IDs + linked identities' : 'Plan: not planned yet');

/** Values for one cell joined with "; ", cut to Excel's limit ending "… (+N more)". */
export function joinCell(values, limit = EXCEL_MAX_CELL_CHARS) {
  if (!values.length) return '';
  const full = values.join('; ');
  if (full.length <= limit) return full;
  let out = '';
  for (let i = 0; i < values.length; i++) {
    const candidate = out ? `${out}; ${values[i]}` : values[i];
    if (candidate.length + ` … (+${values.length - i - 1} more)`.length > limit) {
      const marker = `… (+${values.length - i} more)`;
      return out ? `${out} ${marker}` : marker;
    }
    out = candidate;
  }
  return out;
}

/** Namespace columns of the data sheets: the analysis's namespaces, most common first, minus the source namespace. */
export function dataNamespaces(summary, sourceNs) {
  const srcKey = sourceNsMatcher(sourceNs).key;
  return Object.entries(summary.byNamespace || {})
    .filter(([k]) => k !== srcKey)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k]) => k);
}

function writeSummary(wb, { meta, summary, outsideProfiles, topClusters }) {
  const ws = wb.addWorksheet('Summary', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    properties: { tabColor: { argb: COLOR.red } },
  });
  ws.columns = [{ width: 2 }, { width: 30 }, { width: 15 }, { width: 9 },
    ...Array.from({ length: BAR }, () => ({ width: 1.4 })), { width: 2 }, { width: 56 }];
  let row = 0;
  const style = (cell, s) => { Object.assign(cell, s); return cell; };
  const span = (r, c1, c2, value, s = {}) => {
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    return style(ws.getCell(r, c1), { value, ...s });
  };
  const paint = (r, c1, c2, s) => { for (let c = c1; c <= c2; c++) style(ws.getCell(r, c), s); };
  const pct = (n, d) => (d > 0 ? n / d : 0);
  const bar = (r, share, argb) => {
    const filled = share > 0 ? Math.max(1, Math.round(share * BAR)) : 0;
    for (let i = 0; i < BAR; i++) ws.getCell(r, FIRST_BAR + i).fill = solid(i < filled ? argb : COLOR.grey50);
  };
  const section = (title) => {
    row += 2;
    span(row, 2, LAST_COL, title, { font: font({ size: 11, bold: true, color: { argb: COLOR.navy } }) });
    paint(row, 2, LAST_COL, { border: { bottom: { style: 'thin', color: { argb: COLOR.grey200 } } } });
  };
  const head = (labels) => {
    row++;
    for (const [c, text] of labels) ws.getCell(row, c).value = text;
    paint(row, 2, LAST_COL, { font: font({ size: 9, bold: true, color: { argb: COLOR.grey600 } }) });
  };

  // Title band (navy) + Adobe-red stripe + context lines.
  ws.mergeCells(1, 1, 2, LAST_COL);
  style(ws.getCell(1, 1), { value: `Identity Analysis — ${meta.jobName}`, fill: solid(COLOR.navy),
    font: font({ size: 18, bold: true, color: { argb: COLOR.white } }), alignment: { vertical: 'middle', indent: 1 } });
  ws.getRow(1).height = 22; ws.getRow(2).height = 22;
  ws.mergeCells(3, 1, 3, LAST_COL);               // one seamless Adobe-red stripe
  ws.getCell(3, 1).fill = solid(COLOR.red);
  ws.getRow(3).height = 4;
  span(4, 2, LAST_COL, `Sandbox ${meta.sandbox} · ${meta.sourceNamespace} · Expansion ${meta.expansionMode === 'none' ? 'Off' : 'On'} · ${scopeText(meta.deleteScope)}`,
    { font: font({ color: { argb: COLOR.grey600 } }) });
  span(5, 2, LAST_COL, `Analysis built ${meta.analysisBuiltAt} · Report generated ${meta.generatedAt}`,
    { font: font({ size: 9, color: { argb: COLOR.grey600 } }) });

  // Tiles (rows 7-9). "Asked" = every uploaded ID Adobe was asked about: the
  // analysed ones plus those it never answered for (no reply, 2026-10-08).
  const notFound = summary.byCategory.not_found || 0, noReply = summary.noReply || 0, asked = summary.sources + noReply;
  const tiles = [
    [2, 2, 'UPLOADED IDS', asked, notFound || noReply
      ? `${notFound.toLocaleString('en-US')} not found · ${noReply.toLocaleString('en-US')} no reply` : 'analysed', COLOR.navy],
    [3, 4, 'DISTINCT IDENTITIES', summary.identities, 'in their clusters', COLOR.blue],
    [5, 24, '⚠ MERGED · NOT IN FILE', summary.byCategory.merged_outside_list || 0, 'uploaded IDs', COLOR.orange],
    [26, 26, 'PROFILES NOT IN YOUR FILE', outsideProfiles, 'distinct — also deleted with linked identities', COLOR.orange],
  ];
  for (const [c1, c2, label, value, sub, argb] of tiles) {
    for (let r = 7; r <= 9; r++) paint(r, c1, c2, { fill: solid(COLOR.grey50) });
    paint(7, c1, c2, { border: { top: { style: 'thick', color: { argb } } } });
    span(7, c1, c2, label, { font: font({ size: 9, bold: true, color: { argb: COLOR.grey600 } }), fill: solid(COLOR.grey50),
      border: { top: { style: 'thick', color: { argb } } }, alignment: { indent: 1 } });
    span(8, c1, c2, value, { numFmt: '#,##0', fill: solid(COLOR.grey50), alignment: { horizontal: 'left', indent: 1 },
      font: font({ size: 20, bold: true, color: { argb: argb === COLOR.orange && value > 0 ? COLOR.orange : COLOR.ink } }) });
    span(9, c1, c2, sub, { font: font({ size: 9, color: { argb: COLOR.grey600 } }), fill: solid(COLOR.grey50), alignment: { indent: 1 } });
  }
  ws.getRow(8).height = 28;
  row = 9;

  section('CATEGORIES');
  head([[2, 'Category'], [3, 'Uploaded IDs'], [4, '%'], [26, 'What it means']]);
  for (const cat of ORDER) {
    row++;
    const n = summary.byCategory[cat] || 0;
    style(ws.getCell(row, 2), { value: CATEGORY_LABEL[cat], font: font({ bold: true, color: { argb: CATEGORY_COLOR[cat] } }) });
    if (cat === 'not_found' && legacyAnalysis(summary)) {
      style(ws.getCell(row, 3), { value: '—', font: font(), alignment: { horizontal: 'right' } });
      style(ws.getCell(row, 26), { value: LEGACY_NOT_FOUND, font: font({ color: { argb: COLOR.grey600 } }) });
      continue;
    }
    style(ws.getCell(row, 3), { value: n, numFmt: '#,##0', font: font() });
    style(ws.getCell(row, 4), { value: pct(n, asked), numFmt: '0.0%', font: font() });
    bar(row, pct(n, asked), CATEGORY_COLOR[cat]);
    style(ws.getCell(row, 26), { value: CATEGORY_MEANING[cat], font: font({ color: { argb: COLOR.grey600 } }) });
  }
  if (noReply > 0) {
    row++;
    style(ws.getCell(row, 2), { value: NO_REPLY_LABEL, font: font({ bold: true, color: { argb: COLOR.red } }) });
    style(ws.getCell(row, 3), { value: noReply, numFmt: '#,##0', font: font() });
    style(ws.getCell(row, 4), { value: pct(noReply, asked), numFmt: '0.0%', font: font() });
    bar(row, pct(noReply, asked), COLOR.red);
    style(ws.getCell(row, 26), { value: NO_REPLY_MEANING, font: font({ color: { argb: COLOR.grey600 } }) });
  }

  const srcKey = meta.sourceNamespace;
  const nsRows = Object.entries(summary.byNamespace || {}).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const nsTotal = nsRows.reduce((t, [, n]) => t + n, 0);
  section('NAMESPACES');
  head([[2, 'Namespace'], [3, 'Identities'], [4, '%'], [26, 'Identities linked to the uploaded IDs, per namespace']]);
  for (const [ns, n] of nsRows) {
    row++;
    style(ws.getCell(row, 2), { value: ns === srcKey ? `${ns} (other profiles)` : ns, font: font() });
    style(ws.getCell(row, 3), { value: n, numFmt: '#,##0', font: font() });
    style(ws.getCell(row, 4), { value: pct(n, nsTotal), numFmt: '0.0%', font: font() });
    bar(row, pct(n, nsTotal), COLOR.blue);
  }

  section('TOP 25 LARGEST CLUSTERS');
  head([[2, 'Uploaded ID'], [5, 'Category'], [26, 'Identities · profiles NOT in your file']]);
  for (const t of topClusters) {
    row++;
    span(row, 2, 4, t.source_id, { font: font({ size: 9 }) });
    span(row, 5, 24, CATEGORY_LABEL[t.category] || t.category, { font: font({ color: { argb: CATEGORY_COLOR[t.category] || COLOR.ink } }) });
    style(ws.getCell(row, 26), { value: `${t.identities_total.toLocaleString('en-US')} identities · ${(t.other_not_in_list || 0).toLocaleString('en-US')} NOT in your file`, font: font() });
  }

  section('JOB DETAILS');
  for (const [label, value] of [
    ['Job ID', meta.jobId], ['Job name', meta.jobName], ['Created', meta.createdAt], ['Sandbox', meta.sandbox],
    ['Source namespace', meta.sourceNamespace], ['Identity expansion', meta.expansionMode === 'none' ? 'Off — uploaded IDs only' : 'On — Identity Graph'],
    ['Plan (when generated)', scopeText(meta.deleteScope).replace('Plan: ', '')], ['Uploaded IDs (file rows)', meta.totalSourceIds],
    ['Distinct identities', meta.foundCount], ['No reply from AEP (not in plan)', noReply],
    ['Analysis built', meta.analysisBuiltAt], ['Report generated', meta.generatedAt],
  ]) {
    row++;
    style(ws.getCell(row, 2), { value: label, font: font({ color: { argb: COLOR.grey600 } }) });
    span(row, 3, LAST_COL, value ?? '—', { font: font(), alignment: { horizontal: 'left' },
      ...(typeof value === 'number' ? { numFmt: '#,##0' } : {}) });
  }

  section('HOW TO READ THIS');
  for (const cat of ORDER) {
    row++;
    style(ws.getCell(row, 2), { value: CATEGORY_LABEL[cat], font: font({ bold: true, color: { argb: CATEGORY_COLOR[cat] } }) });
    span(row, 3, LAST_COL, CATEGORY_MEANING[cat], { font: font() });
  }
  if (noReply > 0) {                              // explains a row that exists
    row++;
    style(ws.getCell(row, 2), { value: NO_REPLY_LABEL, font: font({ bold: true, color: { argb: COLOR.red } }) });
    span(row, 3, LAST_COL, NO_REPLY_MEANING, { font: font() });
  }
  row++;
  span(row, 3, LAST_COL, "Deleting with linked identities removes every identity in each uploaded ID's cluster — including profiles NOT in your file.",
    { font: font({ bold: true, color: { argb: COLOR.orange } }) });
  ws.commit();
}

async function writeCategorySheets(wb, { category, meta, namespaces, readers, describe, maxRowsPerSheet, progress }) {
  const title = REPORT_SHEETS[category];
  const headers = [meta.sourceNamespace, 'Category', 'Identities', 'Profiles NOT in your file', 'Profiles in your file', ...namespaces, 'Other namespaces'];
  const columns = new Set(namespaces);
  let part = 0, inSheet = 0, total = 0, ws = null;
  const open = () => {
    part++;
    ws = wb.addWorksheet(part === 1 ? title : `${title} (${part})`, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
      properties: { tabColor: { argb: CATEGORY_COLOR[category] } },
    });
    ws.columns = headers.map((h, i) => ({ header: h, width: i === 0 ? 66 : i === 1 ? 24 : i === 2 ? 11 : i < 5 ? 40 : 34 }));
    const head = ws.getRow(1);
    head.font = font({ bold: true, color: { argb: COLOR.white } });
    head.fill = solid(COLOR.navy);
    head.height = 20;
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    head.commit();
    inSheet = 0;
  };
  open();
  for await (const chunk of readers.categoryChunks(category)) {
    for (const r of chunk) {
      if (inSheet === maxRowsPerSheet) { ws.commit(); open(); }
      const outside = [], inList = [], other = [], byNs = new Map();
      for (const i of describe(r.source_id)) {
        if (i.relation === 'other_profile') (i.inList ? inList : outside).push(i.value);
        else if (i.relation === 'linked') {
          const k = i.namespace || (i.nsid != null ? `nsid:${i.nsid}` : 'unknown');
          if (!columns.has(k)) { other.push(`${k}: ${i.value}`); continue; }
          if (!byNs.has(k)) byNs.set(k, []);
          byNs.get(k).push(i.value);
        }
      }
      const added = ws.addRow([r.source_id, CATEGORY_LABEL[r.category] || r.category, r.identities_total,
        joinCell(outside), joinCell(inList), ...namespaces.map(k => joinCell(byNs.get(k) || [])), joinCell(other)]);
      added.font = font();                                   // never the Office-only default font
      added.getCell(2).fill = solid(CATEGORY_TINT[category]);
      added.getCell(2).font = font({ color: { argb: CATEGORY_COLOR[category] } });
      added.commit();
      inSheet++; total++;
    }
    await letZipCatchUp(ws);
    progress(chunk.length);
  }
  if (total === 0) {
    const note = ws.addRow(['No uploaded IDs in this category.']);
    note.font = font({ italic: true, color: { argb: COLOR.grey600 } });
    note.commit();
  }
  ws.commit();
  return total;
}

/** A one-column list of uploaded IDs (Not found in AEP · No reply from AEP), continued on "(2)". */
async function writeListSheet(wb, { title, header, argb, chunks, maxRowsPerSheet, progress, emptyNote }) {
  let part = 0, inSheet = 0, total = 0, ws = null;
  const open = () => {
    part++;
    ws = wb.addWorksheet(part === 1 ? title : `${title} (${part})`, {
      views: [{ state: 'frozen', ySplit: 1 }], properties: { tabColor: { argb } },
    });
    ws.columns = [{ header, width: 66 }];
    const head = ws.getRow(1);
    head.font = font({ bold: true, color: { argb: COLOR.white } });
    head.fill = solid(COLOR.navy);
    head.height = 20;
    head.commit();
    inSheet = 0;
  };
  open();
  for await (const chunk of chunks) {
    for (const r of chunk) {
      if (inSheet === maxRowsPerSheet) { ws.commit(); open(); }
      const added = ws.addRow([r.source_id]);
      added.font = font();
      added.commit();
      inSheet++; total++;
    }
    await letZipCatchUp(ws);
    progress(chunk.length);
  }
  if (total === 0 && emptyNote) {
    const note = ws.addRow([emptyNote]);
    note.font = font({ italic: true, color: { argb: COLOR.grey600 } });
    note.commit();
  }
  ws.commit();
  return total;
}

export async function writeAnalysisWorkbook({ filename, meta, summary, sourceNs, readers,
  maxRowsPerSheet = EXCEL_MAX_DATA_ROWS, onProgress = () => {} }) {
  const describe = (sourceId) => describeSourceIdentities({ sourceId, sourceNs, rows: readers.identitiesOf(sourceId), isInList: readers.isInList });
  // First pass: distinct profiles outside the upload (the analysis total is a sum per uploaded ID).
  const outside = new Set();
  for await (const chunk of readers.categoryChunks('merged_outside_list')) {
    for (const r of chunk) for (const i of describe(r.source_id)) if (i.relation === 'other_profile' && !i.inList) outside.add(i.value);
  }
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: true, useSharedStrings: false });
  wb.creator = 'AEP Data Lifecycle Helper';
  writeSummary(wb, { meta, summary, outsideProfiles: outside.size, topClusters: readers.topClusters(25) });
  const namespaces = dataNamespaces(summary, sourceNs);
  let rows = 0;
  const progress = (n) => { rows += n; onProgress(rows); };
  for (const category of ['merged_outside_list', 'merged_in_list']) {
    await writeCategorySheets(wb, { category, meta, namespaces, readers, describe, maxRowsPerSheet, progress });
  }
  await writeListSheet(wb, { title: REPORT_SHEETS.not_found, header: meta.sourceNamespace, argb: CATEGORY_COLOR.not_found,
    chunks: readers.categoryChunks('not_found'), maxRowsPerSheet, progress,
    emptyNote: legacyAnalysis(summary) ? LEGACY_NOT_FOUND : 'No uploaded ID came back from AEP with no identities.' });
  if ((summary.noReply || 0) > 0) {
    await writeListSheet(wb, { title: REPORT_SHEETS.no_reply, header: meta.sourceNamespace, argb: COLOR.red,
      chunks: readers.noReplyChunks(), maxRowsPerSheet, progress });
  }
  await wb.commit();
  return { rows, outsideProfiles: outside.size };
}
