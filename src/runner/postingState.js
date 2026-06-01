/**
 * In-process registry of work orders whose non-idempotent Adobe hygiene POST is
 * CURRENTLY in flight (review R8 #1).
 *
 * A work order in status 'submitting' has TWO meanings: (a) its POST is in
 * flight right now, or (b) the POST settled UNCERTAIN (timeout / 5xx / network)
 * and is awaiting recovery. The operator "release-absent" action must act only
 * on (b): releasing a reservation while its POST may still 2xx would drop the
 * hold and over-ship a destructive, irreversible delete.
 *
 * This set is the precise signal for (a). It is intentionally IN-MEMORY: a
 * crash/restart kills any live POST, so a recovered crash-orphan is correctly
 * NOT considered posting and is eligible for resolution. The single-process
 * advisory lock (index.js) guarantees this set observes every in-flight POST.
 *
 * Kept in its own module (importing nothing) so both runner/submission.js (which
 * marks/unmarks) and runner/recovery.js (which reads) can use it with zero risk
 * of a circular import.
 */

const postingWoIds = new Set();

export function markPosting(workOrderId)   { postingWoIds.add(workOrderId); }
export function unmarkPosting(workOrderId) { postingWoIds.delete(workOrderId); }
export function isWorkOrderPosting(workOrderId) { return postingWoIds.has(workOrderId); }
