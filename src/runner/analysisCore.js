/**
 * Pure identity-analysis logic (2026-10-06/07). IMPORT-FREE on purpose: it is
 * shared by the main thread (runner/analysis.js, routes/analysisRoutes.js) and by
 * the Excel-report worker thread (analysisReportWorker.js), which must never load
 * db.js — that would open the app database inside the worker.
 */
export const ANALYSIS_CATEGORIES = ['source_only', 'linked', 'merged_in_list', 'merged_outside_list'];

export const nsKeyOf = (row) => row.ns_code || (row.ns_id != null ? `nsid:${row.ns_id}` : 'unknown');

/**
 * Is a stored identity row in the job's SOURCE namespace? Matched by nsid when
 * both sides carry one, else by code case-insensitively — a typed code in
 * another case must never hide a merged profile. `key` is the label the
 * source namespace is counted under.
 */
export function sourceNsMatcher(sourceNs) {
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

/** The job's source namespace as {code, id}: the stored nsid, else the one on a
 *  stored uploaded-ID row (`sourceRow`), else the typed code alone. */
export function resolveSourceNamespace(job, sourceRow) {
  if (job.source_namespace_id != null) return { code: job.source_namespace, id: job.source_namespace_id };
  return { code: sourceRow?.ns_code || job.source_namespace, id: sourceRow?.ns_id ?? null };
}

/** Next chunk of ONE category, largest clusters first, from three prepared
 *  statements (analysisSql SA_CATEGORY_*) on any connection. `last` = the
 *  previous chunk's last row (null for the first chunk). */
export function categoryChunkReader({ first, sameSize, smaller }, { jobId, category, chunkSize }) {
  return (last) => {
    if (!last) return first.all({ jobId, category, limit: chunkSize });
    const chunk = sameSize.all({ jobId, category, size: last.identities_total, after: last.source_id, limit: chunkSize });
    return chunk.length < chunkSize
      ? chunk.concat(smaller.all({ jobId, category, size: last.identities_total, limit: chunkSize - chunk.length }))
      : chunk;
  };
}
