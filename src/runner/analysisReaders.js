/**
 * Read-only views of a job's analysis on any better-sqlite3 connection — a
 * worker thread's own (the Excel report, the distinct counts) or, for an
 * in-memory database, the main one. Shared since 2026-10-14. Imports nothing
 * that opens the app database.
 */
import { categoryChunkReader } from './analysisCore.js';
import { SA_CATEGORY_FIRST_SQL, SA_CATEGORY_SAME_SIZE_SQL, SA_CATEGORY_SMALLER_SQL, IDENTITIES_FOR_SOURCE_RANGE_SQL,
  HAS_PROCESSED_SOURCE_SQL, TOP_CLUSTERS_SQL, NO_REPLY_CHUNK_SQL, DISTINCT_BY_NAMESPACE_SQL,
  MERGED_WITH_UPLOADED_SQL } from './analysisSql.js';

export function makeAnalysisReaders(conn, jobId, { chunk = 500 } = {}) {
  const stmts = { first: conn.prepare(SA_CATEGORY_FIRST_SQL), sameSize: conn.prepare(SA_CATEGORY_SAME_SIZE_SQL),
    smaller: conn.prepare(SA_CATEGORY_SMALLER_SQL) };
  const identities = conn.prepare(IDENTITIES_FOR_SOURCE_RANGE_SQL);
  const processed = conn.prepare(HAS_PROCESSED_SOURCE_SQL);
  const top = conn.prepare(TOP_CLUSTERS_SQL);
  const noReply = conn.prepare(NO_REPLY_CHUNK_SQL);
  return {
    async *categoryChunks(category) {
      const next = categoryChunkReader(stmts, { jobId, category, chunkSize: chunk });
      for (let last = null, c; (c = next(last)).length; last = c[c.length - 1]) yield c;
    },
    identitiesOf: (sourceId) => identities.all(jobId, sourceId, sourceId),
    isInList: (value) => !!processed.get(jobId, value),
    topClusters: (n) => top.all(jobId, n),
    async *noReplyChunks() {
      for (let after = '', c; (c = noReply.all(jobId, after, chunk)).length; after = c[c.length - 1].source_id) yield c;
    },
    distinctByNamespace: () => conn.prepare(DISTINCT_BY_NAMESPACE_SQL).all(jobId),
    mergedWithUploaded: () => conn.prepare(MERGED_WITH_UPLOADED_SQL).get(jobId).n,
  };
}
