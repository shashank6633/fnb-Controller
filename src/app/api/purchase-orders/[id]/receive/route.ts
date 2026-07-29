import { getDb, generateId, updateMaterialPrice, logAuditEvent } from '@/lib/db';
import { poWriteGate } from '@/lib/po-helpers';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { todayIST } from '@/lib/format-date';
import {
  allocateBillCharges, r2, MIN_NET_RATE, NON_ADMIN_DISCOUNT_CAP_PCT,
  type AllocatedLine,
} from '@/lib/po-charges';

/**
 * Mark an approved PO as Received.
 * Side effects (atomic):
 *   1. Insert one row into `purchases` per PO line (so weighted-avg + history works).
 *   2. Bump raw_materials.current_stock by quantity.
 *   3. Update raw_materials.last_purchase_price + last_purchase_date.
 *   4. Run updateMaterialPrice → recomputes average_price + cascades recipe / sub-recipe costs.
 *   5. Insert inventory_transactions.
 *
 * Optional body: { received_at?, item_overrides?: [{po_item_id, quantity?, unit_price?,
 *                   accepted?, rejection_reason?, deviation_reason?}] }
 *   — lets the receiver record short/over-shipments before commit.
 *   `rejection_reason` stays QC-only (why some units were REJECTED).
 *   `deviation_reason` is the separate "why does this line differ from the PO":
 *   REQUIRED whenever ANY of the three axes moves off the approved PO line —
 *   received qty ≠ ordered qty, accepted qty ≠ ordered qty (a full delivery
 *   part-rejected at QC counts), or the rate ≠ the ordered rate.
 *   It is stored on the GRN line + the purchases row and alerted to the admin.
 *   Changing the rate at receive time is ADMIN-ONLY (403 otherwise).
 *
 * Optional body: { bill_charges?: { discount_amount?, delivery_amount?,
 *                   charges_note?, bill_no? } }
 *   — ONE bill-level figure for each, in RUPEES (a By-% entry is resolved to ₹ on
 *   the client; this route only ever takes an amount). Allocated across the
 *   accepted lines by src/lib/po-charges. The two rulings it encodes:
 *     DISCOUNT REDUCES COST — netted into purchases.unit_price, because that is
 *       the only column updateMaterialPrice() averages. purchases.discount stays
 *       0 on this path so the discount can never be subtracted twice.
 *     DELIVERY IS RECORDED ONLY — stored per line, never touches a rate/average.
 *   `charges_note` is REQUIRED once a discount is entered; a discount above
 *   NON_ADMIN_DISCOUNT_CAP_PCT% of the accepted bill is ADMIN-ONLY (403).
 *   Neither figure may be negative — a vendor credit note is not a negative
 *   discount and does not belong on the receive path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    // Receiving is a PO WRITE action and the irreversible one: it bumps stock,
    // writes purchases rows and rewrites average_price across every recipe.
    // currentRole() could NOT gate it — it collapses 'staff' → 'manager', so a
    // truthiness check on it only meant "has a session" and any signed-in
    // captain could fire this. poWriteGate() tests the real membership; there is
    // still no fail-open to admin when the session is missing.
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can receive POs' }, { status: 403 });
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'approved') {
      return Response.json({ error: `Only approved POs can be received (current: ${po.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    // Use IST "today" for the day boundary (matches todayIST() used by the
    // backdate guard) instead of UTC new Date() — otherwise a receive near
    // midnight IST could resolve to the wrong calendar day.
    const receivedAt = (body?.received_at as string) || todayIST();
    const me = await getCurrentUser();
    const receivedByEmail = me?.email || '';
    // Backdate guard — a PO-receive writes received_at into both the GRN date
    // and every purchases row it creates, so a user-supplied received_at must
    // pass the same configurable window as /api/grn and /api/purchases. Admins
    // (me.role === 'admin' — the REAL tier off the session) are fully exempt.
    const dateCheck = checkPurchaseDate(db, receivedAt, me?.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });
    // Per-line overrides now support accept/reject for QC at the receiving bay,
    // plus deviation_reason — the mandatory "why is this line not what the PO
    // says" (see the deviation gate below). It is DISTINCT from
    // rejection_reason: that one only explains rejected units.
    const overrides: Map<string, { quantity?: number; unit_price?: number; accepted?: number; rejection_reason?: string; deviation_reason?: string }> = new Map();
    if (Array.isArray(body?.item_overrides)) {
      for (const o of body.item_overrides) {
        if (o?.po_item_id) overrides.set(o.po_item_id, {
          quantity: o.quantity, unit_price: o.unit_price,
          accepted: o.accepted, rejection_reason: o.rejection_reason,
          deviation_reason: o.deviation_reason,
        });
      }
    }

    // ── Bill-level charges (shape only — the money gates need the accepted
    // lines and run after the per-line validation below) ──────────────────
    // Both figures arrive in RUPEES. A By-% entry is resolved against the bill
    // on the client (resolveCharge in po-charges), so a percentage never
    // reaches the server and there is exactly one thing to validate here.
    const billCharges = (body?.bill_charges && typeof body.bill_charges === 'object') ? body.bill_charges : {};
    const chargeAmounts: Record<string, number> = { discount_amount: 0, delivery_amount: 0 };
    for (const [field, label] of [
      ['discount_amount', 'discount'],
      ['delivery_amount', 'delivery charge'],
    ] as Array<[string, string]>) {
      const raw = (billCharges as any)[field];
      const n = (raw == null || raw === '') ? 0 : Number(raw);
      if (!Number.isFinite(n)) {
        return Response.json({
          error: `The bill ${label} must be a ₹ amount — received "${raw}".`,
          field,
        }, { status: 400 });
      }
      // Negatives are refused rather than inverted. A vendor CREDIT NOTE is not
      // a negative discount: it lands after the bill, often against a different
      // GRN, and netting it into unit_price here would silently inflate
      // average_price on goods that were never re-priced. Out of scope.
      if (n < 0) {
        return Response.json({
          error: `The bill ${label} cannot be negative (₹${n}). A vendor credit note is not a negative ${label} — it cannot be recorded from the receive screen.`,
          field,
        }, { status: 400 });
      }
      chargeAmounts[field] = r2(n);
    }
    /* A PERCENTAGE IS RESOLVED HERE, NOT ON THE CLIENT.
     * The modal previews the bill over every PO line, but this route allocates
     * only over `receivable` — store-mapped (liquor) lines are dropped by
     * centralFlowBlock. On a mixed PO the two bases differ, so a client-resolved
     * "5%" arrived as a rupee figure that was a much larger share of what is
     * actually booked (₹5,000 of a ₹100,000 preview landing on a ₹50,000 base =
     * a 10% cut, and average_price followed the wrong number). When the client
     * sends the MODE + VALUE we re-resolve against this route's own subtotal,
     * which is by definition the base the money is booked on. The resolved
     * amount is still accepted for older clients and for By-Amount entry. */
    const chargeMode = (f: 'discount' | 'delivery'): 'pct' | 'amt' =>
      String((billCharges as any)[`${f}_mode`] || '').toLowerCase() === 'pct' ? 'pct' : 'amt';
    const chargePctValue = (f: 'discount' | 'delivery'): number => {
      const v = Number((billCharges as any)[`${f}_value`]);
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    let chargeDiscount = chargeAmounts.discount_amount;
    let chargeDelivery = chargeAmounts.delivery_amount;
    const chargesNote    = String((billCharges as any).charges_note || '').trim();
    const billNo         = String((billCharges as any).bill_no || '').trim();
    // A discount rewrites the cost basis of stock and every recipe downstream of
    // it, so it may never land as a bare number — the admin alert below quotes
    // this note, and "why was ₹9,900 taken off this bill" is the whole question.
    if (chargeDiscount > 0 && chargesNote.length < 3) {
      return Response.json({
        error: `Reason required for the ₹${chargeDiscount} bill discount. A discount reduces the cost this delivery is booked at (and the average price of every material on it), so say why the vendor gave it — at least 3 characters; the admin is alerted with that reason.`,
        field: 'charges_note',
      }, { status: 400 });
    }

    const result: any = {};
    // Hoisted so the post-txn audit + Slack ping can read the collected lines.
    // Populated inside the txn loop when accepted qty > ordered qty.
    const excessLines: Array<{
      material_name: string;
      material_id: string;
      ordered: number;
      received: number;
      accepted: number;
      excess: number;
      unit: string;
      unit_price: number;
      excess_value: number;
    }> = [];
    // Every line that came in differently from the APPROVED PO — short qty,
    // over qty, or a changed rate. Superset of excessLines (which stays keyed
    // on ACCEPTED qty because that is what actually enters stock + books).
    // Hoisted for the same reason: the post-txn admin alert reads it.
    const deviationLines: Array<{
      material_name: string;
      material_id: string;
      ordered: number;        // PO line qty — PURCHASE units
      received: number;       // PURCHASE units
      accepted: number;       // PURCHASE units
      unit: string;           // PURCHASE unit label
      ordered_rate: number;   // ₹/purchase-unit on the PO line
      actual_rate: number;    // ₹/purchase-unit actually received at
      qty_short: boolean;
      /** accepted < ordered — a full delivery part-rejected at QC still moves money. */
      acc_short: boolean;
      qty_excess: boolean;
      rate_changed: boolean;
      value_impact: number;   // ₹ (accepted × actual rate) − (ordered × ordered rate)
      reason: string;
    }> = [];
    // Tolerances for "differs from the PO". SQLite REAL is a double and JSON
    // round-trips doubles exactly, so these only stop sub-unit float noise from
    // demanding a reason — anything a receiver actually typed is far bigger.
    const QTY_EPS  = 1e-6;
    const RATE_EPS = 0.005;   // ₹ — half a paisa

    const items = db.prepare(`
      SELECT poi.*, rm.id AS material_id, rm.name AS material_name,
             rm.unit AS material_unit, rm.purchase_unit AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
    `).all(id) as any[];

    if (items.length === 0) return Response.json({ error: 'PO has no items' }, { status: 400 });

    // Phase B store guard (batch → skip + report per line): store-mapped
    // materials (liquor) on HISTORICAL POs are skipped at receive time so they
    // never bump Central stock / purchases / average_price. New POs can't even
    // contain them (create/edit reject). The PO data itself is untouched.
    const storeBlocked: { material_id: string; material_name: string; error: string }[] = [];
    const receivable = items.filter((it: any) => {
      const msg = centralFlowBlock(db, String(it.material_id || ''));
      if (msg) { storeBlocked.push({ material_id: it.material_id, material_name: it.material_name, error: msg }); return false; }
      return true;
    });
    if (receivable.length === 0) {
      return Response.json({
        error: `Nothing to receive — every line is a store-mapped material. ${storeBlocked[0]?.error || ''}`,
        store_blocked: storeBlocked,
      }, { status: 400 });
    }

    // Unit LABEL for a PO line = the PURCHASE unit, because a PO line's qty and
    // rate are both in purchase units (canon, see the boundary note below).
    // rm.purchase_unit is selected un-COALESCEd (line 74) so fall back to the
    // recipe unit when it is NULL/blank.
    const puLabel = (it: any) =>
      String(it.material_purchase_unit || '').trim() || String(it.material_unit || '').trim();

    // Reject negative qty / price BEFORE the txn starts.
    // Receiving is an additive workflow — stock corrections (negative qtys) live
    // on the dedicated GRN back-correction flow. A negative here would silently
    // reduce stock without the audit-trail tagging that back-corrections get.
    // Every check below runs on the EFFECTIVE per-line value (override if sent,
    // else the stored PO line) — the same resolution the txn loop uses. Checking
    // only the override payload left the stored line unvalidated, and PO lines
    // saved before lineSanityError() existed can themselves carry a bad qty/rate.
    for (const it of receivable) {
      const ov = overrides.get(it.id);
      const effRcv   = ov?.quantity   != null ? Number(ov.quantity) : Number(it.quantity);
      const effAcc   = ov?.accepted   != null ? Number(ov.accepted) : effRcv;
      const effPrice = ov?.unit_price != null ? Number(ov.unit_price) : Number(it.unit_price);
      const checks: Array<[string, number]> = [
        ['quantity',   effRcv],
        ['accepted',   effAcc],
        ['unit_price', effPrice],
      ];
      for (const [field, n] of checks) {
        if (!Number.isFinite(n) || n < 0) {
          return Response.json({
            error: `Negative or invalid ${field.replace('_', ' ')} on "${it.material_name}" (${n}). Receiving cannot go below 0 — use the GRN page's back-correction workflow for stock reversals.`,
            material: it.material_name,
            field,
          }, { status: 400 });
        }
      }
      // accepted ≤ received is an invariant of the GRN row: `rejected` is derived
      // as max(0, received - accepted), so an over-accept clamps rejected to 0 and
      // credits stock + purchases for goods the same GRN says never arrived.
      if (effAcc > effRcv) {
        return Response.json({
          error: `Accepted (${effAcc}) exceeds received (${effRcv}) on "${it.material_name}". Accepted qty can never be more than the qty received — record the extra as received first.`,
          material: it.material_name,
          field: 'accepted',
        }, { status: 400 });
      }
      // Rate guard — a 0/blank rate is accepted by the PO composer and by
      // create/approve, but receiving it writes purchases(unit_price 0) and then
      // updateMaterialPrice wipes average_price to 0, cascading a "free"
      // ingredient through every recipe. Mirrors /api/purchases' `!unit_price`
      // reject. A 0 rate is only fatal on lines that actually enter stock/books
      // (accepted > 0) — a fully-rejected line never reaches updateMaterialPrice.
      if (effAcc > 0 && effPrice <= 0) {
        // The remedy differs by role, and saying the wrong one wastes a delivery
        // standing at the gate: only an admin may supply a rate at receive time
        // (the rate lock below is a hard 403), so a non-admin's ONLY route out of
        // a ₹0 line is to have the PO line rate corrected and re-approved.
        const remedy = me?.role === 'admin'
          ? 'edit the PO line rate (or send a unit_price override) before receiving'
          : 'only an admin can set a rate while receiving, so ask an admin to correct the PO line rate and re-approve the PO (or to receive this line)';
        return Response.json({
          error: `Missing or zero rate on "${it.material_name}". A receive rewrites this material's average price, so the line needs a real ₹/${puLabel(it) || 'unit'} — ${remedy}.`,
          material: it.material_name,
          field: 'unit_price',
        }, { status: 400 });
      }
      // Rate lock — ADMIN ONLY, enforced HERE, not in the modal.
      // The receive modal renders the rate read-only for non-admins, but that is
      // only which input mounts: poWriteGate() above admits every storekeeper,
      // HOD, Floor Manager and Bar Manager, so without this check any of them
      // could POST a unit_price override straight at the route and rewrite
      // last_purchase_price + average_price for the material — cascading a bogus
      // cost through every recipe that uses it — while the screen told them
      // "PO rate — admin only". A UI lock the API does not back is not a lock.
      // me.role is the REAL tier off the session (already trusted above for the
      // backdate exemption); effectiveRole() must NOT be used here because it
      // collapses 'staff' into 'manager'.
      // Consequence, deliberate: a PO line approved at ₹0 cannot be repaired from
      // the receive screen by a non-admin (the zero-rate gate above refuses the
      // line and this gate refuses the override). The documented remedy is the PO
      // edit + re-approve path — say so instead of pointing at the PO rate.
      if (ov?.unit_price != null && Math.abs(effPrice - Number(it.unit_price)) > RATE_EPS && me?.role !== 'admin') {
        const ordRatePO = Number(it.unit_price);
        return Response.json({
          error: ordRatePO > 0
            ? `Only an admin can change the rate while receiving. "${it.material_name}" was ordered at ₹${ordRatePO}/${puLabel(it) || 'unit'} — receive at the PO rate, or ask an admin to receive this line.`
            : `Only an admin can set the rate while receiving, and "${it.material_name}" was ordered with no rate (₹0) — which cannot be received either. Ask an admin to correct the PO line rate and re-approve the PO (or to receive this line); it cannot be fixed from this screen.`,
          material: it.material_name,
          field: 'unit_price',
        }, { status: 403 });
      }
      // Deviation gate — receiving OFF-PO must say why.
      // The three ways a receive silently rewrites what was approved: a RECEIVED
      // qty that isn't the ordered qty (short OR over) moves stock and money, an
      // ACCEPTED qty short of the ordered qty does the same even when the truck
      // arrived in full (QC turned units away), and a RATE that isn't the ordered
      // rate feeds updateMaterialPrice → average_price →
      // every recipe cost. The receive modal asks for the reason, but THIS is
      // the gate — a crafted request must not commit an unexplained deviation.
      // The reason is persisted on the GRN line + the purchases row and goes
      // out in the admin alert below.
      const ordQty  = Number(it.quantity);
      const ordRate = Number(it.unit_price);
      const qtyOff  = Math.abs(effRcv - ordQty) > QTY_EPS;
      const rateOff = Math.abs(effPrice - ordRate) > RATE_EPS;
      // ACCEPTED is a third axis, and it was the hole: `accepted` defaults to
      // `received`, so a caller sending ONLY {accepted: 2} on a 10-unit line left
      // effRcv at the ordered 10 — qtyOff false, rateOff false — and the line
      // committed with 8 units silently rejected, no reason, and no admin alert.
      // "Reason for accepting less qty" is half the requirement, so judge accepted
      // against ordered too.
      const accOff  = Math.abs(effAcc - ordQty) > QTY_EPS;
      if (qtyOff || rateOff || accOff) {
        const devReason = String(ov?.deviation_reason || '').trim();
        if (devReason.length < 3) {
          const u = puLabel(it) || 'unit';
          const what: string[] = [];
          if (qtyOff)  what.push(`received ${effRcv} ${u} vs ordered ${ordQty} ${u}`);
          if (accOff)  what.push(`accepted ${effAcc} ${u} vs ordered ${ordQty} ${u}`);
          if (rateOff) what.push(`rate ₹${effPrice}/${u} vs ordered ₹${ordRate}/${u}`);
          return Response.json({
            error: `Reason required on "${it.material_name}" — ${what.join(' and ')}. Enter why this line differs from the PO (at least 3 characters); the admin is alerted with that reason.`,
            material: it.material_name,
            field: 'deviation_reason',
          }, { status: 400 });
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Bill-charge allocation — AFTER every per-line gate above, BEFORE the txn.
    // The ordering is load-bearing, not stylistic: the rate lock, the zero-rate
    // guard and the deviation gate all compare the ORDERED rate against the rate
    // the RECEIVER TYPED. The discount is a property of the bill, not of the
    // rate the vendor quoted, so it must never reach those comparisons — net it
    // in first and every discounted receive reads as a rate deviation, which for
    // a non-admin is the hard 403 above, with the goods standing at the gate.
    // So: validate on the GROSS rate, then allocate, then re-guard.
    //
    // Allocated PER RECEIVE CALL, over THIS call's accepted lines only. Nothing
    // is carried across calls and nothing is read back from a previous receive,
    // so a partial/repeat receive cannot double-count a charge — the bill the
    // receiver is holding is the bill that is allocated.
    // ────────────────────────────────────────────────────────────────────
    const chargeItems = [...receivable]
      // PO item id ASC — a stable order matters because the allocator gives the
      // remainder to the LAST allocatable line, so DB row order must not decide
      // which line absorbs the odd paisa.
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
      .map((it: any) => {
        const ov = overrides.get(it.id);
        const effRcv   = ov?.quantity   != null ? Number(ov.quantity)   : Number(it.quantity);
        const effAcc   = ov?.accepted   != null ? Number(ov.accepted)   : effRcv;
        const effPrice = ov?.unit_price != null ? Number(ov.unit_price) : Number(it.unit_price);
        return { it, qty: effAcc, rate: effPrice };
      })
      // Only lines that actually enter stock and books carry a share. A fully
      // rejected line is never paid for, so it cannot absorb a discount.
      .filter(l => l.qty > 0);
    const chargeInputs = chargeItems.map(l => ({
      id: String(l.it.id), qty: l.qty, rate: l.rate, name: String(l.it.material_name || ''),
    }));
    // THE base the money is booked on — accepted value at the gross rate, over
    // allocatable lines only. A percentage is resolved against THIS, never the
    // client's (which counts lines this route drops).
    const chargeBase = r2(chargeInputs.reduce((acc, l) => acc + (l.qty > 0 && l.rate > 0 ? l.qty * l.rate : 0), 0));
    if (chargeMode('discount') === 'pct' && chargePctValue('discount') > 0) {
      chargeDiscount = r2((chargeBase * chargePctValue('discount')) / 100);
    }
    if (chargeMode('delivery') === 'pct' && chargePctValue('delivery') > 0) {
      chargeDelivery = r2((chargeBase * chargePctValue('delivery')) / 100);
    }
    const chargeAlloc = allocateBillCharges(
      chargeInputs,
      { discount: chargeDiscount, delivery: chargeDelivery },
    );
    const chargeByPoItem = new Map<string, AllocatedLine>(chargeAlloc.lines.map(l => [l.id, l]));
    const chargeItemById = new Map<string, any>(chargeItems.map(l => [String(l.it.id), l.it]));
    const hasCharges = chargeDiscount > 0 || chargeDelivery > 0;

    // Guard 1 — nothing to allocate against. Silently dropping the figures would
    // tell the receiver the bill was booked with its discount when it wasn't.
    if (hasCharges && chargeAlloc.subtotal === 0) {
      return Response.json({
        error: `Nothing was accepted on this receive, so there is nothing to apply the bill's discount/delivery to. Accept at least one line, or receive without the bill charges.`,
        field: 'bill_charges',
      }, { status: 400 });
    }

    // Guard 2 — non-admin discount cap. Same shape as the rate lock above: the
    // modal caps the input, but poWriteGate() admits every storekeeper, HOD and
    // floor manager, so without this an unbounded discount could be POSTed
    // straight at the route and rewrite average_price across every recipe. Half
    // a paisa of headroom so a %-derived figure landing exactly on the cap
    // isn't refused by its own rounding.
    const discountCap = r2((chargeAlloc.subtotal * NON_ADMIN_DISCOUNT_CAP_PCT) / 100);
    if (chargeDiscount - discountCap > 0.005 && me?.role !== 'admin') {
      const pct = chargeAlloc.subtotal > 0 ? Math.round((chargeDiscount / chargeAlloc.subtotal) * 100) : 100;
      return Response.json({
        error: `₹${chargeDiscount} is ${pct}% of the ₹${chargeAlloc.subtotal} accepted on this bill. A discount above ${NON_ADMIN_DISCOUNT_CAP_PCT}% of the bill needs an admin — ask an admin to receive this delivery.`,
        field: 'discount_amount',
        discount_cap: discountCap,
      }, { status: 403 });
    }

    // Guard 3 — post-allocation zero-cost. Mirrors the zero-rate guard above,
    // which runs on the rate as TYPED; this one runs on the rate as BOOKED,
    // because a discount big enough to flatten a line arrives at the same place
    // by a different road. Names every offending line: a receiver who has to
    // guess which of 30 lines broke will just drop the discount.
    // Only when a discount was actually applied: a line whose GROSS rate is
    // already under half a paisa reads as zero-cost here too, and that case
    // belongs to the zero-rate guard above — this one must not start refusing
    // undiscounted receives it never saw before.
    if (chargeAlloc.discount_applied > 0 && chargeAlloc.zero_cost_lines.length > 0) {
      const detail = chargeAlloc.zero_cost_lines.map(l => {
        const it = chargeItemById.get(l.id);
        const u  = (it ? puLabel(it) : '') || 'unit';
        return `"${l.name || it?.material_name || l.id}" would be booked at ₹${l.net_rate.toFixed(2)}/${u}`;
      }).join('; ');
      return Response.json({
        error: `${detail} after the ₹${chargeAlloc.discount_applied.toLocaleString('en-IN')} discount — a ₹0 cost basis wipes average_price and every recipe that uses it. Reduce the discount or record it as a credit note.`,
        field: 'discount_amount',
        zero_cost_lines: chargeAlloc.zero_cost_lines.map(l => ({
          po_item_id: l.id, material_name: l.name, net_rate: l.net_rate, gross_rate: l.rate,
        })),
        min_net_rate: MIN_NET_RATE,
      }, { status: 400 });
    }

    let total = 0;
    const touchedMaterials = new Set<string>();

    const txn = db.transaction(() => {
      // ── Atomic claim (MUST stay the first statement in this txn) ──────────
      // The status === 'approved' check above is separated from every write by
      // two awaits (req.json + getCurrentUser), so two concurrent receives can
      // both pass it and each credit stock, write a purchases row and mint a
      // GRN. better-sqlite3 txns are synchronous: whoever flips approved→received
      // here wins, the loser's UPDATE matches 0 rows and throws, rolling back
      // its whole txn before anything else is written.
      const claim = db.prepare(`
        UPDATE purchase_orders
        SET status = 'received', received_at = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'
      `).run(receivedAt, id);
      if (claim.changes === 0) {
        const err: any = new Error('This PO has already been received (or is no longer approved). Reload the page.');
        err.httpStatus = 409;
        throw err;
      }

      // ── The COST row (net basis) ───────────────────────────────────────
      // unit_price / total_price are NET of the bill discount, because
      // updateMaterialPrice() (src/lib/db.ts) averages ONLY
      // SUM(quantity * unit_price) / SUM(quantity) — it never reads a discount
      // column — so a discount that is not inside unit_price does not reduce
      // cost at all, and the owner ruling is that it must.
      // `discount` is therefore bound to the LITERAL 0 below, deliberately: the
      // reduction already lives in unit_price, and any reader that subtracted
      // this column as well would take it off twice. The gross rate and the
      // discount figure are not lost — they are on the GRN line written just
      // below, which is the bill document.
      // `delivery_charges` is recorded only and never enters any rate.
      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, outlet_id,
                               discount, delivery_charges, bill_no, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'))
      `);
      const bumpStock = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?,
            last_purchase_price = ?,
            last_purchase_date  = ?,
            updated_at          = datetime('now')
        WHERE id = ?
      `);
      const insTx = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id, created_at)
        VALUES (?, ?, 'purchase', ?, ?, ?, ?, datetime('now'))
      `);

      // Phase 1 §5 — auto-create a GRN for this PO receive. Stock only bumps by the
      // ACCEPTED qty on each line (defaults to full received qty if no overrides provided).
      // body.item_overrides may now include: { po_item_id, quantity (=received), accepted, rejection_reason, deviation_reason }
      const grnId = generateId();
      const yr = receivedAt.slice(0, 4);
      const lastGrn = db.prepare(`SELECT grn_number FROM goods_receipt_notes WHERE grn_number LIKE 'GRN-' || ? || '-%' ORDER BY grn_number DESC LIMIT 1`).get(yr) as any;
      const nextNum = lastGrn?.grn_number ? parseInt(lastGrn.grn_number.split('-').pop() || '0', 10) + 1 : 1;
      const grnNumber = `GRN-${yr}-${String(nextNum).padStart(4, '0')}`;
      db.prepare(`
        INSERT INTO goods_receipt_notes
          (id, grn_number, date, po_id, vendor_id, vendor, received_by, status, notes, outlet_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, datetime('now'))
      `).run(grnId, grnNumber, receivedAt, id, po.vendor_id, po.vendor || '',
              receivedByEmail,
              `Auto-created from PO ${po.po_number} receive`,
              po.outlet_id);

      // ── The BILL row (gross basis) ─────────────────────────────────────
      // The exact opposite basis to the purchases row above, and it has to be.
      // unit_price stays GROSS and the discount goes in its own column because
      // this row IS the vendor's bill: /api/grn and the inward register both
      // total it as `quantity × unit_price − discount + …`, so a net rate here
      // plus a discount column would subtract the discount twice; and
      // /api/receiving-variance values every line off gi.unit_price against the
      // ordered rate, so a net rate would report a rate variance the vendor
      // never billed. Discount + delivery are per-line shares of the bill-level
      // figures, allocated by value before the txn opened.
      const insGrnItem = db.prepare(`
        INSERT INTO goods_receipt_note_items
          (id, grn_id, po_item_id, material_id, quantity_ordered, quantity_received,
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes,
           discount, delivery_charges)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Excess + deviation detection happen inline below — the `excessLines` and
      // `deviationLines` arrays are hoisted at the outer function scope (filled
      // here, read post-txn for the admin audit + Slack ping).
      for (const it of receivable) {
        const ov = overrides.get(it.id);
        const received = ov?.quantity   != null ? Number(ov.quantity)   : it.quantity;
        const accepted = ov?.accepted   != null ? Number(ov.accepted)   : received;
        const rejected = Math.max(0, received - accepted);
        const reason   = String(ov?.rejection_reason || '').trim();
        const price    = ov?.unit_price != null ? Number(ov.unit_price) : it.unit_price;
        // Off-PO facts for this line. The pre-txn gate already refused to get
        // here without a reason when either is true, so devReason is present
        // on any deviating line.
        const devReason  = String(ov?.deviation_reason || '').trim();
        const ordQty     = Number(it.quantity);
        const ordRate    = Number(it.unit_price);
        const qtyShort   = received < ordQty - QTY_EPS;
        const qtyExcess  = received > ordQty + QTY_EPS;
        const rateChanged = Math.abs(Number(price) - ordRate) > RATE_EPS;
        // Accepted-vs-ordered is its own axis: a line can arrive in full and then
        // be part-rejected at QC, so `received` matches the PO while only a
        // fraction is actually booked. Judging `deviated` on received alone let
        // that land with no entry here — so no audit event, no notification, no
        // Slack ping — even though the money and stock moved. This is the axis the
        // "accepting less qty" alert hangs on.
        const accShort   = accepted < ordQty - QTY_EPS;
        const deviated   = qtyShort || qtyExcess || rateChanged || accShort;
        const acceptedTotal = Math.round(accepted * price * 100) / 100;
        // This line's share of the bill-level charges (0/0 when none were sent,
        // or when the line is fully rejected and so was never allocated).
        const share       = chargeByPoItem.get(String(it.id));
        const discShare   = share ? share.discount_share : 0;
        const delivShare  = share ? share.delivery_share : 0;
        // The NET basis is substituted ONLY when a discount was actually
        // applied. With no discount the allocator's net_rate is a re-derivation
        // (r2(r2(qty × rate) / qty)) that can differ from the typed rate in the
        // 3rd decimal, and this route must write a receive with no bill charges
        // exactly as it always has.
        const netPrice    = (share && chargeAlloc.discount_applied > 0) ? share.net_rate  : price;
        const netTotal    = (share && chargeAlloc.discount_applied > 0) ? share.net_total : acceptedTotal;
        // purchase_orders.total_cost accumulates what the PO actually cost —
        // net of the discount, exclusive of the recorded-only delivery.
        total += netTotal;

        // Excess detection — store accepted MORE than the PO line ordered.
        // (Rejected portion never enters stock so we compare against accepted,
        // not received — that's what actually impacts inventory + books.)
        // Same QTY_EPS as the deviation flags above so an accepted-over line is
        // ALWAYS also a deviation line: the response reports excess_lines and
        // the alert is driven off deviationLines, and those two must not disagree.
        if (accepted > ordQty + QTY_EPS) {
          const excess = accepted - ordQty;
          excessLines.push({
            material_name: it.material_name,
            material_id: it.material_id,
            ordered:    it.quantity,
            received:   received,
            accepted:   accepted,
            excess:     excess,
            // Purchase unit — ordered/accepted/excess are all PO qtys and the
            // ₹ in the same sentence is ₹/purchase-unit. Labelling with the
            // recipe unit made a 3 L (₹2,400) surplus read as "3 ml".
            unit:       puLabel(it),
            unit_price: price,
            excess_value: Math.round(excess * price * 100) / 100,
          });
        }

        // Off-PO line → admin alert. A line deviates on any of the three axes the
        // gate above asked a reason for: RECEIVED vs ordered (short/over),
        // ACCEPTED vs ordered (accShort — arrived in full, part-rejected at QC),
        // and RATE vs the ordered rate. The money impact is always computed on
        // ACCEPTED, since rejected units are never paid for.
        if (deviated) {
          deviationLines.push({
            material_name: it.material_name,
            material_id:   it.material_id,
            ordered:       ordQty,
            received:      received,
            accepted:      accepted,
            unit:          puLabel(it),
            ordered_rate:  ordRate,
            actual_rate:   Number(price),
            qty_short:     qtyShort,
            qty_excess:    qtyExcess,
            rate_changed:  rateChanged,
            acc_short:     accShort,
            value_impact:  Math.round((accepted * Number(price) - ordQty * ordRate) * 100) / 100,
            reason:        devReason,
          });
        }

        // GRN item row — always written so the audit trail captures received + rejected too.
        // The notes column carries BOTH stories: the QC rejection (why units were
        // turned away) and the PO deviation (why the line isn't what was ordered).
        const noteBits: string[] = [];
        if (rejected > 0) noteBits.push(`Rejected ${rejected} (${reason || 'no reason given'})`);
        if (deviated && devReason) noteBits.push(`PO deviation: ${devReason}`);
        insGrnItem.run(generateId(), grnId, it.id, it.material_id,
                       it.quantity, received, accepted, rejected, reason, price,
                       noteBits.join(' | '),
                       discShare, delivShare);

        // Stock + financials reflect ONLY the accepted qty (rejections never enter stock)
        if (accepted > 0) {
          const purchaseId = generateId();
          const lineVendor = (it.vendor && String(it.vendor).trim()) || po.vendor || '';
          // ── Unit-basis boundary (CORE CONVENTION) ──────────────────────
          // A PO line carries qty in PURCHASE units and price in ₹/purchase-unit
          // (a PO is raised to a VENDOR — see /api/purchase-orders' items query
          // and the composer's poUnitOf/poRateOf). That is the SAME basis the
          // `purchases` table stores, so the row is written UNCHANGED and
          // last_purchase_price is already ₹/purchase-unit.
          // `current_stock` is in RECIPE units, so the stock credit is the only
          // thing that converts: × pack_size when pack>1 AND recipe≠purchase
          // unit — identical to /api/grn and /api/purchases POST.
          const packSize = Number(it.material_pack_size) || 1;
          const ru = String(it.material_unit || '').toLowerCase().trim();
          const pu = String(it.material_purchase_unit || it.material_unit || '').toLowerCase().trim();
          const isPack = packSize > 1 && ru !== pu;
          const stockQty = isPack ? accepted * packSize : accepted;
          // Carry the deviation reason onto the purchases row too — this is the
          // row every cost report and the average_price recompute read back, so
          // "why is this qty/rate not the PO's" has to survive here as well.
          const purchaseNote = `Received against ${po.po_number} (GRN ${grnNumber})`
            + (deviated && devReason ? ` — off-PO: ${devReason}` : '');
          // Stamp the receipt with the PO's outlet (the GRN header above already
          // does). A NULL here gets backfilled to the DEFAULT outlet by the
          // startup migration, silently moving another outlet's purchase.
          insPurchase.run(purchaseId, it.material_id, lineVendor, accepted, netPrice, netTotal, receivedAt,
            purchaseNote, po.outlet_id, delivShare, billNo);
          // last_purchase_price keeps the GROSS rate, and that divergence from
          // the purchases.unit_price written one line above is deliberate: this
          // column is the vendor's LIST rate, and it seeds the next PO's rate
          // (poRateOf / the vendor chips on /purchase-orders). Seeding it net
          // would ratchet the ordered rate down every cycle and then trip the
          // rate lock the moment the vendor bills their unchanged list price.
          // Cost lives in purchases.unit_price; this is what we expect to pay.
          bumpStock.run(stockQty, price, receivedAt, it.material_id);
          insTx.run(generateId(), it.material_id, stockQty, purchaseId, `PO ${po.po_number} received via GRN ${grnNumber}`, po.outlet_id);
          touchedMaterials.add(it.material_id);
        }
      }

      // Mark the GRN 'partial' when this is NOT a clean full receipt — a line
      // with units rejected at QC, OR a line the vendor short-supplied. Keying
      // only off quantity_rejected left a short delivery (rejected = max(0,
      // received - accepted) = 0) reading 'received', i.e. complete, on /grn and
      // on the printed GRN, even though goods are still owed. Same QTY_EPS as the
      // deviation gate so float noise alone never downgrades a full receipt.
      const partialCount = db.prepare(`
        SELECT COUNT(*) AS n FROM goods_receipt_note_items
        WHERE grn_id = ? AND (quantity_rejected > 0 OR quantity_received < quantity_ordered - ?)
      `).get(grnId, QTY_EPS) as any;
      if (partialCount.n > 0) {
        db.prepare(`UPDATE goods_receipt_notes SET status = 'partial' WHERE id = ?`).run(grnId);
      }

      // Only the figures that could not be known until every line was priced.
      // status + received_at are deliberately NOT re-written here: the atomic
      // claim at the top of this txn is their sole writer, so it stays the one
      // statement that guards the approved→received transition.
      db.prepare(`
        UPDATE purchase_orders
        SET total_cost = ?, grn_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(total, grnId, id);
      (result as any).grn_id = grnId;
      (result as any).grn_number = grnNumber;

      // If this PO was auto-raised from a department requisition, the requisition is now fulfilled.
      // (Stock was already issued to the dept at store-process time; receiving the PO replenishes the store.)
      if (po.requisition_id) {
        const reqRow = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(po.requisition_id) as any;
        const willFulfill = reqRow && reqRow.status === 'store_processed';
        db.prepare(`
          UPDATE requisitions
          SET status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'store_processed'
        `).run('po-received-cascade', po.requisition_id);

        // Party requisition fulfilled via PO-receive cascade — deduct now.
        // (Internal requisitions remain audit-only and never enter this branch.)
        if (willFulfill && reqRow.purpose === 'party') {
          const already = db.prepare(`
            SELECT 1 FROM inventory_transactions
            WHERE reference_id = ? AND type = 'party_consumption'
            LIMIT 1
          `).get(po.requisition_id);
          if (already) {
            logAuditEvent(db, {
              event_type: 'requisition.party_consumption.skipped',
              entity_type: 'requisition',
              entity_id: po.requisition_id,
              actor_email: receivedByEmail,
              after: { reason: 'already_deducted' },
              note: 'Party consumption skipped — inventory_transactions row already exists',
            });
          } else {
            const reqItems = db.prepare(`
              SELECT ri.*, rm.name AS material_name, rm.last_purchase_price, rm.average_price,
                     rm.unit AS rm_unit, rm.purchase_unit AS rm_purchase_unit,
                     COALESCE(rm.pack_size, 1) AS rm_pack_size
              FROM requisition_items ri
              JOIN raw_materials rm ON rm.id = ri.material_id
              WHERE ri.req_id = ?
            `).all(po.requisition_id) as any[];
            const decStock = db.prepare(`
              UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
              WHERE id = ?
            `);
            const insPartyTx = db.prepare(`
              INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id, created_at)
              VALUES (?, ?, 'party_consumption', ?, ?, ?, ?, datetime('now'))
            `);
            // The consumption belongs to the requisition's outlet (PO's as a
            // fallback); an unstamped row is backfilled to the DEFAULT outlet.
            const partyOutletId = reqRow.outlet_id || po.outlet_id || null;
            const partyNote = `Party: ${reqRow.event_name || '(unnamed)'} @ ${reqRow.event_date || ''}`.trim();
            const auditItems: any[] = [];
            let totalCost = 0;
            for (const it of reqItems) {
              const issued = Number(it.quantity_issued) || Number(it.quantity_requested) || 0;
              if (issued <= 0) continue;
              decStock.run(issued, it.material_id);
              insPartyTx.run(generateId(), it.material_id, -issued, po.requisition_id, partyNote, partyOutletId);
              // `issued` is RECIPE units; last_purchase_price is ₹/PURCHASE-unit
              // (canon, see the unit-basis boundary note above) — convert first.
              const rPack = Number(it.rm_pack_size) || 1;
              const rUnitsDiffer = String(it.rm_unit || '').toLowerCase().trim()
                !== String(it.rm_purchase_unit || it.rm_unit || '').toLowerCase().trim();
              const lppRecipe = (rPack > 1 && rUnitsDiffer)
                ? (Number(it.last_purchase_price) || 0) / rPack
                : Number(it.last_purchase_price) || 0;
              const unitCost = lppRecipe || Number(it.average_price) || 0;
              const lineCost = Math.round(issued * unitCost * 100) / 100;
              totalCost += lineCost;
              auditItems.push({
                material_id: it.material_id,
                material_name: it.material_name,
                quantity: issued,
                unit_cost: unitCost,
                line_cost: lineCost,
              });
            }
            logAuditEvent(db, {
              event_type: 'requisition.party_consumption',
              entity_type: 'requisition',
              entity_id: po.requisition_id,
              actor_email: receivedByEmail,
              after: { items: auditItems, total_cost: Math.round(totalCost * 100) / 100 },
              note: partyNote,
            });
          }
        }
      }
    });
    txn();

    // Cascade weighted-avg + recipe re-cost outside the transaction (it does its own writes)
    for (const matId of touchedMaterials) updateMaterialPrice(db, matId);

    // ────────────────────────────────────────────────────────────────────
    // Off-PO (deviation) notification.
    // Every line that came in differently from the approved PO — SHORT qty,
    // OVER qty, SHORT-ACCEPTED (arrived in full, part-rejected at QC) or a
    // CHANGED RATE — is sent to the admin via an audit_event
    // (always) + a notifications row (always) + an optional Slack ping (when
    // configured on Settings → Integrations). A short is a vendor service
    // issue, a surplus is stock we never ordered, a short-accept is money the
    // PO expected to spend and didn't, and a rate change rewrites
    // average_price through every recipe — all four are the admin's call, so
    // the alert carries the reason the receiver was forced to give.
    //
    // A BILL DISCOUNT fires the same alert on its own, with no line deviation at
    // all: it moves the cost basis of everything on the bill (and therefore
    // average_price and every recipe) exactly the way a rate change does, so it
    // is the admin's call by the same argument. Delivery rides along in the
    // summary but never raises the alert by itself — it is recorded only and
    // moves no cost.
    // ────────────────────────────────────────────────────────────────────
    const shortLines       = deviationLines.filter(l => l.qty_short);
    const overLines        = deviationLines.filter(l => l.qty_excess);
    const rateChangedLines = deviationLines.filter(l => l.rate_changed);
    // Arrived in full but wasn't all accepted — distinct from a vendor short.
    const accShortLines    = deviationLines.filter(l => l.acc_short && !l.qty_short);
    // The event_type actually written below, echoed back in the response so the
    // caller quotes the string a receiver can really find on /audit instead of
    // guessing from its own line counters. Stays null when nothing was logged
    // (no deviation, or the whole alert block threw and was swallowed).
    let loggedEventType: string | null = null;
    if (deviationLines.length > 0 || chargeAlloc.discount_applied > 0) {
      try {
        const totalExcessValue = excessLines.reduce((s, l) => s + l.excess_value, 0);
        const netValueImpact = Math.round(deviationLines.reduce((s, l) => s + l.value_impact, 0) * 100) / 100;
        const money = (n: number) => `${n < 0 ? '-' : '+'}₹${Math.abs(n).toFixed(0)}`;
        const lineSummary = deviationLines.map(l => {
          const what: string[] = [];
          if (l.qty_short)    what.push(`SHORT ${Math.round((l.ordered - l.received) * 1000) / 1000} ${l.unit}`);
          if (l.qty_excess)   what.push(`OVER ${Math.round((l.received - l.ordered) * 1000) / 1000} ${l.unit}`);
          if (l.acc_short && !l.qty_short) what.push(`SHORT-ACCEPTED ${Math.round((l.ordered - l.accepted) * 1000) / 1000} ${l.unit} (arrived, not accepted)`);
          if (l.rate_changed) what.push(`RATE ₹${l.ordered_rate} → ₹${l.actual_rate} per ${l.unit}`);
          return `• ${l.material_name}: ordered ${l.ordered} ${l.unit} @ ₹${l.ordered_rate}, received ${l.received} ${l.unit} (accepted ${l.accepted}) @ ₹${l.actual_rate}\n    ${what.join(', ')} — value impact ${money(l.value_impact)}\n    reason: ${l.reason || '(none recorded)'}`;
        }).join('\n');
        const counts: string[] = [];
        if (shortLines.length)       counts.push(`${shortLines.length} short`);
        if (overLines.length)        counts.push(`${overLines.length} over`);
        if (accShortLines.length)    counts.push(`${accShortLines.length} short-accepted`);
        if (rateChangedLines.length) counts.push(`${rateChangedLines.length} rate change`);
        // One line for the bill charges, stating which basis each one moved —
        // an admin reading "₹504 off" needs to know whether that changed the
        // cost of the stock (the discount does) or was only filed (delivery is).
        const chargeBits: string[] = [];
        if (chargeAlloc.discount_applied > 0) chargeBits.push(`Bill discount ₹${chargeAlloc.discount_applied.toLocaleString('en-IN')} (netted into cost)`);
        if (chargeAlloc.delivery > 0)         chargeBits.push(`Delivery ₹${chargeAlloc.delivery.toLocaleString('en-IN')} (recorded)`);
        const chargeSummary = chargeBits.length
          ? `${chargeBits.join(' · ')}${chargesNote ? ` — note: "${chargesNote}"` : ''}`
          : '';
        const devTitle = deviationLines.length > 0
          ? `PO ${po.po_number}: ${deviationLines.length} line(s) received off-PO (${counts.join(', ')}; net ${money(netValueImpact)})`
          : `PO ${po.po_number}: received with bill charges`;
        const title = chargeSummary ? `${devTitle} · ${chargeSummary}` : devTitle;
        const body  = `Vendor: ${po.vendor || '—'}\nReceived by: ${receivedByEmail || 'system'}\nGRN: ${(result as any).grn_number}\n\n`
          + (lineSummary    ? `${lineSummary}\n\n`    : '')
          + (chargeSummary  ? `${chargeSummary}\n\n`  : '')
          + `Review on /purchase-orders or /audit.`;

        // A receive whose ONLY deviation is over-quantity keeps the event_type
        // and notification kind it already has — 'po.received_excess' is what
        // /audit and the receive modal's copy call that case today. Short qty,
        // short-accepts and rate changes are new, so they get the general type.
        // This is a per-RECEIVE decision (a mixed receive is one event, logged as
        // 'po.received_deviation'), which is why the resolved type is echoed back
        // in the response — a caller that guessed it from its own per-LINE excess
        // counter sent receivers hunting /audit for a row that was never written.
        // A bill discount is never "excess only": it moves cost, not quantity,
        // so a receive whose only deviation is the discount is a deviation —
        // 'po.received_excess' would file it under a surplus that never arrived.
        const excessOnly = chargeAlloc.discount_applied === 0
          && shortLines.length === 0 && rateChangedLines.length === 0 && accShortLines.length === 0;
        const eventType  = excessOnly ? 'po.received_excess'  : 'po.received_deviation';
        const notifKind  = excessOnly ? 'po_received_excess'  : 'po_received_deviation';

        // 1. Audit event — always written, surfaces on /audit page
        logAuditEvent(db, {
          event_type:  eventType,
          entity_type: 'purchase_order',
          entity_id:   id,
          actor_email: receivedByEmail,
          after: {
            po_number: po.po_number,
            grn_number: (result as any).grn_number,
            excess_value: Math.round(totalExcessValue * 100) / 100,
            net_value_impact: netValueImpact,
            short_lines: shortLines.length,
            over_lines: overLines.length,
            rate_changed_lines: rateChangedLines.length,
            acc_short_lines:    accShortLines.length,
            lines: deviationLines,
            // What the bill's own figures did to this receive. `basis` is the
            // point of the block: one number changed the cost of the stock, the
            // other was filed against it.
            bill_charges: {
              bill_no: billNo,
              note: chargesNote,
              subtotal: chargeAlloc.subtotal,
              discount_requested: chargeAlloc.discount_requested,
              discount_applied: chargeAlloc.discount_applied,
              discount_clamped: chargeAlloc.discount_clamped,
              delivery: chargeAlloc.delivery,
              net_subtotal: chargeAlloc.net_subtotal,
              basis: 'discount netted into purchases.unit_price; delivery recorded only',
              lines: chargeAlloc.lines.map(l => ({
                po_item_id: l.id, material_name: l.name, qty: l.qty,
                gross_rate: l.rate, gross: l.gross,
                discount_share: l.discount_share, delivery_share: l.delivery_share,
                net_total: l.net_total, net_rate: l.net_rate,
              })),
            },
          },
          note: title,
        });
        loggedEventType = eventType;

        // 2. In-app notification row for admin review (kind keyed for dedup)
        db.exec(`
          CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL,
            party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
            channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
            title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at TEXT, delivery_meta TEXT DEFAULT '',
            UNIQUE (party_unique_id, kind, channel)
          )
        `);
        // For a PO deviation we key uniqueness off the PO id via the
        // party_unique_id slot so re-running receive on the same PO doesn't
        // double-notify. One row per receive, listing every deviating line.
        db.prepare(`
          INSERT OR IGNORE INTO notifications
            (id, kind, party_unique_id, channel, recipient, title, body)
          VALUES (?, ?, ?, 'inapp', 'admin', ?, ?)
        `).run(generateId(), notifKind, `po:${id}`, title, body);

        // 3. Optional Slack ping — uses the same webhook the party-refresh job
        // uses. Best-effort: failure here never blocks the receive flow.
        const webhookRow = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value?: string } | undefined;
        const webhook = webhookRow?.value?.trim();
        if (webhook && webhook.startsWith('http')) {
          // Fire-and-forget — don't await so the API response stays snappy.
          fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚨 *${title}*\n${body}`,
            }),
          }).then(() => {
            try {
              db.prepare(`
                UPDATE notifications SET sent_at = datetime('now'), channel = 'slack'
                WHERE kind = ? AND party_unique_id = ?
              `).run(notifKind, `po:${id}`);
            } catch { /* never crash on bookkeeping */ }
          }).catch(() => { /* webhook dead — audit row + in-app already wrote */ });
        }
      } catch (e) {
        console.error('[receive PO] deviation notification failed:', e);
        /* swallow — the receive itself is already committed */
      }
    }

    return Response.json({
      success: true,
      status: 'received',
      received_at: receivedAt,
      grn_id:     (result as any).grn_id,
      grn_number: (result as any).grn_number,
      lines_processed: receivable.length,
      store_blocked: storeBlocked,
      materials_touched: touchedMaterials.size,
      total_cost: total,
      excess_lines: excessLines.length,           // expose to caller so the UI
      excess_value: excessLines.reduce((s, l) => s + l.excess_value, 0),  // can show a "notified admin" confirmation
      // Off-PO counts — the receive modal shows "admin notified" for short qty,
      // short-accepts and rate changes too, not just the accepted-over case
      // above. All FOUR axis counters are published, and they are the same four
      // written into the audit payload: a caller that reasons about "what kind of
      // deviation" from these must not read "none" for a short-accept that moved
      // real stock and money.
      deviation_lines: deviationLines.length,
      short_lines: shortLines.length,
      over_lines: overLines.length,
      acc_short_lines: accShortLines.length,
      rate_changed_lines: rateChangedLines.length,
      // The event_type actually logged for this receive ('po.received_excess' or
      // 'po.received_deviation'), or null if nothing was logged — quote THIS on
      // screen rather than deriving it from the counters above.
      deviation_event_type: loggedEventType,
      // What the bill charges ACTUALLY booked, so the receive modal echoes the
      // committed figures instead of re-deriving them from what it sent —
      // `discount_applied` is clamped to the bill, and the per-line shares carry
      // the remainder-taking rounding the client cannot reproduce line-for-line.
      charges_applied: {
        bill_no: billNo,
        note: chargesNote,
        subtotal: chargeAlloc.subtotal,
        discount_requested: chargeAlloc.discount_requested,
        discount_applied: chargeAlloc.discount_applied,
        discount_clamped: chargeAlloc.discount_clamped,
        delivery: chargeAlloc.delivery,
        net_subtotal: chargeAlloc.net_subtotal,
        lines: chargeAlloc.lines.map(l => ({
          po_item_id: l.id, material_name: l.name, qty: l.qty,
          gross_rate: l.rate, gross: l.gross,
          discount_share: l.discount_share, delivery_share: l.delivery_share,
          net_total: l.net_total, net_rate: l.net_rate,
        })),
      },
    });
  } catch (e: any) {
    console.error('[receive PO]', e);
    // A lost double-receive race is a conflict, not a server fault — the atomic
    // claim inside the txn tags it with 409 so the UI can say "already received".
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
