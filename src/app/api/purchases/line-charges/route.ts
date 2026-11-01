import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
// The SAME read gate as GET /api/purchases (the register feed this route sits
// beside). Imported, never re-typed: a second copy of "who may read the
// purchase register" is how the importers once shipped without one.
import { requirePurchasesReadAccess } from '@/lib/purchases-access';
// THE effective charge rail — imported, not restated. Every report that prints
// a tax or a grand total for a `purchases` row reads it through these fragments,
// and this route has to quote the identical number for the identical row.
import {
  PURCHASE_CHARGE_COLUMNS,
  effectiveBillValueSql,
  effectiveChargeSql,
  effectiveLineTotalSql,
  grnLineJoinSql,
  grnSourcedSql,
  poReceiptMirrorSql,
  withGrnCharges,
} from '@/lib/purchase-charges';
import { gstValue, taxAppliedPercent } from '@/lib/tax-applied';
// The Tax % denominator: the value GST was CHARGED on (accepted, on a delivery
// part-rejected at the door) — the GRN Inward Register's basis. Kept apart from
// bill_value, which stays the SUBTOTAL that Grand Total is built on.
import { gstChargedValueSql, gstBaseAcceptedSql } from '@/lib/purchase-gst-base';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POST /api/purchases/line-charges — TAX, GST % AND GRAND TOTAL PER PURCHASE
 * ROW, for the Purchases register (src/app/purchases/page.tsx).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OWNER #5 (ruling 93, "Do both"): "Purchase Report: Add purchase date, tax
 * details, GST %, and grand total." The reports already carry all four; the
 * Purchases page did not, and its "Total Inward" column added the charge
 * columns stored on the `purchases` row — which on a PO-receipt row are the
 * receive route's placeholder ZEROS (the bill's tax lives on the GRN line).
 * That is the defect Ruling 6 fixed in /api/reports/purchases; this route is
 * how the register gets the same fix.
 *
 * READ-ONLY. Nothing here writes. It is a POST only because the register can
 * hold thousands of rows and a GET URL cannot carry that many ids; the ids
 * travel as ONE JSON-array parameter through json_each, so SQLite's
 * bound-variable limit never applies.
 *
 * WHY A NEW ROUTE AND NOT A JOIN IN GET /api/purchases: that GET's SELECT/JOIN
 * hunk is exactly what the gated wip-v2 branch rewrites. Touching it here would
 * be a merge conflict in a money query. This route sits beside it instead and
 * changes nothing the GET returns.
 *
 *   POST { ids: string[] }   — purchases.id values (the rows on screen)
 *   401 no session · 403 not a reader of /purchases · 400 bad body
 *
 * 200 → {
 *   lines: [{
 *     id,
 *     cgst, sgst, compensation_cess, special_excise_cess,
 *     delivery_charges, mrp_round_off, tcs, discount,     // EFFECTIVE rail, raw
 *     bill_value,     // SUBTOTAL — goods as billed (GRN gross on a PO receipt)
 *     gst_base,       // the goods value GST was CHARGED on, before discount:
 *                     //   bill_value itself, except on a PO receipt part-
 *                     //   rejected at the door, where it is the ACCEPTED value
 *     gst_base_accepted, // 1 = gst_base is that accepted value (≠ bill_value)
 *     total_amount,   // GRAND TOTAL — subtotal − discount + every charge
 *     tax_value,      // gstValue(): r2(cgst + sgst) — GST only, cesses excluded
 *     gst_percent,    // taxAppliedPercent() over gst_base − discount: null
 *                     //   when no GST was recorded
 *     grn_sourced,    // 1 = charges read off the paired GRN line
 *     is_mirror,      // 1 = PO-receipt cost mirror (no PINV of ours + a grn_id);
 *                     //     an Enter Vendor Bill receipt carries our PINV and is 0
 *     unpaired_mirror // 1 = a mirror whose GRN line is gone — charges
 *                     //     UNAVAILABLE, grand total UNDERSTATED
 *   }],
 *   missing: string[] // ids asked for that are not purchases rows
 * }
 *
 * THE FIGURES ARE THE REPORTS' FIGURES, BY CONSTRUCTION:
 *   · the eight charges   = effectiveChargeSql()   — what /api/reports/purchases
 *                           (Summary) and the Purchase Bill Summary sum;
 *   · total_amount        = effectiveLineTotalSql() — the Summary's / Bill
 *                           Summary's Grand Total per line, and on a PO receipt
 *                           character for character the GRN Inward Register's
 *                           Total Inward for that line;
 *   · tax_value / gst_percent = gstValue() / taxAppliedPercent() over
 *                           { cgst, sgst, discount, gst_base } — the value GST
 *                           was charged on, less discount: the GRN Inward
 *                           Register's Tax % basis line for line (owner's
 *                           ruling, 2026-10-14: struck on the ACCEPTED value),
 *                           and on every line that rejected nothing — every
 *                           line today — the Summary's / Bill Summary's base
 *                           exactly (src/lib/purchase-gst-base.ts says where
 *                           those two still differ).
 * Values go out UNROUNDED (except the two helper outputs, which round
 * themselves) so a page total over many rows is r2(Σ raw) — the arithmetic the
 * reports' SQL SUMs use — and not a sum of already-rounded cells.
 *
 * LIQUOR STAYS OUT BY CONSTRUCTION: a TGBCL bill posts to the store ledger and
 * writes NO `purchases` row and NO goods_receipt_note_items row
 * (src/app/api/grn/route.ts liquor rail), so no liquor document can be named
 * by a purchases.id or paired by the grn_line CTE.
 */

/** Far above any real register (2,165 rows locally) — a bound, not a page size. */
const MAX_IDS = 100_000;

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const denied = requirePurchasesReadAccess(me);
    if (denied) return denied;

    let body: unknown;
    try { body = await request.json(); } catch { body = null; }
    const raw = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : undefined;
    if (!Array.isArray(raw)) {
      return Response.json({ error: 'ids (an array of purchase ids) is required' }, { status: 400 });
    }
    const ids = Array.from(new Set(
      raw.filter((v: unknown) => typeof v === 'string' || typeof v === 'number')
         .map((v: string | number) => String(v).trim())
         .filter((v: string) => v !== '' && v.length <= 128),
    ));
    if (ids.length > MAX_IDS) {
      return Response.json({ error: `At most ${MAX_IDS} ids per request` }, { status: 400 });
    }
    if (ids.length === 0) return Response.json({ lines: [], missing: [] });

    const db = getDb();
    const charges = PURCHASE_CHARGE_COLUMNS
      .map((c) => `${effectiveChargeSql(c.key, 'p', 'gl')} AS ${c.key}`)
      .join(',\n             ');
    const rows = db.prepare(withGrnCharges(`
      SELECT p.id AS id,
             ${charges},
             ${effectiveBillValueSql('p', 'gl')} AS bill_value,
             ${gstChargedValueSql('p', 'gl')}    AS gst_base,
             ${gstBaseAcceptedSql('p', 'gl')}    AS gst_base_accepted,
             ${effectiveLineTotalSql('p', 'gl')} AS total_amount,
             ${grnSourcedSql('gl')}               AS grn_sourced,
             ${poReceiptMirrorSql('p')}           AS is_mirror
        FROM purchases p
        ${grnLineJoinSql('p', 'gl')}
       WHERE p.id IN (SELECT value FROM json_each(?))
    `)).all(JSON.stringify(ids)) as Record<string, unknown>[];

    const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const lines = rows.map((r) => {
      const line: Record<string, unknown> = { id: String(r.id) };
      for (const c of PURCHASE_CHARGE_COLUMNS) line[c.key] = n(r[c.key]);
      line.bill_value = n(r.bill_value);
      line.gst_base = n(r.gst_base);
      line.gst_base_accepted = n(r.gst_base_accepted) === 1 ? 1 : 0;
      line.total_amount = n(r.total_amount);
      const grnSourced = n(r.grn_sourced) === 1 ? 1 : 0;
      const isMirror = n(r.is_mirror) === 1 ? 1 : 0;
      const unpaired = isMirror === 1 && grnSourced === 0 ? 1 : 0;
      line.grn_sourced = grnSourced;
      line.is_mirror = isMirror;
      line.unpaired_mirror = unpaired;
      // A mirror whose GRN line is gone has NO charge figures to read — its
      // tax is unavailable, not zero, so it goes out null (blank on screen).
      // Same narrow rule as chargeCell(): null only while the figure is
      // exactly 0, so a blank can never swallow a rupee.
      const gst = gstValue({ cgst: line.cgst as number, sgst: line.sgst as number });
      line.tax_value = unpaired && !gst ? null : gst;
      // The base is the value GST was CHARGED on (gst_base), not the subtotal:
      // a PO receipt that accepted 8 of 10 @ ₹100 carries ₹144 — 18% of the
      // ₹800 accepted, and what the GRN Inward Register prints — where ₹144 ÷
      // the ₹1,000 received read 14.40%. Identical to bill_value on every line
      // that rejected nothing.
      line.gst_percent = taxAppliedPercent({
        cgst: line.cgst as number,
        sgst: line.sgst as number,
        discount: line.discount as number,
        bill_value: line.gst_base as number,
      });
      return line;
    });

    const found = new Set(lines.map((l) => l.id as string));
    const missing = ids.filter((id) => !found.has(id));
    return Response.json({ lines, missing });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return Response.json({ error: message || 'Failed to read purchase charges' }, { status: 500 });
  }
}
