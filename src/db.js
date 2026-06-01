import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './utils/logger.js';

/**
 * SQLite state store.
 *
 * WAL mode allows concurrent readers during long writes; NORMAL sync is
 * durable enough for a local helper. Batch inserts are wrapped in a
 * prepared-statement transaction — ~100k rows/sec sustained.
 */

// Ensure the DB's parent directory exists before opening the connection.
// ES-module imports are hoisted, so this file is evaluated before the
// top-level mkdir calls in src/index.js run. Without this, a fresh install
// (where data/ has never been created) would throw on the first `npm start`.
// In-memory (":memory:") paths have no parent directory — skip them.
if (config.dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// Negative cache_size = kilobytes; keeps B-tree pages hot during large expansion/planning.
// Override via SQLITE_CACHE_MB env var (see config.js for per-machine recommendations).
db.pragma(`cache_size = -${config.sqliteCacheMb * 1024}`);
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 8000'); // checkpoint every ~32 MB instead of default ~4 MB

export function initDb() {
  db.exec(`
    -- ─── Credentials (encrypted client secrets) ─────────────────────
    CREATE TABLE IF NOT EXISTS credentials (
      id                TEXT PRIMARY KEY,
      label             TEXT NOT NULL,
      environment       TEXT NOT NULL,
      region            TEXT NOT NULL,
      ims_org_id        TEXT NOT NULL,
      client_id         TEXT NOT NULL,
      client_secret_enc BLOB NOT NULL,
      client_secret_iv  BLOB NOT NULL,
      client_secret_tag BLOB NOT NULL,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at      TEXT,
      UNIQUE (environment, ims_org_id, client_id)
    );

    -- ─── Per-sandbox config (cached sandboxes/datasets/namespaces) ──
    -- Populated when the user picks a credential + sandbox in the UI.
    -- Allows offline work (e.g. inspecting a past job) without re-hitting
    -- Adobe for every page load.
    CREATE TABLE IF NOT EXISTS sandbox_configs (
      creds_id          TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      sandbox_name      TEXT NOT NULL,
      sandbox_title     TEXT,
      sandbox_type      TEXT,
      sandbox_region    TEXT,
      datasets_json     TEXT,                           -- cached list of Identity-enabled datasets
      namespaces_json   TEXT,                           -- cached namespace registry
      refreshed_at      TEXT,
      PRIMARY KEY (creds_id, sandbox_name)
    );

    -- ─── Jobs ────────────────────────────────────────────────────────
    -- dataset_ids: comma-separated list of dataset ids, or "ALL"
    -- target_services_json: JSON array or NULL (profile-only mode)
    CREATE TABLE IF NOT EXISTS jobs (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'created',
      creds_id            TEXT NOT NULL REFERENCES credentials(id),
      sandbox_name        TEXT NOT NULL,
      dataset_ids         TEXT NOT NULL,                -- "ALL" | "id1,id2,..."
      target_services_json TEXT,
      source_namespace    TEXT NOT NULL DEFAULT 'hashedKocid',
      source_namespace_id INTEGER,                      -- numeric nsid if known
      source_column       TEXT NOT NULL DEFAULT '0',    -- CSV column (0-based index OR header name) chosen at upload
      daily_limit         INTEGER NOT NULL DEFAULT 1000000,
      upload_path         TEXT,
      total_source_ids    INTEGER NOT NULL DEFAULT 0,
      processed_count     INTEGER NOT NULL DEFAULT 0,
      found_count         INTEGER NOT NULL DEFAULT 0,
      graph_members_seen  INTEGER NOT NULL DEFAULT 0,  -- cumulative linked members Adobe returned (review #2 empty-graph fail-closed; survives crash/resume)
      planned_orders      INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

    -- ─── Expanded identities ────────────────────────────────────────
    -- Stores both namespace CODE and numeric ID when available.
    -- No unique index — dedup is deferred to planning time via GROUP BY in
    -- streamIdentitiesBySource. This allows O(1) batch inserts during expansion
    -- instead of O(log n) B-tree lookups that degrade progressively on large jobs
    -- (8M rows → ~400 MB index pages, each lookup requiring multiple disk reads
    -- when pages spill out of cache). Correctness is preserved:
    --   • The planner GROUP BY emits one row per (ns, identity, source) triplet.
    --   • normalizeNamespacesIdentities in hygiene.js deduplicates ids[] within
    --     each namespace group before the Adobe POST.
    CREATE TABLE IF NOT EXISTS expanded_identities (
      job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ns_code         TEXT,
      ns_id           INTEGER,
      identity_id     TEXT NOT NULL,
      source_id       TEXT NOT NULL,                   -- the original hashedKocid that led us here
      discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ei_job_source
      ON expanded_identities(job_id, source_id);
    -- Note: a secondary index idx_ei_job_ns(job_id, ns_code) existed previously.
    -- EXPLAIN QUERY PLAN showed all reads (countIdentitiesByNamespace,
    -- streamIdentitiesBySource, countDistinctIdentities) fall back to
    -- idx_ei_job_source with an identical plan when ns_code-keyed index is
    -- absent, so it was redundant — same job_id-leading SEARCH + TEMP B-TREE
    -- for GROUP BY in both cases. Dropping it saved one B-tree to maintain
    -- per insert (~5-10% faster expansion on million-row jobs) and ~144 MB
    -- disk on a 6M-row table. Migration below drops it on existing DBs.

    -- ─── Work orders ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS work_orders (
      id                      TEXT PRIMARY KEY,
      job_id                  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      day_index               INTEGER NOT NULL,
      dataset_ids             TEXT,                     -- inherited from job, but can be overridden
      target_services_json    TEXT,
      namespaces_identities   TEXT NOT NULL,            -- JSON payload: [{namespace:{code,id}, ids:[...]}]
      identifier_count        INTEGER NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'planned',
      adobe_workorder_id      TEXT,
      adobe_status            TEXT,
      bundle_id               TEXT,
      product_status_details  TEXT,
      last_error              TEXT,
      submitted_at            TEXT,
      completed_at            TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wo_job ON work_orders(job_id);
    CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_wo_adobe ON work_orders(adobe_workorder_id);
    CREATE INDEX IF NOT EXISTS idx_wo_job_day_status ON work_orders(job_id, day_index, status);

    -- ─── Daily quota ledger ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS quota_usage (
      ims_org_id  TEXT NOT NULL,
      utc_date    TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      -- Adobe's observed org-wide consumed (set by seedFloor). Tracked
      -- SEPARATELY from the used column (our reservations) so a release can
      -- never drop the ledger below Adobe's reality and let a later reserve
      -- over-ship (review #3). used is always kept >= adobe_floor.
      adobe_floor INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ims_org_id, utc_date)
    );

    -- ─── Monthly quota ledger ───────────────────────────────────────
    -- Adobe Data Hygiene contracts impose monthly identifier caps in addition
    -- to the daily cap. Rolls over at UTC 1st of each month by virtue of the
    -- year_month (YYYY-MM) being part of the composite key.
    CREATE TABLE IF NOT EXISTS quota_usage_monthly (
      ims_org_id      TEXT NOT NULL,
      utc_year_month  TEXT NOT NULL,   -- 'YYYY-MM' (e.g. '2026-04')
      used            INTEGER NOT NULL DEFAULT 0,
      adobe_floor     INTEGER NOT NULL DEFAULT 0,   -- see quota_usage (review #3)
      PRIMARY KEY (ims_org_id, utc_year_month)
    );

    -- ─── Per-work-order quota reservations (review R4 #1, R5 lifecycle) ───
    -- The aggregate quota_usage.used counter conflated OUR reservations with
    -- Adobe's observed floor, so a delayed release could mis-account (lose
    -- ownership / cross-day). This table records ONE row per reserved work
    -- order with its own period keys. effective_used(period) = adobe_floor(period)
    --   + SUM(count) of ACTIVE reservations in that period.
    --   active=1: reserved / held (counts toward effective).
    --   active=0: released — Adobe did NOT process it (4xx / durability-fail /
    --             operator release-absent R7 #1; recovery never auto-releases).
    --
    -- accepted (R5): 0 = pending (committed locally, Adobe has not acked); 1 =
    -- Adobe ACKED the POST and has spent the quota. An accepted reservation is
    -- NEVER released (release() is guarded WHERE accepted=0) and is NEVER dropped
    -- mid-period — it is HELD until the UTC day/month rolls over (Adobe's counter
    -- resets then too), at which point it auto-expires because the period-keyed
    -- SUM no longer matches it. The R4.1 deactivate-on-terminal and every
    -- timer/floor-delta "assimilation drop" were proven to over-ship under a
    -- concurrent external Adobe consumer (the org-wide /quota gives no per-tool
    -- attribution), so there is deliberately NO mid-period drop. Over-defer
    -- (holding slightly too long) is the SAFE direction and self-corrects at
    -- rollover; over-ship is irreversible.
    CREATE TABLE IF NOT EXISTS quota_reservations (
      work_order_id   TEXT PRIMARY KEY,
      ims_org_id      TEXT NOT NULL,
      utc_date        TEXT NOT NULL,
      utc_year_month  TEXT NOT NULL,
      count           INTEGER NOT NULL,
      active          INTEGER NOT NULL DEFAULT 1,
      accepted        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_qr_org_date  ON quota_reservations(ims_org_id, utc_date, active);
    CREATE INDEX IF NOT EXISTS idx_qr_org_month ON quota_reservations(ims_org_id, utc_year_month, active);

    -- ─── App-global settings (Phase 3, 2026-05-15) ──────────────────
    -- Generic key/value bag for settings that aren't tied to a credential
    -- or a job. Initial users:
    --   auto_resume_enabled        'true' | 'false'
    --   auto_resume_local_time     'HH:MM' (24-hour, operator's local timezone)
    --   auto_resume_days           'every-day' | 'weekdays' | 'first-of-month'
    --   auto_resume_last_run_at    ISO-8601 timestamp of the most recent fire
    --   auto_resume_last_run_summary  JSON: { jobsProcessed, totalSubmitted, ... }
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ─── Additive migrations for existing DBs ─────────────────────────────
  // These run on every boot. SQLite's ALTER TABLE ADD COLUMN is additive only
  // (can't drop or rename), so we wrap each in try/catch and swallow only the
  // "duplicate column" error — any other failure is real and should surface.
  const additiveColumns = [
    { table: 'jobs', column: 'monthly_limit', type: 'INTEGER' },
    { table: 'jobs', column: 'last_checkpoint_at', type: 'TEXT' },
    { table: 'credentials', column: 'client_name', type: 'TEXT' },
    // Phase 2 (2026-05-15) — month-aware planner / re-bucketer.
    // work_orders.month_index: which 1-indexed quota month a planned/deferred
    //   WO falls into. Shipped WOs keep their historical value. Computed by
    //   `redistributeUnshippedOrders` against live Adobe /quota numbers and
    //   updated on every plan + submit run.
    // jobs.projected_months: last redistribute's max month_index for this job —
    //   used to detect "plan extended" shifts so the UI can show a toast
    //   (≤1mo) or a modal (≥2mo). Nullable until the first redistribute runs.
    { table: 'work_orders', column: 'month_index', type: 'INTEGER' },
    { table: 'jobs',        column: 'projected_months', type: 'INTEGER' },
    // Review blocker #4 (2026-05-31): persist the CSV source column chosen at
    // upload so crash-recovery resumes against the SAME column. Without this,
    // recovery hardcoded column 0 and could expand identifiers the operator
    // never selected. Default '0' keeps legacy rows (and the single-column
    // common case) correct.
    { table: 'jobs',        column: 'source_column', type: "TEXT NOT NULL DEFAULT '0'" },
    // Review finding #9: a poll cursor so the monitor rotates fairly through
    // ALL open work orders instead of re-polling the first 100 by rowid every
    // tick (which starved order #101+ on large jobs). NULL = never polled.
    { table: 'work_orders', column: 'last_polled_at', type: 'TEXT' },
    // (R2's work_orders.reserved_monthly migration was removed in R4 — the
    // per-WO quota_reservations table replaced the reserved_monthly approach.)
    // Review #2 (R2): cumulative count of linked members the Identity Graph
    // returned for the job. Persisted (not just run-local) so the empty-graph
    // fail-closed check is correct across a crash + resume.
    { table: 'jobs', column: 'graph_members_seen', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Review #3 (R3): Adobe's observed floor, tracked separately from `used`.
    { table: 'quota_usage',         column: 'adobe_floor', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'quota_usage_monthly', column: 'adobe_floor', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Review R5: pending(0) vs Adobe-accepted(1). A pre-R5 quota_reservations
    // row gets DEFAULT 0, then the backfill below promotes legacy in-flight rows
    // to accepted=1 so release()'s guard can't refund Adobe-processed work.
    { table: 'quota_reservations',  column: 'accepted', type: 'INTEGER NOT NULL DEFAULT 0' },
    // Review R6 #2: the EXACT displayName sent to Adobe (UUID-first, ≤255),
    // persisted durably BEFORE the POST so orphan recovery matches Adobe's stored
    // value exactly instead of reconstructing it (a long job name truncated at
    // 255 used to drop the trailing UUID → orphan invisible → duplicate on
    // resubmit). NULL for legacy rows; recovery falls back to reconstruction.
    { table: 'work_orders', column: 'display_name', type: 'TEXT' },
  ];
  for (const { table, column, type } of additiveColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info({ table, column }, 'schema migration applied');
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

  // ─── One-time conservative quota backfills (idempotent; review R5) ──────
  // (1) Finding #3 — preserve a pre-R4 DB's held usage. The old aggregate model
  //     stored consumption in `used` (now vestigial) with adobe_floor=0; the R5
  //     model reads ONLY adobe_floor. Fold used→adobe_floor (MAX-equivalent via
  //     the WHERE guard; the floor only ever rises) so an upgrade can't silently
  //     drop a conservative hold during Adobe's /quota lag window.
  db.exec(`UPDATE quota_usage         SET adobe_floor = used WHERE used > adobe_floor`);
  db.exec(`UPDATE quota_usage_monthly SET adobe_floor = used WHERE used > adobe_floor`);
  // (2) Synthesis must-fix — a pre-R5 active reservation whose work order had
  //     already reached Adobe (status past the never-sent set) must be marked
  //     accepted=1; otherwise release()'s `WHERE accepted=0` guard would refund
  //     a reservation Adobe is actively processing → over-ship + duplicate.
  db.exec(`
    UPDATE quota_reservations SET accepted = 1
     WHERE active = 1 AND accepted = 0
       AND work_order_id IN (
         SELECT id FROM work_orders
          WHERE status NOT IN ('planned','deferred','awaiting_approval')
       )
  `);

  // Drop the old unique index on expanded_identities if it still exists on an
  // existing DB. Dedup is now deferred to planning time (GROUP BY in
  // streamIdentitiesBySource), eliminating the O(log n) B-tree lookup on every
  // insert that caused progressive slowdown on large jobs (>1M source IDs).
  db.exec('DROP INDEX IF EXISTS idx_ei_unique');

  // Drop the redundant (job_id, ns_code) index on existing DBs. See the schema
  // CREATE block above for the rationale — EXPLAIN QUERY PLAN proved every
  // reader falls back to idx_ei_job_source with the same plan. Removing it
  // speeds up inserts (one fewer B-tree to maintain) and reclaims disk.
  db.exec('DROP INDEX IF EXISTS idx_ei_job_ns');

  logger.info({ path: config.dbPath }, 'SQLite initialized');
}

// ─── Prepared statements ────────────────────────────────────────────────
let stmts = null;
function prepared() {
  if (stmts) return stmts;
  stmts = {
    // ─── Credentials ─────────────────────────────────────────────────
    insertCred: db.prepare(`
      INSERT INTO credentials
        (id, label, client_name, environment, region, ims_org_id, client_id,
         client_secret_enc, client_secret_iv, client_secret_tag)
      VALUES (@id, @label, @clientName, @environment, @region, @imsOrgId, @clientId, @enc, @iv, @tag)
      ON CONFLICT (environment, ims_org_id, client_id) DO UPDATE SET
        client_secret_enc = excluded.client_secret_enc,
        client_secret_iv  = excluded.client_secret_iv,
        client_secret_tag = excluded.client_secret_tag,
        label = excluded.label,
        client_name = excluded.client_name,
        region = excluded.region
    `),
    getCred: db.prepare('SELECT * FROM credentials WHERE id = ?'),
    findCred: db.prepare(`SELECT id FROM credentials WHERE environment = ? AND ims_org_id = ? AND client_id = ?`),
    listCreds: db.prepare(`
      SELECT id, label, client_name, environment, region, ims_org_id, client_id, created_at, last_used_at
        FROM credentials ORDER BY last_used_at DESC NULLS LAST, created_at DESC
    `),
    touchCred: db.prepare(`UPDATE credentials SET last_used_at = datetime('now') WHERE id = ?`),
    deleteCred: db.prepare('DELETE FROM credentials WHERE id = ?'),
    countJobsForCred: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE creds_id = ?`),
    // Update non-secret, non-identity fields. Identity fields (environment,
    // ims_org_id, client_id) define the row's UNIQUE key — changing them =
    // a different credential, handled via insertCred's ON CONFLICT path,
    // not via PATCH.
    updateCredFields: db.prepare(`
      UPDATE credentials
         SET label = @label,
             client_name = @clientName,
             region = @region
       WHERE id = @id
    `),

    // ─── Sandbox configs ─────────────────────────────────────────────
    upsertSandboxConfig: db.prepare(`
      INSERT INTO sandbox_configs
        (creds_id, sandbox_name, sandbox_title, sandbox_type, sandbox_region,
         datasets_json, namespaces_json, refreshed_at)
      VALUES (@credsId, @sandboxName, @sandboxTitle, @sandboxType, @sandboxRegion,
              @datasetsJson, @namespacesJson, datetime('now'))
      ON CONFLICT (creds_id, sandbox_name) DO UPDATE SET
        sandbox_title   = excluded.sandbox_title,
        sandbox_type    = excluded.sandbox_type,
        sandbox_region  = excluded.sandbox_region,
        datasets_json   = COALESCE(excluded.datasets_json, sandbox_configs.datasets_json),
        namespaces_json = COALESCE(excluded.namespaces_json, sandbox_configs.namespaces_json),
        refreshed_at    = datetime('now')
    `),
    getSandboxConfig: db.prepare(`
      SELECT * FROM sandbox_configs WHERE creds_id = ? AND sandbox_name = ?
    `),
    listSandboxConfigs: db.prepare(`
      SELECT * FROM sandbox_configs WHERE creds_id = ? ORDER BY sandbox_name
    `),

    // ─── Jobs ────────────────────────────────────────────────────────
    insertJob: db.prepare(`
      INSERT INTO jobs
        (id, name, creds_id, sandbox_name, dataset_ids, target_services_json,
         source_namespace, source_namespace_id, daily_limit, monthly_limit,
         upload_path, total_source_ids)
      VALUES (@id, @name, @credsId, @sandboxName, @datasetIds, @targetServicesJson,
              @sourceNamespace, @sourceNamespaceId, @dailyLimit, @monthlyLimit,
              @uploadPath, @totalSourceIds)
    `),
    // Persist the upload-time source column separately so insertJob's param
    // contract (and its many call sites) stays untouched. Stored as TEXT
    // because the column may be a 0-based index OR a header name.
    setJobSourceColumn: db.prepare('UPDATE jobs SET source_column = ? WHERE id = ?'),
    // Persist a submission preflight/run error on the job WITHOUT changing its
    // status, so a fire-and-forget submit failure (e.g. quota_unavailable) is
    // observable by the UI instead of only logged (review finding #10).
    setJobError: db.prepare(`UPDATE jobs SET last_error = ?, updated_at = datetime('now') WHERE id = ?`),
    getJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    listJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?'),
    // Monitor-tab feed: jobs that have at least one Adobe-acked work order,
    // enriched with aggregate counts and the most recent work-order activity.
    // Sort priority: jobs with at least one in-flight work order come FIRST
    // (operators care most about pending work), then by latest WO activity
    // DESC. Without the in-flight-first sort, a recently-completed job can
    // push a still-in-flight one off the visible list.
    // Filters: pass '' for no filter on @search or @sandbox.
    listMonitorJobs: db.prepare(`
      SELECT
        j.*,
        COUNT(*) FILTER (WHERE w.adobe_workorder_id IS NOT NULL) AS submitted_count,
        COUNT(*) FILTER (WHERE w.adobe_workorder_id IS NOT NULL
                           AND (w.adobe_status IS NULL
                                OR w.adobe_status NOT IN ('completed','failed'))) AS in_flight_count,
        COUNT(*) FILTER (WHERE w.adobe_status = 'completed')                  AS completed_count,
        COUNT(*) FILTER (WHERE w.adobe_status = 'failed')                     AS adobe_failed_count,
        SUM(CASE WHEN w.adobe_workorder_id IS NOT NULL
                 THEN w.identifier_count ELSE 0 END)                          AS submitted_ids,
        MAX(w.updated_at)                                                     AS latest_activity_at,
        MAX(w.day_index)                                                      AS max_day
      FROM jobs j
      INNER JOIN work_orders w ON w.job_id = j.id
      WHERE w.adobe_workorder_id IS NOT NULL
        AND (@search = '' OR LOWER(j.name) LIKE '%' || LOWER(@search) || '%')
        AND (@sandbox = '' OR j.sandbox_name = @sandbox)
      GROUP BY j.id
      ORDER BY (in_flight_count > 0) DESC, latest_activity_at DESC
      LIMIT @limit
    `),
    // Dashboard-level totals across ALL monitor-eligible jobs matching the
    // search + sandbox filter (NOT capped by limit). Each job is in exactly
    // one bucket: in_flight (≥1 in-flight WO), has_failed (no in-flight but
    // at least one failed WO), or all_completed (no in-flight, no failed).
    monitorTotals: db.prepare(`
      SELECT
        SUM(CASE WHEN sub.in_flight_count > 0                              THEN 1 ELSE 0 END) AS in_flight,
        SUM(CASE WHEN sub.in_flight_count = 0
                      AND sub.adobe_failed_count > 0                       THEN 1 ELSE 0 END) AS has_failed,
        SUM(CASE WHEN sub.in_flight_count = 0
                      AND sub.adobe_failed_count = 0                       THEN 1 ELSE 0 END) AS all_completed,
        COUNT(*) AS total
      FROM (
        SELECT j.id,
               COUNT(*) FILTER (WHERE w.adobe_workorder_id IS NOT NULL
                                  AND (w.adobe_status IS NULL
                                       OR w.adobe_status NOT IN ('completed','failed'))) AS in_flight_count,
               COUNT(*) FILTER (WHERE w.adobe_status = 'failed') AS adobe_failed_count
        FROM jobs j
        INNER JOIN work_orders w ON w.job_id = j.id
        WHERE w.adobe_workorder_id IS NOT NULL
          AND (@search = '' OR LOWER(j.name) LIKE '%' || LOWER(@search) || '%')
          AND (@sandbox = '' OR j.sandbox_name = @sandbox)
        GROUP BY j.id
      ) sub
    `),
    // Distinct sandboxes among monitor-eligible jobs, with per-sandbox job
    // count. Drives the sandbox filter chip row. Honors the search filter
    // (so a chip count reflects what would show if the chip were clicked
    // while the search is active) but NOT a sandbox filter — the chips ARE
    // the sandbox filter.
    monitorSandboxes: db.prepare(`
      SELECT j.sandbox_name AS name, COUNT(DISTINCT j.id) AS count
        FROM jobs j
        INNER JOIN work_orders w ON w.job_id = j.id
       WHERE w.adobe_workorder_id IS NOT NULL
         AND (@search = '' OR LOWER(j.name) LIKE '%' || LOWER(@search) || '%')
       GROUP BY j.sandbox_name
       ORDER BY j.sandbox_name
    `),
    updateJobStatus: db.prepare(`
      UPDATE jobs SET status = ?, updated_at = datetime('now'), last_error = ? WHERE id = ?
    `),
    incrementJobCounters: db.prepare(`
      UPDATE jobs
         SET processed_count    = processed_count + ?,
             found_count        = found_count + ?,
             graph_members_seen = graph_members_seen + ?,
             updated_at         = datetime('now')
       WHERE id = ?
    `),
    setPlannedOrders: db.prepare(`UPDATE jobs SET planned_orders = ?, updated_at = datetime('now') WHERE id = ?`),

    // ─── Identities ──────────────────────────────────────────────────
    // Takes (job_id, ns_code, ns_id, identity_id, source_id).
    // Plain INSERT (no OR IGNORE) — dedup is deferred to planning time via
    // GROUP BY in streamIdentitiesBySource, avoiding the O(log n) B-tree
    // lookup on the old unique index that degraded on multi-million-row jobs.
    insertIdentity: db.prepare(`
      INSERT INTO expanded_identities (job_id, ns_code, ns_id, identity_id, source_id)
      VALUES (?, ?, ?, ?, ?)
    `),
    // Dedup matches the old unique-index semantics: (ns_code, ns_id, identity_id)
    // without source_id. The outer GROUP BY namespace collapses the deduplicated
    // rows into per-namespace counts.
    countIdentitiesByNamespace: db.prepare(`
      SELECT COALESCE(ns_code, 'nsid:' || ns_id) AS namespace, COUNT(*) AS count
        FROM (
          SELECT ns_code, ns_id, identity_id
            FROM expanded_identities WHERE job_id = ?
           GROUP BY COALESCE(ns_code, ''), COALESCE(ns_id, 0), identity_id
        )
       GROUP BY COALESCE(ns_code, 'nsid:' || ns_id)
       ORDER BY count DESC
    `),
    // NOTE: this query is NOT cached in `q().streamIdentitiesBySource` because
    // better-sqlite3 allows only one active iterator per Statement object.
    // The planner (sync) and the /export route (async, holds the iterator
    // across event-loop yields) would collide on a shared cached statement
    // and throw "This statement is busy executing a query". Each caller
    // must `prepareStreamIdentitiesBySource()` to get its own Statement.
    // See the exported factory below.
    // Count of globally distinct (ns, identity) pairs — used after expansion
    // completes to overwrite the running found_count with the true deduplicated
    // total (matching the old unique-index semantics).
    countDistinctIdentities: db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT DISTINCT COALESCE(ns_code, ''), COALESCE(ns_id, 0), identity_id
          FROM expanded_identities WHERE job_id = ?
      ) sub
    `),
    setFoundCount: db.prepare(`
      UPDATE jobs SET found_count = ?, updated_at = datetime('now') WHERE id = ?
    `),

    // ─── Work orders ─────────────────────────────────────────────────
    insertWorkOrder: db.prepare(`
      INSERT INTO work_orders
        (id, job_id, day_index, dataset_ids, target_services_json,
         namespaces_identities, identifier_count, status)
      VALUES (@id, @jobId, @dayIndex, @datasetIds, @targetServicesJson,
              @namespacesIdentities, @identifierCount, @status)
    `),
    // Clears every un-shipped status before a re-plan. MUST include 'deferred':
    // a deferred WO that survives a re-plan plus the freshly re-emitted planned
    // WO both cover the same identities, so the next submit would ship BOTH —
    // a duplicate irreversible delete (review blocker #1). Deferred orders
    // never went to Adobe, so deleting + re-creating them is safe.
    deletePlannedOrders: db.prepare(`DELETE FROM work_orders WHERE job_id = ? AND status IN ('planned', 'awaiting_approval', 'deferred')`),
    // Mark WOs in Month 2+ as awaiting_approval after planning. These require
    // explicit operator sign-off before they become eligible for submission.
    // Month 1 (or NULL legacy rows) stays 'planned' and ships immediately on Submit.
    markFutureMonthsAwaitingApproval: db.prepare(`
      UPDATE work_orders
         SET status = 'awaiting_approval', updated_at = datetime('now')
       WHERE job_id = ? AND COALESCE(month_index, 1) > 1 AND status = 'planned'
    `),
    // Approve a specific month: flip awaiting_approval → planned so the
    // submission runner can pick them up on the next submit/scheduler run.
    approveMonth: db.prepare(`
      UPDATE work_orders
         SET status = 'planned', last_error = NULL, updated_at = datetime('now')
       WHERE job_id = ? AND COALESCE(month_index, 1) = ? AND status = 'awaiting_approval'
    `),
    // Order by SQLite rowid (insertion order) rather than the UUID primary key,
    // so the list reflects creation sequence instead of sorting lexicographically
    // by a random hex string. Includes 'deferred' rows so that re-running
    // submission after UTC midnight (or after a contract limit increase)
    // actually picks up quota-deferred work — without this, deferred rows
    // were stranded and the job appeared "complete".
    getPlannedOrders: db.prepare(`
      SELECT * FROM work_orders WHERE job_id = ? AND status IN ('planned','deferred') ORDER BY month_index NULLS FIRST, day_index, rowid
    `),
    getOrdersByDay: db.prepare(`
      SELECT * FROM work_orders WHERE job_id = ? AND day_index = ? ORDER BY rowid
    `),
    // Phase 2: same as getOrdersByDay but month-scoped. Both month_index and
    // day_index can be NULL on legacy rows; treat NULL as Month 1 / Day 1.
    getOrdersByMonthAndDay: db.prepare(`
      SELECT * FROM work_orders
       WHERE job_id = ?
         AND COALESCE(month_index, 1) = ?
         AND COALESCE(day_index, 1)   = ?
       ORDER BY rowid
    `),
    getAllOrdersForJob: db.prepare(`
      SELECT * FROM work_orders WHERE job_id = ? ORDER BY COALESCE(month_index, 1), day_index, rowid
    `),
    // Single WO scoped to its job — used by the operator "confirmed absent →
    // release & retry" action (review R7 #1) so a woId from a different job
    // can't be acted on.
    getWorkOrderByIdAndJob: db.prepare(`SELECT * FROM work_orders WHERE id = ? AND job_id = ?`),
    // Unshipped (planned + deferred) WOs in deterministic creation order.
    // The redistributor consumes this and updates each row's month/day index.
    getUnshippedOrdersForJob: db.prepare(`
      SELECT id, identifier_count, day_index, month_index, status
        FROM work_orders
       WHERE job_id = ? AND status IN ('planned','deferred')
       ORDER BY rowid
    `),
    setOrderMonthDay: db.prepare(`
      UPDATE work_orders SET month_index = ?, day_index = ?, updated_at = datetime('now') WHERE id = ?
    `),
    setProjectedMonths: db.prepare(`UPDATE jobs SET projected_months = ?, updated_at = datetime('now') WHERE id = ?`),
    updateWorkOrderStatus: db.prepare(`
      UPDATE work_orders SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?
    `),
    // Durable pre-POST checkpoint (review R6 #2): set status='submitting' AND the
    // exact displayName that will be sent to Adobe. COALESCE keeps an existing
    // display_name when @displayName is null (the legacy/no-name durable path).
    setWorkOrderSubmittingWithName: db.prepare(`
      UPDATE work_orders
         SET status = 'submitting', last_error = NULL,
             display_name = COALESCE(@displayName, display_name),
             updated_at = datetime('now')
       WHERE id = @id
    `),
    updateWorkOrderSubmitted: db.prepare(`
      UPDATE work_orders
         SET status = 'submitted',
             adobe_workorder_id = @adobeWorkorderId,
             adobe_status = @adobeStatus,
             bundle_id = @bundleId,
             submitted_at = @submittedAt,
             updated_at = datetime('now')
       WHERE id = @id
    `),
    updateWorkOrderAdobeStatus: db.prepare(`
      UPDATE work_orders
         SET adobe_status = ?,
             status = CASE WHEN ? IN ('completed','failed') THEN ? ELSE status END,
             product_status_details = ?,
             completed_at = CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE completed_at END,
             updated_at = datetime('now')
       WHERE id = ?
    `),
    // Oldest-polled (and never-polled) first, so every open WO is eventually
    // observed even when more than 100 are in flight (review finding #9 —
    // starvation). The monitor stamps last_polled_at on every attempt, so a
    // polled WO rotates to the back of the queue.
    listOpenWorkOrders: db.prepare(`
      SELECT w.*, j.creds_id AS j_creds_id, j.sandbox_name AS j_sandbox_name
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.adobe_workorder_id IS NOT NULL
         AND (w.adobe_status IS NULL OR w.adobe_status NOT IN ('completed','failed'))
       ORDER BY w.last_polled_at IS NOT NULL, w.last_polled_at, w.rowid
       LIMIT 100
    `),
    stampWorkOrderPolled: db.prepare(`UPDATE work_orders SET last_polled_at = datetime('now') WHERE id = ?`),
    countWorkOrdersByStatus: db.prepare(`
      SELECT status, COUNT(*) AS count FROM work_orders WHERE job_id = ? GROUP BY status
    `),
    // Hard-delete a job and everything that references it. The FK CASCADE on
    // expanded_identities + work_orders (set up in initDb above) removes the
    // dependent rows in the same statement, so this single DELETE collapses
    // potentially millions of rows. Caller is responsible for cleaning up
    // associated filesystem artefacts (uploaded CSV, exported CSV).
    deleteJob: db.prepare('DELETE FROM jobs WHERE id = ?'),
    // quota_reservations is keyed by work_order_id but NOT cascaded from jobs
    // (it has no job_id). Delete a job's reservations explicitly BEFORE the job
    // (the job-delete cascades the work_orders away). STATUS-AWARE (review R5 #2):
    // refund ONLY reservations that are already inactive OR whose WO never
    // reached Adobe (planned/deferred/awaiting_approval). An ACTIVE reservation
    // for a WO that WAS sent (submitting/submitted/terminal) is KEPT as a
    // tombstone — Adobe spent that quota, so refunding it would over-ship. The
    // tombstone survives the cascade (no FK) and expires at period rollover.
    deleteReservationsForJob: db.prepare(`
      DELETE FROM quota_reservations
       WHERE work_order_id IN (SELECT id FROM work_orders WHERE job_id = @jobId)
         AND ( active = 0
            OR work_order_id IN (
                 SELECT id FROM work_orders
                  WHERE job_id = @jobId AND status IN ('planned','deferred','awaiting_approval')
               ) )
    `),
    // Startup GC: drop ORPHAN reservations (no surviving work order) that no
    // longer count — inactive, OR whose monthly period has already rolled over
    // (a prior-month tombstone is already excluded from the current-month SUM,
    // so deleting it changes nothing). A CURRENT-month active tombstone is KEPT
    // (Adobe spent it; it must keep counting until rollover) (review R5 #2).
    gcOrphanReservations: db.prepare(`
      DELETE FROM quota_reservations
       WHERE work_order_id NOT IN (SELECT id FROM work_orders)
         AND (active = 0 OR utc_year_month < ?)
    `),

    // ─── Quota: Adobe-observed floor (per period) ─────────────────────
    // adobe_floor = org-wide consumed as observed by Adobe. Raised ONE way:
    //   • seedFloor → MAX(floor, live /quota consumed) — Adobe's ABSOLUTE
    //     observed value. Nothing else touches the floor: an accepted WO is held
    //     as an active reservation (NOT folded into the floor) until period
    //     rollover, so there is no additive bump and no double-count vs the MAX
    //     (review R5). (`used` is vestigial post-R4; reservations replace it.)
    getDailyFloor:   db.prepare(`SELECT adobe_floor FROM quota_usage WHERE ims_org_id = ? AND utc_date = ?`),
    getMonthlyFloor: db.prepare(`SELECT adobe_floor FROM quota_usage_monthly WHERE ims_org_id = ? AND utc_year_month = ?`),
    maxDailyFloor: db.prepare(`
      INSERT INTO quota_usage (ims_org_id, utc_date, used, adobe_floor) VALUES (?, ?, 0, ?)
      ON CONFLICT(ims_org_id, utc_date) DO UPDATE SET adobe_floor = MAX(adobe_floor, excluded.adobe_floor)
    `),
    maxMonthlyFloor: db.prepare(`
      INSERT INTO quota_usage_monthly (ims_org_id, utc_year_month, used, adobe_floor) VALUES (?, ?, 0, ?)
      ON CONFLICT(ims_org_id, utc_year_month) DO UPDATE SET adobe_floor = MAX(adobe_floor, excluded.adobe_floor)
    `),

    // ─── Quota: per-work-order reservations (review R4 #1, R5 lifecycle) ──
    // A (re-)reserve inserts/reactivates as PENDING (accepted=0): a deferred WO
    // retried, or a new WO, has not yet been acked by Adobe.
    upsertReservation: db.prepare(`
      INSERT INTO quota_reservations (work_order_id, ims_org_id, utc_date, utc_year_month, count, active, accepted)
        VALUES (@workOrderId, @imsOrgId, @utcDate, @utcMonth, @count, 1, 0)
      ON CONFLICT(work_order_id) DO UPDATE SET
        ims_org_id = excluded.ims_org_id, utc_date = excluded.utc_date,
        utc_year_month = excluded.utc_year_month, count = excluded.count, active = 1, accepted = 0
    `),
    // Adobe ACKED the POST — promote to accepted AND active so it can never be
    // released and is held until period rollover (review R5). active=1 is
    // defense-in-depth (review R8 #1): if a release somehow slipped in during the
    // in-flight window, a subsequent markAccepted re-activates the hold so the
    // ledger reflects the spend Adobe actually made — it never leaves an
    // Adobe-acked WO uncounted.
    markAcceptedReservation: db.prepare(`UPDATE quota_reservations SET active = 1, accepted = 1 WHERE work_order_id = ?`),
    // Release is GUARDED: only an un-accepted (pending) reservation can be
    // deactivated. Adobe-accepted work must never be refunded (review R5 #2).
    releaseReservation:    db.prepare(`UPDATE quota_reservations SET active = 0 WHERE work_order_id = ? AND accepted = 0`),
    // Recovery: a 'failed' WO that Adobe ACTUALLY processed → restore it AS
    // accepted (it spent quota and is held until rollover).
    reactivateReservation: db.prepare(`UPDATE quota_reservations SET active = 1, accepted = 1 WHERE work_order_id = ?`),
    getReservation: db.prepare(`SELECT * FROM quota_reservations WHERE work_order_id = ?`),
    sumActiveDaily: db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS s FROM quota_reservations
       WHERE ims_org_id = ? AND utc_date = ? AND active = 1
    `),
    sumActiveMonthly: db.prepare(`
      SELECT COALESCE(SUM(count), 0) AS s FROM quota_reservations
       WHERE ims_org_id = ? AND utc_year_month = ? AND active = 1
    `),

    // ─── Recovery (startup reconciliation) ────────────────────────────
    // Jobs stuck mid-expansion: process was killed while expansion was running.
    // Resumable — expansion.js skips already-processed source IDs on the
    // second pass via a set built from processedSourceIdsForJob.
    listExpandingJobs: db.prepare(`SELECT * FROM jobs WHERE status = 'expanding'`),
    processedSourceIdsForJob: db.prepare(`
      SELECT DISTINCT source_id FROM expanded_identities WHERE job_id = ?
    `),
    // Work orders stuck mid-submission: process was killed after quota reserve
    // but before (or during) the Adobe POST. Adobe may or may not have received
    // it — reconciliation queries Adobe and updates status accordingly.
    listSubmittingOrphanOrders: db.prepare(`
      SELECT w.*,
             j.creds_id      AS j_creds_id,
             j.sandbox_name  AS j_sandbox_name,
             j.name          AS j_name
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.status = 'submitting' AND w.adobe_workorder_id IS NULL
    `),
    // Per-job reconcilable orphans — includes both 'submitting' (uncertain
    // submit) and 'failed' (a timeout marked the WO failed even though Adobe
    // processed it). For 'failed' matches the caller re-activates the WO's
    // reservation (review R4 #1).
    listReconcilableOrphansForJob: db.prepare(`
      SELECT w.*,
             j.creds_id      AS j_creds_id,
             j.sandbox_name  AS j_sandbox_name,
             j.name          AS j_name
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.job_id = ?
         AND w.adobe_workorder_id IS NULL
         AND w.status IN ('submitting', 'failed')
    `),
    // (rollbackWorkOrderToPlanned was removed in R6 #1 — recovery never auto-rolls
    //  an uncertain orphan back to 'planned' because that risked a duplicate
    //  irreversible delete; a no-match is now INDETERMINATE, left in 'submitting'.)

    // ─── App settings (Phase 3) ────────────────────────────────────
    listAppSettingsByPrefix: db.prepare(
      `SELECT key, value FROM app_settings WHERE key LIKE ?`
    ),
    upsertAppSetting: db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    // Jobs with at least one un-shipped work order — the set the auto-resume
    // scheduler iterates on each tick. DISTINCT because one job has many WOs.
    listJobsWithUnshippedWOs: db.prepare(`
      SELECT DISTINCT j.id, j.name, j.sandbox_name, j.creds_id
        FROM jobs j
        JOIN work_orders w ON w.job_id = j.id
       WHERE w.status IN ('planned', 'deferred')
       ORDER BY j.created_at ASC
    `),
  };
  return stmts;
}

/**
 * Build a FRESH prepared Statement for iterating deduplicated identities by
 * source. Deliberately NOT cached — better-sqlite3 allows only one active
 * iterator per Statement, and we have two simultaneous-iterator scenarios:
 *
 *   • Planner (sync, completes in one pass — fine on its own)
 *   • CSV export route (async; .iterate() is held while writeCsv yields
 *     between rows). Two concurrent export requests, or one export + one
 *     plan, would collide on a shared cached Statement and throw
 *     "This statement is busy executing a query".
 *
 * Calling .prepare() is cheap (~ms); calling it per request eliminates the
 * collision entirely.
 *
 * Rows yielded: { ns_code, ns_id, identity_id, source_id }
 *   - Deduplicated on (COALESCE(ns_code,''), COALESCE(ns_id,0), identity_id)
 *     — same key the old unique index used.
 *   - source_id is the MIN over the dedup group — picks the earliest cluster
 *     as the identity's "home" for cluster-aware planner packing.
 */
export function prepareStreamIdentitiesBySource() {
  return db.prepare(`
    SELECT ns_code, ns_id, identity_id, MIN(source_id) AS source_id
      FROM expanded_identities
     WHERE job_id = ?
     GROUP BY COALESCE(ns_code, ''), COALESCE(ns_id, 0), identity_id
     ORDER BY MIN(source_id), ns_code
  `);
}

/**
 * Insert a batch of identities atomically.
 * Rows: Array<[job_id, ns_code, ns_id, identity_id, source_id]>
 * Returns the number of rows inserted (= rows.length; dedup is deferred to
 * planning time — see prepareStreamIdentitiesBySource and countDistinctIdentities).
 */
export function bulkInsertIdentities(rows) {
  const p = prepared();
  const tx = db.transaction((batch) => {
    for (const r of batch) p.insertIdentity.run(r[0], r[1], r[2], r[3], r[4]);
    return batch.length;
  });
  return tx(rows);
}

/**
 * Insert a batch of identity rows AND bump the job counters in ONE transaction
 * (review #1). The empty-graph fail-closed guard reads jobs.graph_members_seen,
 * and crash-recovery skips sources based on COMMITTED expanded_identities rows.
 * If the rows committed but the counter increment didn't (separate
 * transactions, crash in between), a resume would skip those sources, leave the
 * counter at 0, and the guard would be bypassed — marking a source-only job
 * 'expanded'. Binding both into one transaction makes that state impossible:
 * either the rows AND the counters commit, or neither does.
 *
 * @param {Array<[job_id, ns_code, ns_id, identity_id, source_id]>} rows
 * @param {number} sourcesProcessed  source IDs handled in this batch (→ processed_count)
 * @param {number} membersSeen       linked members Adobe returned (→ graph_members_seen)
 * @param {string} jobId
 * @returns {number} rows inserted (= rows.length)
 */
export function insertIdentitiesAndCount(rows, sourcesProcessed, membersSeen, jobId) {
  const p = prepared();
  const tx = db.transaction(() => {
    for (const r of rows) p.insertIdentity.run(r[0], r[1], r[2], r[3], r[4]);
    p.incrementJobCounters.run(sourcesProcessed, rows.length, membersSeen, jobId);
    return rows.length;
  });
  return tx();
}

export const q = () => prepared();

/**
 * Durably commit the submit-intent (status='submitting') BEFORE the
 * non-idempotent hygiene POST. If this write were lost to power loss, the WO
 * would revert to 'planned' on restart and could be resubmitted — a duplicate
 * irreversible delete (review #8).
 *
 * We keep synchronous=NORMAL globally for expansion throughput, and make ONLY
 * this one commit durable by flipping synchronous=FULL around it. In WAL mode,
 * synchronous=FULL fsyncs the WAL on commit, so this transition (and every
 * un-fsynced frame before it, including the preceding reserve) is flushed to
 * disk. Crucially this is NOT a wal_checkpoint — a checkpoint blocks on
 * concurrent readers (busy_timeout) and could freeze the whole single-threaded
 * server for the duration of a long CSV export (review #6). An fsync-on-commit
 * does not block on readers.
 *
 * Returns true on success; false (caller fails closed, does not POST) only if
 * the write itself errors.
 */
export function setWorkOrderSubmittingDurable(workOrderId, displayName = null) {
  const prev = db.pragma('synchronous', { simple: true });   // numeric (1 = NORMAL)
  try {
    db.pragma('synchronous = FULL');
    // Persist status='submitting' AND the exact displayName to be POSTed, so
    // orphan recovery can match Adobe's stored value even after a crash (R6 #2).
    prepared().setWorkOrderSubmittingWithName.run({ id: workOrderId, displayName });
    return true;
  } catch {
    return false;
  } finally {
    try { db.pragma(`synchronous = ${Number(prev) || 1}`); } catch { /* restore best-effort */ }
  }
}
