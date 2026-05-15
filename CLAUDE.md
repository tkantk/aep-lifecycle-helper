# CLAUDE.md

This file is read by Claude Code (Anthropic's terminal agent) and other AI
assistants working on this repository. It captures the project's invariants,
conventions, and the reasoning behind non-obvious decisions so that changes
preserve correctness on a destructive Adobe API.

> **Critical**: this tool submits **irreversible deletion** requests to
> Adobe Experience Platform. Every assumption called out here exists
> because the wrong behaviour would silently delete customer data. If you
> are about to weaken one of these invariants, stop and ask the user first.

---

## What this tool does

Local helper for bulk identity deletion from **Adobe Experience Platform**.
Takes a CSV of `hashedKocid` source identifiers, expands each through the
**Identity Graph** to find all linked identities (email, phone, ECID, CRMID,
GAID, IDFA, custom), groups the result into work orders of ≤100,000
identifiers, and submits them to the **Data Hygiene** (record-delete) API
within Adobe's 1,000,000 identifiers/day cap.

Runs as a single Node.js process. One SQLite file for state.
**Not** deployed to Kubernetes, containers, or cloud — this is explicitly a
local helper that an operator runs on their laptop when a deletion batch
needs to happen.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│       Single Node.js process (binds 127.0.0.1:3000)         │
│                                                             │
│  Express server ─┬─▶ REST API (/api/*)                     │
│                  ├─▶ Static UI (/src/web, vanilla JS)      │
│                  │                                          │
│                  ├─▶ In-process runners:                    │
│                  │     • expansion (p-limit concurrency)    │
│                  │     • submission (quota-gated)           │
│                  │     • monitor (setInterval 60s)          │
│                  │     • recovery  (one-shot at startup)    │
│                  │                                          │
│                  ├─▶ SQLite (WAL mode, data/state.db)       │
│                  └─▶ In-memory IMS token cache              │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    Adobe Experience Platform APIs
```

The HTTP server binds to `127.0.0.1` by default — never `0.0.0.0`. Override
explicitly via `HOST` env var only when you need to expose the unauthenticated
API (e.g., SSH-tunneling for a demo). See invariant I12.

No Redis, no Postgres, no BullMQ, no worker threads. "Scalable" here
means **per-process throughput** via async I/O and bounded concurrency,
which is sufficient to saturate Adobe's rate limits from one machine.

---

## File map

```
src/
├── index.js                    Express entrypoint, startup, runner boot
├── config.js                   Config defaults + env overrides (no zod)
├── db.js                       SQLite schema + prepared statements
│
├── services/                   Thin wrappers over Adobe APIs
│   ├── imsAuth.js              IMS token cache + thundering-herd guard
│   ├── adobeClient.js          axios factory (retry, backoff, auth inject)
│   ├── sandboxes.js            GET /data/foundation/sandbox-management/
│   ├── datasets.js             GET /data/foundation/catalog/dataSets (filtered)
│   ├── namespaces.js           GET /data/core/idnamespace/identities + index
│   ├── identityGraph.js        POST /data/core/identity/clusters/members
│   ├── hygiene.js              POST /data/core/hygiene/workorder + validation
│   ├── quotaApi.js             GET /data/core/hygiene/quota (live Adobe-side
│   │                           daily + monthly counters; 1h cache; 24h hard
│   │                           floor on stale fallback)
│   └── quotaManager.js         SQLite-backed daily + monthly quota ledger
│                               (atomic reserve/release used by submission)
│
├── middleware/                 Security middleware (CLAUDE.md I13/I14):
│   └── security.js             hostHeaderGuard (DNS rebinding), origin
│                               /referer guard (CSRF), UUID param guards,
│                               centralised error handler
│
├── runner/                     In-process background work
│   ├── expansion.js            CSV stream → batched Identity Graph calls
│   ├── submission.js           Planner (with replan guard) + quota-gated
│   │                           submission. runSubmission re-fetches /quota
│   │                           and calls the redistributor before picking
│   │                           work — see I3 + I10.
│   ├── redistributor.js        Month-aware re-bucketer (Phase 2). Walks
│   │                           un-shipped WOs in rowid order and assigns
│   │                           (month_index, day_index) from live Adobe
│   │                           quota remaining + future-period fresh caps.
│   │                           Shipped WOs are immutable — see I10.
│   ├── scheduler.js            Auto-resume scheduler (Phase 3). Reads
│   │                           operator-configurable settings from
│   │                           app_settings; setInterval(60s) tick that
│   │                           fires when shouldFireNow() agrees with the
│   │                           HH:MM-local-time + days policy + not-yet-
│   │                           fired-today guard. Iterates jobs with
│   │                           un-shipped WOs via runSubmission.
│   ├── monitor.js              setInterval(60s) status poll
│   └── recovery.js             One-shot startup reconciliation of orphan work orders
│
├── routes/                     Express route modules
│   ├── config.js               Credential CRUD + test
│   ├── adobe.js                Sandbox/dataset/namespace discovery + /quota
│   ├── upload.js               CSV upload → job creation
│   ├── jobs.js                 Job detail, plan, submit, progress, export
│   └── settings.js             GET/PUT /api/settings/auto-resume
│
├── utils/
│   ├── csv.js                  Streaming CSV in/out + formula-injection
│   │                           sanitiser on writeCsv (CLAUDE.md F10)
│   ├── crypto.js               AES-256-GCM envelope encryption; O_EXCL on
│   │                           first-run key creation (F12)
│   └── logger.js               Text or JSON output
│
└── web/                        Zero-build static UI
    ├── index.html              AEP Spectrum-styled templates (also referenced
    │                           as the favicon source via <link rel="icon">)
    ├── styles.css              Spectrum tokens (gray scale, blue, red) +
    │                           @font-face decls + page-header gradient
    ├── app.js                  Vanilla JS controller (no React)
    ├── aep-icon.svg            Local AEP brand mark (top bar + favicon)
    ├── data-cleansing-icon.svg Adobe's official Data Cleansing icon (sidebar app block)
    └── fonts/                  Self-hosted Source Sans 3 (.woff2, OFL)

data/                           Created at runtime
├── state.db                    SQLite (WAL)
├── .key                        AES-256 encryption key (chmod 600)
├── uploads/                    Streamed CSV uploads
└── output/                     Exported CSVs

test/                           Integration tests (mocked Adobe via nock)
docs/                           REVIEW.md + anything else reviewers need
```

---

## Invariants (DO NOT break these)

### I1. Work-order payload shape is exact

Adobe's `POST /data/core/hygiene/workorder` accepts:

```json
{
  "action": "delete_identity",
  "datasetId": "ALL",
  "displayName": "…",
  "description": "…",
  "targetServices": ["identity", "profile", "ajo"],
  "namespacesIdentities": [
    { "namespace": { "code": "email", "id": 6 }, "ids": ["a@x.com"] },
    { "namespace": { "code": "hashedKocid" },    "ids": ["abc"] }
  ]
}
```

- `namespacesIdentities[].namespace` must have **either `code` or `id`**
  (numeric nsid). Both is best — Adobe accepts either and we supply both
  when known so custom namespaces can't collide.
- **Never** stringify an `nsid` as a fake code (e.g. `"411"`). That's
  what the old code did, and it would silently target a namespace named
  literally `"411"` — which doesn't exist, so the delete is a no-op.
- `datasetId` is exactly one of: `"ALL"` | single id | comma-separated ids.
  `"ALL"` cannot be combined with specific ids.
- `targetServices`, when present, must be exactly
  `["identity","profile","ajo"]` in any order, AND `datasetId` MUST be
  `"ALL"`. This is "profile-only mode" — deletes from profile/identity/AJO
  but leaves the data lake intact.

All of this is validated in `services/hygiene.js` via
`normalizeNamespacesIdentities`, `validateDatasetId`, and
`validateTargetServices`. **If you change those, add tests.** Adobe returns
HTTP 400 on any payload violation, but once the request goes through it's
irreversible, so we validate aggressively before calling.

### I2. Namespaces have TWO forms and we respect both

Every AEP identity namespace has:
- **`code`** (string): e.g. `"email"`, `"Phone_E.164"`, `"hashedKocid"`
- **`id`** (number): the `nsid`, e.g. `6`, `411`

The Identity Graph returns identities with varying shapes depending on the
namespace and the data path that produced them. We canonicalize everything
via `services/namespaces.js::canonicalizeNamespace()` — it takes
`{ns, nsid}` (either/both) plus an optional index and returns `{code, id}`.

`runner/expansion.js` loads the full namespace list **once per job** and
passes the index through every batch. The SQLite `expanded_identities`
table stores BOTH `ns_code` and `ns_id` so the planner can emit either or
both in the Adobe payload.

### I3. Identity batch size hard limits

- `POST /identity/clusters/members`: **max 1000 composite XIDs per call**
  (Adobe-enforced; also documented as "1500000 lookups/day in batches of
  1000 at p95 850 ms").
- `POST /hygiene/workorder`: **max 100,000 identifiers per work order**
  (Adobe-enforced hard limit).
- **Daily cap**: 1,000,000 identifiers/day (default entitlement; lower for
  some orgs, higher with Shield add-ons).

These live in `config.js` and must match Adobe's current limits. If Adobe
raises them, bump the defaults and re-run the tests.

### I4. Clusters should stay together when they fit

When the planner builds work orders, it reads identities in
`(source_id, ns_code)` order (see `db.js::streamIdentitiesBySource`). It
collects each cluster into a bundle, and when the current work order can't
hold the whole bundle, it flushes the order first and starts a new one
with the full bundle.

Clusters bigger than 100k will span multiple orders — this is acceptable
because Identity Service still resolves them to the same cluster server-side.
But the default should be to keep them together.

### I5. Quota reservation is atomic and reversible across BOTH dimensions

`services/quotaManager.js` uses SQLite transactional INSERTs with
`ON CONFLICT DO UPDATE` against two ledgers:
- `quota_usage` (daily, keyed on `utc_date`)
- `quota_usage_monthly` (monthly, keyed on `utc_year_month`)

The flow is:

1. `reserve(imsOrgId, count, dailyLimit, monthlyLimit)` checks BOTH caps.
   Denies with `reason: 'daily'` or `reason: 'monthly'` depending on which
   cap would overflow. If both pass, both ledgers are incremented.
2. If `granted === false`, the work order is marked `deferred`. Daily
   denials clear at UTC midnight; monthly denials clear at UTC first-of-month.
3. If the subsequent Adobe submission **fails**, we call
   `release(imsOrgId, count, monthlyLimit)` — decrementing the daily ledger
   always, and the monthly ledger only when `monthlyLimit != null`. Without
   this, a transient 500 would waste quota permanently.

`monthlyLimit` can be `null` (or 0 from the UI) to disable monthly tracking
for a job — useful for operators whose contract has no monthly cap. In that
mode only the daily dimension is checked, AND `release` skips the monthly
decrement so it can't eat headroom from unrelated jobs on the same org that
have monthly tracking on. **Pass the same `monthlyLimit` you passed to
`reserve` — `submission.js` and `recovery.js` both use `job.monthly_limit`.**

Any code that submits a work order MUST pair `reserve` with `release`
in a try/catch. **Exception**: on network timeout we don't know if Adobe
received the POST. `services/adobeClient.js`'s retry guard never retries
the hygiene POST on network errors OR 5xx (see I11), so the double-submit
risk is minimal, but the quota may undercount. Reconcile by checking
Adobe's actual usage if precise accounting matters.

### I6. Client secrets are encrypted at rest

`utils/crypto.js` uses AES-256-GCM with a per-row random 12-byte IV.
The encryption key lives at `data/.key` (auto-generated, chmod 600) or in
the `ENCRYPTION_KEY` env var. Never log, dump, or emit decrypted secrets
anywhere. Tokens (short-lived) stay in memory only, never written to disk.

Key file creation uses `O_EXCL` (`fs.writeFileSync(..., {flag:'wx'})`) so a
parallel boot can't race two different keys into the file. On Windows the
`mode: 0o600` is ignored by the OS — the key inherits the parent dir's ACL.
**Do not place `data/` inside a cloud-sync path (OneDrive / Dropbox / Google
Drive / iCloud).** Index.js prints a `SECURITY WARNING` at boot when it
detects one; `config.detectCloudSyncPath` recognises the common providers.
Operators should set `DATA_DIR` to e.g. `%LOCALAPPDATA%\aep-lifecycle-helper`
on Windows, or stop the sync for the folder.

**`PATCH /api/config/credentials/:id` never touches the encrypted secret
blob** (or the identity fields environment / ims_org_id / client_id —
those define the row's UNIQUE key). The PATCH route only updates label,
client_name, and region. Test in `test/credentialsRoutes.test.js` locks
this in. Re-keying a secret goes through the POST upsert path.

### I7. Datasets shown to the user are pre-filtered

`services/datasets.js` filters to `tags.unifiedIdentity = "enabled:true"`
by default. Non-Identity-enabled datasets would accept a work order but
delete nothing, so hiding them prevents a footgun. If you need the raw
list (e.g. for a diagnostic view), pass `identityOnly: false` and label
the UI clearly that the non-Identity datasets won't actually be touched.

### I8. `data/` is never committed

The `.gitignore` excludes `data/` because it contains the encryption key
and all stored client secrets. If you add a new path that holds secrets,
add it to `.gitignore` and `utils/crypto.js` if needed.

### I9. Identity API region MUST come from the credential, not a global

The Identity Service is regionally sharded — `/clusters/members` and
`/idnamespace/identities` live on `platform-{region}.adobe.io` where
`region ∈ {va7, nld2, aus5, can2}`. **A wrong-region call to `/clusters/members`
returns HTTP 200 with empty cluster data**, which means an operator on a
non-VA7 sandbox would see "no linked identities" and proceed to delete
only the source `hashedKocid` — leaving the linked email/phone/CRMID
alive. Silent partial deletes are exactly what every safety invariant
exists to prevent.

`utils/crypto.js::decryptCreds` must include `region` in its return value.
`services/namespaces.js::listNamespaces` and
`services/identityGraph.js::expandBatch` must build their endpoint URL
from `creds.region` — not `config.aep.identityRegion`. The global config
is only the fallback when a credential row was inserted before the
region column existed. Tests in `test/region.test.js` lock this in.

### I10. Identity content of a shipped work order is immutable; day/month labels are not

`runner/submission.js::planWorkOrders` reads from `expanded_identities`
and emits work orders for every identity in the table — it has no notion
of "which identities have already shipped to Adobe". So a second `/plan`
call after submission would re-emit work orders for identities Adobe
already received, and the next Submit would create **duplicate
irreversible deletes**.

The planner refuses by throwing `ReplanForbiddenError` (HTTP 409)
when any work order on the job is in a state other than `planned` or
`deferred`. Deferred is fine — those rows never went to Adobe. The UI
in `web/app.js` mirrors the guard: the Plan tab no longer auto-POSTs
`/plan` on tab entry, and the "↻ Re-plan" button auto-disables once any
order has shipped, with a tooltip explaining why.

**Phase 2 refinement (2026-05-15):** `runner/redistributor.js::redistributeUnshippedOrders`
is allowed to update `(day_index, month_index)` on un-shipped (planned /
deferred) work orders to match the live Adobe `/quota`. This is *not*
re-planning — the `namespaces_identities` JSON (the actual identity
content) of any existing WO never changes. Only the bucket labels do.
Shipped WOs are read-only. The redistributor runs:
- at the end of `planWorkOrders` (so plan time uses live quota),
- at the top of every `runSubmission` call (so each submit uses fresh quota),
- and, in Phase 3, on the configurable auto-resume scheduler tick.

If you add new flow that mutates work-order state, ensure the planner's
guard sees it. If you add new statuses, decide whether they should be
on the "safe to re-plan / re-bucket" list (currently `planned` and `deferred`).

### I11. Adobe POST retries are gated by a per-request idempotency flag

`services/adobeClient.js::retryCondition` distinguishes idempotent from
non-idempotent requests:
- **GETs** are always idempotent.
- **Non-GETs** default to **non-idempotent**. Pass `{ idempotent: true }`
  in the axios config to opt back in.
- Non-idempotent requests do NOT retry on 5xx or network errors. They
  DO retry on 401 (token refresh) and 429 (rate limit), because those
  unambiguously mean Adobe didn't process the request.
- Idempotent requests retry the full set (5xx + 401 + 429 + network).

Concretely:
- **`services/hygiene.js`** — POST `/hygiene/workorder` is **deliberately
  not idempotent**. A 5xx after Adobe partly processed the request must
  not auto-retry; that would create a duplicate irreversible work order.
  The orphan-recovery path (`runner/recovery.js`) is the safe
  reconciliation route on next startup. **Do not add `idempotent: true`
  to this call site.** A comment marks it.
- **`services/identityGraph.js`** — POST `/clusters/members` opts in via
  `{ idempotent: true }`. It's a side-effect-free query despite using
  POST (the body just carries XID lookups), so retrying transient 5xx
  is safe and useful.

### I12. UI loads only local assets

The CLAUDE.md rule "Never add telemetry, analytics, or outbound calls
beyond the documented Adobe endpoints" applies to the browser too, not
just the server. The HTML page must not load fonts, scripts, styles,
analytics pixels, or images from any third-party CDN. Every asset lives
under `src/web/`.

This means:
- **Fonts**: Source Sans 3 woff2 files are committed at `src/web/fonts/`
  (OFL-licensed). The `@font-face` blocks in `styles.css` reference local
  paths only — never `fonts.googleapis.com` or `use.typekit.net`.
- **Logo**: `src/web/aep-icon.svg` is a local copy of the AEP brand mark
  extracted from Adobe's HeroIcons sprite. Never `<img src="https://cdn...">`.
- **No analytics, no Sentry, no telemetry** — even one image-pixel beacon
  leaks user-agent + IP to a third party from a destructive admin tool.

If you find yourself wanting to load anything from a third-party origin,
download it and ship it. Disk space is fine; offline correctness is the
goal.

### I13. Local API has Host-header + Origin/Referer + helmet guards

The local server binds 127.0.0.1 (I12 / `config.host`) but the API has no
human authentication and no API token. That alone is not enough to keep a
random web page the operator has open from driving destructive Adobe
deletions. Three guards in `src/middleware/security.js` are mandatory:

- `hostHeaderGuard` — rejects requests whose Host header is not localhost
  / 127.0.0.1 / [::1]. **This is the only defense against DNS rebinding**
  (a malicious page that resolves attacker.com to its real IP, serves JS,
  then re-resolves to 127.0.0.1 — the browser then talks to localhost
  thinking it's still same-origin with attacker.com, but the Host header
  it sends is still `attacker.com`). Without this guard, the destructive
  API is reachable from any browser tab the operator opens.
- `originRefererGuard` — on POST/PUT/PATCH/DELETE, the Origin (or Referer
  fallback) host must match the request's own Host. Closes simple-form
  CSRF: a `<form action="http://localhost:3000/api/jobs/:id/submit">`
  posted from cross-origin would otherwise fire all planned work orders.
- `makeErrorHandler` — 5xx responses surface a generic message (raw
  `err.message` from better-sqlite3 / `fs` errors leaks absolute paths);
  4xx responses use the route-set `code` + `publicMessage`.

helmet is mounted with CSP `script-src 'self'` (no inline scripts;
`index.html` complies), `style-src 'self' 'unsafe-inline'` (existing
inline `style="…"` attrs), `frame-ancestors 'none'`, `object-src 'none'`,
COOP/CORP `same-origin`. **Don't loosen the CSP without justification.**

Regression tests live in `test/security.test.js`.

### I14. Region and environment are allowlisted server-side

`region` and `environment` on a credential row flow into a URL host and
into validation logic respectively. The UI dropdowns enforce a fixed set
client-side, but the server MUST also enforce the same lists — otherwise
a CSRF/rebinding attacker (or any future direct DB write) can set
`region = "evil.com#"` and template the bearer token into a host they
control. Validators in `src/routes/config.js`:

```
ALLOWED_REGIONS       = {va7, nld2, aus5, can2}
ALLOWED_ENVIRONMENTS  = {Production, Stage, Development}
```

Belt-and-suspenders allowlist checks in `src/services/identityGraph.js`
and `src/services/namespaces.js` refuse to build an Identity URL if a
stale DB row carries a bad region. **Update both the routes/config.js
list and the two services lists together** when Adobe adds a new region.

Route handlers also validate string lengths and reject control characters
(CR/LF/null) in `imsOrgId`, `clientId`, `clientSecret`, etc. — those flow
into HTTP headers downstream.

### I15. Live Adobe `/quota` is the source of truth for daily + monthly caps

`services/quotaApi.js::getOrgQuota(creds)` calls
`GET /data/core/hygiene/quota` and returns
`{ daily: {consumed, quota, remaining}, monthly: {consumed, quota, remaining},
  fetchedAt, stale, error }`. This endpoint is per-organization (Adobe doc
doesn't require `x-sandbox-name`) and **read-only — it consumes no quota
to call it**, so we refresh aggressively:

- After Test Connection succeeds (UI banner).
- Before every plan (`POST /api/jobs/:id/plan`).
- Before every submit run (`runSubmission` fetches with `refresh: true`).
- On every scheduler tick (I16).
- Hourly background — the 1-hour in-memory cache is keyed by `imsOrgId`.

Stale-cache fallback: a failed live fetch keeps the last cached value with
`stale: true` and the error message. **24-hour hard floor**: if the cache
is older than that (or doesn't exist), `getOrgQuota` re-raises with
`err.code = 'quota_unavailable'`. Plan and Submit routes block at 503 in
that case rather than ship blind.

The job-row `daily_limit` / `monthly_limit` columns are now FALLBACK only —
used when Adobe `/quota` isn't reachable AND no cache exists. Live values
always supersede them at runtime. The `config.dailyIdentifierLimit` and
`config.monthlyIdentifierLimit` env vars are second-tier fallbacks.

Adobe's `operationCount` in the POST work-order response is logged when it
diverges from our pre-submit `total` — drift detector for identifier-
counting discrepancies without needing a live delete to verify.

### I16. Configurable auto-resume scheduler is opt-in and routes through `runSubmission`

`runner/scheduler.js` provides a setInterval(60s) tick that resubmits
deferred work when the operator-configured local HH:MM passes on an
allowed day (every-day / weekdays / first-of-month). Settings live in the
`app_settings` table (keys prefixed `auto_resume_*`):

- `auto_resume_enabled`        — `'true'` / `'false'`, default disabled
- `auto_resume_local_time`     — HH:MM, default `'09:00'`
- `auto_resume_days`           — `'every-day' | 'weekdays' | 'first-of-month'`
- `auto_resume_last_run_at`    — ISO timestamp; written by the scheduler only
- `auto_resume_last_run_summary` — JSON written by the scheduler only

`startScheduler()` runs a catch-up tick at boot so a laptop that was off
at the scheduled time still resumes within seconds of starting the app.
Per-tick reentrancy is blocked by a `running` flag; per-job reentrancy
is the existing `inFlight` Set in `runSubmission`. The scheduler routes
EVERY action through `runSubmission`, which means it inherits:
- The live `/quota` refresh + redistribute (I15 + I10).
- The non-idempotent retry guard (I11).
- The orphan-recovery path (`reconcileOrphanWorkOrders`).

`PUT /api/settings/auto-resume` validates `enabled` (boolean), `localTime`
(HH:MM regex), `days` (enum membership). `lastRunAt` / `lastRunSummary`
are NOT writable via the route — only the scheduler updates them.

---

## Conventions

### Code style

- **ES modules** (`.js` with `"type": "module"` in package.json). No CommonJS.
- **No TypeScript**. This stays deliberately simple — one-file services,
  JSDoc types where helpful.
- **No build step**. The UI loads raw HTML/CSS/JS served by Express.
  The backend runs directly via `node src/index.js`.
- **No bundlers, transpilers, or framework**. If a dependency needs a build
  step to work, don't add it.
- **better-sqlite3** is the ONLY persistence. It's synchronous and ~10x
  faster than async sqlite for our workload.

### Dependencies

When adding a dep, prefer:
- Standard Node APIs (streams, crypto, url, etc.)
- Small, single-purpose libs (`p-limit`, `fast-csv`, `axios-retry`)

Avoid:
- ORMs (we write raw SQL in prepared statements)
- Request/response frameworks beyond Express (no NestJS, Fastify, etc.)
- Big batteries-included libs if a 50-line implementation will do

### Error handling

- All Adobe API calls go through `services/adobeClient.js`, which handles
  401/429/5xx retry + exponential backoff + `Retry-After` honoring,
  **gated by per-request idempotency** (see I11).
- Adobe error bodies are extracted (`detail` / `message` / `error_description`
  / `error_message` / `title` / `error` / `errors[].message`) and replace
  axios's generic "Request failed with status code 403". On 403 specifically,
  a URL-aware permission hint is appended (e.g., "needs Data Hygiene product
  profile + Delete Record permission"). Original axios message preserved on
  `err.originalMessage`. Tests in `test/adobeClient.test.js`.
- Validation errors throw `WorkOrderValidationError` (in `hygiene.js`) —
  these are pre-network and safe.
- Runtime errors from the Adobe API bubble up; the runner catches them,
  marks the work order `failed`, stores the error message, and releases
  the quota reservation (passing the job's `monthly_limit` so monthly
  decrement is gated correctly — see I5).

### Logging

Structured events via `utils/logger.js`. Never log:
- Client secrets (even partial)
- Full access tokens (prefix OK for debugging: `token.slice(0, 12) + '…'`)
- Full identifier lists (use counts instead: `{total: 123456}`)

### Testing

- Unit tests in `test/*.test.js` using `node --test` and `nock` for mocking.
- Live smoke test at `test/smoke.live.js` — requires real creds via env
  vars. Gated by `SMOKE_SUBMIT=1` so nobody runs a real deletion by mistake.
- When you change payload-building code (hygiene.js, identityGraph.js,
  namespaces.js), add or update a test.

---

## Build/run/test commands

```bash
npm install        # compiles better-sqlite3 native binding
npm start          # runs src/index.js, opens browser
npm run dev        # auto-restart on file changes
npm test           # integration tests (mocked Adobe)

# Reset all state (deletes creds + jobs + encryption key):
rm -rf data/
```

---

## Current known limitations

These are deliberate trade-offs, not bugs. If you "fix" them, check with
the maintainer first — they may actually be intended.

- **Single-process.** No distributed coordination. Running two instances
  against the same `data/state.db` will corrupt the WAL. If a user needs
  concurrency, they run multiple sandboxes in one instance.
- **In-memory token cache.** Tokens don't survive a restart. This is fine
  — refresh takes ~300 ms and happens automatically.
- **No user auth on the local web UI.** Server binds to `127.0.0.1` by
  default (see I12 / `config.host`); the UI trusts whoever reaches the
  loopback socket. Setting `HOST=0.0.0.0` exposes the unauthenticated
  destructive API to the LAN — only do so for SSH-tunneled demos and
  add real auth before that, never for production use.
- **Source CSV rows must be one identifier per column.** Multi-identifier
  rows (e.g. CSV with both kocid and email) aren't supported yet. The
  `streamIds` util reads a single column.
- **Single source namespace per job.** All rows in the CSV are treated as
  belonging to whichever namespace the user picks in the Upload-tab dropdown
  (defaults to `hashedKocid` if it exists in the sandbox's registry). If you
  need mixed-namespace sources, split the CSV per namespace and run separate
  jobs. The backend also auto-resolves the numeric `nsid` from the namespace
  registry when the UI sends only a code, so custom namespaces work reliably.
- **Monitor polls every 60s.** No webhook support — Adobe doesn't emit
  webhooks for work-order status, so polling is the only option. The
  interval is the `POLL_INTERVAL_MS` constant at the top of
  `runner/monitor.js` (not env-configurable today). Edit there if you
  want a different cadence.

---

## Things a future change might need

These are NOT yet implemented but are worth flagging if the user asks:

1. **Namespace-qualifier strictness from the /workorder.** If a dataset
   stores both primary and secondary identities, Adobe only matches on
   the schema's primary identity. Failing rows are silently skipped. We
   could pre-check schema primaries via the XDM API and warn.
2. **Multi-file upload.** Currently one CSV per job. A "batch import" of
   a folder would help ops running many deletions per day.
3. **Audit export.** We have `api_audit` in the schema but no write path
   yet. If the client needs SOC-style audit logs, wire logging in
   `adobeClient.js` to insert one row per Adobe call.
4. **Implement the recovery list-without-filter fallback.** When Adobe's
   `GET /hygiene/workorder?displayName=…` returns 400, the recovery
   path currently leaves the orphan in `submitting` (safer than rolling
   back, since rolling back risks duplicates). The originally documented
   fallback was to list recent orders without the filter and match
   client-side. Add it if Adobe ever breaks the displayName filter for
   real and we need automated recovery rather than operator triage.

**Already done (don't ask again):**
- Resume a job across restarts — `runner/recovery.js::resumeExpandingJobs`
  rebuilds `expanded_identities` source-ID set and resumes via
  `runExpansion(... skipSourceIds)`. Tests in `test/recovery.test.js`.

---

## Adobe endpoints cheat sheet

Full details in `docs/REVIEW.md`. Quick reference:

| Method | URL                                                                   | Purpose                               |
|--------|-----------------------------------------------------------------------|---------------------------------------|
| POST   | `/ims/token/v3`                                                       | IMS access token (client_credentials) |
| GET    | `/data/foundation/sandbox-management/`                                | List sandboxes                        |
| GET    | `/data/foundation/catalog/dataSets`                                   | List datasets (filter by tags)        |
| GET    | `/data/core/idnamespace/identities`                                   | List identity namespaces              |
| POST   | `/data/core/identity/clusters/members`                                | Expand cluster (region-scoped host)   |
| POST   | `/data/core/hygiene/workorder`                                        | Create record-delete work order       |
| GET    | `/data/core/hygiene/workorder/{id}`                                   | Poll work-order status                |

Local API surface (under `/api/`, loopback only):

| Method | URL                                | Purpose                                                                  |
|--------|------------------------------------|--------------------------------------------------------------------------|
| GET    | `/api/config/credentials`          | List saved credentials (no secrets in response)                          |
| POST   | `/api/config/credentials`          | Create or upsert credential (encrypts secret at rest)                    |
| PATCH  | `/api/config/credentials/:id`      | Update label / client_name / region only — never touches secret/identity |
| DELETE | `/api/config/credentials/:id`      | Remove credential. Returns 409 if any job references it.                 |
| POST   | `/api/config/credentials/test`     | IMS auth check via stored id or inline creds                             |
| GET    | `/api/jobs?limit&offset`           | List jobs by `created_at DESC` (every status, every sandbox)             |
| GET    | `/api/jobs/monitor?limit&search&sandbox` | **Active-submissions feed** for the Monitor tab. Returns `{ rows, totals, sandboxes }`. Rows are jobs with ≥1 Adobe-acked work order, sorted **in-flight-first** (`(in_flight_count > 0) DESC`) then by `latest_activity_at DESC` so still-pending jobs never get pushed off-screen by recently-completed ones. Optional sandbox filter. `totals` are job-level dashboard counts (`in_flight` / `has_failed` / `all_completed` / `total`) across ALL matching jobs (not capped by limit). `sandboxes` is the distinct sandbox list (with per-sandbox job counts) for the filter chip row. |

Host: `https://platform.adobe.io` for everything **except** Identity APIs,
which require `https://platform-{region}.adobe.io` (region ∈ `va7`, `nld2`,
`aus5`, `can2`).

---

## If Claude is asked to modify this project

1. **Read `docs/ARCHITECTURE.md` first.** It's the living system overview —
   module map, data flow, Adobe contracts, schema. Agents should orient here
   before touching any code.
2. **Read the latest entries in `docs/CHANGELOG.md`.** Recent changes often
   answer "why is it this way?" before you propose reverting them.
3. **Read `docs/REVIEW.md`** if your change touches any Adobe payload.
4. Find the relevant invariant above. If your change would break it, say so
   to the user before proceeding.
5. When in doubt, prefer **rejection at validation time** over relying on
   Adobe's response. Adobe's error messages can be cryptic and a 400 still
   costs a round-trip.
6. Never add telemetry, analytics, or outbound calls beyond the documented
   Adobe endpoints.
7. Run `node --test test` before suggesting a change is done. **113 tests
   should pass** (as of the 2026-04-28 in-flight-first + sandbox-filter
   session).
8. **After your change**, append a bullet to the current session in
   `docs/CHANGELOG.md` describing what + why. If you changed the module map,
   data flow, Adobe contract, or DB schema, also update `docs/ARCHITECTURE.md`.
   If you changed an invariant, update this file.
