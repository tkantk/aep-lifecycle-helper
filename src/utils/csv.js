import fs from 'node:fs';
import { parse, format } from 'fast-csv';
import path from 'node:path';

/**
 * Pre-flight sniff of an uploaded file. Reads the first 4 KiB and returns
 * a `{ ok, kind, reason }` verdict so the upload path can fail FAST with
 * a clear operator-facing message instead of letting fast-csv vomit a
 * parser stack trace into the UI 30 seconds later.
 *
 * Detected non-CSV cases (with the actionable suggestion in `reason`):
 *   - XLSX / ZIP archive (`PK\x03\x04`)
 *   - OLE compound (legacy .xls, MSI, some MIP-protected files)
 *   - UTF-16 LE / BE BOM
 *   - PDF
 *   - High proportion of non-printable bytes (likely encrypted / binary)
 *
 * Accepted: UTF-8 (with or without BOM) text that's mostly printable.
 * The BOM, if present, is left in the file; fast-csv handles it natively.
 */
export async function sniffUpload(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    if (bytesRead === 0) {
      return { ok: false, kind: 'empty', reason: 'File is empty.' };
    }
    const b = buf.subarray(0, bytesRead);

    // Magic-number checks
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) {
      return {
        ok: false, kind: 'zip',
        reason: 'File looks like a ZIP archive (likely an Excel .xlsx workbook with a .csv extension). Open it in Excel and "Save As → CSV UTF-8 (Comma delimited)" before uploading.',
      };
    }
    if (b.length >= 8 && b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) {
      return {
        ok: false, kind: 'ole',
        reason: 'File looks like a legacy Microsoft compound document (.xls / MIP-protected / Office). Open it in Excel and "Save As → CSV UTF-8 (Comma delimited)".',
      };
    }
    if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
      return { ok: false, kind: 'pdf', reason: 'File is a PDF, not a CSV.' };
    }
    if (b.length >= 2 && ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF))) {
      return {
        ok: false, kind: 'utf16',
        reason: 'File is UTF-16 encoded (common Notepad "Unicode" save). Re-save as UTF-8 — in Notepad, use "Save As" and pick UTF-8 encoding.',
      };
    }

    // Heuristic: if a sample of the bytes contains too many control chars
    // (excluding the usual whitespace), treat it as binary.
    let nonPrintable = 0;
    for (const byte of b) {
      // Allow: tab (9), LF (10), CR (13), space..tilde (32..126), and
      // any UTF-8 continuation/leading byte (>= 128). Reject other control
      // codes — they're a strong signal of an encrypted / binary payload.
      const printable = byte === 9 || byte === 10 || byte === 13
        || (byte >= 32 && byte <= 126)
        || byte >= 128;
      if (!printable) nonPrintable++;
    }
    if (nonPrintable / b.length > 0.05) {
      return {
        ok: false, kind: 'binary',
        reason: `File contains ${Math.round(nonPrintable / b.length * 100)}% non-printable bytes in its first ${b.length} bytes — almost certainly not a text CSV. Likely causes: the file is Microsoft Information Protection (MIP) sensitivity-labelled / encrypted, the source is actually .xlsx, or the file got corrupted during transfer. Re-export it as plain UTF-8 CSV from your data source.`,
      };
    }
    return { ok: true, kind: 'csv' };
  } finally {
    await fd.close();
  }
}

/**
 * Stream source IDs from a CSV. Never loads the full file into memory.
 *
 * Auto-detects header row: if the first field of row 1 looks like a
 * column name rather than a data value, it's treated as a header.
 *
 * On parse failure (e.g. invalid CSV structure that the upload sniffer
 * didn't catch), throws a friendly Error with `code = 'csv_parse_error'`
 * so route handlers can return a clean 400 instead of leaking a fast-csv
 * stack trace to the operator.
 */
export async function streamIds(filePath, { column = 0, onRow }) {
  let total = 0;
  let valid = 0;
  let headers = null;

  const stream = fs.createReadStream(filePath)
    .pipe(parse({ headers: false, trim: true, skipEmptyLines: true }));

  try {
    for await (const row of stream) {
    total++;
    // Only treat the first row as a header when column is a string (named-column mode).
    // The old regex-based auto-detection was removed because it could silently drop a
    // real data value that happened to look like a column name.
    if (total === 1 && typeof column === 'string') {
      headers = row;
      continue;
    }

    const idx = typeof column === 'string'
      ? (headers ? headers.findIndex(h => h.toLowerCase() === column.toLowerCase()) : -1)
      : column;
    if (idx === -1) throw new Error(`Column "${column}" not found`);

    const value = (row[idx] || '').trim();
    if (value) {
      valid++;
      await onRow(value, valid);
    }
  }
  } catch (err) {
    // fast-csv throws "Parse Error: expected: ',' OR new line got: ..."
    // when the stream isn't valid CSV (binary file, wrong encoding, XLSX
    // wearing a .csv extension, MIP-encrypted payload, etc.). Re-throw
    // with a friendly message so the route handler returns a clean 400.
    if (/Parse Error/.test(err.message)) {
      const e = new Error(
        'Could not parse uploaded file as CSV. The file appears to contain non-text content — common causes: the file is an Excel .xlsx workbook with a .csv extension, the file is UTF-16 encoded (re-save as UTF-8), the file is Microsoft Information Protection (MIP) sensitivity-labelled, or the file was corrupted in transit. Re-export the source as plain UTF-8 CSV and try again.'
      );
      e.code = 'csv_parse_error';
      e.status = 400;
      e.publicMessage = e.message;
      e.cause = err;
      throw e;
    }
    throw err;
  }
  return { total, valid };
}

/**
 * Defend the exported CSV against spreadsheet-formula injection (a.k.a. CSV
 * injection). Excel / Google Sheets execute the contents of a cell whose
 * value starts with =, +, -, @, tab, or CR — so an identifier value of
 * `=cmd|...` would execute when the operator double-clicks the export. We
 * prefix flagged values with a leading apostrophe so the spreadsheet treats
 * them as literal text. Safe for non-spreadsheet consumers because the
 * apostrophe is part of the CSV value (not a CSV-quoting artefact).
 *
 * Reference: F10 in the 2026-05-12 security review; OWASP "CSV Injection".
 */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r\n]/;

export function sanitiseCsvValue(v) {
  if (v == null) return v;
  const s = typeof v === 'string' ? v : String(v);
  return FORMULA_PREFIX_RE.test(s) ? `'${s}` : s;
}

function sanitiseRow(row) {
  if (Array.isArray(row)) return row.map(sanitiseCsvValue);
  if (row && typeof row === 'object') {
    const out = {};
    for (const k of Object.keys(row)) out[k] = sanitiseCsvValue(row[k]);
    return out;
  }
  return row;
}

/**
 * Write rows to CSV with streaming output. Every value is run through the
 * formula-injection sanitiser above.
 */
export async function writeCsv(filePath, headers, rows) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath);
  const csv = format({ headers, writeHeaders: true });
  csv.pipe(out);
  for (const row of rows) {
    const safe = sanitiseRow(row);
    if (!csv.write(safe)) await new Promise(r => csv.once('drain', r));
  }
  csv.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
}
