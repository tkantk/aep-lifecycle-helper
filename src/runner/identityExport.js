import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { openReadConnection, prepareStreamIdentitiesBySource, STREAM_IDENTITIES_BY_SOURCE_SQL } from '../db.js';
import { writeCsv } from '../utils/csv.js';
import { IDENTITY_EXPORT_HEADERS, identityExportRecords } from '../utils/identityExportFormat.js';

/**
 * Write a job's expanded-identities CSV (each distinct identity once, under its
 * first source, ordered by source then namespace) to `outPath`.
 *
 * Runs in a worker thread (identityExportWorker.js) so SQLite's job-wide
 * grouping — minutes on a 36M-row job — never blocks the event loop, and on its
 * own read-only connection so it never holds the main connection's statements
 * (better-sqlite3 refuses writes on a connection with an open iterator). An
 * in-memory database has no second connection: it exports in-process.
 */
export function exportIdentitiesCsv({ jobId, outPath }) {
  if (config.dbPath === ':memory:') return exportInProcess({ jobId, outPath });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./identityExportWorker.js', import.meta.url), {
      workerData: { dbPath: config.dbPath, jobId, outPath, sql: STREAM_IDENTITIES_BY_SOURCE_SQL },
    });
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    worker.once('message', (m) => settle(m?.ok ? null : new Error(m?.error || 'identity export failed')));
    worker.once('error', settle);
    worker.once('exit', (code) => settle(code === 0 ? null : new Error(`identity export worker exited with code ${code}`)));
  });
}

async function exportInProcess({ jobId, outPath }) {
  const read = openReadConnection();
  try {
    await writeCsv(outPath, IDENTITY_EXPORT_HEADERS,
      identityExportRecords(prepareStreamIdentitiesBySource(read.conn).iterate(jobId)));
  } finally {
    read.close();
  }
}
