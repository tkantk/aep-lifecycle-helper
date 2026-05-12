import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { q } from '../db.js';
import { logger } from './logger.js';

/**
 * AES-256-GCM encryption for IMS client secrets at rest.
 *
 * The encryption key is loaded from:
 *   1. ENCRYPTION_KEY env var (64 hex chars), OR
 *   2. data/.key file (auto-generated on first run)
 *
 * The file is created with 0600 permissions on POSIX. On Windows the mode
 * argument is largely ignored — the key inherits the parent directory's ACL.
 * If you're on Windows, prefer running with `data/` outside any cloud-sync
 * path (OneDrive, Dropbox, Google Drive) so the key is not synced. The startup
 * banner emits a warning when it detects a cloud-sync path. (F3 in the
 * 2026-05-12 security review.)
 */

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;

  if (config.encryptionKey) {
    if (config.encryptionKey.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    }
    cachedKey = Buffer.from(config.encryptionKey, 'hex');
    return cachedKey;
  }

  const keyPath = path.join(config.dataDir, '.key');
  if (fs.existsSync(keyPath)) {
    cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
    return cachedKey;
  }

  // First run: generate and persist with O_EXCL so a parallel boot can't race
  // us into two different keys (F12 in the 2026-05-12 security review). If
  // someone else won the race, fall through to the read path on the next call.
  const keyHex = randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, keyHex, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Another process won the race; re-read the file they wrote.
      cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
      return cachedKey;
    }
    throw err;
  }
  // On POSIX, double-check the file mode in case umask masked our 0600 request.
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(keyPath);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        try { fs.chmodSync(keyPath, 0o600); }
        catch (e) { logger.warn({ err: e.message, mode: mode.toString(8) }, 'could not tighten .key permissions'); }
      }
    } catch { /* stat is best-effort */ }
  }
  cachedKey = Buffer.from(keyHex, 'hex');
  return cachedKey;
}

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc, iv, tag };
}

function decrypt({ enc, iv, tag }) {
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function storeCreds({ label, clientName, environment, region, imsOrgId, clientId, clientSecret }) {
  const { enc, iv, tag } = encrypt(clientSecret);
  const existing = q().findCred.get(environment, imsOrgId, clientId);
  const id = existing?.id || uuid();
  q().insertCred.run({
    id, label, clientName: clientName || null,
    environment, region, imsOrgId, clientId,
    enc, iv, tag,
  });
  return id;
}

export async function decryptCreds(credsId) {
  const row = q().getCred.get(credsId);
  if (!row) throw new Error(`Unknown credential id: ${credsId}`);
  const clientSecret = decrypt({
    enc: row.client_secret_enc,
    iv: row.client_secret_iv,
    tag: row.client_secret_tag,
  });
  q().touchCred.run(credsId);
  return {
    imsOrgId: row.ims_org_id,
    clientId: row.client_id,
    clientSecret,
    // Region must travel with the creds — Identity Service is regionally
    // sharded and calling the wrong region returns 200 with empty cluster
    // data, leading to silent partial deletes. Callers should prefer this
    // over the process-wide config default.
    region: row.region || null,
  };
}
