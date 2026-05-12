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
const { startMonitor } = await import('./runner/monitor.js');
const { runStartupRecovery } = await import('./runner/recovery.js');
const { hostHeaderGuard, originRefererGuard, makeErrorHandler } =
  await import('./middleware/security.js');

const configRouter = (await import('./routes/config.js')).default;
const uploadRouter = (await import('./routes/upload.js')).default;
const jobsRouter   = (await import('./routes/jobs.js')).default;
const adobeRouter  = (await import('./routes/adobe.js')).default;

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

// ─── Start server ───────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  logger.info(`AEP Lifecycle Helper running at ${url} (bound to ${config.host})`);
  logger.info(`State file: ${config.dbPath}`);
  if (config.openBrowser) open(url).catch(() => {});
});

// Graceful shutdown: stop accepting new connections, give in-flight requests
// up to 10s to finish, checkpoint and close SQLite so the WAL doesn't grow
// across restarts, then exit. A hard `process.exit` on SIGINT was leaving the
// WAL un-checkpointed and forcing extra recovery work on next boot.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${sig} received, shutting down gracefully`);

  const forceExitMs = 10_000;
  const timer = setTimeout(() => {
    logger.warn('shutdown timeout exceeded, exiting');
    process.exit(1);
  }, forceExitMs).unref();

  server.close(err => {
    if (err) logger.error({ err: err.message }, 'server close error');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { logger.warn({ err: e.message }, 'wal_checkpoint failed'); }
    try { db.close(); } catch (e) { logger.warn({ err: e.message }, 'db close failed'); }
    clearTimeout(timer);
    process.exit(0);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));
