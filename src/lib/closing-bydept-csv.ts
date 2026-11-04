/**
 * STORE vs DEPARTMENTS — the CSV (owner ruling 99).
 *
 * ONE builder for TWO callers, so the two can never drift apart:
 *   • /api/closing-stock/history?view=bydept&format=csv   (the route), and
 *   • the Download button on Inventory → Closing History, which builds the file
 *     IN THE BROWSER from the very sheet on screen. It does not ask the server
 *     again: a count saved after the sheet loaded must not make the file
 *     silently differ from what the reader is looking at (screen lens, 3 Nov).
 *
 * Pure: no database, no request — the sheet in, the file text out. It only
 * PRINTS what the route already computed (purchase-unit quantities, stored ₹
 * values, totals); it never converts, re-prices or re-totals anything.
 *
 * Layout: two header lines (the group each column files under, then the column
 * itself — the screen's two-level heading), one line per item (raw block, then
 * semi-finished), then per block: items counted, ₹ value, lines with no rate.
 * BLANK = not counted, '0' = counted and zero — the matrix CSV's rule.
 */
import { csvQty } from './pack-units';

export interface BydeptCsvColumn { key: string; name: string; group: string }
/** unit-lock: `qty` is ALREADY in the purchase unit (semi-finished: its yield unit). */
export interface BydeptCsvCell { qty: number; value: number | null; unit: string }
export interface BydeptCsvRow {
  material: string;
  sku: string;
  category: string;
  type: 'RAW' | 'SUB';
  purchase_unit: string;
  mixed_units: boolean;
  cells: Record<string, BydeptCsvCell | null>;
  total_qty: number | null;
  total_value: number | null;
}
export interface BydeptCsvTotal { lines: number; value: number; unpriced: number }
export interface BydeptCsvBlock { by_column: Record<string, BydeptCsvTotal>; total: BydeptCsvTotal & { items: number } }
export interface BydeptCsvSheet {
  date: string;
  columns: BydeptCsvColumn[];
  rows: BydeptCsvRow[];
  semi_rows: BydeptCsvRow[];
  totals: { raw: BydeptCsvBlock; semi: BydeptCsvBlock; all: BydeptCsvBlock };
  truncated: boolean;
  /** The route's truncation note (present whenever `truncated`). */
  note: string | null;
  /** The item search this sheet answers ('' = none). */
  q: string;
}

/** Quote-and-double — item names carry commas ("MAIDA, REFINED"), quotes and
 *  the odd pasted newline. Same rule as the history route's own CSVs. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The download's file name. A searched sheet says so in its name too, so a
 *  filtered file is never saved under the name of the whole day. */
export function bydeptCsvFilename(date: string, q: string): string {
  const slug = q.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `closing-stock-store-vs-departments-${date}${q.trim() ? `-q-${slug || 'search'}` : ''}.csv`;
}

export function bydeptCsv(sheet: BydeptCsvSheet): string {
  const { columns, date } = sheet;
  const colKeys = columns.map((c) => c.key);
  // Quantities first (Store, each department, Total), then the same columns as
  // ₹ values, so a department's value can be totalled in Excel without re-pricing.
  const lead = ['Item', 'SKU', 'Category', 'Type', 'Purchase Unit'];
  const pad = ['', '', '', ''];
  const groupLine = ['Group', ...pad, ...columns.map((c) => c.group), '', ...columns.map((c) => c.group), ''];
  const headLine = [
    ...lead,
    ...columns.map((c) => c.name), 'Total',
    ...columns.map((c) => `${c.name} Value (INR)`), 'Total Value (INR)',
  ];
  const lines = [groupLine.map(cell).join(','), headLine.map(cell).join(',')];
  const rowLine = (row: BydeptCsvRow) => {
    const qtyCells = colKeys.map((k) => {
      const c = row.cells[k];
      // BLANK = not counted, '0' = counted and empty — as the matrix CSV.
      if (!c) return '';
      // A mixed-unit SUB row names the unit in the cell, so no figure in the
      // file reads in a unit it was not counted in.
      return row.mixed_units ? cell(`${csvQty(c.qty)} ${c.unit}`) : String(csvQty(c.qty));
    });
    const valueCells = colKeys.map((k) => {
      const c = row.cells[k];
      return c && c.value != null ? String(c.value) : '';
    });
    return [
      cell(row.material), cell(row.sku), cell(row.category), row.type,
      cell(row.mixed_units ? 'mixed — see each cell' : row.purchase_unit),
      ...qtyCells,
      row.total_qty == null ? '' : String(csvQty(row.total_qty)),
      ...valueCells,
      row.total_value == null ? '' : String(row.total_value),
    ].join(',');
  };
  for (const row of sheet.rows) lines.push(rowLine(row));
  for (const row of sheet.semi_rows) lines.push(rowLine(row));

  // Footers. The item count sits under the quantity columns and the ₹ under the
  // value columns. A column with nothing counted in a block is BLANK, never 0 —
  // "no count" is not "₹0 of stock". The no-rate line says how many counted
  // lines the ₹ leaves out, so a 0 that is really "counted but never priced"
  // is not read as stock worth nothing — the screen says the same per column.
  const footer = (label: string, t: BydeptCsvBlock) => {
    lines.push([
      cell(`Items counted — ${label}`), ...pad,
      ...colKeys.map((k) => t.by_column[k].lines), t.total.items,
      ...colKeys.map(() => ''), '',
    ].join(','));
    lines.push([
      cell(`Value (INR) — ${label}`), ...pad,
      ...colKeys.map(() => ''), '',
      ...colKeys.map((k) => (t.by_column[k].lines ? t.by_column[k].value : '')),
      t.total.lines ? t.total.value : '',
    ].join(','));
    lines.push([
      cell(`Lines with no rate (not in the value) — ${label}`), ...pad,
      ...colKeys.map(() => ''), '',
      ...colKeys.map((k) => (t.by_column[k].lines ? t.by_column[k].unpriced : '')),
      t.total.lines ? t.total.unpriced : '',
    ].join(','));
  };
  lines.push('');
  footer('raw materials', sheet.totals.raw);
  footer('semi-finished', sheet.totals.semi);
  footer('all', sheet.totals.all);
  lines.push('', ['Count date', date].join(','));
  // A searched sheet says so: its footers total only the matched items.
  if (sheet.q.trim()) lines.push(['Item search (filtered view — totals cover the matched items only)', cell(sheet.q.trim())].join(','));
  if (sheet.truncated) lines.push('', cell(`TRUNCATED: ${sheet.note ?? ''}`));
  // UTF-8 BOM — without it Excel on Windows mangles item names and ₹.
  return '﻿' + lines.join('\n');
}
