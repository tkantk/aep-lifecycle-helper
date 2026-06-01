/**
 * Review finding #8: a non-finite source nsid (e.g. Number("abc") === NaN)
 * must never be templated into the /clusters/members request body as
 * "nsid": null. expandBatch omits a non-finite nsid entirely.
 */

import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';

const REGION = 'https://platform-va7.adobe.io';
const IMS = 'https://ims-na1.adobelogin.com';

const { expandBatch } = await import('../src/services/identityGraph.js');

before(() => {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
});
afterEach(() => { /* keep IMS persistent */ });

const creds = { clientId: 'c', imsOrgId: 'o@AcmeOrg', clientSecret: 's', region: 'va7' };

test('expandBatch omits a non-finite nsid (never sends nsid:null)', async () => {
  let body = null;
  nock(REGION).post('/data/core/identity/clusters/members', b => { body = b; return true; })
    .reply(200, { version: '1.1.0', clusters: [{ compositeXid: { id: 'src-a' }, members: [] }] });

  await expandBatch({
    creds, sandboxName: 'prod', namespace: 'hashedKocid',
    namespaceId: 'abc',                // Number('abc') === NaN
    ids: ['src-a'], namespaceIndex: undefined,
  });

  assert.ok(body && Array.isArray(body.compositeXids));
  const x = body.compositeXids[0];
  assert.equal(x.id, 'src-a');
  assert.equal(x.ns, 'hashedKocid');
  assert.ok(!('nsid' in x), 'a non-finite nsid must be omitted, not sent as null');
});

test('expandBatch omits nsid when none is supplied (null is not nsid:0)', async () => {
  // Regression guard: Number(null) === 0 is finite, so the wire guard must
  // check null/undefined BEFORE isFinite, or it would send nsid:0.
  for (const noNsid of [null, undefined]) {
    let body = null;
    nock(REGION).post('/data/core/identity/clusters/members', b => { body = b; return true; })
      .reply(200, { version: '1.1.0', clusters: [{ compositeXid: { id: 'src-a' }, members: [] }] });
    await expandBatch({
      creds, sandboxName: 'prod', namespace: 'hashedKocid',
      namespaceId: noNsid, ids: ['src-a'], namespaceIndex: undefined,
    });
    assert.ok(!('nsid' in body.compositeXids[0]), `nsid must be omitted for ${String(noNsid)}, not 0`);
  }
});

test('expandBatch fails closed when Adobe reports unprocessedXids (review #2)', async () => {
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, {
    version: '1.1.0',
    clusters: [{ compositeXid: { id: 'src-a' }, members: [{ nsid: 6, id: 'a@x.com' }] }],
    unprocessedXids: ['src-b'],
  });
  await assert.rejects(
    () => expandBatch({ creds, sandboxName: 'prod', namespace: 'hashedKocid', namespaceId: 6, ids: ['src-a', 'src-b'], namespaceIndex: undefined }),
    /could not process/i);
});

test('expandBatch fails closed when a requested source is missing from the response (no positional fallback)', async () => {
  // src-b requested but absent from clusters (and not matched by id). The old
  // positional fallback would have emitted src-b as source-only.
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, {
    version: '1.1.0',
    clusters: [{ compositeXid: { id: 'src-a' }, members: [{ nsid: 6, id: 'a@x.com' }] }],
  });
  await assert.rejects(
    () => expandBatch({ creds, sandboxName: 'prod', namespace: 'hashedKocid', namespaceId: 6, ids: ['src-a', 'src-b'], namespaceIndex: undefined }),
    /did not include/i);
});

test('expandBatch fails closed on an unrecognized response shape', async () => {
  nock(REGION).post('/data/core/identity/clusters/members').reply(200, { results: [], total: 0 });
  await assert.rejects(
    () => expandBatch({ creds, sandboxName: 'prod', namespace: 'hashedKocid', namespaceId: 6, ids: ['src-a'], namespaceIndex: undefined }),
    /unrecognized response shape/i);
});

test('expandBatch keeps a valid finite nsid', async () => {
  let body = null;
  nock(REGION).post('/data/core/identity/clusters/members', b => { body = b; return true; })
    .reply(200, { version: '1.1.0', clusters: [{ compositeXid: { id: 'src-a' }, members: [] }] });

  await expandBatch({
    creds, sandboxName: 'prod', namespace: 'hashedKocid',
    namespaceId: 11124296, ids: ['src-a'], namespaceIndex: undefined,
  });

  assert.equal(body.compositeXids[0].nsid, 11124296);
});
