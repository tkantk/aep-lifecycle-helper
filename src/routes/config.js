import { Router } from 'express';
import { storeCreds, decryptCreds } from '../utils/crypto.js';
import { getAccessToken, invalidateToken } from '../services/imsAuth.js';
import { q } from '../db.js';

const router = Router();

/** Store or update credentials (secret encrypted at rest). */
router.post('/credentials', async (req, res, next) => {
  try {
    const { label, clientName, environment, region, imsOrgId, clientId, clientSecret } = req.body;
    if (!label || !environment || !region || !imsOrgId || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const id = storeCreds({ label, clientName, environment, region, imsOrgId, clientId, clientSecret });
    res.json({ id, ok: true });
  } catch (err) { next(err); }
});

/** List stored credentials (without secrets). */
router.get('/credentials', (_req, res, next) => {
  try { res.json(q().listCreds.all()); }
  catch (err) { next(err); }
});

/** Test a credential - either by stored id or with inline creds. */
router.post('/credentials/test', async (req, res) => {
  try {
    let creds;
    if (req.body.credsId) creds = await decryptCreds(req.body.credsId);
    else {
      const { imsOrgId, clientId, clientSecret } = req.body;
      if (!imsOrgId || !clientId || !clientSecret) {
        return res.status(400).json({ error: 'Missing fields' });
      }
      creds = { imsOrgId, clientId, clientSecret };
    }
    invalidateToken(creds);
    const token = await getAccessToken(creds);
    res.json({ ok: true, tokenPrefix: token.slice(0, 12) + '…' });
  } catch (err) {
    res.json({
      ok: false,
      error: err.response?.data?.error_description || err.message,
      status: err.response?.status,
    });
  }
});

/** Update non-secret fields on an existing credential.
 *  Never touches the encrypted client_secret or identity fields
 *  (environment, ims_org_id, client_id) — those changes go through the
 *  insertCred upsert path. */
router.patch('/credentials/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = q().getCred.get(id);
    if (!existing) return res.status(404).json({ error: 'credential not found' });

    const { label, clientName, region } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });

    q().updateCredFields.run({
      id,
      label,
      clientName: clientName || null,
      region: region || existing.region,
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
