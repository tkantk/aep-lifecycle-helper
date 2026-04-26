import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';
import { canonicalizeNamespace } from './namespaces.js';
import { logger } from '../utils/logger.js';

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
 * Position in the response array matches position of the corresponding
 * input id. If Adobe returns fewer results than we sent, we iterate
 * by the input array and assume missing entries have empty identities.
 */

function endpoint(region) {
  // Region MUST come from the credential row (creds.region). The previous
  // process-wide default silently routed non-VA7 sandboxes to platform-va7,
  // and Adobe returns 200 with empty clusters for cross-region calls — that
  // would let an operator delete only the source kocid while linked
  // identities (email/phone/CRMID) silently survived.
  const r = region || config.aep.identityRegion;
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
    if (namespaceId != null) x.nsid = Number(namespaceId);
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
  const clustersArray = Array.isArray(data)
    ? data
    : (Array.isArray(data?.clusters) ? data.clusters : []);

  // Match clusters to source IDs by compositeXid.id (preferred) rather than
  // array position — Adobe's documentation doesn't guarantee order, and
  // position-matching caused silent mis-assignment when responses re-ordered.
  const clusterBySourceId = new Map();
  for (const c of clustersArray) {
    const xid = c?.compositeXid?.id ?? c?.xid;
    if (xid) clusterBySourceId.set(xid, c);
  }

  // Diagnostic: if Adobe returned zero members across the whole batch, dump
  // the raw response so the operator can see whether it's an unexpected shape,
  // an auth error embedded in a 200, or a genuinely-empty batch.
  const totalMembers = clustersArray.reduce((n, c) =>
    n + ((c?.members?.length) || (c?.identities?.length) || 0), 0);
  if (totalMembers === 0) {
    logger.warn({
      batchSize: ids.length,
      firstXid: compositeXids[0],
      responseShape: Array.isArray(data)
        ? `array[${data.length}]`
        : `object(keys=${Object.keys(data || {}).join(',')})`,
      rawResponsePreview: JSON.stringify(data).slice(0, 2000),
    }, 'identity-graph returned zero linked identities across whole batch');
  }

  const sourceNs = canonicalizeNamespace(
    { ns: namespace, nsid: namespaceId }, namespaceIndex
  );

  return ids.map((sourceId, i) => {
    const cluster = clusterBySourceId.get(sourceId) || clustersArray[i] || {};
    const rawMembers = cluster.members || cluster.identities || [];
    const linkedIdentities = rawMembers.map(node => {
      const ns = canonicalizeNamespace(
        { ns: node.ns, nsid: node.nsid }, namespaceIndex
      );
      return { namespace: ns, id: node.id };
    });
    return { sourceId, sourceNamespace: sourceNs, linkedIdentities };
  });
}
