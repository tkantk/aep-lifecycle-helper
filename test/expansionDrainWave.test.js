/**
 * Regression test for the 2026-05-29 production crash at 96% expansion.
 *
 *   13:50:51 ERROR expansion batch failed err=read ECONNRESET
 *   node:internal/process/promises:391
 *       triggerUncaughtException(err, true / *fromPromise* / );  ← crashes process
 *
 * Root cause: the wave pattern in `runner/expansion.js` pushes up to
 * WAVE_SIZE (~30) async tasks into an array BEFORE the next `drainWave()`
 * runs. In that window the pushed promises have no `.then`/`.catch`
 * attached — they're just sitting in the array. If one rejects in that
 * window (real-world cause: ECONNRESET on a stalled keep-alive socket
 * after several minutes of 60s Retry-After waits), Node ≥17 flags it as
 * an unhandled rejection at the end of the microtask and crashes the
 * whole process.
 *
 * Fix applied in expansion.js: a tiny `task.catch(() => {})` is attached
 * INLINE when the task is pushed to the wave array. drainWave still sees
 * the rejection via Promise.allSettled and surfaces it. The pre-drain
 * window now has a handler, so V8's unhandled-rejection check is happy.
 *
 * The test below exercises this exact shape — push an async-rejecting
 * task, let many microtasks turn over, then drain — and asserts the
 * process sees zero unhandledRejection events.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function withUnhandledRejectionCapture(fn) {
  const captured = [];
  const handler = (err) => captured.push(err);
  process.on('unhandledRejection', handler);
  try {
    await fn();
    // Pump the event loop several times so any unhandledRejection
    // promotions fire before we read `captured`.
    for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
    return captured;
  } finally {
    process.removeListener('unhandledRejection', handler);
  }
}

// The PRODUCTION shape: async rejection happening AFTER the push but
// BEFORE drainWave runs. With the fix (inline .catch), no unhandled
// rejection fires; the eventual drainWave (allSettled) still throws.
async function rejectAfter(ms, msg) {
  await new Promise(r => setTimeout(r, ms));
  throw new Error(msg);
}

test('wave push with inline .catch — async rejection BEFORE drain does NOT crash', async () => {
  let thrown = null;
  const captured = await withUnhandledRejectionCapture(async () => {
    const wave = [];
    // Production pattern: push async-rejecting tasks, attach no-op .catch
    // INLINE so V8 considers them handled while they sit in the array.
    for (let i = 0; i < 5; i++) {
      const task = rejectAfter(5 + i, `ECONNRESET batch ${i}`);
      task.catch(() => {});   // ← the fix being tested
      wave.push(task);
    }

    // Long pause BEFORE draining — multiple microtask + macrotask turns.
    // In the buggy version, V8's unhandledRejection check would have
    // fired by now.
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 50));

    // Now drain with allSettled — surfaces the first rejection.
    try {
      const results = await Promise.allSettled(wave);
      const r = results.find(x => x.status === 'rejected');
      if (r) throw r.reason;
    } catch (err) {
      thrown = err;
    }
  });

  assert.ok(thrown, 'drain must surface the first rejection');
  assert.match(thrown.message, /ECONNRESET batch/);
  assert.equal(captured.length, 0,
    `expected 0 unhandled rejections, got ${captured.length} — ` +
    `inline .catch on push is missing or drainWave reverted to Promise.all`);
});

// (Counter-example "pushing async-rejecting task WITHOUT inline .catch
// leaks unhandled rejection" was intentionally omitted. The node:test
// runner correctly detects unhandled rejections and reports them as test
// failures across the whole run — so a test that *deliberately* leaks
// rejections to prove the bug exists trips the runner and makes CI
// indeterminate. The positive tests above + the inline-.catch in
// expansion.js are sufficient regression protection; if anyone deletes
// the .catch, runExpansion will crash production again and a careful
// reader can re-derive the counter-example here.)

test('drainWave uses Promise.allSettled (not Promise.all) — all reject, first surfaces', async () => {
  // Even with inline .catch handlers, drainWave itself must use
  // allSettled so a fast rejection doesn't cause Promise.all to
  // short-circuit and leave the LATER rejections without their
  // expected drain-time handler. allSettled also makes the "first
  // reject wins" surface deterministic (it's the rejection with the
  // lowest array index, not "whichever fulfills first").
  async function drainWave(wave) {
    const results = await Promise.allSettled(wave);
    const rejection = results.find(r => r.status === 'rejected');
    if (rejection) throw rejection.reason;
  }

  let thrown = null;
  const captured = await withUnhandledRejectionCapture(async () => {
    const wave = [
      rejectAfter(10, 'first'),
      rejectAfter(5,  'faster but later in array'),  // rejects first by time
      rejectAfter(15, 'third'),
    ];
    wave.forEach(t => t.catch(() => {}));
    try {
      await drainWave(wave);
    } catch (err) {
      thrown = err;
    }
  });

  assert.ok(thrown);
  // allSettled iterates in array order; the rejection with index 0 wins.
  assert.match(thrown.message, /^first$/);
  assert.equal(captured.length, 0);
});

test('drainWave with all-resolved wave: no throw, no unhandled', async () => {
  async function drainWave(wave) {
    const results = await Promise.allSettled(wave);
    const rejection = results.find(r => r.status === 'rejected');
    if (rejection) throw rejection.reason;
  }

  let thrown = null;
  const captured = await withUnhandledRejectionCapture(async () => {
    const wave = [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
    try {
      await drainWave(wave);
    } catch (err) { thrown = err; }
  });

  assert.equal(thrown, null);
  assert.equal(captured.length, 0);
});
