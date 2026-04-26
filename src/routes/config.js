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

router.delete('/credentials/:id', (req, res, next) => {
  try { q().deleteCred.run(req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

export default router;
