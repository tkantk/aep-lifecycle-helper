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
 * another. The batch FAILS CLOSED on any source Adobe didn't return, on
 * Adobe-reported `unprocessedXids`/`unprocessedNids`, or on an unrecognized
 * response shape, rather than emit a source-only partial delete.
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
 * @returns {Promise<Array<{ sourceId, sourceNamespace: {code, id}, linkedIdentities: [{namespace:{code, id}, id}] }>>}
 */
export async function expandBatch({ creds, sandboxName, namespace, namespaceId, ids, namespaceIndex }) {
  if (ids.length === 0) return [];
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
  const { data } = await client.post(endpoint(creds.region), body, { idempotent: true });

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

  // REQUIRE every requested source to be matched by id — NO positional fallback
  // (review #2). Adobe documents "one entry per requested XID regardless of
  // cluster association"; a missing entry is anomalous (wrong region / partial
  // response). Guessing by array position would silently mis-assign a source to
  // another source's cluster. Fail closed on any unmatched source.
  const unmatched = [];
  const out = ids.map((sourceId) => {
    const cluster = clusterBySourceId.get(sourceId);
    if (!cluster) { unmatched.push(sourceId); return null; }
    const rawMembers = cluster.members || cluster.identities || [];
    const linkedIdentities = rawMembers.map(node => {
      const ns = canonicalizeNamespace(
        { ns: node.ns, nsid: node.nsid }, namespaceIndex
      );
      return { namespace: ns, id: node.id };
    });
    return { sourceId, sourceNamespace: sourceNs, linkedIdentities };
  });

  if (unmatched.length) {
    throw new Error(
      `Identity Graph response did not include ${unmatched.length} of ${ids.length} ` +
      `requested source identity(ies) (e.g. ${unmatched.slice(0, 3).join(', ')}) — refusing to ` +
      `emit them as source-only deletions. Retry; verify the credential region and source namespace.`);
  }
  return out;
}
