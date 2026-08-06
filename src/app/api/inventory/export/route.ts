import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { packFactor } from '@/lib/pack-units';
import { cutoverAt } from '@/lib/dept-ledger';

/**
 * Export every raw_material as a round-trip CSV — every editable field
 * (with the material's `id` first so the import can update existing rows
 * cleanly). Admins / store managers edit in Excel, then upload back via
 * /api/inventory/round-trip-import.
 *
 * GET /api/inventory/export
 *   → 200 text/csv with Content-Disposition attachment
 *
 * NOTE: includes inactive rows too so a user can re-activate by editing
 * `is_active` from 0 → 1 in the spreadsheet. Excluding them would silently
 * drop them on the round-trip.
 *
 * LAYOUT (deliberate, see HEADER_ALIASES and the `_note` block below):
 *   line 1 = headers, `_note` first
 *   line 2 = the banner row — one sentence saying this sheet is CENTRAL STORE
 *            stock only, and every other cell blank
 *   line 3+ = the materials
 * The banner is a ROW and not a line above the headers because line 1 IS the
 * header row to the re-upload parser.
 */
export const dynamic = 'force-dynamic';

const COLUMNS = [
  'id',                       // immutable — required for round-trip update
  'sku',
  'name',
  'category',
  'unit',                     // recipe unit (g/ml/kg/...)
  'purchase_unit',
  'pack_size',
  'case_size',
  'reorder_level',            // in recipe units
  'priority',                 // 3 = critical / 2 = standard / 1 = low
  'costing_method',
  'average_price',            // ₹ per recipe unit
  'current_stock',            // read-only on import (informational)
  'super_category',
  'brand',
  'yield_percent',
  'tax_percent',
  'cess_percent',
  'standard_purchase_rate',
  'closing_cadence',
  'is_recipe_item',
  'is_direct_sell',
  'is_semifinished',
  'storage_location',
  'shelf_life_days',
];

/**
 * Presentation-only header renames: the KEY is the real raw_materials column
 * (it goes into the SELECT and indexes every row), the VALUE is what the
 * spreadsheet says. Kept apart on purpose — aliasing in SQL instead would force
 * every `r[c]` lookup below onto the display name, and the next person adding a
 * column would have to know that.
 *
 * WHY current_stock READS central_stock: since the department cutover a
 * requisition issue debits central at the MOMENT OF ISSUE, so this number is
 * the central store's own holding — grams sitting on a kitchen's shelf are no
 * longer inside it. The value did not change basis (still RECIPE units, still
 * the same column) but its MEANING did, and a column that keeps its old name
 * while its number falls by a third is exactly how a manager concludes the app
 * has broken. The rename is half the answer; the `_note` banner is the other.
 *
 * SAFE ON THE ROUND TRIP, and this is load-bearing rather than lucky:
 * round-trip-import only ever writes FIELD_TYPES / WRITABLE_FIELDS
 * (round-trip-import/route.ts:39-51) and current_stock has never been in it —
 * the column is informational on the way back in, so no rename here can change
 * what an upload writes. Do NOT alias a WRITABLE column: the importer matches
 * on header NAME, so renaming e.g. average_price would silently stop that
 * column being imported at all, with no error anywhere.
 */
const HEADER_ALIASES: Record<string, string> = {
  current_stock: 'central_stock',
};
const headerLabel = (c: string) => HEADER_ALIASES[c] ?? c;

/**
 * THE BANNER COLUMN. `_note` holds one sentence, in one row (the first data
 * row), telling whoever opens the sheet why central_stock dropped.
 *
 * DO NOT "simplify" this into a comment line above the header. The inventory
 * page re-uploads this exact file with Papa.parse({ header: true })
 * (src/app/inventory/page.tsx:677), which takes LINE 1 as the header row. A
 * preamble line would BECOME the header, every real column would disappear,
 * and Export → edit → Re-upload would break for the whole catalog.
 *
 * WHY THE TEXT SITS UNDER `_note` AND NOT UNDER `id` — the page keeps only rows
 * matching `(r.id || r.name)` (page.tsx:681). The banner is blank in both, so it
 * is dropped before the request is even built; and if some other caller ever
 * posts it anyway the server skips it on the empty name (round-trip-import
 * route.ts:155-156). Two independent guards. Parked under `id` or `name` it
 * would survive the filter and report "Skipped 1" on every import forever;
 * parked under `sku` it would enter the duplicate-SKU pre-scan
 * (round-trip-import route.ts:136-150) and abort any file a manager built by
 * concatenating two exports. `_note` is in no importer field list at all, so
 * even the impossible path writes nothing.
 */
const NOTE_COLUMN = '_note';

/**
 * The banner sentence. Reads the ONE cutover boundary
 * (settings.dept_ledger_cutover_at via cutoverAt) rather than hard-coding or
 * re-deriving a date — a second copy of that timestamp is how two different
 * "history excluded" dates end up on screen. Before the cutover is run the
 * stamp is '' and the wording changes, because claiming a re-basing date that
 * has not happened is worse than saying it has not happened.
 *
 * Note what this does NOT claim: the issue-time debit is unconditional from
 * this release, NOT from the cutover. Only the re-basing count and the
 * department balances start at the cutover.
 */
function centralStockNote(db: ReturnType<typeof getDb>): string {
  const d = cutoverAt(db).slice(0, 10);
  const base =
    'NOTE — "central_stock" is the CENTRAL STORE holding only. Goods issued on a requisition are '
    + 'deducted from central the moment the store issues them and are carried on the receiving '
    + "department's ledger instead (Inventory > Department Stock), so they are NOT in this column. "
    + 'It was named "current_stock" in earlier exports, when it still included them.';
  const boundary = d
    ? ` Central was re-based to a physical count at the department cutover on ${d}, and issues dated `
      + `before ${d} were never deducted from it, so this column is not comparable with an export taken `
      + `before ${d} — the fall is stock that now sits with the departments, not a loss.`
    : ' The department cutover has not been run yet, so central has not been re-based to a physical'
      + ' count and this column will keep falling as issues are deducted. Treat it as not comparable'
      + ' with earlier exports until the cutover count is taken.';
  return base + boundary
    + ' This column, and every column ending "_purchase_unit", are informational: re-uploading this'
    + ' file never writes them.';
}

function csvEscape(v: any): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// WIPE GUARD — do not "simplify" this back to a plain csvEscape().
// round-trip-import's coerce() skips an EMPTY cell (value preserved) but writes
// an explicit 0 for a cell containing '0'. These two columns are almost always
// 0 (they are set one material at a time, by hand, on the master), so exporting
// a literal '0' on every row turns any stale sheet into a loaded gun: Export
// today → edit one unrelated cell → Re-upload next week silently zeroes every
// GST%/cess% typed in between, and nothing in the app reads those columns loudly
// enough for anyone to notice. A blank cell means exactly what the 0 meant
// ("not set") and round-trips as a no-op instead. A non-zero rate still exports
// as its number, and a user who genuinely wants 18 → 0 types 0 themselves and it
// still writes 0 — the importer is deliberately left untouched.
const BLANK_WHEN_ZERO = new Set(['tax_percent', 'cess_percent']);

function csvCell(col: string, v: any): string {
  if (BLANK_WHEN_ZERO.has(col) && (v == null || Number(v) === 0)) return '';
  return csvEscape(v);
}

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return new Response('Sign in required', { status: 401 });
    if (me.role !== 'admin' && !me.is_store_manager) {
      return new Response('Admin / store manager only', { status: 403 });
    }
    const db = getDb();
    const rows = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM raw_materials ORDER BY sku, name`).all() as any[];

    const lines: string[] = [];
    // avg_price_per_purchase_unit is a READ-ONLY display column (₹/BTL etc, =
    // average_price × pack_size when the purchase unit differs) so the CSV
    // matches what the UI shows. The round-trip import ignores unknown columns,
    // so it can never be written back — average_price stays the canonical
    // ₹/recipe-unit value.
    // INPUT HAZARD, deliberately handled with INFORMATIONAL columns only: the
    // writable columns (reorder_level, average_price) stay in RECIPE basis
    // because /api/inventory/round-trip-import writes them back verbatim —
    // converting them here would multiply every buffer and rate by pack_size on
    // the next round trip. The *_purchase_unit columns below are display-only
    // twins the importer ignores (not in WRITABLE_FIELDS), so a manager reading
    // the sheet sees the same numbers the screen shows without being able to
    // corrupt the stored basis by editing the wrong cell.
    // central_stock_purchase_unit is the PURCHASE-unit twin of central_stock and
    // was renamed with it — same reason, same basis, and equally inert on the way
    // back in: the importer's twin pre-scan reads only the ₹ and reorder twins
    // (round-trip-import/route.ts:77-78), never the stock one.
    const headers = [
      NOTE_COLUMN,
      ...COLUMNS.map(headerLabel),
      'avg_price_per_purchase_unit', 'central_stock_purchase_unit', 'reorder_level_purchase_unit',
    ];
    lines.push(headers.join(','));
    // Banner row: the note under `_note`, every other cell blank and padded to
    // the full width so Excel keeps the columns aligned and the sentence
    // overflows across the empty cells instead of being clipped.
    lines.push([csvEscape(centralStockNote(db)), ...Array(headers.length - 1).fill('')].join(','));
    for (const r of rows) {
      // packFactor IS the both-halves guard (pack_size > 1 AND recipe unit ≠
      // purchase unit) — imported, never re-derived, so this sheet can't drift
      // from what the screens show.
      const pack = packFactor(r);
      const packed = pack > 1;
      const perPU = packed
        ? Math.round((r.average_price || 0) * pack * 100) / 100
        : (r.average_price ?? 0);
      const stockPU = packed
        ? Math.round(((r.current_stock || 0) / pack) * 1000) / 1000
        : (r.current_stock ?? 0);
      const reorderPU = packed
        ? Math.round(((r.reorder_level || 0) / pack) * 1000) / 1000
        : (r.reorder_level ?? 0);
      // Leading '' = the empty `_note` cell. Every row carries it so the data
      // stays under the headers; only the banner row above fills it.
      lines.push(['', ...COLUMNS.map(c => csvCell(c, r[c])), csvEscape(perPU), csvEscape(stockPU), csvEscape(reorderPU)].join(','));
    }
    const csv = lines.join('\n') + '\n';

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="raw-materials-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/inventory/export]', e);
    return new Response(e.message, { status: 500 });
  }
}
