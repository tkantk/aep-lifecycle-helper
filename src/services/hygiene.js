import { config } from '../config.js';
import { createAdobeClient } from './adobeClient.js';

/**
 * Adobe Data Hygiene record-delete work orders.
 *
 * POST /data/core/hygiene/workorder
 *
 * Payload contract (per Adobe docs, March 2026):
 *
 *   {
 *     "action":  "delete_identity",
 *     "datasetId": "ALL" | "<singleId>" | "<id1>,<id2>,<id3>",
 *     "displayName": "human label",
 *     "description": "...",
 *     "targetServices": ["identity","profile","ajo"]   // optional; profile-only mode requires datasetId="ALL"
 *     "namespacesIdentities": [
 *       { "namespace": { "code": "email", "id": 6 }, "ids": ["a@x.com", ...] },
 *       { "namespace": { "code": "hashedKocid" },     "ids": ["abc", ...] }
 *     ]
 *   }
 *
 * Enforced constraints:
 *   - Total identity count must be > 0 and <= 100_000 (Adobe hard cap)
 *   - datasetId must be exactly one of: "ALL", single id, or comma list
 *   - targetServices, if present, must be exactly {identity, profile, ajo}
 *     in any order, AND datasetId must be "ALL"
 *   - Each namespace group must have either `code` or `id` populated
 */

const PATH = '/data/core/hygiene/workorder';
const ALLOWED_TARGET_SERVICES = new Set(['identity', 'profile', 'ajo']);

export class WorkOrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkOrderValidationError';
  }
}

/**
 * Validate dataset id format. Returns the normalized string on success.
 */
function validateDatasetId(datasetId) {
  if (!datasetId) throw new WorkOrderValidationError('datasetId is required');
  const trimmed = String(datasetId).trim();
  if (trimmed === 'ALL') return 'ALL';

  // Single or comma-separated ids
  const ids = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new WorkOrderValidationError('datasetId is empty');
  if (ids.includes('ALL')) {
    throw new WorkOrderValidationError('datasetId cannot combine "ALL" with specific ids');
  }
  // Adobe dataset ids are 24-char hex, but we don't assert length in case
  // formats evolve - just ensure no whitespace / empty segments
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new WorkOrderValidationError(`Invalid dataset id segment: "${id}"`);
    }
  }
  return ids.join(',');
}

/**
 * Validate a namespacesIdentities array.
 * Normalizes each entry to always send `{ code }` and `{ code, id }` if both known.
 */
function normalizeNamespacesIdentities(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new WorkOrderValidationError('namespacesIdentities must be a non-empty array');
  }

  const seen = new Set();
  let total = 0;
  const normalized = [];

  for (const g of groups) {
    const code = g.namespace?.code;
    const id   = g.namespace?.id != null ? Number(g.namespace.id) : undefined;
    if (!code && id == null) {
      throw new WorkOrderValidationError('Each namespace must have a code or id');
    }
    const key = code || `nsid:${id}`;
    if (seen.has(key)) {
      throw new WorkOrderValidationError(`Duplicate namespace group: ${key}`);
    }
    seen.add(key);

    if (!Array.isArray(g.ids) || g.ids.length === 0) {
      throw new WorkOrderValidationError(`Namespace group "${key}" has empty ids`);
    }

    // Dedup ids within group, drop empty values
    const uniq = [...new Set(g.ids.filter(x => x != null && String(x).trim() !== ''))];
    if (uniq.length === 0) {
      throw new WorkOrderValidationError(`Namespace group "${key}" has empty ids (all values blank/null)`);
    }
    total += uniq.length;

    // Build a namespace object that includes whichever fields we have.
    // Adobe accepts either `code` or `id` or both.
    const ns = {};
    if (code) ns.code = code;
    if (id != null) ns.id = id;

    normalized.push({ namespace: ns, ids: uniq });
  }

  if (total === 0) throw new WorkOrderValidationError('Work order must contain at least one identity');
  if (total > config.maxIdsPerWorkOrder) {
    throw new WorkOrderValidationError(
      `Work order has ${total} ids, exceeds per-order limit of ${config.maxIdsPerWorkOrder}`
    );
  }

  return { groups: normalized, total };
}

/**
 * Validate targetServices. Returns normalized array or undefined.
 * Per Adobe: exactly {identity, profile, ajo} in any order, and datasetId must be "ALL".
 */
function validateTargetServices(targetServices, datasetId) {
  if (!targetServices) return undefined;
  if (!Array.isArray(targetServices) || targetServices.length !== 3) {
    throw new WorkOrderValidationError(
      'targetServices (profile-only mode) must be exactly ["identity","profile","ajo"]'
    );
  }
  const set = new Set(targetServices.map(s => String(s).toLowerCase()));
  if (set.size !== 3 || ![...set].every(s => ALLOWED_TARGET_SERVICES.has(s))) {
    throw new WorkOrderValidationError(
      'targetServices must contain exactly: identity, profile, ajo'
    );
  }
  if (datasetId !== 'ALL') {
    throw new WorkOrderValidationError(
      'Profile-only mode (targetServices set) requires datasetId="ALL"'
    );
  }
  return ['identity', 'profile', 'ajo'];
}

/**
 * Submit a record-delete work order.
 * All validation runs BEFORE we touch the network - if this throws, nothing
 * was sent to Adobe.
 */
export async function submitWorkOrder({
  creds, sandboxName, datasetId, displayName, description,
  targetServices, namespacesIdentities,
}) {
  const normalizedDs = validateDatasetId(datasetId);
  const { groups, total } = normalizeNamespacesIdentities(namespacesIdentities);
  const normalizedSvc = validateTargetServices(targetServices, normalizedDs);

  if (!displayName || !String(displayName).trim()) {
    throw new WorkOrderValidationError('displayName is required');
  }

  const body = {
    action: 'delete_identity',
    datasetId: normalizedDs,
    displayName: String(displayName).trim().slice(0, 255),
    description: String(description || '').slice(0, 1000),
    namespacesIdentities: groups,
  };
  if (normalizedSvc) body.targetServices = normalizedSvc;

  const client = createAdobeClient(creds, sandboxName);
  // DELIBERATELY NOT idempotent: a 5xx after Adobe partly processed the
  // create-work-order request must NOT auto-retry. Duplicate work orders
  // would mean duplicate irreversible deletions. The orphan-recovery path
  // (runner/recovery.js) is the safe reconciliation route on next startup.
  const { data } = await client.post(`${config.aep.gateway}${PATH}`, body, {
    headers: { 'Content-Type': 'application/json' },
  });

  return {
    workorderId: data.workorderId,
    status: data.status,
    operationCount: data.operationCount ?? total,
    createdAt: data.createdAt,
    bundleId: data.bundleId,
    datasetId: data.datasetId,
    targetServices: data.targetServices,
  };
}

export async function getWorkOrder({ creds, sandboxName, workorderId }) {
  const client = createAdobeClient(creds, sandboxName);
  const { data } = await client.get(`${config.aep.gateway}${PATH}/${workorderId}`);
  return data;
}

// Exposed for unit tests
export const __internal__ = {
  validateDatasetId, normalizeNamespacesIdentities, validateTargetServices,
};
