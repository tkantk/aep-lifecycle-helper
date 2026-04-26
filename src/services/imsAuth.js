import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Adobe IMS Server-to-Server OAuth.
 *
 * Tokens are cached in a simple in-memory Map keyed by (clientId + imsOrgId).
 * Since this is a single-process local app, no distributed cache is needed.
 * An async mutex per key prevents multiple concurrent auth calls on the
 * same credentials during a cold start.
 */

const SAFETY_MARGIN_MS = 120_000;  // refresh 2 min before expiry
const cache = new Map();            // key -> { token, expiresAt }
const inflight = new Map();         // key -> Promise<string>

function cacheKey(creds) {
  return `${creds.clientId}:${creds.imsOrgId}`;
}

async function fetchToken(creds) {
  const url = `${config.ims.host}/ims/token/v3`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: config.ims.scope,
  });

  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });

  if (!data.access_token) throw new Error('IMS returned no access_token');

  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - SAFETY_MARGIN_MS,
  };
}

export async function getAccessToken(creds) {
  const key = cacheKey(creds);

  // Serve from cache if still valid
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Coalesce concurrent requests for the same creds
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const fresh = await fetchToken(creds);
      cache.set(key, fresh);
      logger.info({
        clientId: creds.clientId,
        ttl: Math.round((fresh.expiresAt - Date.now()) / 1000),
      }, 'IMS token refreshed');
      return fresh.token;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function invalidateToken(creds) {
  cache.delete(cacheKey(creds));
}

export async function getAuthHeaders(creds, sandboxName) {
  const token = await getAccessToken(creds);
  return {
    Authorization: `Bearer ${token}`,
    'x-api-key': creds.clientId,
    'x-gw-ims-org-id': creds.imsOrgId,
    ...(sandboxName && { 'x-sandbox-name': sandboxName }),
  };
}
