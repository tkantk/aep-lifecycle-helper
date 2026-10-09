import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { q, openReadConnection, prepareStreamIdentitiesBySource, STREAM_IDENTITIES_BY_SOURCE_SQL } from '../db.js';
import { writeCsv } from '../utils/csv.js';
import { logger } from '../utils/logger.js';
import { IDENTITY_EXPORT_HEADERS, identityExportRecords } from '../utils/identityExportFormat.js';

/**
 * The expanded-identities CSV (each distinct identity once, under its first
 * source, ordered by source then namespace).
 *
 * Built in the BACKGROUND (2026-10-09). The Expansion tab's "Export CSV" used to
 * navigate to GET /export, which built the whole file before sending a byte:
 * the browser waited minutes on a big job. Now POST starts the build in a worker
 * (identityExportWorker.js, own read-only connection, sorting on disk), GET
 * /jobs/:id reports its progress, and GET /export sends the finished file. The
 * file is kept until an expansion run changes the identities or the job is
 * deleted. One build runs at a time across the app.
 */
let running = null;      // { jobId, worker, rowsDone, phase, settled, discarded, waiters }

function httpError(Cls, status, code, message) {
  const e = new Cls(message); e.status = status; e.code = code; e.publicMessage = message; return e;
}
export class ExportNotReadyError extends Error {}
export class ExportBuildingError extends Error {}
export class ExportBusyError extends Error {}
export class ExportFailedError extends Error {}

export const exportPath = (jobId) => path.join(config.outputDir, `job_${jobId}_identities.csv`);
const tmpPath = (jobId) => `${exportPath(jobId)}.tmp`;
const removeFiles = (jobId) => {
  for (const p of [exportPath(jobId), tmpPath(jobId)]) {
    try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') logger.warn({ jobId, err: e.message }, 'export cleanup failed'); }
  }
};

/** The download's file name: the job's name, made file-safe. */
export function exportDownloadName(job) {
  const base = String(job.name || job.id).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || job.id;
  return `${base}_identities.csv`;
}

/** The job's export as the UI shows it: null (none) · building (phase sorting|writing) · ready · failed. */
export function exportState(jobId) {
  const j = q().getJob.get(jobId);
  if (!j || !j.export_status) return { status: null };
  if (j.export_status === 'ready' && !fs.existsSync(exportPath(jobId))) {
    q().clearExport.run(jobId);
    return { status: null };
  }
  const live = running && running.jobId === jobId ? running : null;
  return {
    status: j.export_status,
    phase: live ? live.phase : null,
    rowsDone: live ? live.rowsDone : j.export_rows_done,
    rowsTotal: j.export_rows_total,
    bytes: j.export_bytes,
    finishedAt: j.export_finished_at,
    error: j.export_error,
  };
}

/** Start building the job's export (or return the ready one; `rebuild` builds afresh). */
export function startIdentityExport(jobId, { rebuild = false } = {}) {
  const job = q().getJob.get(jobId);
  if (job?.status === 'expanding') {
    throw httpError(ExportNotReadyError, 409, 'export_not_ready', 'The expansion is still running — export once it has finished.');
  }
  if (running) {
    throw running.jobId === jobId
      ? httpError(ExportBuildingError, 409, 'export_building', 'The CSV for this job is already being built.')
      : httpError(ExportBusyError, 409, 'export_busy', "Another job's CSV is being built — try again when it finishes.");
  }
  const current = exportState(jobId);
  if (current.status === 'ready' && !rebuild) return current;

  removeFiles(jobId);
  q().startExport.run({ jobId, rowsTotal: job?.found_count ?? null });
  const run = { jobId, worker: null, rowsDone: 0, phase: 'sorting', settled: false, discarded: false, waiters: [] };
  running = run;
  const finish = (err) => {
    if (run.settled) return;
    run.settled = true;
    if (running === run) running = null;
    if (!run.discarded) {
      if (err) {
        removeFiles(jobId);
        q().failExport.run(String(err.message || err).slice(0, 500), jobId);
        logger.warn({ jobId, err: err.message }, 'identity export failed');
      } else {
        try {
          fs.renameSync(tmpPath(jobId), exportPath(jobId));
          q().finishExport.run({ jobId, rowsDone: run.rowsDone, bytes: fs.statSync(exportPath(jobId)).size });
          logger.info({ jobId, rows: run.rowsDone }, 'identity export built');
        } catch (e) {
          removeFiles(jobId);
          q().failExport.run(String(e.message).slice(0, 500), jobId);
        }
      }
    }
    for (const w of run.waiters.splice(0)) w();
  };
  if (config.dbPath === ':memory:') {            // no second connection to an in-memory DB: build in-process
    exportInProcess({ jobId, outPath: tmpPath(jobId) })
      .then((rows) => { run.rowsDone = rows; finish(null); }, finish);
    return exportState(jobId);
  }
  run.worker = new Worker(new URL('./identityExportWorker.js', import.meta.url), {
    workerData: { dbPath: config.dbPath, jobId, outPath: tmpPath(jobId), sql: STREAM_IDENTITIES_BY_SOURCE_SQL },
  });
  run.worker.on('message', (m) => {
    if (m?.type === 'progress') { run.rowsDone = m.rowsDone; run.phase = 'writing'; }
    else if (m?.type === 'done') { run.rowsDone = m.rows; finish(null); }
    else if (m?.type === 'error') finish(new Error(m.error));
  });
  run.worker.once('error', finish);
  run.worker.once('exit', (code) => finish(code === 0 ? null : new Error(`export worker exited with code ${code}`)));
  return exportState(jobId);
}

/** Resolves when the job's running build (if any) has settled. */
export function waitForIdentityExport(jobId) {
  if (!running || running.jobId !== jobId) return Promise.resolve();
  return new Promise((resolve) => running.waiters.push(resolve));
}

/** Stop any build for the job and remove its export (an expansion run is changing the identities, or the job is deleted). */
export function discardIdentityExport(jobId) {
  if (running && running.jobId === jobId) {
    const run = running;
    run.discarded = true;
    running = null;
    for (const w of run.waiters.splice(0)) w();
    if (run.worker) run.worker.terminate().then(() => removeFiles(jobId), () => removeFiles(jobId));
  }
  removeFiles(jobId);
  try { q().clearExport.run(jobId); } catch { /* the job may be gone */ }
}

/** Startup: a build still 'building' died with the previous process. */
export function markInterruptedExports() {
  for (const { id } of q().listBuildingExports.all()) removeFiles(id);
  return q().markInterruptedExportsFailed.run().changes;
}

/**
 * One-shot export to `outPath` (kept for an unknown job's GET — unchanged: an
 * empty file — and for in-memory databases). Runs in a worker on its own
 * read-only connection.
 */
export function exportIdentitiesCsv({ jobId, outPath }) {
  if (config.dbPath === ':memory:') return exportInProcess({ jobId, outPath }).then(() => undefined);
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
    worker.on('message', (m) => {
      if (m?.type === 'done') settle(null);
      else if (m?.type === 'error') settle(new Error(m.error || 'identity export failed'));
    });
    worker.once('error', settle);
    worker.once('exit', (code) => settle(code === 0 ? null : new Error(`identity export worker exited with code ${code}`)));
  });
}

async function exportInProcess({ jobId, outPath }) {
  const read = openReadConnection();
  let rows = 0;
  function* counted(records) { for (const r of records) { rows++; yield r; } }
  try {
    await writeCsv(outPath, IDENTITY_EXPORT_HEADERS,
      counted(identityExportRecords(prepareStreamIdentitiesBySource(read.conn).iterate(jobId))));
  } finally {
    read.close();
  }
  return rows;
}
