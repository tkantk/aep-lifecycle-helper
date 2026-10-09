/**
 * Identity Graph lookups get their own timeout (IDENTITY_TIMEOUT_MS, default
 * 120 s; 2026-10-09) and a timed-out lookup is retried — one slow Adobe reply no
 * longer fails the whole expansion.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import nock from 'nock';

process.env.IDENTITY_TIMEOUT_MS = '400';
const REGION = 'https://platform-va7.adobe.io';
const IMS = 'https://ims-na1.adobelogin.com';
const { expandBatchDetailed } = await import('../src/services/identityGraph.js');
const { config } = await import('../src/config.js');

before(() => {
  nock(IMS).persist().post('/ims/token/v3').reply(200, { access_token: 'tok', expires_in: 86400 });
});
const creds = { clientId: 'c', imsOrgId: 'o@AcmeOrg', clientSecret: 's', region: 'va7' };

test('IDENTITY_TIMEOUT_MS sets the lookup timeout; a slow first reply is retried and the batch succeeds', async () => {
  assert.equal(config.identityTimeoutMs, 400);
  let calls = 0;
  const answer = { version: '1.1.0', clusters: [{ compositeXid: { nsid: 6, id: 'src-a' }, members: [{ nsid: 6, id: 'src-a' }] }] };
  nock(REGION)
    .post('/data/core/identity/clusters/members').delay(900).reply(() => { calls++; return [200, answer]; })
    .post('/data/core/identity/clusters/members').reply(() => { calls++; return [200, answer]; });
  const { results, missing } = await expandBatchDetailed({ creds, sandboxName: 'prod', namespace: 'hashedKocid',
    namespaceId: 6, ids: ['src-a'], namespaceIndex: undefined });
  assert.deepEqual([results.length, missing], [1, []]);
  assert.equal(calls, 2, 'the first reply took longer than the lookup timeout, so it was asked again');
});

const configIn = async (env) => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    "const { config } = await import('./src/config.js'); console.log(config.identityTimeoutMs, config.requestTimeoutMs, config.expansionHeartbeatMs, config.resumeLogEvery)"],
    { env: { ...process.env, IDENTITY_TIMEOUT_MS: '', REQUEST_TIMEOUT_MS: '', EXPANSION_HEARTBEAT_MS: '', RESUME_LOG_EVERY: '', ...env },
      cwd: fileURLToPath(new URL('..', import.meta.url)) }).toString().trim();   // fileURLToPath: works on Windows too
};

test('defaults: lookups 120 s, other Adobe calls 60 s, heartbeat 30 s, resume line every 100,000', async () => {
  assert.equal(await configIn({}), '120000 60000 30000 100000');
});

test('a raised REQUEST_TIMEOUT_MS also raises the lookup default; nonsense values fall back (final review minors)', async () => {
  assert.equal(await configIn({ REQUEST_TIMEOUT_MS: '180000' }), '180000 180000 30000 100000',
    'a box that raised the general timeout for slow lookups must not drop back to 120 s');
  assert.equal(await configIn({ IDENTITY_TIMEOUT_MS: '90000', REQUEST_TIMEOUT_MS: '180000' }), '90000 180000 30000 100000');
  assert.equal(await configIn({ EXPANSION_HEARTBEAT_MS: '-5', RESUME_LOG_EVERY: '0' }), '120000 60000 30000 100000',
    'a negative heartbeat would flood the log every millisecond');
});
