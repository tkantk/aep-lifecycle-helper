import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Security middleware for the local HTTP server.
 *
 * The server binds to 127.0.0.1 by default, but that alone does NOT make the
 * API safe — DNS rebinding and same-site form-CSRF both let a random web
 * page drive the destructive endpoints from inside the operator's browser.
 * The three guards here close those holes:
 *
 *   1. hostHeaderGuard
 *      Rejects requests whose Host header is not localhost / 127.0.0.1 / [::1].
 *      A DNS-rebinding attacker keeps the original attacker.com Host header
 *      after rebinding to 127.0.0.1, so we can detect and reject it.
 *
 *   2. originRefererGuard
 *      For state-changing methods (POST/PUT/PATCH/DELETE), require Origin or
 *      Referer (if present at all) to match the local origin. Closes simple
 *      form-encoded CSRF where the malicious page POSTs to localhost. We
 *      deliberately allow requests with neither header (server-side curl,
 *      programmatic clients) since they can't be CSRF — there's no browser
 *      ambient authority.
 *
 *   3. uuidParamGuard
 *      Validates that route :id and :credsId params are real UUIDs. Closes a
 *      path-traversal in /api/jobs/:id/export (jobId is interpolated into a
 *      filesystem path) and stops malformed IDs from reaching the DB layer.
 *
 * helmet provides the rest (security headers, CSP, no-sniff, frame-ancestors).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Host headers we treat as the local origin. Port is optional so the regex
// works regardless of PORT override. IPv6 literal must be bracketed per RFC.
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

// Derive the local origin from the request's Host header. We trust the Host
// header here because hostHeaderGuard ran first and already enforced that it
// matches a localhost form — so this only produces local-origin URLs.
function localOriginsFor(req) {
  const host = (req.headers.host || '').trim();
  if (!host) return [];
  // Allow http only; the local server doesn't terminate TLS.
  // Also accept variants that point at the SAME logical host (e.g. when the
  // page was loaded from http://localhost:3000 but a script reads
  // http://127.0.0.1:3000). Both share the loopback port.
  const port = host.includes(':') ? host.split(':').pop() : '';
  const portSuffix = port ? `:${port}` : '';
  return [
    `http://localhost${portSuffix}`,
    `http://127.0.0.1${portSuffix}`,
    `http://[::1]${portSuffix}`,
  ];
}

export function hostHeaderGuard(req, res, next) {
  const host = (req.headers.host || '').trim();
  if (!LOCAL_HOST_RE.test(host)) {
    logger.warn({ host, url: req.url, ip: req.ip }, 'host-header guard: rejected non-local Host');
    return res.status(421).json({
      error: 'misdirected_request',
      message: 'Server only accepts requests with Host: localhost / 127.0.0.1.',
    });
  }
  next();
}

export function originRefererGuard(req, res, next) {
  if (!STATE_CHANGING.has(req.method)) return next();

  const origin = (req.headers.origin || '').trim();
  const referer = (req.headers.referer || '').trim();
  const allowed = localOriginsFor(req);

  // Browsers send Origin on every state-changing request, even same-origin.
  // Non-browser callers (curl, programmatic clients) typically send neither,
  // and they aren't subject to CSRF anyway (no ambient credentials).
  if (!origin && !referer) return next();

  if (origin) {
    if (!allowed.includes(origin)) {
      logger.warn({ origin, url: req.url }, 'origin guard: rejected cross-origin state-change');
      return res.status(403).json({ error: 'cross_origin_blocked' });
    }
    return next();
  }

  // Referer-only fallback (rare on modern browsers, but cover it).
  try {
    const ref = new URL(referer);
    const refOrigin = `${ref.protocol}//${ref.host}`;
    if (!allowed.includes(refOrigin)) {
      logger.warn({ referer, url: req.url }, 'origin guard: rejected non-local Referer');
      return res.status(403).json({ error: 'cross_origin_blocked' });
    }
  } catch {
    return res.status(403).json({ error: 'cross_origin_blocked' });
  }
  next();
}

/**
 * Register UUID validation against Express `:id` and `:credsId` params on a
 * Router (or app). In Express 4 `app.param()` only fires for route params
 * defined on routes mounted directly on that app — it does NOT propagate to
 * sub-routers. So each router that defines a `:id` or `:credsId` param must
 * call this helper on itself.
 *
 * Other path params (e.g. `:sandbox` in routes/adobe.js) are intentionally
 * untouched here; they are free-form Adobe identifiers, not UUIDs.
 */
export function registerUuidParamGuards(router) {
  const reject = (res, name) =>
    res.status(400).json({ error: 'invalid_id', message: `${name} must be a UUID` });

  router.param('id', (req, res, next, val) => {
    if (!UUID_RE.test(val)) return reject(res, 'id');
    next();
  });
  router.param('credsId', (req, res, next, val) => {
    if (!UUID_RE.test(val)) return reject(res, 'credsId');
    next();
  });
  // Work-order id (e.g. POST /jobs/:id/work-orders/:woId/release-absent, R7 #1).
  router.param('woId', (req, res, next, val) => {
    if (!UUID_RE.test(val)) return reject(res, 'woId');
    next();
  });
}

export { UUID_RE };

/**
 * Centralised error handler. Logs everything server-side; returns a stable
 * JSON shape with a generic message on 5xx (so raw err.message — which can
 * include filesystem paths from better-sqlite3 / fs errors — doesn't leak)
 * and the caller-vetted `code` + `publicMessage` (or `message`) on 4xx.
 *
 * Routes signal "this is a 4xx safe to surface" by setting:
 *   - err.status: HTTP status (defaults to 500)
 *   - err.code:   stable machine code (e.g. 'invalid_request')
 *   - err.publicMessage: human-readable text safe to render
 */
export function makeErrorHandler(logger) {
  return function errorHandler(err, _req, res, _next) {
    const status = err.status || 500;
    logger.error({ err: err.message, code: err.code, stack: err.stack, status }, 'request error');
    if (status >= 500) {
      return res.status(status).json({
        error: 'internal_error',
        message: 'An internal error occurred. Check server logs for details.',
      });
    }
    res.status(status).json({
      error: err.code || 'bad_request',
      message: err.publicMessage || err.message,
    });
  };
}
