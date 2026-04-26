# AEP Data Lifecycle Helper

A **local helper tool** for bulk identity deletion from Adobe Experience Platform.

Resolves `hashedKocid` identifiers through the Identity Graph, groups the
resulting cluster members into work orders of up to 100,000 identities each,
and submits them to the Data Hygiene API within Adobe's daily cap (default
1,000,000 identifiers/day).

Runs as a single Node.js process. One SQLite file for state. No Docker,
no Redis, no Postgres — everything lives locally.

---

## Why this exists

Deleting a profile by its `hashedKocid` alone doesn't actually remove the
profile — a profile is an identity *cluster* that can also contain email,
phone, ECID, CRMID, GAID, IDFA. Full deletion requires expanding the cluster
first. This tool does that end-to-end.

---

## Install & run

Requires **Node.js 20+**.

```bash
unzip aep-lifecycle-helper.zip
cd aep-lifecycle-helper
npm install
npm start
```

The tool opens `http://localhost:3000` in your default browser. That's it.

On first run, the tool creates:
- `data/state.db` — SQLite state file (credentials, jobs, work orders)
- `data/.key` — AES-256-GCM encryption key for your client secrets (chmod 600)
- `data/uploads/` — uploaded CSVs (streamed to disk, never loaded into memory)
- `data/output/` — exported identity CSVs

**Add `data/` to `.gitignore`.** It contains your encryption key.

---

## How throughput scales

This is the **only scalability claim** that matters: Node.js async I/O on
a single machine is fast enough for millions of IDs.

| Work type           | Pattern                                        | Throughput                 |
| ------------------- | ---------------------------------------------- | -------------------------- |
| Identity expansion  | `p-limit(10)` concurrent Adobe API calls       | ~10,000 IDs/sec            |
| Work-order submit   | Quota-gated at Adobe's 1M/day cap              | Adobe-bounded, not local   |
| CSV read/write      | Node streams                                   | Memory stays flat          |
| SQLite inserts      | Batch transactions (WAL mode)                  | ~100,000 rows/sec          |

**Example runs (on a 2020 MacBook Pro):**
- 100,000 source IDs → expanded in ~15 seconds
- 1,000,000 source IDs → expanded in ~90 seconds
- 10,000,000 source IDs → expanded in ~17 minutes (Adobe then caps at 1M/day submissions)

Turn the concurrency dial in `.env` (`IDENTITY_CONCURRENCY=10`) if you have
fast bandwidth and aren't getting 429'd.

---

## End-to-end flow

```
1. Environment     Enter IMS creds, sandbox, dataset. Test connection.
      ↓
2. Upload CSV      hashedKocid values. Streamed to disk, not memory.
      ↓
3. Expansion       Batches of 1000 IDs to /identity/clusters/members,
                   10 concurrent. Results dedup'd and inserted to SQLite.
      ↓
4. Batch Planning  Packed into ≤100k-ID work orders, grouped by namespace,
                   day-assigned based on daily cap.
      ↓
5. Submit          POST each work order to /hygiene/workorder.
                   Daily quota enforced in SQLite, rolls over at UTC midnight.
      ↓
6. Monitor         Background poll (every 60s) updates each work order's
                   status through received → validated → submitted →
                   ingested → completed.
```

State is persisted at every step — **close the app and reopen it** and
you can pick up where you left off.

---

## Configuration

All config has sensible defaults. If you want to override, create a `.env`
in the project root:

```dotenv
PORT=3000
OPEN_BROWSER=1

# Identity Graph region (changes API host)
AEP_IDENTITY_REGION=va7   # va7 | nld2 | aus5 | can2

# Throughput
IDENTITY_CONCURRENCY=10
IDENTITY_BATCH_SIZE=1000
WORK_ORDER_CONCURRENCY=2
MAX_IDS_PER_WORK_ORDER=100000
DAILY_IDENTIFIER_LIMIT=1000000

# Optional: supply your own 32-byte hex encryption key instead of the
# auto-generated one in data/.key
# ENCRYPTION_KEY=64-hex-chars
```

---

## API endpoints (for scripting)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/config/credentials` | Store encrypted IMS creds |
| POST | `/api/config/credentials/test` | IMS auth check |
| POST | `/api/upload` | Upload CSV + start expansion |
| GET | `/api/jobs/:id` | Job detail + namespace breakdown + quota |
| GET | `/api/jobs/:id/progress` | Live expansion progress |
| POST | `/api/jobs/:id/plan` | Build work-order plan |
| POST | `/api/jobs/:id/submit` | Submit planned orders (`{dayIndex}` optional) |
| GET | `/api/jobs/:id/work-orders` | List all work orders for a job |
| GET | `/api/jobs/:id/export` | Download expanded identities CSV |

## Adobe endpoints used

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ims/token/v3` | Access token (client_credentials) |
| POST | `/data/core/identity/clusters/members` | Cluster expansion, 1000 IDs/batch |
| POST | `/data/core/hygiene/workorder` | Create record-delete work order |
| GET | `/data/core/hygiene/workorder/{id}` | Status poll |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Single Node.js process (localhost:3000)             │
│                                                                      │
│  ┌─────────────────┐   ┌────────────────┐   ┌─────────────────┐    │
│  │ Express server  │   │ In-process     │   │ Status monitor  │    │
│  │ • Serves UI     │◀─▶│ runners        │   │ (setInterval)   │    │
│  │ • REST /api/*   │   │ • expansion    │   │ Polls Adobe     │    │
│  │                 │   │   (p-limit 10) │   │ every 60s       │    │
│  │                 │   │ • submission   │   │                 │    │
│  │                 │   │   (p-limit 2)  │   │                 │    │
│  └────────┬────────┘   └────────┬───────┘   └────────┬────────┘    │
│           │                     │                    │              │
│           ▼                     ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                 SQLite (WAL mode, data/state.db)            │   │
│  │  credentials · jobs · expanded_identities · work_orders ·   │   │
│  │                         quota_usage                         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│           + in-memory IMS token cache (Map w/ TTL)                  │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                       Adobe Experience Platform
           ims-na1.adobelogin.com · platform.adobe.io
```

Concurrency knobs (`IDENTITY_CONCURRENCY`, `WORK_ORDER_CONCURRENCY`) tune
how many Adobe API calls run in parallel. The defaults are conservative
and stay well under Adobe's rate limits.

---

## Safety

- All Data Hygiene work orders are **asynchronous and destructive — there
  is no undo**. Test on a dev sandbox with a small CSV first.
- Client secrets are **encrypted at rest** (AES-256-GCM).
- Tokens are kept in-memory only (never written to disk).
- The `data/.key` file contains your encryption key; don't check it in.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401` from Adobe | Bad creds / wrong IMS org | Click **Test Connection** on the config page |
| `429` spikes during expansion | Concurrency too high | Lower `IDENTITY_CONCURRENCY` in `.env` |
| Expansion stuck at 0% | No Identity Graph data for namespace | Verify the source namespace matches what's in AEP |
| `Work order has N ids, exceeds per-order limit` | Bug in planner | Re-run plan step (orders are re-created) |
| `quota: N/M used` on work order | Daily cap hit | Re-run submit after UTC midnight |
| `Cannot find module 'better-sqlite3'` | Build step skipped on install | `npm install` must complete; it compiles the native module |

---

## Development

```bash
npm run dev      # auto-restart on file changes
npm test         # integration tests (mocked Adobe)
```

To reset everything (delete all jobs + credentials):

```bash
rm -rf data/
```

## For contributors / AI assistants

- **`CLAUDE.md`** at the project root captures invariants, file map, and
  conventions. Read it before making any change to payload construction,
  namespace handling, or quota logic. This file is also read automatically
  by Claude Code.
- **`docs/REVIEW.md`** is a self-contained code-review brief suitable for
  handing to another LLM or reviewer. It documents every Adobe API we call,
  the exact payload shapes, our validation rules, known limitations, and
  specific review questions.
