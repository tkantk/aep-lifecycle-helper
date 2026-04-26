/**
 * Unit tests for services/hygiene.js validators.
 *
 * These are pure functions — no DB, no HTTP. Static imports are fine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __internal__ } from '../src/services/hygiene.js';

const { validateDatasetId, normalizeNamespacesIdentities, validateTargetServices } = __internal__;

// ─── validateDatasetId ────────────────────────────────────────────────────────

test('validateDatasetId: "ALL" passes unchanged', () => {
  assert.equal(validateDatasetId('ALL'), 'ALL');
});

test('validateDatasetId: single id passes', () => {
  assert.equal(validateDatasetId('abc123def456'), 'abc123def456');
});

test('validateDatasetId: comma-separated ids are normalised', () => {
  assert.equal(validateDatasetId('abc , def , ghi'), 'abc,def,ghi');
});

test('validateDatasetId: "ALL" mixed with specific ids throws', () => {
  assert.throws(() => validateDatasetId('ALL,abc'), /cannot combine/i);
});

test('validateDatasetId: missing value throws', () => {
  assert.throws(() => validateDatasetId(''), /required/i);
  assert.throws(() => validateDatasetId(null), /required/i);
  assert.throws(() => validateDatasetId(undefined), /required/i);
});

test('validateDatasetId: invalid character in id throws', () => {
  assert.throws(() => validateDatasetId('abc!def'), /Invalid dataset id/i);
  assert.throws(() => validateDatasetId('abc def'), /Invalid dataset id/i);
});

test('validateDatasetId: hyphens and underscores are allowed', () => {
  assert.equal(validateDatasetId('abc-def_ghi'), 'abc-def_ghi');
});

// ─── normalizeNamespacesIdentities ───────────────────────────────────────────

test('normalizeNamespacesIdentities: minimal valid input (code + id)', () => {
  const { groups, total } = normalizeNamespacesIdentities([
    { namespace: { code: 'email', id: 6 }, ids: ['a@x.com'] },
  ]);
  assert.equal(total, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].namespace.code, 'email');
  assert.equal(groups[0].namespace.id, 6);
  assert.deepEqual(groups[0].ids, ['a@x.com']);
});

test('normalizeNamespacesIdentities: namespace with code only', () => {
  const { groups } = normalizeNamespacesIdentities([
    { namespace: { code: 'email' }, ids: ['a@x.com'] },
  ]);
  assert.equal(groups[0].namespace.code, 'email');
  assert.equal(groups[0].namespace.id, undefined);
});

test('normalizeNamespacesIdentities: namespace with numeric id only', () => {
  const { groups } = normalizeNamespacesIdentities([
    { namespace: { id: 411 }, ids: ['abc'] },
  ]);
  assert.equal(groups[0].namespace.id, 411);
  assert.equal(groups[0].namespace.code, undefined);
});

test('normalizeNamespacesIdentities: deduplicates ids within a group', () => {
  const { total, groups } = normalizeNamespacesIdentities([
    { namespace: { code: 'email' }, ids: ['a@x.com', 'a@x.com', 'b@x.com'] },
  ]);
  assert.equal(total, 2);
  assert.equal(groups[0].ids.length, 2);
});

test('normalizeNamespacesIdentities: filters null/empty ids', () => {
  const { total } = normalizeNamespacesIdentities([
    { namespace: { code: 'email' }, ids: ['a@x.com', '', null, '  '] },
  ]);
  assert.equal(total, 1);
});

test('normalizeNamespacesIdentities: multiple namespace groups', () => {
  const { groups, total } = normalizeNamespacesIdentities([
    { namespace: { code: 'email', id: 6 }, ids: ['a@x.com', 'b@x.com'] },
    { namespace: { code: 'ECID', id: 4 }, ids: ['123456789'] },
  ]);
  assert.equal(total, 3);
  assert.equal(groups.length, 2);
});

test('normalizeNamespacesIdentities: throws on empty array', () => {
  assert.throws(() => normalizeNamespacesIdentities([]), /non-empty/i);
});

test('normalizeNamespacesIdentities: throws on namespace with neither code nor id', () => {
  assert.throws(
    () => normalizeNamespacesIdentities([{ namespace: {}, ids: ['x'] }]),
    /code or id/i,
  );
});

test('normalizeNamespacesIdentities: throws on namespace with empty ids array', () => {
  assert.throws(
    () => normalizeNamespacesIdentities([{ namespace: { code: 'email' }, ids: [] }]),
    /empty ids/i,
  );
});

test('normalizeNamespacesIdentities: throws when all ids are whitespace/null', () => {
  assert.throws(
    () => normalizeNamespacesIdentities([{ namespace: { code: 'email' }, ids: ['', '  ', null] }]),
    /empty ids/i,
  );
});

test('normalizeNamespacesIdentities: throws on duplicate namespace key', () => {
  assert.throws(
    () => normalizeNamespacesIdentities([
      { namespace: { code: 'email' }, ids: ['a@x.com'] },
      { namespace: { code: 'email' }, ids: ['b@x.com'] },
    ]),
    /Duplicate/i,
  );
});

test('normalizeNamespacesIdentities: exactly 100k ids passes', () => {
  const ids = Array.from({ length: 100_000 }, (_, i) => `id${i}`);
  const { total } = normalizeNamespacesIdentities([{ namespace: { code: 'email' }, ids }]);
  assert.equal(total, 100_000);
});

test('normalizeNamespacesIdentities: 100k + 1 ids throws', () => {
  const ids = Array.from({ length: 100_001 }, (_, i) => `id${i}`);
  assert.throws(
    () => normalizeNamespacesIdentities([{ namespace: { code: 'email' }, ids }]),
    /exceeds per-order limit/i,
  );
});

test('normalizeNamespacesIdentities: 100k total across multiple groups passes', () => {
  const half = Array.from({ length: 50_000 }, (_, i) => `id${i}`);
  const { total } = normalizeNamespacesIdentities([
    { namespace: { code: 'email' }, ids: half },
    { namespace: { code: 'phone' }, ids: half },
  ]);
  assert.equal(total, 100_000);
});

// ─── validateTargetServices ───────────────────────────────────────────────────

test('validateTargetServices: undefined returns undefined (no profile-only mode)', () => {
  assert.equal(validateTargetServices(undefined, 'ALL'), undefined);
  assert.equal(validateTargetServices(null, 'ALL'), undefined);
});

test('validateTargetServices: valid set in any order passes', () => {
  for (const order of [
    ['identity', 'profile', 'ajo'],
    ['ajo', 'profile', 'identity'],
    ['profile', 'ajo', 'identity'],
  ]) {
    const result = validateTargetServices(order, 'ALL');
    assert.ok(Array.isArray(result));
    assert.deepEqual(new Set(result), new Set(['identity', 'profile', 'ajo']));
  }
});

test('validateTargetServices: throws when not exactly 3 services', () => {
  assert.throws(() => validateTargetServices(['identity', 'profile'], 'ALL'), /exactly/i);
  assert.throws(
    () => validateTargetServices(['identity', 'profile', 'ajo', 'extra'], 'ALL'),
    /exactly/i,
  );
});

test('validateTargetServices: throws when an invalid service is included', () => {
  assert.throws(
    () => validateTargetServices(['identity', 'profile', 'datalake'], 'ALL'),
    /identity, profile, ajo/i,
  );
});

test('validateTargetServices: throws when datasetId is not "ALL"', () => {
  assert.throws(
    () => validateTargetServices(['identity', 'profile', 'ajo'], 'ds_123'),
    /requires datasetId="ALL"/i,
  );
});

test('validateTargetServices: case-insensitive service matching', () => {
  const result = validateTargetServices(['Identity', 'PROFILE', 'AJO'], 'ALL');
  assert.ok(Array.isArray(result));
});
