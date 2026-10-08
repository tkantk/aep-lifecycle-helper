/**
 * A clean omission (2026-10-08): IDs Adobe's reply leaves out — when every entry
 * it does return matches an ID sent — come back in `missing` instead of failing
 * the batch. Entries we can't match while IDs are missing still fail closed.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';

const REGION = 'https://platform-va7.adobe.io';
const IMS = 'https://ims-na1.adobelogin.com';
const { expandBatch, expandBatchDetailed } = await import('../src/services/identityGraph.js');

before(() => {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
});
const creds = { clientId: 'c', imsOrgId: 'o@AcmeOrg', clientSecret: 's', region: 'va7' };
const args = (ids) => ({ creds, sandboxName: 'prod', namespace: 'hashedKocid', namespaceId: 6, ids, namespaceIndex: undefined });
const entry = (id, members = [{ nsid: 6, id }]) => ({ compositeXid: { nsid: 6, id }, members });
const reply = (body) => nock(REGION).post('/data/core/identity/clusters/members').reply(200, { version: '1.1.0', ...body });

test('a clean omission comes back in `missing`; answered IDs come back as results', async () => {
  reply({ clusters: [entry('src-a', [{ nsid: 6, id: 'src-a' }, { nsid: 7, id: 'a@x.com' }])] });
  const { results, missing } = await expandBatchDetailed(args(['src-a', 'src-b']));
  assert.deepEqual(missing, ['src-b']);
  assert.deepEqual(results.map(r => r.sourceId), ['src-a']);
  assert.equal(results[0].linkedIdentities.length, 2);
});

test('an empty reply leaves every ID missing (the caller decides)', async () => {
  reply({ clusters: [] });
  assert.deepEqual(await expandBatchDetailed(args(['src-a', 'src-b'])), { results: [], missing: ['src-a', 'src-b'] });
});

test('an entry with an empty member list is an answer, not a missing ID', async () => {
  reply({ clusters: [entry('src-a', [])] });
  const { results, missing } = await expandBatchDetailed(args(['src-a']));
  assert.deepEqual(missing, []);
  assert.deepEqual(results[0].linkedIdentities, []);
});

test('entries we cannot match while IDs are missing fail closed, naming their keys', async () => {
  reply({ clusters: [entry('src-a'), { xid: '6|SRC-B', members: [] }] });
  await assert.rejects(() => expandBatchDetailed(args(['src-a', 'src-b'])), (err) => {
    assert.match(err.message, /could not be read/);
    assert.match(err.message, /entry keys: members, xid/);
    assert.match(err.message, /e\.g\. src-b/);
    return true;
  });
});

test('extra entries are ignored when every ID sent was answered (unchanged)', async () => {
  reply({ clusters: [entry('src-a'), { xid: 'something-else', members: [] }] });
  const { results, missing } = await expandBatchDetailed(args(['src-a']));
  assert.deepEqual([results.length, missing], [1, []]);
});

test('expandBatch keeps its contract: a missing ID still throws "did not include"', async () => {
  reply({ clusters: [entry('src-a')] });
  await assert.rejects(() => expandBatch(args(['src-a', 'src-b'])), /did not include 1 of 2/);
});

test('the reply-format error names only known field names — never a list of IDs', async () => {
  // Final review #2: entries keyed by the ID ({"<id>": {...}}) or bare strings put
  // ~1,000 IDs into the message, which is logged, stored and shown.
  const ids = Array.from({ length: 50 }, (_, i) => `id-${String(i).padStart(3, '0')}-${'x'.repeat(30)}`);
  reply({ clusters: [...ids.slice(1).map(id => ({ [id]: { members: [] } })), 'bare-string-entry', { xid: 'x', members: [] }] });
  await assert.rejects(() => expandBatchDetailed(args(ids)), (err) => {
    assert.match(err.message, /could not be read/);
    const named = ids.filter(id => err.message.includes(id));
    assert.deepEqual(named, ids.slice(0, 3), 'only the 3 examples of missing IDs');
    assert.doesNotMatch(err.message, /bare-string-entry/);
    assert.match(err.message, /entry keys: members, xid \(\+49 other keys\), string/);
    assert.ok(err.message.length < 800, `message is ${err.message.length} chars`);
    return true;
  });
});
