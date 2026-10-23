import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canProcessAsStore } from '@/lib/auth';
import { poWriteGate } from '@/lib/po-helpers';
import { centralFlowBlock } from '@/lib/store-engine';
import { todayIST, fmtIST } from '@/lib/format-date';
import { QC_AWAITING } from '@/lib/grn-qc';
import { fulfilRequisitionFromPo } from '@/lib/po-requisition-fulfil';
import { receivedPoItemIds, liveClaimSql, liveValueSql } from '@/lib/po-receipts';
import {
  closedPoItemIds, poVendorClosures, syncPoLinkFlags, lineIsClosure, lineVendorName, vendorKeyOf,
  type LinkFlagSync,
} from '@/lib/po-link-lifecycle';

/* ══════════════════════════════════════════════════════════════════════════
 * SHORT-CLOSE ONE VENDOR ON AN APPROVED PO (owner ruling 69, 2026-10-23).
 *
 *   POST /api/purchase-orders/:id/close-vendor  { vendor_id, reason }
 *   GET  /api/purchase-orders/:id/close-vendor  → the PO's closures
 *
 * WHY IT EXISTS. A merged PO carries many vendors under one number. An
 * approved PO cannot be cancelled, and it completes only when every receivable
 * line has a receipt — so ONE vendor who never delivers held the whole order
 * (and every department's requisition behind it) 'approved' for ever.
 *
 * WHAT IT DOES. Records a po_vendor_closures row (who, when, why). From then
 * on that vendor's lines that NO live receipt claims are "not delivered":
 *   · receive neither offers nor owes them (receive/route.ts reads
 *     closedPoItemIds, exactly as it skips a store-blocked line);
 *   · a merged PO's links on them read vendor_closed = 1, which frees those
 *     requisition lines to be ordered again;
 *   · the PO completes when every other line is received — here, if that is
 *     already true, or at the last vendor's receipt otherwise.
 * Lines of that vendor which DID arrive (including one still on a kitchen QC
 * hold) are received, not closed — a short delivery stays a short delivery.
 *
 * WHO. Store manager or admin (ruling 65/69) — canProcessAsStore — working in
 * the PO's own outlet (403 wrong_outlet otherwise; a PO with no outlet passes).
 * WHICH POs. APPROVED only (a draft/pending PO is edited instead; a received
 * one has nothing left to close), and only a MERGED PO or a MIXED one (two or
 * more vendors). A single-vendor order is closed by receiving what came, with
 * the short recorded, which is the existing path.
 *
 * COMPLETING ON A CLOSE. Same writes as the receive route's completion branch:
 * status 'received', received_at, total_cost = the received NET (live,
 * value-counted: void and QC-held bills out — a held bill's sign-off re-stamps
 * it, grn-qc.ts), and the single-requisition cascade when the PO has a
 * requisition_id and no bill is held — the same helper, the same gate. A
 * merged PO has requisition_id NULL, so it never fires there (ruling 67).
 *   received_at is the date of the LATEST live receipt — when the goods last
 *   came in — not today: a close weeks later must not move the order's
 *   received date into a different period.
 *   And if NOTHING was ever received on the order, every vendor is now closed
 *   and there is nothing to call "received": the PO becomes 'cancelled', which
 *   is what it is. Its requisition lines are then free to be ordered again.
 * ══════════════════════════════════════════════════════════════════════════ */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

class Refused extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can view PO closures' }, { status: 403 });
    const { id } = await params;
    const db = getDb();
    const po = db.prepare(`SELECT id, po_number, status FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({
      po_id: po.id, po_number: po.po_number, status: po.status,
      closures: poVendorClosures(db, id).map(c => ({
        vendor_id: c.vendor_id, vendor_name: c.vendor_name, reason: c.reason,
        closed_by: c.closed_by, closed_at: c.closed_at,
      })),
      closed_po_item_ids: [...closedPoItemIds(db, id)],
    });
  } catch (e: any) {
    console.error('[close-vendor GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) {
      return Response.json({ error: 'Only the store manager or an admin can short-close a vendor on a PO' }, { status: 403 });
    }
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const vendorId = String(body?.vendor_id ?? '').trim();
    const reason = String(body?.reason ?? '').trim();
    if (!vendorId) return Response.json({ error: 'vendor_id required — which vendor is being closed?', field: 'vendor_id' }, { status: 400 });
    if (reason.length < 3) {
      return Response.json({ error: 'A reason is required (at least 3 characters) — it is recorded on the order and shown wherever the closed lines are.', field: 'reason' }, { status: 400 });
    }
    // The outlet the caller is working in — read BEFORE the synchronous block
    // below (it is the last await), and checked against the PO right after the
    // PO is read. Same predicate as GET /api/grn and grn/[id]'s outletBlock:
    // a PO with no outlet is shared and passes; any other must match.
    const sessionOutletId = await getCurrentOutletId();

    // ── EVERYTHING BELOW IS SYNCHRONOUS. No await between the reads and the
    // transaction, so no receive can land in between within this process; the
    // claim inside the transaction covers anything else.
    const db = getDb();
    const po = db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    // A vendor is short-closed from the books the order belongs to, never
    // across outlets by id (measured: a Branch-2 store manager closed a Main
    // PO's vendor, 200). The merge itself is already outlet-safe (other_outlet).
    if (sessionOutletId && po.outlet_id != null && String(po.outlet_id) !== String(sessionOutletId)) {
      return Response.json({
        error: `${po.po_number} belongs to a different outlet than the one you are working in. Switch to that outlet first — a vendor is closed on the books the order was raised in.`,
        code: 'wrong_outlet',
      }, { status: 403 });
    }
    if (po.status !== 'approved') {
      return Response.json({
        error: `${po.po_number} is "${po.status}". Only an approved order's vendor can be short-closed — a draft or pending order is edited instead, and a received one has nothing left to deliver.`,
      }, { status: 409 });
    }

    const master = db.prepare(`SELECT id, name FROM vendors WHERE id = ?`).get(vendorId) as any;
    const masterName = String(master?.name ?? '');
    const items = db.prepare(`
      SELECT poi.id, poi.material_id, poi.quantity, poi.unit_price, poi.vendor, poi.vendor_id,
             rm.name AS material_name,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit, '') AS purchase_unit
        FROM purchase_order_items poi
        JOIN raw_materials rm ON rm.id = poi.material_id
       WHERE poi.po_id = ?
       ORDER BY poi.rowid
    `).all(id) as any[];

    // Store-mapped lines are never receivable here (receive skips them), so they
    // are never owed and never "closed" — left out of every set below.
    const blocked = new Set(items.filter(it => centralFlowBlock(db, String(it.material_id || ''))).map(it => String(it.id)));
    const receivable = items.filter(it => !blocked.has(String(it.id)));
    const vendorKeys = new Set(receivable.map(it => vendorKeyOf(lineVendorName(it, po))));
    const merged = Number(po.merged) === 1;
    if (!merged && vendorKeys.size < 2) {
      return Response.json({
        error: `${po.po_number} has one vendor. Short-close is for a merged or multi-vendor order. For a single vendor, receive what arrived and record the short — the line closes as received-and-short.`,
      }, { status: 409 });
    }

    const probe = { vendor_id: vendorId, vendor_name: masterName, master_name: masterName };
    const mine = receivable.filter(it => lineIsClosure(it, po, probe));
    if (mine.length === 0) {
      return Response.json({
        error: `No lines on ${po.po_number} are ordered from ${masterName || 'that vendor'}.`,
        field: 'vendor_id',
      }, { status: 400 });
    }
    // The name receive files these lines under — stored on the closure so a
    // later rename of the vendor master still finds them.
    const filingName = lineVendorName(mine[0], po);
    const vendorLabel = filingName || masterName || '(no vendor)';

    type Outcome = {
      status: 'approved' | 'received' | 'cancelled';
      closedLines: any[];
      links: LinkFlagSync;
      cascaded: boolean;
      receivedAt: string | null;
      totalCost: number | null;
      closureId: string;
    };
    // `as`, not an annotation: assigned inside the transaction callback, and an
    // annotated `= null` would be narrowed to null for the code after it.
    let outcome = null as Outcome | null;

    const txn = db.transaction(() => {
      // ── Atomic claim (first statement): takes SQLite's write lock and
      // re-asserts 'approved', so a concurrent receive/edit/void that moved the
      // order since the read above makes this match 0 rows and roll back.
      const claim = db.prepare(`
        UPDATE purchase_orders SET updated_at = datetime('now') WHERE id = ? AND status = 'approved'
      `).run(id);
      if (claim.changes === 0) throw new Refused(409, `${po.po_number} is no longer approved (it may just have been received). Reload the page.`);

      // Under the lock: already closed?
      const already = poVendorClosures(db, id).find(c => (c.vendor_id && c.vendor_id === vendorId)
        || (!!vendorKeyOf(filingName) && vendorKeyOf(c.vendor_name) === vendorKeyOf(filingName)));
      if (already) {
        throw new Refused(409, `${vendorLabel} was already short-closed on ${po.po_number} by ${already.closed_by} on ${fmtIST(already.closed_at)}${already.reason ? ` (${already.reason})` : ''}.`);
      }

      // Under the lock: which of the vendor's lines are still undelivered?
      const claimed = receivedPoItemIds(db, id);
      const undelivered = mine.filter(it => !claimed.has(String(it.id)));
      if (undelivered.length === 0) {
        throw new Refused(409, `${vendorLabel} has nothing left to deliver on ${po.po_number} — every line they supply has been received. Nothing to close.`);
      }

      const closureId = generateId();
      db.prepare(`
        INSERT INTO po_vendor_closures (id, po_id, vendor_id, vendor_name, reason, closed_by, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(closureId, id, vendorId, filingName, reason, me.email);

      // ── IS THE ORDER DONE NOW? The receive route's rule, with closed lines
      // taken off the order: complete when no receivable line is left that is
      // neither claimed by a live receipt nor closed.
      const closedNow = closedPoItemIds(db, id);
      const owed = receivable.filter(it => !claimed.has(String(it.id)) && !closedNow.has(String(it.id)));
      let status: 'approved' | 'received' | 'cancelled' = 'approved';
      let cascaded = false;
      let receivedAt: string | null = null;
      let totalCost: number | null = null;

      if (owed.length === 0) {
        const live = db.prepare(`
          SELECT COUNT(*) AS n, MAX(g.date) AS last_date
            FROM goods_receipt_notes g
           WHERE g.po_id = ? AND ${liveClaimSql('g')}
        `).get(id) as any;
        if ((Number(live?.n) || 0) === 0) {
          // Every vendor closed, nothing ever delivered: the order was called off.
          db.prepare(`
            UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now')
            WHERE id = ? AND status = 'approved'
          `).run(id);
          status = 'cancelled';
        } else {
          receivedAt = String(live?.last_date || '') || todayIST();
          totalCost = r2(Number((db.prepare(`
            SELECT COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2) - gi.discount), 0) AS net
              FROM goods_receipt_note_items gi
              JOIN goods_receipt_notes g ON g.id = gi.grn_id
             WHERE g.po_id = ? AND ${liveValueSql('g')}
          `).get(id) as any)?.net) || 0);
          db.prepare(`
            UPDATE purchase_orders
               SET status = 'received', received_at = ?, total_cost = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'approved'
          `).run(receivedAt, totalCost, id);
          status = 'received';
          // The single-requisition cascade, exactly as receive fires it on
          // completion: only with a requisition_id (never on a merged PO) and
          // only with no bill of this order still on a QC hold — grn-qc fires
          // it at the last sign-off otherwise.
          const held = Number((db.prepare(
            `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE po_id = ? AND status = ?`,
          ).get(id, QC_AWAITING) as any)?.n || 0);
          if (po.requisition_id && held === 0) {
            fulfilRequisitionFromPo(db, {
              requisitionId: String(po.requisition_id),
              poOutletId: po.outlet_id ?? null,
              actorEmail: me.email,
            });
            cascaded = true;
          }
        }
      }

      const links = syncPoLinkFlags(db, id);
      outcome = { status, closedLines: undelivered, links, cascaded, receivedAt, totalCost, closureId };
    });

    try {
      txn();
    } catch (e: any) {
      if (e instanceof Refused) return Response.json({ error: e.message, ...e.extra }, { status: e.status });
      throw e;
    }
    if (!outcome) throw new Error('close-vendor: the transaction committed without an outcome');
    const o: Outcome = outcome;

    const closedLines = o.closedLines.map(it => ({
      po_item_id: String(it.id), material_id: String(it.material_id), material_name: it.material_name,
      // PURCHASE units (purchase_order_items canon) — the unit the line is ordered in.
      quantity: Number(it.quantity) || 0, unit: String(it.purchase_unit || ''),
      ordered_value: r2((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)), // rate-basis: purchase
    }));

    logAuditEvent(db, {
      event_type: 'po.close_vendor', entity_type: 'purchase_order', entity_id: String(id),
      actor_email: me.email, outlet_id: po.outlet_id ?? null,
      before: { status: 'approved', total_cost: po.total_cost },
      after: {
        status: o.status, vendor_id: vendorId, vendor_name: vendorLabel,
        closed_lines: closedLines, received_at: o.receivedAt, total_cost: o.totalCost,
        requisition_cascaded: o.cascaded, links_vendor_closed: o.links.vendor_closed,
      },
      note: `${vendorLabel} short-closed on ${po.po_number}: ${reason}`,
    });

    return Response.json({
      success: true,
      po_id: String(id), po_number: po.po_number,
      po_status: o.status,
      completed: o.status === 'received',
      cancelled: o.status === 'cancelled',
      vendor: { id: vendorId, name: vendorLabel },
      closure: { id: o.closureId, reason, closed_by: me.email },
      closed_lines: closedLines,
      received_at: o.receivedAt,
      total_cost: o.totalCost,
      requisition_cascaded: o.cascaded,
      requisition_links: o.links.links > 0
        ? { links: o.links.links, vendor_closed: o.links.vendor_closed, delivered_direct: o.links.delivered_direct }
        : null,
    });
  } catch (e: any) {
    console.error('[close-vendor POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
