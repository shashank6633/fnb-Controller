import { LQ_PRODUCT_TYPES, type LqProductType } from '@/lib/liquor-recon';

/**
 * Parsing + normalising for the TGBCL Brand Master — shared by the editor route
 * and the CSV import so a value typed into the form and the same value uploaded
 * in a file can never land differently.
 *
 * The CSV reader is the house shape (src/app/api/hr/employees/import/route.ts,
 * itself copied from src/app/api/direct-items/_lib/csv.ts): quoted fields,
 * escaped quotes, CRLF, a BOM, and the SOURCE LINE NUMBER carried on every row
 * so an error can point at the line the operator sees in Excel. Deliberately
 * not imported from either of those — each belongs to its own module and may
 * evolve with it.
 */

export type CsvCells = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: Array<{ /** 1-based line number in the FILE (header = 1). */ line: number; cells: CsvCells }>;
}

/**
 * Canonical column keys, matched case/space/underscore-insensitively. The
 * spellings on the left are the ones the owner's Brand Master sheet and the
 * TGBCL portal exports actually use; the value is the documented column name.
 */
const CANONICAL_BY_BARE: Record<string, string> = {
  material: 'material',
  materialname: 'material',
  itemname: 'material',
  item: 'material',
  name: 'material',
  brandname: 'material',
  materialid: 'material_id',
  sku: 'sku',
  itemcode: 'sku',
  brandcode: 'tgbcl_brand_code',
  tgbclbrandcode: 'tgbcl_brand_code',
  brand: 'tgbcl_brand_code',
  code: 'tgbcl_brand_code',
  sizecode: 'size_code',
  packcode: 'size_code',
  size: 'size_code',
  sizeml: 'size_ml',
  ml: 'size_ml',
  volumeml: 'size_ml',
  bottlespercase: 'bottles_per_case',
  btlpercase: 'bottles_per_case',
  bottlescase: 'bottles_per_case',
  unitspercase: 'bottles_per_case',
  ratepercase: 'rate_per_case_master',
  ratepercasemaster: 'rate_per_case_master',
  issueprice: 'rate_per_case_master',
  issuepricepercase: 'rate_per_case_master',
  caserate: 'rate_per_case_master',
  producttype: 'product_type',
  type: 'product_type',
  category: 'product_type',
  isactive: 'is_active',
  active: 'is_active',
  note: 'note',
  notes: 'note',
  remarks: 'note',
};

export const KNOWN_COLUMNS = new Set(Object.values(CANONICAL_BY_BARE));

/** The header line the "Download template" button writes, and what the import
 *  documents. `material` OR `material_id` OR `sku` identifies the material. */
export const BRAND_MAP_CSV_HEADER =
  'material,material_id,sku,tgbcl_brand_code,size_code,size_ml,bottles_per_case,rate_per_case_master,product_type,is_active,note';

function headerKey(h: string): string {
  const base = h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const bare = base.replace(/_/g, '');
  return CANONICAL_BY_BARE[bare] ?? base;
}

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
      const cells: CsvCells = {};
      headers.forEach((h, i) => { if (h) cells[h] = (r.cells[i] ?? '').trim(); });
      return { line: r.line, cells };
    });
  return { headers, rows };
}

/**
 * product_type → one of the workbook's three exact spellings.
 *
 * NORMALISED AT THE EDGE, NEVER BY LOOSENING THE CHECK — the L0 contract is
 * explicit: 'Beer' and 'BEER' arriving as two stored values would split every
 * category total in Summary §C/§D. Anything unrecognised returns null and the
 * caller raises a row error naming the three tokens; it is never coerced to a
 * default, because guessing 'IML' for a beer misclassifies the uplift factor.
 */
export function normProductType(raw: string): LqProductType | null {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!s) return null;
  if (s === 'beer' || s === 'beers') return 'BEER';
  if (s === 'iml' || s === 'i m l' || s === 'indian made liquor' || s === 'indian made foreign liquor'
      || s === 'imfl' || s === 'spirit' || s === 'spirits') return 'IML';
  if (s === 'duty paid' || s === 'dutypaid' || s === 'dp' || s === 'duty paid liquor') return 'Duty Paid';
  // An exact match on the stored spelling, whatever case it arrived in.
  const exact = LQ_PRODUCT_TYPES.find(t => t.toLowerCase() === s);
  return exact ?? null;
}

/** A money / count cell: strips ₹, commas and spaces. Returns null when the
 *  cell is not a finite number, so the caller can name the bad value rather
 *  than storing a silent 0. */
export function numCell(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/[₹,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** '1' / 'true' / 'yes' / 'y' / 'active' → 1; '0' / 'false' / 'no' / 'n' /
 *  'inactive' → 0; blank → the supplied default. */
export function boolCell(raw: string, dflt: number): number {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return dflt;
  if (['1', 'true', 'yes', 'y', 'active', 'on'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'inactive', 'off'].includes(s)) return 0;
  return dflt;
}

/** TGBCL codes are compared case-insensitively and stored upper-cased, so
 *  "9740" / "9740 " / "pp" / "PP" can never become two master rows behind the
 *  UNIQUE(tgbcl_brand_code, size_code) index. */
export const normCode = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/** One spelling the file typed that is NOT what gets stored. */
export interface SpellingFold {
  /** The column, in the words the preview uses ('code', 'pack code', 'product type'). */
  field: string;
  /** Exactly what the file typed, trimmed. */
  typed: string;
  /** What is stored instead. */
  stored: string;
}

/**
 * OWNER DECISION 4 (2026-08-31): an import must NOT silently fold case — keep
 * the file's spelling, and WARN whenever what is stored differs from what the
 * file typed.
 *
 * normCode() and normProductType() above still fold, deliberately: the
 * UNIQUE(tgbcl_brand_code, size_code) index is case-SENSITIVE, so an unfolded
 * '9740/pp' beside '9740/PP' would make one pack two master rows; and
 * product_type is CHECKed against the workbook's three exact tokens, so
 * 'Beer' and 'BEER' stored apart would split every §C/§D total. What the
 * decision forbids is the SILENCE, so every fold is named — on the preview,
 * on every row whatever its action (an 'unchanged' row was folded too), and in
 * the batch audit — and nothing is folded quietly.
 *
 * Returns null when the stored value IS what the file typed. Surrounding spaces
 * are not a spelling (every cell is trimmed on read), so trimming alone never
 * warns; a blank cell has no spelling to keep and never warns either.
 */
export function spellingFold(field: string, raw: unknown, stored: string): SpellingFold | null {
  const typed = String(raw ?? '').trim();
  if (!typed || typed === stored) return null;
  return { field, typed, stored };
}

/** The preview's sentence for a fold: product type 'Beer' stored as 'BEER'. */
export const spellingFoldMessage = (f: SpellingFold): string =>
  `${f.field} '${f.typed}' stored as '${f.stored}' — the file's spelling is not kept `
  + (f.field === 'product type'
    ? '(product type is one of BEER / IML / Duty Paid exactly, so the totals do not split).'
    : '(TGBCL codes are stored upper-case, so one pack can never become two master rows).');
