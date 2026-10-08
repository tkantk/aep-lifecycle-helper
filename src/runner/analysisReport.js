import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { resolveSourceNamespace } from './analysisCore.js';

/**
 * The identity-analysis Excel report (2026-10-07): built on demand in a worker
 * thread (analysisReportWorker.js), kept in data/output until the analysis is
 * rebuilt or the job deleted, and only ever served for the analysis it was built
 * from. One build runs at a time across the app (measured at 6.8M uploaded IDs /
 * 894,724 merged rows: 7.2 min, +151 MB process memory, a 240 MB file).
 */
let running = null;      // { jobId, worker, rowsDone, rowsTotal, settled, discarded }

function httpError(Cls, status, code, message) {
  const e = new Cls(message); e.status = status; e.code = code; e.publicMessage = message; return e;
}
export class ReportAnalysisNotReadyError extends Error {}
export class ReportBuildingError extends Error {}
export class ReportBusyError extends Error {}

export const reportPath = (jobId) => path.join(config.outputDir, `job_${jobId}_analysis.xlsx`);
const tmpPath = (jobId) => `${reportPath(jobId)}.tmp`;
const removeFiles = (jobId) => {
  for (const p of [reportPath(jobId), tmpPath(jobId)]) {
    try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') logger.warn({ jobId, err: e.message }, 'report cleanup failed'); }
  }
};
const utc = (s) => (s ? `${String(s).slice(0, 16)} UTC` : '—');

// What the job's plan deletes, as the app's badges show it: a NULL delete_scope
// on a job that has a plan means it was planned before scopes existed — i.e.
// uploaded IDs + linked identities. Never "not planned" for a job that shipped.
const PLANNED_STATUSES = new Set(['ready', 'submitting', 'submitted', 'partial']);
function effectiveScope(job) {
  if (job.delete_scope) return job.delete_scope;
  return (job.planned_orders || 0) > 0 || PLANNED_STATUSES.has(job.status) ? 'cluster' : null;
}

export function reportDownloadName(job) {
  const base = String(job.name || job.id).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || job.id;
  return `${base}_identity_analysis.xlsx`;
}

/** The report for the job's CURRENT analysis — absent if built from an older one or its file is gone. */
export function reportState(jobId) {
  const a = q().getJobAnalysis.get(jobId);
  if (!a || !a.report_status) return { status: null };
  if (a.report_status === 'ready' && (a.report_built_for !== a.finished_at || !fs.existsSync(reportPath(jobId)))) {
    q().clearReport.run(jobId);
    return { status: null };
  }
  const live = running && running.jobId === jobId ? running : null;
  return { status: a.report_status, rowsDone: live ? live.rowsDone : a.report_rows_done, rowsTotal: a.report_rows_total,
    bytes: a.report_bytes, finishedAt: a.report_finished_at, error: a.report_error };
}

export function startAnalysisReport(jobId, { rebuild = false, maxRowsPerSheet } = {}) {
  const job = q().getJob.get(jobId);
  const a = q().getJobAnalysis.get(jobId);
  if (!job || !a || a.status !== 'ready' || !a.summary_json) {
    throw httpError(ReportAnalysisNotReadyError, 409, 'analysis_not_ready', 'Build the identity analysis first — the Excel report is made from it.');
  }
  if (running) {
    throw running.jobId === jobId
      ? httpError(ReportBuildingError, 409, 'report_building', 'The Excel report for this job is already being built.')
      : httpError(ReportBusyError, 409, 'report_busy', "Another job's Excel report is being built — try again when it finishes.");
  }
  const current = reportState(jobId);
  if (current.status === 'ready' && !rebuild) return current;

  const summary = JSON.parse(a.summary_json);
  const rowsTotal = (summary.byCategory.merged_outside_list || 0) + (summary.byCategory.merged_in_list || 0)
    + (summary.byCategory.not_found || 0) + (summary.noReply || 0);
  removeFiles(jobId);
  q().startReport.run({ jobId, rowsTotal, builtFor: a.finished_at });
  const sourceNs = resolveSourceNamespace(job, job.source_namespace_id == null ? q().sourceRowNamespace.get(job.id) : undefined);
  const meta = { jobId: job.id, jobName: job.name || job.id, createdAt: utc(job.created_at), sandbox: job.sandbox_name,
    sourceNamespace: job.source_namespace, expansionMode: job.expansion_mode, deleteScope: effectiveScope(job),
    totalSourceIds: job.total_source_ids, foundCount: job.found_count, analysisBuiltAt: utc(a.finished_at),
    generatedAt: utc(new Date().toISOString().replace('T', ' ')) };
  const worker = new Worker(new URL('./analysisReportWorker.js', import.meta.url), {
    workerData: { dbPath: config.dbPath, jobId, tmpPath: tmpPath(jobId), meta, summary, sourceNs, maxRowsPerSheet },
  });
  const run = { jobId, worker, rowsDone: 0, rowsTotal, settled: false, discarded: false };
  running = run;
  const finish = (err) => {
    if (run.settled) return;
    run.settled = true;
    if (running === run) running = null;
    if (run.discarded) return;
    if (err) {
      removeFiles(jobId);
      q().failReport.run(String(err.message || err).slice(0, 500), jobId);
      logger.warn({ jobId, err: err.message }, 'analysis report build failed');
      return;
    }
    try {
      fs.renameSync(tmpPath(jobId), reportPath(jobId));
      q().finishReport.run({ jobId, rowsDone: run.rowsDone, bytes: fs.statSync(reportPath(jobId)).size });
      logger.info({ jobId, rows: run.rowsDone }, 'analysis report built');
    } catch (e) {
      removeFiles(jobId);
      q().failReport.run(String(e.message).slice(0, 500), jobId);
    }
  };
  worker.on('message', (m) => {
    if (m?.type === 'progress') run.rowsDone = m.rowsDone;
    else if (m?.type === 'done') { run.rowsDone = m.rows; finish(null); }
    else if (m?.type === 'error') finish(new Error(m.error));
  });
  worker.once('error', finish);
  worker.once('exit', (code) => finish(code === 0 ? null : new Error(`report worker exited with code ${code}`)));
  return reportState(jobId);
}

/** Stop any build for the job and remove its report (the analysis is being rebuilt, or the job deleted). */
export function discardAnalysisReport(jobId) {
  if (running && running.jobId === jobId) {
    const run = running;
    run.discarded = true;
    running = null;
    run.worker.terminate().then(() => removeFiles(jobId), () => removeFiles(jobId));
  }
  removeFiles(jobId);
  try { q().clearReport.run(jobId); } catch { /* the analysis row may be gone with its job */ }
}

/** Startup: a build still 'building' died with the previous process. */
export function markInterruptedReports() {
  for (const { job_id } of q().listBuildingReports.all()) removeFiles(job_id);
  return q().markInterruptedReportsFailed.run().changes;
}
