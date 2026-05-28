# AEP Data Lifecycle Helper
## Design & Architecture Document

---

| Field        | Value                                           |
|--------------|-------------------------------------------------|
| Version      | 2.0.0                                           |
| Date         | 2026-05-28                                      |
| Status       | Production-ready                                |
| Author       | Tushar Kant Kar (Adobe)                         |
| Audience     | Client teams, platform architects, reviewers    |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [End-to-End Data Flow](#3-end-to-end-data-flow)
4. [Work Order Lifecycle](#4-work-order-lifecycle)
5. [Multi-Month Quota Planning](#5-multi-month-quota-planning)
6. [Adobe API Integration](#6-adobe-api-integration)
7. [Security Architecture](#7-security-architecture)
8. [Environment Configuration Reference](#8-environment-configuration-reference)
9. [Operational Procedures](#9-operational-procedures)
10. [Design Decisions](#10-design-decisions)
11. [Known Limitations & Extension Points](#11-known-limitations--extension-points)
12. [Appendix — File Map](#12-appendix--file-map)

---

## 1. Executive Summary

### What This Tool Does

The **AEP Data Lifecycle Helper** is a secure, operator-run application that
executes bulk identity deletion requests against Adobe Experience Platform (AEP)
via the Data Hygiene API. An operator supplies a CSV of source identifiers
(typically hashed customer identifiers such as `hashedKocid`), and the tool
automatically:

1. **Expands** each source identifier through the AEP Identity Graph to discover
   every linked identity — email addresses, phone numbers, ECIDs, CRMIDs, custom
   namespace IDs, and more.
2. **Plans** the resulting identities into work orders of up to 100,000 identifiers
   each, respecting both Adobe's per-day and per-month deletion quotas.
3. **Submits** each work order to Adobe's Data Hygiene API in a quota-safe,
   crash-safe, and duplicate-safe manner.
4. **Monitors** every submitted work order to completion, surfacing status in
   a browser dashboard.

### Why It Was Built

Adobe's Data Hygiene service is an API-only offering. Managing bulk deletions at
scale — across tens of thousands to millions of identifiers — requires careful
orchestration of identity resolution, quota compliance, idempotent submission, and
crash recovery. Ad-hoc scripting against this API risks silent failures against an
irreversible destructive operation. This tool codifies the correct behavior, validates
every payload before it touches Adobe's API, and tracks all state durably so
operators can stop and resume at any time.

### Key Capabilities

| Capability                     | Detail                                                         |
|--------------------------------|----------------------------------------------------------------|
| Identity graph expansion       | Follows all identity links via AEP's Private Graph             |
| Multi-namespace support        | Email, phone, ECID, CRMID, GAID, IDFA, custom namespaces       |
| Quota-aware planning           | Respects daily (default 1M/day) and monthly caps               |
| Multi-month batching           | Spans deletions across calendar months with per-month approval |
| Crash-safe submission          | Startup recovery reconciles any orphaned work orders           |
| Encrypted credential storage   | AES-256-GCM for all Adobe client secrets at rest               |
| Auto-resume scheduler          | Configurable daily schedule for unattended quota rollovers     |
| Profile-only mode              | Deletes from Identity + Profile + AJO without touching data lake |

### Architecture Principles

- **Local-first, single-process.** Runs on the operator's machine. No cloud
  infrastructure, no Docker, no Kubernetes.
- **One SQLite file for all state.** Zero administration, point-in-time
  durability, fast prepared statements.
- **Validate before the wire.** Every work-order payload is validated locally
  before any network call. Adobe's irreversible API is never reached with a
  malformed request.
- **Non-idempotent hygiene POST.** Adobe's deletion call is never automatically
  retried on failure — duplicate submissions create duplicate irreversible deletes.

---

## 2. System Architecture

### 2.1 High-Level Architecture

The tool is a single Node.js process running on the operator's machine.
There is no cloud infrastructure — all data, state, and secrets live
locally. The only outbound traffic is HTTPS calls to Adobe's documented
APIs.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          OPERATOR'S MACHINE                                │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Browser  ──HTTP──►  Express server  (src/index.js, 127.0.0.1:3000)        │
│                                                                            │
│  REST API Routes                  Background Runners                       │
│  ─────────────────                ──────────────────────                   │
│  /api/config/*                    expansion.js   CSV → Identity Graph      │
│  /api/adobe/*                     submission.js  Plan + quota-gated POST   │
│  /api/upload                      redistributor  Re-bucket vs live quota   │
│  /api/jobs/*                      monitor.js     60s WO status polling     │
│  /api/settings/*                  recovery.js    Boot-time reconciliation  │
│                                   scheduler.js   Auto-resume (opt-in)      │
│                                                                            │
│  Adobe Service Layer              Security Middleware                      │
│  ─────────────────────            ──────────────────────                  │
│  imsAuth      adobeClient         Host-header guard (DNS rebinding)        │
│  sandboxes    datasets            Origin / Referer guard (CSRF)            │
│  namespaces   identityGraph       Helmet (CSP, COOP, CORP)                 │
│  hygiene      quotaApi            AES-256-GCM credential encryption        │
│  quotaManager                                                              │
│                                                                            │
│  Persistence  (data/ directory — never committed, never cloud-synced):     │
│    state.db     SQLite (WAL mode) — every table lives here                 │
│    .key         AES-256 encryption key (chmod 600, never synced)           │
│    uploads/     Streamed CSV uploads                                       │
│    output/      Exported result CSVs                                       │
│                                                                            │
│  SQLite tables: credentials · sandbox_configs · jobs · work_orders         │
│                 expanded_identities · quota_usage · quota_usage_monthly    │
│                 app_settings                                               │
│                                                                            │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │  HTTPS  (TLS 1.2+)
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       ADOBE EXPERIENCE PLATFORM                            │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  IMS Authentication       POST /ims/token/v3                               │
│                           Host: ims-na1.adobelogin.com                     │
│                                                                            │
│  Identity Service         POST /data/core/identity/clusters/members        │
│  (region-sharded)         GET  /data/core/idnamespace/identities           │
│                           Host: platform-{region}.adobe.io                 │
│                                                                            │
│  Platform Services        GET  /data/foundation/sandbox-management/        │
│                           GET  /data/foundation/catalog/dataSets           │
│                           Host: platform.adobe.io                          │
│                                                                            │
│  Data Hygiene API         POST /data/core/hygiene/workorder    (DESTRUCTIVE│
│  (the destructive one)    GET  /data/core/hygiene/workorder/{id}  — never  │
│                           GET  /data/core/hygiene/quota         auto-retried)│
│                           Host: platform.adobe.io                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Summary

| Component             | File                          | Responsibility                                              |
|-----------------------|-------------------------------|-------------------------------------------------------------|
| Express server        | `src/index.js`                | Boot, route mounting, runner startup, security middleware   |
| Config                | `src/config.js`               | Env-var defaults; all tunables in one place                 |
| Database              | `src/db.js`                   | SQLite schema, migrations, all prepared statements          |
| Expansion runner      | `src/runner/expansion.js`     | CSV stream → batched Identity Graph calls → SQLite          |
| Submission runner     | `src/runner/submission.js`    | Planner + quota-gated work-order submission                 |
| Redistributor         | `src/runner/redistributor.js` | Re-buckets unshipped WOs against live Adobe quota           |
| Monitor runner        | `src/runner/monitor.js`       | 60s polling of Adobe work-order status                      |
| Recovery runner       | `src/runner/recovery.js`      | Boot-time orphan reconciliation and expansion resume        |
| Auto-resume scheduler | `src/runner/scheduler.js`     | Configurable daily auto-submit on quota rollover            |
| IMS auth              | `src/services/imsAuth.js`     | Token cache with thundering-herd guard                      |
| Adobe HTTP client     | `src/services/adobeClient.js` | axios with retry, backoff, auth injection, error enrichment |
| Identity Graph        | `src/services/identityGraph.js` | POST /clusters/members, both response shapes              |
| Hygiene               | `src/services/hygiene.js`     | Work-order payload validation + POST                        |
| Quota API             | `src/services/quotaApi.js`    | Live Adobe /quota with 1h cache and 24h hard floor          |
| Quota manager         | `src/services/quotaManager.js`| SQLite-backed daily + monthly ledgers (atomic reserve)      |
| Security middleware   | `src/middleware/security.js`  | Host guard, CSRF guard, error handler                       |
| Crypto                | `src/utils/crypto.js`         | AES-256-GCM envelope encryption for client secrets         |

### 2.3 Technology Stack

| Layer          | Choice          | Reason                                                        |
|----------------|-----------------|---------------------------------------------------------------|
| Runtime        | Node.js 20 LTS  | Long-term support; `better-sqlite3` has prebuilt binaries     |
| HTTP server    | Express 4       | Minimal, well-understood, no magic                            |
| Database       | SQLite (WAL)    | Zero-admin, single-file, crash-safe; sufficient throughput    |
| SQLite driver  | better-sqlite3  | Synchronous API; ~100k rows/sec bulk insert; no async queuing |
| HTTP client    | axios           | Interceptors for auth inject, retry, error enrichment         |
| Concurrency    | p-limit         | Simple, battle-tested async concurrency limiter               |
| CSV parsing    | fast-csv        | Streaming; never loads entire file into memory                |
| UI             | Vanilla JS/HTML | No build step; edit and refresh; no bundler dependency        |
| Testing        | node --test     | Built-in; no Jest/Mocha install; nock for HTTP mocking        |

---

## 3. End-to-End Data Flow

### 3.1 Operator Journey Overview

```
  CONFIGURE        UPLOAD           EXPAND           PLAN
  ─────────────────────────────────────────────────────────
      │                │                │               │
      ▼                ▼                ▼               ▼
  Enter IMS        Drop CSV         Fetch all       Pack into
  credentials   ──► to disk      ──► linked      ──► work orders
  Pick sandbox     Create job       identities       Assign day
  Test connect     row (DB)         via Identity     + month index
  Fetch quota                       Graph (AEP)
      │                │                │               │
      └────────────────┴────────────────┴───────────────┘
                            ▼
  APPROVE          SUBMIT           MONITOR         EXPORT
  ─────────────────────────────────────────────────────────
      │                │                │               │
      ▼                ▼                ▼               ▼
  Month 2+        Reserve         Poll Adobe      Download CSV
  WOs need     ──► quota        ──► every 60s  ──► with status
  explicit        POST to          Track all        per source
  operator        Adobe            status           identifier
  approval        Hygiene          transitions
                  API
```

### 3.2 Step-by-Step Detail

```
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 1 — CONFIGURE                                                     │
│                                                                         │
│  Operator enters in the Config tab:                                     │
│    • IMS Org ID, Client ID, Client Secret                               │
│    • Region (va7 / nld2 / aus5 / can2)                                  │
│    • Environment (Production / Stage / Development)                     │
│                                                                         │
│  On "Test Connection":                                                  │
│    POST /ims/token/v3 ──► bearer token (cached in memory, 24h TTL)      │
│    GET  /sandbox-management/ ──► sandbox list                           │
│    GET  /quota ──► live daily + monthly caps displayed in UI banner     │
│                                                                         │
│  Client secret stored: AES-256-GCM encrypted in data/state.db          │
│  IMS token: in-memory only (never written to disk)                      │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 2 — UPLOAD                                                        │
│                                                                         │
│  Operator selects:                                                      │
│    • Target namespace (e.g. hashedKocid)                                │
│    • Deletion scope (ALL datasets / specific datasets / profile-only)   │
│    • CSV file of source identifiers                                     │
│                                                                         │
│  Server:                                                                │
│    Streams CSV to data/uploads/  (never fully in memory)                │
│    Counts rows → sets job.source_count                                  │
│    Creates jobs row with status = 'ready'                               │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 3 — EXPAND  (runner/expansion.js)                                 │
│                                                                         │
│  Operator clicks "Start Identity Expansion" on the Jobs tab.            │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  CSV stream                                                       │  │
│  │    │                                                              │  │
│  │    ▼ read 1,000 IDs per batch (Adobe hard limit)                  │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │  │
│  │  │  Batch 1   │  │  Batch 2   │  │  Batch 3   │  │   ...      │ │  │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └────┬───────┘ │  │
│  │        │               │               │               │         │  │
│  │        └───────────────┴───────────────┴───────────────┘         │  │
│  │                         │ p-limit(10) concurrent                  │  │
│  │                         ▼                                         │  │
│  │              POST /identity/clusters/members                      │  │
│  │              (region-specific host per credential)                │  │
│  │                         │                                         │  │
│  │                         ▼                                         │  │
│  │              Response: clusters[].members[]                       │  │
│  │              Each member: { nsid, id }                            │  │
│  │              Canonicalized to { code, nsid } via namespace index  │  │
│  │                         │                                         │  │
│  │                         ▼                                         │  │
│  │              INSERT into expanded_identities (SQLite)             │  │
│  │              (plain INSERT, no unique constraint,                 │  │
│  │               dedup performed at planning time via GROUP BY)      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Wave scheduling: batches processed in waves of 20 (concurrency × 2)  │
│  to keep memory constant regardless of file size.                       │
│                                                                         │
│  On completion: COUNT DISTINCT identities → set job.found_count         │
│  Job status: expanding → expanded                                        │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 4 — PLAN  (runner/submission.js::planWorkOrders)                  │
│                                                                         │
│  1. Fetch live quota from Adobe GET /quota (with 1h cache)             │
│  2. Run redistributor: assign day_index + month_index to any           │
│     existing unshipped work orders                                      │
│  3. Stream expanded_identities, deduplicated via GROUP BY               │
│     (ns_code, ns_id, identity_id), ordered by source_id                │
│  4. Bundle identities per cluster (keep clusters together)              │
│  5. Pack bundles into work orders (≤ 100,000 identifiers each)          │
│  6. Assign day_index (advance day when daily cap would overflow)        │
│     and month_index (advance month when monthly cap would overflow)     │
│  7. Month 1 work orders → status = 'planned'                            │
│     Month 2+ work orders → status = 'awaiting_approval'                 │
│     (operator must explicitly approve each future month)                │
│                                                                         │
│  Guard: throws HTTP 409 (ReplanForbiddenError) if any work order       │
│  has already shipped to Adobe — prevents duplicate deletions.           │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 5 — APPROVE  (if multi-month job)                                 │
│                                                                         │
│  Month 1 ships immediately on Submit.                                   │
│                                                                         │
│  Month 2, 3, … are shown in the Plan tab as "Awaiting Approval".        │
│  Operator reviews the planned quantity and clicks "Approve Month N".    │
│                                                                         │
│  POST /api/jobs/:id/approve-month  { monthIndex: 2 }                   │
│    → flips WOs from awaiting_approval → planned                         │
│    → Month N becomes eligible for the next Submit run                   │
│                                                                         │
│  This gate prevents accidental multi-month submissions and gives        │
│  operators a review checkpoint before each month's quota is consumed.   │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 6 — SUBMIT  (runner/submission.js::runSubmission)                 │
│                                                                         │
│  For each planned (or deferred) work order:                             │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Quota check (SQLite atomic transaction)                          │  │
│  │    daily_used + count ≤ daily_limit?   ──No──► mark DEFERRED     │  │
│  │    monthly_used + count ≤ monthly_limit?──No──► mark DEFERRED    │  │
│  │    Both pass ──► reserve quota (increment both ledgers)          │  │
│  │         │                                                         │  │
│  │         ▼                                                         │  │
│  │  POST /data/core/hygiene/workorder                                │  │
│  │    Payload validated locally before the call:                     │  │
│  │      • ≤ 100,000 identifiers total                                │  │
│  │      • datasetId format (ALL / id / comma-list)                   │  │
│  │      • targetServices ↔ datasetId="ALL" consistency               │  │
│  │      • each namespace has code and/or numeric id                  │  │
│  │         │                                                         │  │
│  │         ├─ Success ──► record Adobe work-order ID, mark SUBMITTED │  │
│  │         ├─ Quota denied (429) ──► safe to retry; token refresh    │  │
│  │         ├─ Network error/5xx ──► quota released, mark FAILED      │  │
│  │         │   (never auto-retried — would create duplicate deletes) │  │
│  │         └─ Quota denied by our ledger ──► mark DEFERRED           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Deferred orders retry automatically after UTC midnight rollover.       │
│  The auto-resume scheduler can handle this unattended.                  │
└─────────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 7 — MONITOR  (runner/monitor.js, every 60 seconds)                │
│                                                                         │
│  For each submitted work order (up to 100 per tick, p-limit(5)):        │
│    GET /data/core/hygiene/workorder/{adobe_workorder_id}                │
│                                                                         │
│  Status transitions persisted in SQLite:                                │
│    received → validated → submitted → ingested → completed              │
│                                              └─────────────► failed     │
│                                                                         │
│  Monitor tab in the UI refreshes every 15 seconds showing:              │
│    • Per-job cards with completion progress bars                         │
│    • In-flight jobs always ranked first (never pushed off-screen)        │
│    • Per-work-order pipeline table in the detail panel                   │
│    • Sandbox filter chips for multi-sandbox operators                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Work Order Lifecycle

### 4.1 State Machine

The work-order lifecycle is a strict state machine. Every state transition
is logged. Terminal states (`completed`, `failed`) never move backward.

```
ENTRY — from POST /api/jobs/:id/plan
─────────────────────────────────────────────────────────────────────────────

        ┌──────────────────┐              ┌─────────────────────────┐
        │     PLANNED      │              │   AWAITING_APPROVAL     │
        │   Month 1 WOs    │              │   Month 2+ WOs          │
        └────────┬─────────┘              └────────────┬────────────┘
                 │                                     │
                 │              Operator clicks "Approve Month N":
                 │              POST /api/jobs/:id/approve-month
                 │                                     │
                 │   ┌─────────────────────────────────┘
                 │   │  (Month N flips to planned)
                 ▼   ▼
        ┌──────────────────────────┐
        │  runSubmission picks up  │ ◄────── DEFERRED rows retry here
        └────────────┬─────────────┘         after UTC rollover (daily
                     │                       or monthly)
                     ▼                                          ▲
          ┌──────────────────────┐                              │
          │  Reserve quota       │                              │
          │  (atomic SQLite tx:  │                              │
          │   daily + monthly)   │                              │
          └────┬────────────┬────┘                              │
        GRANTED            DENIED                               │
               │              │                                 │
               ▼              ▼                                 │
        ┌─────────────┐  ┌──────────────┐                       │
        │ SUBMITTING  │  │   DEFERRED   │───────────────────────┘
        │             │  │              │
        │ POST Adobe  │  │ Quota cap    │
        │ /workorder  │  │ hit; waits   │
        └──┬───────┬──┘  │ for rollover │
       2xx │       │     └──────────────┘
           │       │ 4xx / 5xx / network
           │       │ (quota released; never auto-retried)
           ▼       ▼
   ┌─────────────┐  ┌──────────────┐
   │  SUBMITTED  │  │    FAILED    │
   │  Adobe ACK  │  │  (terminal)  │
   └──────┬──────┘  └──────────────┘
          │
          │  monitor.js polls GET /workorder/{id} every 60 seconds
          ▼
  ┌────────────────────────────────────────────────┐
  │  Adobe-side status progression:                │
  │    received → validated → submitted →          │
  │    ingested → COMPLETED   OR   FAILED          │
  └────────────────┬──────────────────────┬────────┘
                   ▼                      ▼
            ┌──────────────┐       ┌──────────────┐
            │  COMPLETED   │       │    FAILED    │
            │  (terminal)  │       │  (terminal)  │
            └──────────────┘       └──────────────┘
```

**Crash recovery (boot-time, in `runner/recovery.js`):**

When the process crashes between quota reservation and Adobe's POST
acknowledgment, work orders are left as orphans (`status='submitting'`
with `adobe_workorder_id IS NULL`). On next startup, recovery looks each
one up in Adobe by `displayName` prefix and applies the appropriate
resolution:

```
 ┌─ Match found in Adobe (displayName-prefix list lookup returns the WO)
 │     → record adobe_workorder_id; status → SUBMITTED  (monitor takes over)
 │
 ├─ Confirmed absent (Adobe returned 200 OK, our prefix not in the list)
 │     → release quota; status → PLANNED  (next submit run retries safely)
 │
 └─ Lookup indeterminate (Adobe returned 4xx / 5xx / network error)
       → leave as SUBMITTING; retry reconciliation on the NEXT boot
         Never roll back when the answer is ambiguous, because rolling
         back could create a duplicate Adobe work order if the original
         POST had actually been processed.
```

### 4.2 Status Reference

| Status                | Description                                                    | Next action           |
|-----------------------|----------------------------------------------------------------|-----------------------|
| `planned`             | Work order created locally; ready to submit to Adobe           | runSubmission picks up |
| `awaiting_approval`   | Month 2+ gate; operator must approve before submission         | Click "Approve Month N" |
| `deferred`            | Quota exhausted for today; will retry after UTC midnight       | Auto-resumes next day  |
| `submitting`          | POST to Adobe in-flight (crash window)                         | Recovery reconciles    |
| `submitted`           | Adobe has acknowledged; monitoring in progress                 | Monitor polls 60s      |
| `completed`           | Adobe confirms deletion complete (terminal)                    | Export results         |
| `failed`              | Adobe returned error or POST failed (terminal)                 | Review error message   |

---

## 5. Multi-Month Quota Planning

### 5.1 Why Multi-Month Planning Exists

Adobe's Data Hygiene API enforces two quota dimensions:

- **Daily cap**: typically 1,000,000 identifiers per day (varies by contract)
- **Monthly cap**: typically 3,000,000 identifiers per month (varies by contract)

A large deletion batch (e.g. 4 million identifiers from a 1.5M-row CSV after
graph expansion) will span multiple calendar months. The planner assigns each
work order to a `(month_index, day_index)` bucket upfront, so the operator can
see the full timeline before any work is submitted.

### 5.2 Planning Diagram

```
  INPUT:  2,500,000 expanded identifiers
  QUOTA:  Daily cap = 1,000,000  ·  Monthly cap = 3,000,000

  ┌─────────────────────────────────────────────────────────────────────┐
  │  MONTH 1  (ships immediately on first Submit click)                 │
  │                                                                     │
  │  Running              Identifiers          Work Orders              │
  │  daily total          in bucket            created                  │
  │  ──────────           ──────────           ──────────               │
  │  Day 1   1,000,000   ████████████████████  10 × 100k WOs           │
  │  Day 2   1,000,000   ████████████████████  10 × 100k WOs           │
  │  Day 3     500,000   ██████████             5 × 100k WOs           │
  │            ───────                                                  │
  │  Month 1 total: 2,500,000  ✓ Within monthly cap (3,000,000)        │
  │  Remaining: 500,000 carry to Month 2                                │
  └─────────────────────────────────────────────────────────────────────┘

  ─── Operator reviews Month 2 plan ─── Clicks "Approve Month 2" ─────►

  ┌─────────────────────────────────────────────────────────────────────┐
  │  MONTH 2  (status: awaiting_approval → planned after approval)      │
  │                                                                     │
  │  Day 1     500,000   ██████████             5 × 100k WOs           │
  │            ───────                                                  │
  │  Month 2 total: 500,000  ✓ Within monthly cap                       │
  └─────────────────────────────────────────────────────────────────────┘

  TOTAL JOB: 2,500,000 identifiers across 2 months, 4 days, 25 WOs
```

### 5.3 Live Quota Redistribution

Before **every** plan and every submit run, the tool fetches live quota
from Adobe's `GET /quota` endpoint. The **redistributor** then re-assigns
`(day_index, month_index)` to all unshipped work orders to reflect the
current quota remaining.

```
  EXAMPLE: 300,000 identifiers consumed from today's quota by another source

  Before redistribution:                 After redistribution:
  ──────────────────────                 ─────────────────────
  Day 1: 1,000,000 capacity              Day 1: 700,000 remaining
    WO-001: 100,000 ─ planned              WO-001: 100,000 ─ planned
    WO-002: 100,000 ─ planned              WO-002: 100,000 ─ planned
    WO-003: 100,000 ─ planned              WO-003: 100,000 ─ planned
    ...                                    WO-004 → Day 2 (overflow)
    WO-010: 100,000 ─ planned

  The redistributor moves work orders across day/month buckets as needed.
  Only unshipped WOs are ever re-bucketed. Already-shipped WOs are immutable.
  The identity content (namespacesIdentities) never changes.
```

---

## 6. Adobe API Integration

### 6.1 API Summary

| Method | Endpoint                                                    | Purpose                        | Host                          |
|--------|-------------------------------------------------------------|--------------------------------|-------------------------------|
| POST   | `/ims/token/v3`                                             | IMS bearer token               | ims-na1.adobelogin.com        |
| GET    | `/data/foundation/sandbox-management/`                      | List active sandboxes          | platform.adobe.io             |
| GET    | `/data/foundation/catalog/dataSets`                         | List Identity-enabled datasets | platform.adobe.io             |
| GET    | `/data/core/idnamespace/identities`                         | List identity namespaces       | platform-{region}.adobe.io    |
| POST   | `/data/core/identity/clusters/members`                      | Expand identity cluster        | platform-{region}.adobe.io    |
| POST   | `/data/core/hygiene/workorder`                              | Create record-delete WO        | platform.adobe.io             |
| GET    | `/data/core/hygiene/workorder/{id}`                         | Poll work-order status         | platform.adobe.io             |
| GET    | `/data/core/hygiene/quota`                                  | Live daily + monthly quota     | platform.adobe.io             |

### 6.2 Region Architecture

Identity Service APIs are regionally sharded. Using the wrong region returns
HTTP 200 with empty cluster data — a silent partial delete.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Identity Service regions                                           │
  │                                                                     │
  │  Credential row → region field                                      │
  │                          │                                          │
  │                          ▼                                          │
  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                    │
  │  │  va7   │  │  nld2  │  │  aus5  │  │  can2  │                    │
  │  │ VA     │  │ NL     │  │ AU     │  │ CA     │                    │
  │  │ (US)   │  │(Europe)│  │(APAC)  │  │(Canada)│                    │
  │  └────────┘  └────────┘  └────────┘  └────────┘                    │
  │                                                                     │
  │  URL pattern: https://platform-{region}.adobe.io                   │
  │                                                                     │
  │  Server-side allowlist prevents SSRF: only the four known regions   │
  │  can be stored on a credential row.                                  │
  └─────────────────────────────────────────────────────────────────────┘
```

### 6.3 Work-Order Payload

```json
{
  "action": "delete_identity",
  "datasetId": "ALL",
  "displayName": "Delete job-abc123 - WO 1 - Day 1",
  "description": "Bulk identity deletion - 95,000 identifiers",
  "targetServices": ["identity", "profile", "ajo"],
  "namespacesIdentities": [
    {
      "namespace": { "code": "email", "id": 6 },
      "ids": ["user@example.com", "user2@example.com"]
    },
    {
      "namespace": { "code": "hashedKocid", "id": 11124296 },
      "ids": ["abc123hash", "def456hash"]
    }
  ]
}
```

**Payload constraints (all validated locally before the network call):**

| Field                  | Constraint                                                                  |
|------------------------|-----------------------------------------------------------------------------|
| `ids` total count      | 1 – 100,000 (Adobe hard limit)                                              |
| `datasetId`            | `"ALL"` \| single dataset ID \| comma-joined list (no mixing `"ALL"` with specific IDs) |
| `targetServices`       | When present: must be `["identity","profile","ajo"]` AND `datasetId` must be `"ALL"` |
| Namespace entry        | Each entry must have `code` (string) and/or `id` (numeric nsid)             |

### 6.4 Identity Quota

| Dimension | Default | Configurable via |
|-----------|---------|-----------------|
| Daily cap | 1,000,000 identifiers | Adobe contract; read from live `/quota` |
| Monthly cap | 3,000,000 identifiers | Adobe contract; read from live `/quota` |

Adobe's `/quota` endpoint is the **source of truth**. The tool's stored
`daily_limit`/`monthly_limit` values are fallbacks used only when the live
endpoint is unreachable and no cache exists.

---

## 7. Security Architecture

### 7.1 Defense-in-Depth Model

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  LAYER 1 — Network Isolation                                        │
  │                                                                     │
  │  Server binds to 127.0.0.1 (loopback) by default.                  │
  │  The unauthenticated API is not reachable from the LAN.             │
  │  Setting HOST=0.0.0.0 opts out of this protection entirely —        │
  │  only do so for SSH-tunneled demos, never for production.           │
  └─────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  LAYER 2 — HTTP Request Guards  (src/middleware/security.js)        │
  │                                                                     │
  │  ① Host-Header Guard                                                │
  │     Rejects requests where Host ≠ localhost / 127.0.0.1 / [::1]   │
  │     Purpose: blocks DNS rebinding attacks                           │
  │     (attacker resolves attacker.com → 127.0.0.1, serves malicious  │
  │      JS; guard rejects because Host header is still attacker.com)  │
  │                                                                     │
  │  ② Origin / Referer Guard                                           │
  │     POST / PUT / PATCH / DELETE must carry matching Origin header   │
  │     Purpose: blocks cross-site request forgery (CSRF)               │
  │     (a malicious page posting to localhost would have the wrong     │
  │      Origin and be rejected before any state changes)               │
  │                                                                     │
  │  ③ Helmet Middleware (CSP + security headers)                       │
  │     Content-Security-Policy: script-src 'self'  (no CDN scripts)   │
  │     Content-Security-Policy: frame-ancestors 'none'  (no iframes)  │
  │     Content-Security-Policy: object-src 'none'                     │
  │     Cross-Origin-Opener-Policy: same-origin                        │
  │     Cross-Origin-Resource-Policy: same-origin                      │
  └─────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  LAYER 3 — Server-Side Allowlists                                   │
  │                                                                     │
  │  region       ∈ { va7, nld2, aus5, can2 }                           │
  │  environment  ∈ { Production, Stage, Development }                  │
  │                                                                     │
  │  Purpose: prevents SSRF via region injection.                       │
  │  Without this, a tampered credential row could cause the server     │
  │  to inject bearer tokens into a host controlled by an attacker.     │
  │                                                                     │
  │  All credential fields validated for length + control characters    │
  │  (CR/LF/null) — these flow into outbound HTTP headers.              │
  └─────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  LAYER 4 — Credential Encryption                                    │
  │                                                                     │
  │  Raw client secret                                                  │
  │       │                                                             │
  │       ▼                                                             │
  │  AES-256-GCM encryption                                             │
  │    Key: data/.key (auto-generated, chmod 600) or ENCRYPTION_KEY env │
  │    IV:  12 random bytes per row                                      │
  │    Tag: 16-byte authentication tag (detects tampering)              │
  │       │                                                             │
  │       ▼                                                             │
  │  Ciphertext stored in data/state.db                                 │
  │                                                                     │
  │  IMS bearer tokens:                                                 │
  │    Cached in-memory only — never written to disk                    │
  │    Auto-refreshed 120 seconds before expiry                         │
  │    Thundering-herd guard: concurrent callers share one in-flight    │
  │    promise (no duplicate refresh races)                             │
  └─────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  LAYER 5 — Static Asset Isolation                                   │
  │                                                                     │
  │  All UI assets (fonts, icons, scripts, styles) are self-hosted.     │
  │  Zero CDN loads from the browser — no google-fonts.com, no          │
  │  cloudflare, no analytics pixels.                                   │
  │                                                                     │
  │  Rationale: this is an admin tool for destructive operations. Any   │
  │  third-party origin receives the operator's IP, user-agent, and     │
  │  timing data — unacceptable for an offline-capable security tool.   │
  └─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Submission Safety

```
  CRITICAL: Adobe work orders are IRREVERSIBLE. The following safeguards
  prevent duplicate or erroneous submissions:

  1. Payload validation before every POST — 5 checks in hygiene.js
     (identifier count, datasetId format, targetServices consistency,
      namespace shape, no duplicate namespace groups)

  2. Non-idempotent retry policy — network errors and 5xx responses
     are NOT retried for the hygiene POST. Only 401 (token refresh)
     and 429 (rate limit) are retried, because those unambiguously
     mean Adobe did NOT process the request.

  3. ReplanForbiddenError — attempting to re-plan after any work order
     has shipped returns HTTP 409. The UI disables the Re-plan button
     automatically. Prevents re-emitting identities already deleted.

  4. Orphan recovery — if the process crashes between quota reservation
     and Adobe's ACK, startup recovery looks up the work order by
     displayName prefix. Confirmed-absent → roll back. Indeterminate
     (Adobe returned 400 or network error) → leave as-is; retry next boot.
     Never roll back when the answer is ambiguous.
```

---

## 8. Environment Configuration Reference

### 8.1 Complete Environment Variable Reference

All variables are optional. The tool runs with zero `.env` configuration
on first launch. Set these to tune behavior for your deployment.

#### Network & Server

| Variable       | Default         | Description                                                                                                           |
|----------------|-----------------|-----------------------------------------------------------------------------------------------------------------------|
| `PORT`         | `3000`          | HTTP port the Express server listens on. Change if 3000 is in use.                                                    |
| `HOST`         | `127.0.0.1`     | Bind address. Default is loopback-only (safe). Set to `0.0.0.0` ONLY for SSH-tunnel demos. Exposes the unauthenticated API to the LAN — add authentication before doing this in any shared environment. |
| `OPEN_BROWSER` | `1`             | Set to `0` to prevent automatic browser launch on `npm start`.                                                        |

#### Storage Paths

| Variable      | Default                  | Description                                                                                                          |
|---------------|--------------------------|----------------------------------------------------------------------------------------------------------------------|
| `DATA_DIR`    | `./data`                 | Directory for all persistent state (database, encryption key, uploads, output). **Move this outside OneDrive / iCloud / Dropbox** to avoid cloud-sync interference with SQLite WAL files. Recommended: `%LOCALAPPDATA%\aep-lifecycle-helper` on Windows, `~/.local/share/aep-lifecycle-helper` on Linux/macOS. |
| `DB_PATH`     | `$DATA_DIR/state.db`     | Override the SQLite database file path directly. Useful for pointing at an existing database from a different `DATA_DIR`. |
| `UPLOAD_DIR`  | `$DATA_DIR/uploads`      | Directory for streamed CSV uploads. Must be writeable.                                                               |
| `OUTPUT_DIR`  | `$DATA_DIR/output`       | Directory for exported result CSVs.                                                                                  |

#### Security

| Variable         | Default                 | Description                                                                                                           |
|------------------|-------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `ENCRYPTION_KEY` | *(auto-generated)*      | 32-byte hex string used for AES-256-GCM encryption of client secrets. If not set, the key is auto-generated and stored in `$DATA_DIR/.key` on first run. Set this explicitly if you want the key to survive a `data/` reset, or to use a key managed by your secrets manager. **Do not commit this value.** |

#### Performance Tuning (scalability knobs)

| Variable                  | Default     | Description                                                                                                           |
|---------------------------|-------------|-----------------------------------------------------------------------------------------------------------------------|
| `SQLITE_CACHE_MB`         | `512`       | SQLite page cache in megabytes. Larger cache = fewer disk I/Os during expansion and planning. Each MB covers approximately 256 × 4KB pages. See per-machine recommendations below. |
| `IDENTITY_CONCURRENCY`    | `10`        | Maximum parallel `POST /clusters/members` calls during expansion. Adobe's Identity Graph supports up to ~10–20 concurrent requests before 429 rate-limiting becomes frequent. |
| `IDENTITY_BATCH_SIZE`     | `1000`      | Source identifiers per Identity Graph batch call. 1,000 is Adobe's hard maximum — do not increase. Decrease only if you encounter payload-size errors. |
| `WORK_ORDER_CONCURRENCY`  | `2`         | Parallel work-order POSTs during submission. Adobe's Hygiene API is not highly parallelized — keep at 1–3. |
| `MAX_IDS_PER_WORK_ORDER`  | `100000`    | Identifiers per work order. 100,000 is Adobe's hard maximum. Do not increase. Decrease only for debugging. |
| `REQUEST_TIMEOUT_MS`      | `60000`     | HTTP request timeout in milliseconds (60 seconds). Increase for very slow network connections or VPN routing. |

#### Quota Fallbacks

These values are **fallbacks only**. The tool always prefers live quota from
Adobe's `GET /quota` endpoint. These are used only when the endpoint is
unreachable and no cache exists.

| Variable                   | Default       | Description                                                                                                           |
|----------------------------|---------------|-----------------------------------------------------------------------------------------------------------------------|
| `DAILY_IDENTIFIER_LIMIT`   | `1000000`     | Fallback daily identifier deletion cap. Match your Adobe contract entitlement. |
| `MONTHLY_IDENTIFIER_LIMIT` | `3000000`     | Fallback monthly identifier deletion cap. Match your Adobe contract. Set to `0` to disable monthly quota tracking (useful for contracts with no monthly cap). |

#### Adobe Endpoints (advanced)

| Variable              | Default                                    | Description                                                                                                           |
|-----------------------|--------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `AEP_GATEWAY`         | `https://platform.adobe.io`                | Base URL for all non-Identity AEP APIs. Override only for on-premise or staging environments. |
| `IMS_HOST`            | `https://ims-na1.adobelogin.com`           | IMS authentication host. Override for non-production IMS environments. |
| `IMS_SCOPE`           | *(standard AEP scopes)*                    | OAuth 2.0 scopes included in the token request. Change only if your Adobe organization uses a non-standard scope set. |
| `AEP_IDENTITY_REGION` | `va7`                                      | Global fallback identity region. Used only when a credential row lacks a `region` value (pre-migration data). For all new credentials, region is stored per-credential. |

### 8.2 Per-Machine Tuning Recommendations

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  QUICK-START  .env  (place in project root, never commit)            │
  │                                                                      │
  │  # ─── Storage (keep outside cloud sync) ─────────────────────────  │
  │  # Windows: DATA_DIR=C:\Users\YourName\AppData\Local\aep-helper      │
  │  # macOS:   DATA_DIR=/Users/YourName/.local/share/aep-helper         │
  │  # Linux:   DATA_DIR=/home/YourName/.local/share/aep-helper          │
  │                                                                      │
  │  # ─── Performance (tune to your machine) ─────────────────────────  │
  │  SQLITE_CACHE_MB=1024         # 16 GB laptop                         │
  │  IDENTITY_CONCURRENCY=10      # default, safe for most orgs          │
  └──────────────────────────────────────────────────────────────────────┘
```

| Machine type                 | `SQLITE_CACHE_MB` | `IDENTITY_CONCURRENCY` | Notes                                    |
|------------------------------|-------------------|------------------------|------------------------------------------|
| Laptop, 8–16 GB RAM          | `512` – `1024`    | `8` – `10`             | Default settings; no change needed       |
| Laptop, 32 GB RAM            | `8192`            | `15`                   | Entire B-tree fits in RAM; no I/O degradation on large jobs |
| Dedicated server, 8–16 GB RAM | `2048`           | `15` – `20`            | More headroom; adjust to available RAM   |
| Dedicated server, 32+ GB RAM  | `4096`           | `20`                   | High throughput; watch Adobe 429 rate   |

### 8.3 Development / Testing

| Variable      | Default | Description                                                                                                           |
|---------------|---------|-----------------------------------------------------------------------------------------------------------------------|
| `SMOKE_SUBMIT`| *(unset)* | Set to `1` to allow the live smoke test (`test/smoke.live.js`) to submit actual work orders to Adobe. **Requires real credentials in environment variables.** Never set this in CI unless you intend live deletions. |

### 8.4 Sample `.env` Files

**Minimal (laptop, first run):**
```env
# No configuration needed — defaults work out of the box.
# Optionally set DATA_DIR to keep data outside cloud sync:
DATA_DIR=C:\Users\YourName\AppData\Local\aep-lifecycle-helper
```

**Tuned for a 32 GB Windows laptop:**
```env
DATA_DIR=C:\Users\YourName\AppData\Local\aep-lifecycle-helper
SQLITE_CACHE_MB=8192
IDENTITY_CONCURRENCY=15
```

**Tuned for a dedicated server:**
```env
DATA_DIR=/var/lib/aep-lifecycle-helper
SQLITE_CACHE_MB=4096
IDENTITY_CONCURRENCY=20
WORK_ORDER_CONCURRENCY=2
HOST=127.0.0.1
OPEN_BROWSER=0
```

**Externally managed encryption key:**
```env
DATA_DIR=/var/lib/aep-lifecycle-helper
ENCRYPTION_KEY=<32-byte-hex-from-your-secrets-manager>
```

---

## 9. Operational Procedures

### 9.1 Prerequisites

```
  Node.js 20 LTS  (required — better-sqlite3 needs prebuilt binaries)

  Windows:
    winget install CoreyButler.NVMforWindows
    nvm install 20.18.0
    nvm use 20.18.0

  macOS / Linux:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    nvm install 20
    nvm use 20
```

### 9.2 Installation & First Run

```bash
npm install          # compiles better-sqlite3 native binding

# Optional: create a .env file (see §8.4 above)

npm start            # starts server, opens browser at http://localhost:3000
```

1. **Config tab** — enter IMS credentials (Environment, IMS Org ID, Client ID,
   Client Secret, Region). Click **Test Connection**. The tool fetches your live
   daily and monthly quota and displays it in the banner.
2. **Pick a sandbox** from the dropdown. Datasets and namespace registry load
   automatically.
3. **Select deletion scope**: ALL datasets, specific datasets, or profile-only
   (Identity + Profile + AJO, no data lake).
4. **Upload tab** — select the source namespace (e.g. `hashedKocid`), drop the
   CSV, click **Start Identity Expansion**.
5. Wait for expansion to complete (progress bar in the Jobs tab).
6. Click **Plan Work Orders**. Review the day/month breakdown.
7. Click **Submit Day 1**. Work orders are sent to Adobe.
8. Switch to the **Monitor tab** to track progress.

### 9.3 Running Tests

```bash
node --test test
```

All 178 tests should pass. The suite covers:
- Work-order payload validators (27 tests)
- Namespace canonicalization (11 tests)
- IMS token cache (7 tests)
- Quota manager — daily, monthly, null-monthly release gating (12 tests)
- Planner — cluster packing, replan guard, deferred tolerance (12 tests)
- Startup recovery — orphan reconciliation, 400-indeterminate handling (6 tests)
- Adobe client — error enrichment, idempotency-aware retries (11 tests)
- Per-credential region routing (3 tests)
- Credentials routes — PATCH non-secret safety, DELETE 409 (7 tests)
- Monitor feed — sorting, filters, aggregates, sandbox filter (11 tests)
- Approve-month gate (9 tests)
- End-to-end integration with fully-mocked Adobe (3 tests)

### 9.4 Recovering From a Crash

Restart the application — no manual action needed in the common case.

On startup, `runStartupRecovery()` automatically:
- **Resumes expanding jobs.** Re-reads the CSV but skips already-processed
  source IDs (built from the existing `expanded_identities` rows). No
  redundant Adobe calls.
- **Reconciles orphan work orders.** For each work order stuck in `submitting`
  with no Adobe ID (the crash window), looks up the order in Adobe by its
  `displayName` prefix:
  - **Match found** — records the Adobe ID and hands off to the monitor.
  - **Confirmed absent** — rolls back to `planned` and releases quota.
  - **Indeterminate** (Adobe returned 400, network error) — leaves the orphan
    for the next startup to retry. Never rolls back ambiguous cases.

### 9.5 Rotating Credentials

1. Update the secret in the **Adobe Developer Console**.
2. Config tab → pick the saved credential from the dropdown → update
   **Client Secret** → click **Test Connection**. The new encrypted secret
   is saved. The in-memory token cache auto-invalidates on the next 401.

### 9.6 Full Reset (wipe all state)

```bash
# Close the app first (Ctrl+C / close window)
rm -rf data/
npm start
```

Deletes the SQLite database, encryption key, all uploads and exports.
A fresh Config tab awaits on next start.

### 9.7 Auto-Resume Scheduler

The scheduler allows unattended operation across multi-day and multi-month
jobs without the operator needing to manually click Submit each morning.

Configure via **Settings tab** (or `PUT /api/settings/auto-resume`):

| Setting               | Options                                    | Default    |
|-----------------------|--------------------------------------------|------------|
| Enabled               | on / off                                   | off        |
| Local time            | HH:MM (24h, operator's local time)         | `09:00`    |
| Days                  | every-day / weekdays / first-of-month      | every-day  |

When the scheduler fires, it runs the full `runSubmission` pipeline
(live quota refresh → redistribute → submit). A catch-up tick runs at boot
so a laptop that was off at the scheduled time resumes within seconds.

---

## 10. Design Decisions

### 10.1 Why SQLite, Not Postgres or Redis

This tool runs on one operator's laptop, not a distributed service. SQLite
in WAL mode delivers:
- Zero-administration durability (one file, crash-safe)
- Fast concurrent reads during long writes
- ~100k rows/sec bulk insert with prepared statements
- No deployment complexity

A distributed database would only be needed for multi-operator shared state —
explicitly out of scope (see §11).

### 10.2 Why Validate Before the Network

Adobe's Data Hygiene API returns HTTP 400 on malformed payloads, but the cost
of an undetected error (wrong namespace, wrong dataset ID) is a no-op delete
that uses quota. Pre-validating also eliminates:
- Wasted IMS token exchanges on doomed requests.
- Cryptic Adobe error messages leaking to the UI.
- Round-trip latency for mistakes catchable in microseconds.

### 10.3 Why In-Memory IMS Tokens (Not Persisted)

Bearer tokens are temporary secrets. Persisting them opens a ~24h window
where anyone reading `data/state.db` can impersonate the operator. In-memory
caching with thundering-herd coalescing regenerates in ~300ms on restart —
the performance cost is negligible; the security benefit is material.

### 10.4 Why the Hygiene POST Is Never Retried on 5xx

Adobe's Data Hygiene work order creation is irreversible. A 5xx response could
mean Adobe processed the request (and is returning an internal error) or did
not (transient failure). Auto-retrying would create duplicate deletions in the
first case. The safe path: don't retry; let startup recovery reconcile via
`displayName` lookup on next boot.

### 10.5 Why Deferred Dedup (No Unique Index on `expanded_identities`)

On large jobs (8M+ rows), SQLite's B-tree unique index for deduplication
becomes the dominant bottleneck:

- Each `INSERT OR IGNORE` must traverse the full B-tree to check for
  duplicates (~400MB of index pages at 8M rows)
- With only 512MB cache, most page lookups hit disk
- On Windows, each SQLite checkpoint triggers a Windows Defender scan,
  inflating each fsync from ~1ms to 10–50ms

Solution: remove the unique index; do plain `INSERT`; deduplicate at
planning time via `GROUP BY (ns_code, ns_id, identity_id)`. This is O(1)
per insert during expansion and the GROUP BY uses a full table scan once
at planning time — much faster overall.

### 10.6 Why Wave-Based Expansion Scheduling

Creating all 1,570 batch promises at once (for a 1.57M-row CSV) allocates
memory for every batch before any batch has completed, preventing garbage
collection. Wave scheduling processes `concurrency × 2` batches at a time
and pauses the CSV stream at each wave boundary. Memory use stays constant
regardless of file size.

---

## 11. Known Limitations & Extension Points

### 11.1 Current Limitations

| Limitation                   | Detail                                                                                       |
|------------------------------|----------------------------------------------------------------------------------------------|
| Single-process only          | Running two instances against the same `data/state.db` will corrupt the WAL. No advisory lock. |
| No multi-user auth           | The local web UI has no authentication. Whoever can reach `127.0.0.1:3000` has full access. |
| Single source namespace      | All rows in the CSV are treated as one namespace. For mixed-namespace sources, run separate jobs per namespace. |
| One CSV per job              | No batch/folder upload. Each deletion batch requires a separate job.                         |
| No credential export         | Each machine encrypts with its own `data/.key`. Moving credentials to a new machine requires re-entering them. |
| Monitor polls 60s            | Adobe doesn't emit webhooks for work-order status. 60-second polling is the only option.    |
| UTC midnight quota rollover  | A job submitted at 11:59 PM local time that Adobe processes after 00:00 UTC counts against the next day's quota. |
| OneDrive path warning        | SQLite WAL files inside a cloud-synced path can trigger `SQLITE_BUSY` errors. Set `DATA_DIR` outside the sync folder. |

### 11.2 Extension Points

These features are not currently implemented but are architecturally
straightforward to add:

| Feature                      | Implementation path                                                                          |
|------------------------------|----------------------------------------------------------------------------------------------|
| Multi-operator support       | Move state to Postgres; add session auth on the web UI; add advisory locks for concurrent planning |
| Webhook-based status updates | Replace the 60s monitor with a `POST /api/callback` handler when Adobe adds webhook support  |
| Operator audit log           | Wire `adobeClient.js` to insert one row per Adobe call into the existing `api_audit` table stub |
| Batch CSV upload             | Add a folder-drop endpoint that creates one job per CSV file                                  |
| Schema-aware dataset filter  | Pre-check each dataset's XDM primary identity via the Schema Registry API; warn if the deletion namespace isn't the primary |

---

## 12. Appendix — File Map

```
aep-lifecycle-helper/
├── src/
│   ├── index.js                    Express entrypoint + boot sequence + runner startup
│   ├── config.js                   All env-overridable defaults (the only place to add env vars)
│   ├── db.js                       SQLite open + schema + migrations + all prepared statements
│   │
│   ├── services/                   Thin wrappers over Adobe APIs
│   │   ├── imsAuth.js              IMS token cache + thundering-herd guard
│   │   ├── adobeClient.js          axios factory (retry, backoff, auth inject, error enrichment)
│   │   ├── sandboxes.js            GET /sandbox-management/
│   │   ├── datasets.js             GET /catalog/dataSets (filtered to Identity-enabled)
│   │   ├── namespaces.js           GET /idnamespace/identities + canonicalize()
│   │   ├── identityGraph.js        POST /clusters/members (handles both response shapes)
│   │   ├── hygiene.js              Work-order payload validation + POST /workorder
│   │   ├── quotaApi.js             GET /quota (1h cache, 24h hard floor on stale)
│   │   └── quotaManager.js         SQLite daily + monthly ledgers (atomic reserve/release)
│   │
│   ├── runner/                     In-process background work
│   │   ├── expansion.js            CSV stream → wave-scheduled Identity Graph → SQLite
│   │   ├── submission.js           Planner (replan guard) + quota-gated submission
│   │   ├── redistributor.js        Re-buckets unshipped WOs against live Adobe quota
│   │   ├── scheduler.js            Configurable daily auto-resume (setInterval 60s tick)
│   │   ├── monitor.js              pLimit(5) status poll every 60s (up to 100 WOs per tick)
│   │   └── recovery.js             Boot-time expansion resume + orphan WO reconciliation
│   │
│   ├── middleware/
│   │   └── security.js             Host-header guard, Origin/Referer CSRF guard, error handler
│   │
│   ├── routes/
│   │   ├── config.js               Credential CRUD (allowlisted region + environment)
│   │   ├── adobe.js                Sandbox / dataset / namespace discovery + /quota
│   │   ├── upload.js               CSV upload + job creation
│   │   ├── jobs.js                 Plan / approve-month / submit / progress / export
│   │   └── settings.js             GET/PUT /api/settings/auto-resume
│   │
│   ├── utils/
│   │   ├── csv.js                  Streaming CSV read/write + formula-injection sanitiser
│   │   ├── crypto.js               AES-256-GCM envelope + O_EXCL first-run key creation
│   │   └── logger.js               Structured JSON or text logger
│   │
│   └── web/                        Zero-build static UI (no framework, no bundler)
│       ├── index.html              Page template (Spectrum-styled, no CDN references)
│       ├── styles.css              Spectrum tokens + @font-face (self-hosted only)
│       ├── app.js                  Vanilla JS controller (~1,200 lines)
│       ├── aep-icon.svg            Local AEP brand mark (top bar + favicon)
│       ├── data-cleansing-icon.svg Adobe Data Cleansing icon (sidebar)
│       └── fonts/                  Self-hosted Source Sans 3 (.woff2, OFL-licensed)
│
├── test/
│   ├── hygiene.test.js             Work-order payload validators (27 tests)
│   ├── namespaces.test.js          Namespace canonicalization + index (11 tests)
│   ├── imsAuth.test.js             Token cache + thundering-herd + nock (7 tests)
│   ├── quotaManager.test.js        Daily + monthly ledgers + null-monthly gate (12 tests)
│   ├── planWorkOrders.test.js      Cluster packing + replan guard + deferred (12 tests)
│   ├── recovery.test.js            Orphan reconciliation + 400-indeterminate (6 tests)
│   ├── adobeClient.test.js         Error enrichment + idempotency-aware retries (11 tests)
│   ├── region.test.js              Per-credential region routing (3 tests)
│   ├── deferred.test.js            Deferred-row surfacing in submission (1 test)
│   ├── credentialsRoutes.test.js   PATCH non-secret-only + DELETE 409 (7 tests)
│   ├── monitorJobs.test.js         Monitor feed: sort, filter, aggregates (11 tests)
│   ├── approveMonth.test.js        Per-month approval gate (9 tests)
│   └── integration.test.js         End-to-end with fully-mocked Adobe (3 tests)
│
├── data/                           Created at runtime — NOT committed
│   ├── state.db                    SQLite database (WAL mode)
│   ├── .key                        AES-256 encryption key (chmod 600)
│   ├── uploads/                    Streamed CSV uploads
│   └── output/                     Exported result CSVs
│
├── docs/
│   ├── DESIGN_DOC.md               This document
│   ├── ARCHITECTURE.md             Living system overview (internal reference)
│   ├── CHANGELOG.md                Append-only session log (internal reference)
│   └── REVIEW.md                   Full review brief + Adobe API contracts (internal)
│
├── CLAUDE.md                       AI assistant guidelines + invariants (internal)
├── README.md                       Quick-start guide
├── package.json
└── .gitignore                      Excludes data/, .env, node_modules/
```

---

*Document end — AEP Data Lifecycle Helper Design Document v2.0.0*
