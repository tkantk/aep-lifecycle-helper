import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';

/**
 * Sandbox API (catalog/listing).
 *
 * Note: The available-sandboxes endpoint is special — it lives at the root of
 *   /data/foundation/sandbox-management/
 * and does NOT require the x-sandbox-name header (since it lists all sandboxes).
 *
 * This is why we pass `undefined` for sandboxName when creating the client.
 */

/**
 * List all sandboxes the authenticated user has access to.
 *
 * @param {object} creds   IMS credentials
 * @returns {Promise<Array<{ name, title, state, type, region, isDefault }>>}
 */
export async function listSandboxes(creds) {
  const client = createAdobeClient(creds, undefined);
  // This endpoint is paginated but most orgs have < 75 sandboxes, so one
  // page of 100 is plenty. If a customer exceeds that, we paginate.
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${config.aep.gateway}/data/foundation/sandbox-management/?limit=${limit}&offset=${offset}`;
    const { data } = await client.get(url);
    const boxes = data.sandboxes || [];
    results.push(...boxes);
    if (boxes.length < limit) break;
    offset += limit;
    // Safety cap
    if (offset > 1000) break;
  }

  // Only return active sandboxes - creating/deleting states are useless to us
  return results
    .filter(s => s.state === 'active')
    .map(s => ({
      name: s.name,             // used in x-sandbox-name header
      title: s.title,           // display name
      type: s.type,             // 'production' | 'development'
      region: s.region,         // 'VA7' | 'NLD2' | ...
      isDefault: !!s.isDefault,
    }));
}
