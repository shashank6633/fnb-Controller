/**
 * Parser for Recaho "Item Wise Sales Report" workbooks.
 *
 * Each row in the main sheet is the *aggregated total* for one menu item over
 * the report's date range. Recaho also ships sister sheets for Complimentary
 * and Non-Chargeable items.
 *
 * Workbook structure:
 *   Sheet 1  "Item Wise Sales Report"            → bill_type = 'normal'
 *     headers (row 6, 0-indexed):
 *       STATION | DISPLAY GROUP | CATEGORY | ITEM TYPE | PRODUCT NAME | MAPPED CODE
 *       | AMOUNT | CONTRIBUTION % | TOTAL QTY SOLD | DINE IN | PARTY
 *
 *   Sheet 2  "Item Wise Complimentary Report"    → bill_type = 'comp'
 *     headers: STATION | DISPLAY GROUP | CATEGORY | ITEM TYPE | PRODUCT NAME
 *              | AMOUNT | CONTRIBUTION % | TOTAL COMPLIMENTARY QTY | DINE IN | PARTY
 *
 *   Sheet 3  "Item Wise Non Chargeable Report"   → bill_type = 'nc'
 *     headers: STATION | DISPLAY GROUP | SITE NAME | CATEGORY | ITEM TYPE | PRODUCT NAME
 *              | AMOUNT | CONTRIBUTION % | TOTAL NON CHARGEABLE QTY | DINE IN | PARTY
 *
 *   Sheet 4  "Variant Wise"                      → ignored (variants reconciled per-item)
 *
 * Date range comes from the header rows ("Start Date" / "End Date").
 */

export type SalesBillType = 'normal' | 'comp' | 'nc';

export interface ParsedSaleLine {
  station: string;
  display_group: string;
  category: string;
  item_type: string;            // 'foods' | 'liquors' | 'beverages.' | …
  product_name: string;
  mapped_code: string;          // pos_id / item_code if Recaho exposed it
  amount: number;
  total_qty: number;
  dine_in_qty: number;
  party_qty: number;
  bill_type: SalesBillType;
}

export interface ParsedSalesReport {
  start_date_iso: string | null;   // YYYY-MM-DD
  end_date_iso:   string | null;
  business_name:  string;
  lines: ParsedSaleLine[];
  // Per-sheet stats for the preview
  by_bill_type: Record<SalesBillType, { lines: number; qty: number; amount: number }>;
  errors: string[];
}

/** "01 May 2026 12:00 AM" → "2026-05-01" */
export function parseRecahoDateTime(s: string | number | null | undefined): string {
  if (s == null) return '';
  if (typeof s === 'number') {
    const d = new Date((s - 25569) * 86400 * 1000);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const txt = String(s).trim();
  const m = txt.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return '';
  const [, dd, monStr, yyyy] = m;
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mm = months[monStr.slice(0, 3).toLowerCase()];
  if (!mm) return '';
  return `${yyyy}-${mm}-${String(dd).padStart(2, '0')}`;
}

/** Locate the header row by required column names (Recaho ordering can vary). */
function findHeader(rows: any[][], required: string[]): { row: number; idx: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i].map(c => String(c || '').toUpperCase().trim());
    const idx: Record<string, number> = {};
    let allFound = true;
    for (const want of required) {
      const matchIdx = r.findIndex(c => c === want.toUpperCase());
      if (matchIdx < 0) { allFound = false; break; }
      idx[want] = matchIdx;
    }
    if (!allFound) continue;
    // Also pick up optional cols if present
    const optional = ['STATION', 'DISPLAY GROUP', 'CATEGORY', 'ITEM TYPE',
                      'PRODUCT NAME', 'MAPPED CODE', 'AMOUNT', 'CONTRIBUTION %',
                      'DINE IN', 'PARTY', 'SITE NAME',
                      'TOTAL QTY SOLD', 'TOTAL COMPLIMENTARY QTY', 'TOTAL NON CHARGEABLE QTY'];
    for (const want of optional) {
      const matchIdx = r.findIndex(c => c === want);
      if (matchIdx >= 0) idx[want] = matchIdx;
    }
    return { row: i, idx };
  }
  return null;
}

function parseSheet(rows: any[][], billType: SalesBillType, qtyCol: string): ParsedSaleLine[] {
  const header = findHeader(rows, ['PRODUCT NAME', qtyCol]);
  if (!header) return [];
  const { row: headerRow, idx } = header;
  const lines: ParsedSaleLine[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => c === '' || c == null)) continue;
    // Recaho's last data row is a "Grand Total" summary. The literal string
    // "Grand Total" can appear in *any* column (typically STATION at col 0,
    // with PRODUCT NAME just "-"). Also bail if the product cell is the dash
    // placeholder — both are signals the row is the totals roll-up, not data.
    const allCellsHaveGrandTotal = r.some(c => /^\s*grand\s+total\s*$/i.test(String(c || '')));
    if (allCellsHaveGrandTotal) continue;
    const product = String(r[idx['PRODUCT NAME']] || '').trim();
    if (!product || product === '-' || product === '—' || /^grand\s+total$/i.test(product)) continue;
    const qty = Number(r[idx[qtyCol]]) || 0;
    if (qty <= 0) continue;
    lines.push({
      station:        String(r[idx['STATION']] || '').trim(),
      display_group:  String(r[idx['DISPLAY GROUP']] || '').trim(),
      category:       String(r[idx['CATEGORY']] || '').trim(),
      item_type:      String(r[idx['ITEM TYPE']] || '').trim(),
      product_name:   product,
      mapped_code:    String(r[idx['MAPPED CODE']] || '').trim(),
      amount:         Number(r[idx['AMOUNT']]) || 0,
      total_qty:      qty,
      dine_in_qty:    Number(r[idx['DINE IN']] ?? 0) || 0,
      party_qty:      Number(r[idx['PARTY']] ?? 0) || 0,
      bill_type:      billType,
    });
  }
  return lines;
}

/**
 * Parse the full workbook. Pass an object that maps sheet names to row arrays
 * (already extracted via XLSX.utils.sheet_to_json with header:1).
 */
export function parseRecahoSalesWorkbook(
  sheets: Record<string, any[][]>,
): ParsedSalesReport {
  const errors: string[] = [];

  // Pull date range + business name from any sheet's header (they're identical)
  const firstSheet = Object.values(sheets)[0] || [];
  let businessName = '', startDateIso = '', endDateIso = '';
  for (let i = 0; i < Math.min(firstSheet.length, 10); i++) {
    const a = String(firstSheet[i]?.[0] || '').toLowerCase().trim();
    const b = firstSheet[i]?.[1];
    if (a === 'business name')                         businessName = String(b || '').trim();
    if (a === 'start date')                            startDateIso = parseRecahoDateTime(b);
    if (a === 'end date')                              endDateIso   = parseRecahoDateTime(b);
  }

  // Identify the relevant sheets by name fragments (Recaho occasionally renames)
  const findSheet = (...needles: string[]): any[][] | null => {
    for (const [name, rows] of Object.entries(sheets)) {
      const n = name.toLowerCase();
      if (needles.every(needle => n.includes(needle))) return rows;
    }
    return null;
  };

  const main = findSheet('item', 'wise', 'sales');
  const comp = findSheet('complimentary');
  const nc   = findSheet('non', 'chargeable');

  const lines: ParsedSaleLine[] = [];
  if (main) lines.push(...parseSheet(main, 'normal', 'TOTAL QTY SOLD'));
  else errors.push('Could not find "Item Wise Sales Report" sheet');
  if (comp) lines.push(...parseSheet(comp, 'comp',   'TOTAL COMPLIMENTARY QTY'));
  if (nc)   lines.push(...parseSheet(nc,   'nc',     'TOTAL NON CHARGEABLE QTY'));

  const by_bill_type: ParsedSalesReport['by_bill_type'] = {
    normal: { lines: 0, qty: 0, amount: 0 },
    comp:   { lines: 0, qty: 0, amount: 0 },
    nc:     { lines: 0, qty: 0, amount: 0 },
  };
  for (const ln of lines) {
    const slot = by_bill_type[ln.bill_type];
    slot.lines  += 1;
    slot.qty    += ln.total_qty;
    slot.amount += ln.amount;
  }

  return {
    start_date_iso: startDateIso || null,
    end_date_iso:   endDateIso   || null,
    business_name:  businessName,
    lines,
    by_bill_type,
    errors,
  };
}
