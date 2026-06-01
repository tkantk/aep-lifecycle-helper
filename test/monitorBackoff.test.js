/**
 * 2026-06-01 prod incident: on a flaky network EVERY status poll to Adobe times
 * out, and the monitor re-polls every open WO every 60s ("monitor tick complete
 * polled=10 failed=10" on repeat) — flooding the network and contending with a
 * concurrent destructive Submit's /quota preflight.
 *
 * The monitor now applies per-WO exponential backoff: a WO whose poll FAILS is
 * skipped on the immediately-following tick(s); a WO whose poll SUCCEEDS keeps
 * full cadence. These tests drive the real tick() with nock'd Adobe.
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-monbackoff-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { tick, _clearPollBackoff } = await import('../src/runner/monitor.js');

const IMS_HOST    = 'https://ims-na1.adobelogin.com';
const AEP_GATEWAY = 'https://platform.adobe.io';
const WO_PATH     = '/data/core/hygiene/workorder';

let credsId;
before(() => {
  initDb();
  credsId = storeCreds({
    label: 'MonBack', environment: 'prod', region: 'VA7',
    imsOrgId: 'monback-org@AcmeOrg', clientId: 'monback-client', clientSecret: 'sec',
  });
});
beforeEach(() => {
  nock.cleanAll();
  _clearPollBackoff();
  // Isolation: prior tests' WOs stay 'open' in the shared DB and would be
  // polled by later ticks. Clear them so each test sees only its own WO.
  db.exec('DELETE FROM work_orders; DELETE FROM jobs;');
});
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

function mockIms() {
  nock(IMS_HOST).persist().post('/ims/token/v3')
    .reply(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
}

/** Insert a job + one open (submitted, non-terminal) WO; return its id. */
function seedOpenWorkOrder(suffix) {
  const jobId = `monback-job-${suffix}`;
  q().insertJob.run({
    id: jobId, name: 'MonBack', credsId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: null, totalSourceIds: 0,
  });
  const woId = `monback-wo-${suffix}`;
  q().insertWorkOrder.run({
    id: woId, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 1, status: 'submitting',
  });
  q().updateWorkOrderSubmitted.run({
    id: woId, adobeWorkorderId: `DI-${woId}`, adobeStatus: 'received', bundleId: null,
    submittedAt: '2026-05-31T00:00:00Z',
  });
  return { jobId, woId };
}

test('a WO whose poll FAILS is skipped on the immediately-following tick (backoff)', async () => {
  mockIms();
  const { woId } = seedOpenWorkOrder('fail');

  let hits = 0;
  // Every status GET fails with a 400 (adobeClient does NOT retry 4xx, so one
  // poll = exactly one hit — unlike a 5xx which it retries internally).
  nock(AEP_GATEWAY).persist()
    .get(`${WO_PATH}/DI-${woId}`)
    .reply(() => { hits++; return [400, { message: 'nope' }]; });

  await tick();          // polls once → fails → enters backoff
  await tick();          // WO is in backoff → must be SKIPPED

  assert.equal(hits, 1, 'the failing WO must be polled once, then skipped while in backoff');
});

test('a backed-off WO still has its poll cursor advanced (cannot freeze the LIMIT-100 window)', async () => {
  // The poll cursor (last_polled_at) orders listOpenWorkOrders and is capped at
  // LIMIT 100 in SQL. If a backed-off WO's cursor never advances, it stays at the
  // front of the window and crowds out eligible WOs beyond row 100 on orgs with
  // >100 concurrently-open WOs. So a WO SKIPPED for backoff must STILL be stamped.
  mockIms();
  const { woId } = seedOpenWorkOrder('cursor');
  nock(AEP_GATEWAY).persist()
    .get(`${WO_PATH}/DI-${woId}`)
    .reply(() => [400, { message: 'nope' }]);

  await tick();   // poll fails → WO enters backoff
  // Simulate a frozen-old cursor.
  db.prepare("UPDATE work_orders SET last_polled_at = '2000-01-01 00:00:00' WHERE id = ?").run(woId);

  await tick();   // WO is backed off → NOT polled, but its cursor MUST still advance

  const row = db.prepare('SELECT last_polled_at FROM work_orders WHERE id = ?').get(woId);
  assert.notEqual(row.last_polled_at, '2000-01-01 00:00:00',
    'a backed-off (skipped) WO must still be stamped so it rotates out of the poll window');
});

test('a WO whose poll SUCCEEDS keeps full cadence (no backoff)', async () => {
  mockIms();
  const { woId } = seedOpenWorkOrder('ok');

  let hits = 0;
  nock(AEP_GATEWAY).persist()
    .get(`${WO_PATH}/DI-${woId}`)
    .reply(() => { hits++; return [200, { status: 'received' }]; }); // non-terminal → stays open

  await tick();          // success → no backoff
  await tick();          // still eligible → polled again

  assert.equal(hits, 2, 'a successfully-polled WO must be polled again on the next tick');
});
