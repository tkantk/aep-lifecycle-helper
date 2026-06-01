import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';
import { logger } from '../utils/logger.js';

/**
 * Adobe Data Hygiene quota lookup.
 *
 * GET https://platform.adobe.io/data/core/hygiene/quota
 *
 * Adobe documents this as an org-wide read-only counter that returns each
 * named quota the org has access to. The response shape (per
 * experienceleague.adobe.com/.../data-lifecycle/api/quota) is:
 *
 *   {
 *     "quotas": [
 *       { "name": "dailyConsumerDeleteIdentitiesQuota",   "consumed": 314,   "quota": 700000,    "description": "..." },
 *       { "name": "monthlyConsumerDeleteIdentitiesQuota", "consumed": 2764,  "quota": 12000000,  "description": "..." },
 *       { "name": "datasetExpirationQuota",               "consumed": 11,    "quota": 75,        "description": "..." }
 *     ]
 *   }
 *
 * We map this to a UI-friendly object:
 *   { daily: { consumed, quota, remaining }, monthly: {...}, datasetExpiration: {...}, fetchedAt, stale, error }
 *
 * Counting unit: "submitted identifiers" — see CLAUDE.md I3 and docs/REVIEW.md
 * §3.7. Calling /quota does NOT consume quota (read-only), so we can refresh
 * aggressively without burning the operator's monthly entitlement.
 *
 * Scope: the doc explicitly states quotas are "per organization." x-sandbox-name
 * is NOT documented as a required header, so we call without it (matches the
 * shape of services/sandboxes.js, also org-wide). If a future Adobe change
 * requires the header, the call would 400 and our error path keeps the last
 * cached value with a stale warning.
 */

const PATH = '/data/core/hygiene/quota';
const CACHE_TTL_MS = 60 * 60 * 1000;             // 1 hour — quota changes slowly
const HARD_FLOOR_MS = 24 * 60 * 60 * 1000;        // 24 hours — beyond this, stale cache is no longer trustworthy

/**
 * In-memory cache keyed on imsOrgId. We deliberately don't persist to SQLite:
 *   - The values change as Adobe processes our (and others') work orders.
 *   - On restart, we want a fresh fetch anyway.
 *   - The cache is purely a rate-limiter for the Adobe call.
 */
const cache = new Map();   // imsOrgId -> { result, fetchedAt }

export function _clearCache() {
  // Used by tests to start each case from a known state.
  cache.clear();
}

// A quota number must be an ACTUAL non-negative integer. We deliberately do
// NOT call Number() first: Number(null)===0, Number(true)===1, Number([5])===5,
// Number('900')===900 — coercion would turn malformed JSON into a fake value
// (review #4: { consumed: null } became 0 = full remaining). Only a real
// numeric integer ≥ 0 is accepted; anything else → null → caller fails CLOSED.
// (0 is valid, e.g. consumed=0 on a fresh day.)
function toNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function normalizeQuotaEntry(entry) {
  if (!entry) return null;
  const consumed = toNonNegInt(entry.consumed);
  const quota    = toNonNegInt(entry.quota);
  if (consumed === null || quota === null) return null;   // malformed → treat as missing
  return {
    consumed,
    quota,
    remaining: Math.max(0, quota - consumed),
    description: entry.description || null,
  };
}

function shapeResponse(data) {
  const arr = Array.isArray(data?.quotas) ? data.quotas : [];
  const find = (name) => arr.find(q => q?.name === name) || null;
  return {
    daily:    normalizeQuotaEntry(find('dailyConsumerDeleteIdentitiesQuota')),
    monthly:  normalizeQuotaEntry(find('monthlyConsumerDeleteIdentitiesQuota')),
    datasetExpiration: normalizeQuotaEntry(find('datasetExpirationQuota')),
  };
}

/**
 * Fetch the org's current Adobe-side quota numbers.
 *
 * @param {object} creds  Decrypted credentials ({ imsOrgId, clientId, clientSecret, region })
 * @param {object} [opts]
 * @param {boolean} [opts.refresh=false]  Force-bust the cache.
 * @returns {Promise<{
 *   daily: {consumed, quota, remaining, description}|null,
 *   monthly: {consumed, quota, remaining, description}|null,
 *   datasetExpiration: {consumed, quota, remaining, description}|null,
 *   fetchedAt: string,   // ISO timestamp of when this was actually fetched (may be stale)
 *   stale: boolean,      // true if served from cache past TTL or after a fetch failure
 *   error: string|null,  // populated when the latest live fetch attempt failed
 * }>}
 */
export async function getOrgQuota(creds, { refresh = false } = {}) {
  const orgId = creds?.imsOrgId;
  if (!orgId) throw new Error('getOrgQuota: creds.imsOrgId is required');

  const now = Date.now();
  const cached = cache.get(orgId);

  // Fresh cache hit — serve immediately, no Adobe call.
  if (!refresh && cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return {
      ...cached.result,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      stale: false,
      error: null,
    };
  }

  try {
    const client = createAdobeClient(creds, undefined);
    const { data } = await client.get(`${config.aep.gateway}${PATH}`);
    const shaped = shapeResponse(data);
    cache.set(orgId, { result: shaped, fetchedAt: now });
    return {
      ...shaped,
      fetchedAt: new Date(now).toISOString(),
      stale: false,
      error: null,
    };
  } catch (err) {
    // Fall back to last cached value with a stale warning. If the cache is
    // older than the 24-hour hard floor — or doesn't exist — propagate the
    // error so the UI can block submission rather than ship blind. This is
    // the F-block decision from the 2026-05-15 quota review.
    const errMsg = err.message || String(err);
    logger.warn({ orgId, err: errMsg }, 'getOrgQuota: live fetch failed');

    if (cached && (now - cached.fetchedAt) < HARD_FLOOR_MS) {
      return {
        ...cached.result,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        stale: true,
        error: errMsg,
      };
    }
    // Either no cache or cache is older than 24h. Surface the error.
    const e = new Error(`Adobe quota fetch failed and no recent cache: ${errMsg}`);
    e.code = 'quota_unavailable';
    e.cause = err;
    throw e;
  }
}
