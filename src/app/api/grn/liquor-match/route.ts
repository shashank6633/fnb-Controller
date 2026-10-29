import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getStoreById, userStoreAccess } from '@/lib/store-engine';
import { findIndentOnStoreRail, liquorGrnStores, matchLiquorCsvRows } from '@/lib/liquor-grn';

/**
 * POST /api/grn/liquor-match — match a TGBCL invoice CSV to a store's items
 * for the Goods Receipt → TGBCL Liquor Bill form. READ-ONLY: it writes
 * nothing. The form fills its lines from `lines`, shows `skipped_rows` with
 * their reasons (and offers them back as a "balance" CSV), and saves through
 * POST /api/grn like any hand-typed liquor bill.
 *
 * Auth: a signed-in session with can_procure on the store (userStoreAccess —
 * the same gate the save applies). SELF-AUTHENTICATES: src/proxy.ts guards
 * pages, not APIs.
 *
 * body: { store_id?, invoice_ref?, exclude_material_ids?: string[],
 *         rows: [{ item_name, sku, cases, bottles, loose, unit_price, per_case,
 *                  amount, discount, delivery_charges, cgst, sgst, batch_no,
 *                  expiry_date, inward_no, date }] }
 * store_id may be left out only when exactly one store is on offer to the
 * caller (active, owns categories, can_procure).
 *
 * → 200 { store:{id,name}, indent_no, indent_taken: null | {message},
 *         lines:[…], skipped_rows:[…] } — see matchLiquorCsvRows.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object') return Response.json({ error: 'A JSON body is required.' }, { status: 400 });

    let storeId = String(b.store_id || '').trim();
    if (!storeId) {
      const offered = liquorGrnStores(db, me).filter(s => s.can_procure);
      if (offered.length !== 1) {
        return Response.json({
          error: offered.length === 0
            ? 'You are not authorised to receive into any store location (Settings → Store Locations → user access, \'procure\').'
            : 'Choose the store this bill is for.',
        }, { status: offered.length === 0 ? 403 : 400 });
      }
      storeId = offered[0].id;
    }
    const store = getStoreById(db, storeId);
    if (!store) return Response.json({ error: 'Store not found' }, { status: 404 });
    if (!store.is_active) {
      return Response.json({ error: `${store.name} is deactivated — reactivate it in Settings → Store Locations before entering its bills.` }, { status: 400 });
    }
    if (!userStoreAccess(db, me, storeId).can_procure) {
      return Response.json({
        error: `You are not authorised to receive into ${store.name} (Settings → Store Locations → user access, 'procure').`,
      }, { status: 403 });
    }
    if (!Array.isArray(b.rows) || b.rows.length === 0) {
      return Response.json({ error: 'rows array is required (at least one CSV line)' }, { status: 400 });
    }
    if (b.rows.length > 2000) {
      return Response.json({ error: 'That sheet has more than 2,000 rows — one TGBCL indent is far smaller. Upload one bill at a time.' }, { status: 400 });
    }

    const out = matchLiquorCsvRows(db, {
      storeId, storeName: store.name, rows: b.rows,
      invoiceRef: String(b.invoice_ref || ''),
      excludeMaterialIds: Array.isArray(b.exclude_material_ids) ? b.exclude_material_ids.map((x: any) => String(x || '')) : [],
    });
    // The same one-door-per-indent guard the save applies, run now so the
    // form can say so before anyone types more.
    const taken = out.indent_no ? findIndentOnStoreRail(db, storeId, out.indent_no) : null;

    return Response.json({
      store: { id: store.id, name: store.name },
      indent_no: out.indent_no,
      indent_taken: taken ? { message: taken.message, ...(taken.grn_number ? { existing_grn_number: taken.grn_number } : {}) } : null,
      lines: out.lines,
      skipped_rows: out.skipped_rows,
    });
  } catch (e: any) {
    console.error('[/api/grn/liquor-match POST]', e);
    return Response.json({ error: e?.message || 'Match failed' }, { status: 500 });
  }
}
