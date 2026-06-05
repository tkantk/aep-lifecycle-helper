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

// Resolve a numeric env var, PRESERVING an explicit 0 (the naive `|| default`
// wrongly turns 0 back into the default). Empty/unset/NaN → fallback.
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
  // Default 5 (conservative) after the 2026-05-29 rate-limit incident where a
  // higher value drew sustained 429 Retry-After waits from Adobe's Identity
  // Service. Raise toward 10–15 only if you observe zero 429s for your org.
  identityConcurrency: Number(process.env.IDENTITY_CONCURRENCY) || 5,
  workOrderConcurrency: Number(process.env.WORK_ORDER_CONCURRENCY) || 2,
  maxIdsPerWorkOrder: Number(process.env.MAX_IDS_PER_WORK_ORDER) || 100_000,
  dailyIdentifierLimit: Number(process.env.DAILY_IDENTIFIER_LIMIT) || 1_000_000,
  // Monthly identifier cap — FALLBACK ONLY (live Adobe /quota wins). Adobe
  // always enforces a monthly cap, so there is no "disable monthly" option
  // (review R4 #4); a 0 is coerced to the 3M default, never "unlimited".
  monthlyIdentifierLimit: numEnv('MONTHLY_IDENTIFIER_LIMIT', 3_000_000) || 3_000_000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 60_000,

  // Destructive-submit /quota preflight retry (2026-06-01 flaky-network prod
  // incident). adobeClient does NOT retry timeouts on a GET, so a single slow
  // /quota call would block the submit on a stale snapshot. These give the
  // preflight a few coarse retries with linear backoff so an INTERMITTENT
  // timeout self-heals into a fresh snapshot instead of stalling the operator.
  quotaPreflightAttempts: Number(process.env.QUOTA_PREFLIGHT_ATTEMPTS) || 3,
  quotaPreflightRetryDelayMs: Number(process.env.QUOTA_PREFLIGHT_RETRY_DELAY_MS) || 2000,

  // Fraction (0..0.95) of each Adobe quota held back as headroom for CONCURRENT
  // EXTERNAL writers (review R6 #3). This tool's zero-over-ship guarantee covers
  // only ITS OWN accounting: Adobe `/quota` is ORG-WIDE and we snapshot it once
  // per submit run, so another UI user / API client / second helper instance in
  // the same org can consume quota between our snapshot and our submit, and we
  // can't see it until the next run. If you CANNOT guarantee this tool is the
  // only writer, set e.g. QUOTA_SAFETY_BUFFER=0.1 to reserve 10% as a margin.
  // Default 0 assumes operational exclusivity. Clamped to [0, 0.95] so a typo
  // can never drive the effective cap to zero-or-negative.
  quotaSafetyBuffer: Math.min(0.95, Math.max(0, numEnv('QUOTA_SAFETY_BUFFER', 0))),

  // ─── Security ──────────────────────────────────────────────────────
  // 32-byte hex key used to encrypt client secrets at rest. Auto-generated
  // and stored in data/ on first run if not provided. Don't commit this.
  encryptionKey: process.env.ENCRYPTION_KEY,

  // When the Identity Graph returns ZERO linked members across an ENTIRE fresh
  // expansion, that is the wrong-region / wrong-nsid / empty-graph fingerprint
  // and we fail closed (a source-only deletion would silently leave linked
  // identities alive — review finding #2). Set to 1 only when you have
  // deliberately confirmed the sources genuinely have no linked identities.
  allowEmptyGraph: process.env.ALLOW_EMPTY_GRAPH === '1',
};
