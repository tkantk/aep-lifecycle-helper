/**
 * SQL shared by the main thread and the Excel-report worker thread (2026-10-07).
 * Pure strings — this module must stay import-free.
 */
export const SA_COLS = 'source_id, category, identities_total, linked_total, ns_counts_json, other_in_list, other_not_in_list';

// ONE category, largest clusters first, walking idx_sa_job_cat_size: the first
// chunk, the rest of the current cluster size, then the smaller sizes.
export const SA_CATEGORY_FIRST_SQL = `SELECT ${SA_COLS} FROM source_analysis
  WHERE job_id = @jobId AND category = @category
  ORDER BY identities_total DESC, source_id LIMIT @limit`;
export const SA_CATEGORY_SAME_SIZE_SQL = `SELECT ${SA_COLS} FROM source_analysis
  WHERE job_id = @jobId AND category = @category AND identities_total = @size AND source_id > @after
  ORDER BY source_id LIMIT @limit`;
export const SA_CATEGORY_SMALLER_SQL = `SELECT ${SA_COLS} FROM source_analysis
  WHERE job_id = @jobId AND category = @category AND identities_total < @size
  ORDER BY identities_total DESC, source_id LIMIT @limit`;

// Every stored identity of a contiguous range of uploaded IDs. (job, first, last)
export const IDENTITIES_FOR_SOURCE_RANGE_SQL = `SELECT source_id, ns_code, ns_id, identity_id FROM expanded_identities
  WHERE job_id = ? AND source_id >= ? AND source_id <= ?`;

// Has this job finished asking Adobe about this uploaded ID — it has stored
// identities, or AEP never answered for it ("no reply", 2026-10-08)? Two indexed
// point lookups (idx_ei_job_source + no_reply_sources' primary key); the derived
// row lets callers keep binding (job, value) positionally. Used by the resume
// skip, the analysis "in your file" check, the routes and the Excel worker.
export const HAS_PROCESSED_SOURCE_SQL = `SELECT 1 FROM (SELECT ? AS job_id, ? AS source_id) AS p
  WHERE EXISTS (SELECT 1 FROM expanded_identities e WHERE e.job_id = p.job_id AND e.source_id = p.source_id)
     OR EXISTS (SELECT 1 FROM no_reply_sources n WHERE n.job_id = p.job_id AND n.source_id = p.source_id)`;

// A job's "no reply from AEP" IDs in keyset chunks, ID order. (job, after, limit)
export const NO_REPLY_CHUNK_SQL = 'SELECT source_id FROM no_reply_sources WHERE job_id = ? AND source_id > ? ORDER BY source_id LIMIT ?';

// The job's largest clusters, all categories (idx_sa_job_size). (job, limit)
export const TOP_CLUSTERS_SQL = `SELECT source_id, category, identities_total, other_not_in_list FROM source_analysis
  WHERE job_id = ? ORDER BY identities_total DESC, source_id LIMIT ?`;
