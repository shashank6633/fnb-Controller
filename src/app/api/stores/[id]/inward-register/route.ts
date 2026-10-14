import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess, getStoreInwardRegister } from '@/lib/store-engine';
import { rateMovementForStore, type LqRateVarianceRow } from '@/lib/liquor-recon';

/**
 * GET /api/stores/[id]/inward-register?from=YYYY-MM-DD&to=YYYY-MM-DD[&recon=1]
 * Flat inward register (one row per purchase LINE) in the TGBCL sheet's column
 * order. Per-line charges ride the ledger row; the four bill-level charges are
 * allocated per line so Σ(total_inward) = the bill's Net Indent Value.
 * Gate: userStoreAccess(...).can_view.
 *
 * ── PHASE L1 ADDITION: RATE-VS-MASTER VARIANCE + LANDED COST ────────────────
 * The register can also answer `recon` — one entry per line, keyed by its
 * store_stock_ledger id — carrying the TGBCL brand-map rate, the variance
 * between it and the rate this line actually arrived at, and the line's landed
 * cost per bottle. `line_ids[i]` names the ledger row behind `rows[i]`, so a
 * caller joins by id and never by position.
 *
 * ADDITIVE ONLY. `rows` is byte-for-byte what it was before: same function,
 * same columns, same numbers. Anything reading only `rows` (the Liquor Store
 * page's CSV download) is untouched.
 *
 * ── THREE RULES THAT KEEP A DEPLOYED ENDPOINT DEPLOYED ───────────────────────
 * This route shipped in f732956 and its ONE existing caller — the Liquor Store
 * page's "download inward register" button — reads `j.rows` and discards
 * everything else. So the L1 block is fenced three ways:
 *
 *  a. OPT-IN, NOT OPT-OUT. `recon=1` asks for it; anything else (including the
 *     existing caller, which sends no such param and whose date inputs default
 *     to blank = the whole history) gets exactly the pre-L1 body and exactly
 *     the pre-L1 cost. Measured on a 24,006-row store ledger: 0.20s / 1.5MB
 *     without, 5.8s / 4.4MB with. Defaulting it ON made a caller that wants
 *     none of it pay all of it.
 *  b. ADMIN ONLY. masterRate / proposedRatePerCase / landedPerBottle are the
 *     same TGBCL master figures /api/liquor/brand-map refuses to non-admins on
 *     every verb (see its _lib/guard.ts and the reason written there). Serving
 *     them here to anyone with can_view would have been a second, softer door
 *     onto the same data. Non-admins get `rows` plus recon_available:false.
 *  c. FAIL-SOFT. The recon block runs in its OWN try/catch: if anything in it
 *     throws — a missing lq_ table on a database whose migration half-ran (the
 *     lq_ block in db.ts swallows per-statement errors and only logs), a future
 *     change inside liquor-recon.ts — the register still returns 200 with its
 *     rows, and says recon_available:false. A deployed CSV download must not
 *     stop working because an analytics add-on failed.
 *
 * ⚠️ TWO THINGS THE RECON BLOCK DOES DIFFERENTLY FROM `rows`, BOTH DELIBERATE
 * and reported rather than reconciled by changing deployed behaviour:
 *
 *  1. MRP ROUNDING IS ALLOCATED BY BOTTLES in `recon`, and BY LINE VALUE in
 *     `rows`. The workbook (and therefore the L0 contract in
 *     src/lib/liquor-recon.ts) allocates that one levy by bottles because it is
 *     a per-bottle rounding; getStoreInwardRegister() has allocated all four by
 *     line value since f732956. PER-BILL TOTALS ARE IDENTICAL either way — only
 *     the per-line split differs — so the Net Indent check is unaffected and
 *     `rows` was NOT changed here. Changing it would silently move the
 *     mrp_round_off column on every historical line, which is the owner's call.
 *  2. RECON ALLOCATES WHOLE BILLS. `rows` allocates across only the lines
 *     inside the date filter, so a bill straddling the range boundary
 *     mis-splits its levies there; recon always reads the complete bill.
 *
 * LINE IDS ARE RE-QUERIED HERE, with the same JOIN, WHERE and ORDER BY as
 * getStoreInwardRegister's own row query, because that function does not return
 * the ledger id and it lives in a shared file this phase does not own. If that
 * query is ever changed, this one must change with it — an index mismatch
 * would put one line's variance on another line's row. THE PAIRING IS CHECKED
 * ROW BY ROW, not by length: the mirror also reads the item name and invoice
 * ref, and every row must match the register's own before a single variance is
 * published. A pure ORDER BY drift keeps the counts equal, so counting alone
 * would not have noticed it.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id: storeId } = await params;
    const db = getDb();

    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });

    const url = new URL(request.url);
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    // OPT-IN (rule a above). No param = the pre-L1 body, at the pre-L1 cost.
    const wantRecon = url.searchParams.get('recon') === '1';
    const rows = getStoreInwardRegister(db, storeId, from || undefined, to || undefined);

    if (!wantRecon) {
      return Response.json({ store: { id: store.id, name: store.name }, rows });
    }

    const withheld = (note: string) => Response.json({
      store: { id: store.id, name: store.name },
      rows, line_ids: [], recon: [], recon_available: false, recon_note: note,
    });

    // ADMIN ONLY (rule b above) — the same bar /api/liquor/brand-map applies to
    // these figures on every verb. Not a 403: the register itself is allowed.
    if (user.role !== 'admin') {
      return withheld('Rate-vs-master and landed cost are admin-only — the TGBCL master re-prices every future indent. The register itself is unaffected.');
    }

    try {
      // Mirror of getStoreInwardRegister's row query — same JOIN, WHERE and
      // ORDER BY. It also reads the two fields the register echoes back, so the
      // pairing can be checked row by row instead of by length.
      const where: string[] = ['l.store_id = ?', "l.txn_type = 'purchase'"];
      const args: any[] = [storeId];
      if (from) { where.push('date(l.created_at) >= date(?)'); args.push(from); }
      if (to) { where.push('date(l.created_at) <= date(?)'); args.push(to); }
      const mirror = db.prepare(`
        SELECT l.id, TRIM(l.ref) AS invoice_ref, rm.name AS item
        FROM store_stock_ledger l
        JOIN raw_materials rm ON rm.id = l.material_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.created_at DESC, l.rowid DESC
      `).all(...args) as any[];

      // A mismatch means the mirrored query drifted from store-engine's. Say so
      // and drop the recon rather than pair the wrong numbers together.
      const aligned = mirror.length === rows.length && mirror.every((m, i) =>
        String(m.item || '') === String(rows[i].item || '')
        && String(m.invoice_ref || '') === String(rows[i].invoice_ref || ''));
      if (!aligned) {
        return withheld('Recon was withheld: the line-id query no longer matches getStoreInwardRegister. See the comment in this route.');
      }
      const lineIds = mirror.map(m => String(m.id));

      const movement = rateMovementForStore(db, storeId, from || undefined, to || undefined);
      const byLedger: Record<string, LqRateVarianceRow> = {};
      for (const m of movement) byLedger[m.ledgerId] = m;

      return Response.json({
        store: { id: store.id, name: store.name },
        rows,
        line_ids: lineIds,
        recon: lineIds.map(id => byLedger[id] ?? null),
        recon_available: true,
        recon_note: 'recon[i] describes rows[i]; null means the line is outside the recon read (it has no invoice ref).',
      });
    } catch (reconErr: any) {
      // FAIL-SOFT (rule c above): the register is deployed, the recon is not.
      console.error('[/api/stores/[id]/inward-register recon]', reconErr);
      return withheld(`Recon was withheld: ${String(reconErr?.message || 'it could not be computed')}. The register rows are unaffected.`);
    }
  } catch (e: any) {
    console.error('[/api/stores/[id]/inward-register GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
