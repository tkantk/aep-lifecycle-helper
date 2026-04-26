/**
 * Regression: deferred work orders must be picked up by a subsequent
 * runSubmission call. Previously the SQL filter only included status='planned'
 * so quota-deferred rows were stranded forever.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-deferred-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q } = await import('../src/db.js');

before(() => initDb());
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

test('getPlannedOrders includes both planned and deferred rows', () => {
  // Seed minimum viable cred + job
  q().insertCred.run({
    id: 'cred-d',
    label: 'Test',
    clientName: null,
    environment: 'prod',
    region: 'va7',
    imsOrgId: 'org-d@AcmeOrg',
    clientId: 'client-d',
    enc: Buffer.from('x'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  });
  q().insertJob.run({
    id: 'job-d', name: 'Deferred Test', credsId: 'cred-d',
    sandboxName: 'sbx', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null,
    uploadPath: null, totalSourceIds: 0,
  });

  // Three work orders: planned, deferred, submitted
  for (const [id, status] of [
    ['wo-planned', 'planned'],
    ['wo-deferred', 'deferred'],
    ['wo-submitted', 'submitted'],
  ]) {
    q().insertWorkOrder.run({
      id, jobId: 'job-d', dayIndex: 1,
      datasetIds: 'ALL', targetServicesJson: null,
      namespacesIdentities: '[]', identifierCount: 100,
      status,
    });
  }

  const rows = q().getPlannedOrders.all('job-d');
  const ids = rows.map(r => r.id).sort();
  assert.deepEqual(ids, ['wo-deferred', 'wo-planned'],
    'getPlannedOrders must surface deferred rows alongside planned ones');
  // Submitted rows MUST NOT be returned — re-submitting them would create duplicates.
  assert.ok(!ids.includes('wo-submitted'));
});
