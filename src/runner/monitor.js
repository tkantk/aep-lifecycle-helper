import pLimit from 'p-limit';
import { getWorkOrder } from '../services/hygiene.js';
import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { decryptCreds } from '../utils/crypto.js';

/**
 * In-process status monitor.
 *
 * Runs every 60 seconds, checks all work orders that have been submitted
 * to Adobe but haven't reached a terminal status yet, and updates their
 * status in the local DB.
 *
 * Each tick polls up to 100 open orders with 5 concurrent Adobe GETs.
 * At 1,500+ work orders (large jobs) this completes a full poll cycle
 * in ~15 min instead of ~52 min with the old serial/30-limit approach.
 */

const POLL_INTERVAL_MS = 60_000;
const POLL_CONCURRENCY = 5;

export function startMonitor() {
  setInterval(tick, POLL_INTERVAL_MS);
  // Run once on startup so we don't wait a full minute for first update
  setTimeout(tick, 5_000);
  logger.info('status monitor started (poll every 60s)');
}

async function tick() {
  try {
    const open = q().listOpenWorkOrders.all();
    if (open.length === 0) return;

    const limit = pLimit(POLL_CONCURRENCY);
    await Promise.all(open.map(wo => limit(async () => {
      try {
        const creds = await decryptCreds(wo.j_creds_id);
        const adobe = await getWorkOrder({
          creds,
          sandboxName: wo.j_sandbox_name,
          workorderId: wo.adobe_workorder_id,
        });

        q().updateWorkOrderAdobeStatus.run(
          adobe.status,
          adobe.status,
          adobe.status,
          adobe.productStatusDetails ? JSON.stringify(adobe.productStatusDetails) : null,
          adobe.status,
          wo.id
        );
      } catch (err) {
        logger.warn({ workOrderId: wo.id, err: err.message }, 'status poll failed - will retry');
      }
    })));
  } catch (err) {
    logger.error({ err: err.message }, 'monitor tick error');
  }
}
