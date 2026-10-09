/*
 * Job state helpers for the UI (2026-10-06): the progress stepper, the mode
 * badges and the plan-scope estimates. Pure functions, no DOM: loaded as a
 * classic script after buckets.js and before app.js (window.AepJobView), and
 * evaluated in node by test/webJobView.test.js.
 *
 * Step keys match the nav's data-step keys so a step can be clicked to go to
 * its tab. States: done | current | todo | locked | na | failed. At most one
 * step is "current": the first to-do step after the last finished one, so an
 * optional step the operator skipped (the analysis) stays "todo" without
 * stealing the highlight from the real next action.
 */
(function (root) {
  'use strict';

  var B = root.AepBuckets;
  var EXPANDED = ['expanded', 'ready', 'submitting', 'submitted', 'partial'];   // = server PLANNABLE_JOB_STATUSES
  var NEVER_SENT = ['planned', 'deferred', 'awaiting_approval'];
  var FINISHED = ['completed', 'failed'];

  function has(list, v) { return list.indexOf(v) !== -1; }
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function isOff(job) { return job.expansion_mode === 'none'; }
  function isPlanned(job, wos) { return (wos && wos.length > 0) || (job.planned_orders || 0) > 0; }

  /** Batches (month, day) in the plan, and how many have fully left the never-sent states. */
  function submitProgress(wos) {
    var buckets = B.listBuckets(wos || []);
    var shipped = buckets.filter(function (b) {
      return b.wos.every(function (w) { return !has(NEVER_SENT, w.status); });
    }).length;
    return { shippedBatches: shipped, totalBatches: buckets.length };
  }

  function steps(job, opts) {
    opts = opts || {};
    var wos = opts.wos || [];
    var analysis = opts.analysis || null;
    var off = isOff(job);
    var expanded = has(EXPANDED, job.status);
    var expFailed = job.status === 'failed';
    var planned = isPlanned(job, wos);
    var out = [];
    function add(key, label, state, hint, running) {
      out.push({ key: key, label: label, state: state, hint: hint || '', running: !!running });
    }
    var afterExpansion = expFailed ? 'Resume the expansion first' : 'Available after expansion';

    add('upload', 'Upload', 'done', fmt(job.total_source_ids) + ' IDs uploaded');

    if (job.status === 'expanding') add('expand', 'Expand', 'todo', off ? 'Storing the uploaded IDs…' : 'Expanding through the Identity Graph…', true);
    else if (expFailed) add('expand', 'Expand', 'failed', 'Expansion failed — resume it on the Expansion tab');
    else add('expand', 'Expand', 'done', off ? 'Identity Graph off — uploaded IDs only'
      : fmt(job.found_count) + ' identities found' + (job.no_reply_count > 0 ? ' · ' + fmt(job.no_reply_count) + ' no reply from AEP' : ''));

    var aStatus = analysis && analysis.status;
    if (off) add('analysis', 'Analyse', 'na', 'Not available — expansion was off');
    else if (!expanded) add('analysis', 'Analyse', 'locked', afterExpansion);
    else if (aStatus === 'building') {
      var total = analysis.sourcesTotal || 0;
      var pct = total > 0 ? Math.min(100, Math.floor(100 * (analysis.sourcesDone || 0) / total)) : 0;
      add('analysis', 'Analyse', 'todo', 'Building the report… ' + pct + '%', true);
    }
    else if (aStatus === 'ready') add('analysis', 'Analyse', 'done', 'Shared-cluster report ready');
    else if (aStatus === 'failed') add('analysis', 'Analyse', 'failed', 'Build failed — rebuild it on the Analysis tab');
    else add('analysis', 'Analyse', 'todo', 'Optional: review IDs that share a cluster');

    if (!expanded) add('plan', 'Plan', 'locked', afterExpansion);
    else if (planned) {
      var scope = job.delete_scope === 'source_only' ? 'uploaded IDs only' : 'uploaded IDs + linked identities';
      add('plan', 'Plan', 'done', fmt(wos.length || job.planned_orders) + ' work orders — ' + scope);
    }
    else add('plan', 'Plan', 'todo', 'Choose what to delete and build the batches');

    var prog = submitProgress(wos);
    if (!planned) add('submit', 'Submit', 'locked', 'Available after planning');
    else if (prog.totalBatches > 0 && prog.shippedBatches === prog.totalBatches) {
      add('submit', 'Submit (' + prog.shippedBatches + '/' + prog.totalBatches + ')', 'done', 'Every batch has been sent');
    }
    else if (prog.totalBatches > 0) {
      add('submit', 'Submit (' + prog.shippedBatches + '/' + prog.totalBatches + ')', 'todo',
        (prog.totalBatches - prog.shippedBatches) + ' batch(es) still to send');
    }
    else add('submit', 'Submit', 'todo', 'Send the planned batches');

    var sentAny = wos.some(function (w) { return !has(NEVER_SENT, w.status); });
    var allFinished = wos.length > 0 && wos.every(function (w) { return has(FINISHED, w.status); });
    if (!sentAny) add('monitor', 'Monitor', 'locked', 'Available after the first submit');
    else if (allFinished) add('monitor', 'Monitor', 'done', 'Every work order has finished');
    else add('monitor', 'Monitor', 'todo', 'Track Adobe processing');

    var lastDone = -1;
    out.forEach(function (s, i) { if (s.state === 'done') lastDone = i; });
    for (var i = lastDone + 1; i < out.length; i++) {
      if (out[i].state === 'todo') { out[i].state = 'current'; break; }
    }
    return out;
  }

  /** Header badges: how identities were gathered, and what the plan deletes. */
  function badges(job) {
    var off = isOff(job);
    var planned = (job.planned_orders || 0) > 0 || has(['ready', 'submitting', 'submitted', 'partial'], job.status);
    var scope;
    if (job.delete_scope === 'source_only') {
      scope = { key: 'scope', label: 'Scope: Uploaded IDs only', tone: off ? 'off' : 'warn' };
    } else if (job.delete_scope === 'cluster' || planned) {
      // NULL on a planned job = planned before scopes existed, i.e. clusters.
      scope = { key: 'scope', label: 'Scope: Linked identities', tone: 'on' };
    } else {
      scope = { key: 'scope', label: 'Scope: Not planned', tone: 'neutral' };
    }
    return [
      off ? { key: 'expansion', label: 'Expansion: Off', tone: 'off' } : { key: 'expansion', label: 'Expansion: On', tone: 'on' },
      scope,
    ];
  }

  /**
   * Rough size of each plan scope for the Plan tab's choice cards. Identities
   * come from the analysis summary when ready (distinct across the job), else
   * from the job counters. Work orders ≈ identities / maxPerOrder (the planner
   * keeps each uploaded ID's identities together, so it can be slightly more).
   */
  function scopeEstimates(job, summary, maxPerOrder) {
    var max = maxPerOrder > 0 ? maxPerOrder : 100000;
    function est(count) {
      var c = Number(count) || 0;
      return { identities: c, workOrders: c > 0 ? Math.ceil(c / max) : 0 };
    }
    var off = isOff(job);
    var sources = summary && summary.sources != null ? summary.sources
      : ((off ? job.found_count : job.processed_count) || job.total_source_ids || 0);
    var linked = summary && summary.identities != null ? summary.identities : (job.found_count || 0);
    return { cluster: off ? null : est(linked), sourceOnly: est(sources) };
  }

  /** The Excel-report button for a report state (GET /analysis → report). */
  function excelReportView(report) {
    var r = report || {};
    function size(b) {
      if (!(b > 0)) return '';
      return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    }
    if (r.status === 'building') {
      var pct = r.rowsTotal > 0 ? Math.min(100, Math.floor(100 * (r.rowsDone || 0) / r.rowsTotal)) : 0;
      return { state: 'building', label: 'Building… ' + pct + '%', pct: pct, size: '', error: '', action: null };
    }
    if (r.status === 'ready') return { state: 'ready', label: '⤓ Download Excel report', pct: 100, size: size(r.bytes), error: '', action: 'download' };
    if (r.status === 'failed') return { state: 'failed', label: 'Try again', pct: 0, size: '', error: r.error || 'The build failed.', action: 'build' };
    return { state: 'none', label: 'Build Excel report', pct: 0, size: '', error: '', action: 'build' };
  }

  /** The Expansion tab's Export CSV button for an export state (GET /jobs/:id → export; 2026-10-09). */
  function identityExportView(exp) {
    var e = exp || {};
    function size(b) {
      if (!(b > 0)) return '';
      return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
    }
    if (e.status === 'building') {
      if (e.phase === 'writing' && e.rowsTotal > 0) {
        var pct = Math.min(100, Math.floor(100 * (e.rowsDone || 0) / e.rowsTotal));
        return { state: 'building', label: 'Writing CSV… ' + pct + '%', pct: pct,
          detail: fmt(e.rowsDone) + ' of ' + fmt(e.rowsTotal) + ' identities', action: null };
      }
      return { state: 'building', label: 'Preparing CSV…', pct: 0,
        detail: (e.rowsTotal > 0 ? 'Sorting ' + fmt(e.rowsTotal) + ' identities' : 'Sorting the identities') + ' — you can keep working',
        action: null };
    }
    if (e.status === 'ready') {
      return { state: 'ready', label: '⤓ Download CSV', pct: 100,
        detail: [size(e.bytes), e.rowsTotal > 0 ? fmt(e.rowsTotal) + ' identities' : ''].filter(Boolean).join(' · '), action: 'download' };
    }
    if (e.status === 'failed') {
      return { state: 'failed', label: 'Export CSV', pct: 0, detail: 'The last export failed: ' + (e.error || 'unknown error'), action: 'build' };
    }
    return { state: 'none', label: 'Export CSV', pct: 0, detail: '', action: 'build' };
  }

  root.AepJobView = {
    identityExportView: identityExportView,
    steps: steps,
    badges: badges,
    scopeEstimates: scopeEstimates,
    submitProgress: submitProgress,
    excelReportView: excelReportView,
  };
})(typeof window !== 'undefined' ? window : globalThis);
