import pLimit from 'p-limit';
import { expandBatchDetailed } from '../services/identityGraph.js';
import { listNamespaces, buildNamespaceIndex, canonicalizeNamespace } from '../services/namespaces.js';
import { snapshotAndResetRateLimitHits, snapshotAndResetTimeoutRetries } from '../services/adobeClient.js';
import { insertIdentitiesAndCount, clearNoReply, q } from '../db.js';
import { discardIdentityExport } from './identityExport.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { streamIds } from '../utils/csv.js';
import { decryptCreds } from '../utils/crypto.js';
import { queueAnalysisBuild } from './analysis.js';

/**
 * In-process identity expansion runner.
 *
 * Algorithm:
 *   1. Load the org's namespace registry once (~40-200 rows typically)
 *      and build a byCode/byId index for canonicalization.
 *   2. Stream the uploaded CSV; as each batch of 1000 source IDs fills up,
 *      fire an async expansion job through p-limit(N) workers.
 *   3. Each worker canonicalizes every returned identity to {code, id},
 *      inserts them into SQLite in a single transaction, and reports
 *      progress atomically.
 *
 * Throughput note: at config.identityConcurrency=10 this saturates at
 * ~10,000 source IDs/sec on a gigabit connection. The SQLite writer is
 * serialized (single writer in WAL mode) but keeps up at ~100k rows/sec.
 */

// Live progress map - read by the /progress route for a fast UI path
export const liveProgress = new Map();

export async function runExpansion({
  jobId, uploadPath, sourceNamespace, sourceNamespaceId,
  credsId, sandboxName, column = 0,
  // Optional: when resuming a crashed expansion, callers pass the Set of
  // source IDs already present in expanded_identities. CSV rows whose value
  // is in the set are skipped so we don't re-call the Identity Graph for
  // work already done.
  skipSourceIds = null,
}) {
  // The stored identities are about to change: an export built from them is
  // stale (2026-10-09). Stop a build and remove the file.
  discardIdentityExport(jobId);
  const creds = await decryptCreds(credsId);
  const job = q().getJob.get(jobId);
  const total = job.total_source_ids;
  // IDs-only job (2026-10-06): the operator chose to delete ONLY the uploaded
  // IDs, so the Identity Graph is never called. Everything else — registry
  // validation, waves, progress, resume, failure handling — is shared.
  const expansionOff = job.expansion_mode === 'none';
  // A resume continues the job's persisted (cumulative) counters, so the live
  // progress the UI polls reads e.g. "4.9M / 6.8M" — not "0 / 6.8M".
  const progress = skipSourceIds
    ? { processed: job.processed_count || 0, total, found: job.found_count || 0 }
    : { processed: 0, total, found: 0 };
  // What the expansion is doing (2026-10-09), shown on the Expansion tab:
  // 'resuming' while a Resume skips IDs already expanded (checked / skipped
  // rows), then 'expanding'; `waiting` = { inFlight, oldestMs } when no batch
  // has finished for EXPANSION_HEARTBEAT_MS.
  Object.assign(progress, { phase: skipSourceIds ? 'resuming' : 'expanding', checked: 0, skipped: 0, waiting: null });
  liveProgress.set(jobId, progress);

  q().updateJobStatus.run('expanding', null, jobId);

  // ─── Load namespace registry (once) ───────────────────────────────────
  // We need this so any identities the graph returns with only `nsid`
  // (common for custom namespaces) are canonicalized to { code, id } pairs.
  let namespaceIndex;
  try {
    const namespaces = await listNamespaces({ creds, sandboxName });
    namespaceIndex = buildNamespaceIndex(namespaces);
    logger.info({ jobId, nsCount: namespaces.length }, 'namespace registry loaded');

    // Also cache it on the sandbox_configs row for UI reuse
    q().upsertSandboxConfig.run({
      credsId, sandboxName,
      sandboxTitle: null, sandboxType: null, sandboxRegion: null,
      datasetsJson: null,
      namespacesJson: JSON.stringify(namespaces),
    });
  } catch (err) {
    // FAIL CLOSED (review finding #10). Without the registry we can't
    // canonicalize linked identities to {code,id}, and we can't resolve the
    // source namespace's nsid — the Identity Graph would very likely return
    // empty clusters and the operator would delete ONLY the source ids while
    // the linked email/phone/CRMID survive (the silent-partial-delete failure
    // mode, same family as I9). Abort rather than expand blind.
    logger.error({ jobId, err: err.message },
      'namespace registry load failed — aborting expansion (cannot canonicalize / resolve nsid)');
    q().updateJobStatus.run('failed', `namespace registry load failed: ${err.message}`, jobId);
    liveProgress.delete(jobId);
    throw err;
  }

  // Custom namespaces (like hashedKocid) often need the numeric nsid to resolve
  // clusters reliably. If the caller gave us a code but no nsid, look the nsid
  // up in the registry now — sending both `ns` and `nsid` on /clusters/members
  // avoids empty responses for ambiguous custom-namespace codes.
  // Defense-in-depth (review finding #8): normalize a non-finite/garbage nsid
  // to null so the registry-resolution path below fires and a NaN can never be
  // templated into the /clusters/members body. Catches a bad nsid from ANY
  // caller (recovery, tests, future code), not just the upload route.
  // Normalize a supplied nsid to a finite non-negative integer or null (review
  // #8): Number('abc')===NaN must never reach the wire.
  let resolvedNsid = Number.isInteger(sourceNamespaceId) && sourceNamespaceId >= 0
    ? sourceNamespaceId : null;

  // Validate the source namespace against the registry — FAIL CLOSED on any
  // ambiguity (reviews #5 + #8 + #10):
  //   (a) the code MUST exist in the org's registry (whether or not an nsid was
  //       supplied — previously this was only checked when no nsid was given,
  //       so a supplied nsid bypassed it, review #5);
  //   (b) if both a code and an nsid are present, they MUST match exactly;
  //   (c) when no nsid was supplied, resolve it from the registry.
  // Expanding against an unrecognized/mismatched namespace would return empty
  // clusters and delete only the source ids — a silent partial delete.
  const failClosed = (msg) => {
    logger.error({ jobId, sourceNamespace }, msg);
    q().updateJobStatus.run('failed', msg, jobId);
    liveProgress.delete(jobId);
    throw new Error(msg);
  };
  if (namespaceIndex && sourceNamespace) {
    const hit = namespaceIndex.byCode.get(sourceNamespace);
    if (!hit) {
      failClosed(`source namespace "${sourceNamespace}" not found in the sandbox's namespace registry`);
    }
    const rid = Number(hit.id);
    const regId = Number.isInteger(rid) && rid >= 0 ? rid : null;
    if (resolvedNsid == null) {
      resolvedNsid = regId;   // resolve from registry (may stay null if registry id is corrupt → code-only)
      logger.info({ jobId, sourceNamespace, resolvedNsid }, 'resolved source namespace nsid from registry');
    } else if (regId != null && regId !== resolvedNsid) {
      failClosed(
        `source namespace "${sourceNamespace}" maps to nsid ${hit.id} in the registry, but nsid ` +
        `${resolvedNsid} was supplied — refusing to expand against a mismatched code/nsid pair`);
    }
  }
  // Persist the registry-resolved nsid so an IDs-only plan can emit {code, id}
  // without scanning identities (never overwrites an operator-supplied value).
  if (resolvedNsid != null) q().setJobSourceNamespaceIdIfNull.run(resolvedNsid, jobId);
  // The validated source namespace as {code, id} — what an IDs-only job stores.
  const sourceNs = canonicalizeNamespace({ ns: sourceNamespace, nsid: resolvedNsid }, namespaceIndex);

  // ─── Pipeline: CSV stream → batch buffer → p-limit workers → SQLite ───
  //
  // Wave-based scheduling: instead of pushing all ~1500 batch tasks into
  // p-limit at once (which keeps every batch array + Adobe response in heap
  // until Promise.all resolves at the very end), we submit WAVE_SIZE tasks
  // at a time and await each wave before the CSV stream advances. This keeps
  // peak heap usage proportional to (concurrency × wave multiplier) rather
  // than the total number of batches, and lets GC reclaim completed batch
  // data continuously across the run. Critical for multi-million-ID jobs on
  // memory-constrained Windows laptops.
  const limit = pLimit(config.identityConcurrency);
  const WAVE_SIZE = config.identityConcurrency * 2; // 2× concurrency in-flight (10 at the default 5)
  let buffer = [];
  let wave   = [];
  let aborted = false;
  let skipped = 0;
  // The first batch to fail stops the run (final review #3, 2026-10-09): its
  // group's other lookups — and their retries, up to ~12 min with timeout
  // retries — are cancelled, and the job records THAT first error (drainWave
  // used to report whichever rejection came first in array order).
  const abortCtl = new AbortController();
  let firstError = null;
  const abortRun = () => { aborted = true; if (!abortCtl.signal.aborted) abortCtl.abort(); };

  // ─── Activity heartbeat (2026-10-09) ──────────────────────────────────
  // A batch waiting on Adobe used to log nothing until it returned — up to the
  // timeout, per attempt — so a slow Adobe looked like a dead app. Every
  // EXPANSION_HEARTBEAT_MS without a finished batch, say what we're waiting for
  // (log + Expansion tab). Cleared in the finally below.
  const inFlight = new Map();          // batch number → start time
  let batchNo = 0;
  let lastBatchAt = Date.now();
  // A tick that fires late means THIS process was paused — text selected in the
  // Windows console (QuickEdit), the laptop asleep, or a heavy page refresh
  // blocking the server. Say so: such a pause turns answers Adobe already sent
  // into "timeouts", and would otherwise be blamed on Adobe (final review #5).
  const PAUSE_REPORT_MS = Math.min(5000, config.expansionHeartbeatMs * 5);
  let lastTick = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const lateMs = now - lastTick - config.expansionHeartbeatMs;
    lastTick = now;
    if (lateMs >= PAUSE_REPORT_MS) {
      logger.warn({ jobId, pausedSec: Math.round(lateMs / 100) / 10 },
        'the app itself was paused — not waiting on Adobe');
    }
    if (inFlight.size === 0 || Date.now() - lastBatchAt < config.expansionHeartbeatMs) return;
    const oldestMs = Date.now() - Math.min(...inFlight.values());
    progress.waiting = { inFlight: inFlight.size, oldestMs };
    logger.info({ jobId, inFlight: inFlight.size, oldestSec: Math.round(oldestMs / 1000),
      processed: progress.processed, total }, 'still waiting on Adobe');
  }, config.expansionHeartbeatMs);
  heartbeat.unref?.();

  // ─── Per-batch timing instrumentation ─────────────────────────────────
  // Tracks rolling p50/p95 of `adobeMs` (Identity Graph round-trip) and
  // `sqliteMs` (insertIdentitiesAndCount) over a 50-batch window so we can
  // spot a slowdown the moment it starts. Every BATCHES_PER_SUMMARY
  // batches the runner emits an aggregate log line — a flat
  // sustained p95 means the bottleneck is environmental (Adobe rate
  // limit / network / cache exhaustion); a climbing p95 on `sqliteMs`
  // alone means the local cache is missing.
  const BATCHES_PER_SUMMARY = 50;
  const recent = { adobeMs: [], sqliteMs: [] };
  let batchesSinceSummary = 0;
  let totalAdobeMs = 0, totalSqliteMs = 0, totalBatches = 0;

  const pushSample = (arr, v) => { arr.push(v); if (arr.length > BATCHES_PER_SUMMARY) arr.shift(); };
  const pct = (arr, p) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };

  const submitBatch = (batch) => limit(async () => {
    if (aborted) return;
    const no = ++batchNo;
    inFlight.set(no, Date.now());
    try {
      const t0 = Date.now();
      // Row shape: [job_id, ns_code, ns_id, identity_id, source_id]
      let rows, linkedTotal, clustersReturned, noReply = [];
      if (expansionOff) {
        // IDs-only: the uploaded IDs themselves are the deletion targets, in the
        // validated source namespace. No Identity Graph call.
        rows = batch.map(id => [jobId, sourceNs.code, sourceNs.id ?? null, id, id]);
        linkedTotal = 0;
        clustersReturned = 0;
      } else {
        const ask = (ids) => expandBatchDetailed({
          creds, sandboxName,
          namespace: sourceNamespace,
          namespaceId: resolvedNsid,
          ids,
          namespaceIndex,
          signal: abortCtl.signal,
        });
        const first = await ask(batch);
        let results = first.results;
        // Adobe documents one reply entry per ID sent. IDs its reply left out —
        // cleanly: every entry it did return matched an ID sent — are asked about
        // ONCE more on their own; any still missing are recorded as "no reply from
        // AEP": never planned or deleted, listed for download. Failing the batch
        // instead stalled the job for good — Resume re-sends the same IDs first
        // (2026-10-08).
        if (first.missing.length) {
          const again = await ask(first.missing);
          results = results.concat(again.results);
          noReply = again.missing;
          logger.warn({ jobId, sent: batch.length, leftOut: first.missing.length, stillMissing: noReply.length },
            'Identity Graph reply left out uploaded IDs — asked again');
        }

        // Diagnostic: count total linked identities returned by Adobe for this batch.
        // If this is zero across every batch, either the namespace is wrong for this
        // sandbox or the IDs don't exist in any cluster.
        linkedTotal = results.reduce((n, r) => n + r.linkedIdentities.length, 0);
        clustersReturned = results.length;

        // Flatten to row tuples for bulk insert.
        // A tuple with both ns_code=null AND ns_id=null is skipped (can't dedup).
        rows = [];
        for (const r of results) {
          // Emit the source identity itself as a deletion target
          if (r.sourceNamespace.code || r.sourceNamespace.id != null) {
            rows.push([jobId, r.sourceNamespace.code, r.sourceNamespace.id ?? null, r.sourceId, r.sourceId]);
          }
          for (const li of r.linkedIdentities) {
            if (!li.namespace.code && li.namespace.id == null) continue;
            rows.push([jobId, li.namespace.code, li.namespace.id ?? null, li.id, r.sourceId]);
          }
        }
      }
      const adobeMs = Date.now() - t0;

      const t1 = Date.now();
      // Rows + counters in ONE transaction so a crash can't leave committed
      // rows with a stale graph_members_seen (which a resume would then skip,
      // bypassing the empty-graph guard) — review #1.
      const inserted = insertIdentitiesAndCount(rows, batch.length, linkedTotal, jobId, noReply);
      const sqliteMs = Date.now() - t1;

      progress.processed += batch.length;
      progress.found += inserted;

      // Per-batch line: keep it terse so the log doesn't drown the run.
      logger.info({
        jobId, batchSize: batch.length, clustersReturned, linkedTotal, expansionOff,
        adobeMs, sqliteMs,
      }, 'identity graph batch returned');

      pushSample(recent.adobeMs, adobeMs);
      pushSample(recent.sqliteMs, sqliteMs);
      totalAdobeMs += adobeMs;
      totalSqliteMs += sqliteMs;
      totalBatches++;
      batchesSinceSummary++;
      if (batchesSinceSummary >= BATCHES_PER_SUMMARY) {
        batchesSinceSummary = 0;
        const pctDone = total ? Math.round(progress.processed / total * 100) : 0;
        // Snapshot the 429 counter across this window. Non-zero means Adobe
        // throttled us — the climbing adobeMs you'll see is the client
        // sleeping on Retry-After, not Adobe being slow. Fix: lower
        // IDENTITY_CONCURRENCY (5 is the conservative default; raise only if 0 429s).
        const rateLimitHits = snapshotAndResetRateLimitHits();
        const timeoutRetries = snapshotAndResetTimeoutRetries();
        logger.info({
          jobId,
          progress: `${progress.processed.toLocaleString()}/${total.toLocaleString()} (${pctDone}%)`,
          batchesDone: totalBatches,
          adobeMs_p50: pct(recent.adobeMs, 0.50),
          adobeMs_p95: pct(recent.adobeMs, 0.95),
          adobeMs_avgAll: Math.round(totalAdobeMs / totalBatches),
          sqliteMs_p50: pct(recent.sqliteMs, 0.50),
          sqliteMs_p95: pct(recent.sqliteMs, 0.95),
          sqliteMs_avgAll: Math.round(totalSqliteMs / totalBatches),
          rateLimitHits,   // # of HTTP 429s Adobe sent in this 50-batch window
          timeoutRetries,  // # of lookups retried because Adobe didn't answer in time
          rateLimitHint: rateLimitHits > 0
            ? 'Adobe is throttling — reduce IDENTITY_CONCURRENCY in .env'
            : undefined,
        }, `── expansion summary @ ${pctDone}% ──`);
      }
    } catch (err) {
      // A cancelled lookup is a consequence of an earlier failure, not news.
      const cancelled = abortCtl.signal.aborted && (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError');
      if (!cancelled) {
        if (!firstError) firstError = err;
        logger.error({ jobId, batchSize: batch.length, err: err.message }, 'expansion batch failed');
      }
      abortRun();
      throw err;
    } finally {
      inFlight.delete(no);
      lastBatchAt = Date.now();
      progress.waiting = null;
    }
  });

  // Drain the current wave: await all in-flight tasks, then clear so GC can
  // reclaim the batch arrays and Adobe response objects from completed tasks.
  //
  // CRITICAL: use Promise.allSettled, NOT Promise.all. A network event like
  // ECONNRESET (which happens when Adobe's load balancer kills a stalled
  // keep-alive socket pool — e.g., after multiple 60s Retry-After waits)
  // takes down ALL in-flight requests sharing that socket pool at once.
  // Promise.all would propagate the first rejection and leave the OTHER
  // (N - 1) rejected promises dangling — Node ≥ v17 promotes those to
  // uncaughtException and the whole process crashes (real production
  // crash at 96% on 2026-05-29 from exactly this failure mode).
  // allSettled awaits every promise, so none can be unhandled; we then
  // surface the first rejection ourselves so the upstream error path is
  // unchanged.
  const drainWave = async () => {
    if (wave.length === 0) return;
    const current = wave;
    wave = [];
    const results = await Promise.allSettled(current);
    const rejection = results.find(r => r.status === 'rejected');
    if (rejection) throw firstError || rejection.reason;
  };

  // Push helper: also attaches a no-op .catch() to silence V8's
  // "unhandled rejection" detection in the WINDOW between push and the
  // next drainWave. That window can be up to WAVE_SIZE batches wide
  // (~30 at IDENTITY_CONCURRENCY=15), and a batch that rejects in
  // that window — e.g. an ECONNRESET on a stalled keep-alive socket —
  // would otherwise fire unhandledRejection BEFORE drainWave gets a
  // chance to attach handlers via Promise.allSettled. Node ≥17 then
  // promotes that to uncaughtException and crashes the process (real
  // 2026-05-29 production crash at 96%). The .catch handler is a
  // no-op — drainWave will still see the rejection via allSettled and
  // surface it as the thrown error, so the upstream error path is
  // unchanged.
  const pushBatch = (batch) => {
    const task = submitBatch(batch);
    task.catch(() => { /* drainWave will surface this — silence V8 */ });
    wave.push(task);
  };

  // ONE try around the whole stream (2026-10-06): a failing batch surfaces via
  // drainWave() INSIDE onRow, i.e. out of streamIds itself. With only the
  // final drain inside the try, a failure in any earlier wave left the job
  // 'expanding' with no reason and frozen progress — un-plannable (correct) but
  // also un-resumable, recoverable only by restarting the app.
  try {
    // onRow is async so that csv.js's `await onRow(...)` provides natural
    // backpressure — the CSV stream pauses at each wave boundary until the
    // in-flight Adobe calls complete.
    await streamIds(uploadPath, {
      column,
      onRow: async (value) => {
        if (aborted) return;
        if (skipSourceIds) {
          // A Resume re-reads the file from the top; say how far it has got
          // (2026-10-09) — it used to log only once the whole file was read.
          progress.checked++;
          if (skipSourceIds.has(value)) {
            progress.skipped = ++skipped;
            if (skipped % config.resumeLogEvery === 0) {
              logger.info({ jobId, checked: progress.checked, skipped }, 'resuming: skipping IDs already expanded');
            }
            return;
          }
          if (progress.phase === 'resuming') {
            progress.phase = 'expanding';
            logger.info({ jobId, checked: progress.checked, skipped },
              'resuming: reached IDs not yet expanded — sending batches again');
          }
        }
        buffer.push(value);
        if (buffer.length >= config.identityBatchSize) {
          pushBatch(buffer);
          buffer = [];
          if (wave.length >= WAVE_SIZE) {
            await drainWave(); // blocks CSV stream until this wave clears
          }
        }
      },
    });

    if (skipSourceIds && skipped > 0) {
      logger.info({ jobId, skipped }, 'resumed expansion: skipped already-processed source ids');
    }

    // Flush any remaining partial buffer and the last partial wave.
    if (buffer.length > 0) pushBatch(buffer);

    await drainWave();

    // FAIL CLOSED on an all-empty graph (review finding #2). When the job
    // processed real sources but the Identity Graph returned ZERO linked
    // members across ALL of them, that is the wrong-region / wrong-nsid /
    // 200-empty fingerprint — proceeding would emit a source-ONLY deletion
    // plan, silently leaving every linked email/phone/CRMID alive. We read the
    // PERSISTED, cumulative counters (not run-local) so this is correct even
    // when a previous run crashed mid-expansion and this is a resume: a fresh
    // run that crashed before this check still incremented graph_members_seen
    // per batch, so a genuinely-empty graph stays 0 across the resume too.
    // Honor an explicit operator override.
    const finalJob = q().getJob.get(jobId);
    // Not for an IDs-only job: there the absence of linked identities is the
    // operator's explicit choice, not a wrong-region / wrong-nsid fingerprint.
    if (!expansionOff && !config.allowEmptyGraph &&
        finalJob.processed_count > 0 && (finalJob.graph_members_seen || 0) === 0) {
      const noReplyNote = finalJob.no_reply_count
        ? ` (${finalJob.no_reply_count} of them got no reply at all; Resume will ask Adobe about them again)` : '';
      // Nothing came back for the whole job, so the "no reply" records describe
      // the setup, not the IDs. Clear them: once the region/namespace is fixed,
      // Resume asks about those IDs again instead of skipping them for good (final
      // review #1). Never a bypass — a still-wrong setup fails here again.
      progress.processed -= clearNoReply(jobId);
      throw new Error(
        `Identity Graph returned 0 linked identities across all ${finalJob.processed_count} source(s)${noReplyNote} — ` +
        `this usually means a wrong region/namespace for this sandbox, or that none of these IDs exist in AEP any more. ` +
        `Refusing to ship a source-only deletion that would leave linked identities alive. ` +
        `Verify the credential region and source namespace; set ALLOW_EMPTY_GRAPH=1 to override ` +
        `if the sources genuinely have no linked identities.`);
    }

    // With deferred dedup (no unique index), found_count was incremented with
    // raw insert counts that may include duplicates. Overwrite with the true
    // distinct total now that all rows are in the table. This is a single
    // COUNT DISTINCT subquery — cheap compared to a full expansion run.
    const distinct = q().countDistinctIdentities.get(jobId)?.n ?? 0;
    q().setFoundCount.run(distinct, jobId);
    progress.found = distinct;

    q().updateJobStatus.run('expanded', null, jobId);
    logger.info({ jobId, processed: progress.processed, found: distinct }, 'expansion complete');
    // Build the identity analysis in the background (cluster jobs only — an
    // IDs-only job has no clusters). Its errors never reach the expansion.
    if (!expansionOff) queueAnalysisBuild(jobId);
  } catch (err) {
    // Let any batch still in flight settle first, so nothing writes rows or
    // counters after the job is recorded 'failed' (a resume could start then).
    // Cancelled lookups settle at once.
    abortRun();
    await Promise.allSettled(wave);
    q().updateJobStatus.run('failed', err.message, jobId);
    throw err;
  } finally {
    clearInterval(heartbeat);
    progress.waiting = null;
    // Only THIS run's entry: a Resume started within the window has replaced
    // it, and deleting that would blank its status mid-run (final review #2).
    const mine = progress;
    setTimeout(() => { if (liveProgress.get(jobId) === mine) liveProgress.delete(jobId); }, config.liveProgressRetainMs)
      .unref?.();     // never the only thing keeping the process alive
  }

  return progress;
}
