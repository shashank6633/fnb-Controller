/**
 * Parser for Recaho "Transfer sales report-detail" workbooks.
 *
 * The report records every internal transfer from Main Store to a department
 * (Bar / Hot Kitchen / Cold Kitchen / Pastry / Staff Room / etc.) over a date
 * range. Each row is one item line; rows that share the same TRANSFER/SALE ID
 * belong to the same transfer and become one Requisition.
 *
 * Sheet header (row 6, 0-indexed):
 *   0  DEPARTMENT NAME       — destination dept (we auto-create if missing)
 *   1  CREATED DATE          — "05 May 2026"
 *   2  CREATED TIME
 *   3  PO ID
 *   4  PO DATE
 *   5  TRANSFER/SALE ID      — group key for one requisition
 *   6  TO DATE               — when the transfer was issued
 *   9  CATEGORY NAME
 *   10 ITEM NAME
 *   11 PO QTY                — quantity_requested
 *   12 TO QTY                — quantity_issued (actually transferred)
 *   13 RATE
 *   20 TOTAL AMOUNT
 *   23 CREATED BY
 *
 * Pure function — takes raw row arrays from `xlsx.sheet_to_json(ws, {header:1})`,
 * returns structured groups so the caller can decide how to persist (preview vs commit).
 */

export interface ParsedTransferLine {
  category: string;
  item_name: string;
  qty_requested: number;
  qty_issued: number;
  rate: number;
  total: number;
}
export interface ParsedTransferGroup {
  transfer_id: string;       // Recaho TRANSFER/SALE ID
  department_name: string;
  created_date_iso: string;  // YYYY-MM-DD
  created_time: string;
  to_date_iso: string;       // YYYY-MM-DD (or '' if absent)
  created_by: string;
  po_id: string;             // Recaho PO ID (kept for reference)
  lines: ParsedTransferLine[];
  // derived totals
  total_amount: number;
  line_count: number;
}
export interface ParsedTransferReport {
  groups: ParsedTransferGroup[];
  departments: string[];     // unique dept names found
  date_min: string | null;
  date_max: string | null;
  errors: string[];
}

/** "05 May 2026" → "2026-05-05". Returns '' for empty/invalid input. */
export function parseRecahoDate(s: string | number | null | undefined): string {
  if (s == null) return '';
  // Excel may give a serial number for date cells; xlsx normally formats them as strings, but be defensive.
  if (typeof s === 'number') {
    // 1900-based Excel serial; offset by 25569 days for unix epoch
    const d = new Date((s - 25569) * 86400 * 1000);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }
  const txt = String(s).trim();
  if (!txt) return '';
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

/** Locate header row by matching column names — survives Recaho re-orderings. */
function findHeader(rows: any[][]): { row: number; idx: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i].map(c => String(c || '').toUpperCase().trim());
    const has = (s: string) => r.findIndex(x => x === s);
    const dept     = has('DEPARTMENT NAME');
    const item     = has('ITEM NAME');
    const transfer = r.findIndex(x => x.includes('TRANSFER') && x.includes('ID'));
    if (dept >= 0 && item >= 0 && transfer >= 0) {
      return {
        row: i,
        idx: {
          dept,
          createdDate: has('CREATED DATE'),
          createdTime: has('CREATED TIME'),
          poId:        has('PO ID'),
          poDate:      has('PO DATE'),
          transferId:  transfer,
          toDate:      has('TO DATE'),
          category:    has('CATEGORY NAME'),
          item,
          poQty:       has('PO QTY'),
          toQty:       has('TO QTY'),
          rate:        has('RATE'),
          total:       has('TOTAL AMOUNT'),
          createdBy:   has('CREATED BY'),
        },
      };
    }
  }
  return null;
}

export function parseRecahoTransferReport(rows: any[][]): ParsedTransferReport {
  const errors: string[] = [];
  const header = findHeader(rows);
  if (!header) {
    return { groups: [], departments: [], date_min: null, date_max: null,
             errors: ['Could not locate the header row — expected a "DEPARTMENT NAME / ITEM NAME / TRANSFER/SALE ID" row.'] };
  }
  const { row: headerRow, idx } = header;

  const groups = new Map<string, ParsedTransferGroup>();
  const allDepts = new Set<string>();
  let dateMin: string | null = null;
  let dateMax: string | null = null;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => c === '' || c == null)) continue;
    const dept = String(r[idx.dept] || '').trim();
    const item = String(r[idx.item] || '').trim();
    const tid  = String(r[idx.transferId] || '').trim();
    if (!dept || !item || !tid) continue;        // skip subtotal/group rows

    const createdIso = parseRecahoDate(r[idx.createdDate]);
    const toIso      = parseRecahoDate(r[idx.toDate]);
    const dateForReq = createdIso || toIso;       // prefer creation; fall back to transfer date
    if (!dateForReq) continue;                    // can't anchor → skip

    if (!dateMin || dateForReq < dateMin) dateMin = dateForReq;
    if (!dateMax || dateForReq > dateMax) dateMax = dateForReq;
    allDepts.add(dept);

    let g = groups.get(tid);
    if (!g) {
      g = {
        transfer_id: tid,
        department_name: dept,
        created_date_iso: createdIso,
        created_time: String(r[idx.createdTime] || '').trim(),
        to_date_iso: toIso,
        created_by: String(r[idx.createdBy] || '').trim(),
        po_id: String(r[idx.poId] || '').trim(),
        lines: [], total_amount: 0, line_count: 0,
      };
      groups.set(tid, g);
    }
    const qtyReq = Number(r[idx.poQty]) || 0;
    const qtyIss = Number(r[idx.toQty]) || 0;
    const rate   = Number(r[idx.rate]) || 0;
    const total  = Number(r[idx.total]) || 0;
    g.lines.push({
      category: String(r[idx.category] || '').trim(),
      item_name: item,
      qty_requested: qtyReq,
      qty_issued: qtyIss,
      rate, total,
    });
    g.total_amount += total;
    g.line_count   += 1;
  }

  return {
    groups: [...groups.values()].sort((a, b) =>
      (a.created_date_iso < b.created_date_iso ? -1 : a.created_date_iso > b.created_date_iso ? 1 : 0)),
    departments: [...allDepts].sort(),
    date_min: dateMin,
    date_max: dateMax,
    errors,
  };
}
