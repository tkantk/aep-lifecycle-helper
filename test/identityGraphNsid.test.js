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
    .reply(200, { version: '1.1.0', clusters: [] });

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

test('expandBatch keeps a valid finite nsid', async () => {
  let body = null;
  nock(REGION).post('/data/core/identity/clusters/members', b => { body = b; return true; })
    .reply(200, { version: '1.1.0', clusters: [] });

  await expandBatch({
    creds, sandboxName: 'prod', namespace: 'hashedKocid',
    namespaceId: 11124296, ids: ['src-a'], namespaceIndex: undefined,
  });

  assert.equal(body.compositeXids[0].nsid, 11124296);
});
