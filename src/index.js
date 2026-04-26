import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import open from 'open';

import { config } from './config.js';
import { logger } from './utils/logger.js';
import { initDb } from './db.js';
import { startMonitor } from './runner/monitor.js';
import { runStartupRecovery } from './runner/recovery.js';

import configRouter from './routes/config.js';
import uploadRouter from './routes/upload.js';
import jobsRouter from './routes/jobs.js';
import adobeRouter from './routes/adobe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Ensure data directories exist ──────────────────────────────────────
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// ─── Init SQLite schema ─────────────────────────────────────────────────
initDb();

// ─── Express app ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve the UI
app.use(express.static(path.join(__dirname, 'web')));

// REST API
app.use('/api/config', configRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/adobe', adobeRouter);

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: err.code || 'INTERNAL_ERROR',
    message: err.message,
  });
});

// ─── Start background runners ───────────────────────────────────────────
// The monitor polls Adobe for status of in-flight work orders.
// It runs in the same process - no separate worker required.
startMonitor();

// Recover any jobs / work orders that were mid-flight when the process last
// stopped. Runs once, asynchronously — doesn't block the HTTP server start.
runStartupRecovery();

// ─── Start server ───────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  logger.info(`AEP Lifecycle Helper running at ${url} (bound to ${config.host})`);
  logger.info(`State file: ${config.dbPath}`);
  if (config.openBrowser) open(url).catch(() => {});
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    process.exit(0);
  });
}
