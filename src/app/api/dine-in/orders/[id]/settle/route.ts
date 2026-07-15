import { getDb, recordSale } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import { computeBill, sumItemTax } from '@/lib/bill-calc';
import { resolveFloorStore } from '@/lib/store-engine';

const VALID_METHODS = ['cash', 'upi', 'card'];

/**
 * Read the 'bill_design' setting (JSON) and pull out the numbers computeBill
 * needs (service charge on/off + pct, cgst/sgst pct). Missing/garbled JSON
 * falls back to safe defaults so settling never breaks on a bad setting.
 */
function loadBillDesign(db: ReturnType<typeof getDb>) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bill_design'").get() as any;
  let d: any = {};
  if (row?.value) { try { d = JSON.parse(row.value) || {}; } catch { d = {}; } }
  return {
    serviceChargeOn: d.serviceChargeOn !== false,
    serviceChargePct: Number(d.serviceChargePct) || 0,
    cgstPct: d.cgstPct == null ? 2.5 : Number(d.cgstPct) || 0,
    sgstPct: d.sgstPct == null ? 2.5 : Number(d.sgstPct) || 0,
  };
}

/**
 * Settle an open order: write one `sales` row per line item (deducting inventory
 * via recordSale) and close the order — all in one transaction so a failure can't
 * half-write. Body: { payment_method: 'cash' | 'upi' | 'card' }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    const b = await req.json().catch(() => ({}));
    const method = String(b.payment_method || '').toLowerCase();
    if (!VALID_METHODS.includes(method)) {
      return Response.json({ error: `payment_method must be one of ${VALID_METHODS.join(', ')}` }, { status: 400 });
    }

    const date = todayIST();
    const saleTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

    // Compute the authoritative bill breakdown (service charge, discount, taxes,
    // total) from the current order + the bill_design settings, so the stored
    // totals match exactly what the printed bill renders via the same helper.
    const billDesign = loadBillDesign(db);
    const bill = computeBill(
      {
        subtotal: order.subtotal,
        itemTax: sumItemTax(items),   // per-item GST (food 5% / liquor 0%)
        serviceRemoved: !!order.service_charge_reason,
        discount_pct: order.discount_pct,
        discount: order.discount,
      },
      billDesign,
    );
    const taxTotal = Math.round((bill.cgst + bill.sgst) * 100) / 100;

    // FAIL-SAFE floor routing (Multi-floor bar Phase 2/3): resolve this order's
    // floor bar store from its table zone ONCE. The settle deduct is only a
    // backstop for items not already deducted at KOT-complete; recordSale gates
    // the actual store posting on tm_floor_autodeduct and ignores store_id when
    // skip_inventory is set. Any failure / unmapped zone → undefined → central.
    let floorStoreId: string | undefined;
    try {
      const zoneRow = order.table_id
        ? db.prepare('SELECT zone FROM restaurant_tables WHERE id = ?').get(order.table_id) as any
        : null;
      floorStoreId = resolveFloorStore(db, zoneRow?.zone) || undefined;
    } catch (e) {
      console.error('[settle floor-resolve]', id, e);
      floorStoreId = undefined;
    }

    const settle = db.transaction(() => {
      for (const it of items) {
        // pos_id from the menu item (stable link); fall back to none.
        const mi = it.menu_item_id
          ? db.prepare('SELECT pos_id FROM menu_items WHERE id = ?').get(it.menu_item_id) as any
          : null;
        recordSale(db, {
          item_name: it.name,
          recipe_id: it.recipe_id,
          quantity_sold: it.quantity,
          // Already consumed at KOT-complete? Record the sale (revenue) but don't
          // deduct stock again. Not-yet-completed items (e.g. quick-settled without
          // a KDS bump) still deduct here as the backstop.
          skip_inventory: !!it.recipe_deducted_at,
          // Route the backstop deduct to the floor bar store (no-op unless
          // tm_floor_autodeduct is on and skip_inventory is false).
          store_id: floorStoreId,
          bill_type: order.bill_type || 'normal',
          selling_price: it.unit_price,
          date,
          sale_time: saleTime,
          order_id: order.id,
          category: it.station || null,
          server: order.server_name || null,
          order_type: order.order_type || 'dine-in',
          pos_item_id: mi?.pos_id || null,
          pos_item_name: it.name,
          outlet_id: outletId,
        });
      }
      // Store the computed breakdown before marking settled so the settled row
      // is the single source of truth for the charged amounts.
      db.prepare(`
        UPDATE orders SET status = 'settled', payment_method = ?,
          service_charge = ?, discount = ?, tax_total = ?, total = ?,
          settled_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(method, bill.serviceCharge, bill.discount, taxTotal, bill.total, id);
    });
    settle();

    return Response.json({ success: true, order_id: id, total: bill.total, payment_method: method, lines: items.length });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/settle]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
