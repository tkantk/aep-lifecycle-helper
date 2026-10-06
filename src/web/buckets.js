/*
 * Submission-batch helpers for the Submit and Plan tabs (2026-10-06).
 *
 * A "batch" is one (month_index, day_index) bucket of work orders — what one
 * Submit click ships. Pure functions, no DOM: loaded as a classic script before
 * app.js (window.AepBuckets) and evaluated in node by test/webBuckets.test.js.
 *
 * Why this exists: the Submit tab used to group by day_index only (so "Day 1"
 * mixed Month 1, 2 and 3 work) and picked the lowest DAY across all months.
 * Batches are ordered by month, then day, and a Submit sends the exact IDs of
 * one batch's shippable orders.
 */
(function (root) {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthOf(w) { return w.month_index == null ? 1 : w.month_index; }
  function dayOf(w) { return w.day_index == null ? 1 : w.day_index; }

  /** Work orders grouped by (month, day), ordered by month then day; input order kept inside a batch. */
  function listBuckets(wos) {
    var byKey = new Map();
    wos.forEach(function (w) {
      var key = monthOf(w) + ':' + dayOf(w);
      if (!byKey.has(key)) byKey.set(key, { month: monthOf(w), day: dayOf(w), wos: [] });
      byKey.get(key).wos.push(w);
    });
    return Array.from(byKey.values()).sort(function (a, b) { return a.month - b.month || a.day - b.day; });
  }

  /** Orders in a batch that a Submit may ship: planned or deferred, never sent, never awaiting approval. */
  function submittable(bucket) {
    if (!bucket) return [];
    return bucket.wos.filter(function (w) {
      return (w.status === 'planned' || w.status === 'deferred') && !w.adobe_workorder_id;
    });
  }

  /** The next batch to ship: the first (month, day) with anything submittable, or null. */
  function firstPendingBucket(wos) {
    var buckets = listBuckets(wos);
    for (var i = 0; i < buckets.length; i++) if (submittable(buckets[i]).length > 0) return buckets[i];
    return null;
  }

  /** Position of the batch (month, day) in a listBuckets() result, or -1. */
  function bucketIndex(buckets, month, day) {
    for (var i = 0; i < buckets.length; i++) if (buckets[i].month === month && buckets[i].day === day) return i;
    return -1;
  }

  /** Calendar month of label "Month N" for a plan anchored at 'YYYY-MM' → 'Nov 2026'; null without an anchor. */
  function calendarMonthName(anchor, monthIndex) {
    var m = /^(\d{4})-(\d{2})$/.exec(anchor || '');
    if (!m) return null;
    var idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + (monthIndex - 1);
    return MONTHS[idx % 12] + ' ' + Math.floor(idx / 12);
  }

  /**
   * When batch "Month N" of a plan anchored at 'YYYY-MM' lies in a calendar
   * month that has not started yet (UTC), the day it opens ('Nov 1, 2026');
   * otherwise null. Submitting such a batch early can only defer (its month's
   * quota isn't available yet), so the Submit tab disables it. null without an
   * anchor (legacy plan) — no gating when we can't tell.
   */
  function opensOn(anchor, monthIndex, now) {
    var m = /^(\d{4})-(\d{2})$/.exec(anchor || '');
    if (!m) return null;
    var batchIdx = Number(m[1]) * 12 + (Number(m[2]) - 1) + (monthIndex - 1);
    var d = now || new Date();
    var nowIdx = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (batchIdx <= nowIdx) return null;
    return MONTHS[batchIdx % 12] + ' 1, ' + Math.floor(batchIdx / 12);
  }

  /** 'Month 2 (Nov 2026) · Day 3' — or 'Month 2 · Day 3' when the plan has no anchor. */
  function bucketLabel(bucket, anchor) {
    var cal = calendarMonthName(anchor, bucket.month);
    return 'Month ' + bucket.month + (cal ? ' (' + cal + ')' : '') + ' · Day ' + bucket.day;
  }

  root.AepBuckets = {
    listBuckets: listBuckets,
    submittable: submittable,
    firstPendingBucket: firstPendingBucket,
    bucketIndex: bucketIndex,
    calendarMonthName: calendarMonthName,
    opensOn: opensOn,
    bucketLabel: bucketLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);
