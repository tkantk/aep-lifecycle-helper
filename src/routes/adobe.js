import { Router } from 'express';
import { listSandboxes } from '../services/sandboxes.js';
import { listDatasets } from '../services/datasets.js';
import { listNamespaces } from '../services/namespaces.js';
import { decryptCreds } from '../utils/crypto.js';
import { q } from '../db.js';
import { registerUuidParamGuards } from '../middleware/security.js';

const router = Router();
registerUuidParamGuards(router);   // :credsId is the credential UUID

/**
 * Dynamic discovery endpoints. These hit Adobe directly (with in-process
 * token cache) and persist the result to sandbox_configs for faster
 * subsequent reads + offline viewing of past jobs.
 *
 * All endpoints require a `credsId` query param (the stored credential
 * record). The UI passes it whenever the user picks a cred.
 */

/**
 * GET /api/adobe/:credsId/sandboxes
 * Returns the full sandbox list for the authenticated user.
 */
router.get('/:credsId/sandboxes', async (req, res, next) => {
  try {
    const creds = await decryptCreds(req.params.credsId);
    const sandboxes = await listSandboxes(creds);

    // Persist one row per sandbox so subsequent GETs of datasets/namespaces
    // can live-refresh or read from cache.
    for (const sb of sandboxes) {
      q().upsertSandboxConfig.run({
        credsId: req.params.credsId,
        sandboxName: sb.name,
        sandboxTitle: sb.title,
        sandboxType: sb.type,
        sandboxRegion: sb.region,
        datasetsJson: null,
        namespacesJson: null,
      });
    }
    res.json(sandboxes);
  } catch (err) { next(err); }
});

/**
 * GET /api/adobe/:credsId/sandboxes/:sandbox/datasets?refresh=1&identityOnly=1
 * Lists datasets in a sandbox. By default, only Identity-enabled datasets
 * are returned (the only ones that can be used by Data Hygiene).
 */
router.get('/:credsId/sandboxes/:sandbox/datasets', async (req, res, next) => {
  try {
    const { credsId, sandbox } = req.params;
    const refresh = req.query.refresh === '1';
    const identityOnly = req.query.identityOnly !== '0';

    if (!refresh) {
      const cached = q().getSandboxConfig.get(credsId, sandbox);
      if (cached?.datasets_json) {
        return res.json({ cached: true, refreshedAt: cached.refreshed_at, datasets: JSON.parse(cached.datasets_json) });
      }
    }

    const creds = await decryptCreds(credsId);
    const datasets = await listDatasets({ creds, sandboxName: sandbox, identityOnly });

    q().upsertSandboxConfig.run({
      credsId, sandboxName: sandbox,
      sandboxTitle: null, sandboxType: null, sandboxRegion: null,
      datasetsJson: JSON.stringify(datasets),
      namespacesJson: null,
    });

    res.json({ cached: false, refreshedAt: new Date().toISOString(), datasets });
  } catch (err) { next(err); }
});

/**
 * GET /api/adobe/:credsId/sandboxes/:sandbox/namespaces?refresh=1
 */
router.get('/:credsId/sandboxes/:sandbox/namespaces', async (req, res, next) => {
  try {
    const { credsId, sandbox } = req.params;
    const refresh = req.query.refresh === '1';

    if (!refresh) {
      const cached = q().getSandboxConfig.get(credsId, sandbox);
      if (cached?.namespaces_json) {
        return res.json({ cached: true, refreshedAt: cached.refreshed_at, namespaces: JSON.parse(cached.namespaces_json) });
      }
    }

    const creds = await decryptCreds(credsId);
    const namespaces = await listNamespaces({ creds, sandboxName: sandbox });

    q().upsertSandboxConfig.run({
      credsId, sandboxName: sandbox,
      sandboxTitle: null, sandboxType: null, sandboxRegion: null,
      datasetsJson: null,
      namespacesJson: JSON.stringify(namespaces),
    });

    res.json({ cached: false, refreshedAt: new Date().toISOString(), namespaces });
  } catch (err) { next(err); }
});

export default router;
