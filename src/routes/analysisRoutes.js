import { performance } from 'node:perf_hooks';
import { q, db } from '../db.js';
import {
  analysisAvailability, isAnalysisBuilding, buildAnalysis, describeSourceIdentities, sourceNamespaceOf,
  ANALYSIS_CATEGORIES, AnalysisUnavailableError, AnalysisRunningError,
} from '../runner/analysis.js';
import { categoryChunkReader } from '../runner/analysisCore.js';
import { startAnalysisReport, reportState, reportPath, reportDownloadName } from '../runner/analysisReport.js';
import { SA_COLS, SA_CATEGORY_FIRST_SQL, SA_CATEGORY_SAME_SIZE_SQL, SA_CATEGORY_SMALLER_SQL } from '../runner/analysisSql.js';
import { streamCsv } from '../utils/csv.js';
import { logger } from '../utils/logger.js';

/**
 * Identity analysis endpoints (2026-10-06), registered on the jobs router so
 * they share its /api/jobs mount and :id UUID guard. Everything except
 * POST /:id/analysis is read-only. Downloads read in keyset chunks with .all()
 * — no statement is ever held across an await, so a slow download can't make
 * a concurrent write (e.g. a submit) fail with "connection is busy".
 */

const MAX_PAGE = 500;
const EXPORT_CHUNK = 5000;       // uploaded IDs per chunk when rows are read in ID (= disk) order
// Chunks whose rows are scattered on disk — a detail download (~5 identity rows
// per ID) or one category (walked by cluster size) — take 500 IDs: one such
// chunk query cannot pause midway (5,000 IDs measured ~0.5 s on a cold cache).
const SCATTERED_CHUNK = 500;
// A detail download reads each ID's identities separately, so it pauses between
// IDs once this much synchronous work has been done (1,000 IDs measured ~0.7 s
// on a cold cache at 2M IDs).
const STEP_MS = 50;
const DRILL_MAX = 2000;          // identities returned for one uploaded ID
const MAX_SEARCH = 512;

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code; e.publicMessage = message;
  return e;
}
const badQuery = (message) => httpError(400, 'invalid_query', message);

function intParam(raw, { name, def, min, max }) {
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) throw badQuery(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw badQuery(`${name} must be between ${min} and ${max}`);
  return n;
}

/** null = not given; 'all' = every category; else one of ANALYSIS_CATEGORIES. */
function categoryParam(raw) {
  if (raw === undefined || raw === '') return null;
  if (raw === 'all') return 'all';
  if (typeof raw !== 'string' || !ANALYSIS_CATEGORIES.includes(raw)) {
    throw badQuery(`category must be one of: all, ${ANALYSIS_CATEGORIES.join(', ')}`);
  }
  return raw;
}

function loadJob(req, res) {
  const job = q().getJob.get(req.params.id);
  if (!job) res.status(404).json({ error: 'job not found' });
  return job;
}

/** The ready analysis + its parsed summary, or 409 analysis_not_ready. */
function readyAnalysis(jobId) {
  const a = q().getJobAnalysis.get(jobId);
  if (!a || a.status !== 'ready' || !a.summary_json) {
    throw httpError(409, 'analysis_not_ready', 'The identity analysis for this job is not ready — build it first (or wait for the build to finish).');
  }
  return JSON.parse(a.summary_json);
}

// ─── Paging statements, prepared once per filter shape ────────────────────
const pageStatements = new Map();
function pageStatement({ category, sort, search }) {
  const key = `${category ? 'c' : '-'}${search ? 's' : '-'}${sort}`;
  let st = pageStatements.get(key);
  if (!st) {
    const where = ['job_id = @jobId'];
    if (category) where.push('category = @category');
    if (search) where.push('source_id >= @lo AND source_id < @hi');
    const order = sort === 'id' ? 'source_id' : 'identities_total DESC, source_id';
    st = {
      page: db.prepare(`
        SELECT source_id, category, identities_total, linked_total, ns_counts_json, other_in_list, other_not_in_list
          FROM source_analysis WHERE ${where.join(' AND ')}
         ORDER BY ${order} LIMIT @limit OFFSET @offset`),
      count: db.prepare(`SELECT COUNT(*) AS n FROM source_analysis WHERE ${where.join(' AND ')}`),
    };
    pageStatements.set(key, st);
  }
  return st;
}

// Keyset chunks for the downloads. `filter` 'all' | 'flagged' (not
// not_found / source_only) walks the primary key in uploaded-ID order. ONE category walks
// idx_sa_job_cat_size, largest clusters first: in ID order a sparse category
// (1% of 6.8M IDs) scanned ~500k rows for every chunk — 2.6 s event-loop blocks.
const chunkStatements = new Map();
function chunkStatement(filter) {
  let st = chunkStatements.get(filter);
  if (!st) {
    if (filter === 'one') {
      // first chunk · rest of the current cluster size · then smaller sizes
      st = [db.prepare(SA_CATEGORY_FIRST_SQL), db.prepare(SA_CATEGORY_SAME_SIZE_SQL), db.prepare(SA_CATEGORY_SMALLER_SQL)];
    } else {
      const cond = filter === 'flagged' ? "AND category NOT IN ('not_found', 'source_only')" : '';
      st = db.prepare(`SELECT ${SA_COLS} FROM source_analysis
                        WHERE job_id = @jobId AND source_id > @after ${cond}
                        ORDER BY source_id LIMIT @limit`);
    }
    chunkStatements.set(filter, st);
  }
  return st;
}

/** Async chunks of source_analysis rows; yields to the event loop between chunks.
 *  Every query completes (.all()) before any await. */
async function* analysisChunks(jobId, filter, category, chunkSize = EXPORT_CHUNK) {
  const next = (() => {
    if (filter === 'one') {
      const [first, sameSize, smaller] = chunkStatement('one');
      return categoryChunkReader({ first, sameSize, smaller }, { jobId, category, chunkSize });
    }
    const st = chunkStatement(filter);
    return (last) => st.all({ jobId, after: last ? last.source_id : '', limit: chunkSize });
  })();
  let last = null;
  for (;;) {
    const chunk = next(last);
    if (chunk.length === 0) return;
    yield chunk;
    last = chunk[chunk.length - 1];
    await new Promise(resolve => setImmediate(resolve));
  }
}

function sendCsvHeaders(res, jobId, kind, category) {
  const suffix = category && category !== 'all' ? `_${category}` : '';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="job_${jobId}_analysis_${kind}${suffix}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
}

export function registerAnalysisRoutes(router) {
  /** POST /api/jobs/:id/analysis — start (or rebuild) the analysis. 409
   *  analysis_unavailable for expansion-off / not-yet-expanded jobs, 409
   *  analysis_running while a build is in progress. Poll GET /:id/analysis. */
  router.post('/:id/analysis', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      const { available, reason } = analysisAvailability(job);
      if (!available) throw new AnalysisUnavailableError(reason);
      if (isAnalysisBuilding(job.id)) throw new AnalysisRunningError();
      // The build marks itself running synchronously, before its first await.
      buildAnalysis(job.id).catch(err => logger.warn({ jobId: job.id, err: err.message }, 'analysis build failed'));
      res.json({ ok: true, started: true });
    } catch (err) { next(err); }
  });

  /** GET /api/jobs/:id/analysis — availability, build status/progress, summary. */
  router.get('/:id/analysis', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      const { available, reason } = analysisAvailability(job);
      const a = q().getJobAnalysis.get(job.id);
      res.json({
        available, reason,
        status: a?.status ?? null,
        sourcesDone: a?.sources_done ?? 0,
        sourcesTotal: a?.sources_total ?? null,
        summary: a?.summary_json ? JSON.parse(a.summary_json) : null,
        error: a?.error ?? null,
        startedAt: a?.started_at ?? null,
        finishedAt: a?.finished_at ?? null,
        report: a ? reportState(job.id) : null,       // the Excel report (2026-10-07)
      });
    } catch (err) { next(err); }
  });

  /** POST /api/jobs/:id/analysis/report[?rebuild=1] — build the Excel report in a
   *  worker thread (2026-10-07). 409 analysis_not_ready / report_building /
   *  report_busy. Poll GET /:id/analysis → report. */
  router.post('/:id/analysis/report', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      res.json(startAnalysisReport(job.id, { rebuild: req.query.rebuild === '1' }));
    } catch (err) { next(err); }
  });

  /** GET /api/jobs/:id/analysis/report — the finished workbook (409 report_not_ready). */
  router.get('/:id/analysis/report', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      if (reportState(job.id).status !== 'ready') {
        throw httpError(409, 'report_not_ready', 'The Excel report is not ready — build it first.');
      }
      res.download(reportPath(job.id), reportDownloadName(job), {
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Cache-Control': 'no-store' },
      });
    } catch (err) { next(err); }
  });

  /** GET /api/jobs/:id/analysis/sources?category=&search=&sort=size|id&limit=&offset= */
  router.get('/:id/analysis/sources', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      const category = categoryParam(req.query.category);
      const sort = req.query.sort ?? 'size';
      if (sort !== 'size' && sort !== 'id') throw badQuery('sort must be size or id');
      const limit = intParam(req.query.limit, { name: 'limit', def: 50, min: 1, max: MAX_PAGE });
      const offset = intParam(req.query.offset, { name: 'offset', def: 0, min: 0, max: 100_000_000 });
      const rawSearch = req.query.search ?? '';
      if (typeof rawSearch !== 'string' || rawSearch.length > MAX_SEARCH) throw badQuery('search must be text');
      const search = rawSearch.trim();
      const summary = readyAnalysis(job.id);

      const cat = category && category !== 'all' ? category : null;
      const st = pageStatement({ category: cat, sort, search: !!search });
      const params = { jobId: job.id };
      if (cat) params.category = cat;
      // Exact or prefix match on the uploaded ID (a PK range — no scan).
      if (search) { params.lo = search; params.hi = `${search}\u{10FFFF}`; }
      const rows = st.page.all({ ...params, limit, offset }).map(r => ({
        source_id: r.source_id,
        category: r.category,
        identities_total: r.identities_total,
        linked_total: r.linked_total,
        ns_counts: JSON.parse(r.ns_counts_json),
        other_in_list: r.other_in_list,
        other_not_in_list: r.other_not_in_list,
      }));
      const total = search ? st.count.get(params).n : (cat ? summary.byCategory[cat] ?? 0 : summary.sources);
      res.json({ rows, total });
    } catch (err) { next(err); }
  });

  /** GET /api/jobs/:id/analysis/sources/:sourceId — one uploaded ID's cluster. */
  router.get('/:id/analysis/sources/:sourceId', (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      const sourceId = req.params.sourceId;
      const rows = q().identitiesForSourceRange.all(job.id, sourceId, sourceId);
      if (rows.length === 0) return res.status(404).json({ error: 'source not found in this job' });
      const identities = describeSourceIdentities({
        sourceId, sourceNs: sourceNamespaceOf(job), rows,
        isInList: (v) => !!q().hasProcessedSource.get(job.id, v),
      });
      res.json({
        source: sourceId,
        category: q().getSourceAnalysis.get(job.id, sourceId)?.category ?? null,
        identities: identities.slice(0, DRILL_MAX),
        total: identities.length,
        truncated: identities.length > DRILL_MAX,
      });
    } catch (err) { next(err); }
  });

  /** GET /api/jobs/:id/analysis/export?kind=summary|detail&category= — streamed CSV.
   *  summary: one row per uploaded ID (default: all categories).
   *  detail:  every identity of the selected IDs (default: all but not_found / source_only). */
  router.get('/:id/analysis/export', async (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      const kind = req.query.kind ?? 'summary';
      if (kind !== 'summary' && kind !== 'detail') throw badQuery('kind must be summary or detail');
      const category = categoryParam(req.query.category);
      const summary = readyAnalysis(job.id);
      const filter = category === null ? (kind === 'detail' ? 'flagged' : 'all')
        : category === 'all' ? 'all' : 'one';
      const idHeader = job.source_namespace || 'source_id';

      sendCsvHeaders(res, job.id, kind, category);
      if (kind === 'summary') {
        // One count column per namespace seen in the job, most common first.
        const nsKeys = Object.entries(summary.byNamespace || {})
          .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([k]) => k);
        async function* rows() {
          for await (const chunk of analysisChunks(job.id, filter, category, filter === 'one' ? SCATTERED_CHUNK : EXPORT_CHUNK)) {
            for (const r of chunk) {
              const counts = JSON.parse(r.ns_counts_json);
              yield [r.source_id, r.category, r.identities_total, r.linked_total, r.other_in_list,
                r.other_not_in_list, ...nsKeys.map(k => counts[k] || 0)];
            }
          }
        }
        await streamCsv(res, [idHeader, 'category', 'identities_total', 'linked_total',
          'other_profiles_in_list', 'other_profiles_not_in_list', ...nsKeys.map(k => `ns:${k}`)], rows());
      } else {
        const sourceNs = sourceNamespaceOf(job);
        const isInList = (v) => !!q().hasProcessedSource.get(job.id, v);
        async function* rows() {
          for await (const chunk of analysisChunks(job.id, filter, category, SCATTERED_CHUNK)) {
            // One indexed read per ID (each completes before any await); pause
            // between IDs once STEP_MS of work is done so a cold disk never
            // blocks the server for long.
            let lines = [];
            let since = performance.now();
            for (const r of chunk) {
              const ids = describeSourceIdentities({ sourceId: r.source_id, sourceNs, isInList,
                rows: q().identitiesForSourceRange.all(job.id, r.source_id, r.source_id) });
              for (const i of ids) {
                lines.push([r.source_id, r.category, i.namespace ?? '', i.nsid ?? '', i.value, i.relation,
                  i.relation === 'other_profile' ? (i.inList ? 'yes' : 'no') : '']);
              }
              if (performance.now() - since >= STEP_MS) {
                yield* lines;
                lines = [];
                await new Promise(resolve => setImmediate(resolve));
                since = performance.now();
              }
            }
            yield* lines;
          }
        }
        await streamCsv(res, [idHeader, 'category', 'namespace', 'namespace_id', 'identity', 'relation',
          'other_profile_in_list'], rows());
      }
    } catch (err) {
      if (!res.headersSent) {
        res.removeHeader('Content-Disposition');
        return next(err);
      }
      logger.warn({ jobId: req.params.id, err: err.message }, 'analysis export aborted mid-stream');
      res.destroy(err);
    }
  });

  /** GET /api/jobs/:id/no-reply — CSV of the uploaded IDs AEP never answered for,
   *  even when asked again (2026-10-08). They are not in any plan. Header = the
   *  job's source namespace; header only when there are none. */
  router.get('/:id/no-reply', async (req, res, next) => {
    try {
      const job = loadJob(req, res);
      if (!job) return;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="job_${job.id}_no_reply_from_aep.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      async function* rows() {
        for (let after = ''; ;) {
          const chunk = q().noReplyChunk.all(job.id, after, EXPORT_CHUNK);
          if (chunk.length === 0) return;
          for (const r of chunk) yield [r.source_id];
          after = chunk[chunk.length - 1].source_id;
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      await streamCsv(res, [job.source_namespace || 'source_id'], rows());
    } catch (err) { next(err); }
  });
}

// Test seam: the download chunking (query plans + keyset order).
export const __internal__ = { analysisChunks, chunkStatement };
