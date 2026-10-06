/**
 * Fix 1 (2026-10-06 review): Submit ships EXACTLY the work orders the operator
 * confirmed — never a silent no-op, never a different set.
 *
 * Root cause (reproduced, incl. the 2026-05-30 prod incident): runSubmission
 * re-bucketed every un-shipped work order (redistributeUnshippedOrders) and only
 * THEN selected by the (month, day) label the UI had sent. Whenever the
 * re-bucket moved labels (month rollover, safety buffer, partial day), the click
 * shipped nothing (submitted=0 deferred=0 failed=0) or a different batch than
 * the confirmation dialog listed.
 *
 * Runs with WORK_ORDER_CONCURRENCY=1 so the per-work-order re-check (a WO whose
 * status changed while queued must not ship) can be exercised deterministically.
 */

process.env.WORK_ORDER_CONCURRENCY = '1';

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-submit-ids-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '5000';
process.env.QUOTA_PREFLIGHT_RETRY_DELAY_MS = '1';

// ── Controllable clock: only Date moves; timers are real ─────────────────
const RealDate = Date;
let offsetMs = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offsetMs); else super(...a); }
  static now() { return RealDate.now() + offsetMs; }
}
globalThis.Date = FakeDate;
const setClock = (iso) => { offsetMs = new RealDate(iso).getTime() - RealDate.now(); };

const { initDb, q, db, setWorkOrderSubmittingDurable } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runSubmission } = await import('../src/runner/submission.js');
const { redistributeUnshippedOrders } = await import('../src/runner/redistributor.js');
const { _clearCache: clearQuotaCache } = await import('../src/services/quotaApi.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

const IMS = 'https://ims-na1.adobelogin.com';
const GATEWAY = 'https://platform.adobe.io';

let server, baseUrl;
before(async () => {
  initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/jobs', jobsRouter);
  app.use(makeErrorHandler(logger));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.Date = RealDate;
  nock.cleanAll();
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});
beforeEach(() => { nock.cleanAll(); clearQuotaCache(); });

// ── Fake Adobe: org-wide consumption per UTC day / month ─────────────────
function fakeAdobe({ daily = 1_000_000, monthly = 3_000_000 } = {}) {
  const adobe = { byDay: new Map(), byMonth: new Map(), posts: [] };
  const day = () => new Date().toISOString().slice(0, 10);
  const mon = () => new Date().toISOString().slice(0, 7);
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, () => ({
    quotas: [
      { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: adobe.byDay.get(day()) || 0, quota: daily },
      { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: adobe.byMonth.get(mon()) || 0, quota: monthly },
    ],
  }));
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply((_uri, body) => {
    // Charge what the WO really carries (identifier_count), found via the UUID-first displayName.
    const woId = /^WO ([0-9a-f-]{36}) /.exec(body.displayName)?.[1];
    const count = db.prepare('SELECT identifier_count AS n FROM work_orders WHERE id = ?').get(woId)?.n ?? 1;
    adobe.byDay.set(day(), (adobe.byDay.get(day()) || 0) + count);
    adobe.byMonth.set(mon(), (adobe.byMonth.get(mon()) || 0) + count);
    adobe.posts.push(woId);
    return [200, { workorderId: `DI-${adobe.posts.length}`, status: 'received', createdAt: new Date().toISOString() }];
  });
  return adobe;
}

let seq = 0;
/** Job with planned work orders: `n` orders of `size`, or an explicit array of sizes (tiny real payloads). */
function seedJob(n, size = 100_000) {
  const sizes = Array.isArray(n) ? n : Array(n).fill(size);
  seq++;
  const credsId = storeCreds({
    label: `Ids ${seq}`, environment: 'Production', region: 'va7',
    imsOrgId: `ids-org-${seq}@AdobeOrg`, clientId: `ids-client-${seq}`, clientSecret: 's',
  });
  const jobId = uuid();
  q().insertJob.run({
    id: jobId, name: `Ids ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL',
    targetServicesJson: null, sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 0,
  });
  q().updateJobStatus.run('ready', null, jobId);
  const ids = [];
  for (let i = 0; i < sizes.length; i++) {
    const id = uuid();
    ids.push(id);
    q().insertWorkOrder.run({
      id, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
      namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: [`wo${i}@x.com`] }]),
      identifierCount: sizes[i], status: 'planned',
    });
  }
  return { jobId, ids };
}

/** Exactly what the Submit tab offers: first (month, day) bucket with planned/deferred work. */
function dialogSelection(jobId) {
  const all = q().listWorkOrderMetaForJob.all(jobId);
  const pending = all.filter(w => ['planned', 'deferred'].includes(w.status));
  if (!pending.length) return { ids: [], monthIndex: null, dayIndex: null };
  const first = pending.reduce((a, w) =>
    ((w.month_index ?? 1) < (a.month_index ?? 1) ||
     ((w.month_index ?? 1) === (a.month_index ?? 1) && w.day_index < a.day_index)) ? w : a);
  const bucket = pending.filter(w => (w.month_index ?? 1) === (first.month_index ?? 1) && w.day_index === first.day_index);
  return { ids: bucket.map(w => w.id), monthIndex: first.month_index ?? 1, dayIndex: first.day_index };
}

function planLikeRoute(jobId) {
  // planWorkOrders = insert + redistribute + mark Month 2+ awaiting; WOs are pre-seeded here.
  return getQuota(jobId).then(quota => {
    redistributeUnshippedOrders(jobId, quota);
    q().markFutureMonthsAwaitingApproval.run(jobId);
  });
}
async function getQuota(jobId) {
  const { getOrgQuota } = await import('../src/services/quotaApi.js');
  const job = q().getJob.get(jobId);
  const c = q().getCred.get(job.creds_id);
  return getOrgQuota({ imsOrgId: c.ims_org_id, clientId: c.client_id, clientSecret: 's', region: c.region }, { refresh: true });
}
async function submit(jobId, args) {
  const r = await runSubmission({ jobId, ...args });
  clearQuotaCache();
  return r;
}
const shippedSet = (jobId) => new Set(q().listWorkOrderMetaForJob.all(jobId).filter(w => w.adobe_workorder_id).map(w => w.id));

/** What TODAY's Submit tab sends (src/web/app.js before this fix): the lowest DAY
 *  number across all months, month taken from the first pending order of that day. */
function legacyUiSelection(jobId) {
  const all = q().listWorkOrderMetaForJob.all(jobId);
  const pending = all.filter(w => ['planned', 'deferred'].includes(w.status));
  const day = pending.reduce((m, w) => Math.min(m, w.day_index), Infinity);
  const shown = all.filter(w => w.day_index === day && ['planned', 'deferred'].includes(w.status));
  return { ids: shown.map(w => w.id), monthIndex: shown[0]?.month_index ?? null, dayIndex: day };
}

/** Oct 20-23 on a 3M/month org with the legacy UI, then Month 2 approved — the sim7 state. */
async function monthRolloverState() {
  fakeAdobe({ daily: 1_000_000, monthly: 3_000_000 });
  const { jobId, ids } = seedJob(68);
  setClock('2026-10-20T09:00:00Z');
  await planLikeRoute(jobId);
  for (const iso of ['2026-10-20', '2026-10-21', '2026-10-22']) {
    setClock(`${iso}T09:00:00Z`);
    const d = legacyUiSelection(jobId);
    await submit(jobId, { monthIndex: d.monthIndex, dayIndex: d.dayIndex });
  }
  q().approveMonth.run(jobId, 2);
  setClock('2026-10-23T09:00:00Z');
  const d = legacyUiSelection(jobId);
  await submit(jobId, { monthIndex: d.monthIndex, dayIndex: d.dayIndex });
  return { jobId, ids };
}

test('confirmed IDs ship exactly — after a month rollover re-labels everything', async () => {
  const { jobId } = await monthRolloverState();
  setClock('2026-11-02T09:00:00Z');
  const dialog = legacyUiSelection(jobId);
  assert.equal(dialog.ids.length, 10, 'precondition: the dialog lists a 10-order batch');
  const before = shippedSet(jobId);
  const r = await submit(jobId, { workOrderIds: dialog.ids });
  const shippedNow = [...shippedSet(jobId)].filter(id => !before.has(id));
  assert.deepEqual(shippedNow.sort(), [...dialog.ids].sort(), 'server shipped exactly the confirmed batch');
  assert.equal(r.submitted, 10);
});

test('confirming part of a bucket ships only that part', async () => {
  const adobe = fakeAdobe({ daily: 1_000_000, monthly: 15_000_000 });
  const { jobId, ids } = seedJob(3);
  setClock('2026-12-10T09:00:00Z');
  await planLikeRoute(jobId);
  const r = await submit(jobId, { workOrderIds: [ids[2]] });
  assert.deepEqual(adobe.posts, [ids[2]]);
  assert.equal(r.submitted, 1);
});

test('a second click the same day never silently does nothing — every confirmed order is accounted for', async () => {
  fakeAdobe({ daily: 1_000_000, monthly: 15_000_000 });
  const { jobId } = seedJob(25);
  setClock('2026-12-01T09:00:00Z');
  await planLikeRoute(jobId);
  await submit(jobId, { workOrderIds: dialogSelection(jobId).ids });     // ships today's 1M
  const d = dialogSelection(jobId);                                      // next batch, same UTC day
  const r = await submit(jobId, { workOrderIds: d.ids });
  assert.equal(r.submitted + r.deferred + r.failed + r.skipped, d.ids.length,
    'each confirmed order is shipped, deferred (quota) or reported skipped');
  assert.equal(r.deferred, d.ids.length, 'today is exhausted, so the batch is deferred — visibly');
});

test('legacy {monthIndex, dayIndex} request selects the bucket BEFORE re-labelling (no silent no-op)', async () => {
  const { jobId } = await monthRolloverState();
  setClock('2026-11-02T09:00:00Z');
  let d = legacyUiSelection(jobId);
  await submit(jobId, { monthIndex: d.monthIndex, dayIndex: d.dayIndex });
  d = legacyUiSelection(jobId);                      // second click, same UTC day
  const r = await submit(jobId, { monthIndex: d.monthIndex, dayIndex: d.dayIndex });
  assert.ok(d.ids.length > 0, 'precondition: the requested bucket had pending work');
  assert.equal(r.submitted + r.deferred, d.ids.length,
    'the bucket the operator saw is the bucket the server acts on (was 0/0/0)');
});

test('May-30 replay: legacy Day-2 request ships the 7 remaining orders (regression guard)', async () => {
  const adobe = fakeAdobe({ daily: 1_000_000, monthly: 12_000_000 });
  const { jobId } = seedJob([...Array(16).fill(100_000), 7_384]);   // the real 1,607,384-id shape
  setClock('2026-05-29T06:00:00Z');
  await planLikeRoute(jobId);
  await submit(jobId, { monthIndex: 1, dayIndex: 1 });
  setClock('2026-05-30T06:00:00Z');
  const before = adobe.posts.length;
  const r = await submit(jobId, { monthIndex: 1, dayIndex: 2 });
  assert.equal(r.submitted, 7);
  assert.equal(adobe.posts.length - before, 7);
});

test('confirmed IDs that are no longer eligible are never POSTed and are reported', async () => {
  const adobe = fakeAdobe({ daily: 1_000_000, monthly: 15_000_000 });
  const { jobId, ids } = seedJob(4);
  const other = seedJob(1);
  setClock('2027-01-05T09:00:00Z');
  await planLikeRoute(jobId);
  q().updateWorkOrderStatus.run('awaiting_approval', null, ids[1]);
  q().updateWorkOrderSubmitted.run({ id: ids[2], adobeWorkorderId: 'DI-earlier', adobeStatus: 'received', bundleId: null, submittedAt: null });

  const r = await submit(jobId, { workOrderIds: [ids[0], ids[1], ids[2], other.ids[0]] });
  assert.deepEqual(adobe.posts, [ids[0]], 'only the still-planned order of THIS job is POSTed');
  assert.equal(r.submitted, 1);
  assert.equal(r.skipped, 3, 'awaiting-approval, already-shipped and foreign IDs are skipped');
});

test('nothing eligible: no POST, job status untouched, operator sees why', async () => {
  const adobe = fakeAdobe({ daily: 1_000_000, monthly: 15_000_000 });
  const { jobId, ids } = seedJob(2);
  setClock('2027-01-06T09:00:00Z');
  await planLikeRoute(jobId);
  for (const id of ids) q().updateWorkOrderSubmitted.run({ id, adobeWorkorderId: `DI-${id}`, adobeStatus: 'received', bundleId: null, submittedAt: null });
  q().updateJobStatus.run('partial', null, jobId);

  const r = await submit(jobId, { workOrderIds: ids });
  assert.equal(adobe.posts.length, 0);
  assert.equal(r.submitted + r.deferred + r.failed, 0);
  assert.equal(r.skipped, 2);
  const job = q().getJob.get(jobId);
  assert.equal(job.status, 'partial', 'a run that shipped nothing must not flip the job to "submitted"');
  assert.match(job.last_error || '', /none of the 2 confirmed work orders/i);
});

test('an order whose status changes while queued is re-checked and not shipped', async () => {
  const { jobId, ids } = seedJob(2);
  setClock('2027-01-07T09:00:00Z');
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [
    { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 },
    { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 15_000_000 },
  ] });
  const posted = [];
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').reply((_u, body) => {
    const woId = /^WO ([0-9a-f-]{36}) /.exec(body.displayName)?.[1];
    posted.push(woId);
    // While the first order is in flight, something else settles the second one.
    if (woId === ids[0]) q().updateWorkOrderStatus.run('awaiting_approval', null, ids[1]);
    return [200, { workorderId: `DI-${posted.length}`, status: 'received', createdAt: new Date().toISOString() }];
  });
  const r = await submit(jobId, { workOrderIds: ids });
  assert.deepEqual(posted, [ids[0]]);
  assert.equal(r.submitted, 1);
  assert.equal(r.skipped, 1);
});

test('durable pre-POST checkpoint fails closed when the row no longer exists', () => {
  assert.equal(setWorkOrderSubmittingDurable(uuid(), 'WO x'), false);
});

// ── Route validation ──────────────────────────────────────────────────────
function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(baseUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

test('POST /submit rejects malformed or foreign workOrderIds with 400 (nothing runs)', async () => {
  const { jobId, ids } = seedJob(2);
  const other = seedJob(1);
  for (const [body, why] of [
    [{ workOrderIds: 'nope' }, 'not an array'],
    [{ workOrderIds: [] }, 'empty'],
    [{ workOrderIds: ['not-a-uuid'] }, 'not a UUID'],
    [{ workOrderIds: [ids[0], other.ids[0]] }, 'belongs to another job'],
    [{ workOrderIds: Array.from({ length: 1001 }, () => uuid()) }, 'too many'],
  ]) {
    const res = await post(`/api/jobs/${jobId}/submit`, body);
    assert.equal(res.status, 400, `expected 400 for ${why}, got ${res.status}`);
    assert.equal(res.body.error, 'invalid_work_order_ids', why);
  }
  assert.equal(q().getJob.get(jobId).last_error, null, 'a rejected request never starts a run');
});

test('POST /submit refuses (409) while a run for the same job is still in flight — never a silent {ok:true}', async () => {
  const { jobId, ids } = seedJob(2);
  const other = seedJob(1);
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 't', expires_in: 86400 });
  nock(GATEWAY).persist().get('/data/core/hygiene/quota').reply(200, { quotas: [
    { name: 'dailyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 1_000_000 },
    { name: 'monthlyConsumerDeleteIdentitiesQuota', consumed: 0, quota: 15_000_000 },
  ] });
  nock(GATEWAY).persist().post('/data/core/hygiene/workorder').delay(400)
    .reply(200, () => ({ workorderId: `DI-${uuid()}`, status: 'received', createdAt: new Date().toISOString() }));

  const first = runSubmission({ jobId, workOrderIds: [ids[0]] });     // in flight for ~400 ms
  await new Promise(r => setTimeout(r, 100));
  const res = await post(`/api/jobs/${jobId}/submit`, { workOrderIds: [ids[1]] });
  assert.equal(res.status, 409, 'the second confirmed batch must be refused visibly');
  assert.equal(res.body.error, 'submission_in_progress');
  const otherJob = await post(`/api/jobs/${other.jobId}/submit`, { workOrderIds: other.ids });
  assert.equal(otherJob.status, 200, 'a different job is not blocked');
  await first;
  clearQuotaCache();
});

test('POST /submit refuses (409) a job whose expansion is still running', async () => {
  const { jobId, ids } = seedJob(1);
  q().updateJobStatus.run('expanding', null, jobId);
  const res = await post(`/api/jobs/${jobId}/submit`, { workOrderIds: ids });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'expansion_running');
});

test('following the plan day by day, every confirmed batch ships in full (10M month, R5 hold)', async () => {
  const adobe = fakeAdobe({ daily: 1_000_000, monthly: 10_000_000 });
  const { jobId } = seedJob(68);
  setClock('2026-10-20T09:00:00Z');
  await planLikeRoute(jobId);
  let partialOrEmpty = 0, days = 0;
  for (let t = new RealDate('2026-10-20T09:00:00Z'); days < 40; t = new RealDate(t.getTime() + 86_400_000), days++) {
    setClock(t.toISOString());
    let meta = q().listWorkOrderMetaForJob.all(jobId);
    if (meta.every(w => w.adobe_workorder_id)) break;
    const cur = 1 + ((t.getUTCFullYear() - 2026) * 12 + t.getUTCMonth() - 9);   // calendar month index vs 2026-10
    // Operator approves next month's work once that month has started (what the gated UI allows).
    const aw = meta.filter(w => w.status === 'awaiting_approval' && w.month_index <= cur);
    if (aw.length) q().approveMonth.run(jobId, Math.min(...aw.map(w => w.month_index)));
    const d = dialogSelection(jobId);
    if (!d.ids.length || d.monthIndex > cur) continue;                         // nothing that can ship today
    const r = await submit(jobId, { workOrderIds: d.ids });
    if (r.submitted !== d.ids.length) partialOrEmpty++;
  }
  assert.equal(adobe.posts.length, 68, 'everything shipped exactly once');
  assert.equal(partialOrEmpty, 0, 'no click that the plan offered came back deferred or empty');
});
