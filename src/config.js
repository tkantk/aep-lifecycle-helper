import path from 'node:path';

/**
 * Configuration. All fields have sensible defaults so the tool runs
 * with zero .env setup on first launch.
 */

const cwd = process.cwd();

// DATA_DIR is the single root for ALL runtime state. db/uploads/output derive
// from it so that pointing DATA_DIR outside a cloud-sync path (the documented
// OneDrive mitigation) actually relocates the SQLite DB too — not just the
// encryption key (review finding #5). Each sub-path still has its own explicit
// override for advanced setups.
const dataDir = process.env.DATA_DIR || path.join(cwd, 'data');

// Resolve a numeric env var, PRESERVING an explicit 0 (e.g.
// MONTHLY_IDENTIFIER_LIMIT=0 means "disable monthly tracking"). `|| default`
// wrongly turned 0 back into the default. Empty/unset/NaN → fallback.
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Detect when `dataDir` lives inside a cloud-sync path (OneDrive, Dropbox,
 * Google Drive, iCloud). The encryption key + encrypted client secrets live
 * here, and syncing them to a third-party cloud is exactly what we don't
 * want. This is informational only — we log a loud warning at boot. See
 * F3 in the 2026-05-12 security review.
 */
export function detectCloudSyncPath(p) {
  const normalized = p.replace(/\\/g, '/').toLowerCase();
  const patterns = [
    { name: 'OneDrive',      re: /\/onedrive([^/]*\/|\/)/ },
    { name: 'Dropbox',       re: /\/dropbox(\/|$)/ },
    { name: 'Google Drive',  re: /\/google ?drive(\/|$)/ },
    { name: 'iCloud Drive',  re: /\/icloud ?drive(\/|$)/ },
    { name: 'Box',           re: /\/box sync(\/|$)/ },
  ];
  for (const { name, re } of patterns) if (re.test(normalized)) return name;
  return null;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  // Default to loopback so the unauthenticated API + destructive submit
  // endpoints aren't exposed to other hosts on the network. Set HOST=0.0.0.0
  // explicitly only when you intend to expose it (e.g. SSH tunnel demo).
  host: process.env.HOST || '127.0.0.1',
  // Binding anywhere other than loopback exposes the UNAUTHENTICATED,
  // destructive API to the network. Require an explicit opt-in so it can
  // never happen by a stray HOST=0.0.0.0 alone (review hardening).
  allowNonLoopback: process.env.ALLOW_NON_LOOPBACK === '1',
  openBrowser: process.env.OPEN_BROWSER !== '0',

  // ─── Paths ─────────────────────────────────────────────────────────
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'state.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
  outputDir: process.env.OUTPUT_DIR || path.join(dataDir, 'output'),

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

  // SQLite page cache. Larger = fewer disk I/Os during expansion + planning.
  // Each MB covers ~256 4 KB pages. Recommended values (set via SQLITE_CACHE_MB):
  //   16 GB laptop  →  1024   (1 GB)
  //   32 GB laptop  →  8192   (8 GB — entire B-tree fits in RAM)
  //   dedicated server →  2048  (2 GB baseline; tune up with available RAM)
  // Default 512 MB is safe for any machine with ≥4 GB RAM.
  sqliteCacheMb: Number(process.env.SQLITE_CACHE_MB) || 512,

  identityBatchSize: Number(process.env.IDENTITY_BATCH_SIZE) || 1000,
  identityConcurrency: Number(process.env.IDENTITY_CONCURRENCY) || 10,
  workOrderConcurrency: Number(process.env.WORK_ORDER_CONCURRENCY) || 2,
  maxIdsPerWorkOrder: Number(process.env.MAX_IDS_PER_WORK_ORDER) || 100_000,
  dailyIdentifierLimit: Number(process.env.DAILY_IDENTIFIER_LIMIT) || 1_000_000,
  // Monthly identifier cap is contract-dependent. Default 3M/month matches
  // the typical base Data Hygiene entitlement; override via env or the Config
  // tab to match your contract. Set to 0 to disable monthly tracking.
  monthlyIdentifierLimit: numEnv('MONTHLY_IDENTIFIER_LIMIT', 3_000_000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 60_000,

  // ─── Security ──────────────────────────────────────────────────────
  // 32-byte hex key used to encrypt client secrets at rest. Auto-generated
  // and stored in data/ on first run if not provided. Don't commit this.
  encryptionKey: process.env.ENCRYPTION_KEY,
};
