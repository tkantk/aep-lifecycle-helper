// ═══════════════════════════════════════════════════════════════════════
// AEP Data Lifecycle Helper - UI controller
// Vanilla JS, no frameworks. State is kept in a single object.
// ═══════════════════════════════════════════════════════════════════════

const API = '/api';
const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// ─── App state ─────────────────────────────────────────────────────────
const state = {
  step: 'config',
  credsId: null,
  config: {
    environment: 'Production', region: 'va7',
    imsOrgId: '', clientId: '', clientSecret: '',
    label: '',
    clientName: '',
    sandboxName: '',
    deleteMode: 'datasets',      // 'datasets' | 'all' | 'profile-only'
    datasetIds: [],              // array of selected dataset ids
    dailyLimit: 1_000_000,
    monthlyLimit: 3_000_000,     // fallback only — Adobe's live monthly cap wins
    sourceNamespace: 'hashedKocid',  // code; defaults to hashedKocid for backwards compat
    sourceNamespaceId: null,         // numeric nsid — filled from the namespace registry
    expansionMode: 'cluster',        // 'cluster' (Identity Graph) | 'none' (uploaded IDs only); reset after each upload
  },
  tokenOk: false,
  identityUnlocked: false,       // true when user clicked "✏ Edit identity fields"
  sandboxes: [],                 // loaded after Test Connection
  datasets: [],                  // loaded after sandbox pick
  namespaces: [],                // loaded after sandbox pick
  orgQuota: null,                // GET /api/adobe/:credsId/quota response
                                 // shape: { daily, monthly, datasetExpiration, fetchedAt, stale, error }
  file: null,
  job: null,
  progress: null,
  plan: null,
  workOrders: [],
  submitView: null,              // Submit tab: { month, day } batch being viewed
  submitTrackIds: null,          // Submit tab: IDs of the batch just submitted (followed across re-labels)
  analysis: null,                // Analysis tab: last GET /jobs/:id/analysis response
  analysisView: null,            // Analysis tab: { jobId, category, search, sort, offset, selected }
  planScope: null,               // Plan tab: { jobId, value } — the scope card the operator picked
  activity: [],
  pollTimer: null,
};

// ─── HTTP ─────────────────────────────────────────────────────────────
async function http(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { status: res.status, data });
  return data;
}

// ─── UI: debounced click handler for destructive buttons ─────────────
/**
 * Wraps an async click handler so the button is disabled while it's running.
 * Prevents the double-submit race that hit the 2026-05-28 1.57M-row run —
 * a rapid second click (or UI auto-retry) firing the same destructive
 * endpoint before the first response returned, which on /export tripped
 * the (now-fixed) cached-prepared-statement "busy" error and on /plan
 * could have triggered duplicate work-order emission.
 *
 * Use for any button that POSTs/PATCHes/DELETEs, kicks off a long-running
 * server job, or whose duplicate execution would be expensive or destructive.
 *
 *   onClickGuarded($('#btn-submit'), submitHandler, { loadingText: 'Submitting…' });
 *
 * Behaviour:
 *   • Click → disable button + set loadingText (if provided) → run handler.
 *   • On settle (success OR error) → re-enable + restore original text.
 *   • If a click fires while a handler is in flight, it is dropped silently
 *     (the disabled attribute prevents most cases; the in-flight flag
 *     guards programmatic re-enable paths).
 */
function onClickGuarded(btn, handler, { loadingText } = {}) {
  if (!btn) return;
  let inFlight = false;
  btn.addEventListener('click', async (ev) => {
    if (inFlight || btn.disabled) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    inFlight = true;
    const originalText = btn.textContent;
    btn.disabled = true;
    if (loadingText) btn.textContent = loadingText;
    try {
      await handler(ev);
    } finally {
      inFlight = false;
      btn.disabled = false;
      if (loadingText) btn.textContent = originalText;
    }
  });
}

// ─── Steps & routing ───────────────────────────────────────────────────
const STEPS = {
  config:  { title: 'Environment Configuration', sub: 'Configure IMS credentials and sandbox for the Data Lifecycle API.', crumbs: ['Data Management', 'Environment Configuration'], render: renderConfig },
  upload:  { title: 'Upload Source Identities',  sub: 'Upload a CSV of source identifier values to be deleted.',          crumbs: ['Data Management', 'Source CSV Upload'],     render: renderUpload },
  expand:  { title: 'Identity Graph Expansion',  sub: 'Resolve all identities linked to each source identifier.',         crumbs: ['Identities', 'Identity Expansion'],         render: renderExpand },
  analysis: { title: 'Identity Analysis',        sub: 'See which uploaded IDs share a cluster with other profiles or identities before you delete.', crumbs: ['Identities', 'Identity Analysis'], render: renderAnalysis },
  plan:    { title: 'Work Order Batch Planning', sub: 'Group identities into optimally-sized batches respecting daily quotas.', crumbs: ['Identities', 'Batch Planning'],    render: renderPlan },
  submit:  { title: 'Submit Work Orders',        sub: 'Submit record-delete work orders to the Data Hygiene API.',          crumbs: ['Data Lifecycle', 'Work Orders'],            render: renderSubmit },
  monitor: { title: 'Work Order Monitor',        sub: 'Track status of submitted work orders across downstream services.', crumbs: ['Data Lifecycle', 'Monitor'],                render: renderMonitor },
};

// ─── Routes (2026-10-09) ────────────────────────────────────────────────
// The address bar mirrors where the operator is, so the browser's Back /
// Forward walk through tabs and jobs and a refresh stays put (before, Back left
// the app). #<tab> = a job tab with no job open (its Recent jobs list);
// #<tab>/<jobId> = that tab for one job. Environment, Source CSV and Monitor
// don't carry a job (Monitor keeps its own job list).
const JOB_TABS = new Set(['expand', 'analysis', 'plan', 'submit']);
let appliedHash = null;      // the route on screen — popstate/hashchange ignore it
let routeSeq = 0;
function routeHash(step) {
  return JOB_TABS.has(step) && state.job ? `#${step}/${encodeURIComponent(state.job.id)}` : `#${step}`;
}
function parseRoute(hash) {
  const m = /^#([a-z]+)(?:\/([A-Za-z0-9-]{1,64}))?$/.exec(hash || '');
  return m && STEPS[m[1]] ? { step: m[1], jobId: m[2] || null } : null;
}
/** Put the current tab (+ open job) in the address bar: a new history entry,
 *  or `replace` the current one (e.g. a job auto-opened on this tab). */
function recordRoute(step, { replace = false } = {}) {
  const hash = routeHash(step);
  if (!replace) routeSeq++;     // a click supersedes a Back/Forward still loading its job
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  appliedHash = hash;
}
/** Show what an address says — Back/Forward, a refresh, a pasted link. A later
 *  Back/Forward or click (routeSeq) wins over one still loading its job. */
async function applyRoute(route) {
  const seq = ++routeSeq;
  if (!route) {
    history.replaceState(null, '', '#config');
    appliedHash = '#config';
    goto('config', { record: false });
    return;
  }
  if (JOB_TABS.has(route.step)) {
    if (route.jobId && route.jobId !== state.job?.id) {
      let job = null, err = null;
      try { job = (await http('GET', `/jobs/${route.jobId}`)).job; } catch (e) { err = e; }
      if (seq !== routeSeq) return;            // a newer address arrived meanwhile — it wins
      if (job) setActiveJob(job);
      else {
        clearActiveJob();
        suppressAutoLoadOnce();
        const gone = err?.status === 404;
        showToast(gone ? 'That job no longer exists — showing the job list.'
          : `Could not load job: ${err?.message || 'no job in the reply'}`, { kind: gone ? 'warning' : 'error' });
        history.replaceState(null, '', `#${route.step}`);
      }
    } else if (!route.jobId && state.job) {
      clearActiveJob();          // the address says "job list" — no auto-opening either
      suppressAutoLoadOnce();
    }
  }
  appliedHash = location.hash;
  goto(route.step, { record: false });
}
function onRouteChange() {
  if (location.hash === appliedHash) return;
  appliedHash = location.hash;   // claim it now: popstate AND hashchange fire for one change
  applyRoute(parseRoute(location.hash));
}
window.addEventListener('popstate', onRouteChange);
window.addEventListener('hashchange', onRouteChange);

function goto(step, { record = true } = {}) {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  stopExcelPoll();
  state.step = step;
  if (record) recordRoute(step);
  const meta = STEPS[step];
  $('#page-title').textContent = meta.title;
  $('#page-sub').textContent   = meta.sub;
  $('#crumbs').innerHTML = `<span>Workflows</span>` +
    meta.crumbs.map((c, i, a) => `<span class="sep">›</span><span${i === a.length - 1 ? ' class="current"' : ''}>${c}</span>`).join('');

  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.step === step));

  const tpl = $('#tpl-' + step) || $('#tpl-' + (step === 'submit' ? 'submit' : step));
  $('#view').innerHTML = '';
  $('#view').appendChild(tpl.content.cloneNode(true));
  meta.render();
}

// ─── Step renderers ────────────────────────────────────────────────────
async function renderConfig() {
  // Populate from state
  for (const [k, id] of [
    ['label', 'c-label'], ['clientName', 'c-client-name'],
    ['environment', 'c-environment'], ['region', 'c-region'],
    ['imsOrgId', 'c-ims-org'], ['clientId', 'c-client-id'], ['clientSecret', 'c-client-secret'],
    ['dailyLimit', 'c-daily'], ['monthlyLimit', 'c-monthly'],
  ]) {
    const el = $('#' + id); if (el) el.value = state.config[k] ?? '';
  }
  $('#c-delete-mode').value = state.config.deleteMode;

  // Wire inputs
  $$('.fields input, .fields select').forEach(el => {
    el.addEventListener('change', updateConfigState);
    el.addEventListener('input', updateConfigState);
  });
  $('#toggle-secret').addEventListener('click', () => {
    const inp = $('#c-client-secret');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('#toggle-secret').textContent = inp.type === 'password' ? 'show' : 'hide';
  });

  onClickGuarded($('#btn-test'),       testConnection,    { loadingText: 'Testing…' });
  onClickGuarded($('#btn-save-creds'), saveAndContinue,   { loadingText: 'Saving…'  });
  $('#btn-refresh-sandboxes').addEventListener('click', () => loadSandboxes(true));
  $('#btn-refresh-datasets').addEventListener('click', () => loadDatasets(true));
  $('#btn-refresh-quota').addEventListener('click', () => loadOrgQuota(true));
  $('#c-sandbox-picker').addEventListener('change', onSandboxChange);
  $('#c-delete-mode').addEventListener('change', onDeleteModeChange);
  $('#btn-cred-add').addEventListener('click', addNewCredentialFlow);
  onClickGuarded($('#btn-cred-remove'), removeCurrentCredential, { loadingText: 'Removing…' });
  $('#btn-edit-identity').addEventListener('click', unlockIdentityFields);
  $('#cred-picker').addEventListener('change', onCredPickerChange);

  // Load saved-credentials list and populate the active-credential picker.
  await refreshCredPicker();
  applyIdentityLockState();

  // If we already tested this session, restore picker state
  if (state.tokenOk && state.credsId) {
    await loadSandboxes(false);
    if (state.config.sandboxName) {
      $('#c-sandbox-picker').value = state.config.sandboxName;
      await loadDatasets(false);
    }
    // Re-render the cached quota immediately (avoids a flicker while the
    // background refresh is in flight). If the cache is < 1h it stays as-is;
    // otherwise loadOrgQuota will refresh in the background.
    if (state.orgQuota) {
      $('#org-quota-block').hidden = false;
      renderOrgQuota(state.orgQuota);
      autoPopulateCapsFromQuota(state.orgQuota);
    }
    loadOrgQuota(false).catch(() => { /* renderOrgQuotaError already showed */ });
  }
  onDeleteModeChange();
  updateConfigState();
}

function updateConfigState() {
  state.config.label        = $('#c-label').value.trim();
  state.config.clientName   = $('#c-client-name').value.trim();
  state.config.environment  = $('#c-environment').value;
  state.config.region       = $('#c-region').value;
  state.config.imsOrgId     = $('#c-ims-org').value.trim();
  state.config.clientId     = $('#c-client-id').value.trim();
  state.config.clientSecret = $('#c-client-secret').value;
  state.config.sandboxName  = $('#c-sandbox-picker').value;
  state.config.deleteMode   = $('#c-delete-mode').value;
  state.config.dailyLimit   = parseInt($('#c-daily').value, 10) || 1_000_000;
  // Monthly cap is a fallback only — Adobe always enforces a monthly cap and
  // submission uses the live /quota value (review R4 #4). 0/empty → backend
  // default, never "disabled".
  state.config.monthlyLimit = Math.max(0, parseInt($('#c-monthly').value, 10) || 0);

  const canTest = state.config.imsOrgId && state.config.clientId && state.config.clientSecret;
  $('#btn-test').disabled = !canTest;

  // Save is enabled only when:
  //   - token verified
  //   - label set
  //   - sandbox picked
  //   - if deleteMode is 'datasets', at least one dataset is selected
  const datasetsOk = state.config.deleteMode !== 'datasets' || state.config.datasetIds.length > 0;
  $('#btn-save-creds').disabled = !(
    state.tokenOk && state.config.label && state.config.sandboxName && datasetsOk
  );
  updateEnvChip();
}

function updateEnvChip() {
  const c = state.config;
  $('#env-label').textContent = c.sandboxName
    ? `${c.environment} · ${c.sandboxName}`
    : (c.environment || 'Not configured');
  $('#env-chip').querySelector('.dot').classList.toggle('green', !!(c.sandboxName && state.tokenOk));
  $('#auth-chip').hidden = !state.tokenOk;
  updateClientNameDisplay();
}

// The top-bar "client name" block and avatar are driven entirely by the
// configured client name; the avatar is purely decorative (local tool has no
// user account) but its initials reflect the client so the UI ties together.
function updateClientNameDisplay() {
  const name = (state.config.clientName || '').trim();
  const nameEl = $('#client-name');
  const avatar = $('#user-avatar');
  if (!nameEl || !avatar) return;

  if (name) {
    nameEl.textContent = name;
    nameEl.hidden = false;
    avatar.textContent = initialsFor(name);
  } else {
    nameEl.hidden = true;
    avatar.textContent = 'AEP';
  }
}

function initialsFor(name) {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

async function useCred(id, cred) {
  state.credsId = id;
  state.config.label       = cred.label;
  state.config.clientName  = cred.client_name || '';
  state.config.environment = cred.environment;
  state.config.region      = cred.region;
  state.config.imsOrgId    = cred.ims_org_id;
  state.config.clientId    = cred.client_id;
  state.config.clientSecret = '(unchanged)';
  state.tokenOk = false;
  state.sandboxes = []; state.datasets = [];
  state.config.sandboxName = ''; state.config.datasetIds = [];
  state.identityUnlocked = false;   // re-lock identity fields when switching creds
  goto('config');
}

// ─── Active-credential picker ─────────────────────────────────────────
// Drives the "Active credential" dropdown at the top of the Config card,
// the "+ Add new" / "⊗ Remove" buttons, and the identity-fields lock that
// prevents accidental edits to fields that define a credential's identity.

async function refreshCredPicker() {
  let list = [];
  try { list = await http('GET', '/config/credentials'); } catch { /* db not ready */ }

  const bar = $('#cred-picker-bar');
  const picker = $('#cred-picker');
  const removeBtn = $('#btn-cred-remove');

  if (list.length === 0) {
    // No saved creds yet — hide the picker entirely; the form is in "new" mode.
    bar.hidden = true;
    state.credsId = null;
    return;
  }

  bar.hidden = false;
  // "Add new" mode is signaled by state.credsId === null AND the user having
  // explicitly unlocked identity fields. Don't auto-fallback to the most
  // recent cred in that case — it would silently undo the user's intent.
  const inAddNewMode = !state.credsId && state.identityUnlocked;
  if (!inAddNewMode && (!state.credsId || !list.some(c => c.id === state.credsId))) {
    state.credsId = list[0].id;
  }

  picker.innerHTML = list.map(c => {
    const label = formatCredOption(c);
    return `<option value="${c.id}"${c.id === state.credsId ? ' selected' : ''}>${escape(label)}</option>`;
  }).join('') + `<option value="__new__"${inAddNewMode ? ' selected' : ''}>+ Add new credential</option>`;

  // "Remove" makes sense only when an existing cred is selected.
  removeBtn.disabled = inAddNewMode || !state.credsId;
}

function formatCredOption(c) {
  const parts = [];
  if (c.client_name) parts.push(c.client_name);
  parts.push(c.label || '(no label)');
  parts.push(c.environment);
  if (c.region) parts.push(c.region);
  return parts.join(' · ');
}

async function onCredPickerChange() {
  const picker = $('#cred-picker');
  const id = picker.value;
  if (id === '__new__') {
    // Sentinel from the dropdown — treat as "+ Add new"
    addNewCredentialFlow();
    return;
  }
  // Switching to an existing cred: hydrate the form via useCred.
  let list = [];
  try { list = await http('GET', '/config/credentials'); } catch { /* */ }
  const cred = list.find(c => c.id === id);
  if (!cred) return;
  await useCred(id, cred);
}

function addNewCredentialFlow() {
  // Reset everything that ties the form to a saved credential. The user is
  // now creating a brand-new entry; the next save POSTs (creates a new row).
  state.credsId = null;
  state.config.label        = '';
  state.config.clientName   = '';
  state.config.environment  = 'Production';
  state.config.region       = 'va7';
  state.config.imsOrgId     = '';
  state.config.clientId     = '';
  state.config.clientSecret = '';
  state.config.sandboxName  = '';
  state.config.datasetIds   = [];
  state.tokenOk = false;
  state.sandboxes = []; state.datasets = []; state.namespaces = [];
  state.identityUnlocked = true;   // identity fields editable in new-cred mode
  goto('config');
}

async function removeCurrentCredential() {
  if (!state.credsId) return;
  const picker = $('#cred-picker');
  const opt = picker.options[picker.selectedIndex];
  const label = opt ? opt.textContent : 'this credential';
  // Native confirm — modal would be overkill for a destructive single-action.
  if (!confirm(`Remove ${label}?\n\nThis only deletes the saved credential entry — it does not affect anything in Adobe.`)) return;

  try {
    await http('DELETE', `/config/credentials/${state.credsId}`);
    state.credsId = null;
    state.tokenOk = false;
    showAlert('#cfg-alert', 'success', 'Credential removed', 'The saved credential has been deleted from local storage.');
    await refreshCredPicker();
    // If there's another saved cred, picker auto-selected it; hydrate the form.
    const newId = $('#cred-picker').value;
    if (newId && newId !== '__new__') await onCredPickerChange();
    else addNewCredentialFlow();
  } catch (err) {
    if (err.status === 409) {
      showAlert('#cfg-alert', 'error', 'Cannot remove credential',
        err.data?.message || 'This credential is referenced by one or more jobs.');
    } else {
      showAlert('#cfg-alert', 'error', 'Remove failed', err.message);
    }
  }
}

// ─── Identity-field lock ──────────────────────────────────────────────
// Environment / IMS Org ID / Client ID together form the unique key on the
// credentials row. Editing them on a loaded saved credential silently routes
// to a different row via the upsert. We lock them by default to make that
// "I'm creating a new credential" intent explicit.

function applyIdentityLockState() {
  const lockedByDefault = !!state.credsId && !state.identityUnlocked;
  const fields = ['c-environment', 'c-ims-org', 'c-client-id'];
  for (const id of fields) {
    const el = $('#' + id);
    if (!el) continue;
    if (lockedByDefault) {
      el.setAttribute('readonly', '');
      if (el.tagName === 'SELECT') el.setAttribute('disabled', '');
      el.classList.add('locked');
    } else {
      el.removeAttribute('readonly');
      el.removeAttribute('disabled');
      el.classList.remove('locked');
    }
  }
  $('#identity-lock-row').hidden = !lockedByDefault;
}

function unlockIdentityFields() {
  state.identityUnlocked = true;
  applyIdentityLockState();
  showAlert('#cfg-alert', 'info', 'Identity fields unlocked',
    'Editing Environment, IMS Org, or Client ID will create a new credential when you save (the existing one stays untouched).');
}

async function testConnection() {
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.innerHTML = '<span class="ico spin">↻</span>Testing…';
  try {
    // If user is testing new creds (not "unchanged"), save them first so we
    // have a credsId to use for sandbox/dataset lookups.
    if (state.config.clientSecret !== '(unchanged)' || !state.credsId) {
      const saved = await http('POST', '/config/credentials', {
        label:         state.config.label || 'Untitled',
        clientName:    state.config.clientName || null,
        environment:   state.config.environment,
        region:        state.config.region,
        imsOrgId:      state.config.imsOrgId,
        clientId:      state.config.clientId,
        clientSecret:  state.config.clientSecret,
      });
      state.credsId = saved.id;
      state.config.clientSecret = '(unchanged)';
      // Re-lock identity fields now that the credential is committed, and
      // refresh the picker so the new entry shows up in the dropdown.
      state.identityUnlocked = false;
      await refreshCredPicker();
      applyIdentityLockState();
    }

    const res = await http('POST', '/config/credentials/test', { credsId: state.credsId });
    state.tokenOk = !!res.ok;

    if (res.ok) {
      showAlert('#cfg-alert', 'success', 'Connection verified',
        `Access token obtained. Loading sandboxes from Adobe…`);
      // Sandbox loading is a SEPARATE Adobe call — its failure must not
      // reset tokenOk. After a system restart the OS network stack can be
      // slow on first outbound, and the bootstrap auto-test would
      // otherwise leave the Authenticated chip hidden until the user
      // clicked Test Connection manually with a warm network.
      try {
        await loadSandboxes(true);
      } catch (sbxErr) {
        showAlert('#cfg-alert', 'warning', 'Sandbox list failed to load',
          `Authentication is OK, but the sandbox-discovery call failed: ${sbxErr.message}. Click "↻" next to the sandbox picker to retry.`);
      }
      // Live Adobe org-quota fetch. Fire-and-forget so a /quota outage
      // doesn't block the rest of the Config flow; the banner self-renders
      // once the call returns (or shows a stale/error state).
      loadOrgQuota(false).catch(() => { /* renderOrgQuota already surfaced the error */ });
    } else {
      showAlert('#cfg-alert', 'error', 'Connection failed',
        res.error || 'Check your credentials and try again.');
    }
  } catch (err) {
    state.tokenOk = false;
    showAlert('#cfg-alert', 'error', 'Request failed', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="ico">⚡</span>Test Connection';
    updateEnvChip();
    updateConfigState();
  }
}

// ─── Adobe org quota ──────────────────────────────────────────────────
// Fetches GET /api/adobe/:credsId/quota (server-side proxy to Adobe's
// /data/core/hygiene/quota). Renders the daily + monthly counters and
// auto-populates the form's cap inputs so what the operator sees is what
// Adobe sees. The first phase of the 2026-05-15 quota work: pure visibility.
// The planner doesn't consume these values yet (that's Phase 2); for now
// they update the inputs and the banner.
async function loadOrgQuota(force) {
  if (!state.credsId) return;
  const block = $('#org-quota-block');
  const meta  = $('#org-quota-meta');
  const refreshBtn = $('#btn-refresh-quota');
  if (!block) return;   // not in DOM yet (Config tab not mounted)

  if (meta) meta.textContent = 'Fetching from Adobe…';
  if (refreshBtn) refreshBtn.disabled = true;
  block.hidden = false;

  try {
    const q = await http('GET',
      `/adobe/${state.credsId}/quota${force ? '?refresh=1' : ''}`);
    state.orgQuota = q;
    renderOrgQuota(q);
    autoPopulateCapsFromQuota(q);
  } catch (err) {
    state.orgQuota = null;
    renderOrgQuotaError(err);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function renderOrgQuota(q) {
  const meta  = $('#org-quota-meta');
  const bars  = $('#org-quota-bars');
  const stale = $('#org-quota-stale');

  if (meta) {
    const when = q.fetchedAt ? new Date(q.fetchedAt) : null;
    const ago  = when ? formatRelativeTime(when.toISOString()) : '—';
    meta.textContent = `Refreshed ${ago}`;
  }

  const renderBar = (label, e) => {
    if (!e) return `
      <div class="org-quota-bar">
        <div class="org-quota-bar-label">${escape(label)}</div>
        <div class="org-quota-bar-value">Not reported by Adobe</div>
      </div>`;
    const pct = e.quota > 0 ? (e.consumed / e.quota) * 100 : 0;
    const color = pct > 90 ? 'var(--red500)' : pct > 70 ? 'var(--orange500)' : 'var(--blue500)';
    return `
      <div class="org-quota-bar">
        <div class="org-quota-bar-label">${escape(label)}</div>
        <div class="org-quota-bar-value">
          <b>${e.consumed.toLocaleString()}</b> / ${e.quota.toLocaleString()}
          <span class="org-quota-bar-rem">· ${e.remaining.toLocaleString()} remaining</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(100, pct).toFixed(1)}%; background:${color}"></div>
        </div>
      </div>`;
  };

  if (bars) {
    bars.innerHTML =
      renderBar('Daily',   q.daily) +
      renderBar('Monthly', q.monthly);
  }

  if (stale) {
    if (q.stale) {
      stale.hidden = false;
      stale.innerHTML = `⚠ Showing cached values${q.error ? ` (live fetch failed: ${escape(q.error)})` : ''}. Click ↻ Refresh to retry.`;
    } else {
      stale.hidden = true;
      stale.textContent = '';
    }
  }
}

function renderOrgQuotaError(err) {
  // Hard failure with no cache → block submission paths by showing the
  // error prominently. Phase 1 just renders the message; Phase 2 will wire
  // this into the Submit button's enabled state.
  const meta  = $('#org-quota-meta');
  const bars  = $('#org-quota-bars');
  const stale = $('#org-quota-stale');
  if (meta) meta.textContent = 'Unavailable';
  if (bars) bars.innerHTML = '';
  if (stale) {
    stale.hidden = false;
    const detail = err?.data?.message || err?.message || 'Unknown error';
    stale.innerHTML = `⚠ Adobe quota fetch failed: ${escape(detail)}. Submissions should not proceed until Adobe is reachable.`;
  }
}

// Mirror Adobe's reported entitlement into the form's cap inputs. The
// operator can still lower these (e.g. to throttle), but raising above
// Adobe's value would just cause Adobe to reject — there's no value in
// allowing it. Phase 2 will add the per-input clamp; here we only update.
function autoPopulateCapsFromQuota(q) {
  const dailyInput   = $('#c-daily');
  const monthlyInput = $('#c-monthly');
  const dailyHint    = $('#c-daily-hint');
  const monthlyHint  = $('#c-monthly-hint');

  if (q.daily && dailyInput) {
    // Only auto-populate when the input is at the hardcoded default — don't
    // clobber an explicit operator override.
    const current = parseInt(dailyInput.value, 10) || 0;
    if (current === 0 || current === 1_000_000) {
      dailyInput.value = q.daily.quota;
      state.config.dailyLimit = q.daily.quota;
    }
    if (dailyHint) {
      dailyHint.textContent = `Adobe-reported entitlement: ${q.daily.quota.toLocaleString()} / day`;
    }
  }
  if (q.monthly && monthlyInput) {
    const current = parseInt(monthlyInput.value, 10) || 0;
    if (current === 0 || current === 3_000_000) {
      monthlyInput.value = q.monthly.quota;
      state.config.monthlyLimit = q.monthly.quota;
    }
    if (monthlyHint) {
      monthlyHint.textContent = `Adobe-reported entitlement: ${q.monthly.quota.toLocaleString()} / month`;
    }
  }
  updateConfigState();
}

// ─── Sandbox / dataset pickers ─────────────────────────────────────────
async function loadSandboxes(refresh) {
  const picker = $('#c-sandbox-picker');
  const refreshBtn = $('#btn-refresh-sandboxes');
  picker.disabled = true; refreshBtn.disabled = true;

  try {
    const sandboxes = await http('GET', `/adobe/${state.credsId}/sandboxes`);
    state.sandboxes = sandboxes;
    picker.innerHTML = `<option value="">-- select a sandbox --</option>` + sandboxes.map(s => `
      <option value="${escape(s.name)}"${s.isDefault ? ' selected' : ''}>
        ${escape(s.title)} (${escape(s.name)}) · ${escape(s.type)}
      </option>`).join('');
    picker.disabled = false; refreshBtn.disabled = false;

    if (state.config.sandboxName && sandboxes.some(s => s.name === state.config.sandboxName)) {
      picker.value = state.config.sandboxName;
    } else if (sandboxes.some(s => s.isDefault)) {
      state.config.sandboxName = sandboxes.find(s => s.isDefault).name;
      picker.value = state.config.sandboxName;
    }
    if (state.config.sandboxName) await loadDatasets(false);
  } catch (err) {
    showAlert('#cfg-alert', 'error', 'Failed to load sandboxes', err.message);
  }
  updateConfigState();
}

async function onSandboxChange() {
  state.config.sandboxName = $('#c-sandbox-picker').value;
  state.config.datasetIds = [];
  state.namespaces = [];
  if (state.config.sandboxName) {
    await Promise.all([loadDatasets(false), loadNamespaces(false)]);
  }
  updateConfigState();
}

async function loadNamespaces(refresh) {
  if (!state.config.sandboxName) return;
  try {
    const resp = await http('GET',
      `/adobe/${state.credsId}/sandboxes/${encodeURIComponent(state.config.sandboxName)}/namespaces${refresh ? '?refresh=1' : ''}`);
    state.namespaces = resp.namespaces || [];

    // If the currently-selected source namespace isn't in the new list, fall back
    // to the first available entry so sourceNamespaceId stays in sync.
    if (!state.namespaces.some(n => n.code === state.config.sourceNamespace)) {
      const first = state.namespaces[0];
      if (first) {
        state.config.sourceNamespace = first.code;
        state.config.sourceNamespaceId = Number(first.id);
      }
    } else {
      // Sync sourceNamespaceId from the resolved entry
      const hit = state.namespaces.find(n => n.code === state.config.sourceNamespace);
      if (hit) state.config.sourceNamespaceId = Number(hit.id);
    }
    populateNamespacePicker();
  } catch (err) {
    // Non-fatal — expansion will still run with auto-nsid resolution on the server.
    // Keep console trace so a silent failure is still discoverable.
    console.warn('namespace load failed:', err.message);
  }
}

function populateNamespacePicker() {
  const el = $('#c-source-ns');
  const refreshBtn = $('#btn-refresh-namespaces');
  if (!el) return;   // the picker only exists when the upload template is mounted

  if (state.namespaces.length === 0) {
    el.innerHTML = '<option value="">No namespaces loaded — pick a sandbox first</option>';
    el.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;
    return;
  }

  // Sort: standard namespaces first, custom after; within each, alphabetically.
  const sorted = [...state.namespaces].sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? 1 : -1;
    return (a.code || '').localeCompare(b.code || '');
  });

  // Escape every Adobe-supplied field — the namespace registry response is
  // not under our control. A namespace `code` of `" onfocus=alert(1) x="`
  // would otherwise break out of the option's value attribute.
  el.innerHTML = sorted.map(n => {
    const label = `${n.code}${n.name && n.name !== n.code ? ` — ${n.name}` : ''}${n.custom ? '  [custom]' : ''}`;
    const selected = n.code === state.config.sourceNamespace ? 'selected' : '';
    return `<option value="${escape(n.code)}" data-nsid="${escape(n.id)}" ${selected}>${escape(label)}</option>`;
  }).join('');

  el.disabled = false;
  if (refreshBtn) refreshBtn.disabled = false;
  onSourceNsChange();
}

function onSourceNsChange() {
  const el = $('#c-source-ns');
  if (!el) return;
  state.config.sourceNamespace = el.value;
  const opt = el.options[el.selectedIndex];
  state.config.sourceNamespaceId = opt?.dataset?.nsid ? Number(opt.dataset.nsid) : null;
  // Refresh the file-chip meta line if a file is staged
  if (state.file) renderFileChip();
}

function onDeleteModeChange() {
  state.config.deleteMode = $('#c-delete-mode').value;
  const showDatasets = state.config.deleteMode === 'datasets';
  $('#dataset-picker-wrap').hidden = !showDatasets;
  if (!showDatasets) state.config.datasetIds = [];
  updateConfigState();
}

async function loadDatasets(refresh) {
  if (!state.config.sandboxName) return;
  const statusEl = $('#dataset-picker-status');
  const pickerEl = $('#dataset-picker');
  const refreshBtn = $('#btn-refresh-datasets');

  statusEl.textContent = refresh ? 'Fetching datasets from Adobe…' : 'Loading datasets…';
  pickerEl.style.display = 'none';
  refreshBtn.hidden = true;

  try {
    const resp = await http('GET',
      `/adobe/${state.credsId}/sandboxes/${encodeURIComponent(state.config.sandboxName)}/datasets${refresh ? '?refresh=1' : ''}`);
    state.datasets = resp.datasets || [];
    statusEl.textContent = `${state.datasets.length} Identity-enabled dataset(s) available${resp.cached ? ' (cached)' : ''}`;
    refreshBtn.hidden = false;

    if (state.datasets.length === 0) {
      pickerEl.innerHTML = `<div style="padding: 12px; font-size: 12.5px; color: var(--g600)">
        No Identity-enabled datasets found. Make sure at least one dataset has
        the <code>unifiedIdentity: enabled:true</code> tag, or use the "Delete
        from ALL datasets" option above.</div>`;
      pickerEl.style.display = 'block';
      return;
    }

    pickerEl.innerHTML = state.datasets.map(d => `
      <label style="display: flex; gap: 8px; padding: 5px 8px; cursor: pointer; border-radius: 3px" class="ds-row">
        <input type="checkbox" value="${escape(d.id)}" ${state.config.datasetIds.includes(d.id) ? 'checked' : ''}>
        <div style="flex: 1; min-width: 0">
          <div style="font-weight: 500; font-size: 12.5px">${escape(d.name || d.id)}</div>
          <div style="font-size: 11px; color: var(--g600); font-family: Menlo, monospace; text-overflow: ellipsis; overflow: hidden; white-space: nowrap">
            ${escape(d.id)}${d.profileEnabled ? ' · profile' : ''}
          </div>
        </div>
      </label>`).join('');
    pickerEl.style.display = 'block';

    $$('.ds-row input[type="checkbox"]', pickerEl).forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = $$('.ds-row input:checked', pickerEl).map(c => c.value);
        state.config.datasetIds = checked;
        $('#dataset-selection-count').textContent =
          checked.length === 0 ? '' : `${checked.length} dataset(s) selected`;
        updateConfigState();
      });
    });
    $('#dataset-selection-count').textContent =
      state.config.datasetIds.length === 0 ? '' : `${state.config.datasetIds.length} dataset(s) selected`;
  } catch (err) {
    statusEl.textContent = 'Failed to load datasets: ' + err.message;
  }
  updateConfigState();
}

async function saveAndContinue() {
  // testConnection() may have already POSTed (when secret was new), but if
  // the user only edited non-secret fields (client name, label, region) on a
  // loaded credential, those changes have NOT been persisted yet. PATCH them
  // now. If we have no credsId (shouldn't happen when Save is enabled, but
  // guard anyway), this falls through cleanly.
  try {
    if (state.credsId && !state.identityUnlocked) {
      await http('PATCH', `/config/credentials/${state.credsId}`, {
        label:      state.config.label || 'Untitled',
        clientName: state.config.clientName || null,
        region:     state.config.region,
      });
      // Refresh the picker so the new label / client name shows in the dropdown.
      await refreshCredPicker();
    }
  } catch (err) {
    showAlert('#cfg-alert', 'error', 'Save failed', err.message);
    return;
  }
  goto('upload');
}

// ─── Upload ───────────────────────────────────────────────────────────
function renderUpload() {
  const dz = $('#dz'), fi = $('#file-input');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', e => handleFile(e.target.files[0]));
  // CRITICAL: a duplicate click would create a second job for the same CSV.
  // Disable on click until the first request returns.
  onClickGuarded($('#btn-start-expand'), startExpansion, { loadingText: 'Starting expansion…' });
  $('#c-source-ns').addEventListener('change', onSourceNsChange);
  $('#btn-refresh-namespaces').addEventListener('click', () => loadNamespaces(true));

  // Identity expansion choice (2026-10-06). "Uploaded IDs only" is confirmed:
  // it decides what the whole job can ever delete and can't be changed later.
  const modeInputs = $$('input[name="expansion-mode"]');
  const syncMode = () => {
    const mode = state.config.expansionMode === 'none' ? 'none' : 'cluster';
    modeInputs.forEach(i => {
      i.checked = i.value === mode;
      i.closest('.choice-card')?.classList.toggle('selected', i.checked);
    });
    $('#btn-start-expand').textContent = mode === 'none' ? 'Load Uploaded IDs →' : 'Start Identity Expansion →';
  };
  modeInputs.forEach(input => input.addEventListener('change', () => {
    if (input.value === 'none' && !confirm(
      'Delete ONLY the uploaded IDs?\n\n' +
      'The Identity Graph will not be called, so identities linked to them (email, phone, ECID, …) ' +
      'will NOT be deleted — the profiles stay reachable through those identities, and the Analysis ' +
      'tab has nothing to show for this job.\n\n' +
      'This applies to the whole job and cannot be changed after upload.')) {
      syncMode();
      return;
    }
    state.config.expansionMode = input.value;
    syncMode();
  }));
  syncMode();

  // Fetch namespaces lazily if they weren't loaded during sandbox pick
  // (e.g. user landed here directly after a page reload).
  if (state.namespaces.length === 0 && state.credsId && state.config.sandboxName) {
    loadNamespaces(false);
  } else {
    populateNamespacePicker();
  }
  if (state.file) renderFileChip();
}

function handleFile(file) {
  if (!file) return;
  state.file = file;
  renderFileChip();
}

function renderFileChip() {
  const info = $('#upload-info');
  info.hidden = false;
  info.innerHTML = `
    <div class="file-chip">
      <div class="file-ico">▤</div>
      <div style="flex:1">
        <div class="file-name">${escape(state.file.name)}</div>
        <div class="file-meta">${formatBytes(state.file.size)} · namespace: <code>${escape(state.config.sourceNamespace || '—')}</code>${state.config.sourceNamespaceId != null ? ` <span style="color:var(--g600)">(nsid ${state.config.sourceNamespaceId})</span>` : ''}</div>
      </div>
      <button class="btn btn-secondary" id="clear-file">×</button>
    </div>`;
  $('#clear-file').addEventListener('click', () => {
    state.file = null;
    $('#upload-info').hidden = true;
    $('#btn-start-expand').disabled = true;
  });
  $('#btn-start-expand').disabled = false;
}

async function startExpansion() {
  if (!state.config.sourceNamespace) {
    alert('Pick a source namespace first.');
    return;
  }
  const form = new FormData();
  form.append('file', state.file);
  form.append('name', state.file.name);
  form.append('credsId', state.credsId);
  form.append('sandboxName', state.config.sandboxName);
  form.append('sourceNamespace', state.config.sourceNamespace);
  if (state.config.sourceNamespaceId != null) {
    form.append('sourceNamespaceId', String(state.config.sourceNamespaceId));
  }
  form.append('dailyLimit', String(state.config.dailyLimit));
  form.append('monthlyLimit', String(state.config.monthlyLimit || 0));
  const expansionMode = state.config.expansionMode === 'none' ? 'none' : 'cluster';
  form.append('expansionMode', expansionMode);

  // Map the three delete-mode choices to the Adobe payload fields:
  //   'datasets'     -> datasetIds = "id1,id2,...",    no targetServices
  //   'all'          -> datasetIds = "ALL",            no targetServices
  //   'profile-only' -> datasetIds = "ALL",            targetServices = identity,profile,ajo
  if (state.config.deleteMode === 'profile-only') {
    form.append('datasetIds', 'ALL');
    form.append('targetServices', 'identity,profile,ajo');
  } else if (state.config.deleteMode === 'all') {
    form.append('datasetIds', 'ALL');
  } else {
    if (state.config.datasetIds.length === 0) {
      alert('Select at least one dataset, or switch deletion mode to "ALL".');
      return;
    }
    form.append('datasetIds', state.config.datasetIds.join(','));
  }

  try {
    const res = await http('POST', '/upload', form);
    state.job = { id: res.jobId, total_source_ids: res.totalSourceIds, status: 'expanding', expansion_mode: expansionMode };
    // Every upload makes its own explicit choice — never carry "IDs only" over.
    state.config.expansionMode = 'cluster';
    // Uploading a new CSV is an explicit "I want this one as my active job"
    // signal — clear any earlier delete-induced auto-load suppression so
    // subsequent navigations behave normally.
    clearAutoLoadSuppression();
    goto('expand');
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
}

// ─── Helpers: auto-load + jobs picker ─────────────────────────────────
// Why this exists: state.job lives in-memory only, so any browser refresh
// or server restart loses it. Without help the operator sees "No job
// selected. Upload a CSV first." even though one or more jobs are running
// in the database — confusing and (if the operator already ran a CSV
// today) wrong.
//
// Two coordinated pieces:
//   ensureActiveJobLoaded(preferredStatuses)
//       Auto-picks the most recent non-terminal job and loads it into
//       state.job. Best-effort — if the operator wants a different job
//       they can pick it from the visible jobs list below.
//   renderJobsPickerInto(containerSelector)
//       Renders a clickable list of recent jobs. Used as the empty-state
//       on Expand/Plan/Submit (so the operator can SEE the available
//       jobs instead of guessing) AND triggerable from a "Switch ▾"
//       link on the active-job header.
// Statuses that prove the expansion FINISHED — mirrors
// src/runner/submission.js PLANNABLE_JOB_STATUSES (the server enforces it).
const PLANNABLE_JOB_STATUSES = new Set(['expanded', 'ready', 'submitting', 'submitted', 'partial']);

const NON_TERMINAL_STATUSES = new Set([
  'created', 'expanding', 'expanded', 'ready', 'planning',
  'submitting', 'submitted', 'partial',
]);

// Sticky flag set after an explicit Delete Job. Cleared the next time the
// operator picks a job from the picker. While set, ensureActiveJobLoaded
// returns null so the picker is shown instead of silently auto-loading
// some OTHER job from the DB — the operator's mental model after a delete
// is "the slate is clean", and silently loading a different job
// contradicts that. Persisted in sessionStorage so it survives a browser
// refresh within the same tab.
const SUPPRESS_FLAG = 'aep-suppress-auto-load';
function suppressAutoLoadOnce() { try { sessionStorage.setItem(SUPPRESS_FLAG, '1'); } catch { /* */ } }
function clearAutoLoadSuppression() { try { sessionStorage.removeItem(SUPPRESS_FLAG); } catch { /* */ } }
function isAutoLoadSuppressed() {
  try { return sessionStorage.getItem(SUPPRESS_FLAG) === '1'; } catch { return false; }
}

async function ensureActiveJobLoaded(preferredStatuses = null) {
  if (state.job) return state.job;

  // After an explicit Delete Job, don't auto-load anything — let the
  // picker show so the operator chooses (or doesn't). Suppression ends
  // the moment they explicitly switch to a job via `switchToJob`.
  if (isAutoLoadSuppressed()) {
    console.log('ensureActiveJobLoaded: auto-load suppressed (recent delete)');
    return null;
  }

  let jobs;
  try {
    jobs = await http('GET', '/jobs?limit=20');
  } catch (err) {
    console.warn('ensureActiveJobLoaded: /jobs fetch failed', err);
    return null;
  }

  // ONLY auto-load jobs that are actively in-flight on the server side.
  // This is the "recovery from server restart" case — runStartupRecovery
  // resumed the expansion, the UI should pick it up automatically. For
  // ANY other status ('expanded', 'ready', 'completed', 'failed', etc.)
  // we deliberately do nothing and let the picker show, so the operator
  // explicitly chooses which past job they want to view. The previous
  // behaviour ("auto-load the most-recent of any non-terminal status")
  // was too aggressive — it silently surfaced jobs the operator had
  // moved on from (real 2026-05-29 report: delete a job, then go to a
  // different tab, and a different job auto-loaded). `preferredStatuses`
  // is intentionally ignored here for the same reason: tab-specific
  // preferences led to "Expand picks A but Plan picks B" inconsistency.
  const candidate = jobs.find(j => j.status === 'expanding' || j.status === 'submitting');
  console.log('ensureActiveJobLoaded:',
    { preferredStatuses, totalJobs: jobs.length,
      autoLoadedInProgress: candidate ? { id: candidate.id.slice(0, 8), name: candidate.name, status: candidate.status } : null });
  if (!candidate) return null;

  try {
    const detail = await http('GET', `/jobs/${candidate.id}`);
    state.job = detail.job;
    state.workOrders = []; // force re-fetch on next Plan/Submit render
    recordRoute(state.step, { replace: true });   // the address shows the job that opened itself
    return state.job;
  } catch (err) {
    console.warn('ensureActiveJobLoaded: /jobs/:id detail failed', err);
    return null;
  }
}

/** Make `job` the open job, dropping everything cached for the previous one. */
function setActiveJob(job) {
  clearActiveJob();
  state.job = job;
  clearAutoLoadSuppression();
}
function clearActiveJob() {
  state.job = null;
  state.workOrders = [];
  state.progress = null;
  state.submitView = null;
  state.submitTrackIds = null;
  state.analysis = null;
  state.analysisView = null;
}
/** "← All jobs" (2026-10-09): close the open job and show the Recent jobs list —
 *  on this tab and every job tab — until the operator picks one; nothing opens
 *  itself meanwhile (same suppression as after Delete Job). */
function showAllJobs() {
  clearActiveJob();
  suppressAutoLoadOnce();
  goto(state.step);
}

/**
 * Switch the active job and re-render the current tab. Wired into every
 * jobs picker entry so clicking a job in the list immediately swaps
 * state.job and shows that job's progress / plan / submit state.
 */
async function switchToJob(jobId) {
  // Immediate feedback: paint a spinner into the current tab body so the click
  // visibly registers, even though the job-detail round-trip is now fast (the
  // heavy namespace GROUP-BY was moved off this path). Operators reported "we
  // don't know if anything is happening on click" while the event loop froze.
  const body = document.getElementById(`${state.step}-body`);
  if (body) body.innerHTML = '<div class="empty-state"><div class="big-icon spin">↻</div><div>Loading job…</div></div>';
  try {
    const detail = await http('GET', `/jobs/${jobId}`);
    // Explicit pick — also clears the post-delete / "All jobs" auto-load
    // suppression so later tab navigations behave normally.
    setActiveJob(detail.job);
    recordRoute(state.step);
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    stopExcelPoll();
    // Re-render whatever tab the operator was on.
    const meta = STEPS[state.step];
    if (meta) await meta.render();
  } catch (err) {
    showToast(`Could not load job: ${err.message}`, { kind: 'error' });
    // Don't leave the "Loading job…" spinner stuck (it was painted above for
    // immediate click feedback). Re-render the current tab so it recovers to
    // the jobs picker / previous state instead of a dead spinner.
    const meta = STEPS[state.step];
    if (meta) await meta.render();
  }
}

/**
 * Fetch up to N recent jobs and render them as a clickable list inside
 * `containerSelector`. Highlights the currently-loaded job. Useful both
 * as the empty-state body (when no job is loaded) and as a "show all
 * recent jobs" popover above the active-job header.
 */
async function renderJobsPickerInto(containerSelector, { activeJobId = null, headline = 'Recent jobs (click to load)' } = {}) {
  const container = $(containerSelector);
  if (!container) return;
  let jobs = [];
  try { jobs = await http('GET', '/jobs?limit=20'); } catch (err) {
    container.innerHTML = `<div class="alert error"><div>Could not load jobs: ${escape(err.message)}</div></div>`;
    return;
  }
  if (jobs.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="big-icon">!</div>
      <div>No jobs yet. <a href="#" data-goto="upload" style="color: var(--blue600)">Upload a CSV</a> first.</div>
    </div>`;
    return;
  }
  container.innerHTML = `
    <div class="section" style="margin-bottom: 12px"><div class="section-head">${escape(headline)}</div></div>
    <div class="jobs-picker" style="display: flex; flex-direction: column; gap: 8px">
      ${jobs.map(j => {
        const isActive = j.id === activeJobId;
        const pct = j.total_source_ids
          ? Math.round((j.processed_count || 0) / j.total_source_ids * 100)
          : 0;
        return `
        <button class="job-pick-row" data-job-id="${j.id}"
                style="text-align: left; padding: 12px 14px; border: 1px solid ${isActive ? 'var(--blue500)' : 'var(--g200)'};
                       border-radius: 6px; background: ${isActive ? 'rgba(38,128,235,0.04)' : '#fff'}; cursor: pointer">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px">
            <div style="font-weight: 600">${escape(j.name || j.id.slice(0, 8))}${isActive ? ' <span style="color:var(--blue600); font-size:11px; font-weight:500">· active</span>' : ''}</div>
            <span class="pill ${escape(j.status)}">${escape(j.status)}</span>
          </div>
          <div style="font-size: 12.5px; color: var(--g600); margin-top: 6px; display: flex; gap: 16px">
            <span>${(j.processed_count || 0).toLocaleString()} / ${(j.total_source_ids || 0).toLocaleString()} processed (${pct}%)</span>
            <span>${(j.found_count || 0).toLocaleString()} identities</span>
            <span>${new Date(j.created_at + 'Z').toLocaleString()}</span>
            ${badgesHtml(j)}
          </div>
        </button>`;
      }).join('')}
    </div>
  `;
  container.querySelectorAll('.job-pick-row').forEach(btn => {
    btn.addEventListener('click', () => switchToJob(btn.dataset.jobId));
  });
}

// ─── Shared UI states (2026-10-06 polish) ─────────────────────────────
// One markup for empty / loading / not-available / error panes. `body` and
// `actionsHtml` are trusted HTML built by the caller (escape user data there).
function stateHtml({ kind = 'empty', icon = '', title = '', body = '', actionsHtml = '' }) {
  if (kind === 'error') {
    return `<div class="alert error"><div style="flex:1">${title ? `<div class="alert-title">${escape(title)}</div>` : ''}${body}</div>${actionsHtml}</div>`;
  }
  const ico = kind === 'loading' ? '<div class="big-icon spin">↻</div>' : icon ? `<div class="big-icon">${icon}</div>` : '';
  return `<div class="empty-state">${ico}${title ? `<div class="empty-title">${escape(title)}</div>` : ''}` +
    `${body ? `<div>${body}</div>` : ''}${actionsHtml ? `<div class="empty-actions">${actionsHtml}</div>` : ''}</div>`;
}

// ─── Job chrome: mode badges + progress stepper (2026-10-06) ──────────
// The decisions live in jobview.js (window.AepJobView, tested in node); this
// only paints them. Tabs pass what they already loaded (work orders, the
// analysis status); anything missing is fetched at most every 5 s per job.
const jobChrome = { jobId: null, wos: null, wosAt: 0, analysis: null, analysisAt: 0 };
function noteJobData(jobId, { wos, analysis } = {}) {
  if (jobChrome.jobId !== jobId) Object.assign(jobChrome, { jobId, wos: null, wosAt: 0, analysis: null, analysisAt: 0 });
  if (wos) { jobChrome.wos = wos; jobChrome.wosAt = Date.now(); }
  if (analysis) { jobChrome.analysis = analysis; jobChrome.analysisAt = Date.now(); }
}
async function refreshJobChromeData(job) {
  noteJobData(job.id);
  if (!PLANNABLE_JOB_STATUSES.has(job.status)) return false;     // nothing to plan or analyse yet
  const stale = (at) => Date.now() - at > 5000;
  const tasks = [];
  if (stale(jobChrome.wosAt)) {
    tasks.push(http('GET', `/jobs/${job.id}/work-orders`).then(w => noteJobData(job.id, { wos: w })).catch(() => {}));
  }
  if (job.expansion_mode !== 'none' && stale(jobChrome.analysisAt)) {
    tasks.push(http('GET', `/jobs/${job.id}/analysis`).then(a => noteJobData(job.id, { analysis: a })).catch(() => {}));
  }
  if (!tasks.length) return false;
  await Promise.all(tasks);
  return true;
}
function badgesHtml(job) {
  return `<span class="badge-row">${window.AepJobView.badges(job)
    .map(b => `<span class="mode-badge ${escape(b.tone)}" data-badge="${escape(b.key)}">${escape(b.label)}</span>`).join('')}</span>`;
}
function stepperHtml(job) {
  const mine = jobChrome.jobId === job.id;
  const steps = window.AepJobView.steps(job, { wos: (mine && jobChrome.wos) || [], analysis: mine ? jobChrome.analysis : null });
  const focus = steps.find(st => st.state === 'current') || steps.find(st => st.state === 'failed');
  return `<ol class="stepper" aria-label="Job progress">${steps.map((st, i) => {
      const canGo = st.key !== 'upload' && st.state !== 'locked' && st.state !== 'na';
      const dot = st.state === 'done' ? '✓' : st.state === 'failed' ? '!' : st.state === 'na' ? '–' : String(i + 1);
      const inner = `<span class="step-dot">${dot}</span><span class="step-label">${escape(st.label)}</span>`;
      return `<li class="step ${st.state}${st.key === state.step ? ' here' : ''}" title="${escape(st.hint)}">` +
        (canGo ? `<button type="button" data-goto="${st.key}">${inner}</button>` : `<span>${inner}</span>`) + '</li>';
    }).join('')}</ol>` +
    (focus ? `<div class="stepper-hint ${focus.state}">${focus.state === 'failed' ? '⚠' : 'Next:'} <b>${escape(focus.label)}</b> — ${escape(focus.hint)}</div>` : '');
}

/**
 * Inject an "Active job: NAME · status · badges · Switch" header with the job's
 * progress stepper at the top of a tab body, so the operator always knows which
 * job they're looking at, what it deletes, and what comes next — and can switch
 * to a different job without leaving the tab. `data` = { wos, analysis } the tab
 * already loaded.
 */
function renderActiveJobHeader(tabBodyId, data = {}) {
  if (!state.job) return;
  const body = $('#' + tabBodyId);
  if (!body) return;
  const job = state.job;
  noteJobData(job.id, data);
  let header = body.querySelector('.active-job-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'active-job-header';
    body.prepend(header);
  }
  const paint = () => {
    header.innerHTML = `
      <div class="ajh-top">
        <button class="btn btn-secondary btn-sm ajh-all-jobs" type="button" title="Close this job and show the list of recent jobs">← All jobs</button>
        <div class="ajh-title">
          <span class="ajh-label">Active job:</span>
          <span class="ajh-name">${escape(job.name || job.id.slice(0, 8))}</span>
          <span class="pill ${escape(job.status)}">${escape(job.status)}</span>
          ${badgesHtml(job)}
        </div>
      </div>
      ${stepperHtml(job)}`;
    header.querySelector('.ajh-all-jobs').addEventListener('click', showAllJobs);
  };
  paint();
  refreshJobChromeData(job).then(changed => {
    if (changed && header.isConnected && state.job?.id === job.id) paint();
  });
}

// ─── Expansion ────────────────────────────────────────────────────────
async function renderExpand() {
  // Show a placeholder IMMEDIATELY so the body isn't blank while the
  // auto-load fetches /jobs and /jobs/:id. Without this the operator
  // sees an empty pane for 100-500ms and may think nothing's happening
  // (which is exactly the report we got from the teammate's machine).
  $('#expand-body').innerHTML = `<div class="empty-state">
    <div class="big-icon spin">↻</div>
    <div>Looking for active job…</div>
  </div>`;

  // Auto-resume after a browser refresh / server restart: if there's no
  // current job but one is mid-expansion in the DB, load it so the user
  // sees the live progress.
  await ensureActiveJobLoaded(['expanding', 'expanded', 'ready']);

  if (!state.job) {
    // Instead of a generic "No job selected" message, show the clickable
    // list of all recent jobs. Handles the multi-job case the operator
    // asked about — they can pick any job to view its expansion state.
    await renderJobsPickerInto('#expand-body', { activeJobId: null });
    return;
  }
  // Export is a browser navigation (window.location), so we can't await its
  // completion. Hold the disable for 3 s so a rapid double-click can't
  // re-trigger /export — even though the server is now collision-safe
  // (see fix on 2026-05-29), duplicate downloads still waste resources.
  onClickGuarded($('#btn-export-csv'), async () => {
    window.location.href = `${API}/jobs/${state.job.id}/export`;
    await new Promise(r => setTimeout(r, 3000));
  }, { loadingText: 'Preparing download…' });
  $('#btn-goto-plan').addEventListener('click', () => goto('plan'));

  // Delete Job — hard-delete the job and all its data (expanded identities,
  // work orders, uploaded CSV, exported CSV). Two confirms: a native confirm()
  // for the basic case, and a second confirm() if the server says any work
  // orders are still in flight to Adobe (server returns 409 + a message).
  onClickGuarded($('#btn-delete-job'), async () => {
    if (!state.job) return;
    if (!confirm(
      `Delete job "${state.job.name || state.job.id.slice(0, 8)}" and all of its data?\n\n` +
      `This removes:\n` +
      `  • The uploaded CSV\n` +
      `  • All expanded identities\n` +
      `  • All planned and submitted work orders\n` +
      `  • Any exported CSV\n\n` +
      `This cannot be undone.`
    )) return;
    try {
      await http('DELETE', `/jobs/${state.job.id}`);
      showToast(`Job deleted.`, { kind: 'success' });
      // Suppress auto-load until the operator explicitly picks a job.
      // Otherwise the next tab navigation silently loads SOME OTHER job
      // from the DB, which contradicts the "I deleted, clean slate"
      // mental model (real 2026-05-29 report).
      suppressAutoLoadOnce();
      state.job = null;
      state.progress = null;
      state.workOrders = [];
      goto('upload');
    } catch (err) {
      const code = err.status === 409 ? err.data?.error : null;
      // Both blocking codes offer a force path, but 'unsettled' (R11 #1 — a WO
      // is reconciling or is an ambiguous failed that Adobe MAY have processed)
      // carries a stronger warning: forcing can lose quota tracking for real
      // Adobe work, so the operator must first verify absence in Adobe's UI.
      if (code === 'in_flight' || code === 'unsettled') {
        const extra = code === 'unsettled'
          ? `\n\nForce-delete ONLY after you have verified in Adobe's Data Lifecycle UI that these ` +
            `work order(s) do NOT exist there. Forcing may lose quota tracking for work Adobe actually ` +
            `performed — your next batch could over-count against the cap.`
          : `\n\nAdobe's deletion of those identifiers will continue independently — ` +
            `we just lose visibility into when it finishes.`;
        const forceOk = confirm(`${err.data.message}${extra}\n\nForce-delete anyway?`);
        if (!forceOk) return;
        try {
          await http('DELETE', `/jobs/${state.job.id}?force=true`);
          showToast(code === 'unsettled'
            ? `Job force-deleted — verify your next batch's quota against Adobe's /quota.`
            : `Job force-deleted (Adobe-side deletions still in flight).`, { kind: 'warning' });
          suppressAutoLoadOnce();
          state.job = null;
          state.progress = null;
          state.workOrders = [];
          goto('upload');
        } catch (e2) {
          showToast(`Failed to delete: ${e2.message}`, { kind: 'error' });
        }
      } else {
        showToast(`Failed to delete: ${err.message}`, { kind: 'error' });
      }
    }
  }, { loadingText: 'Deleting…' });

  // Show a loader immediately so the pane isn't blank while we wait for
  // the first /progress + /jobs round-trip. First render() overwrites this.
  $('#expand-body').innerHTML = `<div class="empty-state">
    <div class="big-icon spin">↻</div>
    <div>Loading expansion progress…</div>
  </div>`;

  // Poll progress. While the job expands, only the cheap endpoints: the
  // per-namespace breakdown (?breakdown=1) is a GROUP BY over every stored
  // identity, run on the server's only thread — seconds per call on a big job.
  // Polled every 1.5 s (and on, after the job finished) it starved the expansion
  // itself: 60 lookups/min instead of ~290 (final review #6, 2026-10-09). Now it
  // is fetched ONCE, when the job is no longer expanding; polls never overlap,
  // and polling stops when there is nothing left to watch.
  let breakdown = null;
  let busy = false;
  const render = async () => {
    if (busy) return;
    busy = true;
    try { await paint(); } catch { /* a missed poll — the next one retries */ } finally { busy = false; }
  };
  const paint = async () => {
    const p = await http('GET', `/jobs/${state.job.id}/progress`);
    const expanding = p.status === 'expanding';
    const wantBreakdown = !expanding && !breakdown;
    const j = await http('GET', `/jobs/${state.job.id}${wantBreakdown ? '?breakdown=1' : ''}`);
    if (wantBreakdown) breakdown = j.breakdown || { byNamespace: [] };
    if (!expanding && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    state.progress = p; state.job = j.job;

    const pct = p.total ? Math.round((p.processed / p.total) * 100) : 0;
    // A FAILED expansion is not "complete": its identities are partial, so it
    // must never offer planning (2026-10-06 fix 4) — only Resume.
    const failed = p.status === 'failed';
    const done = p.status !== 'expanding' && !failed;
    const ratio = p.processed ? (p.found / p.processed).toFixed(2) + '×' : '—';

    const byNs = (breakdown && breakdown.byNamespace) || [];   // shown once the job has finished
    const total = byNs.reduce((s, r) => s + r.count, 0);

    $('#expand-body').innerHTML = `
      ${failed ? `
      <div class="alert error" style="margin-bottom: 16px">
        <div style="flex:1">
          <div class="alert-title">Expansion failed — this job cannot be planned yet</div>
          ${escape(j.job.last_error || 'The identity expansion stopped before finishing.')}
          <div style="margin-top: 8px">Resume continues from where it stopped (already-expanded sources are skipped).</div>
        </div>
        <button class="btn btn-primary" id="btn-resume-expansion" style="white-space: nowrap; align-self: center">↻ Resume expansion</button>
      </div>` : ''}
      ${(j.job.no_reply_count || 0) > 0 ? `
      <div class="alert info" id="expand-no-reply" style="margin-bottom: 16px">
        <div style="flex:1">
          <div class="alert-title">No reply from AEP for ${j.job.no_reply_count.toLocaleString()} uploaded ID${j.job.no_reply_count === 1 ? '' : 's'}</div>
          AEP left ${j.job.no_reply_count === 1 ? 'it' : 'them'} out of its answer, even when asked again.
          ${j.job.no_reply_count === 1 ? 'It is' : 'They are'} not in the plan — nothing will be deleted for ${j.job.no_reply_count === 1 ? 'it' : 'them'}.
        </div>
        <button class="btn btn-secondary" id="btn-dl-no-reply-expand" type="button" style="white-space: nowrap; align-self: center">⤓ Download the list</button>
      </div>` : ''}
      <div class="progress-head">
        <b>${failed ? 'Expansion failed' : done ? 'Expansion complete' : 'Expanding identities…'}</b>
        <span class="count">${p.processed.toLocaleString()} / ${p.total.toLocaleString()} (${pct}%)</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill${done ? ' done' : ''}" style="width:${pct}%"></div>
      </div>
      ${p.status === 'expanding' && p.phase === 'resuming' ? `
      <div class="expand-activity" id="expand-activity">↻ Resuming — checked ${fmtNum(p.checked)} rows of the file;
        ${fmtNum(p.skipped)} were already expanded. Lookups continue right after them.</div>`
      : p.status === 'expanding' && p.waiting ? `
      <div class="expand-activity waiting" id="expand-activity">⏳ Waiting for Adobe — ${fmtNum(p.waiting.inFlight)}
        lookup${p.waiting.inFlight === 1 ? '' : 's'} in flight, the oldest for ${fmtNum(Math.round(p.waiting.oldestMs / 1000))} s.
        Slow answers are retried automatically.</div>` : ''}
      <div class="stat-grid" style="margin-top: 20px">
        <div class="stat">
          <div class="stat-label">Batches</div>
          <div class="stat-value">${Math.ceil(p.processed / 1000).toLocaleString()}</div>
          <div class="stat-sub">of ${Math.ceil(p.total / 1000).toLocaleString()}</div>
        </div>
        <div class="stat hi">
          <div class="stat-label">Identities found</div>
          <div class="stat-value">${p.found.toLocaleString()}</div>
          <div class="stat-sub">incl. cluster members</div>
        </div>
        <div class="stat">
          <div class="stat-label">Expansion ratio</div>
          <div class="stat-value">${ratio}</div>
          <div class="stat-sub">avg per source</div>
        </div>
      </div>

      ${byNs.length ? `
        <div class="section" style="margin-top: 24px; padding-top: 24px">
          <div class="section-head">Identities by namespace</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Namespace</th><th>Count</th><th>% of total</th><th>Distribution</th></tr></thead>
            <tbody>${byNs.map(r => `
              <tr>
                <td><span class="ns-badge ${nsClass(r.namespace)}">${escape(r.namespace)}</span></td>
                <td class="num">${r.count.toLocaleString()}</td>
                <td class="num">${((r.count / total) * 100).toFixed(1)}%</td>
                <td><div class="progress-bar" style="width: 120px"><div class="progress-fill" style="width:${(r.count / total * 100)}%; background:${nsColor(r.namespace)}"></div></div></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
    `;

    // Inject the "Active job: NAME · status · Switch ↻" header above
    // everything else so the operator always knows which job they're
    // viewing and can pivot to a different one (multi-job scenarios).
    renderActiveJobHeader('expand-body');

    $('#btn-export-csv').hidden = !done || total === 0;
    $('#btn-goto-plan').hidden = !done;
    $('#btn-goto-analysis').hidden = !done || state.job.expansion_mode === 'none';

    onClickGuarded($('#btn-dl-no-reply-expand'), async () => {
      window.location.href = `${API}/jobs/${state.job.id}/no-reply`;
      await new Promise(r => setTimeout(r, 3000));
    });
    onClickGuarded($('#btn-resume-expansion'), async () => {
      try {
        await http('POST', `/jobs/${state.job.id}/resume-expansion`);
        showToast('Expansion resumed — already-expanded sources are skipped.', { kind: 'success' });
        state.job.status = 'expanding';
        breakdown = null;          // re-fetched when the resumed run finishes
        if (!state.pollTimer) state.pollTimer = setInterval(render, 1500);
        await render();
      } catch (err) {
        showToast(`Could not resume: ${err.message}`, { kind: 'error' });
      }
    }, { loadingText: 'Resuming…' });
  };
  await render();
  if (state.job.status === 'expanding') {
    state.pollTimer = setInterval(render, 1500);
  }
}

// ─── Analysis (2026-10-06) ────────────────────────────────────────────
// Review-only report of who else is in each uploaded ID's Identity Graph
// cluster (server: runner/analysis.js + routes/analysisRoutes.js). Nothing on
// this tab changes the job, its plan or its work orders. Built automatically
// after a cluster expansion; never for an expansion-off job.
const ANALYSIS_CATS = [
  { key: 'not_found',           label: 'Not found in AEP',                         hint: 'AEP has no identities for it — deleted on its own' },
  { key: 'source_only',         label: 'Only itself',                              hint: 'In AEP, nothing else linked' },
  { key: 'linked',              label: 'Linked identities',                        hint: 'Its own email, ECID, phone… no other profile' },
  { key: 'merged_in_list',      label: 'Merged with a profile in your file',       hint: 'That profile is being deleted too' },
  { key: 'merged_outside_list', label: '⚠ Merged with a profile NOT in your file', hint: "Deleting also removes that profile's identities" },
];
const ANALYSIS_PAGE = 50;
const fmtNum = (n) => Number(n || 0).toLocaleString();
function analysisCatLabel(key) {
  return (ANALYSIS_CATS.find(c => c.key === key) || { label: key || 'Not analysed' }).label;
}
// Filter / paging state for the table — kept per job while the tab is revisited.
function analysisView() {
  if (!state.analysisView || state.analysisView.jobId !== state.job?.id) {
    state.analysisView = { jobId: state.job?.id, category: 'all', search: '', sort: 'size', offset: 0, seq: 0, selected: null };
  }
  return state.analysisView;
}
const onAnalysisTab = (jobId) => state.step === 'analysis' && state.job?.id === jobId;

async function renderAnalysis() {
  stopExcelPoll();          // a ready report restarts it (paintExcelReport) if a build is running
  $('#analysis-body').innerHTML = stateHtml({ kind: 'loading', body: 'Looking for active job…' });
  await ensureActiveJobLoaded();
  if (state.step !== 'analysis') return;
  if (!state.job) { await renderJobsPickerInto('#analysis-body', { activeJobId: null }); return; }
  const jobId = state.job.id;
  let a;
  try {
    a = await http('GET', `/jobs/${jobId}/analysis`);
  } catch (err) {
    if (!onAnalysisTab(jobId)) return;
    $('#analysis-body').innerHTML = `<div class="alert error"><div><div class="alert-title">Could not load the analysis</div>${escape(err.message)}</div></div>`;
    renderActiveJobHeader('analysis-body');
    return;
  }
  if (!onAnalysisTab(jobId)) return;
  state.analysis = a;
  $('#btn-analysis-to-plan').hidden = !PLANNABLE_JOB_STATUSES.has(state.job.status);

  if (a.status === 'ready' && a.summary) renderAnalysisReady(a);
  else if (a.status === 'building') renderAnalysisBuilding(a);
  else if (!a.available) {
    const off = state.job.expansion_mode === 'none';
    $('#analysis-body').innerHTML = stateHtml({
      icon: off ? '—' : '◎',
      title: off ? 'No clusters to analyse' : 'Not available yet',
      body: escape(a.reason || ''),
      actionsHtml: off ? '<button class="btn btn-primary" data-goto="plan">Plan Work Orders →</button>'
                       : '<button class="btn btn-secondary" data-goto="expand">Go to Expansion</button>',
    });
  } else if (a.status === 'failed') {
    $('#analysis-body').innerHTML = `
      <div class="alert error">
        <div style="flex:1"><div class="alert-title">The analysis build failed</div>${escape(a.error || 'Unknown error')}
          <div style="margin-top:6px">It is a review report only — planning and submitting are not affected.</div></div>
        <button class="btn btn-primary" id="btn-rebuild-analysis" style="align-self:center; white-space:nowrap">↻ Rebuild</button>
      </div>`;
  } else {
    $('#analysis-body').innerHTML = stateHtml({
      icon: '◇',
      title: 'No analysis yet',
      body: 'Build a report of which uploaded IDs share a cluster with other profiles or identities.<br>' +
        'It reads the expanded identities only — nothing is sent to Adobe and nothing is deleted.',
      actionsHtml: '<button class="btn btn-primary" id="btn-build-analysis">Build analysis</button>',
    });
  }
  renderActiveJobHeader('analysis-body', { analysis: a });
  onClickGuarded($('#btn-build-analysis'), startAnalysisBuild, { loadingText: 'Starting…' });
  onClickGuarded($('#btn-rebuild-analysis'), startAnalysisBuild, { loadingText: 'Starting…' });
}

async function startAnalysisBuild() {
  try {
    await http('POST', `/jobs/${state.job.id}/analysis`);
    showToast('Building the analysis — this page updates as it runs.', { kind: 'info' });
  } catch (err) {
    if (!(err.status === 409 && err.data?.error === 'analysis_running')) {
      showToast(`Could not build the analysis: ${err.message}`, { kind: 'error' });
      return;
    }
  }
  if (state.step === 'analysis') await renderAnalysis();
}

function renderAnalysisBuilding(a) {
  const jobId = state.job.id;
  const paint = (x) => {
    const total = x.sourcesTotal || 0;
    const pct = total ? Math.min(100, Math.floor((x.sourcesDone || 0) / total * 100)) : 0;
    $('#analysis-body').innerHTML = `
      <div class="progress-head"><b>Building the analysis…</b>
        <span class="count">${fmtNum(x.sourcesDone)} / ${fmtNum(total)} uploaded IDs (${pct}%)</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="f-hint" style="margin-top:10px">Runs in the background — you can leave this tab; planning and submitting are not blocked.</div>`;
    renderActiveJobHeader('analysis-body', { analysis: x });
  };
  paint(a);
  if (state.pollTimer) return;
  let busy = false;
  state.pollTimer = setInterval(async () => {
    if (busy) return;                     // never overlap polls on a slow server
    busy = true;
    try {
      const next = await http('GET', `/jobs/${jobId}/analysis`);
      if (!onAnalysisTab(jobId)) return;
      if (next.status === 'building') paint(next);
      else {
        clearInterval(state.pollTimer); state.pollTimer = null;
        await renderAnalysis();
      }
    } catch { /* transient — keep polling */ }
    finally { busy = false; }
  }, 2000);
}

function nsCountsHtml(counts) {
  const entries = Object.entries(counts || {}).sort((x, y) => y[1] - x[1]);
  if (!entries.length) return '<span class="muted">—</span>';
  const shown = entries.slice(0, 3).map(([ns, n]) =>
    `<span class="ns-count"><span class="ns-badge ${nsClass(ns)}">${escape(ns)}</span> ${fmtNum(n)}</span>`).join(' ');
  return shown + (entries.length > 3 ? ` <span class="muted">+${entries.length - 3} more</span>` : '');
}

function renderAnalysisReady(a) {
  const s = a.summary;
  const view = analysisView();
  const total = s.sources || 0;
  // Shares are of every uploaded ID AEP was asked about — the analysed ones plus
  // those it never answered for (no reply, 2026-10-08) — the Excel report's base too.
  const noReply = s.noReply || 0;
  const uploaded = total + noReply;
  const share = (n) => (uploaded ? `${(n / uploaded * 100).toFixed(n > 0 && n / uploaded < 0.001 ? 2 : 1)}%` : '0%');
  const outside = s.byCategory.merged_outside_list || 0;
  const nsRows = Object.entries(s.byNamespace || {}).sort((x, y) => y[1] - x[1]);
  const nsTotal = nsRows.reduce((t, [, n]) => t + n, 0);
  const srcNs = state.job.source_namespace || 'uploaded ID';
  // Built before "Not found in AEP" existed (no not_found key): those IDs are still
  // counted under "Only itself" — show "—" and ask for a rebuild, never 0 (final review #4).
  const legacyNotFound = !Object.prototype.hasOwnProperty.call(s.byCategory || {}, 'not_found');
  const unknownCat = (key) => legacyNotFound && key === 'not_found';
  const chips = [{ key: 'all', label: 'All', n: total }]
    .concat(ANALYSIS_CATS.map(c => ({ key: c.key, label: c.label, n: unknownCat(c.key) ? null : (s.byCategory[c.key] || 0) })));

  $('#analysis-body').innerHTML = `
    <div class="analysis-meta">
      <span>Built ${escape(formatRelativeTime(a.finishedAt))} · ${fmtNum(uploaded)} uploaded IDs${noReply ? ` (${fmtNum(noReply)} no reply from AEP)` : ''} · ${fmtNum(s.identities)} distinct identities in their clusters</span>
      <button class="link-btn" id="btn-rebuild-analysis" type="button" ${a.available ? '' : 'disabled'}>↻ Rebuild</button>
    </div>
    <div class="dl-card" id="analysis-downloads">
      <div class="dl-card-title">Downloads</div>
      <div class="dl-row">
        <div class="dl-what"><b>Excel report</b><span>Dashboard + every merged ID with all its identities in one row</span></div>
        <div class="dl-action" id="dl-excel"></div>
      </div>
      <div class="dl-row">
        <div class="dl-what"><b>Summary CSV</b><span>One row per uploaded ID — follows the filter below (All = every ID)</span></div>
        <div class="dl-action"><button class="btn btn-secondary btn-sm" id="btn-dl-summary" type="button">⤓ Summary CSV</button></div>
      </div>
      <div class="dl-row">
        <div class="dl-what"><b>Detail CSV</b><span>One row per identity</span>
          <div class="dl-scope">
            <label><input type="radio" name="dl-detail-scope" value="flagged" checked> Flagged IDs</label>
            <label><input type="radio" name="dl-detail-scope" value="all"> Every ID</label>
            <label id="dl-scope-category" hidden><input type="radio" name="dl-detail-scope" value="category"> <span></span></label>
          </div>
          <span class="dl-note">"Every ID" is very large on big jobs (about 5 rows per uploaded ID).</span>
        </div>
        <div class="dl-action"><button class="btn btn-secondary btn-sm" id="btn-dl-detail" type="button">⤓ Detail CSV</button></div>
      </div>
      ${(s.noReply || 0) > 0 ? `
      <div class="dl-row">
        <div class="dl-what"><b>No reply from AEP</b><span>${fmtNum(s.noReply)} uploaded ID${s.noReply === 1 ? '' : 's'} AEP never answered for — not in the plan</span></div>
        <div class="dl-action"><button class="btn btn-secondary btn-sm" id="btn-dl-no-reply" type="button">⤓ CSV</button></div>
      </div>` : ''}
    </div>
    ${outside > 0 ? `
    <div class="alert warning" id="analysis-callout">
      <div style="flex:1"><div class="alert-title">${fmtNum(outside)} uploaded ID${outside === 1 ? '' : 's'} share a cluster with a profile that is NOT in your file</div>
        ${fmtNum(s.otherProfiles.notInList)} such profile${s.otherProfiles.notInList === 1 ? '' : 's'} in total. Planning with
        <b>linked identities</b> (the default) also deletes those profiles' identities. Review them, or plan
        <b>uploaded IDs only</b> to delete just the IDs in your file.</div>
      <button class="btn btn-secondary" id="btn-show-outside" style="align-self:center; white-space:nowrap">Show these IDs</button>
    </div>` : `
    <div class="alert success" id="analysis-callout-ok"><div>No uploaded ID shares a cluster with a profile outside your file.</div></div>`}
    <div class="cat-cards">
      ${ANALYSIS_CATS.map(c => {
        const n = s.byCategory[c.key] || 0;
        return `<button type="button" class="cat-card ${c.key}${view.category === c.key ? ' active' : ''}${c.key === 'merged_outside_list' && n > 0 ? ' warn' : ''}" data-cat="${c.key}" title="${escape(c.hint)}">
          <span class="cat-card-label">${escape(c.label)}</span>
          <span class="cat-card-n">${unknownCat(c.key) ? '—' : fmtNum(n)}</span>
          <span class="cat-card-sub">${unknownCat(c.key) ? 'Rebuild to see' : `${share(n)} of uploaded IDs`}</span>
        </button>`;
      }).join('')}
    </div>
    ${legacyNotFound ? `
    <div class="alert info" id="analysis-legacy"><div>This analysis was built before “Not found in AEP” existed, so uploaded IDs
      AEP doesn't know are still counted under “Only itself”. Click <b>↻ Rebuild</b> above to see them.</div></div>` : ''}
    ${(s.noReply || 0) > 0 ? `
    <div class="alert info" id="analysis-no-reply"><div><b>No reply from AEP: ${fmtNum(s.noReply)} uploaded ID${s.noReply === 1 ? '' : 's'}.</b>
      AEP left ${s.noReply === 1 ? 'it' : 'them'} out of its answer, even when asked again, so ${s.noReply === 1 ? 'it is' : 'they are'} not
      in the plan and nothing will be deleted for ${s.noReply === 1 ? 'it' : 'them'}. Download the list under Downloads.</div></div>` : ''}
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Other profiles · in your file</div><div class="stat-value">${fmtNum(s.otherProfiles.inList)}</div><div class="stat-sub">merged with another uploaded ID</div></div>
      <div class="stat${s.otherProfiles.notInList ? ' warn' : ''}"><div class="stat-label">Other profiles · NOT in your file</div><div class="stat-value">${fmtNum(s.otherProfiles.notInList)}</div><div class="stat-sub">also deleted with linked identities</div></div>
      <div class="stat"><div class="stat-label">Linked identities</div><div class="stat-value">${fmtNum(nsTotal)}</div><div class="stat-sub">summed over the uploaded IDs</div></div>
    </div>
    ${nsRows.length ? `
    <details class="ns-dist">
      <summary>Linked identities by namespace (${nsRows.length})</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Namespace</th><th class="num">Count</th><th class="num">Share</th><th>Distribution</th></tr></thead>
        <tbody>${nsRows.map(([ns, n]) => `<tr>
          <td><span class="ns-badge ${nsClass(ns)}">${escape(ns)}</span></td>
          <td class="num">${fmtNum(n)}</td><td class="num">${(n / nsTotal * 100).toFixed(1)}%</td>
          <td><div class="progress-bar" style="width:120px"><div class="progress-fill" style="width:${(n / nsTotal * 100).toFixed(1)}%; background:${nsColor(ns)}"></div></div></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </details>` : ''}
    <div class="section"><div class="section-head">Uploaded IDs</div><div class="section-sub">Click a row to see every identity in its cluster.</div></div>
    <div class="analysis-controls">
      <div class="filter-chips" role="tablist">
        ${chips.map(c => `<button type="button" class="filter-chip${view.category === c.key ? ' active' : ''}" data-cat="${c.key}">${escape(c.label)} <span class="n">${c.n == null ? '—' : fmtNum(c.n)}</span></button>`).join('')}
      </div>
      <div class="analysis-search-row">
        <input type="search" id="analysis-search" placeholder="Find a ${escape(srcNs)} (exact or prefix)" value="${escape(view.search)}" maxlength="512" autocomplete="off" spellcheck="false">
        <select id="analysis-sort" aria-label="Sort">
          <option value="size"${view.sort === 'size' ? ' selected' : ''}>Largest clusters first</option>
          <option value="id"${view.sort === 'id' ? ' selected' : ''}>By ID</option>
        </select>
      </div>
    </div>
    <div class="table-wrap tall">
      <table id="analysis-table">
        <thead><tr><th>${escape(srcNs)}</th><th>Category</th><th class="num">Identities</th><th>Other profiles</th><th>Linked namespaces</th></tr></thead>
        <tbody id="analysis-rows"><tr><td colspan="5" class="table-msg">Loading…</td></tr></tbody>
      </table>
    </div>
    <div class="pager" id="analysis-pager"></div>`;
  renderActiveJobHeader('analysis-body', { analysis: a });

  const setCategory = (cat) => {
    view.category = cat; view.offset = 0;
    $$('#analysis-body .filter-chip, #analysis-body .cat-card').forEach(el => el.classList.toggle('active', el.dataset.cat === cat));
    syncDetailScope();
    loadAnalysisRows();
  };
  $$('#analysis-body .filter-chip, #analysis-body .cat-card').forEach(el =>
    el.addEventListener('click', () => setCategory(view.category === el.dataset.cat && el.classList.contains('cat-card') ? 'all' : el.dataset.cat)));
  $('#btn-show-outside')?.addEventListener('click', () => {
    setCategory('merged_outside_list');
    $('#analysis-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  let searchTimer = null;
  $('#analysis-search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { view.search = ev.target.value.trim(); view.offset = 0; loadAnalysisRows(); }, 300);
  });
  $('#analysis-sort').addEventListener('change', (ev) => { view.sort = ev.target.value; view.offset = 0; loadAnalysisRows(); });
  const tbody = $('#analysis-rows');
  tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-source]');
    if (tr) openAnalysisDrill(tr.dataset.source);
  });
  tbody.addEventListener('keydown', (ev) => {
    const tr = ev.target.closest('tr[data-source]');
    if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openAnalysisDrill(tr.dataset.source); }
  });
  onClickGuarded($('#btn-rebuild-analysis'), startAnalysisBuild, { loadingText: 'Starting…' });
  bindAnalysisDownloads();
  syncDetailScope();
  paintExcelReport(a.report);
  loadAnalysisRows();
}

async function loadAnalysisRows() {
  const view = analysisView();
  const jobId = state.job.id;
  const seq = ++view.seq;
  const qs = new URLSearchParams({ sort: view.sort, limit: String(ANALYSIS_PAGE), offset: String(view.offset) });
  if (view.category !== 'all') qs.set('category', view.category);
  if (view.search) qs.set('search', view.search);
  const tbody = $('#analysis-rows');
  if (!tbody) return;
  tbody.classList.add('loading');
  let r;
  try {
    r = await http('GET', `/jobs/${jobId}/analysis/sources?${qs}`);
  } catch (err) {
    if (seq !== view.seq || !onAnalysisTab(jobId)) return;
    tbody.classList.remove('loading');
    tbody.innerHTML = `<tr><td colspan="5" class="table-msg error">Could not load the IDs: ${escape(err.message)}</td></tr>`;
    return;
  }
  if (seq !== view.seq || !onAnalysisTab(jobId)) return;     // a newer request (or tab) won
  tbody.classList.remove('loading');
  tbody.innerHTML = r.rows.length ? r.rows.map(row => `
    <tr data-source="${escape(row.source_id)}" tabindex="0"${row.source_id === view.selected ? ' class="selected"' : ''}>
      <td class="mono">${escape(row.source_id)}</td>
      <td><span class="cat-badge ${escape(row.category)}">${escape(analysisCatLabel(row.category))}</span></td>
      <td class="num">${fmtNum(row.identities_total)}</td>
      <td>${row.other_in_list || row.other_not_in_list
        ? `${fmtNum(row.other_in_list)} in your file${row.other_not_in_list ? ` · <b class="warn-text">${fmtNum(row.other_not_in_list)} NOT in your file</b>` : ''}`
        : '<span class="muted">—</span>'}</td>
      <td>${nsCountsHtml(row.ns_counts)}</td>
    </tr>`).join('')
    : `<tr><td colspan="5" class="table-msg">${view.search ? 'No uploaded ID matches that search.' : 'No uploaded IDs in this category.'}</td></tr>`;

  const pager = $('#analysis-pager');
  const pages = Math.max(1, Math.ceil(r.total / ANALYSIS_PAGE));
  const page = Math.floor(view.offset / ANALYSIS_PAGE) + 1;
  const from = r.total ? view.offset + 1 : 0;
  const to = Math.min(view.offset + r.rows.length, r.total);
  pager.innerHTML = `
    <span>Showing ${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(r.total)}</span>
    <span class="spacer"></span>
    <button class="btn btn-secondary btn-sm" id="analysis-prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span>Page ${fmtNum(page)} of ${fmtNum(pages)}</span>
    <button class="btn btn-secondary btn-sm" id="analysis-next" ${page >= pages ? 'disabled' : ''}>Next →</button>`;
  $('#analysis-prev').addEventListener('click', () => { view.offset = Math.max(0, view.offset - ANALYSIS_PAGE); loadAnalysisRows(); });
  $('#analysis-next').addEventListener('click', () => { view.offset += ANALYSIS_PAGE; loadAnalysisRows(); });
}

async function openAnalysisDrill(sourceId) {
  const panel = $('#analysis-drill');
  if (!panel) return;
  const view = analysisView();
  const jobId = state.job.id;
  view.selected = sourceId;
  $$('#analysis-rows tr[data-source]').forEach(tr => tr.classList.toggle('selected', tr.dataset.source === sourceId));
  panel.hidden = false;
  panel.innerHTML = `<div class="panel-title">Cluster</div><div class="muted">Loading…</div>`;
  let d;
  try {
    d = await http('GET', `/jobs/${jobId}/analysis/sources/${encodeURIComponent(sourceId)}`);
  } catch (err) {
    if (view.selected !== sourceId || !onAnalysisTab(jobId)) return;
    panel.innerHTML = `<div class="panel-title">Cluster</div><div class="alert error"><div>${escape(err.message)}</div></div>`;
    return;
  }
  if (view.selected !== sourceId || !onAnalysisTab(jobId)) return;
  const groups = [['self', 'Uploaded ID'], ['other_profile', 'Other profiles'], ['linked', 'Linked identities']];
  panel.innerHTML = `
    <div class="drill-head"><div class="panel-title">Cluster of</div>
      <button class="drill-close" type="button" aria-label="Close">×</button></div>
    <div class="drill-id mono">${escape(d.source)}</div>
    <div class="drill-meta"><span class="cat-badge ${escape(d.category || '')}">${escape(analysisCatLabel(d.category))}</span>
      <span>${fmtNum(d.total)} identit${d.total === 1 ? 'y' : 'ies'}</span></div>
    ${groups.map(([rel, title]) => {
      const items = d.identities.filter(i => i.relation === rel);
      if (!items.length) return '';
      return `<div class="drill-group"><div class="drill-group-title">${title} <span class="muted">${fmtNum(items.length)}</span></div>
        ${items.map(i => `<div class="drill-row">
          <span class="ns-badge ${nsClass(i.namespace)}">${escape(i.namespace || `nsid ${i.nsid}`)}</span>
          <span class="drill-val mono">${escape(i.value)}</span>
          ${rel === 'other_profile' ? (i.inList ? '<span class="in-list yes">in your file</span>' : '<span class="in-list no">⚠ NOT in your file</span>') : ''}
        </div>`).join('')}</div>`;
    }).join('')}
    ${d.truncated ? `<div class="f-hint">Showing the first ${fmtNum(d.identities.length)} of ${fmtNum(d.total)}.</div>` : ''}`;
  panel.querySelector('.drill-close').addEventListener('click', () => {
    panel.hidden = true; view.selected = null;
    $$('#analysis-rows tr.selected').forEach(tr => tr.classList.remove('selected'));
  });
  if (window.matchMedia && window.matchMedia('(max-width: 1100px)').matches) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function analysisDownloadUrl(kind) {
  const view = analysisView();
  const qs = new URLSearchParams({ kind });
  if (kind === 'summary') { if (view.category !== 'all') qs.set('category', view.category); }
  else {
    const scope = $('input[name="dl-detail-scope"]:checked')?.value || 'flagged';
    if (scope === 'all') qs.set('category', 'all');
    else if (scope === 'category' && view.category !== 'all') qs.set('category', view.category);
  }
  return `${API}/jobs/${state.job.id}/analysis/export?${qs}`;
}
// "This category" is offered only while a category chip is active.
function syncDetailScope() {
  const view = analysisView();
  const wrap = $('#dl-scope-category');
  if (!wrap) return;
  wrap.hidden = view.category === 'all';
  wrap.querySelector('span').textContent = view.category === 'all' ? '' : `This category (${analysisCatLabel(view.category).replace(/^⚠\s*/, '')})`;
  if (wrap.hidden && wrap.querySelector('input').checked) $('input[name="dl-detail-scope"][value="flagged"]').checked = true;
}
function bindAnalysisDownloads() {
  for (const [sel, kind] of [['#btn-dl-summary', 'summary'], ['#btn-dl-detail', 'detail']]) {
    onClickGuarded($(sel), async () => {
      window.location.href = analysisDownloadUrl(kind);
      await new Promise(r => setTimeout(r, 3000));     // no double-download on a rapid re-click
    });
  }
  onClickGuarded($('#btn-dl-no-reply'), async () => {
    window.location.href = `${API}/jobs/${state.job.id}/no-reply`;
    await new Promise(r => setTimeout(r, 3000));
  });
}
// Excel report: build in the background, poll while building, then download.
function paintExcelReport(report) {
  const el = $('#dl-excel');
  if (!el) return;
  const v = window.AepJobView.excelReportView(report);
  const when = report?.finishedAt ? ` · built ${escape(formatRelativeTime(report.finishedAt))}` : '';
  el.innerHTML = v.state === 'building'
    ? `<div class="dl-progress"><div class="progress-bar"><div class="progress-fill" style="width:${v.pct}%"></div></div>
         <span>${escape(v.label)} · ${fmtNum(report.rowsDone)} of ${fmtNum(report.rowsTotal)} rows</span></div>`
    : v.state === 'ready'
      ? `<button class="btn btn-primary btn-sm" id="btn-dl-excel" type="button">${escape(v.label)}</button>
         <span class="dl-meta">${escape(v.size)}${when}</span>
         <button class="link-btn" id="btn-excel-rebuild" type="button">Rebuild</button>`
      : `<button class="btn btn-primary btn-sm" id="btn-excel-build" type="button">${escape(v.label)}</button>
         ${v.error ? `<span class="dl-error">${escape(v.error)}</span>` : ''}`;
  onClickGuarded($('#btn-excel-build'), () => startExcelReport(false), { loadingText: 'Starting…' });
  onClickGuarded($('#btn-excel-rebuild'), () => startExcelReport(true), { loadingText: 'Starting…' });
  onClickGuarded($('#btn-dl-excel'), async () => {
    window.location.href = `${API}/jobs/${state.job.id}/analysis/report`;
    await new Promise(r => setTimeout(r, 3000));
  });
  if (v.state === 'building') pollExcelReport();
}
async function startExcelReport(rebuild) {
  try {
    paintExcelReport(await http('POST', `/jobs/${state.job.id}/analysis/report${rebuild ? '?rebuild=1' : ''}`));
  } catch (err) {
    // Already building (e.g. started from another tab): follow its progress.
    if (err.status === 409 && err.data?.error === 'report_building') { pollExcelReport(); return; }
    showToast(err.data?.message || `Could not build the Excel report: ${err.message}`, { kind: err.status === 409 ? 'warning' : 'error' });
  }
}
// The Excel poll has its OWN timer: sharing state.pollTimer with the analysis
// build's poll let a rebuild started mid-report find a timer "already running",
// skip its own poll, and freeze at its first progress value (review, 2026-10-07).
let excelPollTimer = null;
function stopExcelPoll() {
  if (excelPollTimer) { clearInterval(excelPollTimer); excelPollTimer = null; }
}
function pollExcelReport() {
  if (excelPollTimer) return;
  const jobId = state.job.id;
  let busy = false;
  excelPollTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const a = await http('GET', `/jobs/${jobId}/analysis`);
      if (!onAnalysisTab(jobId)) { stopExcelPoll(); return; }
      if (a.report?.status !== 'building') stopExcelPoll();
      paintExcelReport(a.report);
    } catch { /* transient — keep polling */ }
    finally { busy = false; }
  }, 2000);
}

// ─── Plan ─────────────────────────────────────────────────────────────
async function renderPlan() {
  $('#plan-body').innerHTML = `<div class="empty-state">
    <div class="big-icon spin">↻</div>
    <div>Looking for active job…</div>
  </div>`;

  // Auto-resume after a browser refresh: a job in 'expanded' or 'ready'
  // status (or further along) is what the Plan tab is built around.
  await ensureActiveJobLoaded(['expanded', 'ready', 'planning']);
  if (!state.job) {
    await renderJobsPickerInto('#plan-body', { activeJobId: null });
    return;
  }
  $('#btn-goto-submit').addEventListener('click', () => goto('submit'));

  // Don't auto-plan on tab entry: re-planning a job whose orders have already
  // been submitted would cause duplicate irreversible deletes. Render the
  // existing plan if there is one; otherwise show a "Build plan" button.
  const [wos, detail] = await Promise.all([
    http('GET', `/jobs/${state.job.id}/work-orders`),
    http('GET', `/jobs/${state.job.id}`),
  ]);
  if (detail?.job) state.job = detail.job;   // fresh status + plan_anchor_month

  if (wos.length === 0) {
    // A plan may only be built from a FINISHED expansion (2026-10-06 fix 4) —
    // the server refuses otherwise; explain instead of offering the button.
    if (!PLANNABLE_JOB_STATUSES.has(state.job.status)) {
      const failed = state.job.status === 'failed';
      $('#plan-body').innerHTML = `
        <div class="empty-state">
          <div><b>${failed ? 'The identity expansion for this job failed.' : 'The identity expansion for this job has not finished.'}</b></div>
          <div style="margin-top: 8px; max-width: 520px">
            ${failed
              ? `Planning now would only cover the identities found before it stopped. Resume the expansion on the Expand tab first.${state.job.last_error ? `<br><span style="color: var(--g600)">${escape(state.job.last_error)}</span>` : ''}`
              : 'Planning now would only cover the identities found so far. The plan can be built as soon as the expansion completes.'}
          </div>
          <button class="btn btn-secondary" data-goto="expand" style="margin-top:16px">Go to Expand</button>
        </div>`;
      renderActiveJobHeader('plan-body');
      return;
    }
    // No plan yet: choose what to delete, then build (2026-10-06).
    await renderScopeChooser($('#plan-body'));
    renderActiveJobHeader('plan-body', { wos });
    return;
  }

  await renderPlanResults(wos);
}

// What a plan deletes (2026-10-06): the uploaded IDs + every identity linked to
// them (default), or only the uploaded IDs. An expansion-off job can only be
// planned IDs-only. The server enforces both rules and keeps the current scope
// on a re-plan that doesn't name one.
async function renderScopeChooser(target, { replan = false } = {}) {
  const job = state.job;
  const off = job.expansion_mode === 'none';
  let analysis = null;
  if (!off) {
    try { analysis = await http('GET', `/jobs/${job.id}/analysis`); noteJobData(job.id, { analysis }); }
    catch { /* the estimates fall back to the job counters */ }
  }
  const summary = analysis?.status === 'ready' ? analysis.summary : null;
  const est = window.AepJobView.scopeEstimates(job, summary, 100000);
  const outside = summary?.byCategory?.merged_outside_list || 0;
  const noReply = job.no_reply_count || 0;
  let scope = off ? 'source_only'
    : (state.planScope?.jobId === job.id ? state.planScope.value : (job.delete_scope || 'cluster'));
  const card = (value, title, desc, e) => `
    <label class="choice-card${scope === value ? ' selected' : ''}">
      <input type="radio" name="plan-scope" value="${value}"${scope === value ? ' checked' : ''}>
      <span class="choice-title">${title}</span>
      <span class="choice-desc">${desc}</span>
      <span class="choice-est">≈ ${fmtNum(e.identities)} identities · ≈ ${fmtNum(e.workOrders)} work order${e.workOrders === 1 ? '' : 's'}</span>
    </label>`;
  target.innerHTML = `
    <div class="section">
      <div class="section-head">${replan ? 'Change what this plan deletes' : 'What should this plan delete?'}</div>
      <div class="section-sub">${off
        ? 'Identity expansion was off for this job, so only the uploaded IDs can be deleted.'
        : noReply > 0 ? 'Both options delete every uploaded ID AEP answered for; they differ in what else is deleted.'
        : 'Both options delete every uploaded ID; they differ in what else is deleted.'}</div>
    </div>
    ${noReply > 0 ? `<div class="alert info" id="plan-no-reply"><div>${fmtNum(noReply)} uploaded ID${noReply === 1 ? '' : 's'} got no reply from AEP and ${noReply === 1 ? 'is' : 'are'} not in this plan.
      <a href="${API}/jobs/${escape(job.id)}/no-reply">Download the list</a></div></div>` : ''}
    <fieldset class="choice-cards" id="plan-scope">
      ${off ? '' : card('cluster', 'Uploaded IDs + linked identities <span class="choice-tag">Recommended</span>',
        "Deletes each uploaded ID's whole Identity Graph cluster (email, ECID, phone, …), so the profile is fully removed.", est.cluster)}
      ${card('source_only', 'Uploaded IDs only', off
        ? 'Deletes exactly the IDs in the uploaded file.'
        : 'Deletes exactly the uploaded IDs. Their linked identities are kept, so the profiles stay reachable through them.', est.sourceOnly)}
    </fieldset>
    <div id="plan-callout"></div>
    <div class="actions">
      ${replan ? '<button class="btn btn-secondary" id="btn-cancel-scope" type="button">Cancel</button>' : ''}
      <button class="btn btn-primary" id="btn-build-plan" type="button">${replan ? 'Re-plan with this choice' : 'Build plan'}</button>
    </div>`;
  const paintCallout = () => {
    const el = $('#plan-callout');
    if (!el) return;
    if (scope === 'cluster' && outside > 0) {
      const profiles = summary.otherProfiles.notInList;
      el.innerHTML = `<div class="alert warning"><div style="flex:1">
          <div class="alert-title">${fmtNum(outside)} uploaded ID${outside === 1 ? '' : 's'} share a cluster with a profile NOT in your file</div>
          Deleting linked identities also deletes those ${fmtNum(profiles)} profile${profiles === 1 ? "'s" : "s'"} identities.
          Review them on the Analysis tab, or choose <b>Uploaded IDs only</b>.</div>
        <button class="btn btn-secondary" data-goto="analysis" type="button" style="align-self:center; white-space:nowrap">Review →</button></div>`;
    } else if (scope === 'cluster' && !summary) {
      el.innerHTML = `<div class="alert info"><div>${analysis?.status === 'building'
        ? 'The shared-cluster analysis is still building.'
        : 'Tip: the Analysis tab shows which uploaded IDs share a cluster with other profiles before you delete.'}
        <a href="#" data-goto="analysis">Open Analysis</a></div></div>`;
    } else if (scope === 'source_only' && !off) {
      el.innerHTML = `<div class="alert warning"><div>Linked identities (email, phone, ECID, …) will <b>not</b> be deleted —
        the profiles stay reachable through them.</div></div>`;
    } else {
      el.innerHTML = '';
    }
  };
  $$('input[name="plan-scope"]', target).forEach(input => input.addEventListener('change', () => {
    scope = input.value;
    state.planScope = { jobId: job.id, value: scope };
    $$('.choice-card', target).forEach(c => c.classList.toggle('selected', c.querySelector('input').checked));
    paintCallout();
  }));
  paintCallout();
  // CRITICAL: duplicate Plan clicks could have raced before the 2026-05 fixes.
  // Server-side ReplanForbiddenError guards correctness; the debounce keeps one
  // click from spawning two in-flight Plan calls.
  onClickGuarded($('#btn-build-plan'), () => buildOrRebuildPlan({ scope }), { loadingText: 'Planning…' });
  $('#btn-cancel-scope')?.addEventListener('click', () => renderPlan());
}

const scopePhrase = (scope) => (scope === 'source_only' ? 'uploaded IDs only' : 'uploaded IDs + linked identities');

async function buildOrRebuildPlan({ scope, restoring = false } = {}) {
  // What the plan being replaced deletes (NULL on a plan made before scopes
  // existed = cluster; null before the first plan) — what Cancel on a scope
  // change goes back to.
  const hadPlan = (state.workOrders?.length || 0) > 0 || (state.job?.planned_orders || 0) > 0;
  const previousScope = state.job?.delete_scope || (hadPlan ? 'cluster' : null);
  $('#plan-body').innerHTML = `<div class="empty-state"><div class="big-icon spin">↻</div><div>Planning work orders…</div></div>`;
  try {
    // scope 'cluster' | 'source_only'; omitted → the server keeps the current
    // plan's scope (or uses the job's default for a first plan).
    const plan = await http('POST', `/jobs/${state.job.id}/plan`, scope ? { scope } : undefined);
    state.plan = plan;
    // The server saved the new orders and their scope before answering; keep
    // the page's idea of what the plan deletes in step with the database.
    if (state.job && plan.scope) state.job.delete_scope = plan.scope;

    // Phase 2: pre-plan confirmation modal. Triggered when the plan spans
    // more than one month, or when re-planning extended the projected
    // timeline. NOTE the plan is already saved when it shows. A restore
    // (below) re-creates a plan the operator had already accepted — no dialog.
    const shouldConfirm = !restoring && ((plan.months > 1) || plan.shiftedFromPrevious);
    if (shouldConfirm) {
      const ok = await showPlanModal(plan);
      if (!ok) {
        // Cancelling a CHANGE of what the plan deletes must not leave the new
        // scope in place: re-plan with the previous one (allowed — nothing has
        // shipped, or the server would have refused the change).
        if (previousScope && previousScope !== plan.scope) {
          showToast(`Cancelled — restoring the previous plan (${scopePhrase(previousScope)}).`, { kind: 'info' });
          return buildOrRebuildPlan({ scope: previousScope, restoring: true });
        }
        // Otherwise show the saved plan, with the job re-read from the server.
        const [wos, detail] = await Promise.all([
          http('GET', `/jobs/${state.job.id}/work-orders`),
          http('GET', `/jobs/${state.job.id}`),
        ]);
        if (detail?.job) state.job = detail.job;
        await renderPlanResults(wos);
        return;
      }
    }
    if (restoring) showToast(`Restored the previous plan (${scopePhrase(plan.scope)}).`, { kind: 'success' });
    const [wos, detail] = await Promise.all([
      http('GET', `/jobs/${state.job.id}/work-orders`),
      http('GET', `/jobs/${state.job.id}`),
    ]);
    if (detail?.job) state.job = detail.job;   // picks up the new plan_anchor_month
    state.workOrders = wos;
    await renderPlanResults(wos);
  } catch (err) {
    if (err.status === 409 && err.data?.error === 'not_expanded') {
      $('#plan-body').innerHTML = `<div class="alert error">
        <div><div class="alert-title">Cannot plan yet</div>${escape(err.data?.message || err.message)}</div></div>`;
      return;
    }
    if (err.status === 409 && err.data?.error === 'scope_unavailable') {
      $('#plan-body').innerHTML = stateHtml({ kind: 'error', title: 'That choice is not available for this job',
        body: escape(err.data?.message || err.message) });
      renderActiveJobHeader('plan-body');
      return;
    }
    if (err.status === 409) {
      $('#plan-body').innerHTML = `<div class="alert error">
        <div><div class="alert-title">Re-plan blocked</div>${escape(err.data?.message || err.message)}</div></div>`;
      // Still render whatever orders exist so the operator can navigate to Submit/Monitor.
      const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);
      if (wos.length > 0) {
        const div = document.createElement('div');
        div.style.marginTop = '20px';
        $('#plan-body').appendChild(div);
        await renderPlanResults(wos, div);
      }
      return;
    }
    if (err.status === 503) {
      $('#plan-body').innerHTML = `<div class="alert error">
        <div><div class="alert-title">Planning blocked: Adobe quota unreachable</div>
        ${escape(err.data?.message || err.message)}</div></div>`;
      return;
    }
    $('#plan-body').innerHTML = `<div class="alert error">
      <div><div class="alert-title">Planning failed</div>${escape(err.message)}</div></div>`;
  }
}

const PLAN_ROWS_SHOWN = 50;     // rows per month table before "Show all"
async function renderPlanResults(wos, container) {
  state.workOrders = wos;
  const target = container || $('#plan-body');
  // Only paint the active-job header when we're rendering into the main
  // plan body — not when `container` is passed (renderPlan uses it for
  // the "already-shipped, show existing plan" path which appends into
  // a sub-element and would otherwise duplicate the header).
  const isMainBody = !container;

  const planned = wos.length;
  const submittedCount = wos.filter(w => !['planned', 'deferred', 'awaiting_approval'].includes(w.status)).length;
  const totalIds = wos.reduce((s, w) => s + w.identifier_count, 0);
  const replanDisabled = submittedCount > 0;

  // Group by Month → Day. month_index is nullable on legacy rows (jobs
  // planned before Phase 2); we treat NULL as Month 1 for backward compat.
  const byMonth = new Map();    // monthIndex -> Map<dayIndex, WO[]>
  for (const w of wos) {
    const m = w.month_index ?? 1;
    const d = w.day_index ?? 1;
    if (!byMonth.has(m)) byMonth.set(m, new Map());
    const dayMap = byMonth.get(m);
    if (!dayMap.has(d)) dayMap.set(d, []);
    dayMap.get(d).push(w);
  }
  const monthsSorted = [...byMonth.keys()].sort((a, b) => a - b);
  const totalMonths = monthsSorted.length || 1;
  state.plan = state.plan || { planned, months: totalMonths };

  // Per-month identifier totals (Phase 2 — what's going against each month's
  // entitlement). We also surface the "earliest completion" month relative
  // to today; the actual calendar date depends on operator cadence so we
  // phrase it as "spans N months from now."
  const monthRows = monthsSorted.map(m => {
    const wosInMonth = [];
    for (const list of byMonth.get(m).values()) wosInMonth.push(...list);
    const idsInMonth = wosInMonth.reduce((s, w) => s + w.identifier_count, 0);
    return { month: m, ids: idsInMonth, wos: wosInMonth };
  });

  const dailyCap   = state.config.dailyLimit   || 1_000_000;
  const monthlyCap = state.config.monthlyLimit || 0;
  const sourceOnly = state.job?.delete_scope === 'source_only';
  const canChangeScope = isMainBody && !replanDisabled && state.job?.expansion_mode !== 'none';

  target.innerHTML = `
    <div class="plan-scope-line">
      <span>This plan deletes</span>
      <b>${sourceOnly ? 'the uploaded IDs only' : 'the uploaded IDs + all linked identities'}</b>
      ${canChangeScope ? '<button class="link-btn" id="btn-change-scope" type="button">Change</button>' : ''}
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Total identities</div>
        <div class="stat-value">${totalIds.toLocaleString()}</div>
      </div>
      <div class="stat hi">
        <div class="stat-label">Work orders</div>
        <div class="stat-value">${planned.toLocaleString()}</div>
      </div>
      <div class="stat ${totalMonths > 1 ? 'warn' : ''}">
        <div class="stat-label">Spans</div>
        <div class="stat-value">${totalMonths} month${totalMonths === 1 ? '' : 's'}</div>
        <div class="stat-sub">${monthlyCap > 0 ? `@ ${monthlyCap.toLocaleString()}/mo · ` : ''}${dailyCap.toLocaleString()}/day</div>
      </div>
    </div>

    ${totalMonths > 1 ? `
    <div class="alert info" style="margin-top: 16px">
      <div>
        <div class="alert-title">Multi-month plan</div>
        This deletion exceeds your monthly quota and will span <b>${totalMonths} months</b>. Each month's batch ships only after the org-wide monthly quota resets at <b>00:00 GMT on the 1st</b>. Months 2 and beyond require explicit approval before they can ship — use the <b>Approve Month</b> button on each future month below.
      </div>
    </div>` : ''}

    <div class="section" style="margin-top: 24px; padding-top: 24px">
      <div class="section-head">Planned work orders, grouped by month</div>
      <div class="section-sub">Day numbers are within each month and re-bucket dynamically when Adobe quota changes.</div>
    </div>

    ${monthRows.map(m => {
      const hasAwaitingApproval = m.wos.some(w => w.status === 'awaiting_approval');
      const allApproved = !hasAwaitingApproval;
      const isMonth1 = m.month === 1;
      return `
      <details class="plan-month" ${m.month === monthsSorted[0] ? 'open' : ''}>
        <summary>
          <span class="plan-month-label">Month ${m.month}${(() => {
            const cal = window.AepBuckets.calendarMonthName(state.job?.plan_anchor_month, m.month);
            return cal ? ` <span style="font-weight: 400; color: var(--g600)">· ${escape(cal)}</span>` : '';
          })()}</span>
          <span class="plan-month-stats">
            ${m.wos.length} work order${m.wos.length === 1 ? '' : 's'} · ${m.ids.toLocaleString()} identifiers
            ${monthlyCap > 0 ? `· ${((m.ids / monthlyCap) * 100).toFixed(0)}% of monthly cap` : ''}
          </span>
          ${!isMonth1 && hasAwaitingApproval ? `<span class="approval-badge">Awaiting approval</span>` : ''}
          ${!isMonth1 && allApproved && m.wos.every(w => ['planned','deferred'].includes(w.status)) ? `<span class="approval-badge approved">Approved</span>` : ''}
        </summary>
        <div class="table-wrap" style="margin-top: 8px">
          <table>
            <thead><tr><th>Local ID</th><th>Day</th><th>Namespaces</th><th>Identities</th><th>Status</th></tr></thead>
            <tbody>${m.wos.map((w, i) => `
              <tr${i >= PLAN_ROWS_SHOWN ? ' class="extra-row" hidden' : ''}>
                <td class="mono">${escape(w.id.slice(0, 8))}…</td>
                <td><span class="day-chip">Day ${w.day_index ?? 1}</span></td>
                <td>${w.namespaces.map(n => {
                    const label = n.code || `nsid:${n.id}`;
                    return `<span class="ns-badge ${nsClass(n.code)}">${escape(label)}</span>`;
                  }).join(' ')}</td>
                <td class="num">${w.identifier_count.toLocaleString()}</td>
                <td><span class="pill ${escape(w.status)}">${escape(w.status)}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${m.wos.length > PLAN_ROWS_SHOWN ? `<div class="show-all-row"><button class="link-btn" type="button" data-show-all>Show all ${m.wos.length.toLocaleString()} work orders</button></div>` : ''}
        ${!isMonth1 && hasAwaitingApproval ? `
        <div class="approval-action" style="margin: 0 14px 14px; padding: 12px; background: var(--blue50, #eff6ff); border-radius: 6px; display:flex; align-items:center; gap:12px">
          <span style="font-size:13px; flex:1">Month ${m.month} contains <b>${m.wos.filter(w => w.status === 'awaiting_approval').length}</b> work order(s) awaiting your approval before they can ship.</span>
          <button class="btn btn-primary btn-sm" data-approve-month="${m.month}" style="white-space:nowrap">Approve Month ${m.month}</button>
        </div>` : ''}
      </details>`;
    }).join('')}

    <div style="margin-top:16px; display:flex; gap:8px; align-items:center">
      <button class="btn btn-secondary" id="btn-replan" ${replanDisabled ? 'disabled title="Re-planning is blocked once any work order has been submitted to Adobe."' : ''}>
        ${replanDisabled ? 'Re-plan blocked (already submitted)' : '↻ Re-plan against live quota'}
      </button>
      <span style="font-size:11.5px; color:var(--g600)">
        ${replanDisabled ? 'Identity content of shipped work orders is immutable. Un-shipped buckets still re-distribute against live quota on every Submit.' : 'Rebuilds the plan using the current Adobe org quota.'}
      </span>
    </div>`;

  if (isMainBody) renderActiveJobHeader('plan-body', { wos });

  const btn = target.querySelector('#btn-replan');
  // No scope sent: the server keeps the saved plan's scope — a stale tab can
  // never switch what the plan deletes.
  if (btn && !replanDisabled) onClickGuarded(btn, () => buildOrRebuildPlan(), { loadingText: 'Re-planning…' });
  target.querySelector('#btn-change-scope')?.addEventListener('click', async () => {
    await renderScopeChooser($('#plan-body'), { replan: true });
    renderActiveJobHeader('plan-body', { wos });
  });
  // Long months show the first PLAN_ROWS_SHOWN orders until expanded.
  target.querySelectorAll('[data-show-all]').forEach(b => b.addEventListener('click', () => {
    b.closest('details')?.querySelectorAll('tr.extra-row').forEach(tr => { tr.hidden = false; });
    b.parentElement.remove();
  }));

  // Wire up "Approve Month N" buttons. Each button flips that month's
  // awaiting_approval WOs to planned, then re-renders the plan results.
  target.querySelectorAll('[data-approve-month]').forEach(approveBtn => {
    approveBtn.addEventListener('click', async () => {
      const monthIndex = Number(approveBtn.dataset.approveMonth);
      approveBtn.disabled = true;
      approveBtn.textContent = 'Approving…';
      try {
        await http('POST', `/jobs/${state.job.id}/approve-month`, { monthIndex });
        showToast(`Month ${monthIndex} approved — work orders are now eligible for submission.`, { kind: 'success' });
        const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);
        await renderPlanResults(wos, container);
      } catch (err) {
        showToast(`Failed to approve: ${err.message}`, { kind: 'error' });
        approveBtn.disabled = false;
        approveBtn.textContent = `Approve Month ${monthIndex}`;
      }
    });
  });

  $('#btn-goto-submit').hidden = false;
}

// ─── Submit ───────────────────────────────────────────────────────────
let submitPollTimer = null;
async function renderSubmit() {
  $('#submit-body').innerHTML = `<div class="empty-state">
    <div class="big-icon spin">↻</div>
    <div>Looking for active job…</div>
  </div>`;

  // Auto-resume after a browser refresh: load the active job and its
  // work orders if we don't have them in memory.
  await ensureActiveJobLoaded(['ready', 'planning', 'submitting', 'partial']);
  if (state.job && state.workOrders.length === 0) {
    try {
      state.workOrders = await http('GET', `/jobs/${state.job.id}/work-orders`);
    } catch { /* server will be queried again by the render loop below */ }
  }
  if (!state.job) {
    await renderJobsPickerInto('#submit-body', { activeJobId: null });
    return;
  }
  if (!state.workOrders.length) {
    $('#submit-body').innerHTML = `<div class="empty-state">
      <div>No work orders yet for this job. <a href="#" data-goto="plan" style="color: var(--blue600)">Plan</a> first.</div>
    </div>`;
    renderActiveJobHeader('submit-body');
    return;
  }
  // ─── Batches: one (month, day) bucket per Submit (2026-10-06 fix 3) ────
  // The tab shows ONE batch at a time. On entry it is the next batch to ship.
  // After a Submit it follows the work orders just sent (state.submitTrackIds)
  // even if the server re-labels them, so the operator watches THAT batch.
  // Previous / Next browse other batches. A Submit sends the EXACT IDs of the
  // viewed batch's shippable orders — the server never substitutes a different
  // set (the old day-only grouping mixed months, and the server's re-labelling
  // turned "Submit Day N" into silent no-ops; see CHANGELOG 2026-10-06).
  const B = window.AepBuckets;
  state.submitTrackIds = null;
  {
    const first = B.firstPendingBucket(state.workOrders);
    state.submitView = first ? { month: first.month, day: first.day } : null;
  }
  const anchorMonth = () => state.job?.plan_anchor_month || null;
  const viewedBatch = () => {
    const buckets = B.listBuckets(state.workOrders);
    if (state.submitTrackIds?.length) {
      const tracked = state.workOrders.find(w => state.submitTrackIds.includes(w.id));
      if (tracked) state.submitView = { month: tracked.month_index ?? 1, day: tracked.day_index ?? 1 };
    }
    let index = state.submitView ? B.bucketIndex(buckets, state.submitView.month, state.submitView.day) : -1;
    if (index === -1) {
      const first = B.firstPendingBucket(state.workOrders);
      index = first ? B.bucketIndex(buckets, first.month, first.day) : buckets.length - 1;
      state.submitView = buckets[index] ? { month: buckets[index].month, day: buckets[index].day } : null;
    }
    return { buckets, index, bucket: buckets[index] || null };
  };
  const viewBatch = (b) => {
    state.submitTrackIds = null;
    state.submitView = b ? { month: b.month, day: b.day } : null;
    render(state.workOrders);
  };

  const render = (wos) => {
    state.workOrders = wos;
    noteJobData(state.job.id, { wos });
    const { buckets, index, bucket } = viewedBatch();
    const batchWos = bucket ? bucket.wos : [];
    const ship = B.submittable(bucket);
    const next = B.firstPendingBucket(wos);
    const isNext = !!(bucket && next && next.month === bucket.month && next.day === bucket.day);
    const label = bucket ? B.bucketLabel(bucket, anchorMonth()) : 'No batches';
    const stats = {
      submitted: wos.filter(w => ['submitted','completed','received','validated','ingested'].includes(w.status)).length,
      failed:    wos.filter(w => w.status === 'failed').length,
      deferred:  wos.filter(w => w.status === 'deferred').length,
    };

    $('#submit-body').innerHTML = `
      <div class="progress-head">
        <b>${escape(label)}</b>
        <span class="count">batch ${index + 1} of ${buckets.length} · ${batchWos.length} work orders · ${batchWos.reduce((s, w) => s + w.identifier_count, 0).toLocaleString()} identifiers</span>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin: 4px 0 14px">
        <button class="btn btn-secondary btn-sm" id="btn-batch-prev" ${index <= 0 ? 'disabled' : ''}>◀ Previous batch</button>
        <button class="btn btn-secondary btn-sm" id="btn-batch-next" ${index >= buckets.length - 1 ? 'disabled' : ''}>Next batch ▶</button>
        ${next && !isNext ? `<button class="btn btn-secondary btn-sm" id="btn-batch-pending">Go to next batch to ship: ${escape(B.bucketLabel(next, anchorMonth()))}</button>` : ''}
      </div>
      <div class="stat-grid">
        <div class="stat hi">
          <div class="stat-label">Submitted</div>
          <div class="stat-value">${stats.submitted}/${wos.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Failed</div>
          <div class="stat-value">${stats.failed}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Deferred</div>
          <div class="stat-value">${stats.deferred}</div>
          <div class="stat-sub">quota exhausted</div>
        </div>
      </div>
      <div class="section" style="margin-top: 24px; padding-top: 24px">
        <div class="section-head">${escape(label)} — work orders</div>
        ${batchWos.some(w => w.status === 'awaiting_approval') ? `<div class="section-sub">Work orders awaiting month approval are not submitted — approve the month on the Plan tab first.</div>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Local ID</th><th>Status</th><th>Identities</th><th>Adobe Work Order ID</th></tr></thead>
          <tbody>${batchWos.map(w => `
            <tr>
              <td class="mono">${escape(w.id.slice(0, 8))}…</td>
              <td><span class="pill ${escape(w.status)}">${escape(w.status)}</span></td>
              <td class="num">${w.identifier_count.toLocaleString()}</td>
              <td class="mono" style="color: var(--g600)">${w.adobe_workorder_id ? escape(w.adobe_workorder_id.slice(0, 28)) + '…' : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    renderActiveJobHeader('submit-body', { wos });
    $('#btn-batch-prev')?.addEventListener('click', () => viewBatch(buckets[index - 1]));
    $('#btn-batch-next')?.addEventListener('click', () => viewBatch(buckets[index + 1]));
    $('#btn-batch-pending')?.addEventListener('click', () => viewBatch(next));

    // Submit-failure banner (review #10): a fire-and-forget submit that failed
    // its preflight (e.g. quota_unavailable) — or found nothing left to ship —
    // persists job.last_error. Surface it so the operator isn't left with a
    // silent {ok:true}. Cleared by the next submit that actually runs.
    if (state.job && state.job.last_error) {
      const errBanner = document.createElement('div');
      errBanner.style.cssText = 'margin: 14px 0; padding: 12px 14px; background: rgba(244,67,54,0.08); border: 1px solid rgba(244,67,54,0.45); border-radius: 6px; font-size: 13px; line-height: 1.5';
      errBanner.innerHTML = `<b>Last submit did not run.</b><br>${escape(state.job.last_error)}`;
      $('#submit-body').insertBefore(errBanner, $('#submit-body').querySelector('.progress-head'));
    }

    // Rejected banner (2026-10-06 fix 5): Adobe definitively REJECTED these
    // (HTTP 4xx before processing, or a local validation failure) — never
    // created, quota refunded. Once the cause is fixed they can be re-queued.
    const rejected = wos.filter(w => w.status === 'failed' && w.failure_definitive && !w.adobe_workorder_id);
    if (rejected.length > 0) {
      const rej = document.createElement('div');
      rej.style.cssText = 'margin: 14px 0; padding: 12px 14px; background: rgba(244,67,54,0.06); border: 1px solid rgba(244,67,54,0.35); border-radius: 6px; font-size: 12.5px; line-height: 1.5';
      rej.innerHTML = `
        <b>${rejected.length} work order(s) were rejected by Adobe and never created.</b>
        Fix the cause shown, then <b>Retry</b> to put it back in the next batch.
        <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px">
          ${rejected.map(w => `
            <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.03); padding: 6px 8px; border-radius: 5px">
              <span><code style="font-size: 11.5px">${escape(w.id.slice(0, 8))}…</code> · ${w.identifier_count.toLocaleString()} ids · ${escape(w.last_error || 'rejected')}</span>
              <button class="btn btn-secondary" data-retry-rejected="${escape(w.id)}" style="white-space: nowrap; flex: 0 0 auto">Retry</button>
            </div>`).join('')}
        </div>`;
      $('#submit-body').insertBefore(rej, $('#submit-body').querySelector('.progress-head'));
      rej.querySelectorAll('[data-retry-rejected]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const woId = btn.dataset.retryRejected;
          if (!confirm('Put this rejected work order back into the next batch?\n\n' +
                       'Adobe rejected it before creating it, so retrying cannot duplicate a delete. ' +
                       'Make sure the cause shown has been fixed first.')) return;
          btn.disabled = true;
          try {
            await http('POST', `/jobs/${state.job.id}/work-orders/${woId}/retry-rejected`);
            showToast('Re-queued — it will ship with the next batch you submit.', { kind: 'success' });
            state.workOrders = await http('GET', `/jobs/${state.job.id}/work-orders`);
            await refresh();
          } catch (err) {
            btn.disabled = false;
            showToast(`Could not retry: ${err.message}`, { kind: 'error' });
          }
        });
      });
    }

    // Reconciliation banner: work orders whose Adobe outcome is UNCERTAIN —
    // 'submitting' (POST outcome unknown) or an AMBIGUOUS 'failed' (legacy /
    // timeout, failure_definitive=0) — with no Adobe ID. Adobe may have them
    // (real 2026-05-29 incident: 10 WOs in Adobe's UI but only 7 in ours after
    // a 60s axios timeout marked 3 as failed). One click hits
    // POST /api/jobs/:id/reconcile, which looks each one up in Adobe by
    // displayName and corrects the local record. Definitive rejections are in
    // the banner above instead — Adobe never created those.
    const reconcilable = wos.filter(w => !w.adobe_workorder_id &&
      (w.status === 'submitting' || (w.status === 'failed' && !w.failure_definitive)));
    if (reconcilable.length > 0) {
      // The EXACT name Adobe stored (persisted before the POST, review R6 #2) so
      // the operator can search for it in Adobe's UI. Legacy rows (no stored
      // name) fall back to the reconstruction recovery itself uses.
      const lookupName = (w) => w.display_name || `Delete ${state.job.name} - WO ${w.id}`;
      // Only an uncertain 'submitting' orphan is eligible for the manual
      // "confirmed absent → retry" action (an ambiguous 'failed' WO is matched
      // by Reconcile, not stuck).
      const submittingOrphans = reconcilable.filter(w => w.status === 'submitting');
      const banner = document.createElement('div');
      banner.style.cssText = 'margin: 14px 0; padding: 12px 14px; background: rgba(255,193,7,0.08); border: 1px solid rgba(255,193,7,0.4); border-radius: 6px';
      banner.innerHTML = `
        <div style="display: flex; gap: 12px; align-items: center; justify-content: space-between">
          <div style="font-size: 13px; line-height: 1.5">
            <b>${reconcilable.length} work order(s) are unreconciled.</b><br>
            A submit can time out <i>after</i> Adobe already received the request, leaving the local
            record uncertain. <b>Step 1:</b> click <b>Reconcile</b> — we look each one up in Adobe by its
            exact name and auto-record any that exist (no duplicate risk).
          </div>
          <button class="btn btn-secondary" id="btn-reconcile" style="white-space: nowrap">↻ Reconcile</button>
        </div>
        ${submittingOrphans.length ? `
        <div style="margin-top: 11px; border-top: 1px solid rgba(255,193,7,0.35); padding-top: 10px; font-size: 12.5px; line-height: 1.5">
          <b>Step 2 — only if Reconcile can't find one.</b> It may be genuinely absent in Adobe, or
          Adobe's list may just be lagging. Search Adobe's Data Lifecycle UI for the exact name shown.
          <b>Only if you confirm it does NOT exist there</b>, release it to retry — releasing one Adobe
          actually processed would create a <b>duplicate irreversible delete</b>.
          <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px">
            ${submittingOrphans.map(w => `
              <div style="display: flex; gap: 8px; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.03); padding: 6px 8px; border-radius: 5px">
                <code style="font-size: 11.5px; word-break: break-all">${escape(lookupName(w))}</code>
                <button class="btn btn-secondary" data-release-absent="${escape(w.id)}" style="white-space: nowrap; flex: 0 0 auto">Confirmed absent → retry</button>
              </div>`).join('')}
          </div>
        </div>` : ''}
      `;
      $('#submit-body').insertBefore(banner, $('#submit-body').querySelector('.progress-head'));
      onClickGuarded(banner.querySelector('#btn-reconcile'), async () => {
        // Disable every per-WO release control while Reconcile is asking Adobe
        // whether it already has these WOs — releasing+retrying one mid-lookup
        // could create a duplicate delete (review R9 #1; the server also rejects
        // it with 409 'reconciling', this is the matching UI affordance).
        const releaseBtns = [...banner.querySelectorAll('[data-release-absent]')];
        releaseBtns.forEach(b => { b.disabled = true; });
        try {
          const r = await http('POST', `/jobs/${state.job.id}/reconcile`);
          const parts = [];
          if (r.matched > 0)        parts.push(`${r.matched} matched in Adobe`);
          if (r.stillFailed > 0)    parts.push(`${r.stillFailed} failed locally, still unconfirmed in Adobe (verify before deleting)`);
          if (r.indeterminate > 0)  parts.push(`${r.indeterminate} still unconfirmed — verify in Adobe, then use “Confirmed absent → retry” below`);
          if (r.perWoError > 0)     parts.push(`${r.perWoError} errored`);
          showToast(parts.length ? `Reconcile: ${parts.join(', ')}.` : 'Nothing to reconcile.', { kind: 'success' });
          // Re-fetch WOs and re-render (rebuilds the banner + buttons fresh).
          state.workOrders = await http('GET', `/jobs/${state.job.id}/work-orders`);
          await refresh();
        } catch (err) {
          releaseBtns.forEach(b => { b.disabled = false; });   // re-enable on failure
          showToast(`Reconcile failed: ${err.message}`, { kind: 'error' });
        }
      }, { loadingText: 'Reconciling…' });
      // Per-WO "confirmed absent → retry" — strongly confirmed (the operator must
      // have verified absence in Adobe's UI). Releases the held reservation and
      // resets the WO to 'planned'; the server refuses any WO Adobe acked.
      banner.querySelectorAll('[data-release-absent]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const woId = btn.dataset.releaseAbsent;
          const wo = reconcilable.find(w => w.id === woId);
          const nm = wo ? lookupName(wo) : woId;
          if (!confirm(
            `Release this work order for retry?\n\n` +
            `Name in Adobe:\n${nm}\n\n` +
            `Do this ONLY after searching Adobe's Data Lifecycle UI and confirming this work order ` +
            `does NOT exist there.\n\nIf it DOES exist, releasing it will create a DUPLICATE, ` +
            `IRREVERSIBLE delete when you re-submit.`)) return;
          btn.disabled = true;
          try {
            await http('POST', `/jobs/${state.job.id}/work-orders/${woId}/release-absent`, { confirmedAbsent: true });
            showToast('Released and reset to planned — submit again to retry it.', { kind: 'success' });
            state.workOrders = await http('GET', `/jobs/${state.job.id}/work-orders`);
            await refresh();
          } catch (err) {
            btn.disabled = false;
            showToast(`Could not release: ${err.message}`, { kind: 'error' });
          }
        });
      });
    }

    // The button acts on the VIEWED batch: submit its shippable orders, or jump
    // to the next batch that has any. Deferred orders (quota-blocked, never
    // sent) stay submittable — resubmit after UTC midnight (daily) or the 1st
    // (monthly).
    const submitBtn = $('#btn-submit-day');
    const opens = bucket ? B.opensOn(anchorMonth(), bucket.month, new Date()) : null;
    if (ship.length > 0 && opens) {
      // Its calendar month hasn't started: submitting now could only defer.
      submitBtn.textContent = `Ships from ${opens}`;
      submitBtn.disabled = true;
    } else if (ship.length > 0) {
      submitBtn.textContent = `Submit ${label}`;
      submitBtn.disabled = false;
    } else if (next) {
      submitBtn.textContent = 'Go to next batch to ship →';
      submitBtn.disabled = false;
    } else {
      submitBtn.textContent = 'Nothing left to submit';
      submitBtn.disabled = true;
    }
    if (stats.deferred > 0) {
      submitBtn.title = `${stats.deferred} order(s) deferred (quota). Submit again after the UTC quota rollover to retry.`;
    } else {
      submitBtn.removeAttribute('title');
    }

    const anySubmitted = wos.some(w => w.adobe_workorder_id);
    $('#btn-goto-monitor').hidden = !anySubmitted;
  };

  const refresh = async () => {
    const [wos, detail] = await Promise.all([
      http('GET', `/jobs/${state.job.id}/work-orders`),
      http('GET', `/jobs/${state.job.id}`),
    ]);
    // Keep state.job fresh so render() sees the latest job row (incl.
    // last_error persisted by a failed async submit — review #10 UI surface).
    if (detail && detail.job) state.job = detail.job;

    // Phase 2: detect month_index drift across the poll. If the redistributor
    // (run on the server before each submit) extended the projected timeline,
    // surface a toast (≤1mo) or modal (≥2mo). We compare to state.lastKnownMonths
    // — first poll just records the value without notifying.
    const currentMaxMonth = Math.max(1, ...wos.map(w => w.month_index ?? 1));
    if (state.lastKnownMonths != null && currentMaxMonth > state.lastKnownMonths) {
      const delta = currentMaxMonth - state.lastKnownMonths;
      if (delta === 1) {
        showToast(
          `Quota refreshed: plan extended by 1 month (now ${currentMaxMonth}). Adobe's org-wide quota changed since last submit.`,
          { kind: 'warn', durationMs: 9000 }
        );
      } else {
        await showModal({
          title: `Plan extended by ${delta} months`,
          bodyHtml: `<p>Live Adobe quota refresh shifted the timeline from <b>${state.lastKnownMonths}</b> to <b>${currentMaxMonth}</b> months.</p>
                     <p class="modal-warn">This usually happens when another deletion against the same org-wide pool has consumed significant monthly quota since you last planned. Already-shipped work orders are unaffected.</p>`,
          actions: [{ label: 'Acknowledge', kind: 'primary', value: true }],
        });
      }
    }
    state.lastKnownMonths = currentMaxMonth;

    render(wos);
    if (detail.quota) {
      const q = detail.quota;
      const d = q.daily || { used: q.used, remaining: q.remaining, limit: q.limit };
      const m = q.monthly;
      const dPct = d.limit ? (d.used / d.limit * 100).toFixed(0) : 0;
      const dColor = d.used / d.limit > 0.9 ? 'var(--red500)' : 'var(--blue500)';
      let html = `
        <div style="font-weight:600; margin-bottom:4px">Daily</div>
        <div class="metric"><span>Used</span><b>${d.used.toLocaleString()}</b></div>
        <div class="metric"><span>Remaining</span><b>${d.remaining.toLocaleString()}</b></div>
        <div class="metric"><span>Limit</span><b>${d.limit.toLocaleString()}</b></div>
        <div class="progress-bar" style="margin-top: 6px">
          <div class="progress-fill" style="width: ${dPct}%; background:${dColor}"></div>
        </div>`;
      if (m && m.limit > 0) {
        const mPct = (m.used / m.limit * 100).toFixed(0);
        const mColor = m.used / m.limit > 0.9 ? 'var(--red500)' : 'var(--blue500)';
        html += `
        <div style="font-weight:600; margin-top:14px; margin-bottom:4px">This month</div>
        <div class="metric"><span>Used</span><b>${m.used.toLocaleString()}</b></div>
        <div class="metric"><span>Remaining</span><b>${m.remaining.toLocaleString()}</b></div>
        <div class="metric"><span>Limit</span><b>${m.limit.toLocaleString()}</b></div>
        <div class="progress-bar" style="margin-top: 6px">
          <div class="progress-fill" style="width: ${mPct}%; background:${mColor}"></div>
        </div>`;
      }
      $('#quota-display').innerHTML = html;
    }
  };

  await refresh();

  // CRITICAL: a duplicate Submit click fires two POST /jobs/:id/submit calls.
  // The server has its own inFlight guard (submission.js), but UI-level
  // debounce prevents the user from seeing two confirmation modals at all
  // and stops the server-side guard from ever needing to engage.
  onClickGuarded($('#btn-submit-day'), async () => {
    const { bucket } = viewedBatch();
    const ship = B.submittable(bucket);
    if (ship.length === 0) {
      viewBatch(B.firstPendingBucket(state.workOrders));
      return;
    }
    const opens = B.opensOn(anchorMonth(), bucket.month, new Date());
    if (opens) {
      showToast(`This batch is in a later month — it can be submitted from ${opens}.`, { kind: 'warn' });
      return;
    }

    // Confirmation lists exactly what will be POSTed: these work-order IDs.
    // The server ships only those still waiting (planned/deferred), each gated
    // by the quota ledger; it never swaps in a different batch.
    const batchLabel = B.bucketLabel(bucket, anchorMonth());
    const ok = await showSubmitModal({
      wosToSubmit: ship,
      batchLabel,
      quota: state.orgQuota,   // last known; server will refresh independently
    });
    if (!ok) {
      logActivity('info', `Submission for ${batchLabel} cancelled`);
      return;
    }

    logActivity('info', `Starting submission for ${batchLabel} (${ship.length} work orders)…`);
    try {
      await http('POST', `/jobs/${state.job.id}/submit`, { workOrderIds: ship.map(w => w.id) });
      state.submitTrackIds = ship.map(w => w.id);   // keep showing THIS batch while it ships
      logActivity('info', 'Submission started server-side');
    } catch (err) {
      // e.g. 409 submission_in_progress: the previous batch is still being sent.
      logActivity('error', 'Submission request failed: ' + err.message);
      showToast(`Not submitted: ${err.message}`, { kind: 'error', durationMs: 9000 });
    }
  });
  $('#btn-goto-monitor').addEventListener('click', () => goto('monitor'));

  // Auto-resume scheduler panel (Phase 3). Loads current settings, lets
  // the operator toggle/edit, and shows "next run" + last-run summary.
  void initAutoResumePanel();

  // Never overlap polls: if the server is slow, skip a tick instead of stacking
  // requests behind each other (each one also re-renders the whole tab).
  let refreshing = false;
  const pollRefresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { await refresh(); } catch (err) { console.warn('submit tab refresh failed', err); }
    finally { refreshing = false; }
  };
  if (submitPollTimer) clearInterval(submitPollTimer);
  submitPollTimer = setInterval(pollRefresh, 2000);
  state.pollTimer = submitPollTimer;
}

// ─── Auto-resume scheduler UI (Phase 3) ───────────────────────────────
// Reads /api/settings/auto-resume on Submit-tab mount, wires inputs to a
// "dirty" tracker, persists via PUT on Save. The Save button is gated until
// the operator has actually changed something — avoids accidental writes
// that overwrite the lastRunAt timestamp the scheduler relies on.
async function initAutoResumePanel() {
  const en = $('#ar-enabled'); const time = $('#ar-time'); const days = $('#ar-days');
  const status = $('#ar-status'); const saveBtn = $('#btn-ar-save'); const lastRunEl = $('#ar-last-run');
  if (!en || !time || !days) return;   // template not mounted

  let original = null;
  try {
    original = await http('GET', '/settings/auto-resume');
  } catch (err) {
    status.textContent = `Failed to load settings: ${err.message}`;
    return;
  }

  en.checked = !!original.enabled;
  time.value = original.localTime || '09:00';
  days.value = original.days || 'every-day';

  const renderStatus = (settings) => {
    if (!settings.enabled) {
      status.textContent = 'Disabled. Enable to auto-resume deferred work on the schedule below.';
      return;
    }
    if (settings.nextFireAt) {
      const when = new Date(settings.nextFireAt);
      const rel = formatRelativeTime(when.toISOString());
      // formatRelativeTime returns "X ago"; for future dates we want "in X".
      const inText = when > new Date() ? `in ${rel.replace(' ago', '')}` : rel;
      status.textContent = `Next run: ${when.toLocaleString()} (${inText}).`;
    } else {
      status.textContent = 'Scheduled.';
    }
  };

  const renderLastRun = (settings) => {
    if (!settings.lastRunAt) { lastRunEl.hidden = true; return; }
    const s = settings.lastRunSummary || {};
    const when = new Date(settings.lastRunAt);
    lastRunEl.hidden = false;
    lastRunEl.innerHTML = `
      <span class="f-hint">
        Last ran ${escape(formatRelativeTime(when.toISOString()))}
        ${s.jobsConsidered != null ? `· considered ${s.jobsConsidered} job${s.jobsConsidered === 1 ? '' : 's'}` : ''}
        ${s.totalSubmitted ? `· submitted ${s.totalSubmitted} WO${s.totalSubmitted === 1 ? '' : 's'}` : ''}
        ${s.totalDeferred  ? `· deferred ${s.totalDeferred}` : ''}
        ${s.totalFailed    ? `· failed ${s.totalFailed}` : ''}
        ${s.jobsSkipped    ? `· skipped ${s.jobsSkipped} (error)` : ''}
      </span>`;
  };

  renderStatus(original);
  renderLastRun(original);

  const markDirty = () => {
    const changed = en.checked !== !!original.enabled
      || time.value !== (original.localTime || '09:00')
      || days.value !== (original.days || 'every-day');
    saveBtn.disabled = !changed;
  };
  [en, time, days].forEach(el => {
    el.addEventListener('change', markDirty);
    el.addEventListener('input', markDirty);
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const oldText = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const next = await http('PUT', '/settings/auto-resume', {
        enabled:   en.checked,
        localTime: time.value,
        days:      days.value,
      });
      original = next;
      renderStatus(next);
      renderLastRun(next);
      logActivity('info', `Auto-resume settings saved (${next.enabled ? 'enabled' : 'disabled'}, ${next.localTime}, ${next.days}).`);
      saveBtn.textContent = 'Saved';
      setTimeout(() => { saveBtn.textContent = oldText; markDirty(); }, 1500);
    } catch (err) {
      logActivity('error', `Auto-resume save failed: ${err.message}`);
      saveBtn.textContent = oldText;
      saveBtn.disabled = false;
    }
  });
}

function logActivity(level, msg) {
  state.activity.push({ t: new Date().toISOString().slice(11, 19), level, msg });
  const el = $('#activity-log');
  if (!el) return;
  if (state.activity.length === 0) {
    el.innerHTML = '<div class="empty">Waiting for activity...</div>';
    return;
  }
  el.innerHTML = state.activity.slice(-50).reverse()
    .map(a => `<div><span class="ts">${a.t}</span> <span class="lvl ${a.level}">[${a.level.toUpperCase()}]</span> ${escape(a.msg)}</div>`)
    .join('');
}

// ─── Monitor: Active Submissions dashboard ────────────────────────────
//
// The Monitor tab is fundamentally about tracking deletions Adobe is
// processing. It pulls from /jobs/monitor (jobs with at least one Adobe-
// acked work order, sorted by latest activity) rather than /jobs (which
// includes expanding/ready/failed jobs that have nothing to monitor).
//
// State for this tab lives in two places:
//   - state.monitorList: array of dashboard-card payloads from the server
//   - state.job:         the currently-selected job (full detail panel)

const STAGES = ['received', 'validated', 'submitted', 'ingested', 'completed'];
const MONITOR_LIST_LIMIT = 20;

// Tracks which per-work-order cards the operator has opened. We preserve
// this across the 15-second auto-poll so re-rendering the detail panel
// doesn't snap every card closed. Keyed by local work-order UUID.
const expandedWoIds = new Set();

async function renderMonitor() {
  const dashboard = $('#monitor-dashboard');
  const empty = $('#monitor-empty');
  const content = $('#monitor-content');
  const summary = $('#monitor-summary');
  const totalsEl = $('#monitor-totals');
  const sandboxFilterEl = $('#monitor-sandbox-filter');
  const listEl = $('#monitor-list');
  const searchInput = $('#monitor-search');

  let searchTerm = '';
  let sandboxFilter = '';   // '' means All sandboxes
  let searchDebounce = null;

  // Visible-only-on-first-load loading indicator: on the initial render
  // and any subsequent FULL refresh (not the silent 15s background poll),
  // show a spinner inside the list area while /jobs/monitor is in flight.
  // Without this the page just looked frozen during the 2026-05-29
  // incident — the user couldn't tell whether the page was loading or
  // truly empty while the backend was snowed under by overlapping ticks.
  let firstFetch = true;
  const fetchAndRenderList = async ({ silent = false } = {}) => {
    if (!silent && firstFetch) {
      listEl.innerHTML = `<div class="empty-state" style="padding:32px">
        <div class="big-icon spin">↻</div>
        <div>Loading work orders…</div>
      </div>`;
      dashboard.hidden = false;
      empty.hidden = true;
    }
    let payload = { rows: [], totals: { in_flight: 0, has_failed: 0, all_completed: 0, total: 0 }, sandboxes: [] };
    let fetchError = null;
    try {
      const params = new URLSearchParams({ limit: String(MONITOR_LIST_LIMIT) });
      if (searchTerm)    params.set('search', searchTerm);
      if (sandboxFilter) params.set('sandbox', sandboxFilter);
      payload = await http('GET', `/jobs/monitor?${params.toString()}`);
    } catch (err) { fetchError = err; }
    firstFetch = false;
    // Surface a visible error instead of silently degrading to "empty".
    // The original 'try { } catch { }' swallow made backend slowness look
    // identical to an empty database.
    if (fetchError) {
      listEl.innerHTML = `<div class="alert error" style="margin:16px 0">
        <div><div class="alert-title">Could not load monitor data</div>
        ${escape(fetchError.message)}<br>
        <small>The background status poller may be backed up — check the server logs for "monitor tick" entries.</small></div>
      </div>`;
      dashboard.hidden = false;
      empty.hidden = true;
      return;
    }
    const { rows, totals, sandboxes } = payload;
    state.monitorList = rows;

    // Genuine empty state — no submitted jobs anywhere, no filters active.
    if (totals.total === 0 && !searchTerm && !sandboxFilter) {
      dashboard.hidden = true;
      content.hidden = true;
      empty.hidden = false;
      return;
    }
    dashboard.hidden = false;
    empty.hidden = true;

    renderTotalsChips(totals);
    renderSandboxFilter(sandboxes);

    summary.textContent = buildSummaryText(rows, totals, searchTerm, sandboxFilter);

    if (rows.length === 0) {
      listEl.innerHTML = `<div class="empty-state" style="padding:20px">No jobs match the current filter.</div>`;
      return;
    }

    // Pick the job to display. Three cases:
    //   1. state.job is set AND still in the new list  → keep showing it
    //      (covers tab-revisit: the previous selection is still valid)
    //   2. state.job is null OR fell out of the list   → auto-select the
    //      most-recently-active row, but only when there's no active search
    //      (don't yank focus while the operator is narrowing results)
    //   3. user is searching with no current selection → render cards only;
    //      detail panel waits for a click
    const stillSelected = state.job && rows.some(r => r.id === state.job.id);
    if (!stillSelected && !searchTerm) {
      await selectMonitorJob(rows[0].id, /*silent=*/true);
    } else if (stillSelected) {
      // The DOM was just re-cloned by goto() — the detail card starts hidden
      // and stale. Re-render it for the existing selection so a tab-revisit
      // shows the pipeline immediately instead of waiting for the next poll.
      content.hidden = false;
      $('#monitor-detail-title').textContent =
        `${state.job.name || state.job.id.slice(0, 8)} — pipeline detail`;
      await refreshDetail();
    }

    listEl.innerHTML = rows.map(r => renderSubmissionCard(r, state.job?.id === r.id)).join('');
    listEl.querySelectorAll('.sub-card').forEach(card => {
      card.addEventListener('click', () => selectMonitorJob(card.dataset.jobId));
    });
  };

  const selectMonitorJob = async (jobId, silent = false) => {
    if (state.job?.id === jobId && !silent) return;
    try {
      const res = await http('GET', `/jobs/${jobId}`);
      state.job = res.job;
      state.workOrders = [];
    } catch {
      // Fall back to the dashboard payload if the detail fetch fails.
      const row = state.monitorList?.find(r => r.id === jobId);
      if (row) state.job = row;
    }
    content.hidden = false;
    if (!silent) {
      // Refresh the cards so the selected one gets the .selected highlight.
      listEl.querySelectorAll('.sub-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.jobId === jobId);
      });
    }
    // Detail header: job name + sandbox + day range. When multiple sandboxes
    // are in flight at once, having the sandbox right next to the job name
    // (rather than only as a filter chip up top) is what keeps operators
    // from confusing two similarly-named jobs.
    const headerTitle = state.job
      ? `${state.job.name || state.job.id.slice(0, 8)} — pipeline detail`
      : 'Work order pipeline';
    $('#monitor-detail-title').textContent = headerTitle;
    const sb = state.job?.sandbox_name;
    if (sb) {
      $('#monitor-detail-sub').innerHTML =
        `Sandbox <b>${escape(sb)}</b> · polled from Adobe every 60s by the background monitor`;
    } else {
      $('#monitor-detail-sub').textContent =
        'Polled from Adobe every 60s by background monitor';
    }
    await refreshDetail();
  };

  const refreshDetail = async () => {
    if (!state.job) return;
    const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);
    const withAdobe = wos.filter(w => w.adobe_workorder_id);

    const counts = STAGES.reduce((a, s, i) => {
      a[s] = withAdobe.filter(w => stageIdx(w.adobe_status) >= i).length;
      return a;
    }, {});

    $('#stage-stats').className = 'stat-grid five';
    $('#stage-stats').innerHTML = STAGES.map(s => `
      <div class="stat">
        <div class="stat-label">${s}</div>
        <div class="stat-value">${counts[s] || 0}</div>
        <div class="stat-track"><div class="stat-track-fill" style="width:${withAdobe.length ? (counts[s]/withAdobe.length*100) : 0}%; background:${stageColor(s)}"></div></div>
      </div>`).join('');

    // Auto-open the first card on a single-WO job so the operator doesn't
    // have to click. With multiple WOs we keep them collapsed by default
    // to avoid a wall of cards — operators expand the ones they care about.
    if (withAdobe.length === 1) expandedWoIds.add(withAdobe[0].id);

    $('#monitor-table').innerHTML = withAdobe.length === 0
      ? '<div class="empty-state">No submitted work orders yet.</div>'
      : withAdobe.map(w => renderWorkOrderCard(w, state.job)).join('');

    // <details> doesn't bubble click → toggle event up through React-like
    // re-renders, so we wire it on every refresh. The expanded-state Set is
    // the source of truth and is consulted on render to set `open`.
    $$('.wo-card', $('#monitor-table')).forEach(card => {
      const id = card.dataset.woId;
      const det = card.querySelector('details.wo-services');
      if (!det) return;
      det.addEventListener('toggle', () => {
        if (det.open) expandedWoIds.add(id);
        else expandedWoIds.delete(id);
      });
    });
    // Copy-to-clipboard for the Adobe work-order ID (handy when escalating
    // to Adobe support; the full DI-... string is the unique handle).
    $$('.wo-card .copy-btn', $('#monitor-table')).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const text = btn.dataset.copy;
        try { await navigator.clipboard.writeText(text); }
        catch { /* clipboard may be blocked — fail quietly, the ID is also visible */ }
        const orig = btn.textContent;
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    });

  };

  // ─── Helpers (closure: searchTerm, sandboxFilter, fetchAndRenderList) ─

  function renderTotalsChips(t) {
    // job-level counts (each job sits in exactly one bucket): in-flight,
    // has-failed (no in-flight but at least one failed WO), all-completed
    const chips = [];
    if (t.in_flight)    chips.push(`<span class="dash-chip in-flight">${t.in_flight} in-flight</span>`);
    if (t.all_completed)chips.push(`<span class="dash-chip completed">${t.all_completed} completed</span>`);
    if (t.has_failed)   chips.push(`<span class="dash-chip failed">${t.has_failed} failed</span>`);
    totalsEl.innerHTML = chips.join('');
  }

  function renderSandboxFilter(sandboxes) {
    // Hide only when there are zero submitted sandboxes (the empty-state
    // renderer takes over upstream anyway). With one sandbox we still show
    // the row so the feature is discoverable — the operator sees both
    // "All sandboxes" and the single sandbox chip; both lead to the same
    // result, but the "filter by sandbox" affordance is visible.
    if (!sandboxes || sandboxes.length === 0) {
      sandboxFilterEl.innerHTML = '';
      sandboxFilter = '';   // collapse a stale filter to All
      return;
    }
    const totalAll = sandboxes.reduce((s, sb) => s + sb.count, 0);
    const chips = [
      `<button type="button" class="dash-filter-chip${sandboxFilter === '' ? ' active' : ''}" data-sandbox="">All sandboxes (${totalAll})</button>`,
      ...sandboxes.map(sb => `<button type="button" class="dash-filter-chip${sandboxFilter === sb.name ? ' active' : ''}" data-sandbox="${escape(sb.name)}">${escape(sb.name)} (${sb.count})</button>`),
    ];
    sandboxFilterEl.innerHTML = chips.join('');
    sandboxFilterEl.querySelectorAll('.dash-filter-chip').forEach(b => {
      b.addEventListener('click', () => {
        const next = b.dataset.sandbox || '';
        if (next === sandboxFilter) return;
        sandboxFilter = next;
        fetchAndRenderList();
      });
    });
  }

  function buildSummaryText(rows, totals, search, sandbox) {
    const scope = sandbox ? `sandbox "${sandbox}"` : 'all sandboxes';
    if (search) {
      return `${rows.length} of ${totals.total} match${totals.total === 1 ? '' : 'es'} for "${search}" in ${scope}.`;
    }
    if (totals.total === 0) {
      return `No submitted jobs in ${scope}.`;
    }
    const visible = rows.length;
    const total = totals.total;
    const overflow = total > visible ? ` (${total - visible} more — use search)` : '';
    return `Showing ${visible} of ${total} in ${scope}, in-flight first then by latest Adobe activity${overflow}.`;
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchTerm = searchInput.value.trim();
      fetchAndRenderList();
    }, 250);
  });

  await fetchAndRenderList();
  // Poll: refresh the list every 15s so an operator who leaves the tab open
  // sees Adobe activity (e.g. orders advancing from received → validated)
  // without manual refresh. silent=true so the background refresh doesn't
  // flash the spinner — we already have data from the first fetch.
  state.pollTimer = setInterval(async () => {
    await fetchAndRenderList({ silent: true });
    if (state.job) await refreshDetail();
  }, 15000);
}

function renderSubmissionCard(r, isSelected) {
  const total = r.submitted_count || 0;
  const completed = r.completed_count || 0;
  const inFlight = r.in_flight_count || 0;
  const failed = r.adobe_failed_count || 0;
  const pct = total ? Math.round((completed / total) * 100) : 0;
  const updated = formatRelativeTime(r.latest_activity_at);
  const dayInfo = r.max_day && r.max_day > 1 ? `Day 1–${r.max_day}` : 'Single-day';
  const ids = Number(r.submitted_ids || 0).toLocaleString();

  return `
    <div class="sub-card${isSelected ? ' selected' : ''}" data-job-id="${escape(r.id)}">
      <div class="sub-card-name">${escape(r.name || r.id.slice(0, 8))}</div>
      <div class="sub-card-action">${isSelected ? 'Selected' : 'Open →'}</div>
      <div class="sub-card-stats">
        <span><b>${total}</b> work order${total === 1 ? '' : 's'}</span>
        ${inFlight ? `<span class="in-flight">${inFlight} in-flight</span>` : ''}
        ${completed ? `<span class="completed">${completed} completed</span>` : ''}
        ${failed ? `<span class="failed">${failed} failed</span>` : ''}
        <span>${ids} ids</span>
        ${badgesHtml(r)}
      </div>
      <div class="sub-card-bar"><div class="sub-card-bar-fill" style="width:${pct}%"></div></div>
      <div class="sub-card-meta">
        <span>${escape(r.sandbox_name || '')} · ${escape(dayInfo)}</span>
        <span>Updated ${escape(updated)}</span>
      </div>
    </div>`;
}

// ─── Per-work-order detail card (Monitor tab) ──────────────────────────
//
// Mirrors the information AEP's "Data lifecycle requests" detail page shows:
//   - Adobe Work Order ID (full, with copy-to-clipboard)
//   - Created / Updated / Time elapsed
//   - Status pill + identifier count + day
//   - "Status by service" buckets (Pending/Processing vs Completed vs Failed)
//
// Multi-sandbox safety: cards live inside the per-job detail panel, which
// is scoped to ONE job (and therefore one sandbox). The sandbox shows once
// in `#monitor-detail-sub` above the cards — see refreshDetail header copy.
//
// Anti-clutter: each card uses native `<details>` so the service breakdown
// is collapsed by default. We auto-expand the only card on a single-WO job
// (no click required) and otherwise preserve open/closed state in
// `expandedWoIds` across the 15-second poll re-renders.
function renderWorkOrderCard(w, job) {
  const adobeId = String(w.adobe_workorder_id || '');
  const status = w.adobe_status;
  const friendly = friendlyStatus(status);
  const cls = friendlyStatusClass(status);
  const isOpen = expandedWoIds.has(w.id);

  // Adobe's createdAt for this work order comes back in submitted_at.
  // updated_at + completed_at are our local timestamps from monitor.js.
  const created = w.submitted_at || w.created_at;
  const updated = w.updated_at;
  const ended   = (status === 'completed' || status === 'failed') ? w.completed_at : null;

  // The EXACT displayName Adobe stored is persisted on the row (review R6 #2) —
  // show it so the operator can search Adobe's UI by it. Fall back to the legacy
  // reconstruction for pre-R6 rows that have no stored name. The description is
  // not persisted; rebuild it (kept in sync with runner/submission.js).
  const jobShortId = (job?.id || '').slice(0, 8);
  const displayName = w.display_name || `Delete ${job?.name || jobShortId} - WO ${w.id}`;
  const description = `Bulk delete (Job ${jobShortId}, Day ${w.day_index})`;

  // Profile-only mode: when targetServices is set, AEP routes through
  // identity/profile/AJO only (the data lake is NOT touched). Worth
  // surfacing so the operator can sanity-check what was actually requested.
  let targetServices = null;
  try { targetServices = w.target_services_json ? JSON.parse(w.target_services_json) : null; } catch { /* */ }
  const isProfileOnly = Array.isArray(targetServices) && targetServices.length > 0;

  const services = parseProductStatusDetails(w.product_status_details);
  const servicesHtml = renderServicesBreakdown(services);

  // Failure surface: if Adobe reported failed OR our local submission errored,
  // pull the message into the card so it doesn't need to be hunted for in logs.
  const errorHtml = w.last_error
    ? `<div class="wo-error"><b>Error</b>: ${escape(w.last_error)}</div>`
    : '';

  return `
    <div class="wo-card" data-wo-id="${escape(w.id)}">
      <div class="wo-card-head">
        <div class="wo-card-id-row">
          <span class="wo-card-id" title="${escape(adobeId)}">${escape(adobeId)}</span>
          <button class="copy-btn" type="button" data-copy="${escape(adobeId)}" title="Copy Adobe work-order ID">copy</button>
        </div>
        <span class="pill ${cls}" title="${escape(status ? 'Adobe API status: ' + status : 'Adobe has not reported a status yet')}">${escape(friendly)}</span>
      </div>

      <div class="wo-card-meta">
        <div><span class="wo-meta-k">Identities</span><span class="wo-meta-v num">${w.identifier_count.toLocaleString()}</span></div>
        <div><span class="wo-meta-k">Day</span><span class="wo-meta-v">${w.day_index}</span></div>
        <div><span class="wo-meta-k">Created</span><span class="wo-meta-v" title="${escape(formatAbsoluteTime(created))}">${escape(formatAbsoluteTime(created))}</span></div>
        <div><span class="wo-meta-k">Updated</span><span class="wo-meta-v" title="${escape(formatAbsoluteTime(updated))}">${escape(formatRelativeTime(updated))}</span></div>
        <div><span class="wo-meta-k">${ended ? 'Elapsed (final)' : 'Time elapsed'}</span><span class="wo-meta-v">${escape(formatElapsed(created, ended))}</span></div>
        ${w.bundle_id ? `<div><span class="wo-meta-k">Bundle</span><span class="wo-meta-v mono" title="${escape(w.bundle_id)}">${escape(String(w.bundle_id).slice(0, 16))}…</span></div>` : ''}
        ${isProfileOnly ? `<div><span class="wo-meta-k">Mode</span><span class="wo-meta-v"><span class="chip">Profile-only</span></span></div>` : ''}
      </div>

      ${errorHtml}

      <details class="wo-services" ${isOpen ? 'open' : ''}>
        <summary>Status by service${services ? ` (${services.length})` : ''}</summary>
        <div class="wo-services-body">
          <div class="wo-desc">
            <div><span class="wo-meta-k">Name</span> ${escape(displayName)}</div>
            <div><span class="wo-meta-k">Description</span> ${escape(description)}</div>
          </div>
          ${servicesHtml}
        </div>
      </details>
    </div>`;
}

// Render the "Status by service" section grouped the same way AEP does:
// pending/processing on top, completed below, failed last (so a regression
// pops to the bottom where it's most visible).
function renderServicesBreakdown(services) {
  if (!services) {
    return `<div class="wo-services-empty">Waiting for Adobe's first per-service status update… (monitor polls every 60s)</div>`;
  }
  const buckets = {
    pending:    services.filter(s => s.status === 'pending'),
    processing: services.filter(s => s.status === 'processing'),
    completed:  services.filter(s => s.status === 'completed'),
    failed:     services.filter(s => s.status === 'failed'),
    other:      services.filter(s => !['pending','processing','completed','failed'].includes(s.status)),
  };

  const renderRow = (s) => `
    <div class="wo-service ${s.cls}">
      <span class="wo-service-icon" aria-hidden="true">${
        s.cls === 'completed' ? '✓' :
        s.cls === 'failed'    ? '✗' :
        s.cls === 'processing'? '⟳' : '○'
      }</span>
      <span class="wo-service-name">${escape(s.name)}</span>
      <span class="wo-service-status">${escape(s.friendly)}</span>
      ${s.updatedAt ? `<span class="wo-service-time" title="${escape(formatAbsoluteTime(s.updatedAt))}">${escape(formatRelativeTime(s.updatedAt))}</span>` : ''}
    </div>`;

  const renderGroup = (label, list) => list.length === 0 ? '' : `
    <div class="wo-services-group">
      <div class="wo-services-group-label">${escape(label)}</div>
      ${list.map(renderRow).join('')}
    </div>`;

  // Combine pending + processing into AEP's "PENDING/PROCESSING" header.
  const inProgress = [...buckets.pending, ...buckets.processing];
  return `
    ${renderGroup('Pending / processing', inProgress)}
    ${renderGroup('Completed', buckets.completed)}
    ${renderGroup('Failed', buckets.failed)}
    ${renderGroup('Other', buckets.other)}
  `;
}

// Parse the two timestamp shapes we deal with into a JS Date:
//   1. SQLite datetime('now')      -> "YYYY-MM-DD HH:MM:SS" (UTC, no T/Z)
//   2. Adobe API + ISO-8601 strings -> standard ISO
//   3. epoch milliseconds           -> number
// Returns null for anything unparseable so callers can render "—".
function parseTimestamp(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Format a duration in ms as a single human-readable unit.
// `suffix` lets the caller turn "2 hr" into "2 hr ago" without us caring
// whether the duration is in the past or future.
function formatDuration(ms, { suffix = '' } = {}) {
  if (ms == null || isNaN(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 60_000) return 'just now';
  const tail = suffix ? ' ' + suffix : '';
  if (abs < 3_600_000) {
    const n = Math.round(abs / 60_000);
    return `${n} min${tail}`;
  }
  if (abs < 86_400_000) {
    const n = Math.round(abs / 3_600_000);
    return `${n} hr${tail}`;
  }
  const days = Math.round(abs / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}${tail}`;
}

function formatRelativeTime(v) {
  const d = parseTimestamp(v);
  if (!d) return '—';
  return formatDuration(Date.now() - d.getTime(), { suffix: 'ago' });
}

// Absolute time matching AEP's display style: "4/23/2026, 7:30 PM".
// Uses the browser's locale via `toLocaleString`, which keeps month/day order
// correct for non-US users without us hardcoding a format.
function formatAbsoluteTime(v) {
  const d = parseTimestamp(v);
  if (!d) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// Time elapsed between start and end. If end is missing, measures against
// now — that's the "Time elapsed: 18 days" case while the work order is
// still processing. If both are missing, returns "—".
function formatElapsed(startV, endV) {
  const start = parseTimestamp(startV);
  if (!start) return '—';
  const end = parseTimestamp(endV) || new Date();
  return formatDuration(end.getTime() - start.getTime());
}

// Normalise Adobe's productStatusDetails array (or our stringified copy of
// it) into a UI-ready shape: { name, raw, status, friendly, cls, updatedAt }.
// Adobe uses `productStatus` (per docs/REVIEW.md §3.7); some older responses
// use `status`. We accept either. Returns null when there's nothing to render
// so the caller can show a "waiting for first status update" hint.
function parseProductStatusDetails(input) {
  if (!input) return null;
  let arr = input;
  if (typeof input === 'string') {
    try { arr = JSON.parse(input); } catch { return null; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map(it => {
    const raw = String(it.productStatus || it.status || '').toLowerCase();
    let status, friendly, cls;
    if (raw === 'success' || raw === 'completed') {
      status = 'completed'; friendly = 'Request completed'; cls = 'completed';
    } else if (raw === 'failed' || raw === 'failure' || raw === 'error') {
      status = 'failed';    friendly = 'Failed';             cls = 'failed';
    } else if (raw === 'processing' || raw === 'in_progress' || raw === 'in-progress') {
      status = 'processing'; friendly = 'Processing';        cls = 'processing';
    } else if (raw === 'pending' || raw === 'queued' || raw === '') {
      status = 'pending';   friendly = 'Request pending';   cls = 'pending';
    } else {
      status = raw;
      friendly = raw.charAt(0).toUpperCase() + raw.slice(1);
      cls = 'unknown';
    }
    return {
      name: it.productName || 'Unknown service',
      raw,
      status, friendly, cls,
      updatedAt: it.createdAt || it.updatedAt || null,
    };
  });
}

// Returns -1 for any status not in STAGES — pipelineHtml then renders no
// "current" dot rather than silently lighting position 0 (which would falsely
// imply Adobe reported "received").
function stageIdx(s) { return STAGES.indexOf(s); }
function stageColor(s) {
  return { received: 'var(--g500)', validated: 'var(--orange500)',
    submitted: 'var(--blue500)', ingested: 'var(--purple500)', completed: 'var(--green500)' }[s];
}
// AEP's Data Lifecycle UI collapses received/validated/submitted/ingested
// into a single "Processing" label and exposes only Processing/Completed/
// Failed to operators. We mirror that vocabulary on the pill so a user
// looking at this tool and at AEP side-by-side sees matching wording. The
// 5-stage pipeline dots remain for engineer-level diagnosis; hover the pill
// to see the raw API status.
function friendlyStatus(raw) {
  if (raw === 'completed') return 'Completed';
  if (raw === 'failed')    return 'Failed';
  if (STAGES.includes(raw)) return 'Processing';
  return raw || 'Unknown';
}
function friendlyStatusClass(raw) {
  if (raw === 'completed') return 'completed';
  if (raw === 'failed')    return 'failed';
  if (STAGES.includes(raw)) return 'processing';
  return 'unknown';
}
function pipelineHtml(current, rawStatus) {
  const friendly = friendlyStatus(rawStatus);
  const cls = friendlyStatusClass(rawStatus);
  const tooltip = rawStatus
    ? `Adobe API status: ${rawStatus}`
    : 'Adobe has not reported a status yet';
  let html = '<div class="pipeline">';
  STAGES.forEach((s, i) => {
    const done = current >= 0 && i <= current;
    const isCurrent = current >= 0 && i === current;
    html += `<div class="node ${isCurrent ? 'current' : done ? 'done' : ''}" title="${escape(s)}"></div>`;
    if (i < STAGES.length - 1) html += `<div class="link ${current >= 0 && i < current ? 'done' : ''}"></div>`;
  });
  html += `<span class="pill ${cls}" title="${escape(tooltip)}">${escape(friendly)}</span></div>`;
  return html;
}

// ─── Helpers ──────────────────────────────────────────────────────────
function escape(s) { return (s ?? '').toString().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' MB';
  return (b/1024/1024/1024).toFixed(1) + ' GB';
}
function showAlert(sel, kind, title, body) {
  $(sel).innerHTML = `<div class="alert ${kind}">
    <div><div class="alert-title">${escape(title)}</div>${escape(body)}</div></div>`;
}
function nsClass(ns) { return ['hashedKocid', 'email', 'phone', 'ECID', 'CRMID', 'GAID', 'IDFA'].includes(ns) ? ns : 'default'; }
function nsColor(ns) {
  return { hashedKocid: 'var(--purple500)', email: 'var(--blue600)', phone: 'var(--green600)',
    ECID: 'var(--orange500)', CRMID: 'var(--red500)', GAID: '#7B1FA2', IDFA: '#00838F' }[ns] || 'var(--g500)';
}

// ─── Bootstrap ────────────────────────────────────────────────────────
$$('.nav-item').forEach(el => el.addEventListener('click', () => goto(el.dataset.step)));
document.addEventListener('click', e => {
  const go = e.target.closest('[data-goto]');
  if (go) { e.preventDefault(); goto(go.dataset.goto); }
});

// On page load, restore the most-recently-used credential from the server so
// the user doesn't have to re-pick / re-enter on every refresh. Client secret
// never crosses the wire — we mark it as '(unchanged)' so testConnection uses
// the stored credsId instead of re-saving.
async function bootstrap() {
  let savedCred = null;
  try {
    const list = await http('GET', '/config/credentials');
    if (Array.isArray(list) && list.length > 0) savedCred = list[0];
  } catch {
    // First run with no DB, or server temporarily unreachable — just fall
    // through to the fresh Config screen so the user can start from scratch.
  }

  if (savedCred) {
    state.credsId             = savedCred.id;
    state.config.label        = savedCred.label;
    state.config.clientName   = savedCred.client_name || '';
    state.config.environment  = savedCred.environment;
    state.config.region       = savedCred.region;
    state.config.imsOrgId     = savedCred.ims_org_id;
    state.config.clientId     = savedCred.client_id;
    state.config.clientSecret = '(unchanged)';
  }
  updateClientNameDisplay();

  // Open what the address says (a refresh, Back into the app, a pasted link);
  // no or unknown address → Environment (2026-10-09).
  await applyRoute(parseRoute(location.hash));

  // If a credential was restored, auto-verify the token and load sandboxes in
  // the background — avoids a manual Test Connection click on every reload.
  // The token cache in imsAuth.js means this is usually free if the server
  // was never restarted.
  if (savedCred) {
    try { await testConnection(); } catch { /* silent; user can retry manually */ }
  }
}

// ─── Modal + toast (Phase 2) ───────────────────────────────────────────
// Single shared modal: showModal({title, body, actions}) → Promise<value>
// where `value` is the `value` field of the action button the user clicked
// (or null if dismissed via close-X / Escape / backdrop). Modals never
// interrupt the underlying state — only one modal can be open at a time.
let modalResolver = null;
function showModal({ title, bodyHtml, actions }) {
  return new Promise(resolve => {
    if (modalResolver) {
      // Resolve the previous modal with null before opening a new one.
      modalResolver(null);
    }
    modalResolver = (v) => { closeModal(); resolve(v); };

    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    const actionsRoot = $('#modal-actions');
    actionsRoot.innerHTML = '';
    actions.forEach(a => {
      const b = document.createElement('button');
      b.className = `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-secondary'}`;
      b.textContent = a.label;
      b.type = 'button';
      b.addEventListener('click', () => modalResolver?.(a.value ?? a.label));
      actionsRoot.appendChild(b);
    });
    const root = $('#modal-root');
    root.hidden = false;
    // Focus the primary action so Enter confirms by default.
    setTimeout(() => {
      const primary = actionsRoot.querySelector('.btn-primary, .btn-danger') || actionsRoot.querySelector('button');
      if (primary) primary.focus();
    }, 50);
  });
}

function closeModal() {
  const root = $('#modal-root');
  root.hidden = true;
  modalResolver = null;
}

// Wire close button + backdrop click + Escape key once (modal is single-instance).
$('#modal-close').addEventListener('click', () => modalResolver?.(null));
$('#modal-root .modal-backdrop').addEventListener('click', () => modalResolver?.(null));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal-root').hidden) modalResolver?.(null);
});

// Lightweight toast. Stacks in #toast-container, auto-dismisses after ms.
// Kinds: info | warn | error | success. For Phase 2 we use 'warn' for
// the "plan extended by 1 month" notification.
function showToast(message, { kind = 'info', durationMs = 6000 } = {}) {
  const root = $('#toast-container');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span>${escape(message)}</span>
                  <button class="toast-close" aria-label="Dismiss">×</button>`;
  root.appendChild(el);
  // Animate in
  requestAnimationFrame(() => el.classList.add('toast-in'));
  const close = () => {
    el.classList.remove('toast-in');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  if (durationMs > 0) setTimeout(close, durationMs);
}

// Pre-plan confirmation modal. Surfaces the multi-month projection and the
// fact that monthly quota only resets at UTC midnight on the 1st. Returns
// true if the operator clicked Continue, false otherwise. Per the
// 2026-05-15 design (RQ-5): shown when months > 1 OR when re-planning
// extended the timeline. RQ-2 — toast for ≤1mo shift, modal for ≥2mo
// shift — applies on the re-plan path here.
async function showPlanModal(plan) {
  const isShift = !!plan.shiftedFromPrevious;
  const prev = plan.previousMonths ?? 1;
  const delta = plan.months - prev;
  const totalIds = (plan.totalIdentifiers || 0).toLocaleString();
  const perMonth = plan.perMonthCounts || [];

  // RQ-2 routing: small shift (1mo extension) → toast, not modal.
  if (isShift && delta === 1) {
    showToast(`Plan extended by 1 month (now ${plan.months}). Adobe quota changed since the previous plan.`, { kind: 'warn', durationMs: 8000 });
    return true;
  }

  const title = isShift && delta >= 2
    ? `Plan extended by ${delta} months — confirm`
    : 'Multi-month plan — confirm';

  const bodyHtml = `
    <p>This deletion will span <b>${plan.months} month${plan.months === 1 ? '' : 's'}</b>
       because the total identifier count (<b>${totalIds}</b>) exceeds your monthly Adobe entitlement.</p>
    ${isShift ? `<p class="modal-warn">
        Re-planning against fresh Adobe quota shifted the timeline from
        <b>${prev}</b> to <b>${plan.months}</b> months. The most likely cause is another
        deletion against the same org-wide pool.</p>` : ''}
    <p><b>Per-month breakdown:</b></p>
    <ul class="modal-list">
      ${perMonth.map((c, i) => `<li>Month ${i + 1}: ${c.toLocaleString()} identifiers</li>`).join('')}
    </ul>
    <p class="modal-note">
      Each month's batch can only ship after the org-wide monthly quota resets
      at <b>00:00 GMT on the 1st</b>. Months 2 and beyond require explicit
      approval before they can ship — use the <b>Approve Month</b> button on
      each future month in the Plan tab.
    </p>`;

  const choice = await showModal({
    title,
    bodyHtml,
    actions: [
      { label: 'Cancel',             kind: 'secondary', value: false },
      { label: 'Confirm plan',       kind: 'primary',   value: true  },
    ],
  });
  return !!choice;
}

// Pre-submit consumption check. Always shown — the operator confirms each
// destructive submission with the current quota numbers + planned count.
// Returns true if the operator clicks "Submit", false otherwise.
async function showSubmitModal({ wosToSubmit, batchLabel, quota }) {
  const ids = wosToSubmit.reduce((s, w) => s + w.identifier_count, 0);
  const dRem = quota?.daily?.remaining;
  const mRem = quota?.monthly?.remaining;
  const dCap = quota?.daily?.quota;
  const mCap = quota?.monthly?.quota;

  const overDaily   = dRem != null && ids > dRem;
  const overMonthly = mRem != null && ids > mRem;
  const willPartial = overDaily || overMonthly;

  const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

  const job = state.job || {};
  const deletes = job.delete_scope === 'source_only'
    ? 'the <b>uploaded IDs only</b> — their linked identities are kept'
    : 'the <b>uploaded IDs and every identity linked to them</b>';
  const bodyHtml = `
    ${state.job ? `<div class="modal-badges">${badgesHtml(state.job)}</div>` : ''}
    <p>This plan deletes ${deletes}.</p>
    <p>About to submit <b>${wosToSubmit.length} work order${wosToSubmit.length === 1 ? '' : 's'}</b>
       (<b>${ids.toLocaleString()} identifiers</b>) — batch <b>${escape(batchLabel)}</b>.
       Exactly these work orders are sent; any that can't fit today's or this month's quota are deferred, never swapped for others.</p>

    <div class="modal-quota">
      <div>
        <div class="modal-quota-label">Daily</div>
        <div class="modal-quota-value"><b>${fmt(dRem)}</b> / ${fmt(dCap)} remaining</div>
        ${overDaily ? '<div class="modal-warn-inline">⚠ Submission exceeds today\'s daily remaining — excess will be deferred.</div>' : ''}
      </div>
      <div>
        <div class="modal-quota-label">Monthly</div>
        <div class="modal-quota-value"><b>${fmt(mRem)}</b> / ${fmt(mCap)} remaining</div>
        ${overMonthly ? '<div class="modal-warn-inline">⚠ Submission exceeds this month\'s monthly remaining — excess will be deferred until next month.</div>' : ''}
      </div>
    </div>
    ${quota?.stale ? `<p class="modal-warn">⚠ Quota numbers are <b>stale</b> (live Adobe fetch failed). Last refreshed at ${escape(quota.fetchedAt || '—')}.</p>` : ''}
    <p class="modal-note">Adobe Data Hygiene work orders are <b>irreversible</b>. Once Adobe accepts a work order, the identities listed are queued for deletion across Data Management, Identity, Profile, and Journey services.</p>`;

  const choice = await showModal({
    title: willPartial ? 'Submit (some work will defer) — confirm' : 'Submit — confirm',
    bodyHtml,
    actions: [
      { label: 'Cancel', kind: 'secondary', value: false },
      { label: 'Submit', kind: 'danger',    value: true  },
    ],
  });
  return !!choice;
}

bootstrap();
