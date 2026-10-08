/** "No reply from AEP" storage (2026-10-08): recorded with the batch, counted
 *  once, treated as an uploaded ID by the shared lookup, removed with the job. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-noreply-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, insertIdentitiesAndCount } = await import('../src/db.js');
const { HAS_PROCESSED_SOURCE_SQL } = await import('../src/runner/analysisSql.js');

before(() => initDb());
after(() => { for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } } });

function makeJob() {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'N', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `nr-${credsId}@AdobeOrg`, clientId: `nr-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'NR', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 4 });
  return jobId;
}
const noReplyIds = (jobId) => db.prepare('SELECT source_id FROM no_reply_sources WHERE job_id = ? ORDER BY source_id').all(jobId).map(r => r.source_id);

test('a new job starts with no_reply_count 0', () => {
  assert.equal(q().getJob.get(makeJob()).no_reply_count, 0);
});

test('no-reply IDs are recorded with the batch and counted once', () => {
  const jobId = makeJob();
  insertIdentitiesAndCount([[jobId, 'hashedKocid', 5000, 'A', 'A']], 4, 1, jobId, ['N1', 'N1', 'N2']);
  assert.deepEqual(noReplyIds(jobId), ['N1', 'N2']);
  insertIdentitiesAndCount([], 2, 0, jobId, ['N2', 'N3']);
  const job = q().getJob.get(jobId);
  assert.deepEqual([job.no_reply_count, job.processed_count, job.found_count], [3, 6, 1]);
  assert.deepEqual(noReplyIds(jobId), ['N1', 'N2', 'N3']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM expanded_identities WHERE job_id = ? AND source_id LIKE 'N%'").get(jobId).n, 0,
    'no-reply IDs never get identity rows (so they are never planned)');
});

test('the shared lookup treats a no-reply ID as an uploaded ID, with two indexed lookups', () => {
  const jobId = makeJob();
  insertIdentitiesAndCount([[jobId, 'hashedKocid', 5000, 'A', 'A']], 2, 1, jobId, ['N1']);
  assert.ok(q().hasProcessedSource.get(jobId, 'A'));
  assert.ok(q().hasProcessedSource.get(jobId, 'N1'));
  assert.ok(!q().hasProcessedSource.get(jobId, 'Z'));
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${HAS_PROCESSED_SOURCE_SQL}`).all(jobId, 'A').map(r => r.detail).join(' | ');
  assert.match(plan, /SEARCH e USING (COVERING )?INDEX idx_ei_job_source/);
  assert.match(plan, /SEARCH n USING PRIMARY KEY/);
  assert.doesNotMatch(plan, /SCAN (e|n)\b/);
});

test('noReplyChunk pages in ID order', () => {
  const jobId = makeJob();
  insertIdentitiesAndCount([], 3, 0, jobId, ['c', 'a', 'b']);
  assert.deepEqual(q().noReplyChunk.all(jobId, '', 2).map(r => r.source_id), ['a', 'b']);
  assert.deepEqual(q().noReplyChunk.all(jobId, 'b', 2).map(r => r.source_id), ['c']);
});

test('deleting the job removes its no-reply rows', () => {
  const jobId = makeJob();
  insertIdentitiesAndCount([], 1, 0, jobId, ['N1']);
  q().deleteJob.run(jobId);
  assert.deepEqual(noReplyIds(jobId), []);
});
