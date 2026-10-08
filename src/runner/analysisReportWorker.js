/**
 * Worker thread that writes the identity-analysis Excel report (2026-10-07) on
 * its own READ-ONLY connection, so the server never pauses. Imports nothing that
 * opens the app database. Messages: {type:'progress', rowsDone} · {type:'done',
 * rows} · {type:'error', error}.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { categoryChunkReader } from './analysisCore.js';
import { SA_CATEGORY_FIRST_SQL, SA_CATEGORY_SAME_SIZE_SQL, SA_CATEGORY_SMALLER_SQL,
  IDENTITIES_FOR_SOURCE_RANGE_SQL, HAS_PROCESSED_SOURCE_SQL, TOP_CLUSTERS_SQL, NO_REPLY_CHUNK_SQL } from './analysisSql.js';
import { writeAnalysisWorkbook } from './analysisWorkbook.js';

const { dbPath, jobId, tmpPath, meta, summary, sourceNs, maxRowsPerSheet } = workerData;
const CHUNK = 500;
let conn = null;
try {
  conn = new Database(dbPath, { readonly: true, fileMustExist: true });
  conn.pragma('cache_size = -65536');
  const stmts = { first: conn.prepare(SA_CATEGORY_FIRST_SQL), sameSize: conn.prepare(SA_CATEGORY_SAME_SIZE_SQL),
    smaller: conn.prepare(SA_CATEGORY_SMALLER_SQL) };
  const identities = conn.prepare(IDENTITIES_FOR_SOURCE_RANGE_SQL);
  const processed = conn.prepare(HAS_PROCESSED_SOURCE_SQL);
  const top = conn.prepare(TOP_CLUSTERS_SQL);
  const noReply = conn.prepare(NO_REPLY_CHUNK_SQL);
  const readers = {
    async *categoryChunks(category) {
      const next = categoryChunkReader(stmts, { jobId, category, chunkSize: CHUNK });
      for (let last = null, chunk; (chunk = next(last)).length; last = chunk[chunk.length - 1]) yield chunk;
    },
    identitiesOf: (sourceId) => identities.all(jobId, sourceId, sourceId),
    isInList: (value) => !!processed.get(jobId, value),
    topClusters: (n) => top.all(jobId, n),
    async *noReplyChunks() {
      for (let after = '', chunk; (chunk = noReply.all(jobId, after, CHUNK)).length; after = chunk[chunk.length - 1].source_id) yield chunk;
    },
  };
  const res = await writeAnalysisWorkbook({ filename: tmpPath, meta, summary, sourceNs, readers,
    maxRowsPerSheet: maxRowsPerSheet || undefined,
    onProgress: (rowsDone) => parentPort.postMessage({ type: 'progress', rowsDone }) });
  parentPort.postMessage({ type: 'done', rows: res.rows });
} catch (err) {
  parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  process.exitCode = 1;
} finally {
  try { conn?.close(); } catch { /* already closed */ }
}
