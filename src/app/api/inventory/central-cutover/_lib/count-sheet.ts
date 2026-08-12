import type { StageLineInput } from '@/lib/central-cutover';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ COUNT SHEET — the CSV a counter walks the store with, and reads back.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Private `_lib` of the central-cutover route family (Next.js does not route
 * underscore-prefixed folders). Pure functions: no database, no auth, no
 * Response. That is what makes the round trip testable without a server.
 *
 * WHY THE CSV PLUMBING IS LOCAL AND NOT IMPORTED. api/direct-items/_lib/csv.ts
 * has a parser of the same shape, and api/closing-stock/dept-sheet/import has a
 * third. Each is the private lib of a different route family — the underscore
 * is the repo saying so — and nothing in src/ imports across those boundaries
 * today. Reaching into another family's private lib would mean an edit made for
 * Direct Items could silently change how a stock cutover reads a count sheet,
 * which is the one file in this module where a misread is a re-based book.
 * (dept-sheet/import says the same thing at its line 123, for its own reason.)
 *
 * ── THE SHEET IS BLIND, DELIBERATELY ───────────────────────────────────────
 * It carries NO book quantity and no rupee value. A counter who can see the
 * expected number stops counting and starts confirming, and this project
 * already treats blind counts as a hard requirement everywhere else
 * (api/closing-stock/by-location strips system stock + variance server-side for
 * non-admins). A cutover is the one count where confirming instead of counting
 * would bake the drift in permanently, so the sheet does not print the number
 * even for an admin.
 *
 * ── ORDER IS THE WALK, NOT THE ALPHABET ────────────────────────────────────
 * Rows are grouped by storage location (when the field is populated) and then
 * by category, name last. Measured on this database: storage_location is blank
 * on all 952 materials, so the column is OMITTED and the sort degrades exactly
 * to category then name — 29 distinct categories, which is the only real
 * grouping the data supports today. If a future install fills storage_location
 * in, the column reappears and leads the sort with no further change.
 */

// ── CSV plumbing ────────────────────────────────────────────────────────────

/** Quote a cell only when it needs it. Never locale-formats — a CSV is data. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Header text -> canonical key: BOM stripped, lower-cased, runs of space/dash
 *  collapsed to a single underscore. "Physical Count" and "physical-count" and
 *  "PHYSICAL   COUNT" all land on physical_count. */
function headerKey(h: string): string {
  return String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export interface CsvRecord {
  /** 1-based line number in the FILE — the line Excel shows the operator. */
  line: number;
  cells: string[];
}

/**
 * Quoted fields, escaped quotes, CRLF and a BOM. The line number travels with
 * every record so an error points at the line the counter can actually find
 * rather than at an index they have to count out.
 *
 * `field` is cleared together with `cur` at every row break. Without that the
 * last cell of a row stays in the buffer and the next row's first cell is
 * appended to it — the exact bug documented in
 * api/closing-stock/dept-sheet/import/route.ts, which hid because a BLANK
 * template still parses and only appears once real counts are filled in.
 */
export function parseCsv(text: string): CsvRecord[] {
  const src = String(text ?? '').replace(/^﻿/, '');
  const out: CsvRecord[] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let line = 1;
  let recStart = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { cur.push(field); field = ''; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      line++;
      if (field !== '' || cur.length > 0) { cur.push(field); out.push({ line: recStart, cells: cur }); cur = []; }
      field = '';
      recStart = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || cur.length > 0) { cur.push(field); out.push({ line: recStart, cells: cur }); }
  return out;
}

/** Read the CSV text out of a request however the client sent it: a multipart
 *  `file`, a JSON `{ csv }` body, or a raw text/csv body. */
export async function readCsvBody(
  req: Request,
): Promise<{ csv: string; batchId: string | null }> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const file = fd.get('file');
    const b = fd.get('batch_id');
    const batchId = typeof b === 'string' && b.trim() ? b.trim() : null;
    if (!file || !(file instanceof Blob)) return { csv: '', batchId };
    return { csv: await file.text(), batchId };
  }
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({} as any));
    return {
      csv: String(body?.csv ?? ''),
      batchId: body?.batch_id ? String(body.batch_id) : null,
    };
  }
  return { csv: await req.text(), batchId: null };
}

// ── the sheet ───────────────────────────────────────────────────────────────

/** What the sheet needs per material. A deliberately narrow shape: everything
 *  the count sheet is allowed to know. No book quantity lives in this type, so
 *  a future edit cannot leak one onto the sheet by adding a field to a spread. */
export interface CountSheetRow {
  material_id: string;
  sku: string;
  name: string;
  category: string;
  /** The unit the count must be written in — pre-filled so the operator never
   *  has to decide, because a blank unit on a pack material is refused at
   *  staging and a guessed one is a 1,000x error. */
  count_unit: string;
  storage_location?: string;
}

/** Column order as emitted. The importer is header-keyed, so an operator may
 *  reorder, rename via an alias, or add columns and the file still reads. */
const SHEET_COLUMNS_BASE = ['_note', 'category', 'code', 'item', 'count_unit', 'counted_qty', 'note', 'material_id'];

/**
 * The instruction banner. It is a ROW (line 2) and not a line above the
 * headers, because line 1 IS the header row to the re-upload parser — the same
 * layout api/inventory/export uses and for the same reason. It sits in the
 * `_note` column, which maps to no field, so it can never be mistaken for a
 * count.
 */
function bannerText(cutoverDate: string, storeExcludedReason: string): string {
  return 'BLIND COUNT — CENTRAL STORE ONLY, count date ' + cutoverDate + '. '
    + "Write the physical quantity in 'counted_qty', in the unit printed in 'count_unit'. "
    + 'LEAVE THE ROW BLANK IF YOU DID NOT COUNT IT — a blank is NOT a zero and that material is left '
    + 'completely untouched. Write 0 only when you looked and the shelf is empty. '
    + 'Do not change the count_unit unless you truly counted in a different one. '
    + 'Do not delete the material_id column. '
    + storeExcludedReason;
}

/**
 * Build the count sheet.
 *
 * The storage-location column appears only when at least one row actually has
 * one; an empty column on a walk sheet is noise the counter has to scan past.
 * Rows are sorted by that column first when it is present, then category, then
 * name — see the header note.
 */
export function buildCountSheetCsv(
  rows: CountSheetRow[],
  opts: {
    cutoverDate: string;
    storeExcludedReason: string;
    /** Emitted as a second banner row when the row set is INCOMPLETE. A count
     *  sheet that quietly stops short is the worst possible failure here: the
     *  missing materials are simply never counted, and a never-counted material
     *  looks identical to one whose book was already right. */
    warning?: string;
  },
): string {
  const withLoc = rows.some((r) => String(r.storage_location ?? '').trim() !== '');
  const columns = withLoc
    ? ['_note', 'storage_location', ...SHEET_COLUMNS_BASE.slice(1)]
    : SHEET_COLUMNS_BASE;

  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const sorted = [...rows].sort((a, b) => {
    if (withLoc) {
      const la = String(a.storage_location ?? '').trim();
      const lb = String(b.storage_location ?? '').trim();
      // Unassigned goes last: a counter finishes the mapped shelves, then sweeps.
      if ((la === '') !== (lb === '')) return la === '' ? 1 : -1;
      const l = cmp(la, lb);
      if (l !== 0) return l;
    }
    const c = cmp(a.category || '', b.category || '');
    if (c !== 0) return c;
    return cmp(a.name || '', b.name || '');
  });

  const lines: string[] = [];
  lines.push(columns.join(','));

  const banner: Record<string, string> = { _note: bannerText(opts.cutoverDate, opts.storeExcludedReason) };
  lines.push(columns.map((c) => csvEscape(banner[c] ?? '')).join(','));
  if (opts.warning) {
    const warn: Record<string, string> = { _note: '!! ' + opts.warning };
    lines.push(columns.map((c) => csvEscape(warn[c] ?? '')).join(','));
  }

  for (const r of sorted) {
    const cell: Record<string, string> = {
      _note: '',
      storage_location: String(r.storage_location ?? ''),
      category: r.category || '',
      code: r.sku || '',
      item: r.name || '',
      count_unit: r.count_unit || '',
      counted_qty: '',          // BLANK on purpose — this is the whole point
      note: '',
      material_id: r.material_id,
    };
    lines.push(columns.map((c) => csvEscape(cell[c] ?? '')).join(','));
  }

  // The BOM is added HERE and only here, exactly once. Without it Excel on
  // Windows decodes the file as ANSI and Indian material names come out as
  // mojibake; two BOMs is worse than none, because the second is ordinary data
  // and the first header stops matching on any lookup.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Filename for the download. Dated so two sheets never collide in Downloads. */
export function countSheetFilename(cutoverDate: string): string {
  return 'central-count-sheet-' + cutoverDate + '.csv';
}

// ── reading a filled sheet back ─────────────────────────────────────────────

/**
 * Column aliases, keyed in headerKey() form. A fixed table, not a similarity
 * score: a fuzzy matcher gets most columns right and files the rest against the
 * wrong field, and a count read out of the wrong column is only discovered at
 * the next variance review, if ever.
 *
 * On UNIT ambiguity: `unit` is the RECIPE unit in api/inventory/export while
 * `count_unit` is the PURCHASE unit on this sheet. Both are accepted and
 * neither is a hazard, because the unit STRING decides the basis —
 * resolveCountBasis matches it against the material's own recipe and purchase
 * units and refuses anything else by name, so a count labelled 'g' is read as
 * grams whichever column it arrived in.
 */
const FIELD_ALIASES: Record<string, 'id' | 'sku' | 'name' | 'qty' | 'unit' | 'note'> = {
  material_id: 'id', id: 'id',
  code: 'sku', sku: 'sku', item_code: 'sku', material_code: 'sku',
  item: 'name', name: 'name', material: 'name', item_name: 'name',
  material_name: 'name', description: 'name', particulars: 'name',
  counted_qty: 'qty', counted_quantity: 'qty', count: 'qty', counted: 'qty',
  physical_count: 'qty', physical_qty: 'qty', physical_stock: 'qty',
  qty: 'qty', quantity: 'qty', actual: 'qty', actual_qty: 'qty', closing_qty: 'qty',
  count_unit: 'unit', counted_unit: 'unit', unit_of_count: 'unit', uom: 'unit',
  unit: 'unit', purchase_unit: 'unit',
  note: 'note', notes: 'note', remark: 'note', remarks: 'note', comment: 'note',
};

/** Preference order when a file carries more than one alias for the same field.
 *  The sheet's own header always wins, so a round trip is never ambiguous. */
const FIELD_PRIORITY: Record<'id' | 'sku' | 'name' | 'qty' | 'unit' | 'note', string[]> = {
  id: ['material_id', 'id'],
  sku: ['code', 'sku', 'item_code', 'material_code'],
  name: ['item', 'name', 'item_name', 'material_name', 'material', 'description', 'particulars'],
  qty: ['counted_qty', 'counted_quantity', 'physical_count', 'count', 'counted',
    'physical_qty', 'physical_stock', 'actual_qty', 'actual', 'closing_qty', 'qty', 'quantity'],
  unit: ['count_unit', 'counted_unit', 'unit_of_count', 'uom', 'unit', 'purchase_unit'],
  note: ['note', 'notes', 'remark', 'remarks', 'comment'],
};

export interface UploadParse {
  /** Canonical headers as read, in file order. */
  headers: string[];
  /** Which header each field was read from — echoed so the operator can see
   *  the file was understood the way they meant it. */
  columns: Partial<Record<'id' | 'sku' | 'name' | 'qty' | 'unit' | 'note', string>>;
  /** No column matched a count alias — nothing is staged. The wrong-file guard. */
  missing_count_column: boolean;
  /** Data rows seen (the banner and fully blank rows are not counted). */
  data_rows: number;
  /** Rows carrying a count, in file order, ready for stageLines. */
  counted: Array<{ line: number; input: StageLineInput }>;
  /** Rows that named a material but left the count cell empty. NOT COUNTED —
   *  reported as a number, never as an error and never as a zero. */
  skipped_no_count: number;
  /**
   * RAGGED ROWS — more cells than the header has columns, which means every
   * field after the extra one is read out of the wrong column. NOTHING from
   * these rows is staged; they are returned so the operator gets a named
   * rejection instead of a wrong quantity. See the note on ragged detection in
   * parseCountUpload.
   */
  shifted: Array<{ line: number; cells: number; expected: number; item: string; read_as: string }>;
  /** First few of those, so the operator can spot a column they forgot. */
  skipped_no_count_lines: number[];
  /** The same material counted on more than one line. The LAST one wins (that
   *  is what re-staging does); reported because two counters counting one shelf
   *  is a real event, not a typo. */
  duplicates: Array<{ key: string; lines: number[] }>;
  /** Headers that matched no field. Harmless — reported so a mis-typed count
   *  column ("cout") shows up as an unmapped header instead of silence. */
  unmapped_headers: string[];
  /** Rows beyond the cap were not read. */
  truncated: boolean;
}

/** Hard cap on rows read from one file. The realistic sheet is ~700 rows and
 *  the whole central universe is ~825, so anything past this is a wrong file,
 *  not a big count. */
export const MAX_UPLOAD_ROWS = 5000;

const SAMPLE = 15;

/**
 * Read a filled count sheet into stageable inputs.
 *
 * FORGIVING ON SHAPE, STRICT ON MEANING. Column order, extra columns, renamed
 * columns (via the alias table), blank rows and CRLF are all tolerated. What is
 * never tolerated is inventing a count: this function decides only WHICH rows
 * carry a count, and every value judgement — is it a number, is it negative, is
 * the unit knowable — is left to parseCountedQty / resolveCountBasis inside the
 * engine, which is the one place that decision is made.
 *
 * A BLANK COUNT CELL IS DROPPED HERE, NOT PASSED THROUGH. stageLines would
 * report it as a 'blank' rejection, which is correct for a form field and wrong
 * for a sheet: on a 700-row template where 300 shelves were counted, it would
 * produce 400 rejections and bury the six real problems. Not counted is the
 * normal case for most rows of a partial sheet, so it is a COUNT in the result,
 * not an error list.
 *
 * ── RAGGED ROWS, AND THE 1,250 THAT USED TO BECOME 1 ───────────────────────
 * An UNQUOTED grouped number is two cells to every CSV reader, so writing
 * 1,250 into counted_qty by hand pushes every later cell one column right.
 * This module's own sheet orders the columns
 *   _note, category, code, item, count_unit, counted_qty, note, material_id
 * so the qty index lands on the '1' and the row stages a count of ONE — the
 * right material (code still resolves it), the right unit (count_unit sits
 * BEFORE the split), a silently wrong quantity, and no rejection anywhere.
 * Measured: a 1,250 kg line stages as 1 kg. The route header used to promise
 * such a row "surfaces as a rejection rather than a silent misread, because the
 * count cell then holds the unit text" — which describes a sheet whose unit
 * column comes after the quantity, and this one's does not.
 *
 * The shape is the giveaway, not the value: a row with MORE cells than the
 * header has columns cannot be read reliably in any column, so it is refused
 * whole and named. Trailing empties are ignored (a spreadsheet padding a short
 * row is not a shift) and a row with FEWER cells is fine — that is just a row
 * that stops early, and every mapped index past the end reads as blank, which
 * is already handled.
 */
export function parseCountUpload(text: string): UploadParse {
  const records = parseCsv(text);
  const empty: UploadParse = {
    headers: [], columns: {}, missing_count_column: true, data_rows: 0,
    counted: [], skipped_no_count: 0, skipped_no_count_lines: [], shifted: [],
    duplicates: [], unmapped_headers: [], truncated: false,
  };
  if (records.length === 0) return empty;

  const headers = records[0].cells.map(headerKey);

  // Resolve each field to ONE column index, honouring the preference order.
  const columns: UploadParse['columns'] = {};
  const idx: Partial<Record<'id' | 'sku' | 'name' | 'qty' | 'unit' | 'note', number>> = {};
  for (const field of ['id', 'sku', 'name', 'qty', 'unit', 'note'] as const) {
    for (const wanted of FIELD_PRIORITY[field]) {
      const i = headers.indexOf(wanted);
      if (i >= 0) { idx[field] = i; columns[field] = wanted; break; }
    }
  }
  const unmapped = headers.filter((h) => h && h !== '_note' && !FIELD_ALIASES[h]);

  if (idx.qty === undefined) {
    return { ...empty, headers, columns, unmapped_headers: unmapped, missing_count_column: true };
  }

  /** Cells in a record, ignoring purely empty trailing ones. A spreadsheet that
   *  pads every row out to the widest row in the file is not a column shift. */
  const width = (cells: string[]) => {
    let n = cells.length;
    while (n > 0 && String(cells[n - 1] ?? '').trim() === '') n--;
    return n;
  };

  const cell = (cells: string[], i: number | undefined) =>
    i === undefined ? '' : String(cells[i] ?? '').trim();

  const counted: UploadParse['counted'] = [];
  const skippedLines: number[] = [];
  const shifted: UploadParse['shifted'] = [];
  const seen = new Map<string, number[]>();
  let dataRows = 0;
  let skipped = 0;
  let truncated = false;

  for (let r = 1; r < records.length; r++) {
    if (counted.length >= MAX_UPLOAD_ROWS) { truncated = true; break; }
    const rec = records[r];
    const id = cell(rec.cells, idx.id);
    const sku = cell(rec.cells, idx.sku);
    const name = cell(rec.cells, idx.name);
    const qty = cell(rec.cells, idx.qty);
    const unit = cell(rec.cells, idx.unit);
    const note = cell(rec.cells, idx.note);

    // Nothing in any mapped column: the banner row, a spacer, a totals row that
    // only fills an unmapped column. Not a data row at all.
    if (!id && !sku && !name && !qty && !unit && !note) continue;
    dataRows++;

    // COLUMN SHIFT — refused whole, before the quantity is looked at. Every
    // mapped index on this row points one or more columns off, so there is no
    // field here worth trusting, including the ones that happen to look right.
    // WIDTH ALONE CANNOT SEE EVERY SHIFT, and this is the important part.
    // width() strips trailing empties so that a spreadsheet padding every row
    // to the widest row is not mistaken for a shift — but a row that shifted
    // by one comma AND whose trailing columns are empty trims to exactly the
    // same width. The two are indistinguishable by counting. That is not a
    // theoretical gap: it is precisely the "1,250" case, where an unquoted
    // grouped number splits into two cells, the count reads 1 instead of 1250,
    // and every later column slides one place left into an empty tail.
    //
    // So there are two tests. Width catches the unambiguous case; the split
    // detector below catches the one width structurally cannot.
    const w = width(rec.cells);
    const rawOver = rec.cells.length > headers.length;
    // A grouped number always splits as <1-3 digits> , <exactly 3 digits>.
    // Requiring the second half to be exactly three digits is what keeps this
    // from firing on a legitimate small count followed by a numeric note.
    const qtyIdx = idx.qty;
    const after = qtyIdx === undefined ? '' : String(rec.cells[qtyIdx + 1] ?? '').trim();
    const groupedSplit = /^\d{1,3}$/.test(qty) && /^\d{3}$/.test(after);

    if (w > headers.length || (rawOver && groupedSplit) || groupedSplit) {
      shifted.push({
        line: rec.line,
        cells: Math.max(w, rec.cells.length),
        expected: headers.length,
        item: name || sku || id,
        // The number the operator MEANT, reconstructed, so the refusal names
        // the real quantity rather than the truncated one they never typed.
        read_as: groupedSplit ? `${qty} (row split "${qty},${after}")` : qty,
      });
      continue;
    }

    if (qty === '') {
      // Named but not counted. The normal case on a partial sheet.
      skipped++;
      if (skippedLines.length < SAMPLE) skippedLines.push(rec.line);
      continue;
    }

    const key = id ? 'id:' + id : sku ? 'sku:' + sku.toLowerCase() : 'name:' + name.toLowerCase();
    const prev = seen.get(key);
    if (prev) prev.push(rec.line); else seen.set(key, [rec.line]);

    counted.push({
      line: rec.line,
      input: {
        material_id: id || null,
        sku: sku || null,
        name: name || null,
        counted_qty: qty,
        counted_unit: unit || null,
        note: note || null,
      },
    });
  }

  const duplicates = [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .slice(0, SAMPLE)
    .map(([key, lines]) => ({ key, lines }));

  return {
    headers,
    columns,
    missing_count_column: false,
    data_rows: dataRows,
    counted,
    skipped_no_count: skipped,
    skipped_no_count_lines: skippedLines,
    shifted,
    duplicates,
    unmapped_headers: unmapped,
    truncated,
  };
}
