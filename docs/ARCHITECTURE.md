# Architecture — AEP Data Lifecycle Helper

> **Read this first** before proposing any change. Also skim `CHANGELOG.md` for
> what's changed recently, and `CLAUDE.md` for the full list of invariants. If
> your change touches an Adobe payload, read the relevant section of `REVIEW.md`.

---

## 1. What this tool is

A single-process Node.js helper that runs on an operator's laptop, takes a CSV
of source identifiers (typically `hashedKocid`, but any namespace works now),
expands each through Adobe's Identity Graph, packs the resulting identities
into work orders ≤ 100k each, and submits them to the Data Hygiene record-delete
API. Destructive. Irreversible. Every invariant in `CLAUDE.md` exists because
getting it wrong deletes real customer data.

**Runtime requirement: Node.js 20 LTS** (`engines: ">=20.0.0"` in `package.json`).
The tool uses `node --test` (built-in test runner, Node 18+), `node --watch`
(Node 18+), and `better-sqlite3` (native addon, must compile during `npm install`).
Node 20 is the minimum version where all three are stable together.

- **Windows**: install via [nvm-windows](https://github.com/coreybutler/nvm-windows/releases)
  (`nvm install 20 && nvm use 20`). Move `data/` outside OneDrive — see README §Install.
- **Linux / macOS**: install via [nvm](https://github.com/nvm-sh/nvm)
  (`nvm install 20 && nvm alias default 20`).

Verify with `node --version` (must print `v20.x.x` or higher) before `npm install`.

---

## 2. Topology

```
                ┌─────────────────── 127.0.0.1:3000 ──────────────────────┐
                │  helmet + hostHeaderGuard + originRefererGuard          │
                │                                                         │
  ┌─────────┐   │  ┌──────────────┐      ┌──────────────────────────┐    │
  │ Browser │◀──┼─▶│  Express API │◀────▶│   In-process runners      │    │
  │ UI (JS) │   │  │  /api/*      │      │  • expansion (p-limit 10) │    │
  │         │   │  │              │      │  • submission (p-limit 2) │    │
  │  HTML/  │   │  │              │      │  • redistributor          │    │
  │  CSS/JS │   │  │              │      │    (Phase 2; runs inside  │    │
  │  modal+ │   │  │              │      │     plan + submit)        │    │
  │  toast  │   │  │              │      │  • monitor  60s tick      │    │
  │         │   │  │              │      │  • scheduler 60s tick     │    │
  │         │   │  │              │      │    (Phase 3 auto-resume)  │    │
  └─────────┘   │  └──────┬───────┘      └───────────┬───────────────┘    │
                │         │                          │                    │
                │         ▼                          ▼                    │
                │  ┌─────────────────────────────────────────────┐        │
                │  │    SQLite (data/state.db, WAL mode)         │        │
                │  │  credentials · jobs · expanded_identities · │        │
                │  │  work_orders · sandbox_configs ·            │        │
                │  │  quota_usage · quota_usage_monthly ·        │        │
                │  │  app_settings                                │        │
                │  └─────────────────────────────────────────────┘        │
                │                                                         │
                │  In-memory: IMS token cache · /quota cache (1h)         │
                │                                                         │
                └────────────────────┬────────────────────────────────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                   ▼
        ┌──────────────────────────┐      ┌──────────────────────────────┐
        │ ims-na1.adobelogin.com   │      │ platform.adobe.io            │
        │   /ims/token/v3          │      │ platform-{region}.adobe.io   │
        │ (24h bearer tokens)      │      │   /sandbox-management        │
        │                          │      │   /catalog/dataSets          │
        │                          │      │   /idnamespace/identities    │
        │                          │      │   /identity/clusters/members │
        │                          │      │   /hygiene/quota             │
        │                          │      │   /hygiene/workorder         │
        └──────────────────────────┘      └──────────────────────────────┘
```

No distributed components. No workers. No message queue. Scalability = per-process
throughput via async I/O + bounded concurrency, which saturates Adobe's rate
limits from one machine.

Server binds to **`127.0.0.1`** (loopback only) by default. Override via
`HOST` env var if you need to expose the unauthenticated API for an SSH-tunneled
demo — never for production. See CLAUDE.md I12.

---

## 3. Data flow (happy path)

```
  0. INBOUND HTTP    Every request passes the security middleware before any
                     handler: hostHeaderGuard → originRefererGuard → helmet
                     (CSP, COOP/CORP, etc.) → express.json → router. UUID
                     param guards run inside each router (Express 4 doesn't
                     propagate `app.param`). See CLAUDE.md I13/I14.
                     The error handler at the end normalises 5xx into a
                     generic "internal_error" so raw stack/path traces
                     don't leak.

  1. CONFIG          User enters IMS creds; we encrypt+persist in SQLite.
     │               Test Connection → IMS token obtained & cached in memory.
     ▼               Sandbox list loaded. Sandbox picked → datasets + namespaces
                     loaded in parallel and cached on sandbox_configs.
                     GET /data/core/hygiene/quota fetched once (cached 1h);
                     UI banner shows Daily / Monthly consumed + remaining;
                     cap inputs auto-populated from Adobe's reported entitlement.
                     See CLAUDE.md I15.

  2. UPLOAD          User picks source namespace from dropdown (populated from
     │               the sandbox's namespace registry). CSV first passes through
     ▼               sniffUpload() (utils/csv.js) which reads the first 4 KiB and
                     rejects obvious non-CSV uploads BEFORE fast-csv runs —
                     ZIP/XLSX (PK\x03\x04), OLE compound (legacy .xls / some
                     MIP-protected files), UTF-16 BOM, PDF, empty, or >5%
                     non-printable bytes (binary / MIP-encrypted). Each rejection
                     carries an operator-actionable reason ('looks like .xlsx',
                     'looks like UTF-16', 'looks like MIP-encrypted') and the
                     route returns a clean 400 with the message in publicMessage.
                     Accepted CSV is streamed to data/uploads/. Row count passed
                     as totalSourceIds. Job row inserted, status='expanding'.

  3. EXPAND          CSV stream → 1000-ID batches → p-limit(IDENTITY_CONCURRENCY)
     │               workers POST /identity/clusters/members. Default
     ▼               concurrency is 5 (lowered from 10 on 2026-05-29 after a
                     real-world Adobe rate-limit incident; safe ceiling for
                     most orgs). Response parsed from
                     {clusters:[{compositeXid, members}]}. Each member canonicalized
                     via namespace registry index → {code, id}. Plain INSERT into
                     expanded_identities (no unique index — dedup is deferred to
                     planning time via GROUP BY in streamIdentitiesBySource).
                     Wave-based scheduling: WAVE_SIZE = concurrency × 2 tasks
                     run in parallel; onRow is async so the CSV stream pauses
                     when the wave fills, capping peak heap at O(concurrency ×
                     batchSize) regardless of job size. CRITICAL: each pushed
                     task is given an inline .catch(() => {}) BEFORE drainWave
                     attaches its handlers — without this, a network-level
                     rejection (ECONNRESET on stalled keep-alive) in the
                     pre-drain window becomes an unhandled rejection and Node
                     ≥ 17 crashes the process (real 2026-05-29 96% crash).
                     drainWave uses Promise.allSettled (not Promise.all) for
                     belt-and-braces protection of late rejections too.
                     Per-batch log line: adobeMs, sqliteMs, clustersReturned,
                     linkedTotal. Every 50 batches a summary fires with
                     {progress, p50, p95, rateLimitHits} for the window —
                     non-zero rateLimitHits is the signal to lower
                     IDENTITY_CONCURRENCY. After all waves drain, a single
                     COUNT DISTINCT query computes the true deduplicated
                     found_count and writes it via setFoundCount. Live
                     progress map in memory for the UI poll path.

  4. PLAN            Iterate expanded_identities ORDER BY source_id, ns_code.
     │               Bundle identities by cluster. Pack bundles into work orders
     ▼               (≤ 100k ids/order). Initial day_index assigned by the
                     legacy planner. Then runner/redistributor.js runs against
                     live /quota and assigns each un-shipped WO an authoritative
                     (month_index, day_index) — current month uses
                     monthly.remaining; subsequent months use the full quota.
                     Plan tab groups by Month → Day; if months > 1 OR the
                     timeline shifted from a previous plan, a pre-plan modal
                     confirms before locking in. (RQ-2: 1-month shift = toast,
                     ≥ 2-month shift = modal.) Previously-planned rows are
                     deleted first, so re-plan is idempotent.
                     SAFETY GUARD (CLAUDE.md I10): planWorkOrders() refuses
                     with ReplanForbiddenError (HTTP 409) if any work order on
                     the job is in a non-{planned,deferred,awaiting_approval}
                     state — re-emitting identity content for already-shipped
                     orders would cause duplicate irreversible deletes. The
                     redistributor is explicitly allowed to update
                     (month_index, day_index) labels on un-shipped WOs only;
                     identity content of any existing WO never changes.
                     After planning, Month 2+ WOs are immediately flipped to
                     'awaiting_approval' — they cannot ship until the operator
                     clicks "Approve Month N" in the Plan tab (see step 5a).

  5a. APPROVE        Operator-driven. For each month > 1 the Plan tab shows an
      (Month 2+)     "Approve Month N" button next to the grouped WOs.
                     POST /api/jobs/:id/approve-month { monthIndex } flips
                     'awaiting_approval' → 'planned' for that month, making
                     those WOs eligible for the next Submit run or scheduler
                     tick. Month 1 is never gated — it ships immediately on
                     the initial Submit. Idempotent: approving an already-
                     approved month returns 404 (no rows changed).

  5. SUBMIT          Pre-submit modal: shows live remaining + planned count;
     │               operator confirms each click (always shown — destructive).
     ▼               Backend then:
                       a. Re-fetch /quota with refresh: true. On hard failure
                          (no recent cache), abort with quota_unavailable 503.
                       b. Re-run redistributor against the fresh numbers
                          (un-shipped WOs may shift to a later month).
                       c. For each planned OR deferred order in the target
                          (month, day) bucket:
                            i.   reserve(imsOrgId, count, dailyLimit, monthlyLimit)
                                 — atomic SQLite UPSERT against both dimensions.
                            ii.  if granted: POST /hygiene/workorder
                                 (NON-idempotent; 5xx + network errors do NOT
                                 retry — see I11). Persist Adobe ID + log if
                                 operationCount diverges from our pre-submit
                                 total (drift detector, I15).
                            iii. if not granted: mark 'deferred'. The next
                                 submit run (after UTC daily/monthly rollover)
                                 picks up these rows alongside any new 'planned'
                                 ones.
                            iv.  on failure: DISTINGUISH the error class —
                                   • 4xx response (Adobe definitively rejected,
                                     e.g. validation error / auth / forbidden):
                                     release(count, monthlyLimit), mark 'failed'.
                                     monthlyLimit gating prevents leakage into
                                     other jobs.
                                   • 5xx / timeout / network / no response
                                     (UNCERTAIN — Adobe may have processed it
                                     after our axios call gave up): KEEP status
                                     as 'submitting', persist err.message in
                                     last_error, DO NOT release quota. The
                                     startup recovery routine (or the operator-
                                     triggered POST /api/jobs/:id/reconcile)
                                     will look the WO up by displayName and
                                     either record the real Adobe ID or roll
                                     back. This is the fix for the 2026-05-29
                                     "10 in Adobe, 7 in our UI" incident.
                     Guarded against concurrent runs via in-process inFlight Set.

  5b. RECONCILE      Operator-triggered. POST /api/jobs/:id/reconcile (also
      (on demand)    surfaced as the yellow "↻ Reconcile" banner on the Submit
                     tab whenever any WO is in submitting/failed without an
                     adobe_workorder_id). reconcileJobOrphans(jobId) walks
                     every such WO, looks each up via Adobe's list endpoint
                     filtered by the WO's displayName, and applies:
                       • match found → record Adobe ID + flip to 'submitted'
                         (if was 'failed', also re-reserve quota via direct
                         upsertQuota/upsertMonthlyQuota bypassing the cap —
                         Adobe already spent it, our ledger must mirror reality)
                       • absent + was submitting → roll back to 'planned' +
                         release quota
                       • absent + was failed     → leave as 'failed' (confirmed)
                       • Adobe 400 / network    → leave as-is, retry next time
                     No restart required; runs in-process against the same
                     adobeClient as the rest of the tool.

  6. MONITOR         setInterval(60s). Query up to 100 open work orders where
     │               adobe_workorder_id IS NOT NULL AND status NOT terminal.
     ▼               REENTRANCY GUARD: a module-level _running flag prevents
                     a new tick from starting while the previous one is still
                     in flight (real 2026-05-29 cascading-poll incident: when
                     Adobe was slow, multiple ticks piled up running in
                     parallel, each hammering Adobe with duplicate concurrent
                     polls and snowballing rate limits). Per-WO status GET
                     uses a 15-second timeout via getWorkOrder({...timeoutMs:
                     15_000}) — much shorter than the 60s global default,
                     because Adobe's GET /workorder/:id should respond in
                     <2s; failing fast and retrying next tick is better than
                     locking up a socket for a full minute. pLimit(5)
                     concurrent calls. Persist status transitions through
                     received → validated → submitted → ingested → completed.
                     Per-tick log line: monitor tick complete polled=N
                     succeeded=X failed=Y elapsedMs=Z. Per-tick credential
                     cache (Promise-keyed by creds_id) so we don't decrypt
                     the same secret 100x on a single tick.

  7. AUTO-RESUME     setInterval(60s). Reads operator-configured settings
     (Phase 3)       (enabled, localTime HH:MM, days). When shouldFireNow()
                     agrees (today's HH:MM has passed in the operator's
                     timezone AND we haven't fired since), iterates every
                     job with un-shipped WOs and calls runSubmission(jobId)
                     for each. Catch-up tick runs once on app startup so a
                     laptop that was off at the scheduled time still resumes
                     when next powered on. See CLAUDE.md I16.
```

---

## 4. Module map

```
src/
├── index.js                Express entrypoint. Mounts routes, boots monitor.
├── config.js               Env-overridable defaults (port, paths, Adobe hosts,
│                           concurrency knobs, daily cap, timeouts).
│                           sqliteCacheMb: SQLITE_CACHE_MB env var (default
│                           512 MB; use 8192 on a 32 GB laptop, 2048+ on a
│                           server — see README §Tuning for large jobs).
├── db.js                   SQLite open + schema init + prepared statements.
│                           MUST mkdir data/ before connecting (ESM hoist gotcha).
│                           Pragmas: WAL, NORMAL sync, cache_size from
│                           config.sqliteCacheMb (negative = KB), wal_autocheckpoint
│                           8000 pages (~32 MB — reduces Defender scan frequency
│                           8× vs the default 1000 page / ~4 MB threshold).
│                           expanded_identities has NO unique index (dropped at
│                           boot via migration). Dedup is done at planning time
│                           by streamIdentitiesBySource's GROUP BY clause.
│
├── middleware/             Security middleware: hostHeaderGuard, origin/
│   └── security.js         referer guard, UUID param guards, centralised
│                           error handler. Wired in src/index.js. See
│                           CLAUDE.md I13/I14 for the rationale.
│
├── services/               Thin wrappers over Adobe APIs. No business logic.
│   ├── imsAuth.js          In-memory token cache + thundering-herd guard.
│   ├── adobeClient.js      axios factory: auth injection, idempotency-aware
│   │                       retry (5xx + network errors blocked on non-idempotent
│   │                       requests; 401/429 always retry), Retry-After,
│   │                       401 → invalidate, error-body enrichment +
│   │                       per-endpoint permission hints on 403.
│   ├── sandboxes.js        GET /sandbox-management.
│   ├── datasets.js         GET /catalog/dataSets, filters to unifiedIdentity.
│   ├── namespaces.js       GET /idnamespace/identities (uses creds.region —
│   │                       see CLAUDE.md I9). + buildNamespaceIndex +
│   │                       canonicalizeNamespace (fills code from nsid or vv).
│   ├── identityGraph.js    POST /identity/clusters/members on creds.region host.
│   │                       Tagged {idempotent:true} (POST as side-effect-free
│   │                       query). Parses current shape {version, clusters:[
│   │                       {compositeXid, members}]} AND legacy bare-array.
│   ├── hygiene.js          POST /hygiene/workorder + exhaustive pre-network
│   │                       validation (datasetId, namespacesIdentities,
│   │                       targetServices). Throws WorkOrderValidationError
│   │                       before touching the wire. POST is DELIBERATELY
│   │                       non-idempotent — never retries on 5xx/network.
│   └── quotaManager.js     SQLite-backed two-dimension quota ledger.
│                           reserve(org, count, dailyLimit, monthlyLimit) and
│                           release(org, count, monthlyLimit). monthlyLimit=null
│                           skips the monthly ledger on BOTH operations.
│
├── runner/                 In-process background work.
│   ├── expansion.js        CSV stream → Identity Graph → SQLite. Wave-based
│   │                       scheduling (WAVE_SIZE = concurrency × 2); onRow is
│   │                       async so the stream pauses at each wave boundary —
│   │                       caps peak heap regardless of job size. Plain INSERT
│   │                       (no OR IGNORE) — O(1) per row; no B-tree lookup.
│   │                       After all batches finish, COUNT DISTINCT computes
│   │                       the true deduped found_count and persists it.
│   │                       Resolves source nsid from the registry when the UI
│   │                       didn't send one. Logs linkedTotal per batch.
│   ├── submission.js       Planner + quota-gated submission. Two-phase
│   │                       planner (2026-05-29 refactor): Phase 1 uses
│   │                       streaming .iterate() via prepareStreamIdentitiesBy
│   │                       Source() to read identities WITHOUT holding the
│   │                       SQLite connection (no mid-flow writes during the
│   │                       iterator) — builds the plan into a pendingOrders[]
│   │                       array. Phase 2 bulk-inserts every WO in a single
│   │                       db.transaction() so 1,500+ rows hit WAL in one
│   │                       fsync (cuts planning from minutes to seconds on
│   │                       Windows). prepareStreamIdentitiesBySource() returns
│   │                       a FRESH Statement per call — the cached one in q()
│   │                       was retired because better-sqlite3 only allows ONE
│   │                       active iterator per Statement, and the export
│   │                       route holds the iterator across writeCsv yields
│   │                       (real 2026-05-29 'statement busy' bug).
│   │                       The submission catch block DISTINGUISHES error
│   │                       classes: 4xx → mark 'failed' + release quota;
│   │                       5xx/timeout/network → KEEP 'submitting' + persist
│   │                       err.message in last_error + DON'T release quota
│   │                       (uncertain failures must be reconciled, not
│   │                       buried — see CLAUDE.md I17). inFlight Set guards
│   │                       re-entry.
│   │                       Planner exports ReplanForbiddenError and refuses
│   │                       to re-emit work orders if any are in a state past
│   │                       'planned'/'deferred'/'awaiting_approval'. After
│   │                       planning, markFutureMonthsAwaitingApproval flips
│   │                       Month 2+ WOs to 'awaiting_approval'. runSubmission
│   │                       selects both 'planned' and 'deferred'; 'awaiting_
│   │                       approval' WOs are invisible to the submitter until
│   │                       explicitly approved via the /approve-month route.
│   ├── monitor.js          setInterval(60s). REENTRANT-GUARDED via _running
│   │                       flag — tick #N+1 fires no-op if tick #N still in
│   │                       flight (2026-05-29 fix for the cascading-poll
│   │                       snowball). pLimit(5) concurrent status GETs;
│   │                       polls up to 100 open WOs per tick. Per-WO timeout
│   │                       passed as 15_000 ms via getWorkOrder({...timeoutMs})
│   │                       — not the 60s axios global — so a slow Adobe
│   │                       can't trap the tick. Per-tick credential cache
│   │                       (Promise-keyed) prevents N decrypts of the same
│   │                       secret. Per-tick log: 'monitor tick complete
│   │                       polled=N succeeded=X failed=Y elapsedMs=Z'.
│   │                       stopMonitor() exposed for graceful shutdown.
│   ├── scheduler.js        Configurable auto-resume scheduler (Phase 3,
│   │                       2026-05-15). setInterval(60s) tick that fires
│   │                       when shouldFireNow() agrees with the operator's
│   │                       HH:MM-local-time + days policy and we haven't
│   │                       already fired since today's window. Iterates
│   │                       every job with un-shipped WOs and calls
│   │                       runSubmission(jobId), which itself re-fetches
│   │                       /quota + re-buckets via the redistributor.
│   ├── redistributor.js    Month-aware re-bucketer (Phase 2). Walks un-
│   │                       shipped WOs in rowid order and assigns
│   │                       (month_index, day_index) from live Adobe quota
│   │                       remaining + fresh future-period caps. Atomic
│   │                       SQLite transaction. Shipped WOs are immutable.
│   └── recovery.js         Startup reconciliation AND per-job operator-
│                           triggered reconciliation. Exports:
│                             • resumeExpandingJobs() — resumes 'expanding'
│                               jobs with skipSourceIds set from
│                               expanded_identities (no re-doing Adobe calls
│                               for rows already processed).
│                             • reconcileOrphanWorkOrders() — startup path,
│                               scans status='submitting' AND
│                               adobe_workorder_id IS NULL across all jobs.
│                             • reconcileJobOrphans(jobId) — per-job route
│                               POST /api/jobs/:id/reconcile. Scans status
│                               IN ('submitting','failed') AND no Adobe ID.
│                               For previously-'failed' matches, re-reserves
│                               quota via direct upsertQuota / upsertMonthly
│                               (bypasses cap — Adobe spent it, ledger must
│                               mirror reality).
│                           All paths share findAdobeWorkOrderByDisplayName
│                           Prefix. On 400 (filter not supported / indeterminate)
│                           the orphan is LEFT in 'submitting' so the next call
│                           retries — never rolled back, because rollback risks
│                           duplicate
│                           submission if Adobe actually had received the POST.
│
├── routes/
│   ├── config.js           Credential CRUD + test.
│   │                       - POST   /api/config/credentials       (create / upsert)
│   │                       - PATCH  /api/config/credentials/:id   (update label,
│   │                         client_name, region only — never touches the
│   │                         encrypted secret or identity fields)
│   │                       - DELETE /api/config/credentials/:id   (returns 409 if
│   │                         any job references this credential — protects job
│   │                         status polling and recovery from being orphaned)
│   │                       - POST   /api/config/credentials/test  (IMS auth check)
│   ├── adobe.js            Sandbox/dataset/namespace discovery endpoints.
│   ├── upload.js           multipart CSV → job + expansion kickoff.
│   └── jobs.js             Job detail, plan, submit, progress, export.
│                           - POST /api/jobs/:id/approve-month — flips
│                             'awaiting_approval' → 'planned' for a given
│                             monthIndex (≥ 2). Returns 400 for monthIndex=1
│                             (auto-submitted, no approval needed) or invalid
│                             values; 404 when no awaiting WOs exist.
│                           - DELETE /api/jobs/:id — hard-delete the job and
│                             cascade through expanded_identities + work_orders.
│                             409 with {error:'in_flight'} when any WO is
│                             mid-flight to Adobe (status ∈ submitting /
│                             submitted / received / validated / ingested).
│                             ?force=true bypasses the in-flight guard;
│                             Adobe-side deletions continue but local
│                             tracking is dropped. Best-effort unlinks
│                             upload + exported CSV.
│                           - POST /api/jobs/:id/reconcile — per-job orphan
│                             reconciliation. Calls reconcileJobOrphans(id);
│                             scans WOs with adobe_workorder_id IS NULL AND
│                             status ∈ submitting/failed; looks each up in
│                             Adobe by displayName; matched → record ID +
│                             flip to 'submitted' (re-reserve quota if was
│                             failed); absent → roll back submitting to
│                             planned (release quota) OR leave failed as-is;
│                             indeterminate → leave alone. Returns
│                             { matched, rolledBack, stillFailed,
│                             indeterminate, perWoError, total }.
│                           Two list endpoints:
│                           - GET /api/jobs           — flat list, every status
│                           - GET /api/jobs/monitor   — active-submissions feed:
│                             only jobs with ≥1 Adobe-acked work order. Sort
│                             priority: (in_flight_count > 0) DESC then
│                             max(work_orders.updated_at) DESC — in-flight
│                             jobs always come first so a recently-completed
│                             job can't push pending work off-screen. Returns
│                             { rows, totals, sandboxes } in one payload:
│                             rows = enriched (limit-capped); totals = job-
│                             level counts (in_flight / has_failed /
│                             all_completed / total) across ALL matching
│                             jobs; sandboxes = distinct sandbox list with
│                             per-sandbox counts for the filter chip row.
│                             Filters: ?search=… ?sandbox=…
│
├── utils/
│   ├── csv.js              Streaming CSV in/out. First row is data unless the
│   │                       caller passes a string column name (header mode).
│   ├── crypto.js           AES-256-GCM envelope encryption for client secrets.
│   │                       decryptCreds() returns region alongside id/secret
│   │                       so Identity API callers route to the right host
│   │                       (CLAUDE.md I9).
│   └── logger.js           Text or JSON output; LOG_LEVEL env.
│
└── web/                    Zero-build vanilla JS UI.
    ├── index.html          AEP Spectrum-styled templates.
    │                       Active-credential picker bar at the top of the
    │                       Configuration card with dropdown + "+ Add new" +
    │                       "⊗ Remove". Identity-fields lock indicator with an
    │                       "✏ Edit identity fields" link. Page-header wrapper
    │                       with a subtle purple→peach gradient. Favicon link.
    ├── styles.css          Spectrum tokens. Global [hidden]{display:none!important}
    │                       rule so display:flex doesn't override the hidden attr.
    │                       @font-face declarations for Source Sans 3 (4 weights).
    │                       .cred-picker / .identity-lock-row / .page-header
    │                       gradient. .f-hint convention for help text below inputs.
    ├── app.js              State object + fetch-based API calls + step navigator.
    │                       Credential-picker functions: refreshCredPicker,
    │                       addNewCredentialFlow, removeCurrentCredential,
    │                       applyIdentityLockState. Save & Continue PATCHes when
    │                       the active cred has unsaved label/client-name/region
    │                       edits; POSTs (creates) when in Add-new mode.
    ├── aep-icon.svg        Local copy of the AdobeExperiencePlatform mark
    │                       (top bar + favicon).
    ├── data-cleansing-icon.svg  Adobe's official Data Cleansing icon, used
    │                       inside the sidebar app block via CSS mask so the
    │                       gradient tile shows it in white.
    └── fonts/              Self-hosted Source Sans 3 woff2 (OFL-licensed, 4 weights).

test/                       node --test (via `npm test` → scripts/run-tests.mjs,
                            which enumerates test/*.test.js and sets a stable
                            test ENCRYPTION_KEY). 227 tests covering hygiene
                            validators,
                            namespace canonicalization, IMS token cache, quota
                            atomicity (incl. monthly-disabled release gating),
                            planWorkOrders cluster packing + day rollover +
                            idempotent re-plan + replan guard, deferred-row
                            surfacing, region routing per credential, idempotency-
                            aware retries (5xx/network blocked on hygiene POST),
                            recovery on missing/indeterminate Adobe responses,
                            adobeClient error-body enrichment, credentials
                            routes (PATCH non-secret-only safety + DELETE 409),
                            Monitor-tab listMonitorJobs feed (in-flight-first
                            sort, aggregates, sandbox filter), the 2026-05-12
                            security review fixes (host/origin guards, region
                            allowlist, CSV formula sanitiser), Phase 1 quotaApi
                            (cache + stale fallback + 24h hard floor), Phase 2
                            redistributor (4M/10M scenarios + live-quota shifts
                            + shipped-WO immutability), Phase 3 scheduler
                            (shouldFireNow gates + nextFireTime projection +
                            route validation).

docs/
├── ARCHITECTURE.md         This file. Living overview.
├── CHANGELOG.md            Append-only session log.
├── REVIEW.md               Full code-review brief + exact Adobe contracts.
└── sample-source.csv       Tiny test CSV for smoke-testing on dev sandboxes.

data/                       Runtime state; in .gitignore.
├── state.db                SQLite (WAL).
├── .key                    AES-256 key (chmod 600, auto-generated first run).
├── uploads/                Streamed CSV uploads.
└── output/                 Exported identity CSVs.
```

---

## 5. Adobe API contracts — quick reference

**IMS** `POST https://ims-na1.adobelogin.com/ims/token/v3` — client_credentials grant, returns bearer token with ~24h expiry. Cached in `imsAuth.js`.

**Sandboxes** `GET platform.adobe.io/data/foundation/sandbox-management/` — no x-sandbox-name header (org-wide).

**Datasets** `GET platform.adobe.io/data/foundation/catalog/dataSets` — returns a dict keyed by id. We filter to `tags.unifiedIdentity: ["enabled:true"]`.

**Namespaces** `GET platform-{region}.adobe.io/data/core/idnamespace/identities` — region-scoped. Returns an array of `{id, code, name, idType, custom, status}`.

**Identity Graph** `POST platform-{region}.adobe.io/data/core/identity/clusters/members`
- Request: `{ compositeXids:[{ns,nsid,id}], "graph-type": "Private Graph" }`
- **Current response** (AEP v1.1.0, observed): `{ version, clusters:[{compositeXid:{nsid,id}, members:[{nsid,id},...]}] }` — members have no `ns` code; canonicalize via registry.
- **Legacy response** (older regions may still emit): bare array `[{xid, identities:[{ns,nsid,id}]}]`.
- Matching: STRICTLY by `compositeXid.id` (no positional fallback, review R4 #2). Fails closed on any unmatched source, on `unprocessedXids`/`unprocessedNids`, or on an unrecognized shape.

**Work order** `POST platform.adobe.io/data/core/hygiene/workorder`
- See CLAUDE.md I1 for the exact payload contract. Key rules: `action: "delete_identity"`, `datasetId` ∈ `ALL` | single | comma list, `targetServices` iff `datasetId === "ALL"`, total ids ≤ 100k, each namespace group identified by `code` OR `id` OR both.

**Work order status** `GET platform.adobe.io/data/core/hygiene/workorder/{id}` — terminal states are `completed` and `failed`. Called from `monitor.js` with a per-request 15s timeout (not the 60s global default).

**Work order lookup by displayName** `GET platform.adobe.io/data/core/hygiene/workorder?displayName={prefix}` — used by both the startup `reconcileOrphanWorkOrders` path and the operator-triggered `POST /api/jobs/:id/reconcile` route to find WOs that Adobe processed but our local DB never recorded the ID for. Match is by EXACT displayName (the full UUID is embedded in the displayName since F-009). 400 response is treated as "indeterminate — leave the WO alone, don't roll back" because we cannot conclude absence from a rejected query.

**Quota** `GET platform.adobe.io/data/core/hygiene/quota`
- Org-wide (no `x-sandbox-name`); read-only — consumes no quota.
- Response: `{ quotas: [ { name, consumed, quota, description }, ... ] }`.
- Names: `dailyConsumerDeleteIdentitiesQuota`,
  `monthlyConsumerDeleteIdentitiesQuota`, `datasetExpirationQuota`.
- Adobe documented caps: 100k identifiers/work order; 1M identifiers/day
  (subject to monthly remaining); monthly varies by entitlement
  (2M without Shield / 15M with Shield, whichever is less of fixed cap
  or 5%/10% of addressable audience). Resets at 00:00 GMT (daily) and
  00:00 GMT on the 1st of each calendar month; unused quota does NOT
  carry over. See CLAUDE.md I15.

---

## 6. SQLite schema — at a glance

| Table | Purpose | Key constraints |
|---|---|---|
| `credentials` | AES-GCM encrypted secrets | UNIQUE(environment, ims_org_id, client_id) |
| `sandbox_configs` | Cached sandbox metadata + datasets + namespaces | PK(creds_id, sandbox_name) |
| `jobs` | One per upload. Status: created → expanding → expanded → ready → submitting → submitted/partial/failed. `projected_months` (Phase 2) tracks the redistributor's max month_index for shift detection. `source_column` (2026-05-31, default `'0'`) persists the upload-time CSV column so crash-recovery resumes against the same column. | FK creds_id |
| `expanded_identities` | One row per (cluster member, source). No unique index — dedup deferred to planning via `GROUP BY` in `streamIdentitiesBySource`. Only `idx_ei_job_source(job_id, source_id)` remains; `idx_ei_job_ns` was dropped 2026-05-29 (proven via EXPLAIN QUERY PLAN to be redundant — every reader falls back to `idx_ei_job_source` with an identical plan). | FK job_id |
| `work_orders` | One per Adobe work order. Statuses: planned → submitting → submitted → completed/failed/deferred. `month_index` (Phase 2) + `day_index` form the bucket label assigned by the redistributor on un-shipped WOs only. `last_polled_at` (2026-05-31) is the monitor's fairness cursor so >100 open WOs all get polled (no starvation). `reserved_monthly` (2026-05-31 R2) records the effective monthly limit reserve() used, so recovery releases exactly the dimensions reserved (no monthly-ledger leak). | FK job_id, ordered by rowid |
| `quota_usage` | Per-period **adobe_floor** = Adobe's observed consumed (R4: `used` is now vestigial). Raised by `seedFloor` (MAX with live /quota) and `complete()` (additive, moving a finished WO into the floor). | PK(ims_org_id, utc_date) |
| `quota_usage_monthly` | Monthly counterpart of `quota_usage`'s `adobe_floor`. | PK(ims_org_id, utc_year_month) |
| `quota_reservations` | **Per-work-order quota reservation** (2026-05-31 R4 #1): (work_order_id) → count + utc_date + utc_year_month + active. `effective_used(period) = adobe_floor(period) + Σ active reservations(period)`. reserve/release/complete are keyed by WO id → exact + period-correct (fixes same-day ownership, cross-day, multi-month double-count). | PK(work_order_id) |
| `app_settings` | Generic key/value bag (Phase 3). First users: `auto_resume_*` keys for the scheduler. | PK(key) |

Both ledgers are incremented by `reserve()` atomically and decremented by
`release()` atomically. The `jobs` table has `daily_limit` and `monthly_limit`
columns (nullable; null monthly = "don't track monthly for this job") — but
since Phase 1 these are FALLBACK ONLY; the live Adobe `/quota` is the
runtime source of truth (CLAUDE.md I15).

---

## 7. Key invariants (full list in CLAUDE.md §Invariants)

1. Work-order payload shape is exact — validated before network.
2. Namespaces have two forms (code, nsid) — respect both; store both; send both.
3. Hard limits: 1000 ids/Identity-Graph batch, 100k ids/work order, daily cap defaults 1M, monthly default 3M.
4. Cluster members should stay together in one work order when they fit.
5. Quota reservation and release must pair in try/catch — pass `monthlyLimit` to both.
6. Client secrets are encrypted at rest.
7. Datasets shown to the user are pre-filtered to Identity-enabled.
8. `data/` is never committed — contains the encryption key and all secrets.
9. Identity API region MUST come from the credential row, not a global default — wrong region returns 200 with empty clusters and causes silent partial deletes.
10. Re-planning is forbidden once any work order has shipped — `ReplanForbiddenError` (HTTP 409) prevents duplicate irreversible deletes.
11. Adobe POST retries are gated by per-request idempotency — hygiene POST never retries on 5xx/network; identity-graph POST opts in.
12. UI loads only local assets — no third-party CDN fonts/scripts/images. Loopback-bound by default.
13. Local API has Host-header + Origin/Referer + helmet/CSP guards. Defeats DNS rebinding and simple-form CSRF.
14. Region and environment are allowlisted server-side (not just in the UI) — a stale or attacker-set `region` would template into the Identity API host and exfiltrate the bearer token.
15. Live Adobe `/quota` is the source of truth for daily + monthly caps. Refreshed before every plan + every submit; 1h cache; 24h hard floor falls back to `quota_unavailable` 503 rather than ship blind.
16. Configurable auto-resume scheduler is opt-in (defaults disabled) and routes every action through `runSubmission`, inheriting the live-quota refresh, the non-idempotent retry guard, and the orphan-recovery path.
17. `status='submitting' AND adobe_workorder_id IS NULL` has TWO MEANINGS:
    (a) POST genuinely in flight, OR (b) UNCERTAIN — POST timed out / 5xx /
    network-reset BUT Adobe may have processed it. The hygiene POST is
    non-idempotent so we can't tell which without asking Adobe. Quota stays
    reserved. Resolution comes via displayName lookup — either the startup
    `reconcileOrphanWorkOrders` path or the operator-triggered
    `POST /api/jobs/:id/reconcile` route + UI banner. The route also
    handles legacy `failed` rows (mis-marked by the pre-2026-05-29 catch-all
    `release+failed` code) and re-reserves their quota when found in Adobe.
18. Wave-pushed expansion tasks MUST be given an inline `.catch(()=>{})`
    BEFORE drainWave runs. Without this, a network-level rejection in the
    pre-drain window becomes an unhandled rejection and Node ≥17 crashes the
    process (real 2026-05-29 96% crash). drainWave itself uses
    Promise.allSettled (not Promise.all) for defence-in-depth against late
    rejections.
19. Monitor tick is NON-REENTRANT — guarded by a module-level `_running`
    flag. Per-WO status GET uses `timeoutMs: 15_000` (not the 60s global)
    so a slow Adobe doesn't allow tick N+1 to start on top of tick N.
20. UI auto-load (`ensureActiveJobLoaded`) is narrow — only loads jobs in
    `expanding` or `submitting` status (truly-in-progress, where auto-resume
    is the right call). For every other status the jobs picker shows so the
    operator explicitly chooses. Set-once-per-delete suppression flag in
    sessionStorage prevents surprise loads after an explicit Delete Job.

---

## 8. Known operational boundaries (what the tool does NOT do today)

- **Monthly quota default** — `MONTHLY_IDENTIFIER_LIMIT` env var defaults
  to 3M/mo, **but is FALLBACK ONLY since Phase 1 (2026-05-15)**. The live
  `GET /data/core/hygiene/quota` value is the runtime source of truth and
  drives both the Config UI banner and the redistributor's bucket math.
  The env var is consulted only when Adobe is unreachable AND no recent
  `/quota` cache exists.
- **Auto-resume on quota rollover** — IMPLEMENTED in Phase 3 (2026-05-15)
  via `runner/scheduler.js`, but defaults to OFF. Operator enables it on
  the Submit tab. Daily 60s tick fires at the configured HH:MM local time
  on the configured days (every-day / weekdays / first-of-month). Startup
  catch-up tick handles the "laptop was off at the scheduled time" case.
- **Crashed expansion auto-resumes** on next boot — `resumeExpandingJobs()`
  builds a Set of already-processed source IDs from `expanded_identities` and
  skips them when re-reading the CSV. Cost: holds ~50 MB per 1M processed
  sources in memory while resuming.
- **Crashed submission auto-reconciles** on next boot — `reconcileOrphanWorkOrders()`
  calls Adobe's list endpoint filtered by displayName prefix. On match →
  records the Adobe ID. On confirmed no-match (Adobe responded 200, our row
  not in the list) → rolls back to `planned` and releases quota. On transient
  error (network / 5xx) OR indeterminate (400 from list endpoint) → leaves
  the orphan in `submitting` so the next boot retries. **Never rolls back on
  400** — rolling back would risk a duplicate Adobe work order if the original
  POST had actually been processed but our listing query happened to fail.
- **Single-process only** — running two instances against the same database
  corrupts the WAL. Enforced by a single-process advisory lock (`index.js`):
  a `<dbPath>.lock` file keyed on the canonical resolved `DB_PATH` (not
  `DATA_DIR`, so two different `DATA_DIR`s sharing one `DB_PATH` still
  collide), acquired BEFORE the SQLite connection is opened, with stale-pid
  reclamation and release on shutdown (review finding #6).
- **OneDrive-hosted state.db** — if `data/` lives inside a OneDrive-synced path
  (the default install location on Windows), OneDrive can transiently lock
  files and cause SQLITE_BUSY. Safer to move the state outside OneDrive, or
  stop OneDrive sync before running heavy jobs.
- **Quota release on network timeout** — if Adobe accepted the hygiene
  work-order POST but the response was dropped (timeout / connection reset),
  we don't know if the work order was created. The retry guard in
  `services/adobeClient.js` blocks 5xx and network-error retries on
  non-idempotent requests (CLAUDE.md I11), so the hygiene POST will never
  silently double-fire. The downside is that a transient blip surfaces as
  a `failed` work order with quota released — even if Adobe actually did
  process it. The orphan-recovery routine on next startup attempts to
  reconcile by listing Adobe orders by displayName prefix; on match it
  records the Adobe ID without re-submitting.

---

## 9. Where to find what

- "Why was this decision made?" → `CLAUDE.md` invariants + `docs/CHANGELOG.md`
  for the dated story.
- "What does Adobe expect exactly?" → `docs/REVIEW.md` (exact payload shapes,
  response examples, constraints).
- "What changed most recently?" → top of `docs/CHANGELOG.md`.
- "Where is X implemented?" → §4 of this file.
- "What guarantees does the database give?" → §6 of this file plus `src/db.js`.

---

## 10. Agent orientation (for automated tools working on this codebase)

Before editing:
1. Read this file end-to-end.
2. Read the latest two sessions in `docs/CHANGELOG.md`.
3. Read any invariant in `CLAUDE.md` that's adjacent to your change.
4. If you're touching Adobe payloads, read the relevant section of `docs/REVIEW.md`.
5. Check `test/` for existing coverage of the area you're editing.

After editing:
1. Run `node --test test` and make sure all tests still pass.
2. Append a bullet to the current session in `docs/CHANGELOG.md` describing the change (why + what).
3. If you changed the module map, data flow, Adobe contract, or schema, update the relevant section of this file.
4. If you changed an invariant, update `CLAUDE.md`.
5. If you corrected a documented Adobe API behavior, update `docs/REVIEW.md`.
