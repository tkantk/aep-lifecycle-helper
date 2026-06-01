import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';

/**
 * Identity Namespaces registry.
 *
 * Every identity in AEP has two ways to reference its namespace:
 *   - `code` (string, e.g. "email", "Phone_E.164", "hashedKocid")
 *   - `id`   (numeric, the native nsid, e.g. 411)
 *
 * The Data Hygiene work-order payload accepts either form via:
 *   "namespacesIdentities": [{ "namespace": { "code": "email" }, "ids": [...] }]
 *   "namespacesIdentities": [{ "namespace": { "id": 411      }, "ids": [...] }]
 *
 * For standard namespaces the `code` is universally recognized. For CUSTOM
 * namespaces, the code is also accepted but can collide across orgs, so
 * best practice when talking to Adobe is to use BOTH fields. This registry
 * pulls the full list so we can map whatever the Identity Graph returns
 * (which sometimes gives you only `nsid`) into a canonical `{ code, id }`
 * pair before building the delete payload.
 */

/**
 * Fetch all namespaces available in the org's sandbox.
 *
 * Result shape (one entry per namespace):
 * {
 *   id: 411,
 *   code: "AAID",
 *   name: "Adobe Analytics (AAID)",
 *   idType: "COOKIE",
 *   custom: false,
 *   status: "ACTIVE"
 * }
 */
// Allowlist enforced at every Identity URL builder as defence-in-depth.
// The credentials route validates `region` on write (F2), but if a DB row
// from before the validation landed contains an unexpected value — or if a
// future code path writes to `credentials.region` without the route guards —
// we still refuse to build the URL. An invalid region routes the request at
// the process-wide default rather than letting it template into the host.
const ALLOWED_REGIONS = new Set(['va7', 'nld2', 'aus5', 'can2']);

function safeIdentityHost(region) {
  const r = (region || config.aep.identityRegion || '').toString().toLowerCase();
  if (!ALLOWED_REGIONS.has(r)) {
    throw new Error(`refusing to build Identity host with disallowed region "${region}"`);
  }
  return config.aep.gateway.replace('://platform.', `://platform-${r}.`);
}

export async function listNamespaces({ creds, sandboxName }) {
  const client = createAdobeClient(creds, sandboxName);

  // Region-specific identity host. Prefer the per-credential region (saved
  // when the operator picked a sandbox in the Config tab); fall back to the
  // process-wide default only if it's not set on the credential.
  const base = safeIdentityHost(creds.region);
  const url = `${base}/data/core/idnamespace/identities`;

  const { data } = await client.get(url);
  const arr = Array.isArray(data) ? data : [];

  return arr.map(n => ({
    id: n.id,
    code: n.code,
    name: n.name,
    idType: n.idType,
    custom: !!n.custom,
    status: n.status,
  }));
}

/**
 * Build two lookup tables from a namespace list:
 *   - byCode: Map<string, {id, code, ...}>
 *   - byId:   Map<number, {id, code, ...}>
 *
 * The lookup is used during expansion to canonicalize whatever form the
 * Identity Graph returned into a stable { code, id } pair, so our delete
 * payload is always unambiguous.
 */
export function buildNamespaceIndex(namespaces) {
  const byCode = new Map();
  const byId = new Map();
  for (const n of namespaces) {
    if (n.code) byCode.set(n.code, n);
    if (n.id != null) byId.set(Number(n.id), n);
  }
  return { byCode, byId };
}

/**
 * Canonicalize a namespace reference to { code, id }.
 *
 * The Identity Graph cluster endpoint returns identities with either:
 *   { ns: "email", id: "..." }         <- standard, code only
 *   { nsid: 411, id: "..." }           <- numeric only
 *   { ns: "email", nsid: 411, id: "..." }  <- both
 *
 * This function accepts any of those shapes plus an optional index (from
 * buildNamespaceIndex) to fill in missing fields. Returns { code, id } where
 * both are populated when possible. If the index has no hit, we fall back
 * to whatever was provided.
 */
// Coerce to a finite integer or null — never NaN. Number('abc')/Number({}) is
// NaN, which JSON.stringify renders as `null` inside a namespace.id and would
// silently corrupt the work-order payload (review hardening).
function finiteIntOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function canonicalizeNamespace({ ns, nsid }, index) {
  let code = ns || null;
  let id   = finiteIntOrNull(nsid);

  if (index) {
    if (code && id == null) {
      const hit = index.byCode.get(code);
      if (hit) id = finiteIntOrNull(hit.id);
    } else if (id != null && !code) {
      const hit = index.byId.get(id);
      if (hit) code = hit.code;
    }
  }

  return { code, id };
}
