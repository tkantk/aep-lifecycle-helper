/**
 * Worker thread that writes the expanded-identities CSV (2026-10-06; background
 * build with progress 2026-10-09).
 *
 * The export lists each distinct identity once, by its first source, so SQLite
 * groups EVERY stored row of the job before it returns the first one — minutes
 * on a 36M-row job. Done on the main thread that froze the whole server, so it
 * runs here, on its own read-only connection, and writes the file; the main
 * thread only sends it. The grouping sorts ON DISK (temp_store = FILE): in RAM
 * it cost ~+1.1 GB per 1M uploaded IDs (~6 GB at 6.8M) on the laptop the
 * browser runs on — and was slower (measured 2026-10-09).
 *
 * Messages: {type:'progress', rowsDone} · {type:'done', rows} · {type:'error', error}.
 * Imports nothing that opens the app database (no db.js / config.js).
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { writeCsv } from '../utils/csv.js';
import { IDENTITY_EXPORT_HEADERS, identityExportRecords } from '../utils/identityExportFormat.js';

const { dbPath, jobId, outPath, sql } = workerData;
const PROGRESS_EVERY = 25_000;
let conn = null;
try {
  conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  conn.pragma('cache_size = -65536');      // 64 MB: a sequential read needs little cache
  conn.pragma('temp_store = FILE');        // the GROUP BY sorts on disk — see above
  let rows = 0;
  function* counted(records) {
    for (const r of records) {
      rows++;
      if (rows === 1 || rows % PROGRESS_EVERY === 0) parentPort.postMessage({ type: 'progress', rowsDone: rows });
      yield r;
    }
  }
  await writeCsv(outPath, IDENTITY_EXPORT_HEADERS, counted(identityExportRecords(conn.prepare(sql).iterate(jobId))));
  parentPort.postMessage({ type: 'done', rows });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* already closed */ }
}
