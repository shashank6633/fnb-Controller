/**
 * TGBCL LIQUOR BILL CSV — the sheet the Goods Receipt screen reads and writes.
 *
 * CLIENT-SAFE: this module imports papaparse and nothing else. It is used by a
 * 'use client' component (src/components/LiquorGrnBillModal.tsx), so it must
 * never reach @/lib/db or any server module.
 *
 * WHAT MOVED HERE, AND FROM WHERE. Owner rulings #83/#84: TGBCL liquor bills
 * are typed on Goods Receipt, and the TGBCL invoice CSV upload moves with them.
 * The parser, the sample template and the balance (un-matched rows) download
 * are COPIED from the Liquor Store page as it stood at 0d32f2b
 * (src/app/inventory/liquor-store/page.tsx parseBillCsv / downloadTemplate /
 * downloadBalance). Copied, not imported: that page's New Bill / Upload CSV
 * doors are being retired, and a shared import would tie the one live door to
 * the code of the retired one.
 *
 * WHAT IS DIFFERENT FROM THE LIQUOR STORE COPY
 *   · One upload = ONE indent. A Goods Receipt is one indent, so rows carrying
 *     another inward_no are not posted under their own number any more — the
 *     server reports them as 'other_bill' (POST /api/grn/liquor-match) and they
 *     land in the balance file.
 *   · The balance file is built from the ORIGINAL parsed row (so per_case and
 *     inward_no survive the round trip), with the server's reason appended.
 *   · Per-line CGST / SGST are still READ (so the server can say they are not
 *     recorded), but a liquor Goods Receipt carries no GST.
 *
 * QUANTITY BASIS. cases / bottles are PURCHASE units (a case is case_size
 * bottles); loose is the RECIPE-unit remainder (ml / g). The parser keeps all
 * three as the raw strings the sheet held — the server resolves the material
 * and does the arithmetic (tripleToRecipe), so nothing here converts.
 */

import Papa from 'papaparse';

/** One parsed sheet row, every value the raw (trimmed) string from the file. */
export interface LiquorCsvRow {
  item_name: string; sku: string;
  cases: string; bottles: string; loose: string;
  unit_price: string; amount: string; per_case: boolean;
  batch_no: string; expiry_date: string; date: string;
  discount: string; cgst: string; sgst: string; delivery_charges: string;
  /** BILL-level charges (one set per invoice). Read off the first row that
   *  carries each, and offered to the TGBCL charges panel. */
  mrp_round_off: string; excise_turnover_tax: string; special_excise_cess: string; tcs: string;
  /** The indent / inward number. A Goods Receipt is one indent: the first row's
   *  value pre-fills a blank Indent no., and a row with a DIFFERENT number is
   *  reported back as belonging to another bill. */
  inward_no: string;
  /** Reference only — the server matches by sku, then item_name. */
  category_name: string;
  /** Bill-level: pre-fills a blank Supplier. */
  supplier_name: string;
  /** Register parity only — liquor has no PO stage, so this is never read. */
  po_qty: string;
  purchase_unit: string;
  /** Cross-check only, never the price basis. */
  total_inward_amount: string;
  /** Set when inward_qty had a blank / unrecognised purchase_unit and was read
   *  as bottles (or was routed to loose in a unit 1000x the recipe unit). */
  unit_note: string;
}

/**
 * THE BALANCE FILE'S COLUMNS, in order (owner contract 3.2). A balance file is
 * itself a valid upload: every column here is one parseLiquorBillCsv reads
 * (reason is extra and ignored), so the fixed rows can be sent straight back.
 */
export const LIQUOR_CSV_COLUMNS = [
  'item_name', 'sku', 'cases', 'bottles', 'loose', 'unit_price', 'per_case', 'amount',
  'batch_no', 'expiry_date', 'inward_no', 'reason',
] as const;

/** Normalise a CSV date cell to YYYY-MM-DD. Accepts YYYY-MM-DD as-is, year-first
 *  with / or . separators, or a day-first DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY
 *  (2- or 4-digit year, the Indian convention). Anything else → ''. */
export const normCsvDate = (raw: string): string => {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);      // year-first
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);       // day-first
  if (m) {
    const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0');
    let y = m[3]; if (y.length === 2) y = '20' + y;
    if (Number(d) >= 1 && Number(d) <= 31 && Number(mo) >= 1 && Number(mo) <= 12) return `${y}-${mo}-${d}`;
  }
  return '';
};

/**
 * Parse a CSV (header row required) into LiquorCsvRows. Flexible,
 * case-insensitive header names map onto the canonical keys (TGBCL indent and
 * Inward Register friendly). Blank rows are dropped. Throws on a FATAL parse
 * error only — a ragged footer / totals row is tolerated and handled per row.
 */
export function parseLiquorBillCsv(text: string): LiquorCsvRow[] {
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true, skipEmptyLines: true,
    transformHeader: (h: string) => h.toLowerCase().trim(),
  });
  // Ignore NON-fatal FieldMismatch errors (a ragged footer/totals row, a title
  // line, or an item description with an unescaped comma) — PapaParse still
  // parses the data, and the per-row skip-and-report handles those rows.
  const fatal = (parsed.errors || []).filter(
    e => e.type !== 'FieldMismatch' && e.code !== 'TooFewFields' && e.code !== 'TooManyFields',
  );
  if (fatal.length) throw new Error('CSV parse error: ' + fatal[0].message);
  const get = (row: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
    return '';
  };
  const out: LiquorCsvRow[] = [];
  for (const row of parsed.data) {
    const item_name = get(row, 'item_name', 'name', 'item', 'product', 'product description', 'product_description', 'description', 'brand');
    const sku = get(row, 'sku', 'brand_code', 'brand code', 'code');
    const cases = get(row, 'cases', 'quantity cases', 'quantity_cases', 'qty cases', 'case', 'cs');
    const bottles = get(row, 'bottles', 'quantity bottles', 'quantity_bottles', 'qty bottles', 'bottle', 'btl');
    const loose = get(row, 'loose', 'pegs', 'units');
    const unit_price = get(row, 'unit_price', 'unit price', 'price', 'rate', 'price_per_bottle');
    // 'subtotal' is the register's name for this: qty x rate, BEFORE charges.
    const amount = get(row, 'amount', 'subtotal', 'sub total', 'total', 'line_total', 'line total', 'value');
    const pc = get(row, 'per_case', 'per case', 'rate_per_case').toLowerCase();
    const batch_no = get(row, 'batch_no', 'batch', 'batch no', 'lot');
    const expiry_date = get(row, 'expiry_date', 'expiry', 'exp', 'best_before');
    const date = normCsvDate(get(row, 'date', 'inward_date', 'inward date', 'purchase_date', 'purchase date', 'invoice_date', 'invoice date', 'bill_date', 'bill date'));
    const discount = get(row, 'discount', 'disc');
    const cgst = get(row, 'cgst');
    const sgst = get(row, 'sgst');
    const delivery_charges = get(row, 'delivery_charges', 'delivery', 'delivery charges', 'delivery_charge');
    const mrp_round_off = get(row, 'mrp_round_off', 'mrp round off', 'mrp_rounding', 'mrp rounding off');
    const excise_turnover_tax = get(row, 'excise_turnover_tax', 'bar excise turnover tax', 'excise turnover tax', 'turnover_tax');
    const special_excise_cess = get(row, 'special_excise_cess', 'special excise cess', 'cess');
    const tcs = get(row, 'tcs');
    const inward_no = get(row, 'inward_no', 'inward no', 'invoice_id', 'invoice id', 'invoice_ref',
                          'invoice_no', 'invoice no', 'indent_no', 'indent no');
    const category_name = get(row, 'category_name', 'category name', 'category');
    const supplier_name = get(row, 'supplier_name', 'supplier name', 'supplier', 'vendor', 'vendor_name', 'vendor name');
    const po_qty = get(row, 'po_qty', 'po qty', 'ordered_qty', 'ordered qty');
    const inward_qty = get(row, 'inward_qty', 'inward qty', 'qty', 'quantity');
    const purchase_unit = get(row, 'purchase_unit', 'purchase unit', 'unit', 'uom');
    const total_inward_amount = get(row, 'total_inward_amount', 'total inward amount', 'net_amount', 'net amount');
    // Skip a fully-blank line (all key fields empty).
    if (!item_name && !sku && !cases && !bottles && !loose && !inward_qty && !unit_price && !amount) continue;

    // ── inward_qty + purchase_unit -> cases / bottles / loose ────────────────
    // Explicit cases/bottles/loose ALWAYS win: they are the native liquor shape.
    // Only fill from the generic pair when none of the three was given.
    let qCases = cases, qBottles = bottles, qLoose = loose;
    let unitNote = '';
    if (!cases && !bottles && !loose && inward_qty) {
      const u = purchase_unit.toLowerCase().replace(/[^a-z]/g, '');
      if (['case', 'cases', 'cs', 'box', 'boxes', 'carton', 'cartons'].includes(u)) qCases = inward_qty;
      else if (['bottle', 'bottles', 'btl', 'btls', 'pc', 'pcs', 'piece', 'pieces', 'nos', 'no', 'each', 'ea', 'unit', 'units'].includes(u)) qBottles = inward_qty;
      else if (['ml', 'l', 'ltr', 'litre', 'litres', 'liter', 'liters', 'peg', 'pegs', 'loose', 'g', 'kg'].includes(u)) {
        qLoose = inward_qty;
        // Loose is the RECIPE-unit slot (usually ml/g). 'L'/'kg' are 1000x the
        // usual recipe unit and CANNOT be scaled here (the material resolves
        // server-side) — flagged so the sheet is fixed before posting.
        if (['l', 'ltr', 'litre', 'litres', 'liter', 'liters', 'kg'].includes(u)) {
          unitNote = `"${purchase_unit}" routed to LOOSE, which is read in the recipe unit (ml/g) — a ${inward_qty} ${purchase_unit} line would post ~1000× small. Use ml/g or the cases/bottles columns.`;
        }
      } else {
        // Blank or unrecognised unit. Default to BOTTLES, never cases: a case is
        // ~12 bottles, so guessing "case" would inflate the receipt an order of
        // magnitude, and unit_price is per bottle unless per_case says otherwise.
        qBottles = inward_qty;
        unitNote = purchase_unit ? `read "${purchase_unit}" as bottles` : 'no purchase_unit — read as bottles';
      }
    }
    out.push({
      item_name, sku, cases: qCases, bottles: qBottles, loose: qLoose, unit_price, amount,
      per_case: pc === '1' || pc === 'true' || pc === 'yes' || pc === 'y',
      batch_no, expiry_date, date, discount, cgst, sgst, delivery_charges,
      mrp_round_off, excise_turnover_tax, special_excise_cess, tcs,
      inward_no, category_name, supplier_name, po_qty, purchase_unit,
      total_inward_amount, unit_note: unitNote,
    });
  }
  return out;
}

/**
 * The sample template, in Inward Register column order so a downloaded
 * register can be filled in and sent straight back. inward_no, supplier_name
 * and the four bill-level charges are ONE PER INVOICE: first row only. One file
 * is one indent on the Goods Receipt screen, so every row carries the same
 * indent (or none). inward_qty + purchase_unit is the register's way of stating
 * quantity; cases / bottles / loose still work and WIN when present.
 */
export function liquorBillTemplateCsv(date: string): string {
  const d = date;
  // excise_turnover_tax (Bar Excise Turnover Tax, the fourth TGBCL charge) is
  // APPENDED after the register-order columns rather than inserted among them,
  // so a register export still lines up column for column.
  return (
    'inward_no,inward_date,supplier_name,category_name,item_name,sku,'
    + 'po_qty,inward_qty,purchase_unit,rate,subtotal,'
    + 'discount,cgst,sgst,special_excise_cess,tcs,delivery_charges,mrp_round_off,total_inward_amount,'
    + 'cases,bottles,loose,per_case,batch_no,expiry_date,excise_turnover_tax\n'
    // case-quantity line, priced by line total, carrying the bill-level charges
    + `TGBCL-001,${d},GOVERNMENT OF TELANGANA,beer,HEINEKEN LAGER BEER,6561,,5,case,,15010,,,,22617,5491,,7214.40,50332.40,,,,,,,1250\n`
    // same, no charges of its own
    + `,${d},,beer,KINGFISHER ULTRA LAGER BEER,5029,,12,case,,28824,,,,,,,,28824,,,,,,,\n`
    // per-line discount (recorded only), and a bottle quantity
    + `,${d},,vodka,GREY GOOSE VODKA,9004,,6,bottle,,20101,500,,,,,,,19601,,,,,,,\n`
    // priced per CASE instead of per bottle -> per_case=1
    + `,${d},,vodka,ABSOLUT VODKA,8006,,1,case,3900,,,,,,,,,3900,,,,1,,,\n`
    // the older cases/bottles style still works and takes precedence
    + `,${d},,rum,CAMIKARA RUM 750ML,7001,,,,2425.08,2425.08,,,,,,,,2425.08,0,1,,,,,\n`
  );
}

/** One un-matched row for the balance file: the ORIGINAL sheet row plus the
 *  server's reason for not matching it. */
export interface LiquorBalanceRow { row: LiquorCsvRow; reason: string }

/**
 * The balance file — the rows this bill could NOT take, in LIQUOR_CSV_COLUMNS
 * order, so they can be fixed and uploaded again (the matched ones append).
 * Formula-injection guard on genuinely non-numeric cells only, so signed
 * numbers stay summable in Excel.
 */
export function liquorBalanceCsv(rows: LiquorBalanceRow[]): string {
  const clean = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [LIQUOR_CSV_COLUMNS.join(',')];
  for (const { row: r, reason } of rows) {
    lines.push([
      r.item_name, r.sku, r.cases, r.bottles, r.loose, r.unit_price, r.per_case ? '1' : '', r.amount,
      r.batch_no, r.expiry_date, r.inward_no, reason,
    ].map(clean).join(','));
  }
  return lines.join('\n');
}
