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
    monthlyLimit: 3_000_000,     // 0 disables monthly tracking
    sourceNamespace: 'hashedKocid',  // code; defaults to hashedKocid for backwards compat
    sourceNamespaceId: null,         // numeric nsid — filled from the namespace registry
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
  currentDay: 1,
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

// ─── Steps & routing ───────────────────────────────────────────────────
const STEPS = {
  config:  { title: 'Environment Configuration', sub: 'Configure IMS credentials and sandbox for the Data Lifecycle API.', crumbs: ['Data Management', 'Environment Configuration'], render: renderConfig },
  upload:  { title: 'Upload Source Identities',  sub: 'Upload a CSV of source identifier values to be deleted.',          crumbs: ['Data Management', 'Source CSV Upload'],     render: renderUpload },
  expand:  { title: 'Identity Graph Expansion',  sub: 'Resolve all identities linked to each source identifier.',         crumbs: ['Identities', 'Identity Expansion'],         render: renderExpand },
  plan:    { title: 'Work Order Batch Planning', sub: 'Group identities into optimally-sized batches respecting daily quotas.', crumbs: ['Identities', 'Batch Planning'],    render: renderPlan },
  submit:  { title: 'Submit Work Orders',        sub: 'Submit record-delete work orders to the Data Hygiene API.',          crumbs: ['Data Lifecycle', 'Work Orders'],            render: renderSubmit },
  monitor: { title: 'Work Order Monitor',        sub: 'Track status of submitted work orders across downstream services.', crumbs: ['Data Lifecycle', 'Monitor'],                render: renderMonitor },
};

function goto(step) {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  state.step = step;
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

  $('#btn-test').addEventListener('click', testConnection);
  $('#btn-save-creds').addEventListener('click', saveAndContinue);
  $('#btn-refresh-sandboxes').addEventListener('click', () => loadSandboxes(true));
  $('#btn-refresh-datasets').addEventListener('click', () => loadDatasets(true));
  $('#btn-refresh-quota').addEventListener('click', () => loadOrgQuota(true));
  $('#c-sandbox-picker').addEventListener('change', onSandboxChange);
  $('#c-delete-mode').addEventListener('change', onDeleteModeChange);
  $('#btn-cred-add').addEventListener('click', addNewCredentialFlow);
  $('#btn-cred-remove').addEventListener('click', removeCurrentCredential);
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
  // Monthly: 0 or empty means "no monthly cap tracking" — sent as 0 to the
  // backend which maps it to null on the jobs row.
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
      monthlyHint.textContent = `Adobe-reported entitlement: ${q.monthly.quota.toLocaleString()} / month · 0 = unlimited`;
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
  $('#btn-start-expand').addEventListener('click', startExpansion);
  $('#c-source-ns').addEventListener('change', onSourceNsChange);
  $('#btn-refresh-namespaces').addEventListener('click', () => loadNamespaces(true));

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
    state.job = { id: res.jobId, total_source_ids: res.totalSourceIds, status: 'expanding' };
    goto('expand');
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
}

// ─── Expansion ────────────────────────────────────────────────────────
async function renderExpand() {
  if (!state.job) {
    $('#expand-body').innerHTML = `<div class="empty-state">
      <div class="big-icon">!</div>
      <div>No job selected. Upload a CSV first.</div>
    </div>`;
    return;
  }
  $('#btn-export-csv').addEventListener('click', () => window.location.href = `${API}/jobs/${state.job.id}/export`);
  $('#btn-goto-plan').addEventListener('click', () => goto('plan'));

  // Show a loader immediately so the pane isn't blank while we wait for
  // the first /progress + /jobs round-trip. First render() overwrites this.
  $('#expand-body').innerHTML = `<div class="empty-state">
    <div class="big-icon spin">↻</div>
    <div>Loading expansion progress…</div>
  </div>`;

  // Poll progress
  const render = async () => {
    const [p, j] = await Promise.all([
      http('GET', `/jobs/${state.job.id}/progress`),
      http('GET', `/jobs/${state.job.id}`),
    ]);
    state.progress = p; state.job = j.job;

    const pct = p.total ? Math.round((p.processed / p.total) * 100) : 0;
    const done = p.status !== 'expanding';
    const ratio = p.processed ? (p.found / p.processed).toFixed(2) + '×' : '—';

    const byNs = j.breakdown.byNamespace;
    const total = byNs.reduce((s, r) => s + r.count, 0);

    $('#expand-body').innerHTML = `
      <div class="progress-head">
        <b>${done ? 'Expansion complete' : 'Expanding identities…'}</b>
        <span class="count">${p.processed.toLocaleString()} / ${p.total.toLocaleString()} (${pct}%)</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill${done ? ' done' : ''}" style="width:${pct}%"></div>
      </div>
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

    $('#btn-export-csv').hidden = !done || total === 0;
    $('#btn-goto-plan').hidden = !done;
  };
  await render();
  if (state.job.status === 'expanding') {
    state.pollTimer = setInterval(render, 1500);
  }
}

// ─── Plan ─────────────────────────────────────────────────────────────
async function renderPlan() {
  if (!state.job) { $('#plan-body').innerHTML = 'No job.'; return; }
  $('#btn-goto-submit').addEventListener('click', () => goto('submit'));

  // Don't auto-plan on tab entry: re-planning a job whose orders have already
  // been submitted would cause duplicate irreversible deletes. Render the
  // existing plan if there is one; otherwise show a "Build plan" button.
  const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);

  if (wos.length === 0) {
    $('#plan-body').innerHTML = `
      <div class="empty-state">
        <div>No plan yet for this job.</div>
        <button class="btn btn-primary" id="btn-build-plan" style="margin-top:16px">Build plan</button>
      </div>`;
    $('#btn-build-plan').addEventListener('click', () => buildOrRebuildPlan());
    return;
  }

  await renderPlanResults(wos);
}

async function buildOrRebuildPlan() {
  $('#plan-body').innerHTML = `<div class="empty-state"><div class="big-icon spin">↻</div><div>Planning work orders…</div></div>`;
  try {
    const plan = await http('POST', `/jobs/${state.job.id}/plan`);
    state.plan = plan;

    // Phase 2: pre-plan confirmation modal. Triggered when the plan spans
    // more than one month, or when re-planning extended the projected
    // timeline. The operator confirms before we render the new plan and
    // before any submission can start.
    const shouldConfirm = (plan.months > 1) || plan.shiftedFromPrevious;
    if (shouldConfirm) {
      const ok = await showPlanModal(plan);
      if (!ok) {
        // Operator cancelled. Re-render the existing plan (still in DB).
        const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);
        await renderPlanResults(wos);
        return;
      }
    }
    const wos = await http('GET', `/jobs/${state.job.id}/work-orders`);
    state.workOrders = wos;
    await renderPlanResults(wos);
  } catch (err) {
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

async function renderPlanResults(wos, container) {
  state.workOrders = wos;
  const target = container || $('#plan-body');

  const planned = wos.length;
  const submittedCount = wos.filter(w => !['planned', 'deferred'].includes(w.status)).length;
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

  target.innerHTML = `
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
        This deletion exceeds your monthly quota and will span <b>${totalMonths} months</b>. Each month's batch ships only after the org-wide monthly quota resets at <b>00:00 GMT on the 1st</b>. Phase 3 (auto-resume) is not yet enabled; for now you'll need to come back and click Submit each month.
      </div>
    </div>` : ''}

    <div class="section" style="margin-top: 24px; padding-top: 24px">
      <div class="section-head">Planned work orders, grouped by month</div>
      <div class="section-sub">Day numbers are within each month and re-bucket dynamically when Adobe quota changes.</div>
    </div>

    ${monthRows.map(m => `
      <details class="plan-month" ${m.month === monthsSorted[0] ? 'open' : ''}>
        <summary>
          <span class="plan-month-label">Month ${m.month}</span>
          <span class="plan-month-stats">
            ${m.wos.length} work order${m.wos.length === 1 ? '' : 's'} · ${m.ids.toLocaleString()} identifiers
            ${monthlyCap > 0 ? `· ${((m.ids / monthlyCap) * 100).toFixed(0)}% of monthly cap` : ''}
          </span>
        </summary>
        <div class="table-wrap" style="margin-top: 8px">
          <table>
            <thead><tr><th>Local ID</th><th>Day</th><th>Namespaces</th><th>Identities</th><th>Status</th></tr></thead>
            <tbody>${m.wos.map(w => `
              <tr>
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
      </details>`).join('')}

    <div style="margin-top:16px; display:flex; gap:8px; align-items:center">
      <button class="btn btn-secondary" id="btn-replan" ${replanDisabled ? 'disabled title="Re-planning is blocked once any work order has been submitted to Adobe."' : ''}>
        ${replanDisabled ? 'Re-plan blocked (already submitted)' : '↻ Re-plan against live quota'}
      </button>
      <span style="font-size:11.5px; color:var(--g600)">
        ${replanDisabled ? 'Identity content of shipped work orders is immutable. Un-shipped buckets still re-distribute against live quota on every Submit.' : 'Rebuilds the plan using the current Adobe org quota.'}
      </span>
    </div>`;

  const btn = target.querySelector('#btn-replan');
  if (btn && !replanDisabled) btn.addEventListener('click', () => buildOrRebuildPlan());

  $('#btn-goto-submit').hidden = false;
}

// ─── Submit ───────────────────────────────────────────────────────────
let submitPollTimer = null;
async function renderSubmit() {
  if (!state.workOrders.length) { $('#submit-body').innerHTML = 'No work orders. Plan first.'; return; }
  const totalDays = Math.max(...state.workOrders.map(w => w.day_index), 1);

  const render = (wos) => {
    state.workOrders = wos;
    const today = wos.filter(w => w.day_index === state.currentDay);
    const stats = {
      submitted: wos.filter(w => ['submitted','completed','received','validated','ingested'].includes(w.status)).length,
      failed:    wos.filter(w => w.status === 'failed').length,
      deferred:  wos.filter(w => w.status === 'deferred').length,
    };

    $('#submit-body').innerHTML = `
      <div class="progress-head">
        <b>Day ${state.currentDay} of ${totalDays}</b>
        <span class="count">${today.length} work orders · ${today.reduce((s,w) => s+w.identifier_count, 0).toLocaleString()} identifiers</span>
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
        <div class="section-head">Day ${state.currentDay} work orders</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Local ID</th><th>Status</th><th>Identities</th><th>Adobe Work Order ID</th></tr></thead>
          <tbody>${today.map(w => `
            <tr>
              <td class="mono">${w.id.slice(0, 8)}…</td>
              <td><span class="pill ${w.status}">${w.status}</span></td>
              <td class="num">${w.identifier_count.toLocaleString()}</td>
              <td class="mono" style="color: var(--g600)">${w.adobe_workorder_id ? w.adobe_workorder_id.slice(0, 28) + '…' : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    // Day is "done" only when no work order is still planned OR deferred.
    // Deferred orders are quota-blocked but NOT shipped — re-submitting after
    // UTC midnight (daily) or month rollover (monthly) is the documented path,
    // so the button must keep saying "Submit Day N" while any deferred remain.
    const dayHasPending = today.some(w => ['planned', 'deferred'].includes(w.status));
    $('#btn-submit-day').textContent = state.currentDay < totalDays && !dayHasPending
      ? `Advance to Day ${state.currentDay + 1}` : `Submit Day ${state.currentDay}`;
    if (stats.deferred > 0) {
      $('#btn-submit-day').title =
        `${stats.deferred} order(s) deferred (quota). Click again after UTC quota rollover to retry.`;
    } else {
      $('#btn-submit-day').removeAttribute('title');
    }

    const anySubmitted = wos.some(w => w.adobe_workorder_id);
    $('#btn-goto-monitor').hidden = !anySubmitted;
  };

  const refresh = async () => {
    const [wos, detail] = await Promise.all([
      http('GET', `/jobs/${state.job.id}/work-orders`),
      http('GET', `/jobs/${state.job.id}`),
    ]);

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

  $('#btn-submit-day').addEventListener('click', async () => {
    const today = state.workOrders.filter(w => w.day_index === state.currentDay);
    if (today.every(w => !['planned', 'deferred'].includes(w.status))) {
      if (state.currentDay < totalDays) state.currentDay++;
      await refresh();
      return;
    }

    // Phase 2: pre-submit confirmation modal with current org quota.
    // The submit endpoint will also re-fetch quota on the server before
    // shipping, so the modal numbers + the server's decision use the same
    // source of truth.
    const wosToSubmit = today.filter(w => ['planned', 'deferred'].includes(w.status));
    const monthLabel = `Month ${wosToSubmit[0]?.month_index ?? 1}`;
    const dayLabel   = `Day ${state.currentDay}`;
    const ok = await showSubmitModal({
      wosToSubmit,
      monthLabel, dayLabel,
      quota: state.orgQuota,   // last known; server will refresh independently
    });
    if (!ok) {
      logActivity('info', `Submission for ${dayLabel} cancelled`);
      return;
    }

    logActivity('info', `Starting submission for ${dayLabel} of ${monthLabel}…`);
    try {
      await http('POST', `/jobs/${state.job.id}/submit`, {
        dayIndex:   state.currentDay,
        monthIndex: wosToSubmit[0]?.month_index ?? null,
      });
      logActivity('info', 'Submission started server-side');
    } catch (err) {
      logActivity('error', 'Submission request failed: ' + err.message);
    }
  });
  $('#btn-goto-monitor').addEventListener('click', () => goto('monitor'));

  // Auto-resume scheduler panel (Phase 3). Loads current settings, lets
  // the operator toggle/edit, and shows "next run" + last-run summary.
  void initAutoResumePanel();

  if (submitPollTimer) clearInterval(submitPollTimer);
  submitPollTimer = setInterval(refresh, 2000);
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

  const fetchAndRenderList = async () => {
    let payload = { rows: [], totals: { in_flight: 0, has_failed: 0, all_completed: 0, total: 0 }, sandboxes: [] };
    try {
      const params = new URLSearchParams({ limit: String(MONITOR_LIST_LIMIT) });
      if (searchTerm)    params.set('search', searchTerm);
      if (sandboxFilter) params.set('sandbox', sandboxFilter);
      payload = await http('GET', `/jobs/monitor?${params.toString()}`);
    } catch { /* treated as empty */ }
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
  // without manual refresh. Detail panel polls more often via the same loop.
  state.pollTimer = setInterval(async () => {
    await fetchAndRenderList();
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

  // The displayName + description we sent at submission time. We don't store
  // them separately, so rebuild from job + WO — kept in sync with the values
  // in runner/submission.js. AEP's detail page surfaces these prominently.
  const jobShortId = (job?.id || '').slice(0, 8);
  const woShortId  = w.id.slice(0, 8);
  const displayName = `Delete ${job?.name || jobShortId} - WO ${woShortId}`;
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

  goto('config');

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
      at <b>00:00 GMT on the 1st</b>. Phase 3 (auto-resume) is not yet
      available — for now you'll click Submit at the start of each month.
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
async function showSubmitModal({ wosToSubmit, monthLabel, dayLabel, quota }) {
  const ids = wosToSubmit.reduce((s, w) => s + w.identifier_count, 0);
  const dRem = quota?.daily?.remaining;
  const mRem = quota?.monthly?.remaining;
  const dCap = quota?.daily?.quota;
  const mCap = quota?.monthly?.quota;

  const overDaily   = dRem != null && ids > dRem;
  const overMonthly = mRem != null && ids > mRem;
  const willPartial = overDaily || overMonthly;

  const fmt = (n) => n == null ? '—' : Number(n).toLocaleString();

  const bodyHtml = `
    <p>About to submit <b>${wosToSubmit.length} work order${wosToSubmit.length === 1 ? '' : 's'}</b>
       (<b>${ids.toLocaleString()} identifiers</b>) for <b>${escape(monthLabel)}</b> · <b>${escape(dayLabel)}</b>.</p>

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
