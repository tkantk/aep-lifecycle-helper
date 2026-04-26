/**
 * Unit tests for services/namespaces.js.
 *
 * Pure functions — no DB, no HTTP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNamespaceIndex, canonicalizeNamespace } from '../src/services/namespaces.js';

// ─── buildNamespaceIndex ──────────────────────────────────────────────────────

test('buildNamespaceIndex: indexes by both code and id', () => {
  const namespaces = [
    { id: 6, code: 'email', name: 'Email' },
    { id: 7, code: 'phone', name: 'Phone' },
    { id: 411, code: 'AAID', name: 'Analytics' },
  ];
  const idx = buildNamespaceIndex(namespaces);
  assert.equal(idx.byCode.get('email').id, 6);
  assert.equal(idx.byId.get(6).code, 'email');
  assert.equal(idx.byCode.get('AAID').id, 411);
  assert.equal(idx.byId.get(411).code, 'AAID');
});

test('buildNamespaceIndex: handles namespaces with no code gracefully', () => {
  const namespaces = [{ id: 6, code: null, name: 'NoCode' }];
  const idx = buildNamespaceIndex(namespaces);
  assert.equal(idx.byCode.size, 0);
  assert.equal(idx.byId.get(6).name, 'NoCode');
});

test('buildNamespaceIndex: empty array produces empty maps', () => {
  const idx = buildNamespaceIndex([]);
  assert.equal(idx.byCode.size, 0);
  assert.equal(idx.byId.size, 0);
});

// ─── canonicalizeNamespace ────────────────────────────────────────────────────

test('canonicalizeNamespace: code + nsid, no index — returns both as-is', () => {
  const result = canonicalizeNamespace({ ns: 'email', nsid: 6 });
  assert.equal(result.code, 'email');
  assert.equal(result.id, 6);
});

test('canonicalizeNamespace: code only, no index — id is null', () => {
  const result = canonicalizeNamespace({ ns: 'email' });
  assert.equal(result.code, 'email');
  assert.equal(result.id, null);
});

test('canonicalizeNamespace: nsid only, no index — code is null', () => {
  const result = canonicalizeNamespace({ nsid: 6 });
  assert.equal(result.code, null);
  assert.equal(result.id, 6);
});

test('canonicalizeNamespace: both null inputs return {code:null, id:null}', () => {
  const result = canonicalizeNamespace({});
  assert.equal(result.code, null);
  assert.equal(result.id, null);
});

test('canonicalizeNamespace: code fills in id from index when id missing', () => {
  const idx = buildNamespaceIndex([{ id: 6, code: 'email' }]);
  const result = canonicalizeNamespace({ ns: 'email' }, idx);
  assert.equal(result.code, 'email');
  assert.equal(result.id, 6);
});

test('canonicalizeNamespace: nsid fills in code from index when code missing', () => {
  const idx = buildNamespaceIndex([{ id: 6, code: 'email' }]);
  const result = canonicalizeNamespace({ nsid: 6 }, idx);
  assert.equal(result.code, 'email');
  assert.equal(result.id, 6);
});

test('canonicalizeNamespace: both code and nsid provided — no index lookup needed', () => {
  const idx = buildNamespaceIndex([{ id: 6, code: 'email' }]);
  const result = canonicalizeNamespace({ ns: 'email', nsid: 6 }, idx);
  assert.equal(result.code, 'email');
  assert.equal(result.id, 6);
});

test('canonicalizeNamespace: namespace not in index — returns whatever was provided', () => {
  const idx = buildNamespaceIndex([{ id: 6, code: 'email' }]);
  const result = canonicalizeNamespace({ nsid: 99999 }, idx);
  assert.equal(result.code, null);
  assert.equal(result.id, 99999);
});

test('canonicalizeNamespace: id=0 is a valid lookup (fix for id && !code bug)', () => {
  // id=0 is falsy in JS; the fix was `id != null && !code` instead of `id && !code`
  const idx = buildNamespaceIndex([{ id: 0, code: 'ZERO' }]);
  const result = canonicalizeNamespace({ nsid: 0 }, idx);
  assert.equal(result.code, 'ZERO');
  assert.equal(result.id, 0);
});

test('canonicalizeNamespace: empty string ns treated as null', () => {
  const result = canonicalizeNamespace({ ns: '', nsid: 7 });
  assert.equal(result.code, null);
  assert.equal(result.id, 7);
});
