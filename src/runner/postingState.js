/**
 * In-process registry of work orders that are in a STATE-DETERMINING operation
 * right now — either their Adobe hygiene POST is in flight (review R8 #1), or a
 * reconciliation lookup against Adobe is in flight for them (review R9 #1).
 *
 * Why this matters: a work order in status 'submitting' is ambiguous — the
 * outcome may still be settling. The operator "release-absent" action (which
 * releases the held reservation and resets the WO to 'planned' for retry) must
 * NOT act on a WO whose fate is still being determined:
 *
 *   • POST in flight — releasing while the POST may still 2xx would drop the
 *     hold and over-ship a destructive, irreversible delete (R8 #1).
 *   • Reconciliation lookup in flight — we are actively asking Adobe whether it
 *     ALREADY has this WO. If the operator releases + retries during that
 *     lookup, and Adobe did have the original, the retry creates a SECOND
 *     irreversible delete (duplicate). The operator must wait for the lookup to
 *     answer before deciding (R9 #1).
 *
 * Both sets are IN-MEMORY by design. They track whether a LOCAL operation is
 * currently in flight in THIS process — NOT whether Adobe received anything. A
 * crash/restart ends any local POST or lookup (there is no live task left to
 * complete it), so a recovered orphan is correctly not considered in-flight and
 * is eligible for operator resolution. Whether Adobe actually accepted a
 * crashed-mid-flight POST is unknowable locally — that is exactly why
 * release-absent is OPERATOR-CONFIRMED (the operator verifies in Adobe's UI by
 * the persisted displayName). The single-process advisory lock (index.js)
 * guarantees these sets observe every in-flight operation.
 *
 * Kept in its own module (importing nothing) so runner/submission.js (POST) and
 * runner/recovery.js (lookup + release-absent) share it with zero risk of a
 * circular import.
 */

const postingWoIds = new Set();
export function markPosting(workOrderId)   { postingWoIds.add(workOrderId); }
export function unmarkPosting(workOrderId) { postingWoIds.delete(workOrderId); }
export function isWorkOrderPosting(workOrderId) { return postingWoIds.has(workOrderId); }

// REFCOUNTED (review R9 follow-up): two reconcile runs (startup + a manual
// POST /reconcile, or two tabs) can be in flight over the SAME work order at
// once — startup recovery is fire-and-forget while the HTTP server already
// accepts requests. A plain Set would let whichever run finishes the WO FIRST
// delete the shared entry out from under the other run's still-in-flight lookup,
// reopening the duplicate-delete window. A per-WO count keeps the WO guarded
// until the LAST in-flight reconcile for it settles. Callers MUST pair each
// markReconciling with exactly one unmarkReconciling (recovery.js tracks a
// per-run set so the per-WO + outer finally never double-decrement).
const reconcilingWoIds = new Map();   // workOrderId -> in-flight reconcile count
export function markReconciling(workOrderId) {
  reconcilingWoIds.set(workOrderId, (reconcilingWoIds.get(workOrderId) || 0) + 1);
}
export function unmarkReconciling(workOrderId) {
  const next = (reconcilingWoIds.get(workOrderId) || 0) - 1;
  if (next <= 0) reconcilingWoIds.delete(workOrderId);   // floors at 0 (never negative)
  else reconcilingWoIds.set(workOrderId, next);
}
export function isWorkOrderReconciling(workOrderId) {
  return (reconcilingWoIds.get(workOrderId) || 0) > 0;
}
