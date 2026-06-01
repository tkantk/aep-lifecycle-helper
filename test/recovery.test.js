/**
 * Tests for runner/recovery.js — startup reconciliation of jobs / work orders
 * left mid-flight by a previous crash.
 *
 * These are "DB-level" integration tests: we seed SQLite rows to simulate the
 * crash state, then call the recovery functions and assert on post-state.
 * Adobe API calls are mocked via nock where the reconciliation code reaches
 * out.
 */

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-recovery-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { reconcileOrphanWorkOrders, reconcileJobOrphans, resumeExpandingJobs } = await import('../src/runner/recovery.js');
const { reserve, peek } = await import('../src/services/quotaManager.js');
const { isWorkOrderReconciling } = await import('../src/runner/postingState.js');

const GATEWAY = 'https://platform.adobe.io';

before(() => { initDb(); });

// Wipe per-test state. Recovery now leaves un-matched orphans in 'submitting'
// (R6 #1 — no unsafe auto-rollback), so without this they would accumulate and
// a later reconcileOrphanWorkOrders() would process prior tests' orphans against
// the current test's single nock mock → spurious live retries.
afterEach(() => {
  nock.cleanAll();
  db.exec('DELETE FROM quota_reservations; DELETE FROM work_orders; DELETE FROM jobs;');
});

after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function seedCredAndJob({ status = 'submitting', name = 'test-job' } = {}) {
  seq++;
  const credsId = storeCreds({
    label: `Test ${seq}`,
    environment: 'prod',
    region: 'VA7',
    imsOrgId: `org-${seq}@AcmeOrg`,
    clientId: `client-${seq}`,
    clientSecret: 'secret-value',
  });
  const jobId = `job-${seq}`;
  q().insertJob.run({
    id: jobId, name, credsId,
    sandboxName: 'test-sandbox', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run(status, null, jobId);
  return { credsId, jobId };
}

function seedOrphanWorkOrder(jobId, localId, displayName = null) {
  q().insertWorkOrder.run({
    id: localId, jobId, dayIndex: 1,
    datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([
      { namespace: { code: 'email', id: 6 }, ids: ['a@x.com','b@x.com'] },
    ]),
    identifierCount: 2,
    status: 'submitting',   // stuck mid-submit
  });
  if (displayName) q().setWorkOrderSubmittingWithName.run({ id: localId, displayName });
}

function mockIms() {
  nock('https://ims-na1.adobelogin.com')
    .post('/ims/token/v3')
    .reply(200, { access_token: 'tok-abc', expires_in: 86400 });
}

// ─── reconcileOrphanWorkOrders ────────────────────────────────────────────────

test('R6 #1: Adobe list has no match for an uncertain POST → INDETERMINATE (stays submitting, NOT rolled back)', async () => {
  // A recognized-but-empty list does NOT prove Adobe never received the POST —
  // work-order creation is async and Adobe gives no read-after-write contract.
  // Rolling back to 'planned' + releasing would let the next submit re-POST a
  // work order Adobe may already be processing → DUPLICATE irreversible delete.
  // So a no-match is treated as indeterminate: leave the orphan in 'submitting',
  // hold its reservation, and surface it for operator reconciliation.
  const { jobId } = seedCredAndJob({ name: 'match-miss' });
  const localId = `wo-miss-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  // The orphan holds a pending reservation (reserved, POST outcome unknown).
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { workorders: [] });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting', 'must NOT roll back — absence is not proven');
  assert.equal(q().getReservation.get(localId).active, 1, 'reservation stays held (not released)');
  assert.match(wo.last_error || '', /unconfirmed|not yet listed|reconcil/i);
});

test('R9 #1: a reconcile DISCARDS a FOUND result if the WO changed during the awaited lookup (CAS)', async () => {
  // The duplicate-delete race: a reconcile snapshots the orphan, awaits the Adobe
  // lookup, and during that await the operator releases + retries the WO. Applying
  // the (now stale) FOUND result would clobber local state. The attempt-CAS
  // discards it. (The reconciling guard normally blocks the release entirely;
  // this proves the defense-in-depth CAS independently.)
  const { jobId } = seedCredAndJob({ name: 'cas-found' });
  const localId = `wo-casf-${seq}`;
  const name = `Delete cas-found - WO ${localId}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });

  mockIms();
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(120)
    .reply(200, { results: [{ workorderId: 'DI-stale', displayName: name, status: 'received', createdAt: '2026-05-31T00:00:00Z' }] });

  const p = reconcileOrphanWorkOrders();              // awaits the delayed lookup
  await new Promise(r => setTimeout(r, 40));
  q().bumpWorkOrderAttempt.run(localId);              // simulate operator release+retry mid-lookup
  await p;

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.adobe_workorder_id, null, 'stale FOUND result discarded — Adobe ID NOT recorded');
  assert.equal(wo.status, 'submitting', 'WO not flipped to submitted by the stale result');
});

test('R9 #1: a reconcile DISCARDS a NO-MATCH write if the WO changed during the lookup (no stale revert)', async () => {
  const { jobId } = seedCredAndJob({ name: 'cas-nomatch' });
  const localId = `wo-casn-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });

  mockIms();
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(120)
    .reply(200, { results: [] });                     // no match

  const p = reconcileOrphanWorkOrders();
  await new Promise(r => setTimeout(r, 40));
  // Simulate the operator having released + retried: status→planned, attempt bumped.
  q().bumpWorkOrderAttempt.run(localId);
  q().updateWorkOrderStatus.run('planned', null, localId);
  await p;

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'planned', 'stale NO-MATCH write discarded — WO not reverted to submitting');
});

test('R9 follow-up: concurrent reconciles keep the WO guarded until BOTH settle (refcount, no premature unmark)', async () => {
  // A plain Set let whichever concurrent reconcile finished a WO first delete the
  // shared guard out from under the other run's still-in-flight lookup, reopening
  // the duplicate-delete window. The refcount keeps the WO guarded until the LAST
  // in-flight reconcile for it settles.
  const { jobId } = seedCredAndJob({ name: 'concurrent' });
  const localId = `wo-conc-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });

  nock('https://ims-na1.adobelogin.com').persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  // Two lookups: the first reconcile gets the FAST (40ms) reply, the second the SLOW (200ms).
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(40).reply(200, { results: [] });
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(200).reply(200, { results: [] });

  const pA = reconcileOrphanWorkOrders();   // marks (count 0→1)
  const pB = reconcileOrphanWorkOrders();   // marks (count 1→2)

  // After the FAST reconcile has finished + unmarked (count 2→1) but the SLOW one
  // is still awaiting its lookup, the WO MUST still be guarded.
  await new Promise(r => setTimeout(r, 100));
  assert.equal(isWorkOrderReconciling(localId), true,
    'guard held while the slower reconcile lookup is still in flight (refcount > 0)');

  await Promise.all([pA, pB]);
  assert.equal(isWorkOrderReconciling(localId), false,
    'guard cleared only after BOTH reconciles settled (refcount back to 0)');
});

// ─── R10 #1: concurrent reconcile results are monotonic (CAS requires unresolved) ──

// Run two concurrent reconcileOrphanWorkOrders over ONE orphan; first lookup gets
// `firstReply` (delay 40ms), second gets `secondReply` (delay 200ms). Returns the
// final WO row.
async function twoConcurrentReconciles(name, firstReply, secondReply) {
  const { jobId } = seedCredAndJob({ name });
  const localId = `wo-mono-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });
  nock('https://ims-na1.adobelogin.com').persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(40).reply(200, firstReply(localId, name));
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true).delay(200).reply(200, secondReply(localId, name));
  await Promise.all([reconcileOrphanWorkOrders(), reconcileOrphanWorkOrders()]);
  return q().getAllOrdersForJob.all(jobId).find(w => w.id === localId);
}

const FOUND = (status) => (localId, name) => ({ results: [{ workorderId: 'DI-original', displayName: `Delete ${name} - WO ${localId}`, status, createdAt: '2026-06-01T00:00:00Z' }] });
const EMPTY = () => ({ results: [] });

test('R10 #1: FOUND (fast) then EMPTY (slow) — the match is NOT overwritten to submitting', async () => {
  const wo = await twoConcurrentReconciles('mono-fe', FOUND('received'), EMPTY);
  assert.equal(wo.adobe_workorder_id, 'DI-original');
  assert.equal(wo.status, 'submitted', 'the stale slow no-match must NOT revert the resolved match');
});

test('R10 #1: EMPTY (fast) then FOUND (slow) — the match still wins', async () => {
  const wo = await twoConcurrentReconciles('mono-ef', EMPTY, FOUND('received'));
  assert.equal(wo.adobe_workorder_id, 'DI-original');
  assert.equal(wo.status, 'submitted', 'a later found result resolves the still-unresolved orphan');
});

test('R10 #1+#2: terminal FOUND (fast) then EMPTY (slow) — finalised, not reverted', async () => {
  const wo = await twoConcurrentReconciles('mono-te', FOUND('completed'), EMPTY);
  assert.equal(wo.adobe_workorder_id, 'DI-original');
  assert.equal(wo.status, 'completed', 'terminal match finalised; slow no-match discarded');
  assert.ok(wo.completed_at, 'completed_at stamped');
});

// ─── R10 #2: reconcile finalises an already-terminal Adobe match ──────────────

test('R10 #2 (startup): a reconcile match returning completed → local completed + completed_at (not stranded submitted)', async () => {
  const { jobId } = seedCredAndJob({ name: 'term-startup' });
  const localId = `wo-term-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });
  mockIms();
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true)
    .reply(200, { results: [{ workorderId: 'DI-done', displayName: `Delete term-startup - WO ${localId}`, status: 'completed', createdAt: '2026-06-01T00:00:00Z' }] });

  await reconcileOrphanWorkOrders();

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.adobe_workorder_id, 'DI-done');
  assert.equal(wo.status, 'completed', 'local status normalised to terminal (not stuck submitted)');
  assert.equal(wo.adobe_status, 'completed');
  assert.ok(wo.completed_at, 'completed_at stamped so the monitor/list/delete treat it as terminal');
});

test('R10 #2 (manual route): reconcileJobOrphans finalises a terminal=failed match', async () => {
  const { jobId } = seedCredAndJob({ name: 'term-route' });
  const localId = `wo-termr-${seq}`;
  seedOrphanWorkOrder(jobId, localId);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });
  mockIms();
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(true)
    .reply(200, { results: [{ workorderId: 'DI-failed', displayName: `Delete term-route - WO ${localId}`, status: 'failed', createdAt: '2026-06-01T00:00:00Z' }] });

  const r = await reconcileJobOrphans(jobId);
  assert.equal(r.matched, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.adobe_workorder_id, 'DI-failed');
  assert.equal(wo.status, 'failed', 'terminal=failed normalised locally');
  assert.ok(wo.completed_at, 'completed_at stamped');
});

test('R10 #3: a SLOW lookup for one orphan does not hold the reconcile guard for another (parallel)', async () => {
  const { jobId } = seedCredAndJob({ name: 'parallel' });
  const slowId = `wo-slow-${seq}`;
  const fastId = `wo-fast-${seq}`;
  seedOrphanWorkOrder(jobId, slowId);
  seedOrphanWorkOrder(jobId, fastId);
  reserve({ workOrderId: slowId, imsOrgId: `org-${seq}@AcmeOrg`, count: 1, dailyLimit: 1_000_000, monthlyLimit: null });
  reserve({ workOrderId: fastId, imsOrgId: `org-${seq}@AcmeOrg`, count: 1, dailyLimit: 1_000_000, monthlyLimit: null });

  nock('https://ims-na1.adobelogin.com').persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(q => (q.displayName || '').includes(slowId)).delay(300).reply(200, { results: [] });
  nock(GATEWAY).get(/\/data\/core\/hygiene\/workorder/).query(q => (q.displayName || '').includes(fastId)).delay(20).reply(200, { results: [] });

  const p = reconcileOrphanWorkOrders();
  // The fast orphan's lookup settles quickly and unguards it, even though the
  // slow orphan's lookup is still in flight — they run in parallel, so the slow
  // one can't hold the guard for the fast one (pre-R10 #3 sequential would have).
  await new Promise(r => setTimeout(r, 120));
  assert.equal(isWorkOrderReconciling(fastId), false, 'fast orphan unguarded once ITS lookup settled');
  assert.equal(isWorkOrderReconciling(slowId), true, 'slow orphan still guarded while ITS lookup is in flight');

  await p;
  assert.equal(isWorkOrderReconciling(slowId), false, 'slow orphan unguarded after its lookup settled');
});

test('R6 #2: recovery matches a long-job-name orphan via the stored UUID-first display_name', async () => {
  // A long job name truncated at 255 would drop a trailing UUID, making the WO
  // invisible to recovery → false "absent". The fix: a UUID-FIRST displayName is
  // persisted durably (work_orders.display_name) before the POST, and recovery
  // matches that exact stored value (not a reconstruction). The orphan is then
  // correctly found and accepted, never lost.
  const longName = 'X'.repeat(300);
  const { jobId } = seedCredAndJob({ name: longName });
  const localId = `wo-long-${seq}`;
  const sentName = `WO ${localId} - Delete ${longName}`.slice(0, 255);   // UUID survives at the front
  seedOrphanWorkOrder(jobId, localId, sentName);
  reserve({ workOrderId: localId, imsOrgId: `org-${seq}@AcmeOrg`, count: 2, dailyLimit: 1_000_000, monthlyLimit: null });
  assert.ok(sentName.includes(localId), 'precondition: the UUID survives 255-char truncation');

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { results: [{ workorderId: 'DI-long-1', displayName: sentName, status: 'received', createdAt: '2026-05-31T00:00:00Z' }] });

  await reconcileOrphanWorkOrders();

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted', 'matched by stored display_name → recorded as submitted');
  assert.equal(wo.adobe_workorder_id, 'DI-long-1');
  assert.equal(q().getReservation.get(localId).accepted, 1, 'matched orphan is marked accepted (held)');
});

test('reconcile: Adobe finds matching work order → record Adobe ID', async () => {
  const { jobId } = seedCredAndJob({ name: 'match-hit' });
  const localId = `wo-hit-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  // Display name now uses the full local UUID (F-009 fix).
  const displayName = `Delete match-hit - WO ${localId}`;

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, {
      workorders: [{
        workorderId: 'DI-recovered-abc-123',
        displayName,
        status: 'received',
        bundleId: 'BN-xyz',
        createdAt: '2026-04-23T10:00:00Z',
      }],
    });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted');
  assert.equal(wo.adobe_workorder_id, 'DI-recovered-abc-123');
});

test('reconcile: Adobe\'s documented {results:[...]} shape is matched (not rolled back)', async () => {
  // Adobe's live Data Hygiene list endpoint returns the matches under a
  // top-level `results` array (plus `total`/`count`/`_links`), NOT
  // `workorders`/`items`. The pre-fix code only looked for the latter two,
  // so a genuinely-processed work order was reported ABSENT and rolled
  // back → next submit duplicated the irreversible delete.
  const { jobId } = seedCredAndJob({ name: 'results-shape' });
  const localId = `wo-results-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  const displayName = `Delete results-shape - WO ${localId}`;

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, {
      results: [{
        workorderId: 'DI-results-shape-1',
        displayName,
        status: 'received',
        bundleId: 'BN-results',
        createdAt: '2026-05-31T10:00:00Z',
      }],
      total: 1,
      count: 1,
      _links: {},
    });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitted', 'WO present in Adobe under `results` must be recorded, never rolled back');
  assert.equal(wo.adobe_workorder_id, 'DI-results-shape-1');
});

test('reconcile: unrecognized 200 response shape is indeterminate (fail closed, no rollback)', async () => {
  // If Adobe returns a 200 whose shape we DON'T recognize (future API change,
  // a renamed container, an error envelope with HTTP 200), we must NOT
  // conclude the order is absent — that would roll back + release quota and
  // risk a duplicate on the next submit. Unknown shape → leave it submitting.
  const { jobId } = seedCredAndJob({ name: 'unknown-shape' });
  const localId = `wo-unknown-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { somethingElse: 'we do not understand this', data: { nested: true } });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting',
    'unrecognized 200 shape must stay submitting (fail closed) so we never risk a duplicate');
  assert.equal(wo.adobe_workorder_id, null);

  // Cleanup so it doesn't pollute later whole-DB orphan counts.
  q().updateWorkOrderStatus.run('failed', 'test cleanup', wo.id);
});

test('reconcile: Adobe 400 on lookup leaves orphan in submitting (no roll-back, no quota release)', async () => {
  // Regression: the lookup returning null on 400 used to roll the orphan
  // back to planned, which on next submit could create a duplicate Adobe
  // work order if the original POST had actually been processed. The fix
  // returns LOOKUP_INDETERMINATE on 400, leaving the row alone.
  const { jobId } = seedCredAndJob({ name: 'four-hundred' });
  const localId = `wo-400-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(400, { message: 'displayName filter not supported in this API version' });

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  // MUST still be submitting — not rolled back to planned.
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting',
    'orphan must stay submitting on lookup-indeterminate so we don\'t risk duplicates');
  assert.equal(wo.adobe_workorder_id, null);

  // Cleanup: remove this orphan so it doesn't pollute later tests that
  // count rows from listSubmittingOrphanOrders across the whole DB.
  q().updateWorkOrderStatus.run('failed', 'test cleanup', wo.id);
});

test('reconcile: transient error leaves orphan alone for next startup', async () => {
  const { jobId } = seedCredAndJob({ name: 'transient' });
  const localId = `wo-trans-${seq}`;
  seedOrphanWorkOrder(jobId, localId);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .times(6)   // axios-retry will retry up to 5 times on 5xx
    .reply(503, 'Service Unavailable');

  const count = await reconcileOrphanWorkOrders();
  assert.equal(count, 1);

  // Orphan should still be in submitting state so a later restart can retry.
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting');
  assert.equal(wo.adobe_workorder_id, null);
});

test('R6 #1: a no-match does NOT release the reservation (held until operator resolution, no over-ship/duplicate)', async () => {
  // Pre-R6 this rolled back + released on a no-match. That was unsafe: if Adobe
  // had actually processed the (uncertain) POST, releasing freed quota Adobe
  // spent AND the next submit re-POSTed a duplicate. R6 holds the reservation
  // and keeps the WO in 'submitting' — the SAFE direction (over-defer until the
  // operator confirms, never over-ship, never duplicate).
  const { jobId } = seedCredAndJob({ name: 'held-on-nomatch' });
  const imsOrgId = `org-${seq}@AcmeOrg`;
  const localId = `wo-held-${seq}`;
  seedOrphanWorkOrder(jobId, localId);          // identifier_count = 2
  const COUNT = 2;

  const r = reserve({ workOrderId: localId, imsOrgId, count: COUNT, dailyLimit: 1_000_000, monthlyLimit: 3_000_000 });
  assert.equal(r.granted, true);
  assert.equal(peek(imsOrgId, 1_000_000, 3_000_000).daily.used, COUNT);

  mockIms();
  nock(GATEWAY)
    .get(/\/data\/core\/hygiene\/workorder/)
    .query(true)
    .reply(200, { results: [], total: 0, count: 0 });

  await reconcileOrphanWorkOrders();

  const after = peek(imsOrgId, 1_000_000, 3_000_000);
  assert.equal(after.daily.used, COUNT, 'reservation still HELD (not released on an unproven absence)');
  assert.equal(after.monthly.used, COUNT, 'monthly still held too');
  const wo = q().getAllOrdersForJob.all(jobId)[0];
  assert.equal(wo.status, 'submitting', 'stays submitting for operator reconciliation — never auto-rolled-back');
});

// ─── resumeExpandingJobs ──────────────────────────────────────────────────────

test('resume: job with no upload file is marked failed', async () => {
  const { jobId } = seedCredAndJob({ status: 'expanding', name: 'no-file' });
  // upload_path was null in seedCredAndJob → fs.existsSync returns false.

  const count = await resumeExpandingJobs();
  assert.equal(count, 1);

  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /upload file/i);
});

test('resume: empty expanding list is a no-op', async () => {
  const count = await resumeExpandingJobs();
  assert.equal(count, 0);
});
