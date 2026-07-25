import { getDb, generateId, updateMaterialPrice, logAuditEvent } from '@/lib/db';
import { poWriteGate } from '@/lib/po-helpers';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { todayIST } from '@/lib/format-date';

/**
 * Mark an approved PO as Received.
 * Side effects (atomic):
 *   1. Insert one row into `purchases` per PO line (so weighted-avg + history works).
 *   2. Bump raw_materials.current_stock by quantity.
 *   3. Update raw_materials.last_purchase_price + last_purchase_date.
 *   4. Run updateMaterialPrice → recomputes average_price + cascades recipe / sub-recipe costs.
 *   5. Insert inventory_transactions.
 *
 * Optional body: { received_at?, item_overrides?: [{po_item_id, quantity?, unit_price?}] }
 *   — lets the receiver record short/over-shipments before commit.
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
    // Per-line overrides now support accept/reject for QC at the receiving bay.
    const overrides: Map<string, { quantity?: number; unit_price?: number; accepted?: number; rejection_reason?: string }> = new Map();
    if (Array.isArray(body?.item_overrides)) {
      for (const o of body.item_overrides) {
        if (o?.po_item_id) overrides.set(o.po_item_id, {
          quantity: o.quantity, unit_price: o.unit_price,
          accepted: o.accepted, rejection_reason: o.rejection_reason,
        });
      }
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
        return Response.json({
          error: `Missing or zero rate on "${it.material_name}". A receive rewrites this material's average price, so the line needs a real ₹/${puLabel(it) || 'unit'} — edit the PO line rate (or send a unit_price override) before receiving.`,
          material: it.material_name,
          field: 'unit_price',
        }, { status: 400 });
      }
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

      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, outlet_id, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, datetime('now'))
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
      // body.item_overrides may now include: { po_item_id, quantity (=received), accepted, rejection_reason }
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

      const insGrnItem = db.prepare(`
        INSERT INTO goods_receipt_note_items
          (id, grn_id, po_item_id, material_id, quantity_ordered, quantity_received,
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Excess detection happens inline below — the `excessLines` array is
      // hoisted at the outer function scope (filled here, read post-txn for
      // the admin audit + Slack ping).
      for (const it of receivable) {
        const ov = overrides.get(it.id);
        const received = ov?.quantity   != null ? Number(ov.quantity)   : it.quantity;
        const accepted = ov?.accepted   != null ? Number(ov.accepted)   : received;
        const rejected = Math.max(0, received - accepted);
        const reason   = String(ov?.rejection_reason || '').trim();
        const price    = ov?.unit_price != null ? Number(ov.unit_price) : it.unit_price;
        const acceptedTotal = Math.round(accepted * price * 100) / 100;
        total += acceptedTotal;

        // Excess detection — store accepted MORE than the PO line ordered.
        // (Rejected portion never enters stock so we compare against accepted,
        // not received — that's what actually impacts inventory + books.)
        if (accepted > it.quantity) {
          const excess = accepted - it.quantity;
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

        // GRN item row — always written so the audit trail captures received + rejected too
        insGrnItem.run(generateId(), grnId, it.id, it.material_id,
                       it.quantity, received, accepted, rejected, reason, price,
                       rejected > 0 ? `Rejected ${rejected} (${reason || 'no reason given'})` : '');

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
          // Stamp the receipt with the PO's outlet (the GRN header above already
          // does). A NULL here gets backfilled to the DEFAULT outlet by the
          // startup migration, silently moving another outlet's purchase.
          insPurchase.run(purchaseId, it.material_id, lineVendor, accepted, price, acceptedTotal, receivedAt,
            `Received against ${po.po_number} (GRN ${grnNumber})`, po.outlet_id);
          bumpStock.run(stockQty, price, receivedAt, it.material_id);
          insTx.run(generateId(), it.material_id, stockQty, purchaseId, `PO ${po.po_number} received via GRN ${grnNumber}`, po.outlet_id);
          touchedMaterials.add(it.material_id);
        }
      }

      // Mark the GRN as 'partial' if any rejections happened, 'received' otherwise
      const rejCount = db.prepare(`SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ? AND quantity_rejected > 0`).get(grnId) as any;
      if (rejCount.n > 0) {
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
    // Excess-acceptance notification.
    // Every line where the store accepted MORE than the PO ordered is sent
    // to the admin via an audit_event (always) + a notifications row (always)
    // + an optional Slack ping (when configured on Settings → Integrations).
    // The store's surplus could be intentional (vendor over-shipped and we
    // kept it) or a clerical error — admin reviews and decides.
    // ────────────────────────────────────────────────────────────────────
    if (excessLines.length > 0) {
      try {
        const totalExcessValue = excessLines.reduce((s, l) => s + l.excess_value, 0);
        const lineSummary = excessLines.map(l =>
          `• ${l.material_name}: ordered ${l.ordered} ${l.unit}, accepted ${l.accepted} ${l.unit} (excess ${l.excess} ${l.unit} ≈ ₹${l.excess_value.toFixed(0)})`
        ).join('\n');
        const title = `PO ${po.po_number}: ${excessLines.length} line(s) accepted over ordered qty (₹${totalExcessValue.toFixed(0)} excess)`;
        const body  = `Vendor: ${po.vendor || '—'}\nReceived by: ${receivedByEmail || 'system'}\nGRN: ${(result as any).grn_number}\n\n${lineSummary}\n\nReview on /purchase-orders or /audit.`;

        // 1. Audit event — always written, surfaces on /audit page
        logAuditEvent(db, {
          event_type:  'po.received_excess',
          entity_type: 'purchase_order',
          entity_id:   id,
          actor_email: receivedByEmail,
          after: {
            po_number: po.po_number,
            grn_number: (result as any).grn_number,
            excess_value: Math.round(totalExcessValue * 100) / 100,
            lines: excessLines,
          },
          note: title,
        });

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
        // For PO excess we key uniqueness off the PO id via the party_unique_id
        // slot so re-running receive on the same PO doesn't double-notify.
        db.prepare(`
          INSERT OR IGNORE INTO notifications
            (id, kind, party_unique_id, channel, recipient, title, body)
          VALUES (?, 'po_received_excess', ?, 'inapp', 'admin', ?, ?)
        `).run(generateId(), `po:${id}`, title, body);

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
                WHERE kind = 'po_received_excess' AND party_unique_id = ?
              `).run(`po:${id}`);
            } catch { /* never crash on bookkeeping */ }
          }).catch(() => { /* webhook dead — audit row + in-app already wrote */ });
        }
      } catch (e) {
        console.error('[receive PO] excess notification failed:', e);
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
    });
  } catch (e: any) {
    console.error('[receive PO]', e);
    // A lost double-receive race is a conflict, not a server fault — the atomic
    // claim inside the txn tags it with 409 so the UI can say "already received".
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
