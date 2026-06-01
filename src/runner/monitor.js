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

// Per-WO poll backoff (in-memory; resets on restart, which is fine). When Adobe
// is unreachable EVERY poll times out, and without backoff the monitor re-polls
// all open WOs every 60s — flooding a flaky network and contending with a
// concurrent destructive Submit's /quota preflight (2026-06-01 prod incident:
// "monitor tick complete polled=10 failed=10" on repeat). Exponential backoff
// lets a permatimeouting WO fall back to infrequent polls and snap back to full
// cadence the instant a poll succeeds. woId -> { fails, nextAt (ms epoch) }.
const _pollBackoff = new Map();
const BACKOFF_BASE_MS = POLL_INTERVAL_MS;   // 1 unit = one normal poll interval
const MAX_BACKOFF_MULT = 16;                // cap: 16 * 60s = 16 min between polls

function _recordPollFailure(woId, now) {
  const fails = (_pollBackoff.get(woId)?.fails || 0) + 1;
  const mult = Math.min(2 ** fails, MAX_BACKOFF_MULT); // 1st fail → 2×, then 4×, 8×, 16× …
  _pollBackoff.set(woId, { fails, nextAt: now + mult * BACKOFF_BASE_MS });
}

/** Test seam: clear the in-memory poll backoff between cases. */
export function _clearPollBackoff() { _pollBackoff.clear(); }

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

export async function tick() {
  if (_running) {
    // Previous tick still in flight (Adobe slow / rate-limited). Skip
    // this one entirely instead of stacking duplicate polls on top.
    logger.info('monitor tick skipped — previous tick still running');
    return;
  }
  _running = true;
  const tickStart = Date.now();
  try {
    const now = tickStart;
    const candidates = q().listOpenWorkOrders.all();   // top 100 by poll cursor

    // Advance the poll cursor for EVERY candidate we look at — including ones we
    // skip for backoff below. listOpenWorkOrders applies LIMIT 100 in SQL and
    // orders by last_polled_at, so if a backed-off WO's cursor never advanced it
    // would freeze at the front of the window and crowd eligible WOs (beyond row
    // 100) out on orgs with >100 concurrently-open WOs. Stamping here (not only
    // on a real poll) keeps the window rotating. This replaces the old
    // per-survivor stamp inside the poll closure.
    for (const wo of candidates) q().stampWorkOrderPolled.run(wo.id);

    // Drop WOs still inside their failure backoff window. When Adobe is
    // unreachable every poll fails; without this the monitor re-polls all open
    // WOs every tick, flooding a flaky network and starving a concurrent
    // Submit's /quota preflight. A backed-off WO resumes the instant its window
    // elapses, and a single success clears it entirely (below).
    const open = candidates.filter((wo) => {
      const b = _pollBackoff.get(wo.id);
      return !b || now >= b.nextAt;
    });
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
      // (The poll cursor was already stamped for every candidate above — review
      // finding #9 rotation — so a permafailing WO yields to never-polled ones
      // and backed-off WOs can't freeze the LIMIT-100 window.)
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
        // The monitor updates DISPLAY status only — it deliberately does NOT
        // touch the quota ledger (review R5). An Adobe-accepted reservation is
        // HELD until period rollover; deactivating it on terminal status (the
        // R4.1 behaviour) reopened capacity before the org-wide /quota floor
        // caught up → over-ship. There is no per-tool attribution that proves a
        // terminal WO's count is already in the floor, so we never drop it here.
        _pollBackoff.delete(wo.id);   // a success snaps the WO back to full cadence
        succeeded++;
      } catch (err) {
        _recordPollFailure(wo.id, now);   // escalating backoff so a flaky network can't be flooded
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
