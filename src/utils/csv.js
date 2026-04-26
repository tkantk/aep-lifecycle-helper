import fs from 'node:fs';
import { parse, format } from 'fast-csv';
import path from 'node:path';

/**
 * Stream source IDs from a CSV. Never loads the full file into memory.
 *
 * Auto-detects header row: if the first field of row 1 looks like a
 * column name rather than a data value, it's treated as a header.
 */
export async function streamIds(filePath, { column = 0, onRow }) {
  let total = 0;
  let valid = 0;
  let headers = null;

  const stream = fs.createReadStream(filePath)
    .pipe(parse({ headers: false, trim: true, skipEmptyLines: true }));

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
  return { total, valid };
}

/**
 * Write rows to CSV with streaming output.
 */
export async function writeCsv(filePath, headers, rows) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath);
  const csv = format({ headers, writeHeaders: true });
  csv.pipe(out);
  for (const row of rows) {
    if (!csv.write(row)) await new Promise(r => csv.once('drain', r));
  }
  csv.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
}
