/**
 * Review finding #5: durableCheckpoint() must report whether the WAL was
 * actually flushed (durable). wal_checkpoint(FULL) returns { busy } and does
 * NOT throw when a concurrent reader blocks it; busy !== 0 means the commit is
 * not yet durable. Submission relies on this returning false to fail closed
 * (skip the irreversible POST) rather than ship on an unverified intent.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const dbPath = path.join(os.tmpdir(), `aep-test-ckpt-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = os.tmpdir();
process.env.OUTPUT_DIR = os.tmpdir();

const { initDb, q, durableCheckpoint } = await import('../src/db.js');

before(() => { initDb(); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* */ }
  }
});

test('durableCheckpoint returns false while a concurrent reader blocks the checkpoint, true once released', () => {
  // Create WAL frames on the main connection.
  q().insertCred.run({
    id: 'ckpt-cred', label: 'Ckpt', clientName: null, environment: 'prod', region: 'VA7',
    imsOrgId: 'ckpt-org@AcmeOrg', clientId: 'ckpt-client',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });

  // A second connection holds an open read snapshot, which makes a FULL
  // checkpoint report busy (not durable).
  const reader = new Database(dbPath);
  reader.pragma('journal_mode = WAL');
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) AS n FROM credentials').get();

  // More WAL frames so the checkpoint has work it cannot complete.
  q().insertCred.run({
    id: 'ckpt-cred-2', label: 'Ckpt2', clientName: null, environment: 'prod', region: 'VA7',
    imsOrgId: 'ckpt-org2@AcmeOrg', clientId: 'ckpt-client-2',
    enc: Buffer.from('x'), iv: Buffer.alloc(12), tag: Buffer.alloc(16),
  });

  assert.equal(durableCheckpoint(), false,
    'must report NOT durable while a reader blocks the checkpoint');

  reader.exec('COMMIT');
  reader.close();

  assert.equal(durableCheckpoint(), true, 'durable once the reader is released');
});
