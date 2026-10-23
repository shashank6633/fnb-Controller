import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { duplicateLineError } from '@/lib/po-helpers';
import { vendorMappingError, vendorResolver, headerVendorFromLines, type VendorRefLike } from '@/lib/vendor-mapping';
import { snapshotPoLines } from '@/lib/po-stock-snapshot';
import { liveReceiptsOnPo, type PoReceiptWitnesses } from '@/lib/po-receipts';
// A merged PO's requisition links ride on the PO lines this route deletes and
// re-inserts (po_item_id cascades) — carried across by material, see the lib.
import { captureRequisitionLinks, restoreRequisitionLinks, type RestoredLinks } from '@/lib/po-link-lifecycle';

/* ══════════════════════════════════════════════════════════════════════════
 * GOODS ALREADY TAKEN IN CLOSE THIS DOOR.
 *
 * Until per-vendor receiving, the status transition alone protected this
 * endpoint: a received PO was 'received', and 'received' is refused above. A
 * PARTIALLY received PO now deliberately STAYS 'approved' (receive/route.ts —
 * that is what keeps Friday's vendor able to deliver against it), so the status
 * check no longer says anything about whether goods have arrived.
 *
 * That mattered because this endpoint DELETEs and re-inserts every
 * purchase_order_items row. New rows get new ids, so the GRN rows written for
 * vendor A's delivery — which are keyed on po_item_id and ARE the receipt
 * ledger (receive/route.ts receivedPoItemIds) — would be orphaned. To the
 * receive route the PO would then look wholly outstanding, and vendor A's goods
 * could be received a SECOND time: stock credited twice, average_price moved
 * twice, and a second bill paid for one delivery.
 *
 * THE RULE, and it is the whole of it: once ANY goods have been received
 * against a PO, its lines are frozen. Evidence is taken from BOTH independent
 * witnesses the receive txn writes — a GRN linked to the PO (the receipt
 * ledger) and a po_vendor_bills row (the vendor's invoice). Either one is
 * enough to refuse; neither can be produced without goods having been booked.
 *
 * There is no partial-edit path and this is not one: a rate that moved on a
 * vendor who has NOT delivered is corrected by an admin at the receiving bay
 * (receive takes an admin-only unit_price override with a deviation reason),
 * and goods that will never come are simply left un-received, which is the
 * honest record.
 *
 * A VOIDED RECEIPT IS NOT EVIDENCE. Both witnesses now come from
 * liveReceiptsOnPo (src/lib/po-receipts.ts) and both skip a voided GRN — the
 * bill witness via the prose 'GRN <number>' link that is po_vendor_bills' only
 * tie to its GRN. `any` is an OR over the two, so the freeze lifts only when
 * NEITHER stands: an admin who voided a wrong receipt can fix the order, and a
 * PO with one live delivery still refuses. Both witnesses had to learn this
 * together — making only the GRN half void-aware would have left the surviving
 * bill row freezing a truly-voided PO for ever.
 *   THE CONSEQUENCE, STATED: rewriting the lines after a void detaches the
 *   voided GRN's po_item_ids (there is no FK on that column, so no error and no
 *   cascade). The voided bill keeps its own material_id and quantities and its
 *   audit snapshot, and the re-received PO gets fresh line ids that no live GRN
 *   claims — which is what makes double-claiming impossible after a reopen.
 * ══════════════════════════════════════════════════════════════════════════ */
type PoReceipts = PoReceiptWitnesses;

/** The refusal, worded so a manager holding a revised quote knows what to do. */
function receiptRefusal(poNumber: string, r: PoReceipts): string {
  const who = [...new Set([
    ...r.bills.map(b => `${b.vendor_name || '(no vendor)'}${b.bill_no ? ` (bill ${b.bill_no})` : ''}`),
    ...r.grns.map(g => `${g.vendor || '(no vendor)'}${g.invoice_number ? ` (bill ${g.invoice_number})` : ''}`),
  ])];
  const grnList = r.grns.map(g => g.grn_number).filter(Boolean).join(', ');
  return `${poNumber} already has goods received against it${who.length ? ` — from ${who.join('; ')}` : ''}`
    + `${grnList ? ` (${grnList})` : ''}. Its lines can no longer be rewritten: that would delete the record of what was `
    + `taken in and let the same delivery be received — and paid for — a second time. `
    + `For a vendor who has NOT delivered yet, an admin can change the rate or quantity at the receiving bay `
    + `(the receive screen takes an admin rate override with a reason); goods that will never arrive are simply left un-received.`;
}

/**
 * Phase 1 §3 — Edit an APPROVED PO. Drops status back to `pending_reapproval`
 * so admin must sign off again before receive. Used when a vendor changes their
 * rate after the original approval, or when quantities need to be tweaked.
 *
 * REFUSED (409) once ANY goods have been received against the PO — a linked GRN
 * or a po_vendor_bills row. See the doctrine block above: partial receipts keep
 * the PO at 'approved', so the status check alone no longer guards this.
 *
 * Body: {
 *   items?: [{ id?, material_id, quantity, unit_price, vendor?, vendor_id?, notes? }],
 *   reason: string,   // required — captured in the audit trail
 * }
 *
 * Behaviour:
 *   - Admin or Manager only (it un-does an admin approval and rewrites the money)
 *   - Only `approved` POs can be edited via this endpoint (drafts use the normal PUT)
 *   - Replaces line items with the new array (at least one line; same material +
 *     store guards as create/edit), and writes a `po.edit` audit event
 *   - Recomputes total_cost.
 *   - Recomputes the HEADER vendor when the edit ADDS OR REMOVES A VENDOR — i.e.
 *     when the header the new lines derive ("Mixed (N vendors)", or the one
 *     vendor and its id) differs from the one the old lines derived. Same
 *     derivation as POST/PUT's deriveHeaderVendor() (headerVendorFromLines over
 *     the lines that carry a vendor NAME, in rowid order). It used to keep its
 *     pre-edit value always, so a vendor swap left "Mixed (3 vendors)" over
 *     four line vendors (finding E6-hdr) or one vendor's name over another's
 *     lines. An edit that leaves the vendor set as it was writes nothing to the
 *     header, so it reads exactly as before; and a set whose lines name no
 *     vendor at all leaves the header alone, as POST/PUT do.
 *   - Status → `pending_reapproval`, clears approved_at/by + sets re-approval
 *     note — claimed atomically (`WHERE status = 'approved'`) as the first
 *     statement of the txn, so a concurrent receive cannot be undone
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // Reversing an admin's approval AND rewriting the PO's money belongs with
    // approve/reject (Admin-only), not with create/submit/receive — so this
    // DELIBERATELY does not use poWriteGate(), whose isManagement() membership
    // also admits a staff-tier head of department. Nothing upstream role-gates
    // /api/* paths, so this route is the only gate. `me.role` from
    // getCurrentUser() is the REAL tier — effectiveRole() would collapse
    // staff → 'manager' and let every signed-in captain through.
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Only Admin or Manager can edit an approved PO' }, { status: 403 });
    }

    const { id } = await params;
    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'approved') {
      return Response.json({ error: `Only approved POs can be edited this way (current: ${po.status}). Drafts use the regular PUT.` }, { status: 400 });
    }
    // ── Goods already in? Then the lines are frozen (see the block at the top
    // of this file). Checked here for a fast, readable refusal, and RE-ASSERTED
    // inside the txn below — a receive that commits during the awaits between
    // the two would otherwise slip past this one and leave 'approved' intact.
    const receipts = liveReceiptsOnPo(db, id);
    if (receipts.any) {
      return Response.json({
        error: receiptRefusal(po.po_number, receipts),
        received_grns:   receipts.grns.map(g => g.grn_number),
        received_vendors: [...new Set(receipts.bills.map(b => b.vendor_name).filter(Boolean))],
      }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : null;
    const reason = String(body?.reason || '').trim();
    if (!reason) return Response.json({ error: 'reason required for re-approval edit' }, { status: 400 });
    if (!items) return Response.json({ error: 'items array required' }, { status: 400 });
    // `Array.isArray([])` is true, so an empty array used to delete every line and
    // write total_cost = 0 — leaving a PO that can neither be received ('PO has no
    // items') nor edited back. Same guard submit uses; zeroing a PO = cancel it.
    if (items.length === 0) {
      return Response.json({ error: 'Cannot edit a PO to zero items — keep at least one line, or cancel the PO' }, { status: 400 });
    }

    // The same checks create/edit run before touching lines (route.ts:176/179/244);
    // this endpoint replaces the WHOLE item set, so it needs them too:
    //  - material must exist — an unknown id vanishes from the detail JOIN and from
    //    receive (both INNER JOIN raw_materials), silently dropping money;
    //  - store-mapped (liquor) materials never enter Central Store POs, else receive
    //    filters them out and hard-fails if they were the only lines;
    //  - qty/rate must be sane. BOTH are written as `!(Number(x) …)` so a
    //    non-numeric or absent value (NaN) is rejected: a bare `< 0` is false for
    //    NaN, and the insert's `Number(x) || 0` would then store the line at ₹0.
    //    Rate here is ₹/PURCHASE-unit (canon); an explicit ₹0 is still accepted
    //    (receive hard-fails on a zero rate, so it can never reach stock/books).
    const matExists = db.prepare('SELECT 1 FROM raw_materials WHERE id = ?');
    for (const it of items) {
      const materialId = String(it?.material_id || '').trim();
      if (!materialId || !matExists.get(materialId)) {
        return Response.json({ error: `Unknown material on a line: ${materialId || '(blank)'}` }, { status: 400 });
      }
      const blocked = centralFlowBlock(db, materialId);
      if (blocked) return Response.json({ error: blocked }, { status: 400 });
      if (!(Number(it.quantity) > 0)) {
        return Response.json({ error: 'Every line needs a quantity greater than 0' }, { status: 400 });
      }
      if (!(Number(it.unit_price) >= 0)) {
        return Response.json({ error: 'Line rate must be a number (₹ per purchase unit) and cannot be negative' }, { status: 400 });
      }
    }
    // …and the same one-material-one-line rule POST/PUT enforce: this endpoint
    // replaces the WHOLE item set, so a repeat here would reach receive as two
    // purchases rows + two stock credits for one item.
    const dupLine = duplicateLineError(items);
    if (dupLine) return Response.json({ error: dupLine }, { status: 400 });
    // …and the STRICT vendor↔item mapping rule create/edit enforce. This
    // endpoint replaces the WHOLE item set (including each line's vendor), so
    // without it "edit the approved PO" would be the way to file a pair the
    // composer refuses — and this path leads straight to receive, where the
    // money is booked against that vendor.
    //
    // ── DOES THIS EDIT ADD OR REMOVE A VENDOR? Then the header follows. ──────
    // Decided HERE, before the rule, because it decides which header a line
    // with no vendor of its own will inherit at receive. The old lines' derived
    // header against the new lines' derived header, by the ONE derivation POST/
    // PUT use (headerVendorFromLines; the old lines read with deriveHeaderVendor's
    // own SELECT). Equal ⇒ the vendor set did not change and the header is left
    // exactly as stored. Different ⇒ the header is re-derived inside the txn. A
    // new set with no named vendor at all ('none') leaves the header alone, as
    // deriveHeaderVendor does.
    const namedLinesBefore = db.prepare(`
      SELECT vendor, vendor_id FROM purchase_order_items
      WHERE po_id = ? AND vendor IS NOT NULL AND TRIM(vendor) != ''
      ORDER BY rowid
    `).all(id) as VendorRefLike[];
    const hdrBefore = headerVendorFromLines(db, namedLinesBefore);
    const hdrPlanned = headerVendorFromLines(db, items as VendorRefLike[]);
    const headerFollows = hdrPlanned.kind !== 'none'
      && (hdrPlanned.kind !== hdrBefore.kind
        || hdrPlanned.vendor !== hdrBefore.vendor
        || hdrPlanned.vendor_id !== hdrBefore.vendor_id);
    // The header is passed because a line with no vendor of its own is received
    // under it — checking such a line against "nothing" would wave through the
    // exact pair receive then books. `headerIsFinal` when the header is NOT
    // re-derived (the vendor set is unchanged): purchase_orders.vendor keeps its
    // pre-edit value, so what is on the row now is literally what those lines
    // inherit. When it IS re-derived, the rule mirrors that derivation itself —
    // exactly as it does for POST/PUT — so a vendor-less line is checked against
    // the header it will really be received under.
    const badPair = vendorMappingError(db, items, {
      headerVendor: { vendor_id: po.vendor_id, vendor: po.vendor },
      headerIsFinal: !headerFollows,
    });
    if (badPair) return Response.json({ error: badPair }, { status: 400 });

    // Snapshot the lines BEFORE the DELETE below — plus the approval this edit
    // erases (approved_by/approved_at are cleared by the atomic claim below).
    // approve/route.ts
    // overwrites approval_note unconditionally, so without this the edited-away
    // numbers and the original approver leave no trace anywhere.
    const beforeItems = db.prepare(`
      SELECT material_id, quantity, unit_price, total_price, vendor, vendor_id
      FROM purchase_order_items WHERE po_id = ?
    `).all(id) as any[];
    // Hoisted so the post-txn audit event can read what replaced them.
    let newTotal = 0;
    const afterItems: any[] = [];
    // What happened to a merged PO's requisition links (null until the lines
    // are rewritten). `as` so the assignment inside the txn is not narrowed away.
    let links = null as RestoredLinks | null;
    // The header this edit wrote, when it differs from the one it found (null
    // otherwise — every edit that leaves the vendor set alone).
    let headerAfter = null as { vendor: string | null; vendor_id: string | null } | null;

    const txn = db.transaction(() => {
      // ── Atomic claim (MUST stay the first statement in this txn) ──────────
      // The status === 'approved' check above is separated from every write by
      // an await (req.json), so a receive that commits inside that window would
      // be silently undone here: the DELETE below would orphan the GRN rows
      // keyed on po_item_id, and the PO would sit at pending_reapproval again —
      // approvable and receivable a SECOND time, double-crediting stock and
      // re-running updateMaterialPrice. better-sqlite3 txns are synchronous, so
      // re-asserting the precondition in the WHERE clause means the loser
      // matches 0 rows and throws, rolling its whole txn back untouched.
      const claim = db.prepare(`
        UPDATE purchase_orders
        SET status = 'pending_reapproval',
            approved_at = NULL,
            approved_by = '',
            updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'
      `).run(id);
      if (claim.changes === 0) {
        const err: any = new Error('This PO is no longer approved (it may have been received). Reload the page.');
        err.httpStatus = 409;
        throw err;
      }

      // ── Receipt re-assert (MUST stay immediately after the claim) ─────────
      // The claim above no longer implies "nothing has been received": a
      // PARTIALLY received PO stays 'approved' on purpose, so a vendor receive
      // that committed inside the await window (req.json / getCurrentUser)
      // leaves the claim matching happily while its GRN rows sit on lines the
      // DELETE below is about to destroy. Being a WRITE, the claim has taken
      // SQLite's write lock, so this read runs under it and cannot be raced by
      // a second connection; better-sqlite3 txns are synchronous, so throwing
      // here rolls the whole edit back with nothing written.
      const now = liveReceiptsOnPo(db, id);
      if (now.any) {
        const err: any = new Error(`${receiptRefusal(po.po_number, now)} Reload the page.`);
        err.httpStatus = 409;
        throw err;
      }

      // Replace line items. The requisition links are read FIRST: the DELETE
      // cascades them away with the old line ids, and they are written back by
      // material once the new lines exist (below).
      const captured = captureRequisitionLinks(db, id);
      db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
      const ins = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // THE SAME RESOLVER vendorMappingError() just used (POST does this too, at
      // route.ts:374). The rule above resolves each line ID-FIRST; storing
      // `it.vendor` verbatim would let a payload carrying vendor_id X with the
      // name "Y" pass the check on X and then be received, stocked and paid under
      // Y — receive, purchases and po_vendor_bills all key on the NAME.
      const lineVendorOf = vendorResolver(db);
      for (const it of items) {
        // Store the SAME trimmed id that was validated above, or a padded id would
        // pass the existence check and then fail the raw_materials JOIN.
        const materialId = String(it.material_id || '').trim();
        const qty = Number(it.quantity) || 0;
        const px  = Number(it.unit_price) || 0;
        const lineTotal = Math.round(qty * px * 100) / 100;
        newTotal += lineTotal;
        const lv = lineVendorOf(it);
        // 'unknown' is unreachable — the rule above refuses it — but if it ever
        // arrived, keep what came in rather than blanking the line silently.
        const lineVendor   = lv.status === 'known' ? lv.name : (lv.status === 'empty' ? '' : lv.shown);
        const lineVendorId = lv.status === 'known' ? lv.id   : (String(it.vendor_id ?? '').trim() || null);
        ins.run(generateId(), id, materialId, qty, px, lineTotal,
                lineVendor, lineVendorId, it.notes || '');
        afterItems.push({ material_id: materialId, quantity: qty, unit_price: px, total_price: lineTotal });
      }

      // Freeze stock for materials NEW to this PO, at this moment. The owner's
      // rule verbatim: originals keep the figure from the 1st raise, "for extra
      // added items also usually take Actual stock at [add] time". ON CONFLICT
      // (po_id, material_id) DO NOTHING inside snapshotPoLines makes both
      // halves true in one call: every material already snapshotted is left
      // untouched, and only the additions get a row, taken now. Inside this
      // txn per the lib's own header — a purchase_order_items row must never
      // exist without the stock figure that was true when it was raised. The
      // 'po_edit_approved_add' source was declared in SnapshotSource for
      // exactly this path and had no caller until here.
      snapshotPoLines(db, id, { takenBy: me.email, source: 'po_edit_approved_add' });

      // Every link whose material is still on the PO follows it to the new
      // line; a material the edit removed drops its links — those requisition
      // lines are free to be ordered again. Never drops anything else. No-op on
      // a PO that carries no links (every PO not built by the merge).
      links = restoreRequisitionLinks(db, id, captured);

      // THE HEADER FOLLOWS THE VENDOR SET (decided before the txn, see the rule
      // above). Re-derived from the rows just inserted, with deriveHeaderVendor's
      // own SELECT — the stored names are the resolver's master spellings, so
      // this is the header POST/PUT would write for these lines.
      if (headerFollows) {
        const namedNow = db.prepare(`
          SELECT vendor, vendor_id FROM purchase_order_items
          WHERE po_id = ? AND vendor IS NOT NULL AND TRIM(vendor) != ''
          ORDER BY rowid
        `).all(id) as VendorRefLike[];
        const hdr = headerVendorFromLines(db, namedNow);
        if (hdr.kind !== 'none') {
          db.prepare(`UPDATE purchase_orders SET vendor = ?, vendor_id = ? WHERE id = ?`)
            .run(hdr.vendor, hdr.vendor_id, id);
          if (hdr.vendor !== po.vendor || (hdr.vendor_id ?? null) !== (po.vendor_id ?? null)) {
            headerAfter = { vendor: hdr.vendor, vendor_id: hdr.vendor_id };
          }
        }
      }

      // Money + note follow the claim (status/approved_at/approved_by were
      // already cleared there): newTotal is only known after the re-insert.
      // Keep a note so admins know who edited and why.
      db.prepare(`
        UPDATE purchase_orders SET
          total_cost = ?,
          approval_note = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(newTotal, `Re-approval requested by ${me.email}: ${reason}`, id);
    });
    txn();

    // 'po.edit' is the key /audit already reserves a tone for (audit/page.tsx:29)
    // and nothing emitted it — this endpoint was the missing writer.
    logAuditEvent(db, {
      event_type: 'po.edit',
      entity_type: 'purchase_order',
      entity_id: id,
      actor_email: me.email,
      before: {
        status: po.status, total_cost: po.total_cost,
        approved_by: po.approved_by, approved_at: po.approved_at,
        items: beforeItems,
        // Only when the header moved — every other po.edit row keeps its shape.
        ...(headerAfter ? { vendor: po.vendor, vendor_id: po.vendor_id ?? null } : {}),
      },
      after: {
        status: 'pending_reapproval', total_cost: newTotal, items: afterItems,
        // Only on a PO that carried links — the shape of every other po.edit
        // row (which po-diff reads) is unchanged.
        ...(links && (links.kept > 0 || links.dropped.length > 0)
          ? { requisition_links: { kept: links.kept, dropped: links.dropped } }
          : {}),
        ...(headerAfter ? { vendor: headerAfter.vendor, vendor_id: headerAfter.vendor_id } : {}),
      },
      note: reason,
    });

    return Response.json({
      success: true, status: 'pending_reapproval',
      ...(links && (links.kept > 0 || links.dropped.length > 0)
        ? { requisition_links: { kept: links.kept, dropped: links.dropped.length } }
        : {}),
      ...(headerAfter ? { vendor: headerAfter.vendor } : {}),
    });
  } catch (e: any) {
    console.error('[edit-approved PO]', e);
    // A lost race against receive/reject is a conflict, not a server fault — the
    // atomic claim inside the txn tags it 409 so the UI can say "reload".
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
