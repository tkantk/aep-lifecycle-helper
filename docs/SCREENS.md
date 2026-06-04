# Screen Walkthrough

A guided tour of the AEP Data Lifecycle Helper UI — what each screen does, its
key controls, and the safety behaviour behind it. Screens are listed in the
order an operator works through them (left-hand nav, top to bottom).

> Screenshots use **entirely fabricated demo data** — a fictional "Acme Retail"
> credential, a placeholder IMS org, a `prod-demo` sandbox, and a generic CSV
> name. No real company, credentials, sandbox, or customer identifiers appear,
> and the client secret is masked. The scenario (a 1,607,384-identifier job with
> Day 1 of 1,000,000 already shipped and Day 2 of 607,383 pending) is illustrative;
> the quota panel is seeded to stay internally consistent with it.

---

## 1. Environment — credentials & sandbox

![Environment Configuration](screens/01-config.png)

**What it does.** Configures the IMS server-to-server credential (client-credentials
grant) and the sandbox/datasets the deletions target.

**Key controls.**
- **Active credential** picker · **＋ Add new** / **Remove**. Secrets are
  **encrypted at rest** (AES-256-GCM, key in `data/.key`) and never re-displayed.
- **Region** (VA7 / NLD2 / AUS5 / CAN2) — the Identity API is region-sharded, so
  this must match the credential's region or expansion silently returns nothing.
- **Sandbox** (loaded live after **Test Connection**) and **Deletion mode**
  (profile-only vs. data-lake + profile).
- **Daily / Monthly identifier caps** — fallbacks only; the live Adobe `/quota`
  is the real source of truth at run time.
- **Test Connection** validates IMS auth and pulls the live quota.

The right rail summarises what the tool does and the exact Adobe APIs it calls.

---

## 2. Source CSV — upload identifiers

![Upload Source Identities](screens/02-upload.png)

**What it does.** Uploads a single-column CSV of source identifiers (e.g.
`hashedKocid`), one per line, no header.

**Key controls.**
- **Source namespace** — which AEP identity namespace the CSV column belongs to.
- **Drop zone** — CSVs up to ~4 GB are **streamed to disk**, never loaded into
  memory, so very large files are safe.
- **Start Identity Expansion** kicks off the next step.

The right rail explains *why* expansion is needed: a source identifier is only one
node; full deletion requires resolving every linked identity in the cluster.

---

## 3. Expansion — resolve the identity graph

![Identity Graph Expansion](screens/03-expand.png)

**What it does.** Streams each source ID, batches them (1,000 per call) through
`POST /identity/clusters/members`, and dedups every linked identity into SQLite.

**Key readouts.**
- **Batches**, **Identities found** (incl. cluster members), **Expansion ratio**
  (found ÷ source).
- **Identities by namespace** — the breakdown of what was discovered (ECID,
  hashedKocid, email, Phone_E.164, CRMID …). *(This breakdown is computed only on
  this tab — it's the one heavy query, kept off the faster screens.)*
- **Export CSV** of the resolved identities · **Delete Job** · **Plan Work Orders →**.

---

## 4. Batch Planning — group into work orders

![Work Order Batch Planning](screens/04-plan.png)

**What it does.** Packs the resolved identities into work orders of ≤100,000
identifiers each (Adobe's hard cap), grouped into day/month windows that respect
the live daily/monthly quota.

**Key behaviour.**
- **Total identities / Work orders / Spans** summary.
- Work orders are listed **grouped by month**, each row showing its **Day**
  window, namespaces, identity count, and status.
- **Re-plan is blocked once any work order has shipped** (the disabled button) —
  re-emitting shipped identities would create **duplicate irreversible deletes**.
  The identity content of shipped work orders is immutable; only *un-shipped*
  buckets re-distribute against live quota on each Submit.

---

## 5. Submit — ship work orders to Adobe

![Submit Work Orders](screens/05-submit.png)

**What it does.** Submits the current day's window of planned work orders to
`POST /hygiene/workorder`, gated by an atomic quota reservation.

**Key controls & readouts.**
- **Day N of M** — the submission window. In this demo, Day 1 (1,000,000) has
  shipped and the screen has landed directly on **Day 2** for the remaining
  607,383, with a **Submit Day 2** button. *(The window label continues past
  already-shipped days rather than resetting to "Day 1".)*
- **Submitted / Failed / Deferred** counts (here 10/17 submitted).
- **QUOTA** panel — live Adobe daily + monthly used/remaining/limit. A destructive
  submit refuses to run on a **stale** snapshot; it retries the live `/quota`
  fetch a few times before giving up (flaky-network resilience).
- **Auto-resume** scheduler (opt-in) — resubmit deferred work at a chosen local
  time/day. **Activity log** streams server-side submission events.

---

## 6. Monitor — track Adobe-side progress

![Work Order Monitor](screens/06-monitor.png)

**What it does.** Polls every Adobe-acked work order (every 60 s) and shows the
status of in-flight submissions across all jobs.

**Key readouts.**
- **Active submissions** feed — jobs with ≥1 shipped work order, in-flight first,
  with an optional sandbox filter and name search.
- **Work Order Pipeline** — per-WO Adobe work-order ID, status
  (`received → validated → submitted → ingested → completed`), identity count,
  and created/updated timestamps.
- **Processing SLA** and **Downstream services** (Data Lake, Identity, Real-Time
  Profile, AJO) the deletion propagates to.

On a flaky network the monitor backs off per-WO instead of re-polling everything
every tick, so it never floods the connection or stalls a concurrent submit.

---

### Regenerating these screenshots

The images are produced from a throwaway seeded demo DB (no real data). See the
project's screenshot tooling notes; the capture runs the app against a temp
`DATA_DIR` and drives each tab with Playwright at 2× scale.
