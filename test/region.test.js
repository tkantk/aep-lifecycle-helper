/**
 * Regression test: Identity API calls must use the per-credential region,
 * not the process-wide config default. A wrong-region call to
 * /clusters/members returns 200 with empty clusters, which would silently
 * cause partial deletes (only the source kocid, not the linked identities).
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';
import { listNamespaces } from '../src/services/namespaces.js';
import { expandBatch } from '../src/services/identityGraph.js';

const IMS_HOST = 'https://ims-na1.adobelogin.com';
const baseCreds = { clientId: 'tc', imsOrgId: 'org@AcmeOrg', clientSecret: 'sec' };

afterEach(() => nock.cleanAll());

function mockIms() {
  nock(IMS_HOST).persist().post('/ims/token/v3')
    .reply(200, { access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
}

test('listNamespaces uses creds.region (NLD2) instead of process default', async () => {
  mockIms();
  // VA7 (the process-wide default) MUST NOT be hit. NLD2 is what the
  // credential row says, so listNamespaces must route there.
  const nld2 = nock('https://platform-nld2.adobe.io')
    .get('/data/core/idnamespace/identities')
    .reply(200, [{ id: 6, code: 'email', name: 'Email' }]);

  const result = await listNamespaces({
    creds: { ...baseCreds, region: 'nld2' },
    sandboxName: 'eu-prod',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'email');
  assert.ok(nld2.isDone(), 'NLD2 host should have been called');
});

test('expandBatch uses creds.region (AUS5) instead of process default', async () => {
  mockIms();
  const aus5 = nock('https://platform-aus5.adobe.io')
    .post('/data/core/identity/clusters/members')
    .reply(200, { version: '1.1.0', clusters: [
      { compositeXid: { id: 'kocid-1', nsid: 411 }, members: [
        { id: 'a@x.com', nsid: 6 },
      ]},
    ]});

  const result = await expandBatch({
    creds: { ...baseCreds, region: 'aus5' },
    sandboxName: 'apac-prod',
    namespace: 'hashedKocid',
    namespaceId: 411,
    ids: ['kocid-1'],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].linkedIdentities.length, 1);
  assert.ok(aus5.isDone(), 'AUS5 host should have been called');
});

test('listNamespaces falls back to config default when creds.region missing', async () => {
  mockIms();
  // creds.region is undefined; the global default is va7 — confirm we still
  // route somewhere sane rather than throwing.
  const va7 = nock('https://platform-va7.adobe.io')
    .get('/data/core/idnamespace/identities')
    .reply(200, []);

  await listNamespaces({ creds: baseCreds, sandboxName: 'sbx' });
  assert.ok(va7.isDone(), 'VA7 (config default) should have been called');
});
