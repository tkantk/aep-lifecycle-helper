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
db.pragma('cache_size = -64000');    // 64 MB
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');

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
    -- Dedup key is (job, code-or-nsid, id). We prefer code in the key; if
    -- code is null we fall back to nsid so we still enforce uniqueness.
    CREATE TABLE IF NOT EXISTS expanded_identities (
      job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      ns_code         TEXT,
      ns_id           INTEGER,
      identity_id     TEXT NOT NULL,
      source_id       TEXT NOT NULL,                   -- the original hashedKocid that led us here
      discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One of ns_code or ns_id must be present; enforce at insert time.
    -- Unique constraint uses COALESCE to handle either-or:
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ei_unique
      ON expanded_identities(job_id, COALESCE(ns_code, ''), COALESCE(ns_id, 0), identity_id);
    CREATE INDEX IF NOT EXISTS idx_ei_job_source
      ON expanded_identities(job_id, source_id);
    CREATE INDEX IF NOT EXISTS idx_ei_job_ns
      ON expanded_identities(job_id, ns_code);

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
  ];
  for (const { table, column, type } of additiveColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      logger.info({ table, column }, 'schema migration applied');
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

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
    // Takes (job_id, ns_code, ns_id, identity_id, source_id)
    insertIdentity: db.prepare(`
      INSERT OR IGNORE INTO expanded_identities (job_id, ns_code, ns_id, identity_id, source_id)
      VALUES (?, ?, ?, ?, ?)
    `),
    countIdentitiesByNamespace: db.prepare(`
      SELECT COALESCE(ns_code, 'nsid:' || ns_id) AS namespace,
             COUNT(*) AS count
        FROM expanded_identities
       WHERE job_id = ?
       GROUP BY namespace
       ORDER BY count DESC
    `),
    // Iterate identities ordered by (source_id, ns_code) so cluster members
    // arrive contiguously; this lets the planner pack them together.
    streamIdentitiesBySource: db.prepare(`
      SELECT ns_code, ns_id, identity_id, source_id
        FROM expanded_identities
       WHERE job_id = ?
       ORDER BY source_id, ns_code
    `),

    // ─── Work orders ─────────────────────────────────────────────────
    insertWorkOrder: db.prepare(`
      INSERT INTO work_orders
        (id, job_id, day_index, dataset_ids, target_services_json,
         namespaces_identities, identifier_count, status)
      VALUES (@id, @jobId, @dayIndex, @datasetIds, @targetServicesJson,
              @namespacesIdentities, @identifierCount, @status)
    `),
    deletePlannedOrders: db.prepare(`DELETE FROM work_orders WHERE job_id = ? AND status = 'planned'`),
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
    listOpenWorkOrders: db.prepare(`
      SELECT w.*, j.creds_id AS j_creds_id, j.sandbox_name AS j_sandbox_name
        FROM work_orders w JOIN jobs j ON j.id = w.job_id
       WHERE w.adobe_workorder_id IS NOT NULL
         AND (w.adobe_status IS NULL OR w.adobe_status NOT IN ('completed','failed'))
       LIMIT 30
    `),
    countWorkOrdersByStatus: db.prepare(`
      SELECT status, COUNT(*) AS count FROM work_orders WHERE job_id = ? GROUP BY status
    `),

    // ─── Quota (daily) ────────────────────────────────────────────────
    getQuota: db.prepare(`SELECT used FROM quota_usage WHERE ims_org_id = ? AND utc_date = ?`),
    upsertQuota: db.prepare(`
      INSERT INTO quota_usage (ims_org_id, utc_date, used) VALUES (?, ?, ?)
      ON CONFLICT(ims_org_id, utc_date) DO UPDATE SET used = used + excluded.used
    `),
    decQuota: db.prepare(`
      UPDATE quota_usage SET used = MAX(0, used - ?) WHERE ims_org_id = ? AND utc_date = ?
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
 * Insert a batch of identities atomically.
 * Rows: Array<[job_id, ns_code, ns_id, identity_id, source_id]>
 * Returns count of NEW rows inserted (duplicates silently ignored).
 */
export function bulkInsertIdentities(rows) {
  const p = prepared();
  const tx = db.transaction((batch) => {
    let inserted = 0;
    for (const r of batch) {
      const result = p.insertIdentity.run(r[0], r[1], r[2], r[3], r[4]);
      inserted += result.changes;
    }
    return inserted;
  });
  return tx(rows);
}

export const q = () => prepared();
