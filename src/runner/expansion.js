import pLimit from 'p-limit';
import { expandBatch } from '../services/identityGraph.js';
import { listNamespaces, buildNamespaceIndex } from '../services/namespaces.js';
import { bulkInsertIdentities, q } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { streamIds } from '../utils/csv.js';
import { decryptCreds } from '../utils/crypto.js';

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
  const creds = await decryptCreds(credsId);
  const job = q().getJob.get(jobId);
  const total = job.total_source_ids;
  const progress = { processed: 0, total, found: 0 };
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
    logger.warn({ err: err.message }, 'namespace registry load failed - proceeding without canonicalization');
    namespaceIndex = undefined;
  }

  // Custom namespaces (like hashedKocid) often need the numeric nsid to resolve
  // clusters reliably. If the caller gave us a code but no nsid, look the nsid
  // up in the registry now — sending both `ns` and `nsid` on /clusters/members
  // avoids empty responses for ambiguous custom-namespace codes.
  let resolvedNsid = sourceNamespaceId;
  if (resolvedNsid == null && namespaceIndex && sourceNamespace) {
    const hit = namespaceIndex.byCode.get(sourceNamespace);
    if (hit) {
      resolvedNsid = Number(hit.id);
      logger.info({ jobId, sourceNamespace, resolvedNsid }, 'resolved source namespace nsid from registry');
    } else {
      const available = [...namespaceIndex.byCode.keys()].slice(0, 20);
      logger.warn({ jobId, sourceNamespace, availableSample: available },
        'source namespace code not found in registry — Identity Graph will likely return empty clusters');
    }
  }

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
  const WAVE_SIZE = config.identityConcurrency * 2; // 20 batches max in-flight
  let buffer = [];
  let wave   = [];
  let aborted = false;
  let skipped = 0;

  // ─── Per-batch timing instrumentation ─────────────────────────────────
  // Tracks rolling p50/p95 of `adobeMs` (Identity Graph round-trip) and
  // `sqliteMs` (bulkInsertIdentities) over a 50-batch window so we can
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
    try {
      const t0 = Date.now();
      const results = await expandBatch({
        creds, sandboxName,
        namespace: sourceNamespace,
        namespaceId: resolvedNsid,
        ids: batch,
        namespaceIndex,
      });
      const adobeMs = Date.now() - t0;

      // Diagnostic: count total linked identities returned by Adobe for this batch.
      // If this is zero across every batch, either the namespace is wrong for this
      // sandbox or the IDs don't exist in any cluster.
      const linkedTotal = results.reduce((n, r) => n + r.linkedIdentities.length, 0);

      // Flatten to row tuples for bulk insert.
      // Row shape: [job_id, ns_code, ns_id, identity_id, source_id]
      // A tuple with both ns_code=null AND ns_id=null is skipped (can't dedup).
      const rows = [];
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

      const t1 = Date.now();
      const inserted = bulkInsertIdentities(rows);
      q().incrementJobCounters.run(batch.length, inserted, jobId);
      const sqliteMs = Date.now() - t1;

      progress.processed += batch.length;
      progress.found += inserted;

      // Per-batch line: keep it terse so the log doesn't drown the run.
      logger.info({
        jobId, batchSize: batch.length, clustersReturned: results.length, linkedTotal,
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
        }, `── expansion summary @ ${pctDone}% ──`);
      }
    } catch (err) {
      aborted = true;
      logger.error({ jobId, batchSize: batch.length, err: err.message }, 'expansion batch failed');
      throw err;
    }
  });

  // Drain the current wave: await all in-flight tasks, then clear so GC can
  // reclaim the batch arrays and Adobe response objects from completed tasks.
  const drainWave = async () => {
    if (wave.length === 0) return;
    const current = wave;
    wave = [];
    await Promise.all(current); // propagates the first rejection if any task failed
  };

  // onRow is async so that csv.js's `await onRow(...)` provides natural
  // backpressure — the CSV stream pauses at each wave boundary until the
  // in-flight Adobe calls complete.
  await streamIds(uploadPath, {
    column,
    onRow: async (value) => {
      if (aborted) return;
      if (skipSourceIds?.has(value)) { skipped++; return; }
      buffer.push(value);
      if (buffer.length >= config.identityBatchSize) {
        wave.push(submitBatch(buffer));
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
  if (buffer.length > 0) wave.push(submitBatch(buffer));

  try {
    await drainWave();

    // With deferred dedup (no unique index), found_count was incremented with
    // raw insert counts that may include duplicates. Overwrite with the true
    // distinct total now that all rows are in the table. This is a single
    // COUNT DISTINCT subquery — cheap compared to a full expansion run.
    const distinct = q().countDistinctIdentities.get(jobId)?.n ?? 0;
    q().setFoundCount.run(distinct, jobId);
    progress.found = distinct;

    q().updateJobStatus.run('expanded', null, jobId);
    logger.info({ jobId, processed: progress.processed, found: distinct }, 'expansion complete');
  } catch (err) {
    q().updateJobStatus.run('failed', err.message, jobId);
    throw err;
  } finally {
    setTimeout(() => liveProgress.delete(jobId), 60_000);
  }

  return progress;
}
