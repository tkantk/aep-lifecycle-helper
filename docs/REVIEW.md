# Code Review Brief — AEP Data Lifecycle Helper

> **Reviewer instructions**: This document is the complete context for
> auditing this codebase. Read it end-to-end before starting. It contains
> the exact Adobe API contracts we build against, the payload shapes we
> emit, the validation rules we enforce, and our known limitations. Your
> job is to find bugs, payload mistakes, race conditions, and any
> behaviour that could silently misbehave against a destructive API.

**System under review**: single-process Node.js 20 helper that submits
bulk record-delete work orders to Adobe Experience Platform via its Data
Hygiene API. Wraps authentication, namespace discovery, identity-graph
expansion, and work-order planning/submission into a local browser UI.

**Stakes**: Data Hygiene work orders are **asynchronous and irreversible**.
A malformed payload that passes Adobe's validation will quietly delete
wrong data. A correctness bug costs the client real customer records.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Full data flow with invariants](#2-full-data-flow-with-invariants)
3. [Adobe APIs — exact contracts](#3-adobe-apis--exact-contracts)
4. [Our API endpoints](#4-our-api-endpoints)
5. [Payload construction walkthrough](#5-payload-construction-walkthrough)
6. [Database schema](#6-database-schema)
7. [Concurrency model](#7-concurrency-model)
8. [Security model](#8-security-model)
9. [Known limitations](#9-known-limitations)
10. [Test coverage and gaps](#10-test-coverage-and-gaps)
11. [Specific review questions](#11-specific-review-questions)

---

## 1. System overview

**Runtime**: one Node.js process on the operator's laptop, port 3000.
**Binds to `127.0.0.1` (loopback) by default** — set `HOST=0.0.0.0`
explicitly to expose it. No human auth on the local UI; security
relies on three middleware guards (`hostHeaderGuard`,
`originRefererGuard`, helmet/CSP) in `src/middleware/security.js`
plus UUID validation on every `:id` / `:credsId` path param.
`app.listen(port, host, cb)` passes the host explicitly.

**Persistence**: one SQLite file (`data/state.db`) in WAL mode.
`better-sqlite3` synchronous driver. Eight tables: `credentials`,
`sandbox_configs`, `jobs`, `expanded_identities`, `work_orders`,
`quota_usage`, `quota_usage_monthly`, `app_settings`.

**Concurrency**: all work happens in the event loop. Identity-graph
expansion uses `p-limit(10)` for 10 parallel Adobe calls with a
wave-based scheduler (WAVE_SIZE = 20) so peak heap stays bounded
regardless of job size; work-order submission uses `p-limit(2)`;
monitor status polling uses `p-limit(5)` over up to 100 open WOs per
tick. Two `setInterval(60s)` background tickers — the monitor (status
polling) and the scheduler (auto-resume, Phase 3). No worker threads,
no child processes.

**Quota model**: Adobe `GET /data/core/hygiene/quota` is the source of
truth at runtime. Cached 1h in-memory per `imsOrgId`; refreshed before
every plan + submit + scheduler tick. 24h hard floor — if Adobe is
unreachable AND no cache exists, the tool refuses to plan/submit
(`quota_unavailable` 503) rather than ship blind. The local SQLite
ledger (`quota_usage` + `quota_usage_monthly`) is a per-WO atomicity
safety net inside `reserve()` / `release()` only.

**Dependencies**: `express`, `helmet`, `better-sqlite3`, `axios`,
`axios-retry`, `multer` (v2), `fast-csv`, `p-limit`, `uuid`, `dotenv`,
`open`. Dev: `nock`.

**Frontend**: zero-build vanilla HTML/CSS/JS served from `src/web/` by
Express. Adobe Spectrum-styled. Modal + toast scaffolding for pre-plan
and pre-submit confirmations. Talks to the backend via `fetch('/api/…')`
with auto-populated forms and live quota banners.

---

## 2. Full data flow with invariants

```
┌──────────────┐
│ 0. Middleware│  Every request first passes through:
│              │   • hostHeaderGuard — only localhost/127.0.0.1/[::1] accepted
│              │   • originRefererGuard — POST/PUT/PATCH/DELETE Origin must
│              │     match Host (defeats simple-form CSRF)
│              │   • helmet (CSP: script-src 'self'; frame-ancestors 'none')
│              │   • registerUuidParamGuards on :id / :credsId
│              │   • centralised error handler (no raw err.message on 5xx)
└──────┬───────┘
       ▼
┌──────────────┐
│ 1. Config    │  User picks stored creds or enters fresh. Region +
│              │  environment validated server-side against allowlists.
│              │  Test Connection → IMS token obtained, sandboxes loaded,
│              │  /data/core/hygiene/quota fetched (org-wide, no x-sandbox).
│              │  Quota banner: Daily X/Y · Monthly A/B · auto-populated
│              │  cap inputs. User picks sandbox → datasets loaded
│              │  filtered to Identity-enabled + namespaces loaded.
│              │  User picks deletion mode: datasets | all | profile-only.
└──────┬───────┘
       ▼
┌──────────────┐
│ 2. Upload    │  multer 2.x with bounded limits (fileSize 4 GiB; files: 1;
│              │  fields: 20; parts: 25; headerPairs: 100). CSV streamed
│              │  to disk (never loaded in memory). Random filename with
│              │  sanity-checked extension. Row-count pass (streaming)
│              │  populates progress denominator. Job row inserted, status
│              │  ='expanding'. runExpansion() fired and forgotten.
└──────┬───────┘
       ▼
┌──────────────┐  Load namespace registry once → build byCode/byId index.
│ 3. Expansion │  For each 1000-ID buffer:
│ (p-limit 10) │    POST /data/core/identity/clusters/members
│              │    (region from creds, NOT process default; allowlist
│              │     defence-in-depth in services/namespaces.js +
│              │     services/identityGraph.js).
│              │    Canonicalize every returned identity to {code, id}.
│              │    Plain INSERT into expanded_identities (no unique index;
│              │    dedup deferred to planning-time GROUP BY — O(1) per row
│              │    vs. O(log n) B-tree lookup on old unique index).
│              │    Wave-based: WAVE_SIZE batches in-flight at once; onRow
│              │    is async so CSV stream pauses at each wave boundary.
│              │    After all waves drain, COUNT DISTINCT overwrites
│              │    found_count with the true deduplicated total.
│              │  Progress updated in memory + DB.
└──────┬───────┘
       ▼
┌──────────────┐  POST /api/jobs/:id/plan refreshes /quota first.
│ 4. Plan      │  Iterate expanded_identities ORDER BY source_id, ns_code.
│              │  Build cluster bundles, pack into ≤100k-ID work orders,
│              │  assign initial day_index. Then redistributor walks
│              │  un-shipped WOs in rowid order and assigns authoritative
│              │  (month_index, day_index) from live daily.remaining +
│              │  monthly.remaining + future-period fresh caps.
│              │  Returns { planned, months, days, perMonthCounts,
│              │  shiftedFromPrevious, previousMonths }.
│              │  UI: Plan tab groups by Month → Day with per-month
│              │  totals. Pre-plan modal confirms before locking in
│              │  if months > 1 OR timeline shifted. (RQ-2 routing:
│              │  1-mo shift = toast; ≥2-mo shift = modal.)
│              │  After planning, Month 2+ WOs are flipped to
│              │  'awaiting_approval' — invisible to Submit until
│              │  the operator approves each month (step 4a).
└──────┬───────┘
       ▼
┌──────────────┐  Operator-driven. Plan tab shows "Approve Month N"
│ 4a. Approve  │  button for each month > 1 that has awaiting_approval
│ (Month 2+)   │  WOs. POST /api/jobs/:id/approve-month { monthIndex }
│              │  flips awaiting_approval → planned for that month.
│              │  Month 1 is never gated — it ships immediately.
│              │  Idempotent: re-approving returns 404 (no rows changed).
└──────┬───────┘
       ▼
┌──────────────┐  Pre-submit modal (always shown — destructive) with live
│ 5. Submit    │  remaining + planned consumption. Operator confirms.
│              │  Then backend (POST /api/jobs/:id/submit):
│              │   a. runSubmission refreshes /quota with refresh: true.
│              │      Hard failure (no recent cache) → quota_unavailable
│              │      error; UI surfaces it on next poll.
│              │   b. Redistributor re-buckets un-shipped WOs against the
│              │      fresh numbers (work may shift to a later month).
│              │   c. For each planned OR deferred order in target
│              │      (month, day) bucket (p-limit 2):
│              │       - reserve({workOrderId, imsOrgId, count, dailyLimit,
│              │         monthlyLimit}) — per-WO row; caps are live /quota
│              │         × (1 − QUOTA_SAFETY_BUFFER) (R5/R6).
│              │       - If not granted → mark 'deferred', skip.
│              │       - If granted → POST /data/core/hygiene/workorder.
│              │         POST is non-idempotent: NO retry on 5xx/network.
│              │         Log if Adobe operationCount diverges from total.
│              │       - On 2xx: persist adobe_workorder_id + markAccepted(woId).
│              │       - On 4xx: release(woId) (guarded WHERE accepted=0),
│              │         mark 'failed'.
│              │       - On 5xx/timeout/network (UNCERTAIN): keep 'submitting',
│              │         HOLD the reservation, reconcile later (R5/R6).
│              │  CSP guard against re-emitting identity content:
│              │  ReplanForbiddenError (409) if any WO has shipped.
└──────┬───────┘
       ▼
┌──────────────┐  setInterval(60s). Finds work orders where
│ 6. Monitor   │    adobe_workorder_id IS NOT NULL AND
│              │    adobe_status NOT IN ('completed','failed').
│              │  pLimit(5) concurrent GET /data/core/hygiene/workorder/{id}.
│              │  Update adobe_status, product_status_details.
│              │  Up to 100 polls per tick (~15 min for 1,500 open WOs).
│              │  UI: per-work-order rich cards (Adobe ID, dates,
│              │  identifier count, status pill, "Status by service"
│              │  breakdown matching AEP's own detail screen).
└──────┬───────┘
       ▼
┌──────────────┐  Phase 3 auto-resume (OPT-IN, default disabled).
│ 7. Scheduler │  setInterval(60s). On each tick, shouldFireNow() checks:
│              │    enabled === true
│              │    + today passes days filter (every/weekdays/1st)
│              │    + now >= today's HH:MM local
│              │    + lastRunAt < today's HH:MM
│              │  If all pass: walks every job with un-shipped WOs and
│              │  calls runSubmission(jobId). Each runSubmission internally
│              │  re-fetches /quota and re-buckets, so a quota change
│              │  between ticks (e.g. month rollover) is picked up.
│              │  Catch-up tick at startup handles "laptop was off at
│              │  scheduled time."
└──────────────┘
```

Each step's state persists to SQLite, so the process can be killed and
restarted without losing progress. Startup recovery handles two cases:
`expanding` jobs (resume via skip-set) and `submitting` WOs without an
Adobe ID (reconcile via Adobe's list endpoint, never roll back on
indeterminate response).

---

## 3. Adobe APIs — exact contracts

### 3.1 IMS authentication — `POST /ims/token/v3`

Host: `https://ims-na1.adobelogin.com`

```http
POST /ims/token/v3 HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<CLIENT_ID>
&client_secret=<CLIENT_SECRET>
&scope=openid,AdobeID,read_organizations,additional_info.projectedProductContext,session
```

Response:
```json
{
  "access_token": "eyJhbGci...",
  "token_type": "bearer",
  "expires_in": 86400
}
```

**Our implementation**: `services/imsAuth.js`.
- In-memory cache keyed by `${clientId}:${imsOrgId}`.
- Safety margin: refresh 120s before expiry.
- Thundering-herd guard: concurrent callers share one in-flight promise.
- On 401 from any Adobe API, cache is invalidated and next call re-authenticates.

### 3.2 List sandboxes — `GET /data/foundation/sandbox-management/`

Host: `https://platform.adobe.io`

```http
GET /data/foundation/sandbox-management/?limit=100&offset=0 HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
x-api-key: <CLIENT_ID>
x-gw-ims-org-id: <IMS_ORG_ID>
```

**Note**: no `x-sandbox-name` header — this endpoint lists sandboxes, so
it operates org-wide.

Response:
```json
{
  "sandboxes": [
    {
      "name": "prod",
      "title": "Production",
      "state": "active",
      "type": "production",
      "region": "VA7",
      "isDefault": true
    },
    ...
  ],
  "_page": { "limit": 100, "count": 1 }
}
```

**Our implementation**: `services/sandboxes.js`.
- Pages until `sandboxes.length < limit`, then stops.
- Filters to `state === 'active'`.
- Safety cap at offset 1000 (75 sandboxes is Adobe's licensed max).

### 3.3 List datasets — `GET /data/foundation/catalog/dataSets`

```http
GET /data/foundation/catalog/dataSets?limit=100&start=0&properties=name,description,tags,schemaRef,state HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
x-api-key: <CLIENT_ID>
x-gw-ims-org-id: <IMS_ORG_ID>
x-sandbox-name: <SANDBOX_NAME>
```

Response is a **dictionary keyed by dataset id**, not an array:
```json
{
  "5b020a27e7040801dedbf46e": {
    "name": "Commission Program Events DataSet",
    "description": "…",
    "tags": {
      "unifiedProfile": ["enabled:true"],
      "unifiedIdentity": ["enabled:true"]
    },
    "schemaRef": { "id": "https://ns.adobe.com/xdm/context/experienceevent" },
    "state": "active"
  },
  ...
}
```

**Our implementation**: `services/datasets.js`.
- Uses `Object.entries(data)` to flatten the dict.
- Filters to entries where `tags.unifiedIdentity?.includes('enabled:true')`.
  Non-Identity-enabled datasets accept work orders but delete nothing
  (Adobe doesn't reject them — it silently skips records without a
  primary identity).
- Paginates by `start += pageSize` until `entries.length < pageSize`.

### 3.4 List namespaces — `GET /data/core/idnamespace/identities`

Host: region-specific. **Region MUST come from the credential row**
(`creds.region` returned by `decryptCreds`), not the process-wide
`config.aep.identityRegion` default. Wrong-region calls to identity
endpoints return 200 with empty data, which causes silent partial
deletes (CLAUDE.md I9). Both `services/namespaces.js` and
`services/identityGraph.js` build their endpoint URL from
`creds.region` with the global as fallback only.

```http
GET /data/core/idnamespace/identities HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
x-api-key: <CLIENT_ID>
x-gw-ims-org-id: <IMS_ORG_ID>
x-sandbox-name: <SANDBOX_NAME>
```

Response is an array:
```json
[
  { "id": 6, "code": "email", "name": "Email", "idType": "Email", "custom": false, "status": "ACTIVE" },
  { "id": 7, "code": "phone", "name": "Phone", "idType": "Phone", "custom": false, "status": "ACTIVE" },
  { "id": 411, "code": "AAID", "name": "Adobe Analytics (AAID)", "idType": "COOKIE", "custom": false, "status": "ACTIVE" },
  { "id": 10093197, "code": "Loyalty", "name": "Loyalty Member", "idType": "Cross_device", "custom": true, "status": "ACTIVE" }
]
```

**Our implementation**: `services/namespaces.js`.
- `listNamespaces()` fetches the full array.
- `buildNamespaceIndex()` creates `{byCode: Map, byId: Map}`.
- `canonicalizeNamespace({ns, nsid}, index)` resolves either form to a
  `{code, id}` pair. If the index has no hit (e.g. a newly-created
  namespace not yet in our cache), returns whatever was provided.

### 3.5 Identity Graph cluster expansion

```http
POST /data/core/identity/clusters/members HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
x-api-key: <CLIENT_ID>
x-gw-ims-org-id: <IMS_ORG_ID>
x-sandbox-name: <SANDBOX_NAME>
Content-Type: application/json

{
  "compositeXids": [
    { "ns": "hashedKocid", "nsid": 10093197, "id": "abc123" },
    { "ns": "hashedKocid", "nsid": 10093197, "id": "def456" }
  ],
  "graph-type": "Private Graph"
}
```

**Response — observed shape (AEP v1.1.0, current)**:
```json
{
  "version": "1.1.0",
  "clusters": [
    {
      "compositeXid": { "nsid": 10093197, "id": "abc123" },
      "members": [
        { "nsid": 10093197, "id": "abc123" },
        { "nsid": 6,  "id": "alice@example.com" },
        { "nsid": 7,  "id": "+15551234" },
        { "nsid": 4,  "id": "55682333885685634259033964521903796975" }
      ]
    }
  ]
}
```

- The top-level is an object `{version, clusters:[...]}` — NOT a bare array.
- Each cluster identifies its source via `compositeXid` (nsid + id), not `xid`.
- Each linked identity lives under `members[]`, NOT `identities[]`.
- Members carry only `nsid` — the namespace `code` must be resolved locally
  via the registry index.
- Order of `clusters[]` is not guaranteed to match `compositeXids[]` request
  order; match by `compositeXid.id`.

**Response — legacy shape** (older regions / earlier API versions may still emit):
```json
[
  { "xid": "…", "identities": [{ "ns": "email", "nsid": 6, "id": "alice@example.com" }] }
]
```

Our code handles both.

**Critical Adobe limits**:
- ≤ 1000 `compositeXids` per call.
- ~850 ms p95 at typical loads; expect 429s above ~10 concurrent workers.

**Our implementation**: `services/identityGraph.js`.
- Sends both `ns` (code) and `nsid` (numeric) in compositeXids when both are known.
  When only a code is supplied by the UI, `runner/expansion.js` resolves the
  nsid from the namespace registry before the call. Custom namespaces
  (e.g. `hashedKocid`) need the numeric nsid to reliably match clusters.
- Parses both response shapes: extracts `data.clusters` OR `data` itself
  depending on which form was returned.
- Matches each cluster to its source STRICTLY by `compositeXid.id` — no
  positional fallback (review R4 #2). Fails closed on any unmatched source,
  on `unprocessedXids`/`unprocessedNids`, or on an unrecognized shape.
- Each `member.nsid` is canonicalized via the namespace registry to fill in
  the missing `code`. If the registry has no hit, the row is still stored
  with only the nsid — Adobe's Hygiene API accepts namespace groups with
  either `code` or `id`.
- Returns normalized
  `{sourceId, sourceNamespace:{code,id}, linkedIdentities:[{namespace:{code,id}, id}]}`.
- When a batch returns zero linked identities across all clusters, we emit a
  WARN log with the raw response preview so contract drift surfaces quickly.

### 3.6 Create record-delete work order

```http
POST /data/core/hygiene/workorder HTTP/1.1
Authorization: Bearer <ACCESS_TOKEN>
x-api-key: <CLIENT_ID>
x-gw-ims-org-id: <IMS_ORG_ID>
x-sandbox-name: <SANDBOX_NAME>
Content-Type: application/json

{
  "action": "delete_identity",
  "datasetId": "ALL",
  "displayName": "Delete job-abc - WO 12345678",
  "description": "Bulk delete …",
  "targetServices": ["identity", "profile", "ajo"],
  "namespacesIdentities": [
    { "namespace": { "code": "email", "id": 6 }, "ids": ["a@x.com","b@x.com"] },
    { "namespace": { "code": "hashedKocid", "id": 10093197 }, "ids": ["abc","def"] }
  ]
}
```

**Response**:
```json
{
  "workorderId": "DI-95c40d52-6229-44e8-881b-fc7f072de63d",
  "orgId": "…@AcmeOrg",
  "bundleId": "BN-c61bec61-5ce8-498f-a538-fb84b094adc6",
  "action": "identity-delete",
  "createdAt": "2035-06-02T09:21:00.000Z",
  "operationCount": 4,
  "targetServices": ["profile", "datalake", "identity", "ajo"],
  "status": "received",
  "datasetId": "ALL",
  "displayName": "Delete job-abc - WO 12345678"
}
```

**Adobe-enforced constraints**:
1. `namespacesIdentities[*].ids` length: 1–100,000 (total).
2. `datasetId`: exactly one of `"ALL"`, a single id, or a comma-joined list.
   Cannot combine `"ALL"` with specific ids.
3. `targetServices`, if present, must be exactly `{identity, profile, ajo}`
   in any order, AND `datasetId` must be `"ALL"`.
4. Each namespace group must identify a namespace by `code`, `id`, or both.
5. Daily cap: 1,000,000 identifiers (default; some orgs lower, Shield higher).

**Our validation**: `services/hygiene.js` runs all five checks **before**
the network call. Throws `WorkOrderValidationError` with an explicit
message. Response parsing extracts only the fields we store.

### 3.7 Work-order status — `GET /data/core/hygiene/workorder/{id}`

Response includes the same fields as create, plus `productStatusDetails`
when present:
```json
{
  "workorderId": "DI-…",
  "status": "completed",
  "productStatusDetails": [
    { "productName": "Data Management",   "productStatus": "success", "createdAt": "..." },
    { "productName": "Identity Service",  "productStatus": "success", "createdAt": "..." },
    { "productName": "Profile Service",   "productStatus": "success", "createdAt": "..." },
    { "productName": "Journey Orchestrator", "productStatus": "success", "createdAt": "..." }
  ]
}
```

Status values: `received` → `validated` → `submitted` → `ingested` → `completed` (or `failed`).

Terminal states: `completed`, `failed`. Monitor stops polling those.

---

## 4. Our API endpoints

All under `/api/` on `http://127.0.0.1:3000`. Three guards run on every
request (CLAUDE.md I13): hostHeaderGuard (only localhost/127.0.0.1/[::1]
accepted), originRefererGuard (state-changing methods require matching
Origin or Referer), and registerUuidParamGuards on `:id` / `:credsId`.

### Config

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/config/credentials` | Store or upsert creds. Validates region (allowlist), environment (allowlist), length limits per field, CRLF rejection. Encrypts secret at rest. Keyed on (env, ims_org, client_id) |
| GET  | `/api/config/credentials` | List stored creds (no secrets in response) |
| PATCH | `/api/config/credentials/:id` | Update label / client_name / region only — never touches the encrypted secret or identity fields. Returns 404 if id not found, 400 if label missing or region invalid |
| POST | `/api/config/credentials/test` | IMS auth check via stored id or inline creds (inline goes through the same length/CRLF validators) |
| DELETE | `/api/config/credentials/:id` | Remove creds. Returns **409** with `{error: 'credential_in_use', jobCount}` when any row in `jobs` references this credential — protects status polling and recovery from being orphaned |

### Adobe discovery + live quota

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/adobe/:credsId/sandboxes` | Live list of sandboxes |
| GET  | `/api/adobe/:credsId/sandboxes/:sandbox/datasets?refresh=1&identityOnly=1` | Datasets filtered to Identity-enabled |
| GET  | `/api/adobe/:credsId/sandboxes/:sandbox/namespaces?refresh=1` | Namespace registry |
| GET  | `/api/adobe/:credsId/quota?refresh=1` | Live `/data/core/hygiene/quota` snapshot. Returns `{ daily, monthly, datasetExpiration, fetchedAt, stale, error }`. 503 with code `quota_unavailable` only when no cache AND live call failed |

### Jobs

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` (multipart) | Create job + start expansion (multer 2.x with bounded limits) |
| GET  | `/api/jobs` | List jobs by `created_at DESC` (every status, every sandbox) |
| GET  | `/api/jobs/monitor?limit&search&sandbox` | Active-submissions feed: jobs with ≥1 Adobe-acked work order. In-flight-first sort, then by latest WO activity. Returns `{ rows, totals, sandboxes }` |
| GET  | `/api/jobs/:id` | Job detail + namespace breakdown + local-ledger quota peek |
| GET  | `/api/jobs/:id/progress` | Live expansion progress (fast path) |
| POST | `/api/jobs/:id/plan` | Build work-order plan. Server-side fetches `/quota` first; planner emits initial day-bucketed WOs then redistributor re-buckets into month×day. Returns `{ planned, days, months, perMonthCounts, totalIdentifiers, shiftedFromPrevious, previousMonths, quota }`. 503 with `quota_unavailable` if Adobe is unreachable + no recent cache |
| POST | `/api/jobs/:id/approve-month` | Flip `awaiting_approval` → `planned` for `{ monthIndex }` (≥ 2). 400 for monthIndex=1/non-integer; 404 if no awaiting WOs |
| POST | `/api/jobs/:id/submit` | Kick off submission. Body: `{ dayIndex?, monthIndex? }`. Server runs redistributor against fresh `/quota` before picking work. Submit's failure handling differentiates Adobe-4xx (mark `failed` + release quota) from 5xx/timeout/network (keep `submitting`, hold quota — reconcile later) |
| POST | `/api/jobs/:id/reconcile` | Per-job orphan reconciliation. Scans every WO with `adobe_workorder_id IS NULL` AND `status IN ('submitting','failed')`. Looks each up by its persisted `display_name` (R6 #2). Outcomes: `matched` (record Adobe ID, flip to submitted, `markAccepted`/`reactivate`), `indeterminate` (submitting **no-match OR 4xx** → leave in submitting, hold quota — never auto-roll-back, R6 #1), `stillFailed` (failed + absent → leave), `perWoError`. `rolledBack` is always 0 (kept for response shape). Returns counts |
| POST | `/api/jobs/:id/work-orders/:woId/release-absent` | Operator-confirmed resolution for a stuck indeterminate orphan (R7 #1). Body `{ confirmedAbsent: true }` REQUIRED. Releases the held reservation + resets the WO to `planned` for retry, in one transaction (R8 #2). Fail-closed: 409 if the WO has an Adobe ID, an `accepted` reservation, its POST is still in flight (R8 #1), OR a reconciliation lookup is in flight for it (R9 #1 — a refcounted guard; releasing during a lookup that may find it in Adobe would duplicate); only a settled `submitting` orphan is eligible |
| GET  | `/api/jobs/:id/work-orders` | All work orders (month_index + day_index + per-service status from product_status_details) |
| GET  | `/api/jobs/:id/export` | Download expanded identities CSV (formula-injection sanitised). Uses `prepareStreamIdentitiesBySource()` for a FRESH prepared statement per request — overlapping exports cannot collide on a single Statement's one-iterator-per-stmt rule (2026-05-29 'statement busy' fix) |
| DELETE | `/api/jobs/:id` | Hard-delete a job + cascade through `expanded_identities` and `work_orders`. 409 with `{error:'in_flight'}` when any WO is `submitting`/`submitted`/`received`/`validated`/`ingested`. `?force=true` bypasses; Adobe-side deletes continue but local tracking is dropped. Best-effort unlinks upload + exported CSV |

### Settings (Phase 3)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings/auto-resume` | Returns `{ enabled, localTime, days, lastRunAt, lastRunSummary, nextFireAt }` |
| PUT | `/api/settings/auto-resume` | Body: `{ enabled?, localTime?, days? }`. Validates HH:MM regex, days enum (`every-day` / `weekdays` / `first-of-month`), boolean type. `lastRunAt` and `lastRunSummary` are not writable here |

---

## 5. Payload construction walkthrough

Worked example: user uploads 3 `hashedKocid` values, targeting 2 datasets.

### Step 1 — upload CSV

```
abc123
def456
ghi789
```

### Step 2 — expansion reads namespace index

Load `GET /data/core/idnamespace/identities`. Build:
```
byCode: { "email" → {id:6, code:"email", ...}, "hashedKocid" → {id:10093197, ...}, ... }
byId:   { 6 → {id:6, code:"email", ...}, ... }
```

### Step 3 — expansion batches the input

One batch (only 3 IDs, well under 1000):

```json
POST /data/core/identity/clusters/members
{
  "compositeXids": [
    { "ns": "hashedKocid", "nsid": 10093197, "id": "abc123" },
    { "ns": "hashedKocid", "nsid": 10093197, "id": "def456" },
    { "ns": "hashedKocid", "nsid": 10093197, "id": "ghi789" }
  ],
  "graph-type": "Private Graph"
}
```

Response (hypothetical, current AEP v1.1.0 shape):
```json
{
  "version": "1.1.0",
  "clusters": [
    {
      "compositeXid": { "nsid": 10093197, "id": "abc123" },
      "members": [
        { "nsid": 6, "id": "alice@x.com" },
        { "nsid": 10093197, "id": "abc123" },
        { "nsid": 4, "id": "123456789" }
      ]
    },
    {
      "compositeXid": { "nsid": 10093197, "id": "def456" },
      "members": [
        { "nsid": 6, "id": "bob@x.com" },
        { "nsid": 10093197, "id": "def456" }
      ]
    },
    {
      "compositeXid": { "nsid": 10093197, "id": "ghi789" },
      "members": [
        { "nsid": 7, "id": "+15551234" },
        { "nsid": 10093197, "id": "ghi789" }
      ]
    }
  ]
}
```

### Step 4 — insert into expanded_identities

After canonicalization, we insert these tuples (job_id, ns_code, ns_id, identity_id, source_id):

| ns_code     | ns_id    | identity_id       | source_id |
|-------------|----------|-------------------|-----------|
| hashedKocid | 10093197 | abc123            | abc123    |
| email       | 6        | alice@x.com       | abc123    |
| ECID        | 4        | 123456789         | abc123    |
| hashedKocid | 10093197 | def456            | def456    |
| email       | 6        | bob@x.com         | def456    |
| hashedKocid | 10093197 | ghi789            | ghi789    |
| phone       | 7        | +15551234         | ghi789    |

### Step 5 — plan work orders

Query uses `GROUP BY COALESCE(ns_code,''), COALESCE(ns_id,0), identity_id` with
`MIN(source_id)` to deduplicate at read time (same semantics as the old unique
index, but deferred so inserts stay O(1)).

Planner collects cluster bundles (all rows with same `source_id`), packs
them into a single work order (total 7 ids << 100k):

### Step 6 — submit (final payload)

```json
POST /data/core/hygiene/workorder
{
  "action": "delete_identity",
  "datasetId": "dataset_id_1,dataset_id_2",
  "displayName": "Delete job-abc12345 - WO 12345678",
  "description": "Bulk delete (Job abc12345, Day 1)",
  "namespacesIdentities": [
    { "namespace": { "code": "ECID",        "id": 4 },        "ids": ["123456789"] },
    { "namespace": { "code": "email",       "id": 6 },        "ids": ["alice@x.com", "bob@x.com"] },
    { "namespace": { "code": "hashedKocid", "id": 10093197 }, "ids": ["abc123", "def456", "ghi789"] },
    { "namespace": { "code": "phone",       "id": 7 },        "ids": ["+15551234"] }
  ]
}
```

Notice: **both** `code` and `id` are present in each namespace. Adobe
accepts either; we send both to eliminate ambiguity for custom namespaces.

If the user had chosen "profile-only" mode, we'd instead send:
```json
{
  "action": "delete_identity",
  "datasetId": "ALL",
  "targetServices": ["identity", "profile", "ajo"],
  "namespacesIdentities": [ ... same as above ... ]
}
```

---

## 6. Database schema

Full DDL in `src/db.js::initDb()`. Summary:

- **credentials** — AES-GCM encrypted client secrets.
- **sandbox_configs** — per `(creds_id, sandbox_name)` cache of sandbox
  metadata, dataset list, and namespace registry.
- **jobs** — one per CSV upload. `dataset_ids` is the normalized string
  stored as-provided (`"ALL"` or comma list). `target_services_json` is
  nullable JSON. `source_namespace_id` stores the numeric nsid when
  known. `projected_months` (Phase 2) tracks the redistributor's max
  month_index for shift detection — used by the UI to render the
  per-poll "plan extended" toast/modal.
- **expanded_identities** — per-cluster-member rows. Both `ns_code` and
  `ns_id` stored. **No unique index** — dedup is deferred to planning
  time via `GROUP BY COALESCE(ns_code,''), COALESCE(ns_id,0), identity_id`
  in `streamIdentitiesBySource`. The old unique index (`idx_ei_unique`)
  is dropped at boot via migration on existing DBs. This makes each
  INSERT O(1) instead of O(log n), eliminating the progressive slowdown
  on jobs with 1M+ source IDs where the index would grow to ~400 MB.
- **work_orders** — one per Adobe work order. `namespaces_identities` is
  the full JSON payload (we store it so we can retry or audit later).
  `month_index` (Phase 2) + `day_index` form the bucket label assigned
  by the redistributor on un-shipped WOs only; shipped WOs preserve
  their historical labels.
- **quota_usage** — `(ims_org_id, utc_date) → used`. Rolls over at UTC
  midnight by virtue of the date being part of the key. Local atomicity
  ledger only — Adobe `/quota` is the displayed truth.
- **quota_usage_monthly** — `(ims_org_id, utc_year_month) → used`. Same
  pattern at month granularity.
- **app_settings** — generic key/value bag (Phase 3). First users:
  `auto_resume_enabled`, `auto_resume_local_time`, `auto_resume_days`,
  `auto_resume_last_run_at`, `auto_resume_last_run_summary`.

---

## 7. Concurrency model

### Within expansion
- CSV stream feeds a buffer. Every 1000 rows, a `p-limit(N)`-gated
  async task is queued into the current wave.
- Wave-based scheduling: at most `WAVE_SIZE = concurrency × 2` (default 20)
  in-flight tasks at once. `onRow` is async, so `await drainWave()` blocks
  the CSV stream at each wave boundary. This caps peak heap at
  O(concurrency × batchSize) regardless of job size.
- Each task:
  - Calls Adobe once (via retry-wrapped axios).
  - Builds a row array.
  - Calls `bulkInsertIdentities(rows)` which runs a single SQLite
    transaction. Plain `INSERT` (no `OR IGNORE`) — O(1) per row.
- After all waves complete, `countDistinctIdentities` computes the true
  deduped total and `setFoundCount` overwrites `found_count` on the job row.

### Within submission
- `p-limit(2)` over planned-or-deferred orders.
- Each worker:
  - Calls `reserve(orgId, count, dailyLimit, monthlyLimit)` — atomic SQLite
    UPSERT against both daily and monthly ledgers (monthly skipped if null).
  - If granted, posts to Adobe (hygiene POST is non-idempotent — see
    CLAUDE.md I11).
  - On 2xx, updates work_orders row + `markAccepted(woId)` (the reservation is
    held until period rollover, R5).
  - On 4xx, `release(woId)` (guarded WHERE accepted=0) + mark 'failed'.
  - On 5xx/timeout/network (UNCERTAIN), keeps 'submitting' and HOLDS the
    reservation — Adobe may have processed it; recovery reconciles later (R5/R6).

### Status monitor
- `setInterval(60_000, tick)`.
- Each tick selects up to 100 open work orders.
- Polls via `pLimit(5)` — 5 concurrent Adobe GETs per tick instead of
  serial. At 1,500+ open WOs the full poll cycle drops from ~52 min to
  ~15 min.

### Auto-resume scheduler (Phase 3)
- `setInterval(60_000, tick)` (separate from the monitor's interval).
- Each tick reads `app_settings.auto_resume_*`. If `shouldFireNow(settings)`
  agrees (enabled + day filter + HH:MM passed + not-yet-fired-today),
  iterates every job with un-shipped WOs and calls
  `runSubmission(jobId)` serially per job.
- Per-tick `running` flag prevents reentrancy when a paused machine
  wakes up and stacks multiple ticks.
- Per-job concurrency is the existing `inFlight` Set in `runSubmission`.
- Routes EVERY action through `runSubmission`, inheriting the live-quota
  refresh + redistribute + non-idempotent retry guard + orphan recovery.

### Live `/quota` refresh
- `services/quotaApi.js` caches per `imsOrgId` for 1 hour.
- Refreshed force-fresh at the top of every `planWorkOrders` and every
  `runSubmission` call.
- Hard floor: 24 h. Past that without a fresh fetch, the function
  throws `quota_unavailable` so Plan + Submit refuse to ship blind.

### Race conditions we explicitly considered
- **Two expansion batches inserting the same identity**: wave-based
  scheduling limits concurrent inserts to `WAVE_SIZE` tasks. Duplicate
  rows may land (no unique index), but `streamIdentitiesBySource`'s
  GROUP BY deduplicates them at planning time. The work-order payload
  is always clean because `normalizeNamespacesIdentities` further
  deduplicates `ids[]` before the Adobe POST.
- **Parallel submissions racing for quota**: SQLite serializes writes;
  `reserve()` reads-then-writes inside the same statement via
  `ON CONFLICT DO UPDATE`. No lost-update possible.
- **IMS token expiry mid-batch**: 401 interceptor invalidates the
  in-memory cache; next call re-authenticates automatically.

### Race conditions we did NOT address (documented limits)
- Two instances of the helper running against the same `data/state.db`
  would corrupt the WAL. Single-instance by design.
- If the process crashes between "reserve quota" and "Adobe call
  succeeds", the work order is left in `submitting` with no Adobe ID.
  `runner/recovery.js::reconcileOrphanWorkOrders()` runs at startup and
  reconciles via `GET /hygiene/workorder?displayName=...`:
    - On match → record the Adobe ID + markAccepted; let the monitor take over.
    - On no-match → leave in `submitting`, reservation HELD; NEVER auto-roll-back
      (R6 #1 — absence unproven). Operator resolves via release-absent (R7 #1).
    - On 400 (filter not supported) OR transient 5xx/network error →
      leave the row alone for next-startup retry. Never roll back when
      the answer is indeterminate — that would risk a duplicate Adobe
      work order if the original POST had actually been processed.

---

## 8. Security model

### Threat model
- **In scope**: protecting client secrets at rest from anyone reading
  `data/state.db` without the encryption key.
- **In scope** (added 2026-05-12): protecting destructive API endpoints
  from a malicious web page the operator visits (DNS rebinding and
  simple-form CSRF).
- **Out of scope**: protecting against a compromised host (if an
  attacker can read `data/.key` AND `data/state.db`, all secrets are
  exposed — but so is everything else on the machine).
- **Out of scope**: protecting against an operator who explicitly sets
  `HOST=0.0.0.0` to expose the API for a tunnelled demo.

### HTTP-layer guards (2026-05-12 security review)
`src/middleware/security.js` runs three middleware on every request:
- `hostHeaderGuard` — rejects with 421 when Host header is not
  localhost/127.0.0.1/[::1]. **The only defence against DNS rebinding**:
  a browser that's been tricked into talking to 127.0.0.1 still sends
  `Host: attacker.com` (the URL bar), which we detect.
- `originRefererGuard` — POST/PUT/PATCH/DELETE require Origin (or
  Referer fallback) to match the request's own Host. Closes the
  simple-form CSRF where a cross-origin `<form>` could POST to
  `/api/jobs/:id/submit` without preflight.
- `registerUuidParamGuards` — `app.param('id')` / `app.param('credsId')`
  reject malformed IDs with 400 before the route runs. Closes path-
  traversal in `/api/jobs/:id/export`.
- `helmet` with a tight CSP: `script-src 'self'`; `style-src 'self'
  'unsafe-inline'` (existing inline `style=` attributes);
  `frame-ancestors 'none'`; `object-src 'none'`;
  `cross-origin-resource-policy: same-origin`.
- Centralised `makeErrorHandler`: 5xx returns generic
  `"An internal error occurred"`; only 4xx surface caller-vetted
  `code` + `publicMessage`. No raw filesystem paths from
  better-sqlite3 / fs errors leak to clients.

### Encryption
- AES-256-GCM, per-row random 12-byte IV, 16-byte auth tag.
- Key derivation: none — the `ENCRYPTION_KEY` (or `data/.key`) is the
  raw 32-byte key material. 64-hex-char length enforced on load.
- First-run key creation uses `O_EXCL` (`flag: 'wx'`) so two parallel
  boots can't race two different keys onto disk.
- POSIX: explicit `chmod 0600` after `existsSync` check; Windows: the
  mode is informational only (filesystem doesn't honour it), so the
  startup banner warns when `data/` resolves under any cloud-sync path
  (OneDrive / Dropbox / Google Drive / iCloud / Box).
- `utils/crypto.js` exports `storeCreds()` and `decryptCreds()`.

### Tokens + credential metadata
- IMS tokens never persisted. Kept in `services/imsAuth.js` Map with
  expiry. Never logged in full (debug logs slice to 12 chars +
  ellipsis).
- `region` and `environment` on `POST /api/config/credentials` are
  validated against server-side allowlists (CLAUDE.md I14) — a stale
  or attacker-set region would otherwise template into the Identity
  API host and exfiltrate the bearer token. Defence-in-depth allowlist
  in `services/namespaces.js` and `services/identityGraph.js` URL
  builders refuses to compose the URL for an unknown region.
- All credential-route string fields have length caps + CR/LF/control-
  char rejection so CRLF can't smuggle headers through to IMS.

### Input sanitization
- Dataset IDs: regex `^[a-zA-Z0-9_-]+$` per segment.
- Display name: trimmed, truncated to 255 chars.
- Description: truncated to 1000 chars.
- CSV column values: trimmed, empty/null rows skipped.
- CSV export: `sanitiseCsvValue()` prefixes any value starting with
  `=`, `+`, `-`, `@`, tab, or CR with a leading apostrophe so
  Excel/Sheets can't execute it as a formula on open.
- multer 2.x with `files: 1, fields: 20, parts: 25, headerPairs: 100,
  fieldNameSize: 100, fieldSize: 64 KiB, fileSize: 4 GiB`.

### Things we do NOT sanitize but probably should
- The CSV *column selector* is passed directly into `streamIds`. If
  `column` is a header name string, we do `findIndex(h => h === column)`.
  A malicious user uploading a CSV could theoretically craft headers
  that collide with other columns. Low risk on a local tool but worth
  noting.
- The job `name` field is stored as-is in SQLite. It appears in the
  Adobe `displayName` which is truncated to 255. No HTML escaping
  needed server-side; the UI escapes when rendering.

---

## 9. Known limitations

Documented in `CLAUDE.md` but critical for review:

1. **Single source namespace per job** — all CSV rows are treated as
   one namespace. Mixed-namespace input requires separate jobs.
2. **Single-file upload per job** — one CSV at a time.
3. **Expansion resumes across restarts** — handled by
   `resumeExpandingJobs()`: builds a set of already-processed source
   IDs from `expanded_identities` and skips them when re-reading the
   CSV. Memory cost: ~50 MB per 1M processed sources during resume.
4. **Submission race on crash** — see Concurrency section above. The
   orphan-recovery path reconciles via Adobe's list endpoint; on a 400
   from the list endpoint we LEAVE the orphan alone (never roll back)
   so a duplicate work order can't be created if the original POST
   was actually processed.
5. **Poll frequency is fixed at 60s** — for very long jobs (weeks)
   this hammers Adobe. A geometric backoff (60s → 5min → 1h) would
   be better but isn't implemented.
6. **No UI for deleting / aborting a job** — cleanup requires
   `rm -rf data/` or manual SQL.
7. **Auto-resume scheduler defaults disabled** — opt-in. Operator
   enables it on the Submit tab. When disabled, deferred work orders
   stay deferred until the operator manually clicks Submit on the
   next month. When enabled, the 60s tick + startup catch-up handles
   it automatically.
8. **Quota numbers diverge between Adobe `/quota` and our local
   ledger** in two cases: (a) another tool consumed quota for the
   same org between our reserve() and Adobe's accounting; (b) Adobe
   itself is intermittently unreachable. Mitigation: Adobe `/quota`
   is the displayed truth; the redistributor re-buckets against fresh
   numbers before every submission run; the local ledger is purely a
   per-WO atomicity safety net.

---

## 10. Test coverage and gaps

**231 tests** as of the current codebase (`npm test`). Recent additions
(late-May 2026 hardening pass) extended coverage to: per-job orphan
reconciliation, the `DELETE /api/jobs/:id` route with the in-flight
guard, the `prepareStreamIdentitiesBySource()` Statement-per-call
isolation (the fix for the `statement busy` 500 on /export), the wave-
drain regression that prevents unhandled-rejection crashes when many
batches reject simultaneously (ECONNRESET-on-keep-alive scenario), and
the CSV pre-flight sniffer that rejects XLSX/UTF-16/MIP/binary uploads
before fast-csv runs.

### What IS covered (`test/*.test.js`)

**Core pipeline (pre-Phase 1)**
- IMS token caching, thundering-herd coalescing, 401 invalidation.
- Identity Graph batch expansion, dedup across overlapping clusters,
  chunking beyond 1000 IDs.
- Quota reservation atomicity under concurrency (`quotaManager.test.js`).
- Hygiene payload validation — 100k cap, empty list, missing display
  name, invalid dataset id, profile-only rule, duplicate namespaces.
- `submitWorkOrder` end-to-end with `Retry-After` + 429 simulation.
- Region routing (`region.test.js`) — correct vs. incorrect region sends
  to the right `platform-{region}.adobe.io` host; wrong-region fallback.
- Credentials CRUD + PATCH invariant — PATCH only updates label /
  client_name / region, never touches the encrypted secret or the
  identity-key fields (`credentialsRoutes.test.js`).
- Recovery reconciliation — orphan work orders without an Adobe ID are
  matched (→ submitted) or left in `submitting` (no-match / indeterminate →
  reservation held, never auto-rolled-back, R6 #1) depending on the Adobe
  response (`recovery.test.js`).

**Phase 1 — live quota (`quotaApi.test.js`, 8 tests)**
- Cache miss → fresh Adobe fetch, result returned.
- Cache hit within 1h → cached value returned without re-fetching.
- Stale fallback when Adobe is unreachable but cache < 24h.
- 24h hard floor: stale cache older than 24h throws `quota_unavailable`.
- `refresh: true` forces a fresh fetch even within the 1h window.
- Populated `{ daily, monthly }` structure validation.

**Phase 2 — redistributor (`redistributor.test.js`, 8 tests)**
- Identity batches below daily cap → all land in month 0 / day 0.
- 4M identity job with 2M monthly cap → months 0 + 1 split correctly.
- 10M job with 2M monthly cap + 1M daily cap → month × day grid correct.
- Partial `daily.remaining` (cap partially consumed) → first chunk
  honours the partial remaining, rest flows to next day.
- Shipped work orders are immutable — redistributor never touches them.
- Empty job → no-op.
- `shiftedFromPrevious` flag set correctly when quota forces a shift.

**Approval gate (`approveMonth.test.js`, 9 tests)**
- Happy path: 2 awaiting_approval WOs flipped to planned.
- Idempotency: re-approving the same month returns 404.
- Validation: monthIndex=1 (auto-submitted, no approval needed) → 400;
  non-integer, missing, zero → 400.
- No awaiting WOs for the month → 404.
- Unknown job → 404.

**Phase 3 — scheduler (`scheduler.test.js`, 20 tests)**
- Pure-function `shouldFireNow` covers: disabled; before fire time;
  after fire time never run; already run today; last run was yesterday;
  weekdays-only skips Saturday + Sunday; first-of-month fires only on 1st;
  malformed `localTime` fails closed.
- Pure-function `nextFireTime` covers: disabled → null; every-day before
  fire time → today; every-day after fire time → tomorrow; weekdays after
  Friday → Monday; first-of-month from mid-month → 1st of next month.
- Route round-trip: GET returns defaults; PUT accepts full payload + partial
  payload (just `enabled`); PUT rejects invalid `localTime`; rejects
  invalid `days` enum; rejects non-boolean `enabled`; confirms `lastRunAt`
  / `lastRunSummary` are not writable via the route.

**Security (`security.test.js`)**
- `hostHeaderGuard` blocks requests with non-localhost Host headers (DNS
  rebinding protection).
- `originRefererGuard` blocks state-changing requests from a mismatched
  Origin (CSRF protection).
- UUID param guard rejects malformed IDs before routes run.
- CSP header present on all responses.

### What is NOT covered (remaining gaps)

- **Canonicalization corner cases**: what happens when the Identity Graph
  returns a namespace not in our index (e.g. a namespace added between our
  cache fetch and the expansion call)? The code stores just `nsid` but no
  test proves that path through to the hygiene payload.
- **Plan builder cluster-bundling logic**: no tests for the packing or
  flush-at-100k boundary inside `planWorkOrders`. A bug here could
  mis-pack work orders and silently over-pack a single order.
- **Dataset filter**: no test that confirms we actually skip datasets
  without `unifiedIdentity: enabled:true`. The production codepath reads
  the tag; we trust it without a test.
- **Monitor tick**: no test for the polling loop or the
  `listOpenWorkOrders` predicate.
- **End-to-end flow**: no test drives `runExpansion → planWorkOrders →
  runSubmission` in sequence with a mocked Adobe. Coverage is per-module
  only.
- **Scheduler `runSubmission` integration**: the scheduler tests cover the
  time-gate logic but don't actually call `runSubmission`; the integration
  between `startScheduler` and the jobs table is untested end-to-end.
- **`quotaApi` + route integration**: the `GET /api/adobe/:credsId/quota`
  route has no dedicated test; the Phase 1 tests cover the service directly.
- **~~`failed` WO orphan recovery gap (Q12)~~** — **RESOLVED 2026-05-29**.
  Two changes: (a) the submission catch block no longer marks
  timeout/5xx/network errors as `failed` — they stay in `submitting`
  with quota held, so the existing startup `reconcileOrphanWorkOrders`
  catches them. (b) For pre-existing legacy `failed` rows (with no
  Adobe ID, from before the fix), the new
  `POST /api/jobs/:id/reconcile` route + `reconcileJobOrphans(jobId)`
  helper scan BOTH `submitting` and `failed` statuses, re-reserving
  quota for matches that turn out to have been processed by Adobe.
  Operator-triggered via the yellow "↻ Reconcile" banner on the
  Submit tab.

---

## 11. Specific review questions

Please consider these explicitly in your audit:

### Payload correctness
1. In `services/hygiene.js::normalizeNamespacesIdentities`, the
   namespace key uses `code || \`nsid:${id}\``. Is there ANY case
   where two namespaces share a code (e.g. custom namespaces with
   case variations) where our dedup would incorrectly merge them?

2. When canonicalization fails (namespace not in index), we emit
   `{code: null, id: nsid}` OR `{code: code, id: null}`. Adobe accepts
   either. Are we ever at risk of emitting `{code: null, id: null}`
   which would be invalid? Check `runner/expansion.js` row assembly.

3. The planner iterates `ORDER BY source_id, ns_code`. SQLite's
   `ORDER BY` places NULL first by default. Does that affect cluster
   bundling for custom namespaces that only have nsid?

### Quota model (Phase 1 / Phase 2)
4. `services/quotaApi.js` caches per `imsOrgId`. Multi-credential orgs
   (two credentials pointing at the same IMS org but different sandboxes)
   share one cache entry. Is it possible for credential A's recently-
   refreshed entry to mask a stale reading for credential B calling the
   same org?

5. `redistributor.js::redistributeUnshippedOrders` assigns
   `month_index=0` work from `daily.remaining`, then fills subsequent
   days up to `daily.quota`, and opens `month_index=1` using the stored
   `monthly.quota` rather than `monthly.remaining`. Is that correct? If
   another process consumed quota in month 1 already, we'd over-allocate
   to that month and potentially hit Adobe's cap mid-submission.

6. The redistributor calculates `Math.ceil(count / dailyCap)` days per
   month. When a cluster bundle is exactly `dailyCap` identities, does
   `ceil` assign it to one day correctly? Verify the off-by-one for
   boundaries.

### Scheduler (Phase 3)
7. `shouldFireNow` compares `lastRunAt` to today's fire time using
   `new Date(settings.lastRunAt) >= todayFireTime`. On a system where the
   operator manually sets the clock forward (or DST moves the clock),
   could `lastRunAt` in a past ISO string compare incorrectly against a
   locally-constructed `todayFireTime`? Are all Date comparisons timezone-
   consistent (all local vs. all UTC)?

8. The scheduler iterates jobs with un-shipped WOs and calls
   `runSubmission(jobId)` serially. A job with `status='expanding'` could
   theoretically be in this list if expansion just started. Does
   `runSubmission` handle a job mid-expansion safely (e.g. by checking job
   status before attempting to submit)?

9. `startScheduler()` fires a catch-up tick at boot. What if the catch-up
   tick runs WHILE the `setInterval` first tick also fires (boot happens
   at 09:00 exactly)? The `running` flag is checked at the top of the tick
   function — is the catch-up tick and the interval tick both using the
   same `running` flag?

### Concurrency
10. `bulkInsertIdentities` is wrapped in `db.transaction(...)`.
    better-sqlite3 transactions are synchronous but our caller is async.
    Is there any code path where two async tasks could call
    `bulkInsertIdentities` simultaneously and confuse better-sqlite3?
    (With deferred dedup, simultaneous inserts of the same identity are
    now allowed — both rows land. Dedup happens in `streamIdentitiesBySource`
    at planning time. Is there a scenario where this two-step dedup could
    produce an incorrect work-order payload?)

11. The quota `reserve()` function does:
    ```js
    const current = getQuota.get(...)?.used || 0;
    if (current + count > dailyLimit) return {granted: false, ...};
    upsertQuota.run(...);
    return {granted: true, ...};
    ```
    Between the `get` and the `run`, could another async task sneak
    in and over-reserve? (Consider better-sqlite3's synchronous
    semantics vs. the event loop.)

### Error handling
12. When `submitWorkOrder` throws we split by certainty: a **4xx** calls
    `release(woId)` (guarded, refunds only un-acked work) + marks 'failed'; a
    **5xx/timeout/network** is UNCERTAIN — Adobe may have created the WO, so we
    do NOT release; the reservation stays HELD and the WO stays `submitting`.
    The hygiene POST is non-idempotent (CLAUDE.md I11) so we never silently
    double-fire on a retry; orphan recovery reconciles via `GET /hygiene/
    workorder?displayName=…` (the persisted name, R6 #2). On match → record the
    Adobe ID + markAccepted, no re-submit. On ANY no-match (recognized-empty,
    400, network) → leave in `submitting`, reservation held; NEVER auto-roll-back
    (R6 #1). The operator resolves a verified-absent one via release-absent
    (R7 #1), gated against a still-in-flight POST (R8 #1).

13. The retry logic retries on 401 (token refresh) and 429 (rate-limit;
    Adobe didn't process the request). 5xx and network errors retry only
    for **idempotent** requests — GETs always; POSTs only when the call
    site explicitly tags `{idempotent: true}` (the Identity Graph cluster
    query opts in; the hygiene work-order POST does not). If the creds
    are genuinely wrong, we'd hit a 401, refresh once via IMS, then 401
    again on the retry — exits after one round-trip rather than five.

### Security
14. `services/config.js` route `POST /credentials/test` accepts inline
    creds OR a `credsId`. Could an attacker with local access to the
    API (which is bound to localhost but still) use this to enumerate
    stored credsIds?

15. The CSV uploads land in `data/uploads/`. After a job completes,
    they stay on disk forever. Should they be cleaned up? (The file
    contains the source identifier list — usually hashedKocids, not
    PII, but still worth discussing.)

16. The `originRefererGuard` checks Origin before falling back to
    Referer. Browsers send Origin on cross-origin fetch/XHR but may
    omit it on same-site navigational POSTs (e.g., `<form method=POST>`
    with same-origin action). Could a same-site form submission from a
    malicious page hosted on `127.0.0.1` (but a different port) bypass
    both guards if Origin is absent AND Referer matches only the host?

### Correctness of Adobe assumptions
17. We filter datasets to `tags.unifiedIdentity = "enabled:true"`.
    Is this the only dataset flag that Data Hygiene honors? Could a
    `unifiedProfile: enabled:true` dataset (without Identity) also
    accept deletes?

18. We assume Identity Graph response order matches request order
    (`data[i]` corresponds to `ids[i]`). Adobe doesn't explicitly
    document this. Are there cases where the response is re-ordered
    or deduplicated?

19. `x-sandbox-name` header: we pass the sandbox `name` (not `title`).
    Adobe's docs say "sandbox name, not title", which is what we do —
    but could the header ever need `title` in some edge case (e.g.
    the `available sandboxes` endpoint)?

20. Adobe's `GET /data/core/hygiene/quota` is documented as org-wide
    (no `x-sandbox-name` needed). Our code sends it without a sandbox
    header. If Adobe changes this to be sandbox-scoped, our quota numbers
    would be wrong. Is there any evidence Adobe has moved this direction?

---

## Files to prioritize when reviewing

If your time is limited, review in this order:

1. **`src/services/hygiene.js`** — destructive payload construction.
   Every validator here must be correct.
2. **`src/runner/submission.js::planWorkOrders`** — cluster bundling
   logic; subtle correctness. Also `runSubmission` for quota sequencing.
3. **`src/runner/redistributor.js`** — month × day assignment from live
   quota. A bug here silently over-allocates a month's cap.
4. **`src/services/quotaApi.js`** — the 24h hard floor and stale-cache
   logic. Any bypass here ships blind against a destructive API.
5. **`src/services/namespaces.js`** — canonicalization is core to
   I2 in CLAUDE.md.
6. **`src/services/quotaManager.js`** + call sites in submission —
   quota accounting atomicity.
7. **`src/runner/scheduler.js`** — time-gate logic, reentrancy guard,
   startup catch-up tick safety.
8. **`src/middleware/security.js`** — host guard, origin guard,
   UUID param guard. Any gap here exposes the destructive API.
9. **`src/services/imsAuth.js`** — token cache concurrency.
10. Everything else is more mechanical (CSV streaming, routes,
    DB boilerplate).

## Output expected from reviewer

A list of findings, each with:
- **Severity** (blocker / major / minor / nit)
- **Location** (`file:line` or function name)
- **Issue** (what's wrong)
- **Proposed fix** (optional but appreciated)

Feel free to ask the maintainer questions before deciding severity —
context matters, especially for the "we explicitly decided not to do X"
cases documented above.
