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

// Is this value itself an uploaded (processed) ID of the job? (job, value)
export const HAS_PROCESSED_SOURCE_SQL = 'SELECT 1 FROM expanded_identities WHERE job_id = ? AND source_id = ? LIMIT 1';

// The job's largest clusters, all categories (idx_sa_job_size). (job, limit)
export const TOP_CLUSTERS_SQL = `SELECT source_id, category, identities_total, other_not_in_list FROM source_analysis
  WHERE job_id = ? ORDER BY identities_total DESC, source_id LIMIT ?`;
