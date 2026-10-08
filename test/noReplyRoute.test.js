/** GET /api/jobs/:id/no-reply (2026-10-08): the uploaded IDs AEP never answered
 *  for, as a formula-safe CSV streamed in ID order. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-noreply-route-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, insertIdentitiesAndCount } = await import('../src/db.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');
const { logger } = await import('../src/utils/logger.js');

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
  if (server) await new Promise(r => server.close(r));
  for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } }
});

function makeJob(noReply) {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'R', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `nrr-${credsId}@AdobeOrg`, clientId: `nrr-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'NRR', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 9 });
  if (noReply.length) insertIdentitiesAndCount([], noReply.length, 0, jobId, noReply);
  return jobId;
}

test('streams the no-reply IDs as CSV, in ID order, formula-safe', async () => {
  const jobId = makeJob(['b-2', '=HYPERLINK("x")', 'a-1']);
  const res = await fetch(`${baseUrl}/api/jobs/${jobId}/no-reply`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), new RegExp(`job_${jobId}_no_reply_from_aep\\.csv`));
  const lines = (await res.text()).trim().split(/\r?\n/);
  assert.equal(lines[0], 'hashedKocid');
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(1).every(l => !/^[=+\-@]/.test(l.replace(/^"/, ''))), 'no line starts a formula');
  assert.ok(lines.indexOf('a-1') < lines.indexOf('b-2'));
});

test('a job with none gets the header only; an unknown job is a 404', async () => {
  const res = await fetch(`${baseUrl}/api/jobs/${makeJob([])}/no-reply`);
  assert.equal((await res.text()).trim(), 'hashedKocid');
  assert.equal((await fetch(`${baseUrl}/api/jobs/${uuid()}/no-reply`)).status, 404);
});
