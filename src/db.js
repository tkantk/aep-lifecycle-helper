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
      PRIMARY KEY (ims_org_id, utc_year_month)
    );

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
    // Review finding #4 (R2): the EFFECTIVE monthly limit passed to reserve()
    // for this WO. NULL = monthly tracking was off at reserve time (or a
    // legacy/never-reserved row). Recovery releases using THIS value, not the
    // job row's monthly_limit, so reserve and release always agree on the
    // monthly dimension (no monthly-ledger leak on rollback).
    { table: 'work_orders', column: 'reserved_monthly', type: 'INTEGER' },
  ];
  for (const { table, column, type } of additiveColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info({ table, column }, 'schema migration applied');
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

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
         SET processed_count = processed_count + ?,
             found_count     = found_count + ?,
             updated_at      = datetime('now')
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
    // Records the effective monthly limit reserve() used for this WO (review
    // finding #4). Recovery reads it back to release the SAME dimensions.
    setReservedMonthly: db.prepare(`UPDATE work_orders SET reserved_monthly = ? WHERE id = ?`),
    countWorkOrdersByStatus: db.prepare(`
      SELECT status, COUNT(*) AS count FROM work_orders WHERE job_id = ? GROUP BY status
    `),
    // Hard-delete a job and everything that references it. The FK CASCADE on
    // expanded_identities + work_orders (set up in initDb above) removes the
    // dependent rows in the same statement, so this single DELETE collapses
    // potentially millions of rows. Caller is responsible for cleaning up
    // associated filesystem artefacts (uploaded CSV, exported CSV).
    deleteJob: db.prepare('DELETE FROM jobs WHERE id = ?'),

    // ─── Quota (daily) ────────────────────────────────────────────────
    getQuota: db.prepare(`SELECT used FROM quota_usage WHERE ims_org_id = ? AND utc_date = ?`),
    upsertQuota: db.prepare(`
      INSERT INTO quota_usage (ims_org_id, utc_date, used) VALUES (?, ?, ?)
      ON CONFLICT(ims_org_id, utc_date) DO UPDATE SET used = used + excluded.used
    `),
    decQuota: db.prepare(`
      UPDATE quota_usage SET used = MAX(0, used - ?) WHERE ims_org_id = ? AND utc_date = ?
    `),
    // Reconcile the daily ledger UP to Adobe's reported consumed (review
    // blocker #1). MAX (not +): never lowers a value, so it can't undo our own
    // just-reserved increments, and a lagging (lower) Adobe consumed leaves our
    // higher local value intact. Raising the floor to org-wide consumed makes
    // reserve() enforce Adobe's true remaining instead of just the full cap.
    upsertQuotaFloor: db.prepare(`
      INSERT INTO quota_usage (ims_org_id, utc_date, used) VALUES (?, ?, ?)
      ON CONFLICT(ims_org_id, utc_date) DO UPDATE SET used = MAX(used, excluded.used)
    `),

    // ─── Quota (monthly) ──────────────────────────────────────────────
    getMonthlyQuota: db.prepare(`SELECT used FROM quota_usage_monthly WHERE ims_org_id = ? AND utc_year_month = ?`),
    upsertMonthlyQuota: db.prepare(`
      INSERT INTO quota_usage_monthly (ims_org_id, utc_year_month, used) VALUES (?, ?, ?)
      ON CONFLICT(ims_org_id, utc_year_month) DO UPDATE SET used = used + excluded.used
    `),
    decMonthlyQuota: db.prepare(`
      UPDATE quota_usage_monthly SET used = MAX(0, used - ?) WHERE ims_org_id = ? AND utc_year_month = ?
    `),
    // Monthly counterpart of upsertQuotaFloor (review blocker #1).
    upsertMonthlyQuotaFloor: db.prepare(`
      INSERT INTO quota_usage_monthly (ims_org_id, utc_year_month, used) VALUES (?, ?, ?)
      ON CONFLICT(ims_org_id, utc_year_month) DO UPDATE SET used = MAX(used, excluded.used)
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
             j.name          AS j_name,
             j.monthly_limit AS j_monthly_limit
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.status = 'submitting' AND w.adobe_workorder_id IS NULL
    `),
    // Per-job reconcilable orphans — includes both 'submitting' (uncertain
    // submit) and 'failed' (e.g. previous-buggy-behaviour where a timeout
    // marked the WO failed and released quota even though Adobe processed
    // it). For 'failed' rows the caller needs to re-reserve quota if it
    // finds the WO in Adobe; for 'submitting' rows the quota was never
    // released, so no re-reservation is needed.
    listReconcilableOrphansForJob: db.prepare(`
      SELECT w.*,
             j.creds_id      AS j_creds_id,
             j.sandbox_name  AS j_sandbox_name,
             j.name          AS j_name,
             j.monthly_limit AS j_monthly_limit,
             j.daily_limit   AS j_daily_limit
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.job_id = ?
         AND w.adobe_workorder_id IS NULL
         AND w.status IN ('submitting', 'failed')
    `),
    rollbackWorkOrderToPlanned: db.prepare(`
      UPDATE work_orders SET status = 'planned', last_error = ?, updated_at = datetime('now')
       WHERE id = ?
    `),

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

export const q = () => prepared();

/**
 * Force the WAL to disk (fsync) so a just-committed transaction is durable
 * even under synchronous=NORMAL (review finding #8). We keep NORMAL globally
 * for expansion throughput, but the submit-intent transition
 * (reserve quota + status='submitting') MUST survive power loss: if it were
 * lost, the work order would revert to 'planned' on restart and could be
 * resubmitted to Adobe — a duplicate irreversible delete. Call this right
 * before the non-idempotent hygiene POST. Best-effort; a checkpoint failure
 * (e.g. a concurrent reader) is non-fatal and will be retried on the next
 * submit / shutdown checkpoint.
 */
export function durableCheckpoint() {
  // wal_checkpoint returns one row: { busy, log, checkpointed }. busy !== 0
  // means a reader blocked the checkpoint and the WAL was NOT fully flushed —
  // i.e. the commit is NOT yet durable, and SQLite does NOT throw for this
  // (review finding #5). Return whether durability was actually achieved so
  // the caller can fail closed instead of POSTing on an unverified intent.
  try {
    const res = db.pragma('wal_checkpoint(FULL)');
    const row = Array.isArray(res) ? res[0] : res;
    return !!row && Number(row.busy) === 0;
  } catch {
    return false;
  }
}
