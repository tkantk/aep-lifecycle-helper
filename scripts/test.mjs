#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * Why this exists instead of a bare `node --test` in package.json:
 *   1. `node --test test` (the old script) is broken on Node >= 23 — the
 *      positional `test` is parsed as a single test name, not a directory.
 *      `node --test` (no positional) discovers test/*.test.js correctly on
 *      Node 20 and 23 alike.
 *   2. The suite needs a STABLE ENCRYPTION_KEY. Without one, each isolated
 *      `node --test` worker process auto-generates its own data/.key and they
 *      race, so credential encrypt/decrypt tests fail intermittently. We set a
 *      deterministic throwaway key here (only when the caller hasn't supplied
 *      one), which is portable across shells — `VAR=x cmd` syntax is not.
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
if (!env.ENCRYPTION_KEY) env.ENCRYPTION_KEY = '0'.repeat(64); // 32-byte test-only key

const args = ['--test', ...process.argv.slice(2)];
const res = spawnSync(process.execPath, args, { stdio: 'inherit', env });
process.exit(res.status ?? 1);
