import { Router } from 'express';
import { storeCreds, decryptCreds } from '../utils/crypto.js';
import { getAccessToken, invalidateToken } from '../services/imsAuth.js';
import { q } from '../db.js';
import { registerUuidParamGuards } from '../middleware/security.js';

const router = Router();
registerUuidParamGuards(router);   // :id is the credential UUID

// ─── Input validation ────────────────────────────────────────────────────
// The credentials POST/PATCH endpoints accept user-controlled strings that
// flow into:
//   - URL hostnames    (region → platform-{region}.adobe.io — SSRF surface)
//   - HTTP headers     (imsOrgId → x-gw-ims-org-id; clientId → x-api-key)
//   - SQL inserts      (parameterized; safe from injection but still need caps)
//   - the on-disk DB   (unbounded length = unbounded row size)
//
// Without strict server-side validation:
//   - F2: an attacker writing region="evil.com#" exfiltrates the bearer token
//         to platform-evil.com on the next Identity API call.
//   - F7: oversized strings bloat the DB; weird characters in headers can
//         confuse downstream proxies.
// Match the UI's hardcoded region dropdown so what the form offers IS the
// allowed set. Update both lists together if Adobe adds a new region.

const ALLOWED_REGIONS = new Set(['va7', 'nld2', 'aus5', 'can2']);
const ALLOWED_ENVIRONMENTS = new Set(['Production', 'Stage', 'Development']);

const LIMITS = {
  label:        { min: 1,  max: 200 },
  clientName:   { min: 0,  max: 200 },
  imsOrgId:     { min: 1,  max: 64  },
  clientId:     { min: 1,  max: 128 },
  clientSecret: { min: 1,  max: 256 },
};

function fail(message, code = 'invalid_request') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  err.publicMessage = message;
  return err;
}

function validateString(name, val, { min, max }, { allowEmpty = false } = {}) {
  if (val == null) {
    if (allowEmpty || min === 0) return '';
    throw fail(`${name} is required`);
  }
  if (typeof val !== 'string') throw fail(`${name} must be a string`);
  const trimmed = val.trim();
  if (!allowEmpty && trimmed.length < min) throw fail(`${name} is required`);
  if (trimmed.length > max) throw fail(`${name} exceeds max length ${max}`);
  // Reject control characters (CR/LF/null) that could smuggle headers if the
  // value reaches an HTTP header layer.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw fail(`${name} contains invalid characters`);
  return trimmed;
}

function validateRegion(region) {
  if (!region || typeof region !== 'string') throw fail('region is required');
  const r = region.trim().toLowerCase();
  if (!ALLOWED_REGIONS.has(r)) {
    throw fail(`region must be one of: ${[...ALLOWED_REGIONS].join(', ')}`);
  }
  return r;
}

function validateEnvironment(env) {
  if (!env || typeof env !== 'string') throw fail('environment is required');
  if (!ALLOWED_ENVIRONMENTS.has(env)) {
    throw fail(`environment must be one of: ${[...ALLOWED_ENVIRONMENTS].join(', ')}`);
  }
  return env;
}

/** Store or update credentials (secret encrypted at rest). */
router.post('/credentials', async (req, res, next) => {
  try {
    const body = req.body || {};
    const label        = validateString('label',        body.label,        LIMITS.label);
    const clientName   = validateString('clientName',   body.clientName,   LIMITS.clientName,   { allowEmpty: true });
    const environment  = validateEnvironment(body.environment);
    const region       = validateRegion(body.region);
    const imsOrgId     = validateString('imsOrgId',     body.imsOrgId,     LIMITS.imsOrgId);
    const clientId     = validateString('clientId',     body.clientId,     LIMITS.clientId);
    const clientSecret = validateString('clientSecret', body.clientSecret, LIMITS.clientSecret);

    const id = storeCreds({
      label, clientName: clientName || null,
      environment, region, imsOrgId, clientId, clientSecret,
    });
    res.json({ id, ok: true });
  } catch (err) { next(err); }
});

/** List stored credentials (without secrets). */
router.get('/credentials', (_req, res, next) => {
  try { res.json(q().listCreds.all()); }
  catch (err) { next(err); }
});

/** Test a credential - either by stored id or with inline creds.
 *  Inline creds go through the same length/charset validators as the create
 *  path so a malicious caller can't smuggle CRLF into the IMS request. */
router.post('/credentials/test', async (req, res) => {
  try {
    let creds;
    if (req.body?.credsId) {
      creds = await decryptCreds(req.body.credsId);
    } else {
      const body = req.body || {};
      const imsOrgId     = validateString('imsOrgId',     body.imsOrgId,     LIMITS.imsOrgId);
      const clientId     = validateString('clientId',     body.clientId,     LIMITS.clientId);
      const clientSecret = validateString('clientSecret', body.clientSecret, LIMITS.clientSecret);
      creds = { imsOrgId, clientId, clientSecret };
    }
    invalidateToken(creds);
    const token = await getAccessToken(creds);
    res.json({ ok: true, tokenPrefix: token.slice(0, 12) + '…' });
  } catch (err) {
    // Test endpoint deliberately returns ok:false instead of bubbling — the
    // UI renders the reason inline. Keep the public message narrow.
    res.json({
      ok: false,
      error: err.response?.data?.error_description || err.publicMessage || err.message,
      status: err.response?.status,
    });
  }
});

/** Update non-secret fields on an existing credential.
 *  Never touches the encrypted client_secret or identity fields
 *  (environment, ims_org_id, client_id) — those changes go through the
 *  insertCred upsert path.
 *
 *  Validated: label and clientName lengths, region against the allowlist.
 *  Without validation here, an attacker could PATCH region="evil.com#" on an
 *  existing credential and hijack the next Identity API call (F2). */
router.patch('/credentials/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = q().getCred.get(id);
    if (!existing) {
      const err = new Error('credential not found');
      err.status = 404; err.code = 'not_found'; err.publicMessage = 'credential not found';
      return next(err);
    }

    const body = req.body || {};
    const label = validateString('label', body.label, LIMITS.label);
    const clientName = validateString('clientName', body.clientName, LIMITS.clientName, { allowEmpty: true });
    // region is optional on PATCH (keep existing when omitted), but if
    // provided must pass the allowlist.
    const region = body.region != null ? validateRegion(body.region) : existing.region;

    q().updateCredFields.run({
      id,
      label,
      clientName: clientName || null,
      region,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/credentials/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    // Block deletion if any job references this credential — a deleted cred
    // breaks status polling, recovery, and audit traceability for those jobs.
    const { n } = q().countJobsForCred.get(id);
    if (n > 0) {
      return res.status(409).json({
        error: 'credential_in_use',
        message: `Cannot delete: ${n} job(s) reference this credential. Delete or archive those jobs first.`,
        jobCount: n,
      });
    }
    q().deleteCred.run(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
