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
