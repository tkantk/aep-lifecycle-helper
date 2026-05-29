import axios from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config.js';
import { getAuthHeaders, invalidateToken } from './imsAuth.js';
import { logger } from '../utils/logger.js';

// Module-level rate-limit counter. Bumps on every 429 retry across all
// Adobe clients in this process. Callers (e.g. the expansion runner)
// snapshot+reset this around each window so they can report "N 429s in
// the last 50 batches" — turns "Adobe is slow" into a measurable signal
// the operator can act on (lower IDENTITY_CONCURRENCY).
let _rateLimitHitsTotal = 0;
export function snapshotAndResetRateLimitHits() {
  const n = _rateLimitHitsTotal;
  _rateLimitHitsTotal = 0;
  return n;
}
export function getRateLimitHitsTotal() {
  return _rateLimitHitsTotal;
}

/**
 * Axios client factory for Adobe APIs. Handles:
 *   - Auto auth header injection (token, api-key, org-id, sandbox)
 *   - Exponential backoff + jitter on transient failures
 *   - Retry-After header honored on 429
 *   - Token invalidation + auto-refresh on 401
 */
export function createAdobeClient(creds, sandboxName) {
  const client = axios.create({ timeout: config.requestTimeoutMs });

  client.interceptors.request.use(async (cfg) => {
    const headers = await getAuthHeaders(creds, sandboxName);
    cfg.headers = { ...headers, ...cfg.headers };
    cfg.metadata = { startTime: Date.now() };
    return cfg;
  });

  client.interceptors.response.use(
    (res) => res,
    async (err) => {
      if (err.response?.status === 401) {
        logger.warn({ url: err.config?.url }, '401 - invalidating cached token');
        invalidateToken(creds);
      }
      // Replace axios's generic "Request failed with status code 403" with the
      // actual Adobe error body when available. Without this, a 403 from a
      // credential missing Data Hygiene / Identity / Catalog permissions shows
      // as a status-code string and the operator has no idea which product
      // profile to ask for. Full response stays on err.response.data.
      enrichAdobeError(err);
      return Promise.reject(err);
    }
  );

  axiosRetry(client, {
    retries: 5,
    retryDelay: (retryCount, error) => {
      const ra = error.response?.headers?.['retry-after'];
      if (ra) {
        const seconds = isNaN(ra) ? Math.max(0, new Date(ra) - Date.now()) / 1000 : Number(ra);
        return Math.min(seconds, 60) * 1000;
      }
      const base = Math.min(30_000, 500 * Math.pow(2, retryCount - 1));
      return base + Math.floor(Math.random() * base * 0.3);
    },
    retryCondition: (error) => {
      const s = error.response?.status;
      const isNet = axiosRetry.isNetworkError(error);
      const method = error.config?.method?.toLowerCase();
      // Some POSTs (Identity Graph cluster queries) are side-effect-free and
      // safe to retry. The hygiene work-order POST is NOT — a 5xx after Adobe
      // partly processed the request would cause duplicate irreversible
      // deletes on retry. Callers tag those by setting cfg.idempotent = false.
      // Default for non-GET is "non-idempotent" (safe default); GETs are
      // always idempotent.
      const idempotent = method === 'get'
        ? true
        : (error.config?.idempotent === true);

      // Network errors on non-idempotent requests: we don't know if Adobe
      // received the body, so never retry.
      if (isNet && !idempotent) return false;
      // 5xx on non-idempotent requests: Adobe MAY have processed it before
      // failing to respond. Don't retry — the orphan-recovery path on next
      // startup is the safe reconciliation route.
      if (s >= 500 && s < 600 && !idempotent) return false;

      return isNet || s === 401 || s === 429 || (s >= 500 && s < 600);
    },
    onRetry: (n, err, cfg) => {
      const status = err.response?.status;
      // 429 is special: surface it loudly and call out the Retry-After so the
      // operator can see "I'm being rate-limited, expect this to take longer".
      // Without this, a sustained 429 storm just looks like 'identity graph is
      // slow' in higher-level logs.
      if (status === 429) {
        _rateLimitHitsTotal++;
        const ra = err.response?.headers?.['retry-after'];
        const waitSec = ra
          ? (isNaN(ra) ? Math.max(0, (new Date(ra) - Date.now()) / 1000) : Number(ra))
          : null;
        logger.warn({
          url: cfg.url, attempt: n,
          retryAfter: ra || '(none)',
          waitSec: waitSec != null ? Math.round(waitSec) : null,
        }, 'ADOBE RATE LIMIT (HTTP 429) — backing off; reduce IDENTITY_CONCURRENCY if this is frequent');
      } else {
        logger.warn({ url: cfg.url, status, attempt: n }, 'retrying');
      }
    },
  });

  return client;
}

function enrichAdobeError(err) {
  const status = err.response?.status;
  if (!status) return;

  const extracted = extractAdobeMessage(err.response.data);
  const statusText = err.response.statusText || '';
  const hint = permissionHint(status, err.config?.url);

  // Build "HTTP 403 Forbidden: <adobe text>[ · hint]" so whichever layer surfaces
  // err.message (UI alerts, job.last_error, monitor logs) gets the same signal.
  const parts = [`HTTP ${status}${statusText ? ' ' + statusText : ''}`];
  if (extracted) parts.push(extracted);
  let message = parts.join(': ');
  if (hint) message += ` · ${hint}`;

  err.originalMessage = err.message;
  err.message = message;
}

function extractAdobeMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 400).trim() || null;
  if (typeof body !== 'object') return null;

  // Common AEP / IMS / RFC 7807 shapes in priority order
  const direct = body.detail || body.message || body.error_description
              || body.error_message || body.title;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  // Some IMS errors use a plain `error` string, others use it for an error code
  // object — only accept when it's a string.
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();

  // Array-of-errors shape: { errors: [{ message | detail }, ...] }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (typeof first === 'string') return first;
    if (first) return first.message || first.detail || first.title || null;
  }
  return null;
}

function permissionHint(status, url = '') {
  if (status !== 403) return null;
  if (url.includes('/hygiene/'))            return 'needs Data Hygiene product profile + "Delete Record" permission';
  if (url.includes('/sandbox-management/')) return 'needs Sandbox Administration read access';
  if (url.includes('/catalog/'))            return 'needs Catalog read access';
  if (url.includes('/idnamespace/'))        return 'needs Identity read access';
  if (url.includes('/identity/clusters/'))  return 'needs Identity Service access on this region';
  return 'check the product profile attached to this integration';
}
