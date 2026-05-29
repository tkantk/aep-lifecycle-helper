import path from 'node:path';
import fs from 'node:fs';
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

// ─── Ensure data directories exist ──────────────────────────────────────
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

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
    clearTimeout(timer);
    logger.info('shutdown complete');
    process.exit(0);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
