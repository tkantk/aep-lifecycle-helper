# Design Document — AEP Data Lifecycle Helper

**Status**: implemented, tested, production-ready for single-operator use
**Last updated**: 2026-04-23
**Author**: tushark (Adobe) with AI pair-programming assistance
**Audience**: engineers maintaining or extending the tool, reviewers auditing
behavior against Adobe Experience Platform's Data Hygiene API contract.

---

## 1. Executive summary

The AEP Data Lifecycle Helper is a local, single-process Node.js application
that submits bulk record-delete work orders to Adobe Experience Platform via
the Data Hygiene API. An operator supplies a CSV of source identifiers
(typically `hashedKocid`, but any namespace is supported), and the tool:

1. Expands each source identifier into its full Identity Graph cluster to find
   every linked identity (email, phone, ECID, CRMID, etc.),
2. Packs the resulting identities into ≤ 100,000-identifier work orders,
3. Respects Adobe's daily and monthly identifier caps,
4. Submits the work orders to Adobe's Hygiene API,
5. Polls each work order's status until it reaches a terminal state,
6. Recovers gracefully from process crashes without data loss or duplicate deletions.

**Why this tool exists.** Adobe provides Data Hygiene as an API-only service.
Operating it at scale — across tens to hundreds of thousands of identifiers —
requires careful coordination of identity resolution, rate-limit compliance,
and idempotent submission. Doing this via ad-hoc scripts risks silent
misbehavior against an irreversible, destructive API. This tool codifies the
correct behavior, validates every payload before the wire, tracks state
durably in SQLite, and exposes a browser UI for the operator.

**Stakes.** Work orders are asynchronous AND irreversible. A malformed payload
that happens to pass Adobe's validation will quietly delete the wrong data.
Every design decision in this document is shaped by that constraint.

---

## 2. System overview

### 2.1 Topology

Single Node.js process, `http://127.0.0.1:3000` (loopback-only by default;
override with `HOST` env var for SSH-tunneled demos only). No distributed
components.
All state in one SQLite file (`data/state.db`, WAL mode). All secrets
AES-256-GCM encrypted at rest. IMS tokens cached in memory. UI is vanilla
HTML/CSS/JS — no build step, no framework. Tests use Node's built-in
`node --test` runner and `nock` for HTTP mocking.

### 2.2 Component diagram

```
                127.0.0.1:3000
   ┌────────────────────────────────────────────────────────┐
   │  Browser UI (vanilla JS)                               │
   │   ↕ fetch /api/*                                       │
   │  Express API                                           │
   │    ├─ routes/config.js        Credentials CRUD         │
   │    ├─ routes/adobe.js         Sandbox/dataset/NS disc. │
   │    ├─ routes/upload.js        CSV → job creation       │
   │    └─ routes/jobs.js          Plan / submit / progress │
   │                                                        │
   │  In-process runners                                    │
   │    ├─ runner/expansion.js     CSV → Identity Graph     │
   │    ├─ runner/submission.js    Plan + quota-gated POST  │
   │    ├─ runner/monitor.js       60s status poll          │
   │    └─ runner/recovery.js      Boot-time reconciliation │
   │                                                        │
   │  Services (Adobe-facing)                               │
   │    ├─ services/imsAuth.js     Token cache              │
   │    ├─ services/adobeClient.js axios + retry + auth     │
   │    ├─ services/sandboxes.js                            │
   │    ├─ services/datasets.js                             │
   │    ├─ services/namespaces.js                           │
   │    ├─ services/identityGraph.js                        │
   │    ├─ services/hygiene.js     Workorder validation     │
   │    └─ services/quotaManager.js Daily + monthly ledger  │
   │                                                        │
   │  SQLite (WAL, data/state.db)                           │
   │    ├─ credentials                                      │
   │    ├─ sandbox_configs                                  │
   │    ├─ jobs                                             │
   │    ├─ expanded_identities                              │
   │    ├─ work_orders                                      │
   │    ├─ quota_usage                                      │
   │    └─ quota_usage_monthly                              │
   └────────────────────────────────────────────────────────┘
```

### 2.3 Data flow (happy path)

1. **Configure** — operator enters IMS credentials; tool tests via
   `POST /ims/token/v3`, loads sandboxes via
   `GET /data/foundation/sandbox-management/`. On sandbox pick, tool loads
   datasets (filtered to Identity-enabled via the `unifiedIdentity: enabled:true`
   tag) and the namespace registry in parallel, caching both.
2. **Upload** — CSV streamed to `data/uploads/`; row count tallied; a `jobs`
   row is created in status `expanding`.
3. **Expand** — CSV stream → 1,000-ID batches → `p-limit(10)` parallel
   `POST /identity/clusters/members` calls. Each response's `clusters[*].members`
   are canonicalized using the registry and dedup-inserted into
   `expanded_identities`.
4. **Plan** — iterate `expanded_identities` sorted by `(source_id, ns_code)`.
   Bundle identities per cluster; pack bundles into work orders ≤ 100k IDs.
   Assign `day_index` to each work order, advancing when today's running total
   would exceed the daily cap. Previously-planned rows are deleted so re-plan
   is idempotent. **Re-planning is GUARDED**: if any work order on the job is
   in a state past `planned`/`deferred`, the planner throws
   `ReplanForbiddenError` (HTTP 409) — re-emitting orders for already-shipped
   identities would cause duplicate irreversible deletes (CLAUDE.md I10).
5. **Submit** — per work order in `planned` OR `deferred` state, atomically
   reserve quota (daily AND monthly). If granted, `POST /data/core/hygiene/
   workorder` (non-idempotent — never auto-retries on 5xx/network; CLAUDE.md
   I11). On success, record Adobe's work-order ID. If quota denied, mark
   `deferred` — the next submit run after UTC rollover picks it up. On
   failure, `release(count, monthlyLimit)` (skips monthly when null), mark
   `failed`.
6. **Monitor** — every 60 seconds, `GET /data/core/hygiene/workorder/{id}` for
   each non-terminal work order. Persist status transitions.

### 2.4 Recovery flow

On process startup, after schema init and monitor start:

- **Resume expanding jobs.** For each job with `status='expanding'`, build
  a Set of already-processed `source_id`s from `expanded_identities` and
  restart expansion with `skipSourceIds` — the CSV is re-read but already-done
  rows are skipped, so no redundant Adobe calls.
- **Reconcile orphan work orders.** For each work order with
  `status='submitting' AND adobe_workorder_id IS NULL` (the crash window
  between `reserve()` and the POST returning), best-effort look up the work
  order in Adobe by `displayName` prefix. Three outcomes:
    - **Match** — record the Adobe ID and let the monitor take over.
    - **Confirmed no-match** (Adobe responded 200, our row not in the list) —
      roll back to `planned` and release the quota so the next submit run
      can retry cleanly.
    - **Indeterminate** (Adobe returned 400 from the listing endpoint, OR a
      transient 5xx/network error) — leave the orphan in `submitting`. The
      next startup retries. Critically, **we never roll back when the answer
      is indeterminate**, because rolling back would risk a duplicate Adobe
      work order if the original POST had actually been processed.

---

## 3. Adobe API contracts

### 3.1 IMS token — `POST /ims/token/v3`

Grant type: `client_credentials`. Returns a bearer token with
`expires_in ≈ 86,400` (24 hours). We refresh 120 seconds before expiry.
Cached in memory keyed by `(clientId, imsOrgId)`; concurrent callers share
the same in-flight promise (thundering-herd guard). On 401 from any Adobe API,
the cache is invalidated and the next call re-authenticates.

### 3.2 Sandbox listing

`GET platform.adobe.io/data/foundation/sandbox-management/?limit=100&offset=0`

No `x-sandbox-name` header (the endpoint lists sandboxes, so it operates
org-wide). Response: `{sandboxes: [{name, title, state, type, region, isDefault}]}`.
We filter to `state === 'active'` and stop paginating when a page returns
fewer than `limit` results (safety cap at offset 1000).

### 3.3 Dataset listing

`GET platform.adobe.io/data/foundation/catalog/dataSets?limit=100&start=0&properties=name,description,tags,schemaRef,state`

Response is a **dict keyed by dataset id**, not an array. We filter to
datasets with `tags.unifiedIdentity: ["enabled:true"]` — datasets without
this tag would accept work orders but silently delete nothing, so hiding
them prevents a footgun.

### 3.4 Namespace listing

`GET platform-{region}.adobe.io/data/core/idnamespace/identities`

Region-specific host. Returns an array of namespace descriptors with
`{id (numeric nsid), code (string), name, idType, custom, status}`.

### 3.5 Identity Graph expansion — `POST /identity/clusters/members`

Region-specific host. Request body:

```json
{
  "compositeXids": [{ "ns": "hashedKocid", "nsid": 11124296, "id": "abc" }],
  "graph-type": "Private Graph"
}
```

Max 1,000 `compositeXids` per call (Adobe hard limit). For custom
namespaces, `nsid` must be provided — matching by `ns` (code) alone is
unreliable. Our `runner/expansion.js` auto-resolves the nsid from the loaded
namespace registry when the UI supplies only a code.

**Response shape (observed, AEP v1.1.0 — current):**

```json
{
  "version": "1.1.0",
  "clusters": [
    {
      "compositeXid": { "nsid": 11124296, "id": "abc" },
      "members": [
        { "nsid": 11124296, "id": "abc" },
        { "nsid": 6, "id": "alice@x.com" },
        { "nsid": 4, "id": "12345..." }
      ]
    }
  ]
}
```

Members carry only `nsid` — the `code` must be filled in locally via the
registry index. Array order is not guaranteed to match request order; we
match by `compositeXid.id`.

We also handle the **legacy bare-array shape**
`[{xid, identities:[{ns,nsid,id}]}]` for older regions.

### 3.6 Work-order creation — `POST /data/core/hygiene/workorder`

```json
{
  "action": "delete_identity",
  "datasetId": "ALL",
  "displayName": "Delete job-abc - WO 12345678",
  "description": "...",
  "targetServices": ["identity","profile","ajo"],
  "namespacesIdentities": [
    { "namespace": { "code": "email", "id": 6 }, "ids": ["a@x.com"] },
    { "namespace": { "code": "hashedKocid", "id": 11124296 }, "ids": ["abc"] }
  ]
}
```

Enforced constraints (all validated pre-network in `services/hygiene.js`):
- Total `ids` across all groups ∈ [1, 100,000]
- `datasetId` ∈ `"ALL"` | single id | comma-joined list; `"ALL"` cannot be
  combined with specific ids
- `targetServices`, if present, must be exactly `{identity, profile, ajo}`
  (order-independent) AND `datasetId` must be `"ALL"` ("profile-only mode")
- Each namespace group must have a `code` OR an `id` (or both)

Adobe returns `{workorderId, status, orgId, bundleId, operationCount,
createdAt, targetServices, datasetId, displayName}`.

### 3.7 Work-order status — `GET /data/core/hygiene/workorder/{id}`

Status progression: `received → validated → submitted → ingested → completed`
(or `failed`). Terminal states are `completed` and `failed`. Response includes
`productStatusDetails[]` showing per-service completion (Data Management,
Identity Service, Profile Service, Journey Orchestrator).

---

## 4. Non-obvious design decisions

### 4.1 Why SQLite and not Postgres / Redis

This tool runs on an operator's laptop. It's a local helper, not a
distributed service. SQLite's WAL mode gives us:
- Zero-administration durability (one file, point-in-time consistent)
- Fast concurrent reads during long writes
- ~100 k rows/sec bulk insert with prepared statements
- No deployment complexity — `data/state.db` is the entire state

Postgres / Redis would be appropriate only if multiple operators shared the
state. That's explicitly out of scope (see Known Limitations §6).

### 4.2 Why vanilla JS, no framework

- No build step — edit HTML/CSS/JS, refresh, done.
- Zero dependency on Node version / bundler / transpiler versions for the UI.
- The UI's state machine is small (5 steps, ~900 lines of `app.js`). A
  framework would add complexity without value.

### 4.3 Why validate before the network (not rely on Adobe's 400s)

Adobe's Data Hygiene API returns HTTP 400 on malformed payloads, but once the
request goes through it's irreversible. Pre-validating also avoids:
- Wasted IMS token exchanges for doomed requests.
- Cryptic Adobe error messages leaking to the UI.
- Round-trip latency for mistakes that can be caught in microseconds.

Every validator throws `WorkOrderValidationError` with a human-readable
message. See `src/services/hygiene.js` for the full set.

### 4.4 Why in-memory IMS tokens (not persisted)

Tokens are bearer secrets. Persisting them means a ~24h window where anyone
who reads `data/state.db` can impersonate the operator. In-memory caching
with thundering-herd coalescing is free after the first exchange and
regenerates in ~300 ms on restart. Not worth persisting.

### 4.5 Why auto-resolve the nsid from the registry

Custom namespaces (like `hashedKocid`) often fail to resolve clusters when
the request has only `ns` (code) without `nsid` (numeric). The tool used to
send only the code, which caused zero-cluster responses on every call for
custom-namespace sources. Now `runner/expansion.js` loads the namespace
registry once per job and fills in the nsid when the UI didn't supply one.

### 4.6 Why use `.all()` not `.iterate()` in the planner

`better-sqlite3` locks the connection while an iterator is active. The
planner must insert new `work_orders` rows whenever a cluster boundary
would push the current order past 100k — which requires a free connection.
Using `.iterate()` worked for small test cases (single cluster, no mid-flow
flush) but deadlocked with `"This database connection is busy"` on the
first multi-cluster scenario with a real flush. `.all()` materializes the
rows up front and releases the connection before any writes. Memory cost
is the same — we were going to consume the whole iterator anyway.

### 4.7 Why the crashed-submission reconciliation is best-effort

The window between "reserve quota in SQLite" and "Adobe returns 200 from
the POST" is where a process crash leaves ambiguity: did Adobe receive
the request or not? The reconciliation strategy:

1. **Look up by displayName prefix** — our displayName includes an 8-char
   prefix of the local work-order UUID, which is unique enough to identify
   the work order in Adobe's list. If Adobe has it, we know it was received,
   and we record the Adobe ID.
2. **Confirmed no match → roll back** — if Adobe responded successfully and
   the prefix isn't in the list, the POST did not land. Safe to release
   quota and put the work order back to `planned` for the next submit run.
3. **Transient OR indeterminate → leave alone** — if the lookup itself fails
   with 5xx, network, 401, **or 400** (filter rejected by Adobe — we can't
   tell whether the original POST was processed), leave the orphan in
   `submitting`. The next startup retries. Earlier code rolled back on 400,
   which would create a duplicate Adobe work order on the next submit when
   the original POST had actually been processed; the fix is to treat 400
   as "indeterminate" and refuse to roll back.

The only remaining unsafe outcome is: Adobe received the POST, listing
returns 200 with the order *missing* for some unrelated reason (replication
lag, a region-specific quirk), and we roll back. To minimize this risk:

- The hygiene POST is **deliberately non-idempotent** in `services/
  adobeClient.js`'s retry guard — `axios-retry` blocks 5xx and network
  retries on requests that don't tag `{idempotent: true}`. 401 (token
  refresh) and 429 (rate-limit) retries are still safe and on. (CLAUDE.md
  I11.)
- The recovery call uses `GET` + client-side `displayName.startsWith()`
  match, which is resilient to Adobe's filter syntax variations.
- Any reconciliation error path logs at warn level so the operator can
  investigate.

### 4.8 Why monthly quota is a separate table (not a column on daily)

- Daily rows churn once per UTC date; monthly rows churn once per UTC month.
  Mixing them in one table complicates rollover queries.
- Adding a "period type" column would allow generic code but require
  migration for existing users. A separate table with additive schema is
  simpler and more explicit.
- Tests can seed each ledger independently.

---

## 5. Review findings and resolutions

From the initial code review (see `docs/REVIEW.md` for the full
questionnaire), 1 blocker + 3 major + 4 minor issues were identified.
All were fixed before production use.

### 5.1 Blocker

**B1: `monitor.js` used wrong column names.** `wo.creds_id` / `wo.sandbox_name`
were `undefined` because the SQL aliased them as `j_creds_id` / `j_sandbox_name`.
Every 60-second poll was silently failing with "Unknown credential id: undefined".
**Fix**: corrected the property names. Monitor now runs correctly.

### 5.2 Major

**M1: Non-idempotent POST retried on network errors.** `axios-retry` was set
to retry every request on every network error, which could have created
duplicate irreversible work orders if the hygiene POST timed out.
**Fix (initial)**: retry condition skipped non-GET methods on network errors.
**Fix (extended in 2026-04-26 review remediation)**: retry condition is now
fully idempotency-aware — non-idempotent requests (default for non-GETs)
also skip 5xx retries, not just network errors. The Identity Graph cluster
query opts back in via `{idempotent: true}` because POST-as-query is
side-effect-free. The hygiene POST stays non-idempotent. 401/429 retries
are unconditional on all paths.

**M2: Re-plan duplicated work orders.** `planWorkOrders` inserted new rows
without clearing previous `planned` rows. Calling `/plan` twice doubled
the work orders.
**Fix (initial)**: added `deletePlannedOrders` prepared statement;
`planWorkOrders` clears existing planned rows for the job first. Now
idempotent within a pre-submission window.
**Fix (extended in 2026-04-26 review remediation)**: re-planning AFTER any
order shipped to Adobe was still possible — the planner only deleted
`planned` rows, leaving submitted rows alone but happily re-emitting work
orders for identities Adobe already received. Now `planWorkOrders` throws
`ReplanForbiddenError` (HTTP 409) if any work order is in a state past
`planned`/`deferred`. The UI Plan tab no longer auto-POSTs `/plan` on tab
entry; the Re-plan button auto-disables once any order has shipped.

**M3: Concurrent submission race.** Two rapid `/submit` calls could both
read the same `planned` rows and POST the same work orders.
**Fix**: module-level `inFlight` Set in `submission.js`; the second caller
gets an immediate return.

### 5.3 Minor

**m1: CSV header auto-detection could silently drop a real value.** The old
regex treated any first-row value matching `[a-zA-Z_][a-zA-Z0-9_\s]{2,}`
as a header. A real hashedKocid matching that pattern would be dropped.
**Fix**: header detection only activates when the caller passes a string
`column` name (named-column mode). Numeric column index never skips row 1.

**m2: `id=0` bypass in `canonicalizeNamespace`.** `if (id && !code)` evaluates
false for `id === 0` (falsy), so a namespace with nsid 0 wouldn't have its
code looked up.
**Fix**: condition changed to `id != null && !code`.

**m3: Unused `zod` dependency.** CLAUDE.md declared "no zod" but package.json
had `zod@3.23.8`. Dead weight.
**Fix**: removed from `dependencies`.

**m6: `listOpenWorkOrders` loaded everything before slicing.** Monitor did
`.all().slice(0, 30)` — loaded every open order before trimming.
**Fix**: `LIMIT 30` moved into the SQL.

### 5.4 Discovered during live run

- **Identity Graph response shape.** `docs/REVIEW.md` documented a bare-array
  response; Adobe actually returns `{version, clusters:[{compositeXid, members}]}`.
  Our parser dropped every cluster. **Fix**: rewrite of `identityGraph.js` to
  handle both shapes; added a WARN log when a batch returns zero linked
  identities so future contract drift surfaces immediately.
- **Bootstrap crash on first install.** `db.js` opened the SQLite connection
  at module load, before `index.js` had a chance to `mkdirSync('data/')`.
  **Fix**: `mkdirSync` moved into `db.js` itself so the module is
  self-bootstrapping.
- **"Authenticated" chip always visible.** CSS `display: flex` on `.auth-chip`
  overrode the HTML `hidden` attribute.
  **Fix**: added global `[hidden] { display: none !important }` rule.

### 5.5 Observed via testing during integration work

- **Planner's `.iterate()` deadlock.** Mid-flow writes during iterator
  iteration raised `"This database connection is busy"` on scenarios with
  multi-cluster day rollover.
  **Fix**: switched to `.all()`.

- **Work orders ordered by UUID in UI.** `getAllOrdersForJob ORDER BY id` used
  the primary-key UUID, producing random-looking order in the UI.
  **Fix**: `ORDER BY day_index, rowid` — insertion order is now shown.

### 5.6 External review remediation (2026-04-26 session)

A second external code review surfaced 7 additional findings (4 P1, 2 P2,
1 P3). All accepted and fixed.

- **R1 (P1): HTTP server not bound to localhost.** `app.listen(port, cb)`
  defaulted Node's host to `0.0.0.0`, exposing the unauthenticated
  destructive API to the LAN despite docs claiming localhost-only.
  **Fix**: `app.listen(port, host, cb)` with `host = process.env.HOST || '127.0.0.1'`.
- **R2 (P1): Re-plan after submission could duplicate deletes.** See M2
  extension above.
- **R3 (P1): Deferred orders never retried.** `runSubmission` only selected
  `status='planned'`, so quota-deferred orders were stranded. The UI also
  treated a day with no `planned` rows as complete.
  **Fix**: `getPlannedOrders` SQL widened to `status IN ('planned','deferred')`;
  per-day filter matched. UI day-advance logic respects deferred rows and
  shows a tooltip explaining the rollover-then-retry path.
- **R4 (P1): Hygiene POST retried on 5xx.** See M1 extension above.
- **R5 (P1, originally flagged P2): Region selector ignored.** `namespaces.js`
  and `identityGraph.js` used the process-wide `config.aep.identityRegion`,
  ignoring the per-credential `region`. Wrong-region calls to
  `/clusters/members` return 200 with empty cluster data — silent partial
  deletes. **Fix**: `decryptCreds()` now returns `region`; both endpoint
  builders use `creds.region` with the global as fallback. Test in
  `test/region.test.js`.
- **R6 (P2): Monthly-disabled jobs decremented monthly ledger on release.**
  `release()` always touched both ledgers regardless of whether reserve
  had used the monthly one. A failed job with monthly tracking off was
  eating monthly headroom from unrelated jobs on the same org.
  **Fix**: `release(orgId, count, monthlyLimit)` mirrors `reserve`'s gate;
  callers pass `job.monthly_limit`. Test in `test/quotaManager.test.js`.
- **R7 (P2): Recovery rolled back on 400.** A 400 from Adobe's list endpoint
  used to be treated as "Adobe doesn't have this work order" → roll back to
  `planned` + release quota. If Adobe had actually received the original
  POST, the next submit created a duplicate.
  **Fix**: 400 returns a `LOOKUP_INDETERMINATE` sentinel; the orphan stays
  in `submitting` for next-startup retry. Test in `test/recovery.test.js`.
- **R8 (P3): UI loaded Google Fonts.** Previous session added a Google
  Fonts CDN load for Source Sans 3, contradicting the CLAUDE.md "no
  outbound calls beyond Adobe" rule. **Fix**: 4 weights of Source Sans 3
  woff2 self-hosted under `src/web/fonts/` (OFL-licensed).

---

## 6. Known limitations

- **Single-process only.** Running two instances against the same `state.db`
  will corrupt the WAL. No advisory lock today.
- **OneDrive path locks** (Windows-specific). `data/` inside a OneDrive-synced
  path can trigger `SQLITE_BUSY` during sync. Safer to move it outside.
- **Monthly quota default is 3M.** This is a guess for a typical base Data
  Hygiene contract — verify your actual monthly entitlement and override on
  the Config tab.
- **Quota release on network timeout.** If Adobe received the POST but the
  response was dropped, we don't know and might under-count quota. Mitigated
  by the hygiene POST being non-idempotent (no auto-retry on 5xx or network
  errors; CLAUDE.md I11) and by the orphan-recovery routine on next startup
  attempting reconciliation by `displayName` lookup.
- **No multi-file upload.** One CSV per job.
- **No built-in export-import of credentials.** Each machine encrypts with
  its own `data/.key`. Moving creds requires re-entering them.
- **UTC midnight rollover** — a job submitted at 11:59 PM local time that
  Adobe processes after 00:00 UTC counts against the next day's quota.
  Usually fine but worth knowing for operators outside UTC.

---

## 7. Security model

### 7.1 In scope

- Client secrets encrypted at rest (AES-256-GCM, per-row 12-byte IV,
  16-byte auth tag) so that anyone with read access to `data/state.db`
  but NOT the encryption key cannot impersonate credentials.
- Encryption key lives at `data/.key`, 0600 permissions, auto-generated.
- IMS tokens never written to disk.
- Logs never print full tokens or client secrets (prefix-only for debug).

### 7.2 Out of scope

- **Compromised host.** If an attacker reads both `data/.key` AND
  `data/state.db`, all secrets are exposed — but so is every other
  credential on the machine.
- **Network protection.** HTTP binds to `127.0.0.1` by default (now
  enforced explicitly via `app.listen(port, host)`, not relied on as a
  Node default), trusts whoever reaches the loopback socket. No auth on
  the local UI by design. Setting `HOST=0.0.0.0` to expose the API
  explicitly opts out of this security model.
- **Multi-user separation.** This is a single-operator tool.

---

## 8. Operational procedures

### 8.1 First-time setup

1. `nvm install 20.18.0 && nvm use 20.18.0` (required — `better-sqlite3`
   doesn't have prebuilt binaries for Node 24+ as of writing)
2. `npm install` in the project directory
3. `npm start` — browser opens to `http://localhost:3000`
4. Enter IMS credentials on the Config tab; click Test Connection
5. Pick a sandbox; datasets and namespaces auto-load
6. Select deletion mode (specific datasets / ALL / profile-only)
7. Go to Upload tab; pick the source namespace from the dropdown
8. Drop the CSV; click Start Identity Expansion
9. When expansion reaches 100%, click Plan Work Orders
10. Review the plan; click Submit Day 1

### 8.2 Running tests

```bash
node --test test
```

Expected: **95 tests pass, 0 fail**. Current suite: 10 test files covering
hygiene validators (27), namespace canonicalization (11), IMS token cache (7),
quota manager (12, both daily + monthly + monthly-disabled release gating),
plan logic (12, includes replan guard and deferred-tolerance tests),
startup recovery (6, includes the 400-indeterminate test),
adobeClient error enrichment + idempotency-aware retries (11),
region routing per credential (3), deferred-row surfacing (1),
and an end-to-end integration test with a fully-mocked Adobe (3) — last
confirmed green on 2026-04-26.

### 8.3 Recovering from a crash

Just restart the app. On startup, `runStartupRecovery()` will:
- Resume any job in `status='expanding'` from its last committed source IDs.
- Reconcile any work order in `status='submitting'` with no Adobe ID —
  look up in Adobe, record ID if found; on confirmed no-match roll back to
  `planned` and release quota; on indeterminate (400 from the listing
  endpoint) or transient error, leave the orphan in `submitting` for the
  next startup to retry. Never roll back when the answer is indeterminate.

No manual SQL intervention required in the common case.

### 8.4 Rotating credentials

1. Update the secret in the Adobe Developer Console.
2. In the UI: Config tab → pick the saved credential → update the Client
   Secret field → Test Connection. This re-saves the encrypted secret.
   The in-memory IMS token cache auto-invalidates on the next 401.

### 8.5 Full reset

```bash
# Close the app first (Ctrl+C)
rm -rf data/
npm start
```

Wipes SQLite state, encryption key, uploads, exports. A fresh Config tab
awaits.

---

## 9. Extension points

For future work:

- **Multi-operator support.** Would require moving state to Postgres,
  locks for concurrent planning, and auth on the web UI.
- **Webhook-based status updates.** Adobe doesn't currently emit webhooks
  for work-order status; this is polling by necessity. If Adobe adds
  webhooks, the monitor could be replaced with a `POST /api/callback` handler.
- **Audit log.** `docs/CHANGELOG.md` tracks engineering changes but there's
  no operator-facing log of every submission. Would be a one-table addition
  and a new route.
- **Batch CSV upload.** Today one CSV per job; a folder upload of many CSVs
  would help ops running many deletions per day.
- **Schema-aware dataset filtering.** Beyond `unifiedIdentity: enabled:true`,
  pre-check each dataset's primary identity to warn the operator if a
  namespace they're deleting isn't the dataset's primary identity (Adobe
  silently skips such rows).

---

## 10. Appendix — file map

```
src/
├── index.js                        Express entrypoint + boot sequence
├── config.js                       Env-overridable defaults
├── db.js                           SQLite open + schema + migrations + prep stmts
├── services/
│   ├── imsAuth.js                  IMS token cache
│   ├── adobeClient.js              axios client factory
│   ├── sandboxes.js                Sandbox listing
│   ├── datasets.js                 Dataset catalog (Identity-filtered)
│   ├── namespaces.js               Namespace registry + canonicalize
│   ├── identityGraph.js            Cluster expansion (both shape versions)
│   ├── hygiene.js                  Work-order validation + POST
│   └── quotaManager.js             Daily + monthly quota ledgers
├── runner/
│   ├── expansion.js                CSV → Identity Graph → SQLite
│   ├── submission.js               Plan + quota-gated submit
│   ├── monitor.js                  60s status poll
│   └── recovery.js                 Startup reconciliation
├── routes/
│   ├── config.js                   Credential CRUD
│   ├── adobe.js                    Sandbox / dataset / namespace endpoints
│   ├── upload.js                   CSV upload + job create
│   └── jobs.js                     Plan / submit / progress / export
├── utils/
│   ├── csv.js                      Streaming CSV read / write
│   ├── crypto.js                   AES-256-GCM envelope
│   └── logger.js                   Structured logger
└── web/
    ├── index.html                  UI templates
    ├── styles.css                  Spectrum tokens + [hidden] fix + @font-face
    ├── app.js                      Vanilla JS state + fetch orchestrator
    ├── aep-icon.svg                Local AEP brand mark (no CDN dependency)
    └── fonts/                      Self-hosted Source Sans 3 woff2 (4 weights)

test/
├── hygiene.test.js                 Payload validators (27 tests)
├── namespaces.test.js              Canonicalize + index (11 tests)
├── imsAuth.test.js                 Token cache + nock (7 tests)
├── quotaManager.test.js            Daily + monthly ledgers + null-monthly release (12)
├── planWorkOrders.test.js          Cluster packing + replan guard + deferred (12)
├── recovery.test.js                Startup reconciliation + 400-indeterminate (6)
├── adobeClient.test.js             Error enrichment + idempotency-aware retries (11)
├── region.test.js                  Per-credential region routing (3)
├── deferred.test.js                Deferred-row surfacing (1)
└── integration.test.js             End-to-end with full Adobe mocks (3 tests)

docs/
├── ARCHITECTURE.md                 Living architecture overview (orient here)
├── CHANGELOG.md                    Append-only session log
├── REVIEW.md                       Full review brief + Adobe contracts
├── DESIGN_DOC.md                   This file (source for the Word export)
├── DESIGN_DOC.docx                 Word-format export
└── sample-source.csv               Tiny CSV for smoke testing
```
