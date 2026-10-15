/**
 * Worker thread that counts the analysis's distinct identities (2026-10-14) on
 * its own READ-ONLY connection: counting each identity once sorts every stored
 * row of the job (33M on a 6.8M-ID job), which on the main thread would pause
 * the server. Sorts on disk (temp_store = FILE). Imports nothing that opens the
 * app database. Messages: {type:'done', distinct} · {type:'error', error}.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { makeAnalysisReaders } from './analysisReaders.js';
import { computeDistinctCounts } from './analysisCounts.js';

const { dbPath, jobId, sourceNs } = workerData;
let conn = null;
try {
  conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  conn.pragma('cache_size = -65536');
  conn.pragma('temp_store = FILE');
  const distinct = await computeDistinctCounts({ readers: makeAnalysisReaders(conn, jobId), sourceNs });
  parentPort.postMessage({ type: 'done', distinct });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* already closed */ }
}
