/**
 * Review #6: the submit-intent must be made durable WITHOUT a wal_checkpoint
 * (which blocks on concurrent readers and could freeze the single-threaded
 * server for the length of a long CSV export). setWorkOrderSubmittingDurable
 * flips synchronous=FULL around a single commit (an fsync-on-commit, which does
 * NOT block on readers), then restores NORMAL.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const dbPath = path.join(os.tmpdir(), `aep-test-durable-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, setWorkOrderSubmittingDurable } = await import('../src/db.js');

before(() => { initDb(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

function seedWorkOrder(id) {
  q().insertCred.run({
    id: `cred-${id}`, label: 'D', clientName: null, environment: 'prod', region: 'VA7',
    imsOrgId: `org-${id}@AcmeOrg`, clientId: `client-${id}`,
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });
  q().insertJob.run({
    id: `job-${id}`, name: 'D', credsId: `cred-${id}`, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: null, totalSourceIds: 0,
  });
  q().insertWorkOrder.run({
    id, jobId: `job-${id}`, dayIndex: 1, datasetIds: 'ALL', targetServicesJson: null,
    namespacesIdentities: JSON.stringify([{ namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] }]),
    identifierCount: 1, status: 'planned',
  });
}

test('setWorkOrderSubmittingDurable commits the intent and restores synchronous=NORMAL', () => {
  seedWorkOrder('wo-ok');
  assert.equal(setWorkOrderSubmittingDurable('wo-ok'), true);
  assert.equal(q().getAllOrdersForJob.all('job-wo-ok')[0].status, 'submitting');
  // synchronous restored to NORMAL (1) — not left at FULL (2).
  assert.equal(Number(db.pragma('synchronous', { simple: true })), 1);
});

test('setWorkOrderSubmittingDurable does NOT block on a concurrent reader (no checkpoint)', () => {
  seedWorkOrder('wo-reader');
  // A second connection holds an open read snapshot — this would make a FULL
  // checkpoint report busy and block for busy_timeout (~5s). An fsync-on-commit
  // must NOT block on it.
  const reader = new Database(dbPath);
  reader.pragma('journal_mode = WAL');
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) AS n FROM work_orders').get();

  const t0 = Date.now();
  const ok = setWorkOrderSubmittingDurable('wo-reader');
  const elapsed = Date.now() - t0;

  reader.exec('COMMIT');
  reader.close();

  assert.equal(ok, true);
  assert.ok(elapsed < 1000, `durable write must not block on a reader (took ${elapsed}ms)`);
  assert.equal(q().getAllOrdersForJob.all('job-wo-reader')[0].status, 'submitting');
});
