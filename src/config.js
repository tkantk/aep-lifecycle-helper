import path from 'node:path';

/**
 * Configuration. All fields have sensible defaults so the tool runs
 * with zero .env setup on first launch.
 */

const cwd = process.cwd();

export const config = {
  port: Number(process.env.PORT) || 3000,
  // Default to loopback so the unauthenticated API + destructive submit
  // endpoints aren't exposed to other hosts on the network. Set HOST=0.0.0.0
  // explicitly only when you intend to expose it (e.g. SSH tunnel demo).
  host: process.env.HOST || '127.0.0.1',
  openBrowser: process.env.OPEN_BROWSER !== '0',

  // ─── Paths ─────────────────────────────────────────────────────────
  dataDir: process.env.DATA_DIR || path.join(cwd, 'data'),
  dbPath: process.env.DB_PATH || path.join(cwd, 'data', 'state.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(cwd, 'data', 'uploads'),
  outputDir: process.env.OUTPUT_DIR || path.join(cwd, 'data', 'output'),

  // ─── Adobe endpoints ───────────────────────────────────────────────
  ims: {
    host: process.env.IMS_HOST || 'https://ims-na1.adobelogin.com',
    scope: process.env.IMS_SCOPE ||
      'openid,AdobeID,read_organizations,additional_info.projectedProductContext,session',
  },
  aep: {
    gateway: process.env.AEP_GATEWAY || 'https://platform.adobe.io',
    // Identity API lives on region-specific host: platform-{region}.adobe.io
    identityRegion: process.env.AEP_IDENTITY_REGION || 'va7',
  },

  // ─── Throughput (the scalability knobs) ────────────────────────────
  // These are the only things that matter for scaling up. Bump concurrency
  // if you have fast bandwidth and Adobe isn't 429-ing you.
  identityBatchSize: Number(process.env.IDENTITY_BATCH_SIZE) || 1000,
  identityConcurrency: Number(process.env.IDENTITY_CONCURRENCY) || 10,
  workOrderConcurrency: Number(process.env.WORK_ORDER_CONCURRENCY) || 2,
  maxIdsPerWorkOrder: Number(process.env.MAX_IDS_PER_WORK_ORDER) || 100_000,
  dailyIdentifierLimit: Number(process.env.DAILY_IDENTIFIER_LIMIT) || 1_000_000,
  // Monthly identifier cap is contract-dependent. Default 3M/month matches
  // the typical base Data Hygiene entitlement; override via env or the Config
  // tab to match your contract. Set to 0 to disable monthly tracking.
  monthlyIdentifierLimit: Number(process.env.MONTHLY_IDENTIFIER_LIMIT) || 3_000_000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 60_000,

  // ─── Security ──────────────────────────────────────────────────────
  // 32-byte hex key used to encrypt client secrets at rest. Auto-generated
  // and stored in data/ on first run if not provided. Don't commit this.
  encryptionKey: process.env.ENCRYPTION_KEY,
};
