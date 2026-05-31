import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { q } from '../db.js';
import { streamIds, sniffUpload } from '../utils/csv.js';
import { runExpansion } from '../runner/expansion.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Coerce a supplied source nsid to a finite non-negative integer, or null.
// Number("abc") is NaN, which would template into the /clusters/members body
// as "nsid": null and could mis-target the Identity Graph. null is safe: the
// expansion runner re-resolves the nsid from the namespace registry (and fails
// closed if the code isn't registered) — review finding #8.
function finiteNsidOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// multer is bounded on every dimension so a malformed multipart stream can't
// cause unbounded memory growth or fill the disk. fileSize 4 GiB keeps the
// documented "up to 4 GB CSV" UX; the rest are sized for our single-file
// upload form (one CSV + a handful of plain text fields).
const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => {
      // Filenames are random; we only borrow the user-supplied extension and
      // sanity-check it so the extname doesn't smuggle weird characters into
      // the filesystem. The original filename is preserved as the job name
      // in the route handler, not on disk.
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^\.(csv|txt|tsv)$/.test(ext) ? ext : '.csv';
      cb(null, `${Date.now()}_${uuid()}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024,   // 4 GiB
    files: 1,
    fields: 20,
    parts: 25,
    headerPairs: 100,
    fieldNameSize: 100,
    fieldSize: 64 * 1024,               // 64 KiB per non-file field; well above what any form field carries today
  },
});

/**
 * Convert MulterError into a 400 with a friendly message instead of letting
 * the generic 500 handler swallow the cause.  Multer 2.x exposes a stable
 * `code` we can return — e.g. LIMIT_FILE_SIZE, LIMIT_PART_COUNT.
 */
function uploadMiddleware(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const e = new Error(err.message);
      e.status = 400;
      e.code = err.code.toLowerCase();
      e.publicMessage = err.message;
      return next(e);
    }
    next(err);
  });
}

/**
 * POST /api/upload
 *
 * multipart fields:
 *   file              CSV (required)
 *   credsId           stored credential id (required)
 *   sandboxName       target sandbox (required)
 *   datasetIds        "ALL" | "id1,id2,..." (required)
 *   sourceNamespace   default "hashedKocid"
 *   sourceNamespaceId numeric nsid if known (helps for custom namespaces)
 *   dailyLimit        identifier cap per day (default from config)
 *   targetServices    CSV of services for profile-only mode. If set,
 *                     datasetIds MUST be "ALL". Validated downstream.
 *   column            0-based index or header name (default 0)
 *   name              optional job label
 */
router.post('/', uploadMiddleware, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const {
      name, credsId, sandboxName, datasetIds = 'ALL',
      sourceNamespace = 'hashedKocid', sourceNamespaceId,
      dailyLimit = config.dailyIdentifierLimit,
      monthlyLimit = config.monthlyIdentifierLimit,
      targetServices, column = 0,
    } = req.body;

    if (!credsId || !sandboxName) {
      return res.status(400).json({ error: 'credsId and sandboxName are required' });
    }

    // Pre-flight: reject files that obviously aren't text CSV BEFORE we
    // try to parse — turns the fast-csv 30s-into-the-stream stack trace
    // into a clean 400 with an actionable explanation (MIP-encrypted,
    // .xlsx-with-.csv-extension, UTF-16, etc.). See utils/csv.js.
    const sniff = await sniffUpload(req.file.path);
    if (!sniff.ok) {
      // Clean up the rejected upload so it doesn't sit in data/uploads/
      // forever; multer wrote it before our handler got a chance to inspect.
      try { await import('node:fs').then(m => m.promises.unlink(req.file.path)); } catch { /* */ }
      const e = new Error(sniff.reason);
      e.status = 400;
      e.code = `bad_upload_${sniff.kind}`;
      e.publicMessage = sniff.reason;
      return next(e);
    }

    // First pass: count rows so we can show a progress denominator.
    // This is a second pass through the file but it's streaming and fast.
    let totalSourceIds = 0;
    await streamIds(req.file.path, {
      column: isNaN(column) ? column : Number(column),
      onRow: () => { totalSourceIds++; },
    });

    const targetServicesJson = (typeof targetServices === 'string' && targetServices.trim())
      ? JSON.stringify(targetServices.split(',').map(s => s.trim()))
      : null;

    const jobId = uuid();
    q().insertJob.run({
      id: jobId,
      name: name || req.file.originalname,
      credsId,
      sandboxName,
      datasetIds: String(datasetIds).trim() || 'ALL',
      targetServicesJson,
      sourceNamespace: sourceNamespace || 'hashedKocid',
      sourceNamespaceId: finiteNsidOrNull(sourceNamespaceId),
      dailyLimit: Number(dailyLimit) || config.dailyIdentifierLimit,
      monthlyLimit: Number(monthlyLimit) > 0 ? Number(monthlyLimit) : null,
      uploadPath: req.file.path,
      totalSourceIds,
    });

    // Persist the chosen source column so crash-recovery resumes against the
    // same column (review blocker #4). Stored as the raw value (index or
    // header name); recovery re-applies the same isNaN/Number coercion.
    q().setJobSourceColumn.run(String(column), jobId);

    // Kick off expansion in-process (fire-and-forget). Progress via /progress.
    runExpansion({
      jobId,
      uploadPath: req.file.path,
      sourceNamespace: sourceNamespace || 'hashedKocid',
      sourceNamespaceId: finiteNsidOrNull(sourceNamespaceId),
      credsId,
      sandboxName,
      column: isNaN(column) ? column : Number(column),
    }).catch(err => logger.error({ jobId, err: err.message }, 'expansion crashed'));

    res.json({ jobId, totalSourceIds, status: 'expanding' });
  } catch (err) { next(err); }
});

export default router;
