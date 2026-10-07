import { performance } from 'node:perf_hooks';
import { q, db } from '../db.js';
import { logger } from '../utils/logger.js';
import { PLANNABLE_JOB_STATUSES } from './submission.js';

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

export const ANALYSIS_CATEGORIES = ['source_only', 'linked', 'merged_in_list', 'merged_outside_list'];

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

const nsKeyOf = (row) => row.ns_code || (row.ns_id != null ? `nsid:${row.ns_id}` : 'unknown');

/**
 * Is a stored identity row in the job's SOURCE namespace? Matched by nsid when
 * both sides carry one, else by code case-insensitively — a typed code in
 * another case must never hide a merged profile. `key` is the label the
 * source namespace is counted under.
 */
function sourceNsMatcher(sourceNs) {
  const srcId = sourceNs?.id ?? null;
  const srcCode = sourceNs?.code ? String(sourceNs.code).toLowerCase() : null;
  const matches = (row) => {
    if (srcId != null && row.ns_id != null) return Number(row.ns_id) === Number(srcId);
    if (srcCode && row.ns_code) return String(row.ns_code).toLowerCase() === srcCode;
    return false;
  };
  return { matches, key: sourceNs?.code || (srcId != null ? `nsid:${srcId}` : 'unknown') };
}

/**
 * Classify ONE uploaded ID from its stored identity rows (pure).
 *
 * @param {{ sourceId: string, sourceNs: {code?: string|null, id?: number|null},
 *           rows: Array<{ns_code, ns_id, identity_id}>, isInList: (value: string) => boolean }} args
 * @returns {{ category, identitiesTotal, linkedTotal, nsCounts, otherInList, otherNotInList }}
 */
export function classifySource({ sourceId, sourceNs, rows, isInList }) {
  const { matches: inSourceNs, key: srcKey } = sourceNsMatcher(sourceNs);

  let selfSeen = false;
  const otherProfiles = new Set();     // values — same namespace, so the value is the identity
  const seenLinked = new Set();        // `${nsKey}\0${value}` for every other namespace
  const nsCounts = new Map();
  let linkedTotal = 0;
  for (const row of rows) {
    const value = row.identity_id;
    let key;
    if (inSourceNs(row)) {
      if (value === sourceId) { selfSeen = true; continue; }
      if (otherProfiles.has(value)) continue;
      otherProfiles.add(value);
      key = srcKey;
    } else {
      key = nsKeyOf(row);
      const k = `${key}\u0000${value}`;
      if (seenLinked.has(k)) continue;
      seenLinked.add(k);
    }
    nsCounts.set(key, (nsCounts.get(key) || 0) + 1);
    linkedTotal++;
  }

  let otherInList = 0;
  for (const v of otherProfiles) if (isInList(v)) otherInList++;
  const otherNotInList = otherProfiles.size - otherInList;

  let category;
  if (otherProfiles.size === 0) category = linkedTotal === 0 ? 'source_only' : 'linked';
  else category = otherNotInList > 0 ? 'merged_outside_list' : 'merged_in_list';

  return {
    category,
    identitiesTotal: linkedTotal + (selfSeen ? 1 : 0),
    linkedTotal,
    nsCounts: Object.fromEntries(nsCounts),
    otherInList,
    otherNotInList,
  };
}

/**
 * One uploaded ID's cluster, deduplicated, for the drill-down and the detail
 * CSV: the ID itself first, then other profiles, then linked identities (each
 * group by namespace, then value). Other profiles carry `inList`.
 * @returns {Array<{ namespace: string|null, nsid: number|null, value: string,
 *                   relation: 'self'|'other_profile'|'linked', inList?: boolean }>}
 */
export function describeSourceIdentities({ sourceId, sourceNs, rows, isInList }) {
  const { matches: inSourceNs } = sourceNsMatcher(sourceNs);
  const RANK = { self: 0, other_profile: 1, linked: 2 };
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const value = row.identity_id;
    const inSrc = inSourceNs(row);
    const relation = inSrc ? (value === sourceId ? 'self' : 'other_profile') : 'linked';
    const k = relation === 'linked' ? `L\u0000${nsKeyOf(row)}\u0000${value}` : `S\u0000${value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = { namespace: row.ns_code ?? null, nsid: row.ns_id ?? null, value, relation };
    if (relation === 'other_profile') entry.inList = !!isInList(value);
    out.push(entry);
  }
  const ns = (e) => e.namespace || (e.nsid != null ? `nsid:${e.nsid}` : '');
  return out.sort((a, b) => (RANK[a.relation] - RANK[b.relation])
    || (ns(a) < ns(b) ? -1 : ns(a) > ns(b) ? 1 : 0)
    || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

/** The job's source namespace as {code, id}; fills a missing nsid from a stored source row. */
export function sourceNamespaceOf(job) {
  if (job.source_namespace_id != null) return { code: job.source_namespace, id: job.source_namespace_id };
  const row = q().sourceRowNamespace.get(job.id);
  return { code: row?.ns_code || job.source_namespace, id: row?.ns_id ?? null };
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
