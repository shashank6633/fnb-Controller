import { getDb, generateId } from '@/lib/db';
import { resolveTableByToken, priceLookup, getCustomerMenuDesign, otpAppliesToTable } from '@/lib/customer';
import { normMobile, otpChannelReady, hasVerifiedMobile, recentSendFailed, otpSendExhausted } from '@/lib/customer-otp';
import { fireStagingOrder } from '@/lib/kot-fire';
import { raiseKotAlert } from '@/lib/kot-alerts';
import { emitKds } from '@/lib/kds-bus';

const MAX_LINES = 60;      // sanity caps — a prank can't create a huge order
const MAX_QTY_PER_LINE = 40;

/**
 * POST /api/customer/orders   (PUBLIC — table-token scoped)
 *
 * A guest submits their cart from the QR menu. We always create the order with
 * origin 'customer'; what happens next depends on the QR Ordering Mode (Settings
 * → Customer Menu Page Design):
 *   - 'captain' (default): the order stays 'pending_approval' — nothing fires and
 *     no bill exists yet. The Captain reviews it in the approval queue and
 *     Approve/Reject/Modify (see /api/dine-in/customer-orders). Only on approval
 *     do the items fire to the KDS.
 *   - 'direct': the guest already confirmed on their phone, so we fire the KOT
 *     straight to the kitchen (shared fireStagingOrder — promote to 'open',
 *     assign a daily number / merge one-bill-per-table, emit to the KDS). No
 *     captain step.
 *
 * Body: { t: <qr_token>, items: [{ id, qty, note? }], note?: string }
 * Prices, tax %, station and name are ALWAYS re-read from menu_items — never
 * trusted from the client.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const token = String(body?.t || body?.table || '').trim();
    const table = resolveTableByToken(token);
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });

    const rawItems: any[] = Array.isArray(body?.items) ? body.items : [];
    if (!rawItems.length) return Response.json({ ok: false, error: 'Your cart is empty.' }, { status: 400 });
    if (rawItems.length > MAX_LINES) return Response.json({ ok: false, error: 'Too many items — please ask a server.' }, { status: 400 });

    // Collapse duplicate (id + per-line note) lines, clamp quantities. The note
    // carries the chosen variant (e.g. "Chilled") so it reaches the KOT — and two
    // notes on the same item (Normal vs Chilled water) stay as SEPARATE lines.
    const wanted = new Map<string, { id: string; qty: number; note: string }>();
    for (const it of rawItems) {
      const id = String(it?.id || '').trim();
      const qty = Math.min(MAX_QTY_PER_LINE, Math.max(1, Math.floor(Number(it?.qty) || 0)));
      const lnote = String(it?.note || '').slice(0, 120).trim();
      if (!id || qty <= 0) continue;
      const key = id + '|' + lnote;
      const cur = wanted.get(key);
      wanted.set(key, { id, qty: Math.min(MAX_QTY_PER_LINE, (cur?.qty || 0) + qty), note: lnote });
    }
    if (!wanted.size) return Response.json({ ok: false, error: 'Your cart is empty.' }, { status: 400 });

    const prices = priceLookup([...new Set([...wanted.values()].map(w => w.id))]);
    const lines = [...wanted.values()]
      .map(w => ({ id: w.id, qty: w.qty, note: w.note, mi: prices.get(w.id) }))
      .filter(l => l.mi); // drop items that no longer exist / are inactive
    if (!lines.length) return Response.json({ ok: false, error: 'These items are no longer available.' }, { status: 409 });

    const db = getDb();
    const note = String(body?.note || '').slice(0, 300);
    const orderId = generateId();

    // ── WhatsApp OTP gate (Settings → Customer Menu, otpMode) ────────────────
    // Require a verified mobile before a captain-less order fires. If the OTP
    // channel isn't ready (WhatsApp not connected / no template / provider down)
    // we NEVER block — the order falls back to captain approval instead.
    const design = getCustomerMenuDesign();
    const orderMode = design.orderMode;
    const reqMobile = normMobile(body?.mobile);
    // Guest name from the details page — for the bill/captain's reference. Saved
    // whenever provided (any mode), never trusted for anything security-relevant.
    const guestName = String(body?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    // OTP is MANDATORY only where a captain-less order would fire: direct mode,
    // on a table the admin put in scope (all / selected floors / selected tables).
    // Everywhere else the details page is an optional ask — never a gate.
    const otpRequired = design.otpMode === 'direct' && orderMode === 'direct'
      && otpAppliesToTable(design, { id: table.id, zone: table.zone, section: table.section });
    let guestMobile = '';
    let forceCaptain = false;
    if (otpRequired) {
      if (otpChannelReady()) {
        if (reqMobile && hasVerifiedMobile(db, table.id, reqMobile)) {
          guestMobile = reqMobile;
        } else if (reqMobile && (recentSendFailed(db, table.id, reqMobile) || otpSendExhausted(db, table.id, reqMobile))) {
          // Channel LOOKS ready but this guest genuinely cannot verify right now:
          // either the provider just bounced their code (expired token / paused
          // template) or the send rate caps are exhausted. Don't 428 them into a
          // verify loop they can never pass — fall back to captain approval.
          forceCaptain = true;
          guestMobile = reqMobile;       // unverified, kept for reference
        } else {
          return Response.json({ ok: false, needs_otp: true, error: 'Please verify your mobile number to place this order.' }, { status: 428 });
        }
      } else {
        forceCaptain = true;             // fall back to captain approval, never block
        guestMobile = reqMobile || '';   // keep the typed number (unverified) for reference
      }
    } else {
      guestMobile = reqMobile || '';     // OTP off — still keep a shared number if the guest gave one
    }

    const create = db.transaction(() => {
      // Staging order: order_number 0 until the Captain approves (a real daily
      // number is only assigned on approval so rejected orders don't burn one).
      db.prepare(`
        INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, bill_type,
                            covers, server_id, server_name, guest_name, guest_mobile,
                            origin, notes, subtotal, tax_total, total, created_at, updated_at)
        VALUES (?, ?, 0, ?, 'pending_approval', 'dine-in', 'normal',
                0, '', 'Customer', ?, ?, 'customer', ?, 0, 0, 0, datetime('now'), datetime('now'))
      `).run(orderId, table.outlet_id, table.id, guestName, guestMobile, note);

      const insItem = db.prepare(`
        INSERT INTO order_items (id, order_id, menu_item_id, recipe_id, name, station,
                                 quantity, unit_price, tax_value, line_total, status, prep_minutes, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
      `);
      let subtotal = 0;
      for (const l of lines) {
        const lineTotal = Math.round(l.mi!.unit_price * l.qty * 100) / 100;
        subtotal += lineTotal;
        insItem.run(
          generateId(), orderId, l.id, l.mi!.recipe_id, l.mi!.name, l.mi!.station,
          l.qty, l.mi!.unit_price, l.mi!.tax_value, lineTotal, l.mi!.prep_minutes, l.note || '',
        );
      }
      const sub = Math.round(subtotal * 100) / 100;
      db.prepare('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?').run(sub, sub, orderId);
      return sub;
    });
    const subtotal = create();

    // Direct ordering: the guest confirmed on their phone → fire the KOT now.
    // Captain mode (or OTP fallback): leave it pending for the captain to review.
    if (orderMode === 'direct' && !forceCaptain) {
      try {
        const fired = fireStagingOrder(db, orderId, { firedBy: 'QR Order', serverId: '' });
        for (const k of fired.firedKots) emitKds({ type: 'kot.new', outlet_id: k.outlet_id, station: k.station, kot: k });
        return Response.json({
          ok: true,
          orderId: fired.targetId,
          status: 'open',            // fired to the kitchen — customer sees "Preparing"
          mode: 'direct',
          subtotal: fired.subtotal,
          lines: lines.length,
        });
      } catch (e: any) {
        // If firing fails, the order still exists as pending_approval — a captain
        // can recover it. Raise a KOT alert so the respective captain + floor
        // manager are told immediately, then surface a soft error to the guest.
        console.error('[/api/customer/orders POST direct-fire]', e);
        try {
          raiseKotAlert(db, {
            orderId, outletId: table.outlet_id, tableNumber: String(table.table_number || ''),
            kind: 'fire_failed', createdBy: 'QR Order',
            reason: `Self-order from Table ${table.table_number || '?'} could not reach the kitchen — needs manual firing.`,
          });
        } catch (ae) { console.error('[/api/customer/orders POST fire-alert]', ae); }
        return Response.json({ ok: false, error: 'Could not send your order to the kitchen. Please ask our staff.' }, { status: 500 });
      }
    }

    return Response.json({
      ok: true,
      orderId,
      status: 'pending_approval',
      mode: 'captain',
      subtotal,
      lines: lines.length,
    });
  } catch (e: any) {
    console.error('[/api/customer/orders POST]', e);
    return Response.json({ ok: false, error: 'Could not place your order. Please try again.' }, { status: 500 });
  }
}

/**
 * GET /api/customer/orders?t=<qr_token>   (PUBLIC)
 * The table's active orders (pending_approval + open) with line items, so the
 * menu app can show a running tab and reflect approval status.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('t') || url.searchParams.get('table') || '';
    const table = resolveTableByToken(token);
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });

    const db = getDb();
    const orders = db.prepare(`
      SELECT id, order_number, status, subtotal, total, created_at
      FROM orders
      WHERE table_id = ? AND status IN ('pending_approval','open')
      ORDER BY created_at ASC
    `).all(table.id) as any[];

    const itemStmt = db.prepare('SELECT name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?');
    const out = orders.map(o => ({
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      subtotal: o.subtotal,
      total: o.total,
      created_at: o.created_at,
      items: (itemStmt.all(o.id) as any[]).map(i => ({
        name: i.name, qty: i.quantity, price: i.unit_price, line_total: i.line_total,
      })),
    }));

    const runningTab = out.reduce((s, o) => s + (Number(o.subtotal) || 0), 0);
    return Response.json({ ok: true, table: { number: table.table_number }, orders: out, runningTab }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    console.error('[/api/customer/orders GET]', e);
    return Response.json({ ok: false, error: 'Could not load orders.' }, { status: 500 });
  }
}
