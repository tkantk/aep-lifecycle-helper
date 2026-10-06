/**
 * Fix 3 (2026-10-06 review), UI side: the Submit tab groups work orders into
 * (month, day) batches and submits exactly one batch's shippable orders.
 *
 * Before: it grouped by day_index ONLY, so "Day 1" mixed Month 1, 2 and 3 work
 * ("28 WOs from months [1,2,3]"), and it picked the lowest DAY across all months
 * — the request that, combined with server-side re-labelling, shipped nothing or
 * a different batch. These helpers live in src/web/buckets.js (a classic script
 * the page loads before app.js) and are evaluated here in a sandbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../src/web/buckets.js', import.meta.url), 'utf8'), ctx);
const B = ctx.AepBuckets;
// Results are built inside the sandbox realm (its own Array.prototype); copy to
// host-realm values before deepStrictEqual compares them.
const plain = (v) => JSON.parse(JSON.stringify(v));

const wo = (id, month, day, status = 'planned', extra = {}) =>
  ({ id, month_index: month, day_index: day, status, identifier_count: 100_000, ...extra });

test('batches are ordered by month, then day — never mixing months', () => {
  const buckets = B.listBuckets([wo('a', 2, 1), wo('b', 1, 2), wo('c', 1, 1), wo('d', 1, 2), wo('e', 3, 1)]);
  assert.deepEqual(plain(buckets.map(b => `${b.month}:${b.day}:${b.wos.map(w => w.id).join('')}`)),
    ['1:1:c', '1:2:bd', '2:1:a', '3:1:e']);
});

test('legacy rows without month/day labels count as Month 1, Day 1', () => {
  const buckets = B.listBuckets([wo('a', null, null), wo('b', 1, 1)]);
  assert.equal(buckets.length, 1);
  assert.deepEqual(plain(buckets[0].wos.map(w => w.id)), ['a', 'b']);
});

test('only planned / deferred orders without an Adobe ID are submittable', () => {
  const [bucket] = B.listBuckets([
    wo('p', 1, 1, 'planned'), wo('d', 1, 1, 'deferred'), wo('a', 1, 1, 'awaiting_approval'),
    wo('s', 1, 1, 'submitted', { adobe_workorder_id: 'DI-1' }), wo('f', 1, 1, 'failed'),
  ]);
  assert.deepEqual(plain(B.submittable(bucket).map(w => w.id)), ['p', 'd']);
  assert.deepEqual(plain(B.submittable(null)), []);
});

test('the next batch is the first (month, day) with something submittable', () => {
  const wos = [
    wo('s1', 1, 1, 'submitted', { adobe_workorder_id: 'DI-1' }),
    wo('aw', 1, 2, 'awaiting_approval'),          // not submittable: needs approval
    wo('d1', 2, 1, 'deferred'),
    wo('p1', 1, 3, 'planned'),
  ];
  const next = B.firstPendingBucket(wos);
  assert.equal(`${next.month}:${next.day}`, '1:3', 'Month 1 Day 3 comes before Month 2 Day 1');
  assert.equal(B.firstPendingBucket([wo('x', 1, 1, 'submitted', { adobe_workorder_id: 'DI' })]), null);
});

test('bucketIndex finds a batch by its (month, day)', () => {
  const buckets = B.listBuckets([wo('a', 1, 1), wo('b', 2, 1)]);
  assert.equal(B.bucketIndex(buckets, 2, 1), 1);
  assert.equal(B.bucketIndex(buckets, 9, 9), -1);
});

test('calendar month names follow the plan anchor, across year boundaries', () => {
  assert.equal(B.calendarMonthName('2026-10', 1), 'Oct 2026');
  assert.equal(B.calendarMonthName('2026-11', 3), 'Jan 2027');
  assert.equal(B.calendarMonthName(null, 2), null);
  assert.equal(B.calendarMonthName('garbage', 2), null);
});

test('batch labels name the month, its calendar month and the day', () => {
  assert.equal(B.bucketLabel({ month: 2, day: 3 }, '2026-10'), 'Month 2 (Nov 2026) · Day 3');
  assert.equal(B.bucketLabel({ month: 1, day: 1 }, null), 'Month 1 · Day 1');
});

test('a batch whose calendar month has not started reports when it opens (Submit is gated)', () => {
  const oct20 = new Date('2026-10-20T09:00:00Z');
  assert.equal(B.opensOn('2026-10', 2, oct20), 'Nov 1, 2026');
  assert.equal(B.opensOn('2026-10', 1, oct20), null, 'the current month is open');
  assert.equal(B.opensOn('2026-10', 2, new Date('2026-11-01T00:00:00Z')), null, 'opens at 00:00 UTC on the 1st');
  assert.equal(B.opensOn('2026-12', 2, new Date('2026-12-15T00:00:00Z')), 'Jan 1, 2027');
  assert.equal(B.opensOn(null, 2, oct20), null, 'no anchor (legacy plan): cannot tell, do not gate');
});
