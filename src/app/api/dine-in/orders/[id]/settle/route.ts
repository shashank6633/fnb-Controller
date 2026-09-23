import { getDb, recordSale, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { settleAuthority, recordSettleOverride } from '@/lib/settle-authority';
import { todayIST } from '@/lib/format-date';
import { computeBill, sumItemTax, round2 } from '@/lib/bill-calc';
// resolveFloorStore is NOT imported any more: a settle no longer resolves — or
// posts to — a floor bar store (owner ruling 2026-09-10, see the deduct block).
import { completeBookingForOrder } from '@/lib/ct/seating';
import { closeServiceRequestsForOrder } from '@/lib/service-requests';
// BILLS ON HOLD. A held bill can carry collections already taken on its BOH
// record; this route used to collect the whole frozen total regardless, which
// charged the guest twice. bohTillNetting() is a pure read; absorbTillSettleIntoBoh()
// records the till's own collection in that ledger and closes the record.
import { bohTillNetting, absorbTillSettleIntoBoh } from '@/lib/boh';

// Payment methods the cashier can settle with. Split payments record one
// order_payments row per method; the sales dashboard's payment-category breakup
// aggregates these (falling back to orders.payment_method for legacy rows).
const VALID_METHODS = ['cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other'];

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
    // 'open' → full settle. 'on_hold' → payment-only (the sales/inventory + totals
    // were already finalised when the bill was put on hold).
    const fromHold = order.status === 'on_hold';
    if (order.status !== 'open' && !fromHold) return Response.json({ error: 'Order is not open' }, { status: 409 });

    // ── AUTHORIZATION ────────────────────────────────────────────────────────
    // Settling closes the bill, writes the sales rows, deducts stock and takes
    // the money, so who may do it is the owner's OVERRIDE model: the cashier
    // checked in on THIS bill's floor settles normally; manager/admin may
    // ALWAYS settle (recorded as an override below when a cashier held the
    // floor); other staff must be till-capable and hold the floor.
    // src/lib/settle-authority.ts is the single place that decides, and
    // /api/dine-in/orders/[id]/hold calls the identical function — hold freezes
    // these same totals and routes back through here, so gating one without the
    // other would leave hold as the bypass.
    //
    // WHAT THIS REPLACES: `!canApproveTableOp(me) && !canWorkTable(db, me,
    // order.table_id)`. canWorkTable() returns true for everyone unless the
    // setting captain_area_lock === '1', and that key has never existed in this
    // database and nothing seeds it — so the && was always false and this 403
    // was unreachable. Settle's real gate was "presents a session cookie".
    //
    // NOTHING HERE IS CLIENT-SUPPLIED, deliberately: the actor comes from the
    // session cookie via getCurrentUser(), the floor is re-derived server-side
    // from the ORDER's table_id, and this runs before req.json() is even read.
    // There is no body field, header or query param that can move it.
    //
    // The refusal carries `reason` and the offer flags rather than a bare
    // "Forbidden": a cashier standing at the counter with a guest waiting needs
    // to be told whose floor it is and that one tap checks them in.
    const auth = settleAuthority(db, me, order, outletId);
    if (!auth.allowed) {
      return Response.json({
        error: auth.message,
        reason: auth.reason,
        floor: auth.floor,
        floorName: auth.floorName,
        // Trimmed to the two fields the UI names the holder with, matching
        // request-bill's state(). The presence row also carries outletId,
        // checkedInAt and lastSeen — server-side bookkeeping a refused caller
        // has no use for and should not be handed.
        cashier: auth.cashier ? { userId: auth.cashier.userId, userName: auth.cashier.userName } : null,
        offerCheckIn: auth.offerCheckIn,
        offerTakeOver: auth.offerTakeOver,
      }, { status: auth.status });
    }

    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Order has no items' }, { status: 400 });

    const b = await req.json().catch(() => ({}));

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
    // A held bill's total was frozen at hold time — collect exactly that.
    const grand = Math.round(fromHold ? Number(order.total) : bill.total);

    // ── BILLS ON HOLD: NET OFF WHAT WAS ALREADY COLLECTED ────────────────────
    // A bill on hold can carry part-payments recorded on its BOH record (a
    // company that paid half on account, a guest who left a deposit). This
    // branch used to take `grand` — the WHOLE frozen bill — with no knowledge of
    // boh_payments, so the guest paid twice: measured live, Rs 200 on the BOH
    // plus Rs 681 at the till against a Rs 681 bill. The books were never
    // doubled (hold wrote the single sales row and deducted the stock; this
    // branch writes no sales row at all) — only the guest was.
    //
    // `collect` is what this till may still take. It is derived SERVER-SIDE from
    // the BOH ledger; no request field can move it. A bill with no BOH record —
    // every bill held before the module shipped — nets nothing and behaves
    // exactly as before.
    const bohNet = fromHold ? bohTillNetting(db, id, grand) : null;
    const collect = bohNet ? bohNet.dueNow : grand;
    if (bohNet && collect <= 0.005) {
      return Response.json({
        error:
          `₹${bohNet.alreadyPaid.toFixed(2)} has already been collected against this bill on its Bills-on-Hold record, ` +
          `which covers the whole ₹${grand} bill. There is nothing left to take here — ` +
          (bohNet.status === 'open'
            ? 'open the bill on hold and close it there.'
            : 'that record is already closed, so a manager should reconcile the bill in the POS rather than collecting again.'),
        boh_id: bohNet.bohId,
      }, { status: 409 });
    }

    // Resolve payment(s): either a split { payments: [{method, amount}] } that must
    // total the collectable amount, or a single { payment_method }. Validated here
    // so a mistyped split can never settle for the wrong money.
    let payments: { method: string; amount: number }[];
    const raw = Array.isArray(b.payments) ? b.payments : null;
    if (raw && raw.length) {
      payments = raw
        .map((p: any) => ({ method: String(p?.method || '').toLowerCase(), amount: round2(Number(p?.amount) || 0) }))
        .filter((p: any) => p.amount > 0);
      if (!payments.length) return Response.json({ error: 'No valid payment amounts' }, { status: 400 });
      for (const p of payments) {
        if (!VALID_METHODS.includes(p.method)) {
          return Response.json({ error: `Invalid payment method "${p.method}". Allowed: ${VALID_METHODS.join(', ')}` }, { status: 400 });
        }
      }
      const sum = round2(payments.reduce((s, p) => s + p.amount, 0));
      if (Math.abs(sum - collect) > 1) {
        return Response.json({
          error: bohNet
            ? `Split payments total ₹${sum}, but only ₹${collect} is still due on this bill — ` +
              `₹${bohNet.alreadyPaid.toFixed(2)} was already collected on its bill-on-hold record.`
            : `Split payments total ₹${sum} but the bill is ₹${grand}`,
        }, { status: 400 });
      }
      // ── A HELD BILL MAY NEVER BE SETTLED FOR MORE THAN IT OWES ───────────
      // MEASURED on a booted server (lane-A money probe, round 3): a ₹252 held
      // bill carrying ₹40 already collected on its BOH record settled for ₹213
      // against a ₹212 balance — HTTP 200. The guest paid ₹1 too much, the BOH
      // ledger summed to ₹253 against a ₹252 principal (a NEGATIVE balance on
      // the record, and a dashboard 'collected' figure larger than the bill),
      // and the order's own tenders came to ₹253 against an orders.total of
      // ₹252. Reproduced identically with ₹100 already collected, and on a held
      // bill with no partial at all.
      //
      // The ±₹1 slack above is there to forgive a split that ROUNDS. It also,
      // silently, forgave taking MORE than the guest owes — which is the one
      // thing this module exists to prevent ("Deduct BOH payments and charge
      // the balance" — the owner). recordBohPayment() already refuses exactly
      // this on the /api/boh side ("That is more than the outstanding balance");
      // the till door had no equivalent.
      //
      // ROUNDING IS STILL FORGIVEN. `collect` can carry paisa (a whole-rupee
      // frozen bill minus a part payment, e.g. ₹151.70), so a till that rounds
      // it to the nearest rupee moves it by at most ₹0.50 and is still accepted.
      // Beyond that it is a typo: /cashier's own split editor shows "Remaining"
      // and only reads Balanced at exactly zero. Under-collection keeps the full
      // ₹1 tolerance it had — this guard is one-sided on purpose.
      //
      // SCOPED TO THE HELD-BILL PATH. `bohNet` is non-null only for an order
      // that has a live Bills-on-Hold record, so an ordinary open-order settle —
      // and every bill held before this module ships — keeps the tolerance it
      // shipped with, byte for byte.
      if (bohNet && sum - collect > 0.5) {
        return Response.json({
          error:
            `Split payments total ₹${sum}, but only ₹${collect} is due on this bill` +
            (bohNet.alreadyPaid > 0.005
              ? ` — ₹${bohNet.alreadyPaid.toFixed(2)} was already collected on its bill-on-hold record. `
              : '. ') +
            `A bill on hold cannot be settled for more than it owes.`,
          boh_id: bohNet.bohId,
        }, { status: 400 });
      }
    } else {
      const method = String(b.payment_method || '').toLowerCase();
      if (!VALID_METHODS.includes(method)) {
        return Response.json({ error: `payment_method must be one of ${VALID_METHODS.join(', ')}` }, { status: 400 });
      }
      payments = [{ method, amount: collect }];
    }
    const primaryMethod = payments.length === 1 ? payments[0].method : 'split';

    // NO FLOOR STORE IS RESOLVED HERE ANY MORE (owner ruling, 2026-09-10).
    // A block here mapped this order's table zone → floor bar store and passed
    // it to recordSale as store_id, so the backstop deduct could post the pour
    // as an OUTWARD row on that store's ledger. A settle may not move stock at
    // store level: the backstop deduct goes to the DEPARTMENT that cooked the
    // line, or nowhere with a recorded skip. The floor's own figure is measured
    // by counting (/inventory/reconciliation), never inferred from the bill.
    // Held in an object rather than a plain `let`: the write happens inside the
    // transaction closure below, and TypeScript's control-flow analysis would
    // otherwise keep narrowing the variable to the `null` it was initialised to.
    const bohOut: { res: ReturnType<typeof absorbTillSettleIntoBoh> } = { res: null };
    const settle = db.transaction(() => {
      // A held bill already wrote its sales/inventory rows — don't double-write.
      const freshDeduct = db.prepare('SELECT recipe_deducted_at FROM order_items WHERE id = ?');
      const stampDeduct = db.prepare("UPDATE order_items SET recipe_deducted_at = datetime('now') WHERE id = ?");
      for (const it of (fromHold ? [] : items)) {
        // pos_id from the menu item (stable link); fall back to none.
        const mi = it.menu_item_id
          ? db.prepare('SELECT pos_id FROM menu_items WHERE id = ?').get(it.menu_item_id) as any
          : null;
        // Re-read the deduction stamp INSIDE the transaction: a KDS bump can
        // complete between the items read above and here (across the req.json()
        // await), and the stale row would otherwise deduct a second time.
        const alreadyDeducted = !!(freshDeduct.get(it.id) as any)?.recipe_deducted_at;
        recordSale(db, {
          item_name: it.name,
          recipe_id: it.recipe_id,
          quantity_sold: it.quantity,
          // Already consumed at KOT-complete? Record the sale (revenue) but don't
          // deduct stock again. Not-yet-completed items (e.g. quick-settled without
          // a KDS bump) still deduct here as the backstop.
          skip_inventory: alreadyDeducted,
          // DEPARTMENT ROUTING (deduct-at-issue): the recipe consumption debit now
          // leaves the DEPARTMENT that cooked the dish, not central — so the
          // backstop must resolve the same department the KDS bump would have.
          // Same field, same row, per line: order_items.station. The bump reads it
          // off the order_items rows under the KOT; we read it off the same rows
          // here, so a bumped order and a quick-settled one land in one department.
          //   - NEVER resolve from kots.station: a blank line station is coerced to
          //     the literal 'kitchen' when the KOT is written, and 'Kitchen' is a
          //     real department — that would silently debit the main kitchen for
          //     every station-less line.
          //   - NOT the `category` field above. It happens to carry the station on
          //     this route, but /api/sales-import puts the Recaho menu CATEGORY
          //     there; a future engineer "simplifying" the two into one field would
          //     hand deductInventoryForSale 'Starters' as a station.
          //   - Blank / unmapped (sushi, terracegrill) / liquor stations: the
          //     deduct SKIPS the department and records why. Do not add a fallback
          //     department here — a wrong kitchen debited silently reads as theft
          //     on the very variance report this change exists to produce.
          station: it.station || null,
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
          // FIELD 8 — the responsible user, from the SESSION. This route 401s
          // without `me`, so a real cashier is always available; leaving it out
          // stamped every backstop consumption row 'system:recipe-consumption',
          // which is a true statement about a timer and a false one about a
          // person closing a bill. Never from the request body.
          actor: me.email,
          // WHICH SOLD LINE CAUSED THIS. The movement rows carry the SALES row
          // id as their reference; the trace column that was built to name the
          // order line was left NULL by every writer on this path, so "which
          // dish ate this?" could only be answered by joining back through
          // sales. It is one field and it was already plumbed.
          order_item_id: it.id,
        });
        // Stamp the backstop deduct so a later KDS bump (the settled order still
        // passes bump's status !== 'void' check) can't deduct these items again.
        // Same recipe gate as recordSale's deduct ('' never deducts). Inside the
        // transaction, so a recordSale throw rolls the stamp back too.
        if (!alreadyDeducted && it.recipe_id) stampDeduct.run(it.id);
      }
      // Store the computed breakdown before marking settled so the settled row
      // is the single source of truth for the charged amounts. A held bill's
      // totals were frozen at hold time → only record the payment + close it.
      // Store `grand` (the whole-rupee amount actually collected, validated and
      // printed) as orders.total — NOT the unrounded bill.total — so the settled
      // row, order_payments and the printed bill all agree, and reports equal what
      // was charged.
      if (fromHold) {
        db.prepare(`UPDATE orders SET status = 'settled', payment_method = ?, total = ?, settled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(primaryMethod, grand, id);
      } else {
        db.prepare(`
          UPDATE orders SET status = 'settled', payment_method = ?,
            service_charge = ?, discount = ?, tax_total = ?, total = ?,
            settled_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(primaryMethod, bill.serviceCharge, bill.discount, taxTotal, grand, id);
      }
      // The desktop POS prints the bill ITSELF, in the browser, the instant this
      // returns — dine-in/order/[id] settle() calls printBill() against its own
      // local bridge rather than going through /print-bill. Nothing on that path
      // ever stamped bill_printed_at, and that column is what decides the
      // DUPLICATE BILL header. So the guest's request for a copy read NULL and
      // came off the printer as a second UNMARKED original; only a third press
      // said DUPLICATE. Declared by the caller rather than assumed, because
      // /cashier also settles and does not always print.
      //
      // COALESCE keeps the stamp a bill already earned (printed before settling,
      // which is the normal order at a counter) instead of moving it forward.
      if (b.bill_printed === true) {
        db.prepare('UPDATE orders SET bill_printed_at = COALESCE(bill_printed_at, ?) WHERE id = ?')
          .run(new Date().toISOString().slice(0, 19).replace('T', ' '), id);
      }
      // Record each tender line (clear any prior rows first so a retry can't
      // double-insert). Powers the dashboard's payment-category breakup + split.
      db.prepare('DELETE FROM order_payments WHERE order_id = ?').run(id);
      const insP = db.prepare(
        'INSERT INTO order_payments (id, order_id, outlet_id, method, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const p of payments) insP.run(generateId(), id, outletId, p.method, p.amount, me.email);

      // ── CLOSE THE BILL-ON-HOLD RECORD, IN THE SAME BREATH ────────────────
      // Only on the fromHold branch, and only when a live record exists.
      // It appends the till's tenders to the BOH ledger, replays any EARLIER
      // BOH collections into this order's tender rows (so order_payments still
      // sums to the whole bill, not just to what this till took), and closes the
      // record as paid in full, attributed to the person standing here.
      //
      // Before this, every held bill settled the way staff actually settle them
      // left its BOH open for ever: the dashboard's pending figure and every
      // per-user overdue column overstated the debt, and the accountability view
      // accused people of not chasing bills that were already paid.
      if (fromHold) {
        bohOut.res = absorbTillSettleIntoBoh(db, id, { tenders: payments, outletId, actor: me });
      }
    });
    settle();
    const bohSettle = bohOut.res;

    // THE OVERRIDE LEDGER. If management just settled past a live floor
    // cashier ('manager_override'), record who settled, when, and who was
    // bypassed. AFTER the commit, so the ledger holds settles that actually
    // happened; a no-op for every other reason, so this is unconditional and
    // cannot get the condition wrong. logAuditEvent never throws.
    recordSettleOverride(db, auth, { actor: me, orderId: id, action: 'settle', outletId });

    // Order is now 'settled': if it came from a reservation, flip that booking
    // seated → completed. Best-effort — the lib swallows errors so a booking
    // hiccup can never fail an already-committed settle.
    completeBookingForOrder(db, id);

    // The table has paid, so its table-assistance bells are over. Close them —
    // otherwise a "Call waiter" nobody pressed Done on stays pending forever and
    // the guest-side de-duplicator keeps refusing to raise a NEW one of that type
    // at that table, silently disabling the button for the next guest. Same
    // shape as completeBookingForOrder above: after the commit, best-effort, the
    // lib swallows its own errors so this can never fail a settle that has
    // already taken the money. Writes only status/outcome/closed_reason/
    // closed_at — never completed_by — so captain-performance is untouched.
    closeServiceRequestsForOrder(db, id);

    return Response.json({
      success: true, order_id: id, total: bill.total, payment_method: primaryMethod, payments, lines: items.length,
      // What the till actually took, and why it may differ from the bill total.
      // Present only when this bill had a live bill-on-hold record.
      boh: bohSettle
        ? {
            boh_id: bohSettle.bohId,
            collected_now: bohSettle.till_amount,
            already_collected: bohSettle.already_paid,
            bill_total: grand,
            closed: bohSettle.closed,
            // The engine composes this sentence, because only it knows whether
            // the record was still open (this settle closed it) or was ALREADY
            // closed — a write-off whose bill stayed on hold, where the money
            // is appended to the ledger and the close decision stands.
            note: bohSettle.note,
          }
        : null,
      // SURFACE THE OVERRIDE. When management settled past a live floor cashier
      // the client should say so ("Settled by <manager> — <cashier> holds this
      // floor"), so the success payload carries the same facts the ledger just
      // recorded — names from the authority result, never a client-side guess.
      // null on every ordinary settle.
      override: auth.reason === 'manager_override' && auth.override
        ? {
            by: String(me.name || me.email || ''),
            bypassed: auth.override.bypassed.userName || 'the floor cashier',
            floor: auth.floor,
            floorName: auth.floorName,
          }
        : null,
    });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/settle]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
