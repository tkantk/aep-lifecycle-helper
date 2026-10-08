/** "Not found in AEP" (2026-10-08): an uploaded ID Adobe answered with NO
 *  identities has exactly one own row (expansion's source row) — Adobe lists an
 *  ID it knows in its own cluster, which adds a second. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

const dbPath = path.join(os.tmpdir(), `aep-test-notfound-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, db, bulkInsertIdentities, insertIdentitiesAndCount } = await import('../src/db.js');
const { classifySource, buildAnalysis, ANALYSIS_CATEGORIES } = await import('../src/runner/analysis.js');
const { __internal__: chunks } = await import('../src/routes/analysisRoutes.js');

before(() => initDb());
after(() => { for (const e of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + e); } catch { /* */ } } });

const KOC = { code: 'hashedKocid', id: 5000 };
const r = (ns, id, v) => ({ ns_code: ns, ns_id: id, identity_id: v });
const classify = (sourceId, rows) => classifySource({ sourceId, sourceNs: KOC, rows, isInList: () => false });

test('the categories, in display order', () => {
  assert.deepEqual(ANALYSIS_CATEGORIES, ['not_found', 'source_only', 'linked', 'merged_in_list', 'merged_outside_list']);
});

test('one own row and nothing else = not found; Adobe listing it too = only itself', () => {
  const nf = classify('N', [r('hashedKocid', 5000, 'N')]);
  assert.deepEqual([nf.category, nf.identitiesTotal, nf.linkedTotal], ['not_found', 1, 0]);
  assert.equal(classify('S', [r('hashedKocid', 5000, 'S'), r('hashedKocid', 5000, 'S')]).category, 'source_only');
  assert.equal(classify('L', [r('hashedKocid', 5000, 'L'), r('email', 6, 'l@x')]).category, 'linked',
    'linked identities always mean the ID is known');
});

test('documented limit: an unknown ID uploaded twice has two own rows and reads "Only itself"', () => {
  assert.equal(classify('D', [r('hashedKocid', 5000, 'D'), r('hashedKocid', 5000, 'D')]).category, 'source_only');
});

function seed() {
  const credsId = uuid();
  q().insertCred.run({ id: credsId, label: 'NF', clientName: null, environment: 'Production', region: 'va7',
    imsOrgId: `nf-${credsId}@AdobeOrg`, clientId: `nf-${credsId}`, enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16) });
  const jobId = uuid();
  q().insertJob.run({ id: jobId, name: 'NF', credsId, sandboxName: 'prod', datasetIds: 'ALL', targetServicesJson: null,
    sourceNamespace: 'hashedKocid', sourceNamespaceId: 5000, dailyLimit: 1_000_000, monthlyLimit: 3_000_000, uploadPath: null, totalSourceIds: 4 });
  const S = (s, members) => [[jobId, 'hashedKocid', 5000, s, s], ...members.map(([ns, id, v]) => [jobId, ns, id, v, s])];
  bulkInsertIdentities([
    ...S('N', []),                                                   // Adobe: no identities
    ...S('O', [['hashedKocid', 5000, 'O']]),                          // Adobe: only itself
    ...S('M', [['hashedKocid', 5000, 'M'], ['hashedKocid', 5000, 'Q'], ['email', 6, 'm@x']]),  // merged with Q
  ]);
  insertIdentitiesAndCount([], 0, 0, jobId, ['Q']);                  // Q: uploaded, no reply from AEP
  q().updateJobStatus.run('expanded', null, jobId);
  q().setFoundCount.run(5, jobId);
  return jobId;
}

test('buildAnalysis: not_found counted, noReply carried, a no-reply uploaded ID counts as "in your file"', async () => {
  const jobId = seed();
  const summary = await buildAnalysis(jobId);
  assert.deepEqual(summary.byCategory, { not_found: 1, source_only: 1, linked: 0, merged_in_list: 1, merged_outside_list: 0 });
  assert.equal(summary.noReply, 1);
  assert.equal(summary.sources, 3, 'no-reply IDs are not analysed (they have no identities)');
  const m = db.prepare('SELECT * FROM source_analysis WHERE job_id = ? AND source_id = ?').get(jobId, 'M');
  assert.deepEqual([m.other_in_list, m.other_not_in_list], [1, 0], 'Q is in the upload even though AEP never answered for it');
});

test('the "flagged" download leaves out not_found as well as source_only', async () => {
  const jobId = seed();
  await buildAnalysis(jobId);
  const got = [];
  for await (const chunk of chunks.analysisChunks(jobId, 'flagged', null)) got.push(...chunk.map(x => x.source_id));
  assert.deepEqual(got, ['M']);
});
