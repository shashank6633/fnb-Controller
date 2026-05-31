/**
 * Recaho Inward Report parser — handles both the legacy single-sheet "inward report
 * detail" export and the newer multi-sheet "Advanced Inward Report" with grouped rows.
 *
 * Pure function; no DB or fs deps so it can run on both the server (Node API route)
 * and the script (Node CLI).
 *
 * Export Recaho format facts the parser handles:
 *  - Sheets: any of "Item Wise", "Supplier Wise", "Category Wise" or "inward report detail".
 *  - First 5–6 rows are metadata (Business Name / dates / fetched by). Header row is
 *    detected by the presence of "ITEM NAME" / "INWARD QTY" / "RATE".
 *  - Header column names sometimes have trailing spaces ("ITEM  NAME ").
 *  - Grouped sheets contain subtotal rows where the first cell is the group label
 *    ("HYPERPURE", "GROCERY", "FRESH CREAM 1 LTR") and qty/rate cells contain "-".
 *    These rows must be SKIPPED.
 *  - Detail rows have an empty first cell, a date in CREATED DATE, and numeric INWARD QTY.
 *
 * Returns a normalized array of `ParsedInward` rows ready for DB insert.
 */

import type * as XLSX from 'xlsx';

export interface ParsedInward {
  inwardDate:   string | null;     // ISO yyyy-mm-dd
  invoiceId:    string;
  inwardId:     string;
  poId:         string;
  supplier:     string;
  category:     string;
  itemName:     string;
  inwardQty:    number;
  purchaseUnit: string;            // raw POS unit (e.g. "PKT(1LTR)", "CASE(24PC)")
  rate:         number;            // per purchase-unit
  subtotal:     number;
  cgst:         number;
  sgst:         number;
  totalAmount:  number;
  createdBy:    string;
  notes:        string;            // formatted "Invoice X · Inward Y"
}

const norm = (s: any): string => String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();

/** Find the row index that looks like the column header. Searches first 20 rows. */
function findHeaderRow(rows: any[][]): number {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const cells = (rows[i] || []).map(norm);
    const hasItem  = cells.some(c => c === 'ITEM NAME' || c === 'ITEM  NAME');
    const hasQty   = cells.some(c => c === 'INWARD QTY');
    const hasRate  = cells.some(c => c === 'RATE');
    if (hasItem && hasQty && hasRate) return i;
  }
  return -1;
}

/** Build a column-name → index map. Trailing spaces are trimmed. */
function buildHeaderMap(headerRow: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  headerRow.forEach((c, i) => {
    const k = norm(c);
    if (k && map[k] === undefined) map[k] = i;
  });
  return map;
}

/** Detect "is this a group/subtotal row" — has label in col 0, qty/rate are "-". */
function isGroupRow(row: any[], h: Record<string, number>): boolean {
  const firstCell = String(row[0] ?? '').trim();
  if (!firstCell) return false;                       // detail rows have empty col 0
  // Group rows have "-" in CREATED DATE and PO QTY
  const cd  = String(row[h['CREATED DATE']  ?? -1] ?? '').trim();
  const tot = String(row[h['TOTAL INWARD AMOUNT'] ?? -1] ?? '').trim();
  return (cd === '' || cd === '-') && tot !== '' && tot !== '-';
}

function parseDate(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  const s = String(raw).trim();
  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  // "05 May 2026"
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s || s === '-' || s === '–') return 0;
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/**
 * Parse an open XLSX workbook into a flat list of `ParsedInward` rows.
 * Tries sheets in this order: Item Wise → Supplier Wise → Category Wise → first sheet.
 *
 * Pass an already-loaded XLSX module so the function works in both server (where xlsx
 * is dynamically imported) and CLI contexts.
 */
export function parseInwardWorkbook(xlsx: typeof XLSX, workbook: XLSX.WorkBook): ParsedInward[] {
  const preferred = ['Item Wise', 'Supplier Wise', 'Category Wise', 'inward report detail'];
  const sheetName =
    preferred.find(name => workbook.SheetNames.includes(name)) ||
    workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rows  = xlsx.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' });

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) return [];
  const h = buildHeaderMap(rows[headerIdx]);

  // Detect what's the GROUPING column based on the sheet name.
  //   Item Wise       → first col is ITEM NAME    (carry to detail rows missing ITEM NAME)
  //   Supplier Wise   → first col is SUPPLIER NAME
  //   Category Wise   → first col is CATEGORY NAME
  // The legacy "inward report detail" sheet has all fields populated on every row, so
  // group-tracking is harmless there.
  const sheetUpper = sheetName.toUpperCase();
  let groupField: 'itemName' | 'supplier' | 'category' | null = null;
  if (sheetUpper.includes('ITEM'))     groupField = 'itemName';
  else if (sheetUpper.includes('SUPP')) groupField = 'supplier';
  else if (sheetUpper.includes('CATE')) groupField = 'category';

  let currentGroup = '';
  const out: ParsedInward[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;

    if (isGroupRow(row, h)) {
      currentGroup = String(row[0] ?? '').trim();
      continue;
    }

    const qty  = num(row[h['INWARD QTY'] ?? -1]);
    if (qty <= 0) continue;

    // Pull each field; fall back to currentGroup for whichever field is the group key.
    const itemName = (() => {
      const v = String(row[h['ITEM NAME'] ?? -1] ?? '').trim();
      if (v) return v;
      return groupField === 'itemName' ? currentGroup : '';
    })();
    const supplier = (() => {
      const v = String(row[h['SUPPLIER NAME'] ?? -1] ?? '').trim();
      if (v) return v;
      return groupField === 'supplier' ? currentGroup : '';
    })();
    const category = (() => {
      const v = String(row[h['CATEGORY NAME'] ?? -1] ?? '').trim();
      if (v) return v;
      return groupField === 'category' ? currentGroup : '';
    })();

    if (!itemName) continue;

    out.push({
      inwardDate:   parseDate(row[h['INWARD DATE']   ?? -1])
                  ?? parseDate(row[h['CREATED DATE'] ?? -1]),
      invoiceId:    String(row[h['INVOICE ID']    ?? -1] ?? '').trim(),
      inwardId:     String(row[h['INWARD ID']     ?? -1] ?? '').trim(),
      poId:         String(row[h['PO ID']         ?? -1] ?? '').trim(),
      supplier,
      category,
      itemName,
      inwardQty:    qty,
      purchaseUnit: String(row[h['PURCHASE UNIT'] ?? -1] ?? '').trim(),
      rate:         num(row[h['RATE']     ?? -1]),
      subtotal:     num(row[h['SUBTOTAL'] ?? -1]),
      cgst:         num(row[h['CGST']     ?? -1]),
      sgst:         num(row[h['SGST']     ?? -1]),
      totalAmount:  num(row[h['TOTAL INWARD AMOUNT'] ?? -1]),
      createdBy:    String(row[h['CREATED BY'] ?? -1] ?? '').trim(),
      notes:        [
                      row[h['INVOICE ID'] ?? -1] ? `Invoice: ${row[h['INVOICE ID']]}` : null,
                      row[h['INWARD ID']  ?? -1] ? `Inward: ${row[h['INWARD ID']]}`   : null,
                    ].filter(Boolean).join(' · '),
    });
  }
  return out;
}

/* --------------------------------------------------------------------- */
/* Unit / category mapping (mirrors lib/db.ts choices)                    */
/* --------------------------------------------------------------------- */

export function mapCategory(posCategory: string): string {
  const cat = (posCategory || '').trim().toUpperCase();
  if (['VODKA','GIN','RUM','WHISKEY','BOURBON','TEQUILA','BRANDY','BLENDED SCOTCH','BLENDED MALT','SINGLE MALT WHISKEY','IRISH','JAPANESE','TENNESSEE','LIQUER','APERITIF','VERMOUTH','RED WINE','WHITE WINE','SPARKLING WINE','WINES [ROSE]','WINE','BEER','BITTERS'].includes(cat)) return 'bar';
  if (['SOFT BEVERAGES','JUICES','SYRUPS','PUREE','CRUSH','SAUCES'].includes(cat)) return 'beverages';
  if (cat === 'DAIRY PRODUCTS' || cat === 'FROZEN & CHEESE') return 'dairy';
  if (['VEGETABLES','LOCAL VEGETABLES','ENGLISH VEGETABLES'].includes(cat)) return 'veg';
  if (cat === 'FRUITS') return 'veg';
  if (['MEAT','POULTRY','POULTY','SEAFOOD'].includes(cat)) return 'non-veg';
  if (cat === 'GROCERY') return 'grocery';
  if (cat === 'SPICES') return 'spices';
  if (cat === 'GAS & CHARCOAL') return 'other';
  if (cat === 'HOUSEKEEPING' || cat === 'STATIONERY') return 'packaging';
  return 'other';
}

export function mapUnit(posUnit: string): string {
  const u = (posUnit || '').trim().toUpperCase();
  if (u === 'KG' || u.includes('KG')) return 'kg';
  if (u === 'GMS' || u.includes('GMS') || u.includes('GM')) return 'g';
  if (u === 'LTR' || u.includes('LTR') || u.includes('LITRE')) return 'l';
  if (u.includes('ML')) return 'ml';
  if (u === 'PC' || u === 'PCS') return 'pcs';
  if (u.includes('BTL')) return 'bottle';
  if (u.includes('PKT')) return 'pcs';
  if (u.includes('TIN')) return 'pcs';
  if (u.includes('BOX')) return 'pcs';
  if (u.includes('CAN')) return 'pcs';
  if (u.includes('BAG')) return 'kg';
  if (u.includes('DOZEN') || u.includes('DZN')) return 'dozen';
  if (u.includes('BUNCH')) return 'bunch';
  if (u.includes('CASE')) return 'pcs';
  return 'pcs';
}

/** Pack multiplier from "CASE(24PC)", "PKT(1LTR)", etc. */
export function packSize(posUnit: string): number {
  const u = (posUnit || '').trim().toUpperCase();
  const m = u.match(/\(\s*(\d+)\s*PC?S?\s*\)/) || u.match(/(\d+)\s*PC?S?\b/) || u.match(/OF\s*(\d+)/);
  if (m) return parseInt(m[1], 10) || 1;
  return 1;
}

export function parseMaterialVolumeMl(name: string): number | null {
  if (!name) return null;
  const s = String(name).toUpperCase();
  const mMl  = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}
