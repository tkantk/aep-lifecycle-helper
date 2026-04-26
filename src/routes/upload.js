import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { q } from '../db.js';
import { streamIds } from '../utils/csv.js';
import { runExpansion } from '../runner/expansion.js';
import { logger } from '../utils/logger.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}_${uuid()}${path.extname(file.originalname) || '.csv'}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

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
router.post('/', upload.single('file'), async (req, res, next) => {
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
      sourceNamespaceId: sourceNamespaceId != null && sourceNamespaceId !== ''
        ? Number(sourceNamespaceId) : null,
      dailyLimit: Number(dailyLimit) || config.dailyIdentifierLimit,
      monthlyLimit: Number(monthlyLimit) > 0 ? Number(monthlyLimit) : null,
      uploadPath: req.file.path,
      totalSourceIds,
    });

    // Kick off expansion in-process (fire-and-forget). Progress via /progress.
    runExpansion({
      jobId,
      uploadPath: req.file.path,
      sourceNamespace: sourceNamespace || 'hashedKocid',
      sourceNamespaceId: sourceNamespaceId != null && sourceNamespaceId !== ''
        ? Number(sourceNamespaceId) : null,
      credsId,
      sandboxName,
      column: isNaN(column) ? column : Number(column),
    }).catch(err => logger.error({ jobId, err: err.message }, 'expansion crashed'));

    res.json({ jobId, totalSourceIds, status: 'expanding' });
  } catch (err) { next(err); }
});

export default router;
