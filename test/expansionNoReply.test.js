/**
 * The colleague's stall (2026-10-08): Adobe's reply left out uploaded IDs, the
 * batch failed, and every Resume re-sent the same IDs first and failed again.
 * Now: ask once more for just the missing IDs; record any still missing as "no
 * reply from AEP" (never planned) and finish the job.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import nock from 'nock';

const dbPath = path.join(os.tmpdir(), `aep-test-noreply-run-${Date.now()}.db`);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-test-noreply-run-'));
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = uploadDir;
process.env.OUTPUT_DIR = os.tmpdir();
process.env.REQUEST_TIMEOUT_MS = '4000';

const { initDb, q, db, insertIdentitiesAndCount } = await import('../src/db.js');
const { storeCreds } = await import('../src/utils/crypto.js');
const { runExpansion } = await import('../src/runner/expansion.js');

const IMS = 'https://ims-na1.adobelogin.com';
const REGION = 'https://platform-va7.adobe.io';
const NSID = 11124296;

before(() => initDb());
afterEach(() => nock.cleanAll());
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { /* */ }
});

let seq = 0;
function setup(ids) {
  seq++;
  const credsId = storeCreds({ label: `NR${seq}`, environment: 'prod', region: 'VA7',
    imsOrgId: `noreply-${seq}@AcmeOrg`, clientId: `noreply-${seq}`, clientSecret: 'secret' });
  const csv = path.join(uploadDir, `nr-${seq}.csv`);
  fs.writeFileSync(csv, ids.join('\n') + '\n');
  const jobId = `noreply-job-${seq}`;
  q().insertJob.run({ id: jobId, name: `NR ${seq}`, credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: NSID, dailyLimit: 1_000_000, monthlyLimit: null, uploadPath: csv,
    totalSourceIds: ids.length });
  mockBasics();
  return { jobId, csv, credsId };
}
function mockBasics() {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
  nock(REGION).persist().get('/data/core/idnamespace/identities').reply(200, [
    { id: NSID, code: 'hashedKocid', name: 'Hashed KOCID', custom: true, status: 'ACTIVE' },
    { id: 6, code: 'Email', name: 'Email', custom: false, status: 'ACTIVE' },
  ]);
}
// Adobe stand-in: `answer(ids, call)` picks which IDs get an entry; every request is recorded.
function graph(answer) {
  const calls = [];
  nock(REGION).persist().post('/data/core/identity/clusters/members').reply(200, (uri, body) => {
    const ids = body.compositeXids.map(x => x.id);
    calls.push(ids);
    return { version: '1.1.0', clusters: answer(ids, calls.length).map(id => ({
      compositeXid: { nsid: NSID, id },
      members: [{ nsid: NSID, id }, { nsid: 6, id: `${id}@x.com` }],
    })) };
  });
  return calls;
}
const run = (s, extra = {}) => runExpansion({ jobId: s.jobId, uploadPath: s.csv, sourceNamespace: 'hashedKocid',
  sourceNamespaceId: NSID, credsId: s.credsId, sandboxName: 'prod', column: 0, ...extra });
const storedSources = (jobId) => db.prepare('SELECT DISTINCT source_id FROM expanded_identities WHERE job_id = ? ORDER BY source_id').all(jobId).map(r => r.source_id);
const noReplyIds = (jobId) => db.prepare('SELECT source_id FROM no_reply_sources WHERE job_id = ? ORDER BY source_id').all(jobId).map(r => r.source_id);
async function analysisSettled(jobId) {
  for (let i = 0; i < 200; i++) {
    const a = q().getJobAnalysis.get(jobId);
    if (a && a.status !== 'building') return a;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('analysis never settled');
}

test('IDs left out of a reply are asked about again; answered on the re-ask → stored, no "no reply"', async () => {
  const s = setup(['src-a', 'src-b', 'src-c']);
  const calls = graph((ids, call) => (call === 1 ? ids.filter(id => id !== 'src-b') : ids));
  await run(s);
  assert.deepEqual(calls, [['src-a', 'src-b', 'src-c'], ['src-b']], 'the re-ask carries only the missing ID');
  const job = q().getJob.get(s.jobId);
  assert.deepEqual([job.status, job.processed_count, job.no_reply_count], ['expanded', 3, 0]);
  assert.deepEqual(storedSources(s.jobId), ['src-a', 'src-b', 'src-c']);
  await analysisSettled(s.jobId);
});

test('IDs still missing after the re-ask are recorded as "no reply": job expanded, never planned', async () => {
  const s = setup(['src-a', 'gone-1', 'src-c', 'gone-1']);    // gone-1 twice in one batch
  const calls = graph((ids) => ids.filter(id => !id.startsWith('gone-')));
  await run(s);
  assert.deepEqual(calls[1], ['gone-1', 'gone-1']);
  const job = q().getJob.get(s.jobId);
  assert.deepEqual([job.status, job.processed_count, job.no_reply_count], ['expanded', 4, 1]);
  assert.deepEqual(noReplyIds(s.jobId), ['gone-1']);
  assert.deepEqual(storedSources(s.jobId), ['src-a', 'src-c'], 'no identity rows → the planner never sees it');
  const a = await analysisSettled(s.jobId);
  assert.equal(JSON.parse(a.summary_json).noReply, 1, 'the automatic analysis carries the count');
});

test('Resume skips "no reply" IDs — Adobe is not asked about them again', async () => {
  const s = setup(['src-a', 'gone-1', 'src-c']);
  insertIdentitiesAndCount([[s.jobId, 'hashedKocid', NSID, 'src-a', 'src-a'], [s.jobId, 'hashedKocid', NSID, 'src-a', 'src-a']], 2, 1, s.jobId, ['gone-1']);
  q().updateJobStatus.run('failed', 'stopped', s.jobId);
  const calls = graph((ids) => ids);
  await run(s, { skipSourceIds: { has: (v) => !!q().hasProcessedSource.get(s.jobId, v) } });
  assert.deepEqual(calls, [['src-c']]);
  assert.equal(q().getJob.get(s.jobId).status, 'expanded');
  await analysisSettled(s.jobId);
});

test('when AEP answers nothing at all, the job still fails with the empty-graph message', async () => {
  const s = setup(['src-a', 'src-b']);
  graph(() => []);
  await assert.rejects(() => run(s), /0 linked identities across all 2 source\(s\) \(2 of them got no reply at all; Resume will ask Adobe about them again\)/);
  assert.equal(q().getJob.get(s.jobId).status, 'failed');
});

test('a re-ask that fails fails the job and records nothing for that batch', async () => {
  const s = setup(['src-a', 'gone-1']);
  let n = 0;
  nock(REGION).persist().post('/data/core/identity/clusters/members').reply(() => {
    n++;
    return n === 1
      ? [200, { version: '1.1.0', clusters: [{ compositeXid: { nsid: NSID, id: 'src-a' }, members: [{ nsid: NSID, id: 'src-a' }] }] }]
      : [400, { title: 'bad request' }];
  });
  await assert.rejects(() => run(s));
  const job = q().getJob.get(s.jobId);
  assert.deepEqual([job.status, job.processed_count, job.no_reply_count], ['failed', 0, 0]);
  assert.deepEqual([storedSources(s.jobId), noReplyIds(s.jobId)], [[], []]);
});

test('unreadable entries while IDs are missing stop the job (reply-format error)', async () => {
  const s = setup(['src-a', 'src-b']);
  nock(REGION).persist().post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0', clusters: [
    { compositeXid: { nsid: NSID, id: 'src-a' }, members: [{ nsid: NSID, id: 'src-a' }] },
    { xid: `${NSID}|src-b`, members: [] },
  ] });
  await assert.rejects(() => run(s), /could not be read/);
  assert.equal(q().getJob.get(s.jobId).status, 'failed');
  assert.deepEqual(noReplyIds(s.jobId), []);
});

test('a wrong-region job recovers: fix the region, Resume asks Adobe about every ID again', async () => {
  // Final review #1: a wrong region answers 200 {clusters: []}. Every ID used to be
  // recorded as "no reply" and then skipped by every Resume — unrecoverable.
  const s = setup(['src-a', 'src-b', 'src-c']);
  graph(() => []);
  await assert.rejects(() => run(s), /0 linked identities/);
  let job = q().getJob.get(s.jobId);
  assert.deepEqual([job.status, job.processed_count, job.no_reply_count, noReplyIds(s.jobId)], ['failed', 0, 0, []],
    'nothing came back for the whole job, so the "no reply" records are cleared for Resume');
  nock.cleanAll();
  mockBasics();
  const calls = graph((ids) => ids);                     // the region is fixed
  await run(s, { skipSourceIds: { has: (v) => !!q().hasProcessedSource.get(s.jobId, v) } });
  assert.deepEqual(calls.flat().sort(), ['src-a', 'src-b', 'src-c']);
  job = q().getJob.get(s.jobId);
  assert.deepEqual([job.status, job.processed_count, job.no_reply_count], ['expanded', 3, 0]);
  await analysisSettled(s.jobId);
});
