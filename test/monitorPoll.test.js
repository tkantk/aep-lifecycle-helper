/**
 * Review finding #9: the monitor's listOpenWorkOrders used LIMIT 100 with no
 * ordering, so on a job with >100 open work orders it re-polled the same first
 * 100 (by rowid) every tick — orders #101+ were never observed. The fix orders
 * by a poll cursor (last_polled_at, never-polled first) so every open WO is
 * eventually polled.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-monpoll-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q } = await import('../src/db.js');

before(() => { initDb(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

test('listOpenWorkOrders rotates so >100 open orders are all eventually polled', () => {
  const credId = 'monpoll-cred';
  q().insertCred.run({
    id: credId, label: 'MonPoll', clientName: null, environment: 'prod', region: 'VA7',
    imsOrgId: 'monpoll-org@AcmeOrg', clientId: 'monpoll-client',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });
  const jobId = 'monpoll-job';
  q().insertJob.run({
    id: jobId, name: 'MonPoll', credsId: credId, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: null, totalSourceIds: 0,
  });

  // 150 open work orders (adobe_workorder_id set, non-terminal status).
  const TOTAL = 150;
  for (let i = 0; i < TOTAL; i++) {
    const id = `monpoll-wo-${String(i).padStart(3, '0')}`;
    q().insertWorkOrder.run({
      id, jobId, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
      namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
      identifierCount: 1, status: 'submitting',
    });
    q().updateWorkOrderSubmitted.run({
      id, adobeWorkorderId: `DI-${id}`, adobeStatus: 'received', bundleId: null,
      submittedAt: '2026-05-31T00:00:00Z',
    });
  }

  // Tick 1 polls the first 100; stamp them as polled.
  const batch1 = q().listOpenWorkOrders.all().map(w => w.id);
  assert.equal(batch1.length, 100);
  for (const id of batch1) q().stampWorkOrderPolled.run(id);

  // Tick 2 must surface the 50 that were never polled (no starvation).
  const batch2 = new Set(q().listOpenWorkOrders.all().map(w => w.id));
  const neverPolled = [];
  for (let i = 0; i < TOTAL; i++) {
    const id = `monpoll-wo-${String(i).padStart(3, '0')}`;
    if (!batch1.includes(id)) neverPolled.push(id);
  }
  assert.equal(neverPolled.length, 50);
  for (const id of neverPolled) {
    assert.ok(batch2.has(id), `never-polled ${id} must appear in the next tick (no starvation)`);
  }
});
