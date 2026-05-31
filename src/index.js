import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pin the .env load path to <package-root>/.env so a stray .env in the current
// working directory cannot silently override sensitive config (ENCRYPTION_KEY,
// IMS_HOST, AEP_GATEWAY, HOST). The package root is one level above src/.
// (F6 in the 2026-05-12 security review.)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { config, detectCloudSyncPath } = await import('./config.js');
const { logger } = await import('./utils/logger.js');

// ─── Refuse non-loopback bind without explicit acknowledgment ───────────
// The API has no authentication and submits irreversible deletes. Binding to
// anything other than loopback exposes it to the network, so a stray
// HOST=0.0.0.0 must be paired with ALLOW_NON_LOOPBACK=1 (review hardening).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK_HOSTS.has(config.host) && !config.allowNonLoopback) {
  logger.error(
    `Refusing to bind to non-loopback host "${config.host}" without ALLOW_NON_LOOPBACK=1. ` +
    `This API is unauthenticated and performs irreversible deletions — exposing it to the ` +
    `network is dangerous. Set ALLOW_NON_LOOPBACK=1 only for an SSH-tunneled/trusted setup.`);
  process.exit(1);
}

// ─── Ensure data directories exist ──────────────────────────────────────
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// ─── Single-process advisory lock (acquire BEFORE opening SQLite) ────────
// Two instances against the SAME database file corrupt the WAL (no multi-
// writer coordination). Key the lock on the canonical DB PATH — NOT DATA_DIR —
// because DB_PATH can point elsewhere, so two different DATA_DIRs could still
// share one database file (review finding #6). Acquire it BEFORE importing
// db.js, which opens the connection at module-eval time, so the connection is
// never opened while another instance holds the lock. Reclaim only a stale
// lock whose recorded pid is no longer alive. Released on shutdown.
const lockPath = config.dbPath === ':memory:' ? null : path.resolve(config.dbPath) + '.lock';

// Synchronous sleep — startup runs synchronously before the server. Atomics.wait
// blocks the thread without a busy-loop.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ }
}
function readLockHolder(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

function acquireSingleProcessLock() {
  if (!lockPath) return;   // in-memory DB has no shared file to guard
  const myToken = `${process.pid}:${crypto.randomUUID()}`;
  const tmpPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;

  for (let attempt = 0; attempt < 8; attempt++) {
    // Create the lock ATOMICALLY and ALREADY-POPULATED via link(): write the
    // token to a temp file, then hard-link it onto the lock path. link() fails
    // EEXIST if the lock is held, and — unlike open(O_EXCL)+write — the lock
    // file is never observable in an EMPTY state, eliminating both the
    // publication-window race (review #3) and the zero-byte strand (review #7).
    fs.writeFileSync(tmpPath, myToken);
    let linked = false;
    try {
      fs.linkSync(tmpPath, lockPath);
      linked = true;
    } catch (err) {
      if (err.code !== 'EEXIST') { try { fs.unlinkSync(tmpPath); } catch { /* */ } throw err; }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* */ }

    if (linked) {
      // Ownership verification — confirm the lock holds OUR token (defends
      // against a racing reclaim+rewrite). If not, back off and retry.
      if (readLockHolder(lockPath) === myToken) return;
      sleepSync(25);
      continue;
    }

    // Lock is held. Inspect the holder, with a GRACE RETRY for an empty lock
    // (a legacy openSync-based writer mid-publication, or a crashed one).
    let holder = readLockHolder(lockPath);
    for (let g = 0; g < 5 && holder === ''; g++) { sleepSync(40); holder = readLockHolder(lockPath); }
    if (holder === null) { sleepSync(25); continue; }   // vanished — retry

    const pid = Number(String(holder).split(':')[0]);
    const validPid = Number.isInteger(pid) && pid > 0;
    let alive = false;
    if (validPid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }

    if (validPid && alive && pid !== process.pid) {
      logger.error(
        `Another instance (pid ${pid}) is already running against the database ${config.dbPath}. ` +
        `Running two instances on one database corrupts the WAL. Stop the other instance first, ` +
        `or point DB_PATH at a different database file.`);
      process.exit(1);
    }

    // Dead pid, or genuinely-empty-after-grace (crashed publication) → reclaim.
    // VERIFY the content is UNCHANGED since we read it before unlinking, so we
    // never clobber a lock a fresh writer just published (review #3).
    logger.warn({ staleHolder: holder || '(empty)' }, 'reclaiming stale/corrupt single-process lock');
    if (readLockHolder(lockPath) === holder) { try { fs.unlinkSync(lockPath); } catch { /* */ } }
    sleepSync(25);
  }
  throw new Error('could not acquire single-process lock after retries');
}
acquireSingleProcessLock();

// ─── Now safe to open SQLite + load db-dependent modules (under the lock) ─
const { initDb, db } = await import('./db.js');
const { startMonitor, stopMonitor } = await import('./runner/monitor.js');
const { runStartupRecovery } = await import('./runner/recovery.js');
const { startScheduler, stopScheduler } = await import('./runner/scheduler.js');
const { hostHeaderGuard, originRefererGuard, makeErrorHandler } =
  await import('./middleware/security.js');

const configRouter   = (await import('./routes/config.js')).default;
const uploadRouter   = (await import('./routes/upload.js')).default;
const jobsRouter     = (await import('./routes/jobs.js')).default;
const adobeRouter    = (await import('./routes/adobe.js')).default;
const settingsRouter = (await import('./routes/settings.js')).default;

// ─── Purge orphaned upload files ────────────────────────────────────────
// CSV uploads carry raw customer identifiers. Remove any upload file in the
// upload dir that no job references (e.g. left behind by a force-deleted job
// or an interrupted upload) so customer data isn't retained indefinitely
// (review hardening). Job-referenced uploads are kept for crash-resume.
// Only the helper's own uploads match this shape: <epoch-ms>_<uuid-v4>.<ext>
// (see src/routes/upload.js multer storage filename). Restricting the purge to
// it guarantees we never delete a file the tool didn't create, even if
// UPLOAD_DIR points at a shared directory (review finding #7). Keep in lockstep
// with the multer filename in upload.js.
const GENERATED_UPLOAD_RE =
  /^[0-9]+_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.(csv|txt|tsv)$/;
function purgeOrphanedUploads() {
  try {
    const referenced = new Set(
      db.prepare(`SELECT upload_path FROM jobs WHERE upload_path IS NOT NULL`)
        .all().map(r => path.resolve(r.upload_path)));
    let purged = 0;
    for (const name of fs.readdirSync(config.uploadDir)) {
      if (!GENERATED_UPLOAD_RE.test(name)) continue;   // not ours — never touch
      const full = path.resolve(config.uploadDir, name);
      if (!referenced.has(full)) { try { fs.unlinkSync(full); purged++; } catch { /* */ } }
    }
    if (purged > 0) logger.info({ purged }, 'purged orphaned upload files (no referencing job)');
  } catch (err) {
    logger.warn({ err: err.message }, 'orphaned-upload purge failed (non-fatal)');
  }
}

// Warn loudly if `data/` sits inside a cloud-sync path — the encryption key
// and all encrypted credentials live there. Syncing them to a third-party
// cloud means key + ciphertext are co-located off-machine.
const cloudSync = detectCloudSyncPath(config.dataDir);
if (cloudSync) {
  logger.warn({
    dataDir: config.dataDir,
    syncedTo: cloudSync,
  }, `SECURITY WARNING: data/ (encryption key + encrypted secrets) appears to be inside a ${cloudSync}-synced path. Move it out (set DATA_DIR / DB_PATH env vars) or stop ${cloudSync} sync for that folder.`);
}

// ─── Init SQLite schema ─────────────────────────────────────────────────
initDb();
purgeOrphanedUploads();

// ─── Express app ────────────────────────────────────────────────────────
const app = express();

// ─── Security middleware (order matters) ────────────────────────────────
// 1. Host-header guard: defeats DNS rebinding (attacker.com → 127.0.0.1).
// 2. Origin/Referer guard: defeats simple-form CSRF against state-changing
//    routes. Both are explained in src/middleware/security.js.
// 3. helmet: security headers + CSP. The UI uses inline style="…" attrs
//    everywhere, so we allow 'unsafe-inline' for style-src only. Scripts
//    are loaded only from /app.js — no inline scripts in index.html.
// 4. UUID param guards (registered after routers are mounted, see below).
app.use(hostHeaderGuard);
app.use(originRefererGuard);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      fontSrc:    ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc:  ["'none'"],
      formAction: ["'self'"],
      baseUri:    ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  referrerPolicy:            { policy: 'no-referrer' },
}));

app.use(express.json({ limit: '10mb' }));

// Serve the UI
app.use(express.static(path.join(__dirname, 'web')));

// REST API. Each router calls registerUuidParamGuards(router) internally so
// :id and :credsId are validated as real UUIDs before any handler runs (F5):
// closes path-traversal on /api/jobs/:id/export and rejects malformed IDs
// before they reach SQLite or the filesystem.
app.use('/api/config', configRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/adobe', adobeRouter);
app.use('/api/settings', settingsRouter);

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Centralised error handler — see makeErrorHandler in middleware/security.js.
app.use(makeErrorHandler(logger));

// ─── Start background runners ───────────────────────────────────────────
// The monitor polls Adobe for status of in-flight work orders.
// It runs in the same process - no separate worker required.
startMonitor();

// Recover any jobs / work orders that were mid-flight when the process last
// stopped. Runs once, asynchronously — doesn't block the HTTP server start.
runStartupRecovery();

// Auto-resume scheduler (Phase 3). Always start the timer so the operator
// can toggle the setting from the UI without restarting; the tick is a
// no-op unless the operator has explicitly enabled auto-resume. The
// startup tick handles "laptop was closed at the scheduled time" — if the
// fire window passed today and we have un-shipped work, the catch-up
// fire happens immediately.
startScheduler();

// ─── Start server ───────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  logger.info(`AEP Lifecycle Helper running at ${url} (bound to ${config.host})`);
  logger.info(`State file: ${config.dbPath}`);

  // Performance-knob banner. Makes "did I set SQLITE_CACHE_MB?" answerable
  // by glancing at boot output. The defaults are conservative (512 MB / 10);
  // operators with multi-million-row jobs on RAM-rich machines should bump
  // these via .env (see README §Tuning for large jobs).
  const tuned = config.sqliteCacheMb >= 1024 || config.identityConcurrency > 10;
  logger.info(
    `Perf knobs: SQLITE_CACHE_MB=${config.sqliteCacheMb}  ` +
    `IDENTITY_CONCURRENCY=${config.identityConcurrency}  ` +
    `IDENTITY_BATCH_SIZE=${config.identityBatchSize}  ` +
    `WORK_ORDER_CONCURRENCY=${config.workOrderConcurrency}  ` +
    `${tuned ? '✓ tuned' : '⚠ defaults (recommend SQLITE_CACHE_MB=8192 for large jobs on a 32 GB machine)'}`
  );
  if (config.openBrowser) open(url).catch(() => {});
});

// Graceful shutdown. Multi-step because several things keep the event loop
// alive even after `server.close()`:
//   - Monitor's setInterval (60 s polling) — explicitly stop it.
//   - Scheduler's setInterval (60 s tick)  — explicitly stop it.
//   - HTTP keep-alive sockets that `server.close()` only drains, doesn't force
//     close — call `server.closeAllConnections()` (Node 18.2+) to drop them.
//   - Outbound axios requests from the expansion runner mid-batch — those keep
//     TLS sockets open. We can't cancel them cleanly without an AbortController
//     rewrite, so we rely on the force-exit timer + SIGKILL fallback.
//   - better-sqlite3 native bindings — process.exit can stall here for a few
//     seconds while the native side cleans up. SIGKILL is the nuclear backstop.
//
// The previous version's "shutdown timeout exceeded, exiting" WARN was real:
// the event loop wasn't draining because the monitor's setInterval kept ticking
// and keep-alive sockets weren't being force-closed. Even after process.exit,
// the native bindings could hang for ~5 s. This handler now stops every known
// loop-keeping source, force-closes connections, and SIGKILLs itself if a
// graceful exit takes too long.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${sig} received, shutting down gracefully`);

  // (1) Stop the recurring timers — without these the setIntervals keep the
  // loop alive indefinitely and shutdown can never converge naturally.
  try { stopScheduler(); } catch (e) { logger.warn({ err: e.message }, 'stopScheduler failed'); }
  try { stopMonitor();   } catch (e) { logger.warn({ err: e.message }, 'stopMonitor failed'); }

  // (2) Force-exit timer. NOT .unref() — we want this to fire even if other
  // things keep the loop alive. If it does fire, schedule a SIGKILL as the
  // final fallback in case process.exit itself hangs (better-sqlite3 native
  // bindings have been observed to stall process.exit for several seconds).
  const forceExitMs = 8_000;
  const timer = setTimeout(() => {
    logger.warn('shutdown timeout exceeded — forcing exit. Any in-flight expansion batches will be retried by startup recovery on the next boot.');
    setTimeout(() => {
      logger.error('process.exit hung — sending SIGKILL to self');
      try { process.kill(process.pid, 'SIGKILL'); } catch { /* */ }
    }, 3_000).unref();
    process.exit(1);
  }, forceExitMs);

  // (3) Force-close keep-alive sockets after a short grace period so
  // `server.close()` callback can actually fire. Without this, an idle
  // keep-alive connection holds the server open until its 5-minute timeout.
  if (typeof server.closeAllConnections === 'function') {
    setTimeout(() => {
      try { server.closeAllConnections(); } catch { /* */ }
    }, 2_000).unref();
  }

  // (4) Stop accepting new connections, await drain of existing ones, then
  // checkpoint SQLite and exit cleanly.
  server.close(err => {
    if (err) logger.error({ err: err.message }, 'server close error');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { logger.warn({ err: e.message }, 'wal_checkpoint failed'); }
    try { db.close(); } catch (e) { logger.warn({ err: e.message }, 'db close failed'); }
    if (lockPath) { try { fs.unlinkSync(lockPath); } catch { /* best-effort lock release */ } }
    clearTimeout(timer);
    logger.info('shutdown complete');
    process.exit(0);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
