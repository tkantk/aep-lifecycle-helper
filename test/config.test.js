/**
 * Review findings #5 + MONTHLY=0.
 *
 * #5: DATA_DIR must relocate ALL runtime state (db, uploads, output), not just
 *     the encryption key. The documented OneDrive mitigation depends on this.
 * MONTHLY=0: MONTHLY_IDENTIFIER_LIMIT=0 must mean "disable monthly tracking",
 *     not silently revert to the 3M default.
 *
 * config.js reads process.env at module-eval time, so we evaluate it in a
 * child process with a controlled environment and read back the resolved
 * values as JSON.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// OS-agnostic "is `child` under `parent`?". config.js derives sub-paths via
// path.join, which emits `\` on Windows and `/` on POSIX — so a literal
// `startsWith(parent + '/')` check is non-portable. path.relative resolves
// both sides on the host platform; a child is "under" parent when the result
// is a non-empty relative path that doesn't escape upward.
function isUnder(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function loadConfigWith(env) {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e',
      'import { config } from "./src/config.js"; ' +
      'process.stdout.write(JSON.stringify({ dbPath: config.dbPath, uploadDir: config.uploadDir, outputDir: config.outputDir, dataDir: config.dataDir, monthly: config.monthlyIdentifierLimit }));'],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

test('DATA_DIR relocates db, uploads, and output (not just the key)', () => {
  const dir = '/tmp/aep-custom-datadir';
  const cfg = loadConfigWith({ DATA_DIR: dir, DB_PATH: '', UPLOAD_DIR: '', OUTPUT_DIR: '' });
  assert.equal(cfg.dataDir, dir);
  assert.ok(isUnder(dir, cfg.dbPath), `dbPath should be under DATA_DIR, got ${cfg.dbPath}`);
  assert.ok(isUnder(dir, cfg.uploadDir), `uploadDir should be under DATA_DIR, got ${cfg.uploadDir}`);
  assert.ok(isUnder(dir, cfg.outputDir), `outputDir should be under DATA_DIR, got ${cfg.outputDir}`);
});

test('MONTHLY_IDENTIFIER_LIMIT=0 coerces to the 3M default (no "disable monthly", review R4 #4)', () => {
  const cfg = loadConfigWith({ MONTHLY_IDENTIFIER_LIMIT: '0' });
  assert.equal(cfg.monthly, 3_000_000, '0 is no longer "disabled" — Adobe always enforces a monthly cap');
});

test('MONTHLY_IDENTIFIER_LIMIT unset falls back to the 3M default', () => {
  const cfg = loadConfigWith({ MONTHLY_IDENTIFIER_LIMIT: '' });
  assert.equal(cfg.monthly, 3_000_000);
});
