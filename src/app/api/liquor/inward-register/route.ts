import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess, getStoreInwardRegister } from '@/lib/store-engine';
import { rateMovementForStore, type LqRateVarianceRow } from '@/lib/liquor-recon';

/**
 * GET /api/liquor/inward-register?store_id=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * ── PHASE L1: RATE-VS-MASTER VARIANCE + LANDED COST, LINE BY LINE ───────────
 * The store's inward register (the SAME rows GET /api/stores/[id]/inward-register
 * returns) plus `recon`: one entry per line, keyed by its store_stock_ledger id,
 * carrying the TGBCL brand-map rate, the variance between it and the rate this
 * line actually arrived at, and the line's landed cost per bottle. `line_ids[i]`
 * names the ledger row behind `rows[i]`, so a caller joins by id and never by
 * position.
 *
 * WHY THIS IS ITS OWN ROUTE. It used to be an opt-in `recon=1` block inside
 * /api/stores/[id]/inward-register. That route is DEPLOYED (f732956, the Liquor
 * Store's "download inward register" button) and is not part of the gated
 * Liquor Reconciliation module, so its static import of liquor-recon.ts meant a
 * ship without liquor could not load it, and a liquor ship that left it out lost
 * this read. Here, under api/liquor/**, it ships with the module and only with
 * it; the deployed register route is back to production, byte for byte. The
 * body below is exactly what `?recon=1` returned. No client called `recon=1`.
 *
 * ── THE RULES IT KEEPS ──────────────────────────────────────────────────────
 *  a. THE REGISTER'S OWN GATE FIRST: signed in, the store exists, and
 *     userStoreAccess(...).can_view, exactly as the register route does.
 *  b. RECON IS ADMIN ONLY. masterRate / proposedRatePerCase / landedPerBottle
 *     are the same TGBCL master figures /api/liquor/brand-map refuses to
 *     non-admins on every verb (see its _lib/guard.ts and the reason written
 *     there). A non-admin with can_view gets `rows` plus recon_available:false
 *     and a note, not a 403: the register itself is theirs to read.
 *  c. FAIL-SOFT. The recon runs in its OWN try/catch: if anything in it throws
 *     (a missing lq_ table on a database whose migration half-ran, since the
 *     lq_ block in db.ts swallows per-statement errors and only logs, or a
 *     future change inside liquor-recon.ts), the response is still 200 with the
 *     register rows, and says recon_available:false.
 *
 * ⚠️ TWO THINGS THE RECON DOES DIFFERENTLY FROM `rows`, BOTH DELIBERATE, and
 * reported rather than reconciled by changing deployed behaviour:
 *
 *  1. MRP ROUNDING IS ALLOCATED BY BOTTLES in `recon`, and BY LINE VALUE in
 *     `rows`. The workbook (and therefore the L0 contract in
 *     src/lib/liquor-recon.ts) allocates that one levy by bottles because it is
 *     a per-bottle rounding; getStoreInwardRegister() has allocated all four by
 *     line value since f732956. PER-BILL TOTALS ARE IDENTICAL either way (only
 *     the per-line split differs), so the Net Indent check is unaffected and
 *     `rows` was NOT changed. Changing it would silently move the mrp_round_off
 *     column on every historical line, which is the owner's call.
 *  2. RECON ALLOCATES WHOLE BILLS. `rows` allocates across only the lines
 *     inside the date filter, so a bill straddling the range boundary
 *     mis-splits its levies there; recon always reads the complete bill.
 *
 * LINE IDS ARE RE-QUERIED HERE, with the same JOIN, WHERE and ORDER BY as
 * getStoreInwardRegister's own row query, because that function does not return
 * the ledger id and it lives in a shared file this module does not own. If that
 * query is ever changed, this one must change with it: an index mismatch would
 * put one line's variance on another line's row. THE PAIRING IS CHECKED ROW BY
 * ROW, not by length: the mirror also reads the item name and invoice ref, and
 * every row must match the register's own before a single variance is
 * published. A pure ORDER BY drift keeps the counts equal, so counting alone
 * would not notice it.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const url = new URL(request.url);
    const storeId = (url.searchParams.get('store_id') || '').trim();
    if (!storeId) return Response.json({ error: 'store_id is required' }, { status: 400 });
    const db = getDb();

    // Rule a: the register route's own gate, unchanged.
    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
    const access = userStoreAccess(db, user, storeId);
    if (!access.can_view) return Response.json({ error: `You are not authorized to view ${store.name}` }, { status: 403 });

    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const rows = getStoreInwardRegister(db, storeId, from || undefined, to || undefined);

    const withheld = (note: string) => Response.json({
      store: { id: store.id, name: store.name },
      rows, line_ids: [], recon: [], recon_available: false, recon_note: note,
    });

    // Rule b: ADMIN ONLY, the same bar /api/liquor/brand-map applies to these
    // figures on every verb. Not a 403: the register itself is allowed.
    if (user.role !== 'admin') {
      return withheld('Rate-vs-master and landed cost are admin-only — the TGBCL master re-prices every future indent. The register itself is unaffected.');
    }

    try {
      // Mirror of getStoreInwardRegister's row query: same JOIN, WHERE and
      // ORDER BY. It also reads the two fields the register echoes back, so the
      // pairing can be checked row by row instead of by length.
      const where: string[] = ['l.store_id = ?', "l.txn_type = 'purchase'"];
      const args: unknown[] = [storeId];
      if (from) { where.push('date(l.created_at) >= date(?)'); args.push(from); }
      if (to) { where.push('date(l.created_at) <= date(?)'); args.push(to); }
      const mirror = db.prepare(`
        SELECT l.id, TRIM(l.ref) AS invoice_ref, rm.name AS item
        FROM store_stock_ledger l
        JOIN raw_materials rm ON rm.id = l.material_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.created_at DESC, l.rowid DESC
      `).all(...args) as Array<{ id: string; invoice_ref: string | null; item: string | null }>;

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
    } catch (reconErr: unknown) {
      // Rule c: FAIL-SOFT. The register rows are still returned.
      console.error('[/api/liquor/inward-register recon]', reconErr);
      const msg = reconErr instanceof Error && reconErr.message ? reconErr.message : 'it could not be computed';
      return withheld(`Recon was withheld: ${msg}. The register rows are unaffected.`);
    }
  } catch (e: unknown) {
    console.error('[/api/liquor/inward-register GET]', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
