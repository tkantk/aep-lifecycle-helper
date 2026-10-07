/**
 * Worker thread for GET /api/jobs/:id/export (2026-10-06 final review).
 *
 * The export lists each distinct identity once, by its first source, so SQLite
 * groups EVERY stored row of the job before it returns the first one — minutes
 * on a 36M-row job. Done on the main thread that froze the whole server (a
 * running submission's Adobe responses, the monitor, the UI) long enough for
 * request timeouts to fire. Here it runs on its own read-only connection and
 * writes the file; the main thread only sends it.
 *
 * Imports nothing that opens the app database (no db.js / config.js).
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { writeCsv } from '../utils/csv.js';
import { IDENTITY_EXPORT_HEADERS, identityExportRecords } from '../utils/identityExportFormat.js';

const { dbPath, jobId, outPath, sql } = workerData;
let conn = null;
try {
  conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  conn.pragma('cache_size = -65536');      // 64 MB: a sequential read needs little cache
  conn.pragma('temp_store = MEMORY');      // as the main connection (the GROUP BY's temp B-tree)
  await writeCsv(outPath, IDENTITY_EXPORT_HEADERS, identityExportRecords(conn.prepare(sql).iterate(jobId)));
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* already closed */ }
}
