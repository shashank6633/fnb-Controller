import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { invoiceFromNotes } from '@/lib/purchase-reconciliation';

/**
 * REPAIR: recover vendor invoice numbers into `purchases.bill_no`.
 *
 * POST /api/admin/repair-purchase-bill-no        → DRY RUN (default). Changes nothing.
 * POST /api/admin/repair-purchase-bill-no  body: { "dry_run": false, "confirm": "APPLY" }
 *
 * ADMIN ONLY. DRY RUN BY DEFAULT. NEVER RUNS ON BOOT. NEVER RUNS ITSELF.
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-10.
 *
 * WHAT IS BROKEN
 * The inward importer parsed the sheet's INVOICE ID and then dropped it: its
 * INSERT had no bill_no column, so the number survived only as prose inside
 * `notes` — "Invoice: 19162 · Inward: 4633". Bill views key a bill by
 * invoice_id → grn_id → bill_no and fall back to VENDOR+DAY when all three are
 * blank, so those rows merged: on the copy this was measured against, 2,118 of
 * 2,165 rows had no bill identity, 60 vendor-day lines were each hiding 2-4
 * genuinely different invoices, and 69 separate vendor bills worth
 * ₹12,93,120.30 could not be seen as separate. The writer is fixed
 * (src/app/api/inward-import/commit/route.ts); this repairs what it already
 * wrote.
 *
 * WHY THIS IS AN EXPLICIT ADMIN ACTION AND NOT A MIGRATION
 * `bill_no` is not a derived cache — it is a fact about a vendor's document,
 * and this repair infers it by PARSING PROSE. That is exactly the kind of write
 * that must never happen behind a deploy: scripts/check-boot-migrations.js
 * exists in this repo because recompute-on-boot silently reverted admin
 * decisions before, and the owner's standing rule is that no shipped change
 * gets undone without approval. So a human reads the dry run, sees the exact
 * rows and the exact numbers, and decides.
 *
 * WHAT IT WILL NOT DO
 *  • Never overwrites a non-empty bill_no. Only '' / NULL are candidates.
 *  • Never touches a row whose notes carry no recoverable "Invoice: …".
 *  • Never invents a number, never normalises one, never merges two.
 *  • Writes nothing at all unless dry_run is explicitly false AND confirm is
 *    the literal string "APPLY". Two independent flags, because one careless
 *    `{"dry_run":false}` should not be enough to mutate 2,118 rows.
 *  • Idempotent: after a successful apply the same call finds 0 candidates.
 *
 * TWO DUPLICATE GUARDS READ THIS COLUMN — check both before writing it.
 *  · /api/purchases scopes its (vendor, bill_no, date, outlet) duplicate check
 *    with `COALESCE(invoice_id,'') LIKE 'PINV-%'`, and imported rows never
 *    mint an invoice_id, so that guard never judges them, whether or not they
 *    carry a bill_no. Filling it in cannot make it wrongly refuse a
 *    hand-entered bill.
 *  · /api/purchases/bulk DOES judge them, and reads a stored BLANK bill_no as
 *    "matches any bill". After APPLY, a bulk CSV line with the same item +
 *    vendor + date + qty + rate as a repaired row is still refused on that
 *    row's bill number or a blank one, but a line carrying a DIFFERENT bill
 *    number is inserted and its stock counted; before APPLY it was refused.
 *    That is the bulk route's own rule for two named bills, which the blank
 *    used to mask. And the reverse: a bulk line naming the SAME bill for the
 *    same material at another qty or rate, inserted before APPLY, is refused
 *    after it (one material = one line on a named bill). The repair write
 *    itself moves no stock (below).
 *
 * NO STOCK, NO MONEY, NO LEDGER. This writes one text column. Quantities,
 * rates, totals, charges and every inventory row are untouched — which is why
 * the report's SPEND figures are identical before and after. What changes is
 * only how many BILLS the bill views can tell apart.
 */
export const dynamic = 'force-dynamic';

interface Candidate {
  id: string;
  vendor: string;
  date: string;
  proposed_bill_no: string;
  goods: number;
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({} as any));
    // DEFAULT-SAFE: anything other than an explicit `false` is a dry run.
    const dryRun = body?.dry_run !== false;
    const confirmed = String(body?.confirm || '') === 'APPLY';

    const db = getDb();

    // Candidates: no bill identity of any kind, but a recoverable invoice
    // number sitting in notes. `invoice_id`/`grn_id` blank is part of the test —
    // a row that already groups correctly must not be disturbed.
    const rows = db.prepare(`
      SELECT id, COALESCE(vendor, '') AS vendor, date, notes,
             COALESCE(total_price, 0) AS goods
        FROM purchases
       WHERE TRIM(COALESCE(bill_no,    '')) = ''
         AND TRIM(COALESCE(invoice_id, '')) = ''
         AND TRIM(COALESCE(grn_id,     '')) = ''
         AND notes LIKE '%Invoice:%'
       ORDER BY date, vendor
    `).all() as any[];

    const candidates: Candidate[] = [];
    let skipped_unparseable = 0;
    for (const r of rows) {
      const inv = invoiceFromNotes(r.notes);
      if (!inv) { skipped_unparseable++; continue; }
      candidates.push({
        id: String(r.id), vendor: String(r.vendor), date: String(r.date),
        proposed_bill_no: inv, goods: Number(r.goods) || 0,
      });
    }

    // THE POINT OF THE REPAIR, quantified: how many bill lines the affected
    // vendor-days collapse to now, and how many they will separate into after.
    // Reported so the reviewer sees the OUTCOME, not just a row count.
    const dayKey = (c: Candidate) => `${c.vendor.trim().toLowerCase()}|${c.date}`;
    const before = new Set<string>();
    const after = new Set<string>();
    for (const c of candidates) {
      before.add(dayKey(c));
      after.add(`${dayKey(c)}|${c.proposed_bill_no.toLowerCase()}`);
    }

    const preview = {
      candidate_rows: candidates.length,
      skipped_unparseable,
      distinct_invoice_numbers: new Set(candidates.map(c => c.proposed_bill_no)).size,
      bill_lines_before: before.size,
      bill_lines_after: after.size,
      bills_recovered: after.size - before.size,
      goods_value_touched: Math.round(candidates.reduce((a, c) => a + c.goods, 0) * 100) / 100,
      // Enough rows to actually audit the inference, not a token sample.
      sample: candidates.slice(0, 25),
    };

    if (dryRun || !confirmed) {
      return Response.json({
        mode: 'dry_run',
        applied: false,
        ...preview,
        // Say plainly what it would take to run it — an admin should not have to
        // read the source to find the second flag.
        how_to_apply: 'POST again with body {"dry_run": false, "confirm": "APPLY"}',
        reason_not_applied: dryRun
          ? 'dry_run defaults to true; nothing was written.'
          : 'confirm must be the literal string "APPLY"; nothing was written.',
      });
    }

    // APPLY. One transaction: either every recovered number lands or none does,
    // so a failure halfway cannot leave the bill views half-merged.
    const upd = db.prepare(
      `UPDATE purchases
          SET bill_no = ?
        WHERE id = ?
          AND TRIM(COALESCE(bill_no, '')) = ''`,   // re-checked inside the write
    );
    const txn = db.transaction((list: Candidate[]) => {
      let n = 0;
      for (const c of list) n += upd.run(c.proposed_bill_no, c.id).changes;
      return n;
    });
    const updated = txn(candidates);

    return Response.json({
      mode: 'apply',
      applied: true,
      updated_rows: updated,
      ...preview,
      note: 'purchases.bill_no only. No stock, rate, total, charge or ledger row was touched — spend totals are unchanged by design; bill COUNTS separate.',
    });
  } catch (e: any) {
    console.error('[/api/admin/repair-purchase-bill-no]', e);
    return Response.json({ error: e?.message || 'Repair failed' }, { status: 500 });
  }
}
