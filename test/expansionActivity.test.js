/**
 * Expansion activity (2026-10-09). The user saw "namespace registry loaded" and
 * then nothing: a batch waiting on Adobe logged nothing until it returned (and a
 * timeout failed the job), and a Resume logged its skipping only at the very end.
 * Now the log and the Expansion tab say what the expansion is doing.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import nock from 'nock';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-activity-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-activity-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.EXPANSION_HEARTBEAT_MS = '100';
process.env.RESUME_LOG_EVERY = '2';
process.env.IDENTITY_TIMEOUT_MS = '5000';
process.env.LIVE_PROGRESS_RETAIN_MS = '300';    // a finished run's live progress lingers this long

const { initDb, q, insertIdentitiesAndCount } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion, liveProgress } = await import('../src/runner/expansion.js');
const { logger } = await import('../src/utils/logger.js');
const jobsRouter = (await import('../src/routes/jobs.js')).default;
const { makeErrorHandler } = await import('../src/middleware/security.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';
const NSID = 11124296;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const seen = [];
for (const lvl of ['info', 'warn']) {
  const orig = logger[lvl];
  logger[lvl] = (d, m) => { seen.push({ msg: typeof d === 'string' ? d : m, data: typeof d === 'object' ? d : {} }); return orig(d, m); };
}

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
afterEach(() => nock.cleanAll());
after(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

let seq = 0;
function setup(ids) {
  seq++;
  const credsId = storeCreds({ label: `ACT${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `activity-${seq}@AcmeOrg`, clientId: `activity-${seq}`, clientSecret: 'secret' });
  const csv = path.join(uploadDir, `act-${seq}.csv`);
  fs.writeFileSync(csv, ids.join('\n') + '\n');
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: `ACT ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: NSID, dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv,
    totalSourceIds: ids.length });
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).persist().get('/data/core/idnamespace/identities').reply(200, [
    { id: NSID, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
    { id: 6, code: 'Email', name: 'Email', custom: false, status: 'ACTIVE' },
  ]);
  return { jobId, csv, credsId };
}
const answerAll = (body) => ({ version: '1.1.0', clusters: body.compositeXids.map(({ id }) => ({
  compositeXid: { nsid: NSID, id }, members: [{ nsid: NSID, id }, { nsid: 6, id: `${id}@x.com` }] })) });
const run = (s, extra = {}) => runExpansion({ jobId: s.jobId, uploadPath: s.csv, sourceNamespace: 'hashedKocid',
  sourceNamespaceId: NSID, credsId: s.credsId, sandboxName: 'prod', column: 0, ...extra });
const logsFor = (jobId, msg) => seen.filter(e => e.msg === msg && e.data.jobId === jobId);

test('while a batch waits on Adobe, the log and the live progress say so — and clear once it returns', async () => {
  const s = setup(['src-a', 'src-b']);
  nock(REGION).post('/data/core/identity/clusters/members').delay(700).reply(200, (uri, body) => answerAll(body));
  const running = run(s);
  let waiting = null;
  for (let i = 0; i < 60 && !waiting; i++) { waiting = liveProgress.get(s.jobId)?.waiting; await sleep(20); }
  assert.ok(waiting && waiting.inFlight === 1 && waiting.oldestMs >= 50, `live progress: ${JSON.stringify(waiting)}`);   // the batch starts ms after the run
  await running;
  const beats = logsFor(s.jobId, 'still waiting on Adobe');
  assert.ok(beats.length >= 1 && beats[0].data.inFlight === 1, `heartbeat logs: ${JSON.stringify(beats.map(b => b.data))}`);
  assert.equal(liveProgress.get(s.jobId).waiting, null, 'no "waiting" once the batch returned');
  assert.equal(q().getJob.get(s.jobId).status, 'expanded');
});

test('a batch whose first reply times out is retried and the job finishes (it used to fail)', async () => {
  const s = setup(['src-a', 'src-b']);
  let calls = 0;
  nock(REGION)
    .post('/data/core/identity/clusters/members').delay(6000).reply(200, (uri, body) => { calls++; return answerAll(body); })
    .post('/data/core/identity/clusters/members').reply(200, (uri, body) => { calls++; return answerAll(body); });
  await run(s);
  assert.equal(q().getJob.get(s.jobId).status, 'expanded');
  assert.ok(seen.some(e => e.msg === 'Adobe did not answer in time — retrying'), 'the retry is logged with its reason');
});

test('a Resume says what it is doing while it skips IDs already expanded', async () => {
  const s = setup(['a1', 'a2', 'a3', 'a4', 'a5', 'new-1']);
  const rows = [];
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) rows.push([s.jobId, 'hashedKocid', NSID, id, id], [s.jobId, 'hashedKocid', NSID, id, id]);
  insertIdentitiesAndCount(rows, 5, 5, s.jobId);
  q().updateJobStatus.run('failed', 'timeout of 60000ms exceeded', s.jobId);
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, (uri, body) => answerAll(body));
  await run(s, { skipSourceIds: { has: (v) => !!q().hasProcessedSource.get(s.jobId, v) } });
  assert.deepEqual(logsFor(s.jobId, 'resuming: skipping IDs already expanded').map(e => e.data.skipped), [2, 4]);
  const reached = logsFor(s.jobId, 'resuming: reached IDs not yet expanded — sending batches again');
  assert.deepEqual(reached.map(e => [e.data.checked, e.data.skipped]), [[6, 5]]);
  const p = liveProgress.get(s.jobId);
  assert.deepEqual([p.phase, p.checked, p.skipped], ['expanding', 6, 5]);
  assert.equal(q().getJob.get(s.jobId).status, 'expanded');
});

test('GET /api/jobs/:id/progress passes the activity to the Expansion tab', async () => {
  const s = setup(['x']);
  q().updateJobStatus.run('expanding', null, s.jobId);
  liveProgress.set(s.jobId, { processed: 3, total: 1, found: 7, phase: 'resuming', checked: 300, skipped: 290,
    waiting: { inFlight: 2, oldestMs: 45_000 } });
  const body = await (await fetch(`${baseUrl}/api/jobs/${s.jobId}/progress`)).json();
  assert.deepEqual({ phase: body.phase, checked: body.checked, skipped: body.skipped, waiting: body.waiting },
    { phase: 'resuming', checked: 300, skipped: 290, waiting: { inFlight: 2, oldestMs: 45_000 } });
  liveProgress.delete(s.jobId);
  const idle = await (await fetch(`${baseUrl}/api/jobs/${s.jobId}/progress`)).json();
  assert.deepEqual({ phase: idle.phase, waiting: idle.waiting }, { phase: null, waiting: null });
});

test('a failed run\'s cleanup never deletes the progress of the Resume that followed it (final review #2)', async () => {
  const s = setup(['src-a', 'src-b']);
  nock(REGION).post('/data/core/identity/clusters/members')
    .reply(200, { version: '1.1.0', clusters: [], unprocessedXids: ['src-a'] });           // run 1 fails at once
  await assert.rejects(() => run(s), /could not process/);
  nock(REGION).post('/data/core/identity/clusters/members').delay(800).reply(200, (uri, body) => answerAll(body));
  const resumed = run(s, { skipSourceIds: { has: (v) => !!q().hasProcessedSource.get(s.jobId, v) } });
  await sleep(500);                                  // run 1's cleanup timer (300 ms) has fired by now
  const p = liveProgress.get(s.jobId);
  assert.ok(p && p.phase === 'expanding' && p.waiting, `the resumed run's live progress is still there: ${JSON.stringify(p)}`);
  await resumed;
  assert.equal(q().getJob.get(s.jobId).status, 'expanded');
});

test('when the app ITSELF was paused, the log says so instead of blaming Adobe (final review #5)', async () => {
  // e.g. text selected in the Windows console (QuickEdit), the laptop asleep, or a
  // heavy page refresh blocking the server — any pause longer than the lookup
  // timeout used to read as "Adobe did not answer in time".
  const s = setup(['src-a']);
  nock(REGION).post('/data/core/identity/clusters/members').delay(1200).reply(200, (uri, body) => answerAll(body));
  const running = run(s);
  await sleep(250);
  const until = Date.now() + 700;
  while (Date.now() < until) { /* the process is frozen */ }
  await running;
  const paused = logsFor(s.jobId, 'the app itself was paused — not waiting on Adobe');
  assert.ok(paused.length >= 1 && paused[0].data.pausedSec >= 0.5, `pause logs: ${JSON.stringify(paused.map(p => p.data))}`);
});
