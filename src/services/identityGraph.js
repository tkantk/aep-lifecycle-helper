import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';
import { canonicalizeNamespace } from './namespaces.js';

/**
 * Identity Graph cluster expansion.
 *
 * POST /data/core/identity/clusters/members
 *
 * Accepts up to 1000 composite identities per request. Returns each cluster
 * that contains any of the requested identities, with all linked members.
 *
 * Response shape (simplified):
 * [
 *   {
 *     xid: "...",
 *     identities: [
 *       { ns: "email",  id: "a@x.com", nsid: 6 },
 *       { ns: "Phone",  id: "+1234",   nsid: 7 },
 *       { ns: "hashedKocid", id: "abc", nsid: 123456 }
 *     ]
 *   },
 *   ...
 * ]
 *
 * Each requested source is matched to its cluster STRICTLY by
 * `compositeXid.id` (Adobe documents "one entry per requested XID regardless of
 * cluster association"). There is NO positional fallback (review R4 #2) —
 * guessing by array position could silently mis-assign one source's cluster to
 * another. expandBatch FAILS CLOSED on any source Adobe didn't return;
 * expandBatchDetailed reports a clean omission in `missing` (the runner re-asks,
 * then records "no reply from AEP" — never planned or deleted). Both fail closed
 * on Adobe-reported `unprocessedXids`/`unprocessedNids`, an unrecognized response
 * shape, or unreadable entries while IDs are missing, rather than emit a
 * source-only partial delete.
 */

// Defence-in-depth allowlist — see services/namespaces.js for the rationale.
// Templating an unvalidated region into the host is SSRF: with the bearer
// token attached, a request to platform-evil.com# leaks credentials.
const ALLOWED_REGIONS = new Set(['va7', 'nld2', 'aus5', 'can2']);

function endpoint(region) {
  // Region MUST come from the credential row (creds.region). The previous
  // process-wide default silently routed non-VA7 sandboxes to platform-va7,
  // and Adobe returns 200 with empty clusters for cross-region calls — that
  // would let an operator delete only the source kocid while linked
  // identities (email/phone/CRMID) silently survived.
  const r = (region || config.aep.identityRegion || '').toString().toLowerCase();
  if (!ALLOWED_REGIONS.has(r)) {
    throw new Error(`refusing to build Identity host with disallowed region "${region}"`);
  }
  return `${config.aep.gateway.replace(
    '://platform.',
    `://platform-${r}.`
  )}/data/core/identity/clusters/members`;
}

/**
 * Expand a batch (up to 1000) of source identities.
 *
 * @param {object} p
 * @param {object} p.creds
 * @param {string} p.sandboxName
 * @param {string} p.namespace          Source namespace CODE (e.g. 'hashedKocid')
 * @param {number} [p.namespaceId]      Numeric nsid if known - preferred for custom namespaces
 * @param {string[]} p.ids
 * @param {object} [p.namespaceIndex]   Output of buildNamespaceIndex(), used to canonicalize results
 * @returns {Promise<{ results: Array<{ sourceId, sourceNamespace: {code, id}, linkedIdentities: [{namespace:{code, id}, id}] }>,
 *                     missing: string[] }>}  missing = IDs sent that the reply cleanly left out
 */
export async function expandBatchDetailed({ creds, sandboxName, namespace, namespaceId, ids, namespaceIndex, signal }) {
  if (ids.length === 0) return { results: [], missing: [] };
  if (ids.length > 1000) throw new Error(`Batch too large: ${ids.length} (max 1000)`);

  const client = createAdobeClient(creds, sandboxName);

  // Build composite XIDs. Include both ns (code) and nsid (numeric) when we
  // have them - for custom namespaces, the numeric nsid is the reliable key.
  const compositeXids = ids.map(id => {
    const x = { id };
    if (namespace) x.ns = namespace;
    // Only template a FINITE nsid into the body. Guard null/undefined FIRST —
    // Number(null) === 0 is finite, so a bare isFinite() check would wrongly
    // send "nsid": 0 when no nsid was supplied. A NaN (from Number('abc'))
    // would serialize as "nsid": null and could mis-target the graph — review
    // finding #8. The upload route + expansion runner already coerce upstream;
    // this is the last line of defense at the wire.
    if (namespaceId != null && Number.isFinite(Number(namespaceId))) x.nsid = Number(namespaceId);
    return x;
  });

  const body = { compositeXids, 'graph-type': 'Private Graph' };

  // /clusters/members is a side-effect-free query despite being POST (the
  // request body just carries a list of XIDs). Safe to retry on 5xx/429.
  // A lookup that times out is retried (2026-10-09), each attempt with the full
  // timeout — without shouldResetTimeout a retry gets only the time left over.
  const { data } = await client.post(endpoint(creds.region), body, {
    idempotent: true, timeout: config.identityTimeoutMs, retryOnTimeout: true,
    'axios-retry': { shouldResetTimeout: true },
    // The runner cancels a run's other lookups (and their retry waits) once one
    // batch has failed — final review #3.
    ...(signal && { signal }),
  });

  // Adobe's /clusters/members response shape (observed against AEP production
  // API v1.1.0; the legacy shape in the bare-array form also still occurs on
  // some older regions, so we handle both):
  //
  //   Current:  { version: "1.1.0", clusters: [
  //                 { compositeXid: { nsid, id }, members: [ { nsid, id }, ... ] },
  //                 ...
  //             ]}
  //
  //   Legacy:   [ { xid, identities: [ { ns, nsid, id }, ... ] }, ... ]
  //
  // Members come back with nsid only (no ns code) in the current shape, so
  // canonicalizeNamespace fills in the code from the registry index.
  // FAIL CLOSED on an unrecognized response shape (review #2). If it's neither
  // the current object-with-clusters nor the legacy bare array, we can't safely
  // interpret it — refuse rather than treat it as "empty" and emit source-only
  // deletes.
  const recognized = Array.isArray(data) || Array.isArray(data?.clusters);
  if (!recognized) {
    throw new Error(
      `Identity Graph returned an unrecognized response shape ` +
      `(keys=${Object.keys(data || {}).join(',') || typeof data}) — refusing to expand ` +
      `against an unknown response (would risk source-only partial deletes).`);
  }
  const clustersArray = Array.isArray(data) ? data : data.clusters;

  // FAIL CLOSED on Adobe-reported unprocessed identities (review #2). Adobe's
  // documented response lists XIDs/NIDs it could NOT process in `unprocessedXids`
  // / `unprocessedNids`. Emitting an unprocessed source as a deletion target
  // would delete only its source id and leave its linked identities alive — a
  // silent partial delete. Refuse the batch; the operator retries (resume skips
  // already-processed sources). Lowering IDENTITY_CONCURRENCY usually clears it.
  const unprocessedXids = Array.isArray(data?.unprocessedXids) ? data.unprocessedXids : [];
  const unprocessedNids = Array.isArray(data?.unprocessedNids) ? data.unprocessedNids : [];
  if (unprocessedXids.length || unprocessedNids.length) {
    throw new Error(
      `Identity Graph could not process ${unprocessedXids.length + unprocessedNids.length} ` +
      `identity(ies) in this batch (unprocessedXids/unprocessedNids non-empty) — refusing to ` +
      `emit a partial (source-only) deletion. Retry; lower IDENTITY_CONCURRENCY if it persists.`);
  }

  // Match clusters to source IDs by compositeXid.id (preferred) rather than
  // array position — Adobe's documentation doesn't guarantee order, and
  // position-matching caused silent mis-assignment when responses re-ordered.
  const clusterBySourceId = new Map();
  for (const c of clustersArray) {
    const xid = c?.compositeXid?.id ?? c?.xid;
    if (xid) clusterBySourceId.set(xid, c);
  }

  const sourceNs = canonicalizeNamespace(
    { ns: namespace, nsid: namespaceId }, namespaceIndex
  );

  // Every requested source is matched by id — NO positional fallback (review #2).
  // Adobe documents "one entry per requested XID regardless of cluster
  // association". A CLEAN omission — some IDs absent while every entry Adobe did
  // return matches an ID we sent — goes back to the caller in `missing` (the
  // runner re-asks once, then records "no reply from AEP"; 2026-10-08). Entries
  // that match no ID we sent while IDs are missing may be those IDs in another
  // form, so that fails closed: skipping them could leave real profiles undeleted.
  const requested = new Set(ids);
  const missing = [];
  const results = [];
  for (const sourceId of ids) {
    const cluster = clusterBySourceId.get(sourceId);
    if (!cluster) { missing.push(sourceId); continue; }
    const rawMembers = cluster.members || cluster.identities || [];
    const linkedIdentities = rawMembers.map(node => {
      const ns = canonicalizeNamespace(
        { ns: node.ns, nsid: node.nsid }, namespaceIndex
      );
      return { namespace: ns, id: node.id };
    });
    results.push({ sourceId, sourceNamespace: sourceNs, linkedIdentities });
  }
  if (missing.length) {
    const unreadable = clustersArray.filter(c => !requested.has(c?.compositeXid?.id ?? c?.xid));
    if (unreadable.length) {
      throw new Error(
        `Identity Graph reply could not be read: ${unreadable.length} of its ${clustersArray.length} ` +
        `entries match none of the ${ids.length} IDs sent (entry keys: ${describeEntryKeys(unreadable)}), and ` +
        `${missing.length} ID(s) sent got no entry (e.g. ${missing.slice(0, 3).join(', ')}). This looks like a ` +
        `reply-format problem, not unknown IDs — the expansion stopped so nothing is deleted by halves. ` +
        `Resume retries the batch; if it repeats, share this message with whoever maintains the tool.`);
    }
  }
  return { results, missing };
}

// Field names a reply entry may carry (current + legacy shapes). Only these are
// named in the reply-format error; other keys are only counted — an unknown key
// may itself be an identity value, and ID lists never go to logs (final review #2).
const KNOWN_ENTRY_KEYS = new Set(['compositeXid', 'xid', 'members', 'identities', 'nsid', 'ns', 'id']);

function describeEntryKeys(entries) {
  const known = new Set(), other = new Set(), types = new Set();
  for (const c of entries) {
    if (c && typeof c === 'object') for (const k of Object.keys(c)) (KNOWN_ENTRY_KEYS.has(k) ? known : other).add(k);
    else types.add(c === null ? 'null' : typeof c);
  }
  let keys = [...known].sort().join(', ');
  if (other.size) keys += `${keys ? ' ' : ''}(+${other.size} other key${other.size === 1 ? '' : 's'})`;
  return [keys, ...[...types].sort()].filter(Boolean).join(', ') || 'none';
}

/**
 * Expand a batch, failing closed on ANY source Adobe's reply left out — the
 * original contract, kept for every caller except the expansion runner (which
 * uses expandBatchDetailed to re-ask and record "no reply from AEP").
 */
export async function expandBatch(args) {
  const { results, missing } = await expandBatchDetailed(args);
  if (missing.length) {
    throw new Error(
      `Identity Graph response did not include ${missing.length} of ${args.ids.length} ` +
      `requested source identity(ies) (e.g. ${missing.slice(0, 3).join(', ')}) — refusing to ` +
      `emit them as source-only deletions. Retry; verify the credential region and source namespace.`);
  }
  return results;
}
