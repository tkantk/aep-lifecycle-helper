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
explicitly to expose it. No auth on the local UI (trusted single-user).
Earlier versions of this doc claimed localhost binding without actually
enforcing it; `app.listen(port, host, cb)` now passes the host explicitly.

**Persistence**: one SQLite file (`data/state.db`) in WAL mode.
`better-sqlite3` synchronous driver.

**Concurrency**: all work happens in the event loop. Identity-graph
expansion uses `p-limit(10)` for 10 parallel Adobe calls; work-order
submission uses `p-limit(2)`. No worker threads, no child processes.

**Dependencies**: `express`, `better-sqlite3`, `axios`, `axios-retry`,
`multer`, `fast-csv`, `p-limit`, `uuid`, `dotenv`, `open`. Dev: `nock`.

**Frontend**: zero-build vanilla HTML/CSS/JS served from `src/web/` by
Express. Adobe Spectrum-styled. Talks to the backend via `fetch('/api/…')`.

---

## 2. Full data flow with invariants

```
┌──────────────┐
│ 1. Config    │  User picks stored creds or enters fresh.
│              │  Test Connection → IMS token obtained, sandboxes loaded
│              │  from Adobe. User picks sandbox → datasets loaded,
│              │  filtered to Identity-enabled. User picks deletion mode:
│              │     datasets | all | profile-only
└──────┬───────┘
       ▼
┌──────────────┐
│ 2. Upload    │  CSV streamed to disk (never loaded in memory).
│              │  Row-count pass (streaming) populates progress denominator.
│              │  Job row inserted into jobs table, status='expanding'.
│              │  runExpansion() fired and forgotten (in-process async).
└──────┬───────┘
       ▼
┌──────────────┐  Load namespace registry once → build byCode/byId index.
│ 3. Expansion │  For each 1000-ID buffer:
│ (p-limit 10) │    POST /data/core/identity/clusters/members
│              │    Canonicalize every returned identity to {code, id}
│              │    INSERT OR IGNORE into expanded_identities
│              │    (dedup key: job_id, ns_code||'', ns_id||0, identity_id)
│              │  Progress updated in memory + DB.
└──────┬───────┘
       ▼
┌──────────────┐  Iterate expanded_identities ORDER BY source_id, ns_code.
│ 4. Plan      │  Build cluster bundles (all rows with same source_id).
│              │  Pack bundles into ≤100k-ID work orders.
│              │  Assign day_index respecting dailyLimit.
│              │  Insert one row per work order (status='planned').
└──────┬───────┘
       ▼
┌──────────────┐  For each planned OR deferred order on the selected day:
│ 5. Submit    │    Reserve quota (daily + monthly) in SQLite (atomic UPSERT).
│ (p-limit 2)  │    If not granted → mark 'deferred', skip. The next submit
│              │    after UTC daily/monthly rollover picks these up again
│              │    (selector matches both 'planned' and 'deferred').
│              │    If granted → POST /data/core/hygiene/workorder.
│              │    POST is non-idempotent: NO retry on 5xx/network.
│              │    On success: persist adobe_workorder_id.
│              │    On failure: release(count, monthlyLimit), mark 'failed'.
└──────┬───────┘
       ▼
┌──────────────┐  setInterval(60s). Finds work orders where
│ 6. Monitor   │    adobe_workorder_id IS NOT NULL AND
│              │    adobe_status NOT IN ('completed','failed').
│              │  GET /data/core/hygiene/workorder/{id}
│              │  Update adobe_status, product_status_details.
│              │  Up to 30 polls per tick (rate limiting).
└──────────────┘
```

Each step's state persists to SQLite, so the process can be killed and
restarted without losing progress.

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
- Matches each cluster to its source by `compositeXid.id` (falls back to
  array position if absent).
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

All under `/api/` on `http://127.0.0.1:3000`. No auth — security model
relies on the loopback-only socket (CLAUDE.md I12).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/config/credentials` | Store or upsert creds (encrypts secret at rest, keyed on (env, ims_org, client_id)) |
| GET  | `/api/config/credentials` | List stored creds (no secrets in response) |
| PATCH | `/api/config/credentials/:id` | Update label / client_name / region only — never touches the encrypted secret or identity fields. Returns 404 if id not found, 400 if label missing |
| POST | `/api/config/credentials/test` | IMS auth check via stored id or inline creds |
| DELETE | `/api/config/credentials/:id` | Remove creds. Returns **409** with `{error: 'credential_in_use', jobCount}` when any row in `jobs` references this credential — protects status polling and recovery from being orphaned |
| GET  | `/api/adobe/:credsId/sandboxes` | Live list of sandboxes |
| GET  | `/api/adobe/:credsId/sandboxes/:sandbox/datasets?refresh=1&identityOnly=1` | Datasets filtered to Identity-enabled |
| GET  | `/api/adobe/:credsId/sandboxes/:sandbox/namespaces?refresh=1` | Namespace registry |
| POST | `/api/upload` (multipart) | Create job + start expansion |
| GET  | `/api/jobs` | List jobs by `created_at DESC` (every status, every sandbox) |
| GET  | `/api/jobs/monitor?limit&search&sandbox` | Active-submissions feed: jobs with ≥1 Adobe-acked work order. **In-flight-first sort** (recently-completed jobs never push pending work off-screen) then by latest WO activity. Returns `{ rows, totals, sandboxes }` — rows are limit-capped; totals (`in_flight` / `has_failed` / `all_completed` / `total`) span ALL matching jobs; sandboxes is the distinct sandbox list with counts for the filter chip row. Optional `?search` (case-insensitive name LIKE) and `?sandbox` (exact match). |
| GET  | `/api/jobs/:id` | Job detail + namespace breakdown + quota |
| GET  | `/api/jobs/:id/progress` | Live expansion progress (fast path) |
| POST | `/api/jobs/:id/plan` | Build work-order plan |
| POST | `/api/jobs/:id/submit` | Kick off submission (optional `{dayIndex}`) |
| GET  | `/api/jobs/:id/work-orders` | All work orders for job |
| GET  | `/api/jobs/:id/export` | Download expanded identities CSV |

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

Query `SELECT … FROM expanded_identities WHERE job_id=? ORDER BY source_id, ns_code`.

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
  known.
- **expanded_identities** — per-cluster-member rows. Both `ns_code` and
  `ns_id` stored. Unique index on `(job_id, COALESCE(ns_code,''),
  COALESCE(ns_id,0), identity_id)` so dedup works regardless of whether
  Adobe returned us the code, the nsid, or both.
- **work_orders** — one per Adobe work order. `namespaces_identities` is
  the full JSON payload (we store it so we can retry or audit later).
- **quota_usage** — `(ims_org_id, utc_date) → used`. Rolls over at UTC
  midnight by virtue of the date being part of the key.

---

## 7. Concurrency model

### Within expansion
- CSV stream feeds a buffer. Every 1000 rows, a `p-limit(N)`-gated
  async task is kicked off.
- All tasks resolve before the runner returns.
- Each task:
  - Calls Adobe once (via retry-wrapped axios).
  - Builds a row array.
  - Calls `bulkInsertIdentities(rows)` which runs a single SQLite
    transaction. `INSERT OR IGNORE` handles dedup.

### Within submission
- `p-limit(2)` over planned-or-deferred orders.
- Each worker:
  - Calls `reserve(orgId, count, dailyLimit, monthlyLimit)` — atomic SQLite
    UPSERT against both daily and monthly ledgers (monthly skipped if null).
  - If granted, posts to Adobe (hygiene POST is non-idempotent — see
    CLAUDE.md I11).
  - On success, updates work_orders row.
  - On failure, calls `release(orgId, count, monthlyLimit)` before
    re-throwing — monthlyLimit gate prevents bleed into other jobs' monthly
    counters when monthly tracking was off for this job.

### Status monitor
- `setInterval(60_000, tick)`.
- Each tick selects up to 30 open work orders (to avoid overrunning
  Adobe's rate limits on GETs during long runs).
- Polls each serially within the tick.

### Race conditions we explicitly considered
- **Two expansion batches inserting the same identity**: handled by
  `INSERT OR IGNORE` on the unique index. Both may succeed; only one row
  lands.
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
    - On match → record the Adobe ID and let the monitor take over.
    - On confirmed no-match → roll back to `planned` and `release` quota.
    - On 400 (filter not supported) OR transient 5xx/network error →
      leave the row alone for next-startup retry. Never roll back when
      the answer is indeterminate — that would risk a duplicate Adobe
      work order if the original POST had actually been processed.

---

## 8. Security model

### Threat model
- **In scope**: protecting client secrets at rest from anyone reading
  `data/state.db` without the encryption key.
- **Out of scope**: protecting against a compromised host (if an
  attacker can read `data/.key` AND `data/state.db`, all secrets are
  exposed — but so is everything else on the machine).
- **Out of scope**: network-level protection. HTTP binds to `127.0.0.1`
  by default — this is now enforced at `app.listen(port, host)` rather
  than relied on as a Node default. Operators who set `HOST=0.0.0.0`
  to expose the API are explicitly opting out of the security model.

### Encryption
- AES-256-GCM, per-row random 12-byte IV, 16-byte auth tag.
- Key derivation: none — the `ENCRYPTION_KEY` (or `data/.key`) is the
  raw 32-byte key material. 64-hex-char length enforced on load.
- `utils/crypto.js` exports `storeCreds()` and `decryptCreds()`.

### Tokens
- Never persisted. Kept in `services/imsAuth.js` Map with expiry.
- Never logged in full. Debug logs slice to 12 chars + ellipsis.

### Input sanitization
- Dataset IDs: regex `^[a-zA-Z0-9_-]+$` per segment.
- Display name: trimmed, truncated to 255 chars.
- Description: truncated to 1000 chars.
- CSV column values: trimmed, empty/null rows skipped.

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
3. **Expansion doesn't resume across restarts** — if the process
   crashes mid-expansion, the job stays `expanding` and must be
   manually retried. Source IDs already processed won't be
   re-expanded (they're in `expanded_identities`) but the streamer
   starts from the beginning of the CSV, which is wasteful.
4. **Submission race on crash** — see Concurrency section above.
5. **Poll frequency is fixed at 60s** — for very long jobs (weeks)
   this hammers Adobe. A geometric backoff (60s → 5min → 1h) would
   be better but isn't implemented.
6. **No UI for deleting / aborting a job** — cleanup requires
   `rm -rf data/` or manual SQL.

---

## 10. Test coverage and gaps

### What IS covered (`test/*.test.js`)
- IMS token caching, thundering-herd coalescing, 401 invalidation.
- Identity Graph batch expansion, dedup across overlapping clusters,
  chunking beyond 1000 IDs.
- Quota reservation atomicity under concurrency.
- Hygiene payload validation — 100k cap, empty list, missing display
  name, invalid dataset id, profile-only rule, duplicate namespaces.
- `submitWorkOrder` end-to-end with `Retry-After` + 429 simulation.

### What is NOT covered (gaps the reviewer should flag)
- **Canonicalization corner cases**: what happens when the Identity
  Graph returns a namespace not in our index (e.g. a namespace added
  between our cache fetch and the expansion call)?
- **Plan builder**: no tests for the cluster-bundling logic or the
  day-index assignment. A bug here could mis-pack work orders.
- **Dataset filter**: no test that confirms we actually skip datasets
  without `unifiedIdentity: enabled:true`.
- **Monitor tick**: no test for the polling logic or the
  `listOpenWorkOrders` predicate.
- **End-to-end flow**: no test drives `runExpansion → planWorkOrders →
  runSubmission` in sequence with a mocked Adobe.

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

### Concurrency
4. `bulkInsertIdentities` is wrapped in `db.transaction(...)`.
   better-sqlite3 transactions are synchronous but our caller is async.
   Is there any code path where two async tasks could call
   `bulkInsertIdentities` simultaneously and confuse better-sqlite3?

5. The quota `reserve()` function does:
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
6. When `submitWorkOrder` throws, we call `release(count, monthlyLimit)`.
   What if Adobe accepted the POST but we timed out waiting for the
   response? The work order is created on their side but we "released"
   the quota. Mitigation: the hygiene POST is non-idempotent (CLAUDE.md
   I11) so we never silently double-fire on a retry; the orphan-recovery
   routine on next startup attempts to reconcile via `GET /hygiene/
   workorder?displayName=…`. On match it records the Adobe ID without
   re-submitting. On 400 from the listing endpoint it leaves the row in
   `submitting` rather than rolling back, so we don't create a duplicate
   work order on the next submit.

7. The retry logic retries on 401 (token refresh) and 429 (rate-limit;
   Adobe didn't process the request). 5xx and network errors retry only
   for **idempotent** requests — GETs always; POSTs only when the call
   site explicitly tags `{idempotent: true}` (the Identity Graph cluster
   query opts in; the hygiene work-order POST does not). If the creds
   are genuinely wrong, we'd hit a 401, refresh once via IMS, then 401
   again on the retry — exits after one round-trip rather than five.

### Security
8. `services/config.js` route `POST /credentials/test` accepts inline
   creds OR a `credsId`. Could an attacker with local access to the
   API (which is bound to localhost but still) use this to enumerate
   stored credsIds?

9. The CSV uploads land in `data/uploads/`. After a job completes,
   they stay on disk forever. Should they be cleaned up? (The file
   contains the source identifier list — usually hashedKocids, not
   PII, but still worth discussing.)

### Correctness of Adobe assumptions
10. We filter datasets to `tags.unifiedIdentity = "enabled:true"`.
    Is this the only dataset flag that Data Hygiene honors? Could a
    `unifiedProfile: enabled:true` dataset (without Identity) also
    accept deletes?

11. We assume Identity Graph response order matches request order
    (`data[i]` corresponds to `ids[i]`). Adobe doesn't explicitly
    document this. Are there cases where the response is re-ordered
    or deduplicated?

12. `x-sandbox-name` header: we pass the sandbox `name` (not `title`).
    Adobe's docs say "sandbox name, not title", which is what we do —
    but could the header ever need `title` in some edge case (e.g.
    the `available sandboxes` endpoint)?

---

## Files to prioritize when reviewing

If your time is limited, review in this order:

1. **`src/services/hygiene.js`** — destructive payload construction.
   Every validator here must be correct.
2. **`src/runner/submission.js::planWorkOrders`** — cluster bundling
   logic; subtle correctness.
3. **`src/services/namespaces.js`** — canonicalization is core to
   I2 in CLAUDE.md.
4. **`src/services/quotaManager.js`** + call sites in submission —
   quota accounting.
5. **`src/services/imsAuth.js`** — token cache concurrency.
6. Everything else is more mechanical (CSV streaming, routes,
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
