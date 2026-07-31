/**
 * CSV plumbing shared by the Direct Items export + import routes, so the file
 * one writes is exactly the file the other reads. (Private `_lib` folder — not
 * a route.)
 */

/** Quote a cell only when it needs it. Never locale-formats — a CSV is data. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: Array<{ /** 1-based line number in the FILE (header = 1). */ line: number; cells: CsvRow }>;
}

/** Header text → canonical key: lower-cased, spaces/dashes → underscore. */
function headerKey(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Small CSV reader: quoted fields, escaped quotes, CRLF, and a BOM. Keeps the
 * source line number for every row so an error can point the user at the line
 * they see in Excel rather than at an index they have to count out.
 */
export function parseCsv(text: string): ParsedCsv {
  const records: { line: number; cells: string[] }[] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let line = 1;
  let recStart = 1;
  const pushField = () => { cur.push(field); field = ''; };
  const pushRecord = () => { records.push({ line: recStart, cells: cur }); cur = []; recStart = line; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      if (field !== '' || cur.length > 0) { pushField(); pushRecord(); }
      else recStart = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || cur.length > 0) { pushField(); pushRecord(); }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].cells.map(headerKey);
  const rows = records.slice(1)
    .filter(r => r.cells.some(c => c.trim() !== ''))
    .map(r => {
      const cells: CsvRow = {};
      headers.forEach((h, i) => { if (h) cells[h] = (r.cells[i] ?? '').trim(); });
      return { line: r.line, cells };
    });
  return { headers, rows };
}

/**
 * Read the CSV text out of a request, whichever way the client sent it:
 * multipart `file`, a JSON `{ csv }` body, or a raw text/csv body.
 */
export async function readCsvBody(req: Request): Promise<{ csv: string; mode: string | null }> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const file = fd.get('file');
    const mode = fd.get('mode');
    if (!file || !(file instanceof Blob)) return { csv: '', mode: typeof mode === 'string' ? mode : null };
    return { csv: await file.text(), mode: typeof mode === 'string' ? mode : null };
  }
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    return { csv: String(body?.csv || ''), mode: body?.mode ? String(body.mode) : null };
  }
  return { csv: await req.text(), mode: null };
}

/**
 * Truthy/falsey words a human might type in a yes/no column.
 * 'blank' and 'invalid' are kept apart on purpose: blank means "leave it alone",
 * while a typo must be reported rather than silently read as "no".
 */
export type BoolCell = { kind: 'blank' } | { kind: 'value'; value: boolean } | { kind: 'invalid' };

export function parseBoolCell(v: string | undefined): BoolCell {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return { kind: 'blank' };
  if (['1', 'y', 'yes', 'true', 't', 'dismissed'].includes(s)) return { kind: 'value', value: true };
  if (['0', 'n', 'no', 'false', 'f'].includes(s)) return { kind: 'value', value: false };
  return { kind: 'invalid' };
}
