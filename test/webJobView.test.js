/**
 * UI state helpers (2026-10-06): the job progress stepper, the mode badges and
 * the plan-scope estimates. Pure functions in src/web/jobview.js (a classic
 * script loaded after buckets.js, before app.js), evaluated here in a sandbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../src/web/buckets.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(new URL('../src/web/jobview.js', import.meta.url), 'utf8'), ctx);
const V = ctx.AepJobView;
const plain = (v) => JSON.parse(JSON.stringify(v));
const states = (steps) => plain(steps).map(s => `${s.key}:${s.state}`).join(' ');
const byKey = (steps) => Object.fromEntries(plain(steps).map(s => [s.key, s]));

const job = (over = {}) => ({ id: 'j', status: 'expanded', expansion_mode: 'cluster', delete_scope: null,
  planned_orders: 0, processed_count: 100, total_source_ids: 100, found_count: 450, ...over });
let n = 0;
const wo = (month, day, status, extra = {}) =>
  ({ id: `w${++n}`, month_index: month, day_index: day, status, identifier_count: 100_000, ...extra });

test('expanding job: expansion is current, later steps are locked with a reason', () => {
  const s = V.steps(job({ status: 'expanding' }));
  assert.equal(states(s), 'upload:done expand:current analysis:locked plan:locked submit:locked monitor:locked');
  assert.match(byKey(s).analysis.hint, /after expansion/i);
  assert.match(byKey(s).plan.hint, /after expansion/i);
});

test('failed expansion: marked failed; planning says to resume the expansion; nothing is current', () => {
  const s = V.steps(job({ status: 'failed' }));
  assert.equal(states(s), 'upload:done expand:failed analysis:locked plan:locked submit:locked monitor:locked');
  assert.match(byKey(s).plan.hint, /resume the expansion/i);
});

test('expanded cluster job: the analysis is next; building, ready and failed builds', () => {
  assert.equal(states(V.steps(job())), 'upload:done expand:done analysis:current plan:todo submit:locked monitor:locked');
  const building = byKey(V.steps(job(), { analysis: { status: 'building', sourcesDone: 40, sourcesTotal: 100 } }));
  assert.equal(building.analysis.state, 'current');
  assert.match(building.analysis.hint, /40%/);
  assert.equal(states(V.steps(job(), { analysis: { status: 'ready' } })),
    'upload:done expand:done analysis:done plan:current submit:locked monitor:locked');
  assert.equal(states(V.steps(job(), { analysis: { status: 'failed' } })),
    'upload:done expand:done analysis:failed plan:current submit:locked monitor:locked',
    'a failed analysis never blocks planning');
});

test('expansion-off job: no analysis step; planning is next', () => {
  const s = V.steps(job({ expansion_mode: 'none' }));
  assert.equal(states(s), 'upload:done expand:done analysis:na plan:current submit:locked monitor:locked');
  assert.match(byKey(s).analysis.hint, /expansion was off/i);
});

test('planned, 1 of 3 batches sent: submit is current and counts batches; a skipped analysis stays todo', () => {
  const wos = [wo(1, 1, 'submitted', { adobe_workorder_id: 'DI-1' }), wo(1, 2, 'planned'), wo(2, 1, 'deferred')];
  const s = V.steps(job({ status: 'submitting', planned_orders: 3 }), { wos });
  assert.equal(states(s), 'upload:done expand:done analysis:todo plan:done submit:current monitor:todo');
  assert.equal(byKey(s).submit.label, 'Submit (1/3)');
  assert.deepEqual(plain(V.submitProgress(wos)), { shippedBatches: 1, totalBatches: 3 });
});

test('a batch with an order awaiting approval is not sent yet', () => {
  const wos = [wo(1, 1, 'completed'), wo(1, 1, 'awaiting_approval')];
  assert.deepEqual(plain(V.submitProgress(wos)), { shippedBatches: 0, totalBatches: 1 });
});

test('everything sent: monitor is current until every order is finished', () => {
  const sent = [wo(1, 1, 'completed'), wo(1, 2, 'received', { adobe_workorder_id: 'DI-2' })];
  assert.equal(states(V.steps(job({ status: 'submitted', planned_orders: 2 }), { wos: sent, analysis: { status: 'ready' } })),
    'upload:done expand:done analysis:done plan:done submit:done monitor:current');
  const done = [wo(1, 1, 'completed'), wo(1, 2, 'failed', { adobe_workorder_id: 'DI-3' })];
  assert.equal(states(V.steps(job({ status: 'submitted', planned_orders: 2 }), { wos: done, analysis: { status: 'ready' } })),
    'upload:done expand:done analysis:done plan:done submit:done monitor:done');
});

const badges = (j) => plain(V.badges(j)).map(b => `${b.key}=${b.label}/${b.tone}`).join(' | ');

test('badges show the expansion mode and what the plan deletes', () => {
  assert.equal(badges(job()), 'expansion=Expansion: On/on | scope=Scope: Not planned/neutral');
  assert.equal(badges(job({ status: 'ready', planned_orders: 4, delete_scope: 'cluster' })),
    'expansion=Expansion: On/on | scope=Scope: Linked identities/on');
  assert.equal(badges(job({ status: 'ready', planned_orders: 4, delete_scope: 'source_only' })),
    'expansion=Expansion: On/on | scope=Scope: Uploaded IDs only/warn',
    'IDs-only on an expanded job leaves linked identities alive — highlighted');
  assert.equal(badges(job({ expansion_mode: 'none', status: 'ready', planned_orders: 1, delete_scope: 'source_only' })),
    'expansion=Expansion: Off/off | scope=Scope: Uploaded IDs only/off');
  assert.equal(badges(job({ status: 'submitted', planned_orders: 9, delete_scope: null })),
    'expansion=Expansion: On/on | scope=Scope: Linked identities/on', 'jobs planned before scopes existed deleted clusters');
});

test('scope estimates: from the analysis summary when ready, else from the job counters', () => {
  assert.deepEqual(plain(V.scopeEstimates(job(), { sources: 5, identities: 10 }, 4)),
    { cluster: { identities: 10, workOrders: 3 }, sourceOnly: { identities: 5, workOrders: 2 } });
  assert.deepEqual(plain(V.scopeEstimates(job(), null, 100)),
    { cluster: { identities: 450, workOrders: 5 }, sourceOnly: { identities: 100, workOrders: 1 } });
  assert.deepEqual(plain(V.scopeEstimates(job({ expansion_mode: 'none', found_count: 98 }), null, 100)),
    { cluster: null, sourceOnly: { identities: 98, workOrders: 1 } }, 'IDs-only job: distinct uploaded IDs');
  assert.deepEqual(plain(V.scopeEstimates(job({ found_count: 0, processed_count: 0, total_source_ids: 0 }), null, 100)),
    { cluster: { identities: 0, workOrders: 0 }, sourceOnly: { identities: 0, workOrders: 0 } });
});

test('excelReportView: the Excel button for every report state', () => {
  assert.deepEqual(plain(V.excelReportView(null)), { state: 'none', label: 'Build Excel report', pct: 0, size: '', error: '', action: 'build' });
  assert.deepEqual(plain(V.excelReportView({ status: 'building', rowsDone: 405112, rowsTotal: 894724 })),
    { state: 'building', label: 'Building… 45%', pct: 45, size: '', error: '', action: null });
  assert.deepEqual(plain(V.excelReportView({ status: 'ready', bytes: 93323264 })),
    { state: 'ready', label: '⤓ Download Excel report', pct: 100, size: '89.0 MB', error: '', action: 'download' });
  assert.deepEqual(plain(V.excelReportView({ status: 'ready', bytes: 524288 })).size, '512 KB');
  assert.deepEqual(plain(V.excelReportView({ status: 'failed', error: 'disk full' })),
    { state: 'failed', label: 'Try again', pct: 0, size: '', error: 'disk full', action: 'build' });
  assert.equal(V.excelReportView({ status: 'building', rowsDone: 0, rowsTotal: 0 }).pct, 0);
});

test('the Expand step mentions IDs with no reply from AEP', () => {
  assert.equal(byKey(V.steps(job({ found_count: 450, no_reply_count: 3 }))).expand.hint, '450 identities found · 3 no reply from AEP');
  assert.equal(byKey(V.steps(job({ found_count: 450 }))).expand.hint, '450 identities found');
});

test('identityExportView: the Export CSV button for every export state (2026-10-09)', () => {
  assert.deepEqual(plain(V.identityExportView(null)),
    { state: 'none', label: 'Export CSV', pct: 0, detail: '', action: 'build' });
  assert.deepEqual(plain(V.identityExportView({ status: 'building', phase: 'sorting', rowsDone: 0, rowsTotal: 23335220 })),
    { state: 'building', label: 'Preparing CSV…', pct: 0, detail: 'Sorting 23,335,220 identities — you can keep working', action: null });
  assert.deepEqual(plain(V.identityExportView({ status: 'building', phase: 'writing', rowsDone: 11667610, rowsTotal: 23335220 })),
    { state: 'building', label: 'Writing CSV… 50%', pct: 50, detail: '11,667,610 of 23,335,220 identities', action: null });
  assert.deepEqual(plain(V.identityExportView({ status: 'ready', bytes: 540016640, rowsTotal: 4000000 })),
    { state: 'ready', label: '⤓ Download CSV', pct: 100, detail: '515.0 MB · 4,000,000 identities', action: 'download' });
  assert.deepEqual(plain(V.identityExportView({ status: 'failed', error: 'disk full' })),
    { state: 'failed', label: 'Export CSV', pct: 0, detail: 'The last export failed: disk full', action: 'build' });
});
