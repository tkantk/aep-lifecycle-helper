/**
 * Review R4 #3: under a CONCURRENT start (multiple processes launched at the
 * same instant against the same database), the single-process advisory lock
 * must admit EXACTLY ONE — the link()-based atomic acquisition must not let a
 * second process observe a half-written/empty lock and reclaim it.
 *
 * Spawns several real `node src/index.js` processes on one DB_PATH and asserts
 * exactly one logs "running at" while the rest log "already running".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'src', 'index.js');
const KEY = '0'.repeat(64);

test('concurrent start: exactly one instance acquires the lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-lock-conc-'));
  const dbPath = path.join(dir, 'state.db');
  const N = 5;
  const procs = [];
  const out = Array.from({ length: N }, () => '');

  for (let i = 0; i < N; i++) {
    const p = spawn(process.execPath, [indexPath], {
      env: { ...process.env, DATA_DIR: dir, DB_PATH: dbPath, OPEN_BROWSER: '0',
             PORT: String(4900 + i), ENCRYPTION_KEY: KEY },
    });
    p.stdout.on('data', d => { out[i] += d; });
    p.stderr.on('data', d => { out[i] += d; });
    procs.push(p);
  }

  // Give them time to race the lock + boot.
  await new Promise(r => setTimeout(r, 4000));

  const acquired = out.filter(o => /running at/.test(o)).length;
  const refused  = out.filter(o => /already running against the database/.test(o)).length;

  // Clean up any survivor(s) before asserting.
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
  await new Promise(r => setTimeout(r, 300));
  for (const ext of ['', '-wal', '-shm', '.lock']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  assert.equal(acquired, 1, `exactly one instance must acquire the lock (got ${acquired})`);
  assert.equal(refused, N - 1, `the other ${N - 1} must be refused (got ${refused})`);
});

test('R5 #6: graceful shutdown does NOT remove a lock a successor reclaimed (verify-token-before-unlink)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aep-lock-own-'));
  const dbPath = path.join(dir, 'state.db');
  const lockPath = dbPath + '.lock';
  let out = '';
  const p = spawn(process.execPath, [indexPath], {
    env: { ...process.env, DATA_DIR: dir, DB_PATH: dbPath, OPEN_BROWSER: '0',
           PORT: '4955', ENCRYPTION_KEY: KEY },
  });
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });

  // Wait until it has acquired + booted.
  const t0 = Date.now();
  while (!/running at/.test(out) && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 100));
  assert.match(out, /running at/, 'process A booted and acquired the lock');
  assert.ok(fs.existsSync(lockPath), 'lock file exists after acquire');

  // Simulate a successor reclaiming the lock: overwrite with a DIFFERENT token
  // (as if A had been wrongly declared stale and B took over).
  const successorToken = '999999:successor-uuid';
  fs.writeFileSync(lockPath, successorToken);

  // Gracefully stop A. Its shutdown must NOT delete the lock — A no longer holds it.
  p.kill('SIGTERM');
  await new Promise(r => { p.on('exit', r); setTimeout(r, 8000); });

  const survived = fs.existsSync(lockPath) &&
    fs.readFileSync(lockPath, 'utf8').trim() === successorToken;

  try { p.kill('SIGKILL'); } catch { /* */ }
  for (const ext of ['', '-wal', '-shm', '.lock']) { try { fs.unlinkSync(dbPath + ext); } catch { /* */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }

  assert.ok(survived, 'A\'s shutdown must leave the successor\'s reclaimed lock intact');
});
