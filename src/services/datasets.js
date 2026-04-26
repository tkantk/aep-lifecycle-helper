import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';

/**
 * Catalog / Datasets API.
 *
 * Adobe's Data Hygiene record-delete requires the target dataset's schema
 * to define a primary identity (or identity map). Records without a
 * populated primary identity are silently skipped. Data ingested BEFORE
 * the primary identity was added to the schema is also skipped.
 *
 * To avoid giving the user a footgun, we filter the dataset list down to
 * Profile/Identity-enabled ones (`tags.unifiedIdentity = enabled:true`).
 * Datasets without this tag would accept a work order but delete nothing.
 */

/**
 * List datasets in a sandbox, optionally filtered to Identity-enabled only.
 *
 * @param {object} params
 * @param {object} params.creds            IMS credentials
 * @param {string} params.sandboxName      Target sandbox
 * @param {boolean} [params.identityOnly=true]  Only return Identity-enabled datasets
 * @param {number}  [params.limit=500]     Page size (Adobe allows up to 100/page)
 * @returns {Promise<Array<{id, name, description, identityEnabled, profileEnabled, schemaRef}>>}
 */
export async function listDatasets({ creds, sandboxName, identityOnly = true, limit = 500 }) {
  const client = createAdobeClient(creds, sandboxName);

  // Catalog returns a dict keyed by dataset id, so we page by offset+limit until empty.
  // Request only the fields we need to keep response size sane (datasets can be chatty).
  const results = [];
  const pageSize = Math.min(100, limit);
  let start = 0;

  while (results.length < limit) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      start: String(start),
      properties: 'name,description,tags,schemaRef,state',
    });
    const url = `${config.aep.gateway}/data/foundation/catalog/dataSets?${params}`;
    const { data } = await client.get(url);

    const entries = Object.entries(data || {});
    if (entries.length === 0) break;

    for (const [id, ds] of entries) {
      const identityEnabled = Array.isArray(ds.tags?.unifiedIdentity)
        && ds.tags.unifiedIdentity.includes('enabled:true');
      const profileEnabled = Array.isArray(ds.tags?.unifiedProfile)
        && ds.tags.unifiedProfile.includes('enabled:true');

      if (identityOnly && !identityEnabled) continue;

      results.push({
        id,
        name: ds.name,
        description: ds.description,
        identityEnabled,
        profileEnabled,
        schemaRef: ds.schemaRef?.id,
        state: ds.state,
      });
    }

    if (entries.length < pageSize) break;
    start += pageSize;
  }

  return results;
}
