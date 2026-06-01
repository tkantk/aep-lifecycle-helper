#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * Why this exists instead of a bare `node --test` in package.json:
 *   1. `node --test test` (the original script) is broken on Node >= 23 — the
 *      positional `test` is parsed as a single test name, not a directory.
 *   2. The suite needs a STABLE ENCRYPTION_KEY. Without one, each isolated
 *      `node --test` worker process auto-generates its own data/.key and they
 *      race, so credential encrypt/decrypt tests fail intermittently. We set a
 *      deterministic throwaway key here (only when the caller hasn't supplied
 *      one), which is portable across shells — `VAR=x cmd` syntax is not.
 *   3. We ENUMERATE the test files explicitly rather than relying on
 *      `node --test` discovery. Discovery's default glob matches any file
 *      named test.js / test.mjs / test.cjs at any depth, so a bare
 *      `node --test` would pick up this runner itself and spawn recursively
 *      (a real bug in the prior scripts/test.mjs — it was named test.mjs and
 *      matched that glob, which also inflated the reported test count by 1).
 *      Enumerating is exact.
 *
 * This file is intentionally NOT named with a test.* / *-test filename and
 * lives outside the test directory, so nothing can auto-discover it as a test.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const testDir = path.join(repoRoot, 'test');

const env = { ...process.env };
if (!env.ENCRYPTION_KEY) env.ENCRYPTION_KEY = '0'.repeat(64); // 32-byte test-only key

// Explicit file list — pass-through extra args (e.g. --test-name-pattern) too.
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join('test', f));

const res = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit', env, cwd: repoRoot });
process.exit(res.status ?? 1);
