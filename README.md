# AEP Data Lifecycle Helper

A **local helper tool** for bulk identity deletion from Adobe Experience
Platform. Built for jobs that may span multiple months — it reads the
operator's live Adobe quota, plans work into month-sized chunks, and (if
enabled) auto-resumes on the 1st of each new month so the operator
doesn't have to babysit a long-running deletion.

Resolves source identifiers (any AEP namespace — `hashedKocid`, `email`,
`CRMID`, etc.) through the Identity Graph, groups the resulting cluster
members into work orders of up to **100,000 identities each**, and submits
them to the Data Hygiene API within Adobe's caps:

- **100,000 identifiers per work order** (Adobe hard limit)
- **1,000,000 identifiers per day** (Adobe limit)
- **Monthly cap from your contract** — 2M / month without Shield, 15M / month
  with Privacy or Healthcare Shield (and whichever is less of fixed cap or
  5%/10% of addressable audience). The exact number is fetched live from
  `GET /data/core/hygiene/quota`, so what the tool sees is what Adobe sees.

Runs as a single Node.js process. One SQLite file for state. No Docker,
no Redis, no Postgres — everything lives locally on the operator's machine.

---

## Why this exists

Deleting a profile by its `hashedKocid` (or any single identifier) alone
doesn't actually remove the profile — a profile is an identity *cluster*
that can also contain email, phone, ECID, CRMID, GAID, IDFA. Full deletion
requires expanding the cluster first. This tool does that end-to-end and
also handles:

- Picking the right **region** automatically per credential (wrong region
  silently returns empty cluster data — a footgun this tool prevents).
- Splitting work across **months** when the deletion size exceeds the
  org's monthly entitlement.
- **Optionally auto-resuming** when the new month's quota resets at
  00:00 GMT on the 1st.

---

## Install & run

Requires **Node.js 20 LTS** (the tool uses `node --test`, `node --watch`, and
`better-sqlite3`'s native addon — all stable on Node 20+).

### Step 1 — Install Node.js 20

Use a version manager so you can switch Node versions per-project without
touching the system install.

<details>
<summary><strong>Windows</strong></summary>

1. Download and run the **nvm-windows** installer from
   https://github.com/coreybutler/nvm-windows/releases  
   (pick `nvm-setup.exe` from the latest release).

2. Open a **new** PowerShell window (the PATH update takes effect in new shells):

   ```powershell
   nvm install 20
   nvm use 20
   node --version   # should print v20.x.x
   ```

3. If you already have another Node version set as default, `nvm use 20` is
   per-session. To make it permanent:

   ```powershell
   nvm alias default 20   # nvm-windows ≥ 1.2 supports aliases
   ```

> **OneDrive warning** — the default Documents folder is synced by OneDrive on
> most corporate Windows machines. SQLite's WAL journal files can be locked by
> the sync client and cause `SQLITE_BUSY` errors under load. Set `DATA_DIR` in
> `.env` to a path outside OneDrive (e.g. `C:\Users\you\AppData\Local\aep-lh`).
> The app prints a warning at startup when it detects a cloud-sync path.

</details>

<details>
<summary><strong>Linux / macOS</strong></summary>

1. Install **nvm**:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   # Then restart your shell, or:
   source ~/.bashrc   # or ~/.zshrc on macOS
   ```

2. Install and activate Node 20:

   ```bash
   nvm install 20
   nvm use 20
   node --version   # should print v20.x.x
   ```

3. To make it the default for all new shells:

   ```bash
   nvm alias default 20
   ```

</details>

### Step 2 — Run the tool

```bash
unzip aep-lifecycle-helper.zip
cd aep-lifecycle-helper
npm install          # compiles the better-sqlite3 native addon
npm start            # opens http://localhost:3000
```

The tool opens `http://localhost:3000` in your default browser. That's it.

On first run, the tool creates:

- `data/state.db` — SQLite state file (credentials, jobs, work orders, settings)
- `data/.key` — AES-256-GCM encryption key for your client secrets (chmod 600)
- `data/uploads/` — uploaded CSVs (streamed to disk, never loaded into memory)
- `data/output/` — exported identity CSVs

**Add `data/` to `.gitignore`.** It contains your encryption key. The app
also warns at startup if `data/` is inside a cloud-sync path (OneDrive /
Dropbox / Google Drive / iCloud) — co-locating the key and the encrypted
secrets in someone else's cloud defeats the encryption.

---

## How throughput scales

Node.js async I/O on a single machine saturates Adobe's rate limits.

| Work type           | Pattern                                        | Throughput                 |
| ------------------- | ---------------------------------------------- | -------------------------- |
| Identity expansion  | `p-limit(10)` concurrent Adobe API calls       | ~10,000 IDs/sec            |
| Work-order submit   | Quota-gated at Adobe's 1M/day cap              | Adobe-bounded, not local   |
| CSV read/write      | Node streams                                   | Memory stays flat          |
| SQLite inserts      | Batch transactions (WAL mode)                  | ~100,000 rows/sec          |

**Example runs (on a 2020 MacBook Pro):**

- 100,000 source IDs → expanded in ~15 seconds
- 1,000,000 source IDs → expanded in ~90 seconds
- 10,000,000 source IDs → expanded in ~17 minutes (Adobe then caps at 1M/day
  submissions; with a 2M/mo entitlement, deletion completes over 5 months)

Turn the concurrency dial in `.env` (`IDENTITY_CONCURRENCY=10`) if you have
fast bandwidth and aren't getting 429'd.

---

## End-to-end flow

```
1. Environment     Enter IMS creds, sandbox, dataset. Test connection.
      ↓            Adobe org quota auto-fetched (Daily / Monthly / Remaining).
                   Cap inputs auto-populated from Adobe's reported entitlement.
      ↓
2. Upload CSV      Source identifiers (any namespace). Streamed to disk.
      ↓
3. Expansion       Batches of 1000 IDs to /identity/clusters/members,
                   10 concurrent. Results dedup'd and inserted to SQLite.
      ↓
4. Batch Planning  Identities packed into ≤100k-ID work orders, then
                   re-bucketed by the LIVE Adobe quota into Month × Day
                   buckets. Multi-month plans surface a confirmation
                   modal with a per-month breakdown.
                   Month 2+ work orders are immediately placed in
                   'awaiting approval' — they cannot ship until the
                   operator clicks "Approve Month N" in the Plan tab.
      ↓
4a. Approve        For each month beyond Month 1 an "Approve Month N"
    Month 2+       button appears in the Plan tab. Clicking it unlocks
                   that month's work orders for the next Submit run.
                   Month 1 ships immediately — no extra click needed.
      ↓
5. Submit          Pre-submit modal shows planned vs Adobe's current
                   remaining. POST each work order to /hygiene/workorder.
                   Before every submission run, /quota is re-fetched and
                   un-shipped work is re-bucketed (so if someone else
                   consumed org-wide quota since you planned, work moves
                   to a later window instead of erroring out).
      ↓
6. Monitor         Background poll every 60s updates each work order's
                   status: received → validated → submitted → ingested →
                   completed. Per-service breakdown (Data Management,
                   Identity, Profile, Journey Orchestrator) shown in the
                   Monitor tab — same view Adobe surfaces in their UI.
      ↓
7. Auto-resume     OPTIONAL. The operator can enable a daily scheduler
   (Phase 3)       (HH:MM in local time + every day / weekdays / 1st-of-
                   month). On each tick, every job with un-shipped work
                   is processed. Catches up on startup if the laptop was
                   off at the scheduled time.
```

State is persisted at every step — **close the app and reopen it** and
you can pick up where you left off. The startup-recovery routine handles
jobs stuck mid-expansion or mid-submission.

---

## Configuration

All config has sensible defaults. Override via `.env` in the project root:

```dotenv
PORT=3000
OPEN_BROWSER=1
HOST=127.0.0.1                # default; never expose to LAN unless tunneled

# Identity Graph region default (per-credential overrides take precedence)
AEP_IDENTITY_REGION=va7        # va7 | nld2 | aus5 | can2

# Throughput
IDENTITY_CONCURRENCY=10
IDENTITY_BATCH_SIZE=1000
WORK_ORDER_CONCURRENCY=2
MAX_IDS_PER_WORK_ORDER=100000
DAILY_IDENTIFIER_LIMIT=1000000        # FALLBACK ONLY — live /quota wins
MONTHLY_IDENTIFIER_LIMIT=3000000      # FALLBACK ONLY — live /quota wins

# Run state location. Move out of OneDrive / Dropbox / etc. on Windows.
DATA_DIR=/custom/path
DB_PATH=/custom/path/state.db

# Optional: supply your own 32-byte hex encryption key instead of the
# auto-generated one in data/.key
# ENCRYPTION_KEY=64-hex-chars
```

The **DAILY_IDENTIFIER_LIMIT / MONTHLY_IDENTIFIER_LIMIT** defaults are only
used as a fallback if Adobe's `/quota` endpoint is unreachable. Live values
always win. See the "Quota model" section below.

---

## Quota model

The tool uses **two complementary sources of truth**:

1. **Adobe `GET /data/core/hygiene/quota`** — the authoritative number for
   what your org has currently consumed and what's remaining. Cached for 1
   hour in-process; refreshed force-fresh before every plan and every submit.
   If `/quota` is unreachable AND no recent cache exists (24 h hard floor),
   the tool **refuses to plan or submit** rather than ship blind.

2. **Local SQLite ledger (`quota_usage` + `quota_usage_monthly`)** — used
   inside `reserve()` / `release()` for atomic per-WO accounting. Prevents
   two work orders in this app's process from racing past the cap during
   a single submission batch.

Adobe is always the displayed truth in the UI; the local ledger is purely a
within-process safety net. When the two diverge (e.g. another tool deleted
against the same org-wide pool between our plan and our submit), the
redistributor re-buckets un-shipped work into a later window instead of
shipping and being rejected by Adobe.

---

## API endpoints (for scripting)

All under `/api/` on `http://127.0.0.1:3000`.

### Config

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/config/credentials` | Store encrypted IMS creds (region + environment + length validated) |
| GET | `/api/config/credentials` | List stored creds (no secrets) |
| PATCH | `/api/config/credentials/:id` | Update label / client_name / region (never touches encrypted secret) |
| DELETE | `/api/config/credentials/:id` | Remove creds (409 if a job references them) |
| POST | `/api/config/credentials/test` | IMS auth check |

### Adobe discovery + quota

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/adobe/:credsId/sandboxes` | Live sandbox list |
| GET | `/api/adobe/:credsId/sandboxes/:sandbox/datasets?refresh=1` | Identity-enabled datasets |
| GET | `/api/adobe/:credsId/sandboxes/:sandbox/namespaces?refresh=1` | Namespace registry |
| GET | `/api/adobe/:credsId/quota?refresh=1` | Live `/data/core/hygiene/quota` snapshot |

### Jobs

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` | Upload CSV + start expansion |
| GET | `/api/jobs` | All jobs (every status, every sandbox) |
| GET | `/api/jobs/monitor?search=&sandbox=` | Active-submissions dashboard feed (jobs with ≥1 Adobe-acked WO) |
| GET | `/api/jobs/:id` | Job detail + namespace breakdown + quota peek |
| GET | `/api/jobs/:id/progress` | Live expansion progress (fast path) |
| POST | `/api/jobs/:id/plan` | Build work-order plan (auto re-buckets against live quota) |
| POST | `/api/jobs/:id/approve-month` | Approve Month N for submission. Body: `{monthIndex}` (≥ 2) |
| POST | `/api/jobs/:id/submit` | Submit work orders. Body: `{dayIndex?, monthIndex?}` |
| GET | `/api/jobs/:id/work-orders` | All work orders + per-service status |
| GET | `/api/jobs/:id/export` | Download expanded identities CSV (formula-injection sanitized) |

### Settings

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings/auto-resume` | Auto-resume scheduler config + next fire time |
| PUT | `/api/settings/auto-resume` | Toggle / set HH:MM local time / set days policy |

---

## Adobe endpoints used

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ims/token/v3` | Access token (client_credentials) |
| GET | `/data/foundation/sandbox-management/` | List sandboxes |
| GET | `/data/foundation/catalog/dataSets` | List datasets (filtered to Identity-enabled) |
| GET | `/data/core/idnamespace/identities` | List namespaces (region-scoped) |
| POST | `/data/core/identity/clusters/members` | Cluster expansion, 1000 IDs/batch (region-scoped) |
| GET | `/data/core/hygiene/quota` | Org-wide daily + monthly identifier quota |
| POST | `/data/core/hygiene/workorder` | Create record-delete work order |
| GET | `/data/core/hygiene/workorder/{id}` | Status poll |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                  Single Node.js process (localhost:3000)               │
│                                                                        │
│  ┌────────────────┐   ┌───────────────────┐   ┌───────────────────┐   │
│  │ Express server │   │ In-process        │   │ Background timers │   │
│  │ • Serves UI    │◀─▶│ runners           │   │ • Monitor 60s     │   │
│  │ • REST /api/*  │   │ • expansion       │   │   poll Adobe      │   │
│  │ • CSP + Host   │   │   p-limit(10)     │   │ • Scheduler 60s   │   │
│  │   guard + CSRF │   │ • submission      │   │   auto-resume     │   │
│  │   origin check │   │   p-limit(2)      │   │   tick (Phase 3)  │   │
│  └────────┬───────┘   └────────┬──────────┘   └─────────┬─────────┘   │
│           │                    │                        │             │
│           ▼                    ▼                        ▼             │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │            SQLite (WAL mode, data/state.db)                      │ │
│  │  credentials · sandbox_configs · jobs · expanded_identities ·    │ │
│  │  work_orders · quota_usage · quota_usage_monthly · app_settings  │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│           + in-memory IMS token cache (Map w/ TTL)                    │
│           + in-memory Adobe /quota cache (1h TTL, 24h hard floor)     │
└────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                       Adobe Experience Platform
           ims-na1.adobelogin.com · platform.adobe.io
           platform-{va7|nld2|aus5|can2}.adobe.io  (Identity Service)
```

Concurrency knobs (`IDENTITY_CONCURRENCY`, `WORK_ORDER_CONCURRENCY`) tune
how many Adobe API calls run in parallel. The defaults are conservative
and stay well under Adobe's rate limits.

---

## Safety

- All Data Hygiene work orders are **asynchronous and destructive — there
  is no undo**. Test on a dev sandbox with a small CSV first.
- Pre-plan and pre-submit confirmation modals surface what's about to ship
  with live quota numbers. The Submit modal won't auto-fire — the operator
  confirms each click.
- Client secrets are **encrypted at rest** (AES-256-GCM, per-row IV).
- Tokens are kept in-memory only (never written to disk).
- The local HTTP server binds to **`127.0.0.1`** with Host-header validation,
  CSRF Origin/Referer check, Content-Security-Policy via `helmet`, and UUID
  validation on every `:id` / `:credsId` path param. DNS-rebinding attacks
  and cross-origin form posts are blocked.
- Region is **allow-listed server-side** (not just in the UI) so a stale
  DB row can't trick the Identity API URL builder into leaking the bearer
  token to a non-Adobe host.
- The `data/.key` file contains your encryption key; don't check it in.
  Move `data/` outside any cloud-sync path on Windows.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` from Adobe | Bad creds / wrong IMS org | Click **Test Connection** on the Environment tab |
| `429` spikes during expansion | Concurrency too high | Lower `IDENTITY_CONCURRENCY` in `.env` |
| Expansion stuck at 0% | No Identity Graph data for namespace | Verify the source namespace matches what's in AEP |
| `Work order has N ids, exceeds per-order limit` | Bug in planner | Re-run plan step (orders are re-created) |
| Plan blocked with "Adobe quota unreachable" | Network or permission issue | Confirm IMS auth still valid; click ↻ Refresh on the quota panel |
| Submit denied: `quota_unavailable` 503 | Adobe `/quota` outage + no recent cache | Try again once Adobe is reachable; the 24h hard floor protects against blind shipping |
| `quota: N/M used` on work order | Daily cap hit | Re-run submit after UTC midnight, or enable auto-resume |
| `Cannot find module 'better-sqlite3'` | Native build step skipped | `npm install` must complete; it compiles the native module |
| Auto-resume didn't fire on the 1st | Laptop was off at the scheduled time | The startup tick catches up automatically next time the app runs |

---

## Development

```bash
npm run dev      # auto-restart on file changes
npm test         # 178 tests, mocked Adobe via nock
```

To reset everything (delete all jobs + credentials):

```bash
rm -rf data/
```

## For contributors / AI assistants

- **`CLAUDE.md`** at the project root captures invariants, file map, and
  conventions. Read it before making any change to payload construction,
  namespace handling, or quota logic. This file is read automatically
  by Claude Code.
- **`docs/ARCHITECTURE.md`** is the living system overview — module map,
  data flow, Adobe contracts, DB schema. Start here.
- **`docs/REVIEW.md`** is a self-contained code-review brief suitable for
  handing to another LLM or reviewer.
- **`docs/CHANGELOG.md`** is the append-only session log — recent entries
  often explain "why is it this way?"
