/**
 * The expanded-identities export's columns and row shape (GET /api/jobs/:id/export).
 * Pure — shared by the export worker thread and the in-process fallback, so
 * both always write the same file.
 */
export const IDENTITY_EXPORT_HEADERS = ['source_id', 'namespace_code', 'namespace_id', 'identity'];

/** Rows of the STREAM_IDENTITIES_BY_SOURCE_SQL query → export records. */
export function* identityExportRecords(rows) {
  for (const r of rows) {
    yield {
      source_id: r.source_id,
      namespace_code: r.ns_code || '',
      namespace_id: r.ns_id || '',
      identity: r.identity_id,
    };
  }
}
