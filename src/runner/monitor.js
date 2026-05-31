import pLimit from 'p-limit';
import { getWorkOrder } from '../services/hygiene.js';
import { q } from '../db.js';
import { logger } from '../utils/logger.js';
import { decryptCreds } from '../utils/crypto.js';
import { complete as completeReservation } from '../services/quotaManager.js';

// Adobe terminal states. 'completed' and 'failed' both mean the request was
// ACCEPTED (it has an adobe_workorder_id) and thus counts toward quota, so we
// move its reservation into adobe_floor either way (review R4 #1).
const TERMINAL_ADOBE_STATUSES = new Set(['completed', 'failed']);

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
// Per-WO status GET timeout. Deliberately short. Adobe's GET /workorder/:id
// should respond in <2 s; when it doesn't (rate limit, slow upstream), the
// next tick will retry. Capping it short prevents the snowball scenario
// where each tick's HTTP requests hang for the full 60 s axios timeout
// while the next interval tick fires on top, hammering Adobe with
// duplicate concurrent polls and locking up the event loop. Real
// 2026-05-29 incident: the operator's Monitor tab showed a loading
// spinner forever because half a dozen overlapping ticks each held
// 60 s-timeout polls on the same 6 work orders.
const POLL_PER_REQUEST_TIMEOUT_MS = 15_000;

let _interval = null;
let _startupTick = null;
// Reentrancy guard: a tick is non-blocking from setInterval's perspective,
// but the Adobe HTTP calls inside can take longer than POLL_INTERVAL_MS
// when Adobe is slow. Without a guard, multiple ticks pile up running in
// parallel — each fetches the SAME open WO list and hammers Adobe with
// duplicate GETs. The guard makes overlapping ticks a no-op.
let _running = false;

export function startMonitor() {
  _interval = setInterval(tick, POLL_INTERVAL_MS);
  // Run once on startup so we don't wait a full minute for first update
  _startupTick = setTimeout(tick, 5_000);
  logger.info('status monitor started (poll every 60s)');
}

/**
 * Stop the polling intervals so the event loop can drain on shutdown.
 * Without this the setInterval keeps the process alive until the 10s
 * force-exit timer fires — meaning Ctrl+C feels broken to the operator.
 */
export function stopMonitor() {
  if (_interval)    { clearInterval(_interval);    _interval = null; }
  if (_startupTick) { clearTimeout(_startupTick);  _startupTick = null; }
}

async function tick() {
  if (_running) {
    // Previous tick still in flight (Adobe slow / rate-limited). Skip
    // this one entirely instead of stacking duplicate polls on top.
    logger.info('monitor tick skipped — previous tick still running');
    return;
  }
  _running = true;
  const tickStart = Date.now();
  try {
    const open = q().listOpenWorkOrders.all();
    if (open.length === 0) return;

    // Per-tick credential cache. Most ticks hit 1-3 distinct creds_ids across
    // 100 work orders; without this we'd decrypt the same secret up to 100x
    // per minute. Cache the PROMISE so parallel callers share one decrypt.
    const credsCache = new Map();
    const getCreds = (credsId) => {
      let p = credsCache.get(credsId);
      if (!p) {
        p = decryptCreds(credsId);
        credsCache.set(credsId, p);
      }
      return p;
    };

    let succeeded = 0, failed = 0;
    const limit = pLimit(POLL_CONCURRENCY);
    await Promise.all(open.map(wo => limit(async () => {
      // Stamp the poll cursor on every ATTEMPT (success or failure) so this WO
      // rotates to the back of listOpenWorkOrders and can't starve others on
      // jobs with >100 open orders (review finding #9). A permafailing WO
      // therefore yields to never-polled ones instead of monopolising the tick.
      q().stampWorkOrderPolled.run(wo.id);
      try {
        const creds = await getCreds(wo.j_creds_id);
        const adobe = await getWorkOrder({
          creds,
          sandboxName: wo.j_sandbox_name,
          workorderId: wo.adobe_workorder_id,
          timeoutMs: POLL_PER_REQUEST_TIMEOUT_MS,
        });

        q().updateWorkOrderAdobeStatus.run(
          adobe.status,
          adobe.status,
          adobe.status,
          adobe.productStatusDetails ? JSON.stringify(adobe.productStatusDetails) : null,
          adobe.status,
          wo.id
        );
        // On reaching a terminal Adobe state, move this WO's reservation into
        // adobe_floor (atomic, effective-preserving) so it isn't double-counted
        // once Adobe's /quota reflects it (review R4 #1). Idempotent: a no-op
        // once the reservation is already inactive.
        if (TERMINAL_ADOBE_STATUSES.has(adobe.status)) {
          try { completeReservation(wo.id); }
          catch (e) { logger.warn({ workOrderId: wo.id, err: e.message }, 'reservation complete() failed'); }
        }
        succeeded++;
      } catch (err) {
        failed++;
        logger.warn({ workOrderId: wo.id, err: err.message }, 'status poll failed - will retry');
      }
    })));
    const elapsedMs = Date.now() - tickStart;
    if (open.length > 0) {
      logger.info({
        polled: open.length, succeeded, failed, elapsedMs,
      }, 'monitor tick complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'monitor tick error');
  } finally {
    _running = false;
  }
}
