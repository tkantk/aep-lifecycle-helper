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
  sandboxes: [],                 // loaded after Test Connection
  datasets: [],                  // loaded after sandbox pick
  namespaces: [],                // loaded after sandbox pick
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
  upload:  { title: 'Upload Source Identities',  sub: 'Upload a CSV containing hashedKocid values to be deleted.',         crumbs: ['Data Management', 'Source CSV Upload'],     render: renderUpload },
  expand:  { title: 'Identity Graph Expansion',  sub: 'Resolve all identities linked to each hashedKocid.',                crumbs: ['Identities', 'Identity Expansion'],         render: renderExpand },
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
  $('#c-sandbox-picker').addEventListener('change', onSandboxChange);
  $('#c-delete-mode').addEventListener('change', onDeleteModeChange);

  // Load existing credentials
  try {
    const list = await http('GET', '/config/credentials');
    if (list.length > 0) {
      $('#saved-creds-panel').hidden = false;
      $('#saved-creds-list').innerHTML = list.slice(0, 5).map(c => `
        <div class="saved-cred-item">
          <div>
            <div><b>${escape(c.label)}</b></div>
            <div class="cred-meta">${c.environment} · ${c.region} · ${c.client_id.slice(0,12)}…</div>
          </div>
          <button data-cred-id="${c.id}" class="use-cred">use</button>
        </div>`).join('');
      $$('.use-cred').forEach(b => b.addEventListener('click', () =>
        useCred(b.dataset.credId, list.find(x => x.id === b.dataset.credId))));
    }
  } catch (e) { /* db may not exist yet */ }

  // If we already tested this session, restore picker state
  if (state.tokenOk && state.credsId) {
    await loadSandboxes(false);
    if (state.config.sandboxName) {
      $('#c-sandbox-picker').value = state.config.sandboxName;
      await loadDatasets(false);
    }
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
  goto('config');
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
    }

    const res = await http('POST', '/config/credentials/test', { credsId: state.credsId });
    state.tokenOk = !!res.ok;

    if (res.ok) {
      showAlert('#cfg-alert', 'success', 'Connection verified',
        `Access token obtained. Loading sandboxes from Adobe…`);
      await loadSandboxes(true);
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

  el.innerHTML = sorted.map(n => {
    const label = `${n.code}${n.name && n.name !== n.code ? ` — ${n.name}` : ''}${n.custom ? '  [custom]' : ''}`;
    const selected = n.code === state.config.sourceNamespace ? 'selected' : '';
    return `<option value="${n.code}" data-nsid="${n.id}" ${selected}>${label}</option>`;
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
  // Creds are already persisted during testConnection(). Just move on.
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
    $('#plan-body').innerHTML = `<div class="alert error">
      <div><div class="alert-title">Planning failed</div>${escape(err.message)}</div></div>`;
  }
}

async function renderPlanResults(wos, container) {
  state.workOrders = wos;
  const target = container || $('#plan-body');
  // If we don't have a totals block yet (e.g. came in via existing-plan path),
  // synthesize plan summary from the work-order list.
  const planned = wos.length;
  const days = wos.reduce((m, w) => Math.max(m, w.day_index), 1);
  const submittedCount = wos.filter(w =>
    !['planned', 'deferred'].includes(w.status)
  ).length;
  state.plan = state.plan || { planned, days };

  const totalIds = wos.reduce((s, w) => s + w.identifier_count, 0);
  const replanDisabled = submittedCount > 0;

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
      <div class="stat">
        <div class="stat-label">Submission days</div>
        <div class="stat-value">${days}</div>
        <div class="stat-sub">@ ${state.config.dailyLimit.toLocaleString()}/day</div>
      </div>
    </div>

    <div class="section" style="margin-top: 24px; padding-top: 24px">
      <div class="section-head">Planned work orders</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Local ID</th><th>Day</th><th>Namespaces</th><th>Identities</th><th>Status</th></tr></thead>
        <tbody>${wos.map(w => `
          <tr>
            <td class="mono">${w.id.slice(0, 8)}…</td>
            <td><span class="day-chip">Day ${w.day_index}</span></td>
            <td>${w.namespaces.map(n => {
                const label = n.code || `nsid:${n.id}`;
                return `<span class="ns-badge ${nsClass(n.code)}">${escape(label)}</span>`;
              }).join(' ')}</td>
            <td class="num">${w.identifier_count.toLocaleString()}</td>
            <td><span class="pill ${w.status}">${w.status}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-top:16px; display:flex; gap:8px; align-items:center">
      <button class="btn btn-secondary" id="btn-replan" ${replanDisabled ? 'disabled title="Re-planning is blocked once any work order has been submitted to Adobe."' : ''}>
        ${replanDisabled ? 'Re-plan blocked (already submitted)' : '↻ Re-plan'}
      </button>
      <span style="font-size:11.5px; color:var(--g600)">
        ${replanDisabled ? 'A new plan would risk duplicate deletions.' : 'Rebuild the plan from current expanded identities.'}
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
    if (today.every(w => w.status !== 'planned')) {
      if (state.currentDay < totalDays) state.currentDay++;
      await refresh();
      return;
    }
    logActivity('info', `Starting submission for Day ${state.currentDay}…`);
    try {
      await http('POST', `/jobs/${state.job.id}/submit`, { dayIndex: state.currentDay });
      logActivity('info', 'Submission started server-side');
    } catch (err) {
      logActivity('error', 'Submission request failed: ' + err.message);
    }
  });
  $('#btn-goto-monitor').addEventListener('click', () => goto('monitor'));

  if (submitPollTimer) clearInterval(submitPollTimer);
  submitPollTimer = setInterval(refresh, 2000);
  state.pollTimer = submitPollTimer;
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

// ─── Monitor ──────────────────────────────────────────────────────────
const STAGES = ['received', 'validated', 'submitted', 'ingested', 'completed'];
async function renderMonitor() {
  // Step 1: load the recent-jobs list so an operator arriving after a restart
  // can pick up a prior job. Backend state.db persists across restarts —
  // /api/jobs is the authoritative source.
  let jobs = [];
  try { jobs = await http('GET', '/jobs?limit=20'); } catch { /* treated as empty */ }

  const picker = $('#monitor-job-picker');
  const pickerCard = $('#monitor-picker-card');
  const meta = $('#monitor-job-meta');
  const content = $('#monitor-content');
  const empty = $('#monitor-empty');

  if (jobs.length === 0 && !state.job) {
    content.hidden = true;
    pickerCard.hidden = true;
    empty.hidden = false;
    return;
  }

  pickerCard.hidden = false;
  empty.hidden = true;
  content.hidden = false;

  // If nothing is selected in-memory yet, fall back to the most recent job
  // so the Monitor tab is useful on its own after a fresh page load.
  if (!state.job && jobs.length > 0) {
    state.job = jobs[0];
  }

  // If the current state.job isn't in the list (e.g. older than limit=20),
  // prepend it so the selector still shows a matching option.
  const selectedId = state.job?.id;
  if (selectedId && !jobs.some(j => j.id === selectedId)) {
    jobs = [state.job, ...jobs];
  }

  picker.innerHTML = jobs.map(j => `
    <option value="${j.id}" ${j.id === selectedId ? 'selected' : ''}>
      ${escape(formatJobOption(j))}
    </option>`).join('');

  const renderMeta = (j) => {
    meta.innerHTML = `
      <span class="chip">Status: ${escape(j.status)}</span>
      <span class="chip">Sandbox: ${escape(j.sandbox_name)}</span>
      <span class="chip">${(j.total_source_ids || 0).toLocaleString()} source IDs</span>`;
  };
  renderMeta(state.job);

  const refresh = async () => {
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

    $('#monitor-table').innerHTML = withAdobe.length === 0
      ? '<div class="empty-state">No submitted work orders yet.</div>'
      : `<div class="table-wrap">
          <table>
            <thead><tr><th>Adobe ID</th><th>Identities</th><th>Pipeline</th><th>Updated</th></tr></thead>
            <tbody>${withAdobe.map(w => `
              <tr>
                <td class="mono">${w.adobe_workorder_id.slice(0, 24)}…</td>
                <td class="num">${w.identifier_count.toLocaleString()}</td>
                <td>${pipelineHtml(stageIdx(w.adobe_status))}</td>
                <td style="color: var(--g600); font-size: 11.5px">${w.updated_at}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
  };

  picker.addEventListener('change', async () => {
    const id = picker.value;
    // Fetch the full job detail so downstream tabs (plan/submit) have the
    // target_services + breakdown they'd otherwise get from an upload flow.
    try {
      const res = await http('GET', `/jobs/${id}`);
      state.job = res.job;
      state.workOrders = [];
    } catch {
      state.job = jobs.find(j => j.id === id) || null;
    }
    if (state.job) renderMeta(state.job);
    await refresh();
  });

  await refresh();
  state.pollTimer = setInterval(refresh, 5000);
}

function formatJobOption(j) {
  const when = (j.created_at || '').replace('T', ' ').slice(0, 16);
  const ids = (j.total_source_ids || 0).toLocaleString();
  return `${when} · ${j.name || j.id.slice(0, 8)} · ${j.sandbox_name} · ${ids} IDs · ${j.status}`;
}

function stageIdx(s) { const i = STAGES.indexOf(s); return i < 0 ? 0 : i; }
function stageColor(s) {
  return { received: 'var(--g500)', validated: 'var(--orange500)',
    submitted: 'var(--blue500)', ingested: 'var(--purple500)', completed: 'var(--green500)' }[s];
}
function pipelineHtml(current) {
  let html = '<div class="pipeline">';
  STAGES.forEach((s, i) => {
    const done = i <= current;
    html += `<div class="node ${i === current ? 'current' : done ? 'done' : ''}"></div>`;
    if (i < STAGES.length - 1) html += `<div class="link ${i < current ? 'done' : ''}"></div>`;
  });
  html += `<span class="pipeline-label">${STAGES[current]}</span></div>`;
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

bootstrap();
