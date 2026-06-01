/**
 * READ-ONLY incident inspector. Does NOT modify the DB, run migrations, or
 * contact Adobe. ASCII-only so it saves cleanly on Windows. Run from inside the
 * app folder (so it can resolve better-sqlite3 from node_modules):
 *
 *   node diagnose-job.mjs "C:\path\to\data\state.db"
 *   node diagnose-job.mjs /path/to/data/state.db
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node diagnose-job.mjs <path-to-state.db>');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
const colsOf = (t) => tables.has(t) ? new Set(db.prepare("PRAGMA table_info(" + t + ")").all().map(c => c.name)) : new Set();
const woCols = colsOf('work_orders');
const jobCols = colsOf('jobs');
const m = woCols.has('month_index') ? 'COALESCE(month_index,1)' : '1';
const bar = '='.repeat(72);
const head = (t) => console.log('\n' + bar + '\n' + t + '\n' + bar);

console.log('DB:', dbPath);

head('JOBS');
const jobSel = ['id','name','status','sandbox_name','source_namespace','daily_limit','monthly_limit','total_source_ids','created_at'].filter(c => jobCols.has(c));
for (const j of db.prepare('SELECT ' + jobSel.join(',') + ' FROM jobs ORDER BY created_at DESC').all()) {
  console.log('  id=' + j.id);
  console.log('     name="' + j.name + '"  status=' + j.status + '  sandbox=' + (j.sandbox_name || '?') + '  ns=' + (j.source_namespace || '?'));
  console.log('     totalSourceIds=' + (j.total_source_ids != null ? j.total_source_ids : '?') + '  daily_limit=' + (j.daily_limit != null ? j.daily_limit : '?') + '  monthly_limit=' + (j.monthly_limit != null ? j.monthly_limit : '?') + '  created=' + j.created_at);
}

head('WORK ORDERS by (month, day, status)   shipped = has an Adobe work-order id');
for (const r of db.prepare('SELECT job_id, ' + m + ' AS mo, day_index AS dy, status, COUNT(*) AS wos, SUM(identifier_count) AS ids, SUM(CASE WHEN adobe_workorder_id IS NOT NULL THEN 1 ELSE 0 END) AS shipped FROM work_orders GROUP BY job_id, mo, dy, status ORDER BY job_id, mo, dy, status').all()) {
  console.log('  job=' + String(r.job_id).slice(0,8) + '  month=' + r.mo + ' day=' + String(r.dy).padStart(2) + '  ' + String(r.status).padEnd(12) + '  WOs=' + String(r.wos).padStart(4) + '  identities=' + String(r.ids).padStart(9) + '  shipped=' + r.shipped);
}

head('TOTALS by status');
for (const r of db.prepare('SELECT status, COUNT(*) AS wos, SUM(identifier_count) AS ids, SUM(CASE WHEN adobe_workorder_id IS NOT NULL THEN 1 ELSE 0 END) AS shipped FROM work_orders GROUP BY status ORDER BY status').all()) {
  console.log('  ' + String(r.status).padEnd(12) + '  WOs=' + String(r.wos).padStart(4) + '  identities=' + String(r.ids).padStart(9) + '  shipped=' + r.shipped);
}

if (tables.has('expanded_identities')) {
  head('EXPANDED IDENTITIES (discovered via Identity Graph)');
  for (const r of db.prepare('SELECT job_id, COUNT(*) AS rowcount, COUNT(DISTINCT source_id) AS sources FROM expanded_identities GROUP BY job_id').all()) {
    console.log('  job=' + String(r.job_id).slice(0,8) + '  identity_rows=' + r.rowcount + '  distinct_source_ids=' + r.sources);
  }
}

for (const t of ['quota_usage','quota_usage_monthly']) {
  if (tables.has(t)) {
    head(t + ' (local quota ledger)');
    for (const r of db.prepare('SELECT * FROM ' + t).all()) console.log('  ', JSON.stringify(r));
  }
}

if (tables.has('quota_reservations')) {
  head('quota_reservations');
  const acc = colsOf('quota_reservations').has('accepted') ? ', accepted' : '';
  for (const r of db.prepare('SELECT ims_org_id, utc_date, utc_year_month, active' + acc + ', COUNT(*) AS rowcount, SUM(count) AS ids FROM quota_reservations GROUP BY ims_org_id, utc_date, utc_year_month, active' + acc).all()) {
    console.log('  ', JSON.stringify(r));
  }
}

const samp = db.prepare('SELECT adobe_workorder_id, status, adobe_status, ' + m + ' AS mo, day_index AS dy FROM work_orders WHERE adobe_workorder_id IS NOT NULL ORDER BY rowid LIMIT 8').all();
if (samp.length) {
  head('SAMPLE shipped work orders (cross-check these in Adobe Data Lifecycle UI)');
  for (const s of samp) console.log('  ' + s.adobe_workorder_id + '  (local ' + s.status + '/' + s.adobe_status + ', month ' + s.mo + ' day ' + s.dy + ')');
}

const errs = db.prepare('SELECT DISTINCT last_error FROM work_orders WHERE adobe_workorder_id IS NULL AND last_error IS NOT NULL LIMIT 10').all();
if (errs.length) {
  head('last_error on non-shipped work orders (why a submit may have stalled)');
  for (const r of errs) console.log('  - ' + r.last_error);
}

db.close();
console.log('\n(read-only - nothing was modified)');
