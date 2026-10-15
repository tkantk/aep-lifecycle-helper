/**
 * Worker thread that writes the identity-analysis Excel report (2026-10-07) on
 * its own READ-ONLY connection, so the server never pauses. An analysis built
 * before the distinct counts existed (2026-10-14) is counted here first — that
 * sorts every stored row of the job, so it sorts on disk (temp_store = FILE) —
 * and the counts go back to the main thread with 'done'. Imports nothing that
 * opens the app database. Messages: {type:'phase', phase:'counting'} ·
 * {type:'progress', rowsDone} · {type:'done', rows, distinct?} · {type:'error', error}.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { makeAnalysisReaders } from './analysisReaders.js';
import { writeAnalysisWorkbook } from './analysisWorkbook.js';

const { dbPath, jobId, tmpPath, meta, summary, sourceNs, maxRowsPerSheet } = workerData;
let conn = null;
try {
  conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  conn.pragma('cache_size = -65536');
  conn.pragma('temp_store = FILE');
  const res = await writeAnalysisWorkbook({ filename: tmpPath, meta, summary, sourceNs,
    readers: makeAnalysisReaders(conn, jobId),
    maxRowsPerSheet: maxRowsPerSheet || undefined,
    onPhase: (phase) => parentPort.postMessage({ type: 'phase', phase }),
    onProgress: (rowsDone) => parentPort.postMessage({ type: 'progress', rowsDone }) });
  parentPort.postMessage({ type: 'done', rows: res.rows, ...(summary.distinct || !res.distinct ? {} : { distinct: res.distinct }) });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* already closed */ }
}
