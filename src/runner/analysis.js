import { performance } from 'node:perf_hooks';
import { q, db } from '../db.js';
import { logger } from '../utils/logger.js';
import { PLANNABLE_JOB_STATUSES } from './submission.js';
import { ANALYSIS_CATEGORIES, classifySource, describeSourceIdentities, resolveSourceNamespace } from './analysisCore.js';
import { discardAnalysisReport } from './analysisReport.js';

// The pure logic lives in analysisCore.js (shared with the Excel-report worker).
export { ANALYSIS_CATEGORIES, classifySource, describeSourceIdentities };

/**
 * Identity analysis (2026-10-06) — a REVIEW-ONLY report of who else is in each
 * uploaded ID's Identity Graph cluster, so the operator can see which uploaded
 * hashedKocids share a cluster with other profiles before deleting.
 *
 * Built from expanded_identities after a cluster expansion, in keyset pages of
 * uploaded IDs. One short transaction per page, then a macrotask yield, so a
 * 6.8M-ID build never blocks the event loop for long and no statement is held
 * across an await. Nothing here reads or writes the job row, its plan or its
 * work orders: a failed build only marks the analysis failed.
 *
 * Definitions (spec §2):
 *   cluster of an uploaded ID  its distinct stored identities (ns + value)
 *   other profile              a cluster identity in the SOURCE namespace that
 *                              is not the uploaded ID itself
 *   in your list               an other profile that is itself an uploaded
 *                              (processed) ID of THIS job
 *   category                   source_only | linked | merged_in_list |
 *                              merged_outside_list (see classifySource)
 */


const PAGE_SIZE = 2000;          // most uploaded IDs per page (~10k identity rows)
// Pages start small and are re-sized after each one so a page's synchronous
// work stays ~STEP_TARGET_MS on any disk: an ID's rows are scattered across the
// table, and at 6.8M IDs on a cold cache a fixed 2,000-ID page took ~0.56 s.
const FIRST_PAGE = 250;
const MIN_PAGE = 10;
const STEP_TARGET_MS = 100;
const DELETE_CHUNK = 50_000;     // old rows cleared per statement on a rebuild

// Builds run in this process only; a 'building' row left by a dead process is
// marked failed at startup (recovery.js).
const building = new Set();

export class AnalysisUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisUnavailableError';
    this.status = 409;
    this.code = 'analysis_unavailable';
    this.publicMessage = message;
  }
}

export class AnalysisRunningError extends Error {
  constructor() {
    const message = 'An analysis is already being built for this job — wait for it to finish.';
    super(message);
    this.name = 'AnalysisRunningError';
    this.status = 409;
    this.code = 'analysis_running';
    this.publicMessage = message;
  }
}

/** Whether a job can be analysed, and why not. */
export function analysisAvailability(job) {
  if (!job) return { available: false, reason: 'Job not found.' };
  if (job.expansion_mode === 'none') {
    return { available: false, reason: 'Identity expansion was off for this job — only the uploaded IDs were stored, so there are no clusters to analyse.' };
  }
  if (!PLANNABLE_JOB_STATUSES.has(job.status)) {
    return { available: false, reason: 'The analysis is available once identity expansion has finished.' };
  }
  return { available: true, reason: null };
}

export function isAnalysisBuilding(jobId) {
  return building.has(jobId);
}

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

/** The job's source namespace as {code, id}; fills a missing nsid from a stored source row. */
export function sourceNamespaceOf(job) {
  return job.source_namespace_id != null
    ? resolveSourceNamespace(job)
    : resolveSourceNamespace(job, q().sourceRowNamespace.get(job.id));
}

/**
 * Build (or rebuild) the analysis for a job. Resolves with the summary, or
 * null when the job was deleted mid-build. Rejects with
 * AnalysisUnavailableError / AnalysisRunningError before doing anything, or
 * with the underlying error after marking the analysis failed.
 */
export async function buildAnalysis(jobId, { pageSize = PAGE_SIZE } = {}) {
  const job = q().getJob.get(jobId);
  const { available, reason } = analysisAvailability(job);
  if (!available) throw new AnalysisUnavailableError(reason);
  if (building.has(jobId)) throw new AnalysisRunningError();
  building.add(jobId);
  const t0 = Date.now();
  try {
    // An Excel report describes the analysis being replaced — stop and drop it.
    discardAnalysisReport(jobId);
    q().upsertJobAnalysisStart.run(jobId, job.processed_count ?? null);
    while (q().deleteSourceAnalysisChunk.run(jobId, DELETE_CHUNK).changes > 0) await yieldToLoop();

    const sourceNs = sourceNamespaceOf(job);
    const isInList = (value) => !!q().hasProcessedSource.get(jobId, value);
    const summary = {
      sources: 0,
      identities: 0,
      byCategory: Object.fromEntries(ANALYSIS_CATEGORIES.map(c => [c, 0])),
      byNamespace: {},
      otherProfiles: { inList: 0, notInList: 0 },
    };

    let after = '';
    let size = Math.min(FIRST_PAGE, pageSize);
    for (;;) {
      // The job can be deleted while we yield; its rows cascade away with it.
      if (!q().getJob.get(jobId)) {
        logger.info({ jobId }, 'analysis: job deleted mid-build — stopped');
        return null;
      }
      const stepStart = performance.now();
      const page = q().nextSourcePage.all(jobId, after, size).map(r => r.source_id);
      if (page.length === 0) break;
      const bySource = new Map();
      for (const row of q().identitiesForSourceRange.all(jobId, page[0], page[page.length - 1])) {
        let list = bySource.get(row.source_id);
        if (!list) { list = []; bySource.set(row.source_id, list); }
        list.push(row);
      }
      const results = page.map(sourceId => ({
        sourceId,
        ...classifySource({ sourceId, sourceNs, rows: bySource.get(sourceId) || [], isInList }),
      }));
      db.transaction(() => {
        for (const r of results) {
          q().insertSourceAnalysis.run({
            jobId, sourceId: r.sourceId, category: r.category,
            identitiesTotal: r.identitiesTotal, linkedTotal: r.linkedTotal,
            nsCountsJson: JSON.stringify(r.nsCounts),
            otherInList: r.otherInList, otherNotInList: r.otherNotInList,
          });
        }
        q().setJobAnalysisProgress.run(summary.sources + results.length, jobId);
      })();
      for (const r of results) {
        summary.sources++;
        summary.byCategory[r.category]++;
        for (const [k, n] of Object.entries(r.nsCounts)) summary.byNamespace[k] = (summary.byNamespace[k] || 0) + n;
        summary.otherProfiles.inList += r.otherInList;
        summary.otherProfiles.notInList += r.otherNotInList;
      }
      after = page[page.length - 1];
      const took = Math.max(performance.now() - stepStart, 1);
      size = Math.max(MIN_PAGE, Math.min(pageSize, Math.round(size * Math.min(2, STEP_TARGET_MS / took))));
      await yieldToLoop();
    }

    // The job-wide DISTINCT identity count expansion computed (shared identities
    // counted once) — what deleting with linked identities removes.
    summary.identities = q().getJob.get(jobId)?.found_count ?? 0;
    summary.builtAt = new Date().toISOString();
    q().finishJobAnalysis.run(JSON.stringify(summary), summary.sources, jobId);
    logger.info({ jobId, sources: summary.sources, byCategory: summary.byCategory, ms: Date.now() - t0 },
      'analysis built');
    return summary;
  } catch (err) {
    try { q().failJobAnalysis.run(String(err?.message || err).slice(0, 500), jobId); }
    catch { /* the analysis row is gone with its job */ }
    logger.warn({ jobId, err: err?.message }, 'analysis build failed');
    throw err;
  } finally {
    building.delete(jobId);
  }
}

/** Fire-and-forget build after a successful cluster expansion; never throws into the caller. */
export function queueAnalysisBuild(jobId) {
  setImmediate(() => {
    buildAnalysis(jobId).catch(err => {
      logger.warn({ jobId, err: err?.message }, 'analysis: automatic build after expansion did not complete');
    });
  });
}
