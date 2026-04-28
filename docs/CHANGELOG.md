# Changelog

Append-only log of changes to this project, organised by working session.
New entries go **at the top**. Each bullet should explain *what* changed and *why*,
with enough detail that a future contributor can reconstruct the decision.

Format: `## YYYY-MM-DD` session headers; bullets grouped under **Backend**,
**Frontend**, **Tests**, **Docs**, **Infra**. Reference file paths where useful.

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
