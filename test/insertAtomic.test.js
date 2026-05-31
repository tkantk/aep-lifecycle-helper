/**
 * Review #1: identity rows and the job counters (processed_count,
 * graph_members_seen) must be written in ONE transaction. Otherwise a crash
 * between the row insert and the counter increment leaves committed rows with
 * stale counters; on resume those sources are skipped, the counter stays 0, and
 * the empty-graph fail-closed guard is bypassed. insertIdentitiesAndCount binds
 * them atomically — a failure rolls back BOTH.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = path.join(os.tmpdir(), `aep-test-insatomic-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, insertIdentitiesAndCount } = await import('../src/db.js');

before(() => { initDb(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
});

function seedJob(id) {
  q().insertCred.run({
    id: `cred-${id}`, label: 'A', clientName: null, environment: 'prod', region: 'VA7',
    imsOrgId: `org-${id}@AcmeOrg`, clientId: `client-${id}`,
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });
  q().insertJob.run({
    id, name: 'Atomic', credsId: `cred-${id}`, sandboxName: 'prod',
    datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: null,
    dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: null, totalSourceIds: 0,
  });
}

function rowCount(jobId) {
  return q().countDistinctIdentities.get(jobId)?.n ?? 0;
}

test('insertIdentitiesAndCount commits rows + counters together', () => {
  const jobId = 'atomic-ok';
  seedJob(jobId);
  const inserted = insertIdentitiesAndCount([
    [jobId, 'email', 6, 'a@x.com', 'src1'],
    [jobId, 'phone', 7, '+15551234', 'src1'],
  ], /*sourcesProcessed*/ 1, /*membersSeen*/ 2, jobId);
  assert.equal(inserted, 2);
  const job = q().getJob.get(jobId);
  assert.equal(job.processed_count, 1);
  assert.equal(job.graph_members_seen, 2);
  assert.equal(rowCount(jobId), 2);
});

test('a failure rolls back BOTH the rows and the counters (no orphaned rows)', () => {
  const jobId = 'atomic-fail';
  seedJob(jobId);
  // Second row binds a plain object (not a valid SQLite value) → the insert
  // throws mid-batch. The first row's insert and the counter increment must NOT
  // persist.
  assert.throws(() => insertIdentitiesAndCount([
    [jobId, 'email', 6, 'good', 'src1'],
    [jobId, { not: 'bindable' }, 6, 'bad', 'src1'],
  ], 1, 2, jobId));

  const job = q().getJob.get(jobId);
  assert.equal(job.processed_count, 0, 'counter must not advance when the batch failed');
  assert.equal(job.graph_members_seen, 0, 'members counter must not advance either');
  assert.equal(rowCount(jobId), 0, 'no rows may be left committed without their counters');
});
