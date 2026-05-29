# Changelog

Append-only log of changes to this project, organised by working session.
New entries go **at the top**. Each bullet should explain *what* changed and *why*,
with enough detail that a future contributor can reconstruct the decision.

Format: `## YYYY-MM-DD` session headers; bullets grouped under **Backend**,
**Frontend**, **Tests**, **Docs**, **Infra**. Reference file paths where useful.

---

## 2026-05-29 — Friendly errors for non-CSV uploads (MIP / XLSX / UTF-16)

User uploaded a CSV from a new machine and got a 500 with a fast-csv
stack trace: `Parse Error: expected: ',' OR new line got: 'q'. at
' q4uN����'`. The `����` (Unicode replacement chars) and stray `q4uN`
were the giveaway — the uploaded file wasn't actually plain-text CSV.
Most likely it was a Microsoft Information Protection (MIP) /
sensitivity-labelled file (common at Adobe for customer data), an
.xlsx wearing a .csv extension, or a UTF-16-encoded export.

### Backend (`src/utils/csv.js`, `src/routes/upload.js`)

- **New `sniffUpload(filePath)` helper** — reads the first 4 KiB of an
  upload and refuses obvious non-CSV payloads BEFORE fast-csv runs.
  Each verdict carries an operator-actionable reason string. Detected:
  - `kind: 'zip'`   — ZIP / XLSX magic (PK\\x03\\x04)
  - `kind: 'ole'`   — OLE compound (legacy .xls, some MIP-protected files)
  - `kind: 'pdf'`   — PDF magic
  - `kind: 'utf16'` — UTF-16 LE / BE BOM
  - `kind: 'binary'` — >5% non-printable bytes in the sniff window
  - `kind: 'empty'` — zero-byte file
  UTF-8 BOM is accepted (fast-csv handles it natively).
- **Pre-flight wiring** in the `/api/upload` POST handler: sniff first,
  return a clean 400 with `code = 'bad_upload_<kind>'` and the
  human-readable `publicMessage` if the verdict isn't ok. Reject files
  are unlinked from `data/uploads/` so they don't accumulate.
- **`streamIds()`** now catches fast-csv `Parse Error` and rethrows as a
  `csv_parse_error` 400 with the same friendly message. Belt-and-braces
  for any binary content that slipped past the sniffer.

### Tests (`test/security.test.js`)

- 6 new sniffer tests cover: plain UTF-8 CSV (accept), UTF-8 BOM (accept),
  ZIP/XLSX (reject with xlsx hint), UTF-16 LE (reject), high-binary
  content (reject as MIP-encrypted / corrupt), empty file (reject).
- 179 → 185 tests pass.

---

## 2026-05-29 — UI button debounce + concurrency audit

Follow-up to the statement-busy fix earlier today. The server side is now
collision-safe; this lands the UI side so a rapid double-click can't trigger
duplicate destructive requests in the first place.

### Frontend (`src/web/app.js`)

- **`onClickGuarded(btn, handler, opts)` helper.** Wraps an async click
  handler to disable the button for the duration of the request and
  optionally show a "loading" label. Drops any clicks that arrive while
  the handler is in flight. Pattern doc-commented next to the helper.
- **Applied to all destructive buttons:**
  - `#btn-test` — Adobe IMS round-trip
  - `#btn-save-creds` — POST/PATCH `/credentials`
  - `#btn-cred-remove` — DELETE `/credentials/:id`
  - `#btn-start-expand` — kicks off a new job; duplicate would create
    two parallel expansion runs on the same CSV
  - `#btn-export-csv` — 3 s hold since browser navigation is fire-and-
    forget (this is the button that triggered the 2026-05-28 crash)
  - `#btn-build-plan` / `#btn-replan` — POST `/plan`
  - `#btn-submit-day` — POST `/submit`; server has its own inFlight
    guard, this is defence-in-depth
- **Intentionally NOT guarded:**
  - `#btn-cred-add`, `#btn-edit-identity` — UI-only state toggles
  - `#btn-refresh-*` — idempotent reads, safe to retry
  - `#btn-goto-*` — tab navigation
  - Auto-resume `#btn-ar-save` — already does manual disable correctly

### Backend concurrency audit (no code changes — confirmation only)

- **`.iterate()` on cached prepared Statements:** 0 remaining sites.
  Earlier today both planner and export migrated to the
  `prepareStreamIdentitiesBySource()` factory. No other queries use
  `.iterate()`.
- **`db.transaction(...)` callbacks:** 3 sites in `src/` (db.js,
  redistributor.js, submission.js). All take synchronous callbacks; no
  `db.transaction(async ...)` anti-pattern (which would commit the
  transaction before the async work finished).
- **Per-job locks:** `runSubmission` keeps its module-level `inFlight`
  Set. Plan / Approve-month handlers are synchronous — concurrent calls
  serialize on the event loop and the second sees the first's state
  (e.g. `ReplanForbiddenError` from a duplicate Plan).

179 tests still pass.

---

## 2026-05-29 — Fix "statement busy" crash on /export (and now planner-during-export)

Root cause traced from a 2026-05-28 production log:

```
23:44:31 INFO  expansion complete jobId=fa71... processed=1,569,174 found=1,607,384
00:27:55 ERROR request error err=This statement is busy executing a query
        at src/routes/jobs.js:217:47   <-- the cached streamIdentitiesBySource
```

Both the planner (`src/runner/submission.js`) and the CSV export route
(`src/routes/jobs.js`) called `.iterate()` on the SAME cached prepared
Statement `q().streamIdentitiesBySource`. better-sqlite3 allows only one
active iterator per Statement object. The /export route holds its
iterator across `await writeCsv(...)` yields — for a 1.6M-row export
that's tens of seconds. Any concurrent request that touches the same
cached Statement during that window throws `"This statement is busy
executing a query"` → HTTP 500.

Collisions that the bug enabled:
  - Export-vs-Export — a double-clicked or UI-auto-retried export
    (this is what hit the user; four 500s in 3 seconds).
  - Export-vs-Plan — yesterday's two-phase planner refactor made the
    planner also call `.iterate()` on the cached Statement, so Plan
    clicked DURING a long export would have collided too.

### Backend — db.js / submission.js / routes/jobs.js

- **`prepareStreamIdentitiesBySource()` factory.** New exported helper
  in `src/db.js` that returns a FRESH `db.prepare(...)` each call.
  Removed the cached `q().streamIdentitiesBySource` entirely. Both
  call sites (planner, export route) now build their own Statement.
  Prepare cost is ~ms; query cost is seconds-to-minutes — per-request
  prepare is negligible overhead and eliminates the collision entirely.
- **No public-API impact.** Callers are internal modules only.

### Tests (`test/planWorkOrders.test.js`)

- **New regression test** `prepareStreamIdentitiesBySource: concurrent
  iterators do not collide` opens two iterators against the same job
  and interleaves `.next()` calls. With the old cached Statement this
  threw "statement busy"; with the factory it produces identical row
  sets. Locks the fix against future regressions.

179 tests pass (was 178).

---

## 2026-05-28 — Follow-up perf review (Opus 4.7)

Second-pass review of the day's perf fixes. Two further wins applied:

### Backend — monitor (`src/runner/monitor.js`)

- **Per-tick `decryptCreds` cache** — the previous tick called `decryptCreds`
  once per work order, but with up to 100 WOs sharing typically 1-3 distinct
  credentials, that meant 95-99 wasted AES-256-GCM decrypts per minute. New
  `getCreds(credsId)` helper caches the **Promise** (not the resolved value)
  inside the tick closure, so parallel `pLimit(5)` callers all share one
  in-flight decrypt for any given creds_id. Saves ~100-500 ms CPU/tick.

### Backend — planning (`src/runner/submission.js`)

- **Two-phase planner refactor** — replaced
  `const rows = streamIdentitiesBySource.all(jobId)` (which materialised the
  full deduplicated identity set into JS objects — ~480 MB for a 6M-unique
  job) with a streaming `.iterate()` loop that builds a `pendingOrders` array
  of work-order plans. Phase 2 bulk-inserts all work orders in one
  `db.transaction()`. Memory drops from ~480 MB → ~120 MB on the big job
  shape; planning time unchanged (the single-tx fsync win still applies).
  Strict separation between phases is mandatory: better-sqlite3 locks the
  connection while an iterator is active, so any `insertWorkOrder.run()`
  during the iterate() loop would throw "connection busy".

### Backend — schema (`src/db.js`)

- **Dropped redundant `idx_ei_job_ns(job_id, ns_code)` index** — verified
  with `EXPLAIN QUERY PLAN` that every reader (`countIdentitiesByNamespace`,
  `streamIdentitiesBySource`, `countDistinctIdentities`) falls back to the
  still-existing `idx_ei_job_source(job_id, source_id)` with an **identical
  plan structure** (same job_id-leading `SEARCH` + same `TEMP B-TREE FOR
  GROUP BY`). Both indexes serve `WHERE job_id = ?` equally well; neither
  was covering for these queries, so the secondary index was pure dead
  weight. Removed from schema and dropped via `DROP INDEX IF EXISTS` on
  existing DBs. Frees one B-tree per insert (~5-10% expansion speedup on
  multi-million-row jobs) and ~144 MB disk on a 6M-row table.

### Docs (`docs/DESIGN_DOC.md`, `docs/DESIGN_DOC.docx`)

- **Architecture diagram** — rebuilt at uniform 78-char width. Fixes a 1-col
  misalignment between the bottom-border `╤` (col 35) and the arrow `│`
  below it (col 36). Replaced the nested inner-box layout with flat sections
  (Routes / Runners / Adobe Services / Security / Persistence) — easier to
  scan in print.
- **State machine diagram (§4.1)** — complete redesign. The previous diagram
  had inconsistent box widths, an arrow that pointed into the side of the
  SUBMITTING box (`└──────────────►│  Failure`), and an unclear
  AWAITING_APPROVAL connection that hung off the bottom of the main flow.
  New version uses a coherent top-down flow: PLANNED + AWAITING_APPROVAL
  entry → runSubmission → quota decision → SUBMITTING / DEFERRED →
  SUBMITTED / FAILED → terminal. Crash recovery is documented separately
  in a text block instead of dangling arrows.

178 tests still pass.

---

## 2026-05-28 — Performance fixes for large jobs (1M+ source IDs)

Context: a 1.57M source-ID job was run on a corporate Windows laptop. Identity
expansion was fast for the first ~700 batches but degraded progressively to the
point of taking >3.5 hours total. Root cause was a three-layer SQLite + Windows
interaction: (1) `INSERT OR IGNORE` had to traverse a unique B-tree index that
grew to ~400 MB / ~8M rows, making each insert O(log n) instead of O(1); (2)
WAL auto-checkpoint every ~4 MB triggered Windows Defender scans on every
checkpoint, turning each fsync from ~1 ms to 10–50 ms; (3) all 1,570 wave
tasks were queued in `Promise.all` at once, keeping every batch array and Adobe
response in heap until the very end, preventing GC from reclaiming completed work.
This session lands five fixes across expansion, planning, monitoring, and the
SQLite config layer.

### Backend — expansion (`src/runner/expansion.js`)

- **Wave-based task scheduling** — replaced a single `Promise.all(tasks)` over
  all ~1,570 batch closures with a rolling wave-window of
  `WAVE_SIZE = identityConcurrency × 2` (default 20). The `onRow` callback is
  now `async`; `await drainWave()` is called when the wave fills up, providing
  natural CSV backpressure. At completion, GC reclaims completed batch arrays
  continuously rather than holding all of them until the final `.all()` resolves.
  This caps peak heap at O(concurrency × batchSize) regardless of job size.
- **True distinct count after expansion** — with deferred dedup (see db.js),
  `found_count` was incremented with raw insert counts. After all waves drain,
  `countDistinctIdentities` runs a single `COUNT DISTINCT` query and overwrites
  `found_count` via `setFoundCount`, restoring pre-dedup semantics for the UI.

### Backend — planning (`src/runner/submission.js`)

- **Single-transaction work-order flush** — all `insertWorkOrder.run()` calls
  inside `planWorkOrders` are now wrapped in a single `db.transaction()`. On
  Windows, each SQLite auto-commit triggers an fsync; for 1,500+ work orders
  this was taking minutes under Defender. Wrapping in one transaction reduces
  it to a single fsync (~10–50 ms total).

### Backend — monitor (`src/runner/monitor.js`)

- **Parallel status polling** — `tick()` now uses `pLimit(5)` to fire up to
  5 concurrent `GET /hygiene/workorder/{id}` calls instead of polling serially.
  At 1,500+ open work orders the full poll cycle drops from ~52 min to ~15 min.
  Also raised `listOpenWorkOrders` LIMIT from 30 to 100.

### Backend — SQLite tuning (`src/db.js`, `src/config.js`)

- **Configurable page-cache** — `cache_size` pragma now reads from
  `config.sqliteCacheMb` (default 512 MB; was hard-coded 256 MB). Set via
  `SQLITE_CACHE_MB` env var. On a 32 GB laptop `SQLITE_CACHE_MB=8192` keeps
  the entire B-tree in RAM, preventing the cache-thrash that amplified under
  Defender once the index spilled past the 256 MB window.
- **WAL checkpoint threshold raised** — `wal_autocheckpoint` bumped from the
  SQLite default of 1,000 pages (~4 MB) to 8,000 pages (~32 MB). Reduces
  checkpoint frequency by 8×, cutting Defender scan overhead proportionally.
- **Deferred identity dedup** — the most impactful structural fix:
  - Removed `CREATE UNIQUE INDEX idx_ei_unique` from fresh-DB schema. Added a
    startup `DROP INDEX IF EXISTS idx_ei_unique` migration for existing DBs.
  - Changed `insertIdentity` from `INSERT OR IGNORE` to plain `INSERT` —
    O(1) per insert regardless of table size; no B-tree lookup needed.
  - Dedup moved to planning time: `streamIdentitiesBySource` now uses
    `GROUP BY COALESCE(ns_code,''), COALESCE(ns_id,0), identity_id` with
    `MIN(source_id)` — exactly the same dedup key as the old unique index,
    so each identity still appears at most once in any work order payload.
  - `countIdentitiesByNamespace` updated with the same inner `GROUP BY` so
    the Plan tab's namespace-breakdown table remains correct.
  - Correctness preserved by `hygiene.js::normalizeNamespacesIdentities`,
    which already deduplicates `ids[]` within each namespace group before
    the Adobe POST.
  - `bulkInsertIdentities` simplified: no longer tracks `result.changes`
    (every insert now succeeds); returns `batch.length` directly.

### Docs (`README.md`)

- **Tuning guide** added to the Architecture section: a table with recommended
  `SQLITE_CACHE_MB` and `IDENTITY_CONCURRENCY` values per machine class
  (16 GB laptop, 32 GB laptop, 8–16 GB server, 32+ GB server), with notes on
  Adobe 429 headroom. `SQLITE_CACHE_MB` documented in the `.env` config block.

### Expected impact on a 1.57M source-ID job

Removing the unique index + raising the cache size cuts expansion time by
~70–80% (the dominant bottleneck). Planning drops from ~minutes to ~seconds
with the transaction fix. Monitor poll cycle: 52 min → ~15 min.
On a 32 GB laptop with `SQLITE_CACHE_MB=8192` and `IDENTITY_CONCURRENCY=15`
the 1.57M job should complete expansion in under 45 minutes vs >3.5 hours.

**178/178 tests pass.**

---

## 2026-05-18 — Per-month approval gate for multi-month deletion plans

Context: the client raised a concern that with multi-month plans the tool was
automatically scheduling Month 2, 3, … for submission via the auto-resume
scheduler — operators wanted an explicit approval checkpoint before each
month's quota chunk ships, to allow time for reviewing the plan before
irreversible deletes go out. This session adds a first-class `awaiting_approval`
work-order status and a per-month "Approve Month N" action in the UI.

### Backend

- **`src/db.js`** — Three changes to the prepared-statement set:
  - `deletePlannedOrders` now also deletes `awaiting_approval` rows, so
    re-planning after an approval clears the stale WOs.
  - New `markFutureMonthsAwaitingApproval`: flips any `planned` WOs with
    `COALESCE(month_index, 1) > 1` to `awaiting_approval` immediately after
    planning. Month 1 stays `planned` and ships on the first Submit click.
  - New `approveMonth`: flips `awaiting_approval` → `planned` for a given
    `(job_id, month_index)` pair. Used by the new route below.
- **`src/runner/submission.js`**:
  - `planWorkOrders` calls `markFutureMonthsAwaitingApproval` at the end,
    so every fresh plan immediately protects Month 2+ behind the approval
    gate.
  - `ReplanForbiddenError` guard now allows `awaiting_approval` alongside
    `planned` and `deferred` — these WOs have never shipped to Adobe and
    it's safe to re-plan over them.
- **`src/routes/jobs.js`** — New route `POST /api/jobs/:id/approve-month`
  accepts `{ monthIndex }` (integer ≥ 2), calls `approveMonth`, and returns
  `{ ok: true, approved: <changes>, monthIndex }`. Returns 400 for invalid
  monthIndex (1 would approve Month 1 which is auto-submitted, so it's
  disallowed), 404 when no `awaiting_approval` WOs exist for that month.

### Frontend

- **`src/web/app.js`**:
  - `renderPlanResults` now renders "Awaiting approval" / "Approved" badges
    on Month 2+ `<summary>` headers in the grouped work-order table.
  - Each month with `awaiting_approval` WOs gets an approval action bar
    with an "Approve Month N" button that POSTs to the new route and
    re-renders the plan on success.
  - `submittedCount` excludes `awaiting_approval` (alongside `planned` and
    `deferred`) so the progress bar stays correct until the operator
    explicitly approves and the WOs start shipping.
- **`src/web/styles.css`** — Added `.pill.awaiting_approval` (blue tint) and
  `.approval-badge` / `.approval-badge.approved` styles for the summary-row
  indicator.

### Tests

- **`test/approveMonth.test.js`** — New file. 9 tests: happy path (2 WOs
  approved), idempotency (second call returns 404), invalid monthIndex values
  (1, 0, non-integer, missing), no awaiting WOs for the month (404), unknown
  job (404).

**178/178 tests pass.**

---

## 2026-05-15 — Security & correctness fixes from code review

Context: post-Phase-3 full functionality + security audit surfaced a set of
correctness gaps. All 12 findings (F-001 through F-012) were addressed. Full
review report in `docs/REVIEW.md`. 169/169 tests continue to pass.

### Backend

- **F-001 / `src/runner/redistributor.js`** — Removed the `SAFE_MIN_DAILY_CAP`
  / `SAFE_MIN_MONTHLY_CAP` floors (100k each) that were applied to the initial
  `dayRem` / `monthRem` values. These floors caused the redistributor to skip
  remaining capacity that wasn't large enough to hold a max-size WO (100k),
  but WOs are typically much smaller. A 30k WO would be pushed to the next
  day/month even with 80k remaining — wasting up to 99k of quota per period.
  Replaced with a simple clamp to 0 (defensive; Adobe's API can't return a
  negative). Also added a comment to `safeInt` explaining the `quota=0`
  treatment (F-008).
- **F-003 / `src/runner/submission.js`** — `reserve()` and `release()` now use
  the live Adobe quota cap values (`quotaSnapshot.daily.quota` /
  `quotaSnapshot.monthly.quota`) instead of the static `job.daily_limit` /
  `job.monthly_limit` stored at upload time. Job-row values are fallbacks only.
  This keeps the local quota ledger consistent with what the redistributor
  already used.
- **F-005 / `src/runner/submission.js`** — `runSubmission` now returns early
  (`{submitted:0}`) when `job.status === 'expanding'`. The scheduler's
  `listJobsWithUnshippedWOs` can include a job still expanding after a crash
  + restart; submitting its old planned WOs while expansion is in progress
  is confusing even though content is frozen.
- **F-006 / `src/runner/expansion.js`** — Added an `aborted` flag shared
  across the `p-limit` task pool. When any batch throws, `aborted = true`
  is set before re-throwing; subsequent in-queue tasks exit immediately
  without writing progress counters to SQLite. Prevents the UI from
  showing an ever-growing progress count on a job already marked `failed`.
- **F-007 / `src/routes/config.js`** — `POST /credentials/test` now validates
  `req.body.credsId` against `UUID_RE` before calling `decryptCreds`. Non-UUID
  strings are rejected immediately with a generic response, eliminating
  timing-based credential enumeration.
- **F-009 / `src/runner/submission.js` + `recovery.js`** — Work-order
  `displayName` now embeds the full local UUID (`WO ${wo.id}` instead of
  `WO ${wo.id.slice(0,8)}`). Recovery lookup uses exact-match (`=== prefix`)
  instead of `startsWith`. This makes orphan matching unambiguous even if a
  job name contains ` - WO `.
- **F-010 / `src/utils/csv.js`** — Added `\n` (LF) to `FORMULA_PREFIX_RE`
  alongside the existing `\r` (CR), per OWASP CSV Injection guidance.
- **F-004 / `src/runner/scheduler.js`** — `stopScheduler()` now resets
  `running = false` so a subsequent `startScheduler()` call gets a clean
  state. Without this, a test (or production restart) that cycles the
  scheduler while a tick is awaiting would suppress the next catch-up tick.
  Added a comment documenting the DST fall-back double-fire edge case (Q7
  from the review): acceptable because `runSubmission` is idempotent for
  already-submitted WOs.

### Tests

- **`test/recovery.test.js`** — Updated the "finds matching work order" test
  to use the full `localId` as the displayName (was `localId.slice(0, 8)`
  plus a suffix checked via `startsWith`), matching F-009.

### What was NOT changed (false positive or non-issue)

- **F-002** — `originRefererGuard` allows requests with neither Origin nor
  Referer. Confirmed not a practical bypass: `hostHeaderGuard` runs first
  and blocks any non-local Host. The gap is limited to content served from
  the same loopback port, which already implies same-origin privilege.
- **F-012** — `app.js` uses `escape(label)` in the credential picker.
  The local `function escape(s)` declaration at line 1963 hoists to the top
  of the script scope and shadows the browser global throughout — so
  `escape(label)` was already calling the correct HTML-escape helper. No
  change needed.

---

## 2026-05-15 — Quota Phase 3: configurable auto-resume scheduler

Context: Phase 2 (same day) made multi-month plans visible and re-bucketed
un-shipped work orders against live `/quota` on every plan + submit. But
the operator still had to come back manually on the 1st of each month to
click Submit again. Phase 3 closes that gap: a 60-second background tick
checks whether it's the operator-configured local HH:MM today on an allowed
weekday, and if so re-submits every job that still has un-shipped work.
The redistribute + reserve plumbing is unchanged; only the trigger is new.

### Backend — scheduler module

- **`src/runner/scheduler.js`** — new module. Three pieces:
  - `shouldFireNow(settings, now = new Date())` — pure function. Returns
    true exactly when `enabled === true` AND today passes the days
    filter (every-day / weekdays / first-of-month) AND `now` is at or
    past today's HH:MM AND we haven't fired since today's HH:MM (per
    `lastRunAt`). Injectable `now` makes it trivially unit-testable
    without freezing the system clock.
  - `nextFireTime(settings, now)` — walks forward day-by-day looking
    for the next datetime that satisfies the schedule. Exposed via the
    API so the UI's "Next run: …" label always agrees with the actual
    tick logic.
  - `startScheduler()` / `stopScheduler()` — lifecycle. The startup
    immediately runs one catch-up tick so the "laptop was closed at
    the scheduled time" case (which the client called out explicitly)
    is handled: if today's window has already passed and we haven't
    fired today, the very first tick fires. `running` flag guards
    against reentrancy when ticks overlap (paused machines can stack
    setIntervals).
  - `runResumeForAllJobs()` — iterates jobs with un-shipped WOs via a
    new `listJobsWithUnshippedWOs` prepared statement, calls
    `runSubmission({ jobId })` for each (which re-fetches `/quota`
    and re-buckets, see Phase 2). One bad job is logged and skipped;
    the rest still get processed. Per-tick summary
    (`jobsProcessed`, `totalSubmitted`, `totalDeferred`, `totalFailed`,
    `errors[]`) is persisted to `app_settings.auto_resume_last_run_summary`.
- **`src/db.js`** — new `CREATE TABLE app_settings (key TEXT PRIMARY KEY,
  value TEXT NOT NULL)`. Generic key/value bag. First users: `auto_resume_enabled`,
  `auto_resume_local_time`, `auto_resume_days`, `auto_resume_last_run_at`,
  `auto_resume_last_run_summary`. Two new prepared statements:
  `listAppSettingsByPrefix`, `upsertAppSetting`. Plus
  `listJobsWithUnshippedWOs` for the scheduler.
- **`src/routes/settings.js`** — new router mounted at `/api/settings`.
  `GET /auto-resume` returns the current settings + a `nextFireAt`
  projection. `PUT /auto-resume` accepts a partial body
  (`{ enabled?, localTime?, days? }`) and validates each field —
  HH:MM regex for time, enum membership for days, boolean type for
  enabled — using the same 400 envelope as F7's other route validators.
  `lastRunAt` / `lastRunSummary` are deliberately not writable from
  the route; only the scheduler itself updates them.
- **`src/index.js`** — mounts `settingsRouter`, starts the scheduler
  after `runStartupRecovery()`, and adds `stopScheduler()` to the
  graceful-shutdown path so the setInterval doesn't keep the event
  loop alive during shutdown.

### Frontend — Submit tab sidebar panel

- **`src/web/index.html`** — new `#auto-resume-panel` in the Submit
  tab's sidebar. Toggle + HH:MM `<input type="time">` + days `<select>`
  + a Save button gated on a dirty-check, plus a "next run" status
  line and an optional last-run summary strip.
- **`src/web/app.js`** — new `initAutoResumePanel()` called from
  `renderSubmit`. Fetches settings on mount, renders, tracks dirty
  state across input changes, persists via `PUT /settings/auto-resume`
  on Save. `formatRelativeTime` reused for the "Last ran X ago" line.
- **`src/web/styles.css`** — `.auto-resume-row`, `.f-toggle` (small
  checkbox + label combo using the existing Spectrum tokens).

### Invariants

- **`docs/ARCHITECTURE.md` §4** updated — `runner/scheduler.js` and
  `runner/redistributor.js` added to the module map. No new
  `CLAUDE.md` invariant required: the scheduler routes every action
  through `runSubmission`, which already preserves I5 (quota
  reserve/release), I10 (re-bucket-not-re-emit), and I11 (non-
  idempotent retry guards).

### Tests

- **`test/scheduler.test.js`** — 20 new cases. Pure-function
  coverage: `shouldFireNow` returns false when disabled, fires when
  past HH:MM with no prior run, doesn't fire before HH:MM, doesn't
  fire twice in one day, fires the next day when yesterday's run is
  stale, weekdays-only skips Sat/Sun and fires Monday, first-of-month
  fires only on the 1st, malformed `localTime` fails closed.
  `nextFireTime` projections for every-day, weekdays Friday→Monday,
  and first-of-month mid-month→1st-of-next-month. Routes: GET
  returns defaults; PUT accepts complete + partial valid payloads;
  PUT rejects bad HH:MM / unknown days / non-boolean enabled;
  PUT silently ignores caller-supplied `lastRunAt` /
  `lastRunSummary`.
- **169/169 pass.**

### What this completes

The three quota phases close out the multi-month-job feature set:
- Phase 1: live Adobe `/quota` visibility + drift detection (`operationCount`).
- Phase 2: month-aware re-bucketing + Plan/Submit modals.
- Phase 3 (this session): operator-configurable auto-resume scheduler.

A 10M-id job against a 2M/month entitlement now reliably ships across 5
months without manual intervention beyond the initial Plan + Submit click,
provided the operator's laptop is on at the configured local time at least
once a month. The startup catch-up tick handles the "laptop was off at
the scheduled time" edge case.

---

## 2026-05-15 — Quota Phase 2: month-aware re-bucketer + Plan/Submit modals

Context: Phase 1 (same day) wired live Adobe `/quota` into the Config UI.
Phase 2 makes the planner actually use those numbers. The headline change
is that the planner now buckets un-shipped work orders into `(day_index,
month_index)` pairs computed from the live `daily.remaining` and
`monthly.remaining` Adobe reports — and every Submit re-fetches `/quota`
and re-buckets before shipping anything. So if another tool consumes
org-wide monthly quota between Plan and Submit, our previously-Month-2
work gets pushed to Month 3 automatically; we never ship blind and let
Adobe reject. Pre-plan and pre-submit modals add operator confirmation
points before any destructive call goes out.

### Backend — re-bucketer + planner / submission integration

- **`src/runner/redistributor.js`** — new module exporting
  `redistributeUnshippedOrders(jobId, quota)`. Walks all un-shipped
  (status ∈ {planned, deferred}) work orders for the job in rowid order
  and assigns `(month_index, day_index)` based on the live quota:
  the first month consumes `quota.monthly.remaining` (the live Adobe
  value, which already excludes whatever has been shipped this month);
  subsequent months consume the full `quota.monthly.quota` entitlement.
  Today consumes `quota.daily.remaining`; subsequent days consume full
  `quota.daily.quota`. All updates run inside a single SQLite
  transaction so a crash mid-redistribute leaves the previous labels
  intact. Returns `{ months, days, totalUnshipped, totalIdentifiers,
  perMonthCounts }`. **Never touches shipped WOs** — their historical
  `(day_index, month_index)` is preserved.
- **`src/runner/submission.js::planWorkOrders`** — accepts a new
  `quota` parameter; after the legacy day-by-day pass writes the
  initial rough plan, calls `redistributeUnshippedOrders` to assign
  the authoritative month/day labels. Returns
  `{ planned, days, months, perMonthCounts, totalIdentifiers,
  shiftedFromPrevious, previousMonths }`. The Replan-Forbidden guard
  for shipped WOs is unchanged.
- **`src/runner/submission.js::runSubmission`** — accepts a new
  `monthIndex` alongside `dayIndex`. Always re-fetches `/quota` with
  `refresh: true` before picking work; if `/quota` fails AND there's no
  cached value within the 24 h hard floor, throws `quota_unavailable`
  and refuses to submit. The pre-submission redistribute updates the
  un-shipped pool to reflect any drift; the per-WO `reserve()` /
  `release()` ledger is unchanged.
- **`src/routes/jobs.js`** — Plan and Submit handlers fetch `/quota`
  via `getOrgQuota` and pass it to the planner / runner. Plan returns
  503 with code `quota_unavailable` when Adobe is unreachable AND no
  cache (caller blocks the UI). Submit returns 200 immediately and
  records crashes via the existing logger.
- **`src/db.js`** — additive migrations: `work_orders.month_index`
  (nullable; computed by the redistributor) and `jobs.projected_months`
  (nullable; the redistributor's max month_index for this job —
  used by the UI to detect "plan extended by N months" shifts).
  Five new prepared statements: `getOrdersByMonthAndDay`,
  `getUnshippedOrdersForJob`, `setOrderMonthDay`, `setProjectedMonths`,
  plus an update to `getAllOrdersForJob` / `getPlannedOrders` to sort
  by `COALESCE(month_index, 1)`.

### Backend — invariant update

- **`CLAUDE.md` I10** rewritten. The old rule "re-planning is forbidden
  once any WO has shipped" stands. The Phase 2 refinement clarifies
  that "re-bucketing" (updating `day_index` / `month_index` on
  un-shipped WOs) is explicitly allowed — the
  `namespaces_identities` JSON of any existing WO never changes; only
  the bucket label moves.

### Frontend — Plan UI grouped by Month → Day

- **`src/web/app.js::renderPlanResults`** — table replaced with a
  collapsible `<details>` per month showing per-month identifier total
  and percentage of monthly cap. Top stat-grid surfaces "Spans N
  months" (orange-tinted when > 1) so the multi-month case is obvious
  at a glance. Re-plan button label updated to "↻ Re-plan against
  live quota".
- **`src/web/app.js::buildOrRebuildPlan`** — handles the new server
  return shape, calls `showPlanModal(plan)` when the plan spans more
  than one month or when re-planning extended the timeline. Operator
  cancel keeps the previous plan unchanged in the DB.

### Frontend — Pre-plan modal, pre-submit modal, re-bucket toast

- **`src/web/index.html`** — new `#modal-root` and `#toast-container`
  at the bottom of the page; single shared modal instance to keep
  state simple.
- **`src/web/app.js`** — new helpers `showModal({title, bodyHtml,
  actions}) → Promise<value>` and `showToast(message, {kind,
  durationMs})`. The modal closes on backdrop click / Escape / close
  button (returns null). Toasts auto-dismiss after 6–9 s and stack
  in the top-right corner.
- **`showPlanModal(plan)`** — confirmation before a multi-month plan
  is locked in. Per the 2026-05-15 RQ-2 decision: shows a toast for
  a 1-month extension; shows the modal for ≥ 2-month extensions or
  any fresh multi-month plan. Body lists per-month identifier
  counts and notes that monthly quota only resets at 00:00 GMT on
  the 1st.
- **`showSubmitModal({wosToSubmit, monthLabel, dayLabel, quota})`** —
  always shown before each Submit click. Includes the live daily and
  monthly remaining numbers, warns when the requested batch exceeds
  either (excess will be deferred), and warns when the quota numbers
  are stale.
- **Submit-tab poll** — on every 2-second refresh, compares
  `Math.max(...workOrders.map(w => w.month_index))` against
  `state.lastKnownMonths`. A 1-month drift triggers a toast; ≥ 2
  triggers a modal explaining the shift.

### Frontend — styles

- **`src/web/styles.css`** — new `.plan-month` accordion, `.stat.warn`
  variant, `.modal-root` / `.modal-card` / `.modal-quota`, `.toast`
  / `.toast-warn` / `.toast-in`, `.btn-danger`. All built from the
  existing Spectrum tokens.

### Tests

- **`test/redistributor.test.js`** — 8 new cases: 4M with 2M/mo →
  2 months / 20+20 split; 10M → 5 months × 2 days; live monthly
  remaining of 500k pushes excess to month 2; partial daily.remaining
  produces a small Day 1; shipped WOs keep their labels; monthly cap
  disabled → single-month spread across days; `projected_months` is
  persisted; empty job is a no-op.
- **`test/integration.test.js`** — added `mockOrgQuota()` helper +
  `clearQuotaCache()` in afterEach so the new `runSubmission`
  pre-flight passes. Same end-to-end coverage as before.
- **`test/planWorkOrders.test.js`** — updated the
  "empty expanded_identities" assertion to expect `days: 0,
  months: 0` (the redistributor's correct empty-pool behaviour;
  previously the planner returned `days: 1` even with no work, a
  quirk of always starting `dayIndex` at 1).
- **149/149 pass.**

### What's deliberately deferred to Phase 3

- Auto-resume scheduler (configurable HH:MM + weekdays-only /
  1st-of-month toggle). For now the operator manually clicks Submit
  at the start of each month; the Plan UI's multi-month banner makes
  this expectation explicit.

---

## 2026-05-15 — Quota Phase 1: live Adobe org quota in the Config UI

Context: client asked us to address a series of quota-handling concerns
on a job that may run 6M+ source identifiers (~10M+ expanded). The
previous hardcoded defaults (1M daily / 3M monthly) gave us no way to
plan against the actual org entitlement, and quota changes mid-run (other
tools consuming from the same org-wide pool) were invisible to us.
Phase 1 — locked in 2026-05-15 — wires up live `GET /data/core/hygiene/quota`
so the operator and the planner share Adobe's source of truth. Phases 2
(month-aware re-bucketing + plan/submit modals) and 3 (configurable
auto-resume scheduler) are queued for separate commits.

### Backend — quota service + route

- **`src/services/quotaApi.js`** — new module. `getOrgQuota(creds, {refresh})`
  calls `GET https://platform.adobe.io/data/core/hygiene/quota` (org-wide,
  no `x-sandbox-name`; the doc doesn't list it as required, and we matched
  the same shape as `services/sandboxes.js`). Returns
  `{ daily, monthly, datasetExpiration, fetchedAt, stale, error }`. In-memory
  cache keyed on `imsOrgId`; TTL 1 hour. `refresh=true` force-busts the
  cache. On a live fetch failure the function returns the last cached value
  with `stale: true` and the error message attached — UI surfaces a warning
  banner but doesn't have to block. **Hard floor**: if the cache is older
  than 24 h (or there's no cache at all), the error is re-thrown with
  `err.code = 'quota_unavailable'` so submission paths can hard-block. This
  matches the RQ-3 decision from the design conversation.
- **`src/routes/adobe.js`** — new endpoint `GET /api/adobe/:credsId/quota?refresh=1`.
  Returns the shape above. On `quota_unavailable` it returns HTTP 503 with
  the same machine code. UUID param guard still applies to `:credsId`.
- **`src/services/hygiene.js`** — drift-detection log. When Adobe's response
  to `POST /workorder` carries an `operationCount` and it disagrees with our
  locally-computed `total`, we emit a single WARN line (`workorderId`,
  `ourCount`, `adobeOperationCount`, `delta`). This is the safe replacement
  for the live-delete identifier-counting test the user (rightly) rejected:
  we get the comparison for free on every real submission, with no extra
  quota consumed.

### Frontend — Config card quota banner + auto-populate

- **`src/web/index.html`** — new `#org-quota-block` panel above the Daily /
  Monthly cap inputs in the Config card. Shows two bars (Daily, Monthly)
  with consumed / quota / remaining, a "↻ Refresh" link button, and a
  stale-warning strip when applicable. Initially hidden; revealed after Test
  Connection succeeds.
- **`src/web/app.js`** — new `loadOrgQuota(force)` + `renderOrgQuota(q)` +
  `renderOrgQuotaError(err)` + `autoPopulateCapsFromQuota(q)`. The auto-
  populate function only overrides the cap inputs when they're still at the
  hardcoded defaults (1,000,000 / 3,000,000), so it never clobbers an
  explicit operator override. Quota is fetched after Test Connection
  succeeds (fire-and-forget) and again whenever the Config tab is mounted
  with an already-trusted session. Hints under each cap input now read
  "Adobe-reported entitlement: N / day" instead of the generic placeholder.
- **`src/web/styles.css`** — `.org-quota`, `.org-quota-head`,
  `.org-quota-bars`, `.org-quota-bar*`, `.org-quota-stale`. The progress bar
  reuses the existing `.progress-bar` / `.progress-fill` classes; colour
  shifts to orange at >70% and red at >90% so the operator notices when
  monthly headroom is getting tight. Adds a `.link-btn:disabled` state to
  the existing helper class.

### What this does NOT do yet (Phase 2 + 3)

- Planner still uses the static `daily_limit` / `monthly_limit` columns on
  the job row. It does NOT dynamically re-bucket un-shipped work orders
  against the live quota — that lands in Phase 2.
- The Plan tab does NOT show the projected "Month 1 / Month 2 / Month 3"
  timeline yet. Plan and Submit modals also pending Phase 2.
- Auto-resume on month rollover is NOT implemented. Deferred WOs still
  require an operator click to retry. Phase 3.

### Tests

- **`test/quotaApi.test.js`** — 8 new cases: documented response shape
  parses correctly, empty `quotas` array degrades gracefully, in-memory
  cache prevents a second Adobe hit within TTL, `refresh: true` forces a
  new fetch, live-fetch failure falls back to last cached with `stale: true`,
  no-cache + failure raises `quota_unavailable`, missing `imsOrgId` rejects
  early. **141/141 total pass.**

### Infra / docs

- This changelog entry. No invariant change yet — Phase 2 will update I3
  (the monthly cap discussion) and I10 (re-planning rules).

---

## 2026-05-12 (followup) — Per-work-order detail cards on Monitor tab

Context: operator showed AEP's "Data lifecycle requests" detail screen (the
one Adobe surfaces after clicking into a single work order: Work order
request ID, Created at, Updated at, Time elapsed, Number of identities,
plus a "Status by service" breakdown — Identity Service / Profile Service
/ Journey Optimizer / Data Management each with their own Pending / Processing
/ Completed state). We were already polling this data via the 60s monitor
tick and storing the raw `productStatusDetails` JSON on the `work_orders`
table, but the Monitor tab only rendered a 4-column dense table that
collapsed it all into a single "Pipeline" cell. This session surfaces the
detail without cluttering the page when many work orders are in flight.

### Frontend — rich work-order cards (`src/web/app.js`)

- **`renderWorkOrderCard(w, job)`** — new function that produces one card
  per work order, replacing the old table row. Shows:
  - Adobe Work Order ID (full DI-… string) with a "copy" button that uses
    the Clipboard API. The DI- handle is what you quote when escalating
    to Adobe support, so making it one-click-copy is the small UX win.
  - Status pill (Processing / Completed / Failed — friendly vocabulary
    already established for the existing pipeline indicator).
  - Identifier count, day index, Created at (absolute time tooltip),
    Updated at (relative "1 hr ago"), Time elapsed ("18 days").
  - Bundle ID truncated with the full value in a `title=` tooltip —
    Adobe's bundle handle is occasionally useful for cross-referencing
    work orders that ran in the same batch.
  - "Profile-only" chip when `targetServices` is set, so the operator
    can sanity-check that they really did request the profile-only mode
    they think they did. (Profile-only leaves the data lake intact;
    forgetting that has bitten ops before.)
  - "Error" callout strip when `last_error` is non-null — the failure
    text appears inline on the card instead of requiring a log dive.
- **`<details>` for the "Status by service" block** — collapsed by
  default to keep the page light when a job has many WOs. A `Set`
  (`expandedWoIds`) tracks which cards the operator opened and re-applies
  the `open` attribute on each 15s poll re-render, so the panel doesn't
  snap back closed mid-read. Auto-opens the single card on a single-WO
  job (no click needed).
- **`renderServicesBreakdown(services)`** — buckets the per-service rows
  the same way AEP groups them: Pending/Processing first, Completed
  second, Failed last (so a regression bubbles to the bottom where it's
  most visible). Each row shows an icon (`✓` / `○` / `⟳` / `✗`), the
  service name from Adobe's `productName`, the friendly status text
  ("Request pending" / "Request completed" / "Processing" / "Failed"),
  and the per-service `createdAt` as a relative time. If
  `productStatusDetails` is null (work order submitted but Adobe hasn't
  reported per-service status yet), we render a "Waiting for Adobe's
  first per-service status update… (monitor polls every 60s)" hint.
- **`parseProductStatusDetails(input)`** — small helper that accepts
  either the JSON string (as stored on `work_orders.product_status_details`)
  or a pre-parsed array, normalises every entry to a UI-ready shape
  (`{name, raw, status, friendly, cls, updatedAt}`), and handles both
  the `productStatus` field per `docs/REVIEW.md §3.7` and a fallback
  `status` field for older response shapes.
- **`parseTimestamp` + `formatDuration` + `formatAbsoluteTime` +
  `formatElapsed`** — small new helpers that handle SQLite's "YYYY-MM-DD
  HH:MM:SS" UTC format, Adobe's ISO timestamps, and epoch numbers all
  through the same parser. `formatRelativeTime` was reimplemented on
  top of `formatDuration` so the "5 min ago" / "2 hr ago" / "18 days
  ago" vocabulary is consistent everywhere.

### Frontend — sandbox visibility (multi-sandbox safety)

- **`#monitor-detail-sub`** now reads `Sandbox <b>{name}</b> · polled from
  Adobe every 60s…` when a job is selected. With multiple sandboxes
  flowing into the dashboard at once, the existing chip-row filter is
  the right way to scope the LIST, but the operator can still get lost
  when bouncing between job detail panels — having the sandbox visible
  right above the work-order cards anchors the view.
- Per-card sandbox would be redundant inside the detail panel (one
  job = one sandbox by schema), so we don't repeat it on each card.

### Frontend — styles (`src/web/styles.css`)

- New rules under `/* ─── Work-order detail cards … */`: `.wo-card`,
  `.wo-card-head`, `.wo-card-meta` (responsive grid), `.wo-services`
  (custom-marker `<details>` summary with a rotating `▸`), `.wo-service`
  rows colour-coded by status (`completed` / `pending` / `processing` /
  `failed`), `.wo-error`, `.wo-services-empty`, `.copy-btn`. All use
  the existing Spectrum tokens so colours stay consistent with the rest
  of the UI.

### Tests

- 133/133 still pass. No backend contract changed; the data has been on
  the wire for a while via `/api/jobs/:id/work-orders` (the route already
  passes `product_status_details` through as part of `...r`).

### Docs

- This changelog entry. No invariant change (the polled data was already
  there; this is purely a UI presentation upgrade).

---

## 2026-05-12 — Security review fixes (F1–F14)

Context: a full security review of the codebase (see security report from
the 2026-05-07/08 session in the project root, attached to the review PR)
turned up 14 findings ranging from critical (DNS rebinding / unauthenticated
local API) to informational. This session lands the fixes for F1–F14 in one
bundle so the gaps don't sit while we triage individually.

### Backend — request guards and helmet (F1, F8)

- **`src/middleware/security.js`** — new module hosting three middleware
  primitives and a centralised error handler:
  - `hostHeaderGuard` — rejects requests whose Host header is not
    localhost / 127.0.0.1 / [::1]. Closes DNS rebinding (an attacker.com
    page that rebinds to 127.0.0.1 keeps `Host: attacker.com` after
    rebinding, so we can detect and 421-reject it).
  - `originRefererGuard` — for POST/PUT/PATCH/DELETE, requires the Origin
    (or, fallback, Referer) host to match the request's own Host. Closes
    simple-form CSRF: a `<form>` POST from a cross-origin page now gets
    403 instead of triggering destructive submission. Requests with
    neither header (curl / programmatic clients) are allowed since they
    can't be CSRF.
  - `registerUuidParamGuards(router)` — calls `router.param('id', …)` /
    `router.param('credsId', …)` to validate that both UUID-shaped path
    params actually parse as v4 UUIDs. F5 fix. **Must be called on each
    router** because Express 4 doesn't propagate `app.param()` into
    mounted sub-routers.
  - `makeErrorHandler(logger)` — 5xx responses get a generic
    "internal_error" message (no raw `err.message` — better-sqlite3 and
    `fs` errors otherwise leak absolute paths); 4xx responses surface a
    `code` + `publicMessage` set by the route handler.
- **`src/index.js`** — wires `hostHeaderGuard`, `originRefererGuard`,
  `helmet` (with a tight CSP: `script-src 'self'`, no inline scripts;
  `style-src 'self' 'unsafe-inline'` to permit the existing inline
  `style="…"` attrs; `frame-ancestors 'none'`, `object-src 'none'`,
  COOP/CORP `same-origin`), and the centralised error handler.

### Backend — region allowlist + cred field validation (F2, F7)

- **`src/routes/config.js`** — POST/PATCH/test all validate strings
  against length caps + control-character rejection, and lock `region` to
  `{va7, nld2, aus5, can2}` and `environment` to `{Production, Stage,
  Development}` server-side. The UI dropdown already enforced this
  client-side, but the server accepted any string — which made a stored
  `region = "evil.com#"` (set via a CSRF or rebinding attack) into an
  SSRF that templated into the Identity host with the bearer token
  attached. Belt-and-suspenders allowlists in
  `src/services/identityGraph.js` and `src/services/namespaces.js`
  refuse to build the URL if a stale DB row carries a bad region.

### Backend — encryption key hardening (F3, F12)

- **`src/utils/crypto.js`** — first-run key creation now opens with
  `O_EXCL` (`flag: 'wx'`) so two concurrent boot processes can't each
  generate a different key and silently strand secrets. On POSIX we also
  verify+`chmod` the file to 0600 if the umask masked our request.
- **`src/config.js`** — new exported `detectCloudSyncPath(p)` helper
  recognises OneDrive / Dropbox / Google Drive / iCloud / Box paths.
- **`src/index.js`** — startup banner emits a loud `SECURITY WARNING` log
  line when `dataDir` resolves under a cloud-sync path. The encryption
  key and encrypted client secrets live in `data/`; syncing them to a
  third-party cloud co-locates key + ciphertext off-machine. Doesn't
  auto-relocate (would silently break existing setups) — operators set
  `DATA_DIR` or stop the sync.

### Backend — multer 2.x upgrade + bounded limits (F4)

- **`package.json`** — `multer` ^1.4.5-lts.1 → ^2.0.0 (current 2.1.1).
  Multer 1.x is end-of-life and has several DoS / uncaught-exception
  advisories.
- **`src/routes/upload.js`** — added per-request limits beyond just
  `fileSize`: `files: 1`, `fields: 20`, `parts: 25`, `headerPairs: 100`,
  `fieldNameSize: 100`, `fieldSize: 64 KiB`. Also added a wrapper that
  converts `MulterError` into a 400 with the multer code as `error`
  instead of letting it fall through to the 500 handler.
- **`src/routes/upload.js`** — random filename now uses a sanity-checked
  extension (`.csv`/`.txt`/`.tsv` only, default `.csv`) instead of
  whatever `path.extname(originalname)` returned.

### Backend — dotenv pinned, errors sanitised, graceful shutdown (F6, F11, F14)

- **`src/index.js`** — replaced `import 'dotenv/config'` (CWD-relative)
  with `dotenv.config({ path: '<package-root>/.env' })`. A stray `.env`
  in the current working directory can no longer override `HOST`,
  `ENCRYPTION_KEY`, `IMS_HOST`, or `AEP_GATEWAY`.
- **`src/index.js`** — SIGTERM/SIGINT now: (a) stops accepting new
  connections, (b) gives in-flight requests up to 10s, (c) checkpoints
  + closes SQLite (`pragma wal_checkpoint(TRUNCATE)`, `db.close()`), then
  exits. The old `process.exit(0)` left the WAL un-checkpointed and
  forced extra recovery work on next boot.

### Backend — CSV formula-injection guard (F10)

- **`src/utils/csv.js`** — `writeCsv` now runs every value through
  `sanitiseCsvValue` before emitting it: any value starting with `=`,
  `+`, `-`, `@`, tab, or CR is prefixed with `'` so Excel/Sheets treat it
  as literal text instead of executing a formula. Applies to the
  identifier export endpoint and any future CSV writer that uses this
  helper.

### Frontend — escaped HTML sinks (F9)

- **`src/web/app.js:499–503`** — namespace `<option>` builder now passes
  `n.code`, `n.id`, and the combined `label` through `escape()`. A
  namespace whose `code` contained quote or angle-bracket characters
  could previously break out of the option attribute / inject markup.
- **`src/web/app.js:1186`** — monitor table now escapes
  `w.adobe_workorder_id` and `w.updated_at` before inserting into HTML.
  Defence-in-depth against malformed/malicious Adobe responses.

### Tests

- **`test/security.test.js`** — new file. 19 cases cover: host-header
  guard accepts loopback variants and rejects attacker.com Host,
  origin guard accepts same-origin POST and rejects cross-origin POST
  and mismatched-Referer, UUID guard rejects non-UUID `:id`, region
  allowlist rejects evil.com and accepts case-insensitive members,
  environment allowlist, CRLF in fields rejected, oversized
  clientSecret rejected, missing label rejected, PATCH region
  allowlist, CSV formula sanitiser correctness.
- **`test/credentialsRoutes.test.js`** — updated two tests to match the
  new error envelope (`error` is now a machine code, human text moved
  to `message`) and the new UUID guard semantics (malformed `:id` now
  returns 400 `invalid_id` before the route runs; the 404 case must
  pass a valid UUID that doesn't exist). Added one new test:
  `PATCH with malformed UUID returns 400 invalid_id`.
- **133/133 pass.**

### Infra / docs

- **`package.json`** — added `helmet` ^8.1.0.
- **`docs/ARCHITECTURE.md`** — module map gained `src/middleware/`;
  §3 step-1 augmented with the security-middleware order.
- **`CLAUDE.md`** — added invariants I13 (security middleware order)
  and I14 (region allowlist enforced server-side, not just in the UI).

---

## 2026-05-06 (followup) — Generic source-identifier copy in UI

Context: operator pointed out that several UI strings still treated
`hashedKocid` as the canonical/only input namespace, even though the tool's
Upload-tab namespace dropdown has been fully generic for some time (works
with email, phone, ECID, CRMID, GAID, IDFA, or any custom namespace in the
sandbox's registry — see CLAUDE.md "Single source namespace per job"
limitation, which clarifies that any single namespace is supported, just
not multiple at once). The `hashedKocid` references read as factual claims
about what the tool does, which would mislead any operator running it
against a non-Coca-Cola sandbox.

### Frontend — copy generalisation

- **`src/web/index.html`** — About panel on the Environment page now reads
  "Resolves source identifiers (any AEP namespace — hashedKocid, email,
  CRMID, etc.) to their full Identity Graph clusters…". Lists a few common
  namespace codes as examples so the copy is still concrete enough to
  ground first-time readers, without claiming hashedKocid is special.
- **`src/web/index.html`** — "Why expansion?" panel on the Source CSV tab
  rewritten as "Your source identifier is only one identity node…" — the
  rest of the warning (about linked email/phone/ECID/CRMID, full deletion
  requiring cluster resolution) is unchanged.
- **`src/web/app.js`** — Upload and Expand step headers (used in
  breadcrumb subtitles) generalised: "Upload a CSV of source identifier
  values to be deleted." / "Resolve all identities linked to each source
  identifier."

### Not changed (deliberate)

- **`src/web/app.js:24`** — `state.sourceNamespace = 'hashedKocid'` default.
  This is the form's pre-selected dropdown value, not user-facing claim
  text. Kept for backwards compat with existing operator muscle memory;
  any saved sandbox namespace registry will repopulate this on Upload-tab
  entry anyway.
- **`src/web/app.js:1360-1362`** and **`src/web/styles.css:411`** — namespace
  badge color hints (`hashedKocid: purple`, `email: blue`, etc.). These are
  presentation conveniences for known namespaces, not claims about
  supported input. Custom namespaces fall through to a neutral gray.

### Tests

- 113/113 still pass (text-only frontend changes, no test fixtures or
  payload contracts touched).

---

## 2026-05-06 — Monitor Pipeline label matches AEP UI vocabulary

Context: operator noticed the Monitor tab's per-work-order Pipeline column
showed `received` (with the first dot lit) for a work order that AEP's own
Data Lifecycle UI was showing as `Processing`. Investigation confirmed both
sources were consistent at the data layer — Adobe's
`GET /data/core/hygiene/workorder/{id}` literally returns
`status: "received"`, which we store and render verbatim — but AEP's UI
collapses every non-terminal API stage (`received` / `validated` /
`submitted` / `ingested`) into a single user-facing **Processing** label.
Operators comparing the two screens reasonably ask "which is right?". Both
were, but in different vocabularies.

Compounding this: `stageIdx` previously fell back to `0` for any
non-recognised status, which would silently render an unknown status as if
Adobe had reported `received`. If Adobe ever does add a new API status, the
old code would have hidden it behind a fake "received" label.

### Frontend

- **`src/web/app.js`** — added `friendlyStatus()` and `friendlyStatusClass()`
  helpers that map the 6 documented API statuses to AEP's UI vocabulary
  (`received` / `validated` / `submitted` / `ingested` → **Processing**;
  `completed` → **Completed**; `failed` → **Failed**; anything else →
  surfaced verbatim as **Unknown**, never silently flattened).
- **`src/web/app.js`** — `pipelineHtml(current, rawStatus)` now takes the
  raw status as a second argument, replaces the old `<span class="pipeline-label">`
  with a colour-coded `<span class="pill">`, and writes the raw API status
  into the pill's `title` tooltip for engineer-level diagnosis. Each dot
  also carries its own stage name as a `title` attribute so hovering an
  individual node shows the granular API stage.
- **`src/web/app.js`** — `stageIdx` now returns `-1` for unrecognised
  statuses rather than `0`. `pipelineHtml` treats `-1` by lighting no
  "current" dot — a future unknown status would no longer be misrendered as
  `received`. The stage stats grid above the table benefits identically:
  unknown statuses no longer count toward any stage bucket.
- **`src/web/app.js`** — call site at the Monitor table updated to pass
  `w.adobe_status` through to `pipelineHtml` so the new tooltip works.
- **`src/web/styles.css`** — added `.pill.processing` (blue, grouped with
  the existing `.pill.received` rule) and `.pill.unknown` (gray, grouped
  with `.pill.planned`/`.pill.queued`). Replaced the now-unused
  `.pipeline-label` rule with `.pipeline .pill { margin-left: 10px; }` so
  the pill spaces correctly after the last dot.

### Tests

- 113/113 still pass (no backend behaviour changed; the friendly-label
  layer is purely presentational and frontend-only — the Monitor SQL
  contract still keys on the raw `adobe_status` values).

### Docs

- This changelog entry. No invariant change (the API contract docs in
  `CLAUDE.md` / `REVIEW.md` are correct as-is — the API really does emit
  the 6 documented statuses; the label change is a UI-only courtesy).

---

## 2026-04-28 (followup) — Two bug fixes after operator testing

After running the new Monitor dashboard against a real workspace with one
sandbox + one submitted job, two issues surfaced:

### Bug 1 — Authenticated chip disappeared on refresh

**Root cause**: `testConnection`'s outer `catch` was clobbering `state.tokenOk = false`
when the downstream `loadSandboxes(true)` call threw. After a system restart
(or any transient network blip), the IMS auth call could succeed and set
`tokenOk = true`, then the immediately-following `loadSandboxes` Adobe call
could time out, throw, and reset `tokenOk` to false in the catch — even
though authentication had genuinely worked. The chip stayed hidden until
the operator clicked Test Connection manually with a warm network.

**Fix** (`src/web/app.js`): wrap `loadSandboxes(true)` in its own try/catch
inside the success branch. A sandbox-load failure now surfaces as a warning
alert ("Authentication is OK, but the sandbox-discovery call failed: …")
without resetting `tokenOk`.

**Side fix** (`src/web/styles.css`): added `.alert.warning` style (orange
border + tint) so the new alert kind renders correctly.

### Bug 2 — Sandbox filter row hidden by design with one sandbox

**Root cause**: `renderSandboxFilter` had `if (sandboxes.length <= 1)
hide`, hiding the entire chip row when there was only one sandbox. The
intent was "filtering one thing is meaningless" but the side-effect was
"the feature is invisible to anyone with one sandbox" — i.e., most
operators starting out.

**Fix** (`src/web/app.js`): change to `if (sandboxes.length === 0)` so
the row shows when there's at least one sandbox. With one sandbox the
operator sees `[All sandboxes (N)] [<sandbox-name> (N)]` — both lead to
the same set, but the affordance is discoverable from the first
submission.

### Tests

No new tests — these are UI guard / DOM-rendering changes outside the
SQL contract. 113/113 still passing.

---

## 2026-04-28 (latest) — Monitor: in-flight-first sort + sandbox filter + count chips

Context: with 20-25 submitted jobs across multiple sandboxes (a realistic
production load for a marketer running deletions across several Adobe
orgs), the previous "top 10 by latest activity" feed had two problems:
recently-completed jobs could push still-in-flight ones off the visible
list, and there was no way to scope to one sandbox. Implemented Options
1 + 3 from the proposal.

### Backend — SQL + route

- **`src/db.js`** — `listMonitorJobs` now sorts
  `(in_flight_count > 0) DESC, latest_activity_at DESC` so jobs with
  pending Adobe work always rank above terminal jobs. Accepts new
  `@sandbox` param for exact-match filter on `j.sandbox_name`.
- **`src/db.js`** — new `monitorTotals` prepared statement. Returns
  job-level dashboard counts across ALL matching jobs (not capped by
  limit), bucketing each job into exactly one of `in_flight` (≥1
  in-flight WO), `has_failed` (no in-flight + ≥1 failed WO), or
  `all_completed` (no in-flight + no failed).
- **`src/db.js`** — new `monitorSandboxes` prepared statement. Returns
  distinct sandbox names with per-sandbox job counts among submitted
  jobs. Honors the search filter (so chip counts reflect the active
  search) but not the sandbox filter (the chips ARE the filter).
- **`src/routes/jobs.js`** — `GET /api/jobs/monitor` response shape
  changed from `[rows]` to `{ rows, totals, sandboxes }`. Default limit
  bumped from 10 to 20 (cap still 100). Accepts `?sandbox` query param.

### Frontend — chips + filter row

- **`src/web/index.html`** — Monitor template adds two new sub-rows:
  `#monitor-totals` (horizontal chips for in-flight / completed /
  failed counts) and `#monitor-sandbox-filter` (filter chip row with
  "All sandboxes (N)" + one chip per sandbox).
- **`src/web/styles.css`** — `.dashboard-totals`, `.dash-chip` (with
  in-flight / completed / failed color variants matching the existing
  card-stats palette), `.dashboard-sandbox-filter`, `.dash-filter-chip`
  (pill-shaped with `.active` blue-fill state).
- **`src/web/app.js`** — `MONITOR_LIST_LIMIT` 10 → 20. `renderMonitor`:
  - new `sandboxFilter` closure variable; passed to `/jobs/monitor` as
    `?sandbox=` and used to highlight the active chip
  - new helpers (closures): `renderTotalsChips`, `renderSandboxFilter`
    (auto-hides when ≤1 sandbox), `buildSummaryText` (shows
    "Showing N of M in scope, in-flight first… (K more — use search)")
  - response shape now `{ rows, totals, sandboxes }`; empty state keys
    on `totals.total === 0 && !searchTerm && !sandboxFilter`

### Tests — 6 new, 1 rewritten

- **`test/monitorJobs.test.js`** — existing `.all()` calls updated to
  pass `sandbox: ''`. The "sorts by latest activity" test was rewritten
  to use two **in-flight** jobs (so the secondary sort is exercised
  cleanly without confound from the new in-flight-first priority).
  New tests:
  - **in-flight jobs sort BEFORE terminal jobs** even when the
    terminal job has more recent activity (locks in Option 1's fix)
  - **sandbox filter scopes results** correctly + empty `sandbox`
    means all sandboxes
  - **monitorTotals bucketing** — each job lands in exactly one of
    `in_flight` / `has_failed` / `all_completed`
  - **monitorTotals filter propagation** — search and sandbox filters
    apply to the count too
  - **monitorSandboxes** returns distinct sandboxes with correct counts;
    decoy job (no Adobe ID) does not contribute
  - **monitorSandboxes search propagation** — chip counts reflect active
    name search
- 113/113 tests pass (107 → 113).

### Docs

- **CLAUDE.md** local API surface table updated: `/jobs/monitor` row
  expanded to describe the response shape, in-flight-first sort, and
  the sandbox filter.
- **docs/ARCHITECTURE.md** `routes/jobs.js` entry updated with the new
  response shape and sort semantics.
- **docs/REVIEW.md** endpoint row updated.
- **docs/DESIGN_DOC.md** §4.8 expanded: in-flight-first ORDER BY
  rationale, sandbox filter rationale, response-shape rationale (one
  round-trip per refresh, totals across all matching jobs not just
  visible ones, sandbox chip counts honor search but not sandbox).
  Test counts and appendix file map updated.

---

## 2026-04-28 (later) — Monitor tab → Active Submissions dashboard

Context: the Monitor tab's recent-jobs picker pulled from `/api/jobs?limit=20`
ordered by `created_at DESC`. Two practical problems for marketers tracking
deletions: (1) heavy expansion activity pushed the still-in-flight submissions
out of the visible window, and (2) sort-by-creation surfaced new uploads even
when the most-relevant job was an in-flight deletion that had been submitted
days earlier. The user asked for a real monitoring dashboard rather than a
filtered dropdown stop-gap. This is Option C from the proposal — replaces the
picker with a list of submission cards backed by a dedicated server feed.

### Backend — active-submissions feed

- **`src/db.js`** — new `listMonitorJobs` prepared statement. INNER JOINs
  `work_orders`, filters to rows where `adobe_workorder_id IS NOT NULL` (jobs
  Adobe has acknowledged), GROUP BY job, with `FILTER (WHERE …)` aggregates
  for `submitted_count`, `in_flight_count`, `completed_count`,
  `adobe_failed_count`, `submitted_ids`, `latest_activity_at`, `max_day`.
  ORDER BY latest WO activity DESC. Optional case-insensitive name search.
- **`src/routes/jobs.js`** — new `GET /api/jobs/monitor?limit&search`
  endpoint backed by `listMonitorJobs`. Limit hard-capped at 100.

### Frontend — dashboard rewrite

- **`src/web/index.html`** — `tpl-monitor` rebuilt:
  - **Active submissions card** at the top: heading + caption ("Showing top
    N by latest Adobe activity") + `<input type="search">` + a list region.
  - **Detail card** below (existing 5-stage stat grid + per-WO pipeline
    table) becomes the "selected job" view, hidden until a card is opened.
  - New **empty state**: "No submitted jobs to monitor yet. Upload a CSV
    and run Submit to start tracking deletions here."
- **`src/web/styles.css`** — `.dashboard-head`, `.sub-card` (with `.selected`,
  hover, `:has`-free progress bar via `.sub-card-bar`), `.sub-card-stats`
  (color-coded `in-flight` / `completed` / `failed`), `.sub-card-action`,
  `.section-divider`. Search input styled to match form controls.
- **`src/web/app.js`** — `renderMonitor` rewritten:
  - `fetchAndRenderList()` hits `/jobs/monitor`, renders cards, manages
    empty/no-match states.
  - `selectMonitorJob(id, silent)` fetches full job detail, switches the
    card highlight, refreshes the detail panel. Auto-selects the
    most-recently-active job on first render.
  - `renderSubmissionCard()` produces the per-job card markup.
  - `formatRelativeTime()` turns SQLite `datetime('now')` into "just now /
    N min ago / N hr ago / N day(s) ago". Treats stored timestamps as UTC
    (which is how the prepared statements write them).
  - Search input has 250ms debounce; refetches with the `search` param.
  - List polls every 15s (was 5s for the single selected job); detail
    panel still refreshes every 15s alongside the list.

### Tests — 5 new

- **`test/monitorJobs.test.js`** — locks the SQL contract:
  - excludes jobs with no Adobe-acked work order (expansion-only stays out)
  - sorts by latest WO activity DESC, NOT job creation time
  - aggregate counts (submitted / in_flight / completed / failed) match
  - case-insensitive substring search on job name
  - `limit` is honored
- 107/107 tests pass (102 → 107).

### Docs

- **CLAUDE.md** — local API surface table extends with `/api/jobs` and
  `/api/jobs/monitor` rows. Test count `102` → `107`.
- **docs/ARCHITECTURE.md** — `routes/jobs.js` entry expanded with the
  two list endpoints' semantics. Test description updated.
- **docs/REVIEW.md** — endpoints table adds the new monitor row.
- **docs/DESIGN_DOC.md** — new **§4.8 "Why the Monitor tab uses an
  active-submissions feed, not /jobs"** documents the two original
  problems (submitted jobs falling out of the picker; wrong sort axis)
  and the SQL design. Existing §4.8 (credentials picker) renumbered to
  §4.9; §4.9 (monthly quota) renumbered to §4.10. Test counts and
  appendix file map updated.

---

## 2026-04-28 — Credentials picker overhaul + UI polish + 7 new route tests

Context: client name was disappearing on refresh, there was no obvious way to
switch between saved credentials, and no "Add new" UI. Three symptoms, one
underlying cause: the persistence path was gated on "did the secret change,"
so non-secret edits to existing creds were never saved, and the saved-
credentials list was buried in a right-rail panel with no active-cred
indicator. Also addressed: form alignment bug on Daily/Monthly cap inputs,
favicon, official Adobe Data Cleansing icon, and AEP-style page-header
gradient.

### Backend — Option B credentials picker

- **`src/db.js`** — added `countJobsForCred` and `updateCredFields` prepared
  statements. The latter updates ONLY label / client_name / region; never
  touches the encrypted secret blob (`client_secret_enc/iv/tag`) or the
  unique-key identity columns (environment / ims_org_id / client_id).
- **`src/routes/config.js`** — new `PATCH /api/config/credentials/:id`.
  Accepts `{ label, clientName, region }`. Returns 404 if id doesn't
  exist; 400 if label missing. The route deliberately ignores any
  identity-field keys in the body (those route through the existing POST
  upsert path).
- **`src/routes/config.js`** — `DELETE /api/config/credentials/:id` now
  blocks with HTTP 409 + `{error: 'credential_in_use', jobCount, message}`
  when any row in `jobs` references the credential. Without this, deleting
  a cred attached to in-flight or completed jobs would orphan job status
  polling and recovery routines.

### Frontend — credentials picker UX

- **`src/web/index.html`** — new `.cred-picker` bar at the top of the
  Configuration card with a dropdown ("Active credential"), **+ Add new**
  button, **⊗ Remove** button. New `.identity-lock-row` showing a dashed
  reminder when identity fields are locked, with an "✏ Edit identity
  fields" link to unlock. Removed the right-rail "Saved Credentials"
  panel — the new picker is the single source of truth.
- **`src/web/app.js`** — new `state.identityUnlocked` flag.
  - `refreshCredPicker()` — fetches `/config/credentials`, populates the
    dropdown (last-used-first, formatted as `client_name · label · env ·
    region`), appends "+ Add new credential" sentinel option. Auto-falls
    back to `list[0]` only when `state.credsId` is unset OR points to a
    deleted cred AND the user is NOT in Add-new mode.
  - `addNewCredentialFlow()` — clears form + `state.credsId = null` +
    `state.identityUnlocked = true`, then `goto('config')`.
  - `removeCurrentCredential()` — native `confirm()` dialog → DELETE →
    refreshes picker → switches to next-most-recent or Add-new mode.
    Surfaces 409 errors clearly.
  - `applyIdentityLockState()` — readonly + `.locked` class on
    `c-environment` / `c-ims-org` / `c-client-id` when a saved cred is
    loaded and the user hasn't explicitly unlocked.
  - `unlockIdentityFields()` — unlocks + info alert explaining that
    edits will create a new credential on next save.
  - `saveAndContinue()` — actually persists now. PATCHes when an
    existing cred is loaded and identity fields are locked; otherwise
    falls through to upload (the new-cred case is already POSTed during
    Test Connection).
  - `testConnection()` — after creating a brand-new cred, re-locks
    identity fields and refreshes the picker so the new entry shows.
- **`src/web/styles.css`** — `.cred-picker`, `.cred-picker-actions`,
  `.identity-lock-row`, `.link-btn`, `input.locked` / `select.locked`.

### Frontend — visual polish

- **Page-header gradient** (`src/web/index.html` + `styles.css`) — wrapped
  breadcrumbs / title / subtitle in `.page-header` with a subtle
  purple→peach gradient (8% / 10% opacities). Matches AEP's new look on
  the Profile Detail / hub views without bleeding under cards. Reversible
  in ~5 minutes if it reads as too marketing-y.
- **Data Cleansing icon** (`src/web/data-cleansing-icon.svg` new) —
  Adobe's official `dataCleansing` icon, refilled to `currentColor`.
  Rendered inside the sidebar app-block's gradient tile via CSS mask
  so it shows in white on the existing blue→purple background. Replaces
  the placeholder `⌫` glyph.
- **Favicon** (`src/web/index.html`) — `<link rel="icon" type="image/svg+xml"
  href="/aep-icon.svg">` so the browser tab shows the AEP "A" mark.
  Reuses the local SVG already used in the top bar — no extra assets,
  still offline-only (CLAUDE.md I12).
- **Form alignment fix** (`src/web/styles.css` + `index.html`) — Daily /
  Monthly identifier cap inputs were misaligned because the Monthly
  label had a long inline help-text span that wrapped to two lines and
  pushed the input down. Fix: introduced `.f-hint` Spectrum-style help
  text below the input; added matching hint to Daily for symmetry.
  `.f-row-2` now has `align-items: end` as defense-in-depth so any
  future label-height mismatch can't repeat the bug. Same anti-pattern
  fixed proactively on the Datasets field and the Source namespace
  field (Upload tab).

### Tests

- **`test/credentialsRoutes.test.js` (new, 7 tests)** — boots a minimal
  Express app on a random localhost port and exercises the routes via
  Node's built-in `http`. Covers:
  - PATCH updates label / client_name / region
  - PATCH never overwrites client_secret_enc/iv/tag (asserts byte-for-byte)
  - PATCH 404 on unknown id
  - PATCH 400 when label missing
  - PATCH ignores identity-field keys (env / ims_org_id / client_id) — the
    route's contract that those go through the upsert path is locked in
  - DELETE removes when no jobs reference the cred
  - DELETE returns 409 with jobCount when jobs reference the cred; cred
    must still exist after the rejection
- 102/102 tests pass (95 → 102).

### Docs

- **CLAUDE.md** — file map adds `data-cleansing-icon.svg`. New "Local API
  surface" table next to the Adobe endpoints cheat sheet, listing PATCH +
  DELETE 409 behavior. I6 extended to document that PATCH never touches
  the encrypted secret blob or identity fields. Test count `95` → `102`.
- **docs/ARCHITECTURE.md** — `routes/config.js` entry expanded with the
  four route shapes; `web/` entry expanded with picker bar, identity
  lock, page-header gradient, favicon, Data Cleansing icon, `.f-hint`
  convention. Test description updated.
- **docs/REVIEW.md** — endpoints table updated with PATCH row and the
  DELETE 409 contract.
- **docs/DESIGN_DOC.md** — new §4.8 ("Why the credentials picker has its
  own dedicated UX") explaining the three symptoms, the picker design,
  the identity-fields lock rationale, and the AEC org-switcher analogy.
  Existing §4.8 (monthly quota) renumbered to §4.9. Test counts and
  appendix file map updated.

---

## 2026-04-26 (later) — Documentation refresh after review remediation

Context: brought all four primary docs (`CLAUDE.md`, `docs/ARCHITECTURE.md`,
`docs/REVIEW.md`, `docs/DESIGN_DOC.md`) in line with current code reality.
Stale claims were corrected; new invariants and behaviors documented.

### CLAUDE.md

- Architecture diagram now shows `127.0.0.1:3000` (loopback enforced) with
  a paragraph explaining the `HOST` env override.
- File map adds `runner/recovery.js`, `web/aep-icon.svg`, `web/fonts/`.
- I5 (quota) updated: `release(imsOrgId, count, monthlyLimit)` signature;
  monthly skipped when null; cross-reference to I11 for the retry guard.
- **Four new invariants added:**
  - **I9** — Identity API region MUST come from the credential row, not
    a global. Wrong-region returns 200 with empty clusters → silent
    partial deletes.
  - **I10** — Re-planning is forbidden once any work order has shipped.
    `ReplanForbiddenError` (HTTP 409). UI mirrors with disabled button.
  - **I11** — Adobe POST retries are gated by per-request idempotency.
    Hygiene POST never retries 5xx/network; identity-graph opts in.
  - **I12** — UI loads only local assets. No third-party CDNs (fonts,
    scripts, images, analytics). Server binds to `127.0.0.1` by default.
- "Error handling" section adds the Adobe error-body enrichment +
  permission hints behavior added in the prior session.
- "Known limitations" updated: `HOST=0.0.0.0` opt-out is explicit; monitor
  poll interval clarified as a constant (not env-configurable today).
- "Things a future change might need" — moved "resume jobs across restarts"
  to a new "Already done" section since recovery.js exists.
- Test count "66 tests should pass" → "95 tests should pass".

### docs/ARCHITECTURE.md

- Topology diagram shows `127.0.0.1:3000` and includes a note about loopback
  default + HOST override.
- Data-flow §3 PLAN step documents the replan guard (`ReplanForbiddenError`)
  and references CLAUDE.md I10.
- Data-flow §3 SUBMIT step documents the deferred-retry path and the
  non-idempotent hygiene POST (cross-references I11).
- Module map §4 expanded:
  - `adobeClient.js` — idempotency-aware retry; error-body enrichment;
    permission hints on 403.
  - `namespaces.js` and `identityGraph.js` — region from `creds.region`.
  - `hygiene.js` — explicit "deliberately non-idempotent" note.
  - `quotaManager.js` — `release(orgId, count, monthlyLimit)` signature.
  - `submission.js` — replan guard, deferred-retry selector.
  - `recovery.js` — 400 leaves orphan in submitting; never rolls back
    when answer is indeterminate.
  - `crypto.js` — `decryptCreds` returns `region`.
  - `web/` — aep-icon.svg + fonts/ subdirectory.
- Test-suite description updated: 95 tests; new categories listed.
- Invariant summary §7: added I9–I12 to the bullet list.
- §8 known boundaries: orphan reconciliation rolls back only on confirmed
  no-match; quota-release-on-timeout note rewritten around the new
  idempotency guard.

### docs/REVIEW.md

- §1 system overview: localhost binding now enforced via `app.listen(port,
  host, cb)`; earlier doc claim corrected.
- §2 data flow Submit step: planned-or-deferred selector; non-idempotent
  POST; release with `monthlyLimit`.
- §3.4 namespaces: region MUST come from credential row, not global.
- §4 our endpoints: address corrected to `http://127.0.0.1:3000`.
- §7 concurrency model: `release` signature updated; recovery rules
  updated with the LOOKUP_INDETERMINATE / 400-handling logic.
- §8 security model: localhost binding now enforced; HOST=0.0.0.0 opt-out.
- §9 review questions: Q6 and Q7 rewritten to reflect the
  recovery + idempotency-aware retry behaviors.

### docs/DESIGN_DOC.md

- Topology and component diagram: `127.0.0.1:3000` with HOST note.
- §2.3 data flow: PLAN step documents replan guard; SUBMIT documents
  deferred retry + non-idempotent POST + release(... monthlyLimit).
- §2.4 recovery flow: three-outcome breakdown (match / confirmed no-match
  / indeterminate); explicit "never roll back when indeterminate."
- §4.7 reconciliation rationale: indeterminate outcome on 400; updated
  retry posture references CLAUDE.md I11.
- §5.2 M1/M2: extended with the 2026-04-26 review fixes (idempotency-
  aware retries; replan guard).
- **§5.6 NEW: External review remediation (2026-04-26 session)** —
  R1 through R8 documented with one paragraph each (HTTP host binding,
  replan guard, deferred retry, hygiene 5xx, region routing, monthly
  release gating, recovery 400 handling, self-hosted fonts).
- §6 known limitations: quota-release-on-timeout rewritten around
  non-idempotent POST + recovery routine.
- §7.2 security: HTTP binding now enforced; HOST opt-out.
- §8.2 test counts: 76 → 95; per-file breakdown updated; three new test
  files mentioned (adobeClient, region, deferred).
- §8.3 crash recovery: indeterminate outcome documented.
- §10 appendix file map: web/aep-icon.svg, web/fonts/, three new test
  files.

### Process notes

- `docs/DESIGN_DOC.docx` not regenerated — it's a Word export of the .md
  the user has been maintaining manually. They should regenerate it from
  the updated DESIGN_DOC.md when convenient.
- 95/95 tests still pass after doc-only changes.

---

## 2026-04-26 — External P1/P2/P3 review remediation (8 fixes, 12 new tests)

Context: external review flagged seven correctness/safety findings plus one
invariant violation. Verified each against the code, accepted all, fixed all.
Test count 83 → 95.

### Safety / correctness — P1s

- **`src/index.js` + `src/config.js`** — server now binds to `127.0.0.1` by
  default (override via `HOST` env var). Previously `app.listen(port, cb)`
  used Node's unspecified-host default (`0.0.0.0`), exposing the
  unauthenticated API and destructive Submit endpoint to anyone on the
  same network.
- **`src/runner/submission.js`** — `planWorkOrders` now throws a new
  `ReplanForbiddenError` (HTTP 409) if the job has any work order in a
  non-`planned`/non-`deferred` state. Re-planning after a submission would
  re-emit work orders for identities Adobe already received, causing
  duplicate irreversible deletes. `routes/jobs.js` maps the error to a 409
  with a human message.
- **`src/web/app.js`** — `renderPlan` no longer auto-POSTs `/plan` on tab
  entry. It loads the existing plan via `GET /work-orders` and renders it
  read-only. A "Build plan" or explicit "↻ Re-plan" button is the only
  way to trigger planning. The Re-plan button auto-disables (with a
  tooltip) when any order has been submitted, mirroring the server guard.
  409 responses surface as a clear "Re-plan blocked" alert without losing
  the existing plan view.
- **`src/db.js` + `src/runner/submission.js`** — `getPlannedOrders` SQL
  now selects `status IN ('planned','deferred')` and `runSubmission`'s
  per-day filter matches. Quota-deferred work orders were stranded
  before — the documented "rerun after UTC midnight" path now actually
  retries them. `app.js`'s Submit-tab day-advance logic treats deferred
  rows as still-pending and adds a hover tooltip explaining what to do.
- **`src/services/adobeClient.js`** — `retryCondition` is now
  idempotency-aware. Adds a per-request `idempotent` flag (default: `true`
  for GETs, `false` for everything else). On 5xx or network errors,
  non-idempotent requests are NOT retried — protects the hygiene work-order
  POST from creating duplicate Adobe records when a 5xx arrives after the
  request was already processed. The Identity Graph cluster query (POST
  used as side-effect-free read) opts in via `idempotent: true`. 401/429
  retries continue unconditionally.
- **`src/services/hygiene.js` + `src/services/identityGraph.js`** —
  hygiene POST kept as default non-idempotent with an explicit DO-NOT-RETRY
  comment; identityGraph POST tagged `{ idempotent: true }`.
- **`src/utils/crypto.js` + `src/services/namespaces.js` +
  `src/services/identityGraph.js`** — Identity API region now flows from
  the credential row through `decryptCreds` (returns `region`). Both
  endpoint builders prefer `creds.region` over the process-wide default.
  Previously selecting NLD2/AUS5/CAN2 in the Config tab silently still
  routed to platform-va7, and Adobe returns 200 with empty cluster data
  on cross-region calls — that would cause silent partial deletes (the
  source kocid would be deleted but the linked email/phone/CRMID would
  not). Treated as a P1 even though the reviewer flagged P2.

### Correctness — P2s

- **`src/services/quotaManager.js`** — `release(imsOrgId, count, monthlyLimit)`
  now skips the monthly ledger decrement when `monthlyLimit` is null,
  mirroring `reserve()`'s gate. Both call sites (`runner/submission.js`
  catch path; `runner/recovery.js` rollback path) now pass `job.monthly_limit`.
  Without this, a failed job with monthly tracking off was eating monthly
  headroom from unrelated jobs on the same org.
- **`src/db.js`** — `listSubmittingOrphanOrders` now also returns
  `j.monthly_limit AS j_monthly_limit` so recovery can pass it through to
  `release()`.
- **`src/runner/recovery.js`** — `findAdobeWorkOrderByDisplayNamePrefix`
  now distinguishes "Adobe says it doesn't exist" (returns `null`) from
  "Adobe rejected our query" (returns a new `LOOKUP_INDETERMINATE` sentinel).
  On 400, the orphan stays in `submitting` so a later run can retry the
  lookup — instead of being rolled back to `planned` + having quota
  released, which on resubmit could create a duplicate if the original
  POST had actually been processed.

### CLAUDE.md invariant violation — P3

- **`src/web/index.html` + `src/web/styles.css` + `src/web/fonts/*.woff2`
  (new)** — Source Sans 3 (4 weights) is now self-hosted instead of
  loaded from Google Fonts CDN. The Google Fonts call leaked user-agent +
  IP to a third party and broke offline operation, which contradicts
  CLAUDE.md "Never add … outbound calls beyond the documented Adobe
  endpoints." Files come from the official `adobe-fonts/source-sans`
  GitHub release branch (OFL-licensed). ~620 KB on disk total.

### Tests — 12 new

- **`test/region.test.js` (new, 3)** — `listNamespaces`/`expandBatch` route
  to per-credential region (NLD2/AUS5) instead of process default; default
  fallback still works.
- **`test/adobeClient.test.js` (+4)** — non-idempotent POST blocks 5xx
  retries; idempotent POST allows 5xx retries to eventual success;
  non-idempotent POST blocks network-error retries; GET retries 5xx.
- **`test/planWorkOrders.test.js` (+2)** — re-plan throws
  `ReplanForbiddenError` once an order is in `submitted`; re-plan succeeds
  when only `deferred` orders exist.
- **`test/deferred.test.js` (new, 1)** — `getPlannedOrders` returns
  planned + deferred but not submitted.
- **`test/quotaManager.test.js` (+1, modified 2)** — `release(...,null)`
  doesn't touch the monthly ledger; existing tests updated to pass the
  new arg.
- **`test/recovery.test.js` (+1)** — 400 from list endpoint leaves orphan
  in `submitting` (not rolled back).

### Process notes

- CLAUDE.md test-count line still says "66 tests should pass". Now 95.
  Will update CLAUDE.md separately if the user wants — it should reflect
  current reality.

---

## 2026-04-24 (afternoon) — AEP-style top bar, configurable client name, avatar repurposed

Context: user asked the UI to look closer to the production AEP web UI, wanted
the placeholder red "A" replaced with the official AEP mark, flagged that the
top-right "DE" avatar circle had no explanation and did nothing on click, and
asked for a configurable client name (e.g. "Coca-Cola") since this helper is
generic and reused across orgs.

### Frontend — top bar

- **`src/web/aep-icon.svg` (new)** — extracted just the `AdobeExperiencePlatform`
  artwork from the public HeroIcons sprite (`cdn.experience.adobe.net/assets/
  HeroIcons.6620f5dc.svg#AdobeExperiencePlatform`) into a standalone ~500-byte
  SVG. Kept locally rather than fetched at runtime so the topbar works offline
  and doesn't silently break if Adobe rotates the sprite hash.
- **`src/web/index.html`** — replaced the `<div class="brand-mark">A</div>`
  placeholder with `<img src="/aep-icon.svg">`. Added a `#client-name` text
  block and gave the `.avatar` element an `id` + `title` tooltip that
  explicitly documents its purpose ("Local tool — no user account. Initials
  reflect the configured client name.") so users stop wondering what the
  non-clickable circle is for.
- **`src/web/styles.css`** — switched the topbar background from `--g900` to
  `#000B1D` (matches the AEP icon's navy). Tweaked chip backgrounds to use
  translucent white so they sit cleanly on the navy bar. Avatar now uses the
  same blue→purple gradient as the sidebar's app-icon so the brand is
  consistent.

### Frontend — client name

- **`src/web/index.html`** — added a `Client name` input at the top of the
  Credentials card in the Environment Configuration template. Placeholder
  text spells out that it appears in the top bar + avatar.
- **`src/web/app.js`** — `state.config.clientName` is now round-tripped:
  read from `savedCred.client_name` on bootstrap, written via `updateConfigState`,
  sent with the POST /config/credentials body, and restored in `useCred`.
  New `updateClientNameDisplay()` updates both the top-bar text block and the
  avatar initials; called from `updateEnvChip()` so the display stays in sync
  as the user types. `initialsFor()` takes first letters of first two
  whitespace/dash/underscore/dot-separated words (e.g. "Coca-Cola" → "CC",
  "Acme Corp" → "AC"); falls back to first two characters for single-word
  names. When no client name is configured the avatar falls back to "AEP" and
  the top-bar text block is hidden entirely.

### Backend — client name persistence

- **`src/db.js`** — additive migration adds `client_name TEXT` to the
  `credentials` table. `insertCred` prepared statement now writes the new
  column (with existing upsert path preserved). `listCreds` returns it so the
  UI can restore it without a second round trip.
- **`src/utils/crypto.js`** — `storeCreds` accepts `clientName` and forwards
  it to `insertCred`. Missing values normalize to `null` so older flows keep
  working.
- **`src/routes/config.js`** — `POST /config/credentials` pulls `clientName`
  off the body and passes it through to `storeCreds`. It's optional — only
  `label, environment, region, imsOrgId, clientId, clientSecret` remain
  required.

### Tests

- **`test/planWorkOrders.test.js`** — test fixture's `insertCred()` now
  passes `clientName: null` to satisfy the new named parameter on the
  prepared statement. 76/76 tests pass.

### Backend — Adobe error enrichment

Context: user asked what happens when IMS credentials have partial AEP access
(e.g. can list sandboxes but not submit work orders). The failure paths
existed but surfaced axios's generic "Request failed with status code 403"
with no indication of which product profile was missing. This made
permission diagnosis unnecessarily painful.

- **`src/services/adobeClient.js`** — response interceptor now calls a new
  `enrichAdobeError(err)` on every 4xx/5xx. It extracts Adobe's error body
  across common shapes (`detail` / `message` / `error_description` /
  `error_message` / `title` / `error` / `errors[].message`) and overrides
  `err.message` with `"HTTP <status> <statusText>: <adobe text>"`. For 403s
  it appends a permission hint derived from the URL path:
  - `/hygiene/` → "needs Data Hygiene product profile + Delete Record permission"
  - `/sandbox-management/` → "needs Sandbox Administration read access"
  - `/catalog/` → "needs Catalog read access"
  - `/idnamespace/` → "needs Identity read access"
  - `/identity/clusters/` → "needs Identity Service access on this region"
  - anything else → "check the product profile attached to this integration"
  The original axios message is preserved on `err.originalMessage`; the full
  response body stays on `err.response.data` for anyone who wants to inspect.
  No changes to the retry interceptor or 401 token-invalidation path.

- **`test/adobeClient.test.js` (new)** — seven nock-mocked tests covering
  each supported body shape, the permission-hint mapping for 403s, the
  `originalMessage` preservation, and a non-known-path fallback. 83/83 tests
  pass.

### Typography

- **`src/web/index.html`** — now loads **Source Sans 3** (weights 400/500/600/700)
  from Google Fonts with `preconnect` for both `fonts.googleapis.com` and
  `fonts.gstatic.com`. Picked because Adobe Clean is proprietary and only
  renders on adobe.com-hosted pages; Source Sans 3 is the closest open-source
  cousin (same family lineage) and ensures consistent rendering across
  operator machines.
- **`src/web/styles.css`** — reordered the body font stack so
  `"Source Sans 3"` is primary; `"adobe-clean"` kept as a fallback for anyone
  with it installed locally, then system fonts after that.

---

## 2026-04-24 — Monitor tab job picker + expand-tab loader

Context: after an app restart the Monitor tab showed an empty Work Order
Pipeline even though the backend was still polling Adobe for the live
work order. Root cause was UI-only: `state.job` is seeded from the
upload/expansion flow, and `bootstrap()` only restored the saved
credential — not the job. The SQLite state (`data/state.db`) and the
background monitor runner (`runner/monitor.js`) were both healthy; the
UI just had no way to re-select a prior job.

### Frontend

- **`src/web/index.html`** — added a "Recent jobs" picker card at the top
  of the Monitor template, plus an empty-state card for the zero-jobs
  case. Wrapped the existing pipeline/stage stats block in
  `#monitor-content` so it can be hidden when no job is selected.
- **`src/web/app.js`** — `renderMonitor` now fetches `/jobs?limit=20`,
  auto-selects the most recent job when `state.job` is null, and wires
  the `<select>` to re-hydrate `state.job` (via `GET /jobs/:id` for the
  full detail payload) before calling the existing `refresh()`. If the
  current job isn't in the recent list (older than limit=20) it's
  prepended so the dropdown still shows a matching option. New helper
  `formatJobOption` renders each option as `date · name · sandbox · IDs · status`.
- **`src/web/app.js`** — `renderExpand` now paints a spinner
  ("Loading expansion progress…") into `#expand-body` before the first
  `/progress` + `/jobs/:id` round-trip completes, matching the spinner
  style used by `renderPlan`.
- **`src/web/styles.css`** — added `.job-picker` / `.job-picker-meta`
  layout helpers for the new Monitor picker row.

### Tests

- 76/76 `node --test test` pass; no changes needed (picker + loader are
  UI-only and don't touch covered server logic).

---

## 2026-04-23 (evening) — monthly quota tracking + restart recovery + integration tests

Context: user approved the proposals from the earlier session for Tasks #5 and
#6. Also requested proper unit + integration coverage for the new features and
a Word-format design document.

### Backend — monthly quota (Task #5)

- **`src/db.js`** — added `quota_usage_monthly (ims_org_id, utc_year_month, used)`
  table, parallel to the daily `quota_usage`. Rolls over at UTC first-of-month.
  Also added an additive migration block that ALTERs `jobs` to add
  `monthly_limit INTEGER` and `last_checkpoint_at TEXT`. Swallows only
  "duplicate column" errors so re-runs are idempotent.
- **`src/db.js`** — prepared statements `getMonthlyQuota`, `upsertMonthlyQuota`,
  `decMonthlyQuota` (same pattern as daily).
- **`src/services/quotaManager.js`** — rewrote for two-dimension tracking.
  `peek` now returns `{ daily:{used,remaining,limit}, monthly:{...}|null, ...
  back-compat fields }`. `reserve(org, count, dailyLimit, monthlyLimit)` checks
  BOTH caps and denies on either overflow, exposing `reason: 'daily' | 'monthly'`.
  `release` decrements both ledgers.
- **`src/config.js`** — added `monthlyIdentifierLimit` with default 3,000,000/month
  (typical base Data Hygiene contract; contract-dependent, overridable via env
  or Config tab). Set to 0 to disable monthly tracking entirely.
- **`src/routes/upload.js`** — accepts `monthlyLimit` form field; stores as
  nullable integer on the job row (null means "no monthly tracking for this job").
- **`src/routes/jobs.js`** — job-detail endpoint passes the job's `monthly_limit`
  to `peek()` so the UI can display both dimensions.
- **`src/runner/submission.js`** — `runSubmission` passes `job.monthly_limit`
  to `reserve()`. Deferred-reason message now distinguishes "daily quota X/Y"
  from "monthly quota X/Y" so the operator knows which cap triggered the defer.

### Backend — restart recovery (Task #6)

- **`src/runner/recovery.js` (new)** — startup reconciliation module. Two
  functions:
  - `resumeExpandingJobs()` — finds any job stuck in `status='expanding'`,
    builds a `Set` of already-processed `source_id`s from
    `expanded_identities`, and calls `runExpansion(... skipSourceIds)` to
    resume where the crash left off. Missing upload file → job marked failed
    (can't resume without the source data).
  - `reconcileOrphanWorkOrders()` — finds work orders with `status='submitting'
    AND adobe_workorder_id IS NULL` (the crash-after-reserve-before-POST
    window). Looks up Adobe via `GET /hygiene/workorder?displayName=<prefix>`.
    If matched → record Adobe ID, move to `submitted` (monitor takes over).
    If not matched → roll back to `planned` and `release()` the quota.
    If transient error → leave as-is, next startup retries.
- **`src/runner/expansion.js`** — `runExpansion` accepts optional
  `skipSourceIds` Set. When streaming the CSV, rows whose value is in the set
  are skipped so we don't re-call the Identity Graph for work already done.
- **`src/runner/expansion.js`** — emits a `resumed expansion: skipped N`
  info log when a resume takes effect so operators can see it happen.
- **`src/db.js`** — new prepared statements: `listExpandingJobs`,
  `processedSourceIdsForJob` (returns DISTINCT source_id via unique index),
  `listSubmittingOrphanOrders`, `rollbackWorkOrderToPlanned`.
- **`src/index.js`** — calls `runStartupRecovery()` after `initDb()` and
  `startMonitor()`. Non-blocking (fire-and-forget); any errors are logged but
  never crash the boot.

### Frontend — UI for monthly quota

- **`src/web/index.html`** — Config tab now has a 2-column row with Daily +
  Monthly identifier caps side-by-side (Monthly defaults 3M, 0 disables).
- **`src/web/app.js`** — `state.config.monthlyLimit` added. `updateConfigState`
  reads the input. `startExpansion` form append sends `monthlyLimit`.
- **`src/web/app.js`** — Submit page's `#quota-display` now renders both
  dimensions: "Daily: used/remaining/limit + progress bar" stacked on top of
  "This month: used/remaining/limit + progress bar". Each bar turns red at
  >90% usage.
- **`src/web/app.js` bootstrap** — refresh-aware: `monthlyLimit` added to the
  form-restore loop so the Config tab re-populates correctly after reload.

### Tests

- **`test/quotaManager.test.js`** rewritten (was 9 tests, now 11). New cases:
  - peek returns both dimensions on a fresh org
  - peek with `monthlyLimit=null` returns `monthly: null` and still works
  - peek back-compat fields (`used`/`remaining`/`limit`) still return daily
  - reserve with `monthlyLimit=null` behaves identically to daily-only mode
  - reserve grants when both dimensions have room
  - reserve denies with `reason='daily'` OR `reason='monthly'` based on which
    cap triggered
  - denial is a no-op (neither ledger is incremented)
  - release decrements both ledgers
  - release floors at zero on both
  - sequential over-allocation blocked in whichever dimension is tightest
- **`test/recovery.test.js` (new)** — 5 tests using `nock` for Adobe mocks:
  - orphan with no Adobe match → rolled back to planned + error message set
  - orphan matched by displayName prefix → recorded as submitted
  - orphan with transient Adobe error (503×retry) → left for next startup
  - expanding job with missing upload file → marked failed
  - empty expanding list → no-op
- **`test/integration.test.js` (new)** — 3 end-to-end tests wiring
  expansion → plan → submit with full nock-mocked Adobe (IMS +
  Identity Graph in new shape + hygiene POST):
  - expansion parses `{version, clusters:[{compositeXid, members}]}` shape
    correctly (verifies the observed AEP v1.1.0 response handling)
  - plan → submit produces a work-order POST with `code + id` for every
    namespace group and exercises the full runner chain
  - resume with `skipSourceIds` set sends ONLY the un-processed IDs to Adobe
    (verified by capturing the POST body)
- **`test/planWorkOrders.test.js`** — updated `insertJob` helper to include
  `monthlyLimit: null` (matches the new schema column).

### Infra / notes

- **API verification caveat** — I don't have web access in this session, so
  the monthly default of 3M comes from training-data knowledge of typical
  base Data Hygiene contracts, not a live Experience League fetch. The
  `// VERIFY:` comments in `recovery.js::findAdobeWorkOrderByDisplayNamePrefix`
  call out the one place where the Adobe API's query-filter format may
  need confirmation against your live API in production. Worst case it
  returns 400 and reconciliation falls through to "roll back to planned"
  (safe default — causes one extra submit on next run rather than silent
  double-submit).

### Docs

- **`docs/ARCHITECTURE.md`** — updated schema section to include
  `quota_usage_monthly`, updated data-flow to mention the startup recovery
  pass, updated module map to list `runner/recovery.js`.
- **`CLAUDE.md`** — Invariant I5 (quota reservation is atomic and reversible)
  updated to note that both daily AND monthly are reserved/released together.
- **`docs/DESIGN_DOC.md` (new)** — long-form design doc covering system
  overview, architecture decisions, Adobe contracts, review findings,
  operational procedures, and known limitations. Used as the source for the
  Word-format export.
- **`docs/DESIGN_DOC.docx` (new)** — Microsoft Word export of DESIGN_DOC.md.
  Generated by `scripts/md-to-docx.py` (python-docx). Regenerate with:
  `python scripts/md-to-docx.py docs/DESIGN_DOC.md docs/DESIGN_DOC.docx`.
- **`scripts/md-to-docx.py` (new)** — Markdown→DOCX converter using
  python-docx. Handles headings, fenced code blocks (shaded monospace),
  bullet + numbered lists, pipe tables, **bold**, *italic*, `inline code`,
  and horizontal rules. Installed dep: `python-docx==1.2.0`.

### Verification

**Tests**: 76 passing, 0 failing on Node 20.18.0 (up from 66). New tests
cover the monthly quota matrix (denial reasons, dimension independence,
release both), recovery orphan reconciliation (match / no-match / transient),
and a full expansion→plan→submit integration flow with mocked Adobe.

---

## 2026-04-23 — initial review fixes, end-to-end run, UI + contract corrections

Context: first full working session. User requested a thorough code review of
the new aep-lifecycle-helper project against its `CLAUDE.md` invariants and the
contract in `docs/REVIEW.md`. 1 blocker + 3 major + 4 minor findings were
identified and fixed. Test suite was written and all green. Application was
started end-to-end against a real AEP UAT sandbox; two additional bugs were
found and corrected during live use.

### Backend

- **`src/runner/monitor.js` — fix blocker: wrong column names.** The SQL in
  `listOpenWorkOrders` aliases joined cols as `j_creds_id` and `j_sandbox_name`,
  but `monitor.js` was reading `wo.creds_id` / `wo.sandbox_name` — both
  `undefined`. Every status poll was silently failing with "Unknown credential
  id: undefined". Corrected the property names.
- **`src/services/adobeClient.js` — fix major: non-idempotent POST retried on
  network errors.** Previously `axios-retry` was set to retry all network
  errors (timeouts included) on every request. Added a guard: for non-GET
  methods, skip retries on network errors. The hygiene workorder POST is not
  idempotent — a retried timeout could have created duplicate irreversible
  deletion orders.
- **`src/runner/submission.js` — fix major: re-planning duplicated work orders.**
  `planWorkOrders` was inserting new rows without clearing previous `planned`
  rows for the same job. Added `deletePlannedOrders` prepared statement and
  call it at the start of `planWorkOrders` — re-plan is now idempotent.
- **`src/runner/submission.js` — fix major: concurrent submission race.** Added
  a module-level `inFlight` Set guard. Two rapid `/submit` calls no longer race
  to POST the same work order to Adobe.
- **`src/runner/submission.js` — fix major: SQLite connection busy on mid-flow
  flush.** `planWorkOrders` was using `.iterate()` on the identity stream while
  calling `.run()` to insert work orders mid-iteration. better-sqlite3 locks the
  connection for the duration of an iterator. Switched to `.all()` — memory cost
  is identical since the iterator was never actually streamed (the planner
  writes mid-flow anyway).
- **`src/services/namespaces.js` — fix minor: id=0 bypass.** `id && !code` was
  falsy when id=0; changed to `id != null && !code` so a namespace with nsid 0
  gets its code resolved from the registry.
- **`src/db.js` — fix minor: ORDER BY rowid, not UUID.** `getAllOrdersForJob`,
  `getPlannedOrders`, `getOrdersByDay` now sort by `rowid` (insertion order)
  instead of the UUID primary key. UI was showing work orders in random order.
- **`src/db.js` — fix minor: listOpenWorkOrders LIMIT moved into SQL.** Previous
  code did `.all().slice(0,30)` — loaded every open order into memory before
  trimming. Added `LIMIT 30` in SQL.
- **`src/db.js` — fix bootstrap bug: mkdirSync on module load.** ES-module
  imports hoist; `index.js`'s `fs.mkdirSync('data/')` ran after `db.js`'s
  `new Database(config.dbPath)` had already thrown because the dir didn't exist.
  Moved the mkdir into `db.js` so any importer gets a self-bootstrapping DB.
- **`src/runner/expansion.js` — auto-resolve source nsid from the registry.**
  When the caller supplies only a namespace code (no `sourceNamespaceId`), we
  now look up the nsid in the loaded registry index before calling Identity
  Graph. Custom namespaces like `hashedKocid` were returning zero clusters when
  only `ns` was sent. Also added diagnostic log lines:
  `resolved source namespace nsid from registry` and
  `identity graph batch returned` (with linkedTotal count).
- **`src/services/identityGraph.js` — fix Adobe API contract: response shape.**
  `docs/REVIEW.md` documented a bare-array response `[{xid, identities:[...]}]`.
  Observed production response is `{version, clusters:[{compositeXid:{nsid,id},
  members:[{nsid,id}]}]}`. Old parser dropped every cluster. Rewrote to handle
  both shapes, match by `compositeXid.id` (not array position), and unpack
  `members[]` (current) OR `identities[]` (legacy). Also logs the raw response
  preview when a batch returns zero linked identities, so the next contract
  drift is visible immediately.

### Frontend

- **`src/web/styles.css` — fix: `[hidden] { display:none !important }` added.**
  The `hidden` HTML attribute maps to `display:none` via the UA stylesheet,
  but every `.auth-chip`, `#dataset-picker-wrap`, etc. had its own `display:flex`
  rule that won on specificity. Result: the "Authenticated" chip was always
  visible. Global rule now forces `hidden` to take precedence.
- **`src/web/index.html` + `src/web/app.js` — add source-namespace dropdown.**
  Previously hard-coded `sourceNamespace='hashedKocid'` in the upload form.
  Now populates a dropdown from the sandbox's namespace registry, standards
  first then customs, marked `[custom]`. Upload form posts both
  `sourceNamespace` (code) and `sourceNamespaceId` (numeric nsid). This also
  removes the CLAUDE.md limitation "Single source namespace per job" —
  technically still one namespace per job, but any namespace instead of only
  the hard-coded one. Makes the tool reusable for deleting by email, phone,
  ECID, CRMID, or any custom ID.
- **`src/web/index.html` — copy cleanup on Upload tab.** Section sub now says
  "Single-column CSV — one identifier per line, no header" (accurate after the
  `csv.js` header-detection fix).
- **`src/routes/jobs.js` — use logger, not console.error.** Submission crashes
  now go through the structured logger instead of raw stderr.

### Utilities

- **`src/utils/csv.js` — remove fragile header auto-detect.** The regex heuristic
  could silently drop a real data value that looked like a column name. Now the
  first row is only skipped if the caller passes a string `column` name
  (named-column mode).

### Tests

- **`test/hygiene.test.js`** — 27 tests covering `validateDatasetId`,
  `normalizeNamespacesIdentities`, `validateTargetServices` (100k boundary,
  profile-only mode, duplicate namespaces, empty ids, etc.).
- **`test/namespaces.test.js`** — 11 tests for `buildNamespaceIndex` and
  `canonicalizeNamespace` (including the id=0 regression case).
- **`test/imsAuth.test.js`** — 7 tests using `nock` for HTTP mocking: cache hit,
  invalidation, thundering-herd coalescing, 401 handling, error recovery.
- **`test/quotaManager.test.js`** — 9 tests for reserve/release/peek with
  over-limit, exact-limit-minus-one, floor-at-zero, sequential allocation.
- **`test/planWorkOrders.test.js`** — 10 tests covering single-cluster packing,
  cluster overflow flush, 250k giant cluster splitting into 100k/100k/50k,
  day rollover (3×70k with 150k daily cap → days 1/1/2), re-plan idempotency
  (the M2 fix), empty inputs, and identifier_count consistency.
- Test infra: two DB-backed test files (`quotaManager`, `planWorkOrders`) use
  a temp SQLite file under `os.tmpdir()` via `process.env.DB_PATH`. Dynamic
  `await import(...)` ensures env is set before module evaluation.
- Final result: **66 tests, 66 passing, 0 failing.**

### Infra / packaging

- **`package.json`** — removed the unused `zod` runtime dependency
  (CLAUDE.md said "no zod" but it was still declared).
- **`package.json`** — test script changed from `node --test test/*.test.js`
  to `node --test test`. The glob form doesn't expand on Windows cmd / PowerShell;
  the directory form works cross-platform.

### Docs

- **`docs/sample-source.csv`** — small smoke-test CSV (replaced by user with
  real hashedKocid values).
- **`docs/ARCHITECTURE.md` — new.** Living architecture overview with module
  map, data flow, Adobe contracts (corrected), SQLite schema, and agent
  orientation steps. Should be read before any code change.
- **`docs/CHANGELOG.md` — new (this file).**

### Known issues discovered but not yet fixed

Captured as Tasks #5 and #6 in the task tracker for the current session:

- **Task #4 — FIXED.** Added `bootstrap()` at the bottom of `src/web/app.js`.
  On page load it calls `/api/config/credentials`, selects the
  most-recently-used credential (server-side SQL already orders by
  `last_used_at DESC`), pre-fills the Config form state, and auto-runs
  `testConnection()` in the background to refresh sandboxes + namespaces.
  The encrypted client secret never crosses the wire — `state.config.clientSecret`
  stays `'(unchanged)'` and the test flow uses the stored `credsId`. User
  refreshes the page → lands on Config with the last session's environment
  already live. Task #4 closed.
- **Task #5** — No monthly quota tracking. Adobe enforces both daily and
  monthly caps; today we only track daily. Over-monthly submissions fail at
  Adobe with a 400 instead of deferring locally.
- **Task #6** — Crashed jobs don't auto-recover. `expanding` jobs need
  manual re-upload (dedup prevents double work, but the CSV is re-scanned
  from row 0). `submitting` work orders with no `adobe_workorder_id` after a
  restart are ambiguous — we don't know if Adobe received the POST.

### Also discovered during live run

- **Transient DNS / 504 errors during monitor polling** (`getaddrinfo
  ENOTFOUND platform.adobe.io`, `504 Gateway Timeout`) — retry logic handles
  both correctly; not a bug. Network intermittency and Adobe-side 5xx recover
  automatically on the next 60s tick or through `axios-retry`'s backoff.
- **OneDrive-hosted `data/`** — the user installed the project inside a
  OneDrive-synced path. Not blocking today, but noted as a future gotcha: if
  OneDrive locks `state.db` during sync we'd see `SQLITE_BUSY`. Moving
  `data/` outside OneDrive avoids this.
