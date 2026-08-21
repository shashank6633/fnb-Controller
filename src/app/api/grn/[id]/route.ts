import { getDb, updateMaterialPrice, logAuditEvent } from '@/lib/db';
import { getCurrentUser, requireRole, getCurrentOutletId, canProcessAsStore, isManagement } from '@/lib/auth';
import { getCentralStoreCutoverDate } from '@/lib/central-cutover';

/**
 * AMEND and VOID one inward entry (GRN).
 *
 *   PUT    /api/grn/[id]  → amend the BILL-LEVEL fields, and RECORD that it was
 *                           amended (who, when, and the field-level diff).
 *   DELETE /api/grn/[id]  → ADMIN ONLY. Reverse the stock this GRN added, then
 *                           VOID the row. Never a hard delete.
 *
 * ── WHY "DELETE" IS A VOID ────────────────────────────────────────────────
 * A received GRN has already moved inventory: it bumped raw_materials.current_stock,
 * wrote a `purchases` cost row per accepted line and an inventory_transactions
 * row per cost row, and dragged raw_materials.average_price through
 * updateMaterialPrice into every sub-recipe and recipe that uses the material.
 * Dropping the header row would leave every one of those in place, silently
 * overstating on-hand for ever. So the document is KEPT — header and line items
 * both, status flipped to 'void' with voided_at / voided_by / void_reason — and
 * what is undone is the movement.
 *
 * It also could not be a hard delete even if we wanted one: material_returns.grn_id
 * and material_return_items.grn_item_id point at these rows, PRAGMA foreign_keys
 * is ON, and goods_receipt_note_items cascades from the header.
 *
 * ── SCOPE LIMIT, STATED PLAINLY: AD-HOC GRNs ONLY ─────────────────────────
 * A PO-sourced GRN (po_id NOT NULL) is REFUSED, and this is a real limitation,
 * not an oversight. Reversing one needs four things this route cannot do
 * honestly on its own:
 *   1. `receivedPoItemIds()` in api/purchase-orders/[id]/receive/route.ts derives
 *      "which PO lines are already received" from goods_receipt_note_items alone,
 *      with no status filter. Keep a voided GRN's item rows (and we must — they
 *      are the bill) and that PO can NEVER be re-received. The same derivation is
 *      repeated in four places in api/purchase-orders/route.ts and once in
 *      .../[id]/edit-approved/route.ts; all six need `AND g.status <> 'void'`
 *      before a PO GRN can be voided, and all six live in files this change does
 *      not own.
 *   2. po_vendor_bills carries no grn_id — its only tie to the GRN is the
 *      sentence in `notes` — and its UNIQUE(po_id, vendor_name, bill_no) means a
 *      surviving row blocks re-receiving the same bill for ever.
 *   3. purchase_orders would have to be reopened (status, received_at,
 *      total_cost back to the ORDERED total, grn_id back to a surviving GRN).
 *   4. A PO that completed a requisition — especially purpose='party', which
 *      DEDUCTS stock a second time at receive — would need a second reversal on
 *      a different rail with its own negative-balance guard.
 * Refusing is reversible; a stray stock credit is not.
 *
 * ── THE WEIGHTED AVERAGE: WHAT THIS DOES, AND WHAT IT CANNOT DO ───────────
 * The reversal DELETES the `purchases` rows this GRN wrote (snapshotted into the
 * audit row first) and then re-runs updateMaterialPrice per material. That is
 * the only option that keeps current_stock, average_price and the variance
 * report moving together — variance-report computes purchases_to_date from
 * SUM(purchases.quantity), not from inventory_transactions, so a soft-flagged
 * row would read as real there and in ~40 other files that SELECT FROM purchases.
 * A NEGATIVE purchases row is explicitly forbidden (src/lib/return-stock.ts):
 * FIFO's "latest purchase" would become the reversal itself and cascade a
 * nonsense rate into every recipe.
 *
 * updateMaterialPrice re-derives the average from the surviving rows in the
 * calendar month of the material's newest remaining purchase, so in the normal
 * case the pre-receipt figure comes back on its own. IT CANNOT when NO purchase
 * rows remain for that material: `if (sameMonth.total_qty > 0)` and the FIFO
 * `if (latest)` both leave average_price untouched, so the voided bill's price
 * stands. Nothing anywhere stores the pre-receipt average, so there is nothing
 * honest to restore it from — the response and the audit row therefore NAME
 * those materials in `average_price_stale` rather than pretend. Same for
 * last_purchase_price, which is a straight overwrite with no history: it is
 * re-derived from the newest surviving purchase, and named in
 * `last_purchase_stale` when there is none.
 *
 * ── WHAT IS NOT UNDONE, DELIBERATELY ──────────────────────────────────────
 * Anything that SPENT the average between receive and void was written at that
 * rate and is a historical snapshot: party-consumption unit_cost/line_cost in
 * audit_events, closing valuations, department-variance valuations, kitchen
 * production batch costs. A void does not rewrite history it did not author.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** An error carrying the HTTP status it should surface as. Thrown from inside
 *  db.transaction(), where a Response cannot be returned, and unwrapped by the
 *  handler's catch — the shape api/purchase-orders/[id]/receive/route.ts uses. */
class GrnRefused extends Error {
  httpStatus: number;
  payload?: Record<string, unknown>;
  constructor(status: number, message: string, payload?: Record<string, unknown>) {
    super(message);
    this.httpStatus = status;
    this.payload = payload;
  }
}

const EPS = 1e-9;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** A stored UTC stamp ('YYYY-MM-DD HH:MM:SS') as the venue reads it. Every other
 *  surface in this feature renders through the page's fmtIST; a message that
 *  interpolated the raw column told an admin in Hyderabad the bill was voided
 *  five and a half hours before they voided it. */
function istStamp(utc: any): string {
  const s = String(utc ?? '').trim();
  if (!s) return '';
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * WRITE THE AUDIT ROW, OR ABORT THE WHOLE OPERATION.
 *
 * logAuditEvent (src/lib/db.ts) is deliberately best-effort — it catches its own
 * error and returns, so an audit failure never breaks the parent operation. That
 * is the right default nearly everywhere and the WRONG one here, twice over:
 *
 *   · grn.void — the before_json it writes is THE ONLY COPY of the `purchases`
 *     rows and inventory_transactions rows this route is about to DELETE, and
 *     the only record of the pre-reversal price fields. Swallow that insert and
 *     the reversal still commits: the cost rows are gone, there is no snapshot
 *     to rebuild them from, and the caller is told `success: true`.
 *   · grn.edit — edit_count is what the owner's "edited" marker hangs on. If the
 *     stamp lands and the event does not, the marker says "amended 2 times" and
 *     points an admin at a history panel that has one entry (or renders nothing
 *     at all). A marker that overstates is worse than no marker.
 *
 * So the insert is VERIFIED here rather than trusted: count before, log, count
 * after, and throw unless it went up by exactly one. Thrown inside the caller's
 * db.transaction(), which rolls the claim, the stamps and the deletes back
 * together. Any failure to even READ the count is also a throw — "cannot prove
 * the record was written" is not "the record was written".
 */
function logAuditOrThrow(
  db: ReturnType<typeof getDb>,
  params: Parameters<typeof logAuditEvent>[1],
  whatWouldBeLost: string,
): void {
  const count = () => (db.prepare(
    `SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = ? AND entity_id = ? AND event_type = ?`
  ).get(params.entity_type, params.entity_id, params.event_type) as any)?.n;
  let before: number;
  try {
    before = Number(count());
    if (!Number.isFinite(before)) throw new Error('audit_events unreadable');
  } catch (e: any) {
    throw new GrnRefused(500,
      `The audit log could not be read (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`);
  }
  logAuditEvent(db, params);
  let after: number;
  try {
    after = Number(count());
  } catch (e: any) {
    throw new GrnRefused(500,
      `The audit log could not be verified (${e?.message || 'unknown error'}), so ${whatWouldBeLost} cannot be recorded. Nothing was changed.`);
  }
  if (after !== before + 1) {
    throw new GrnRefused(500,
      `The audit record for this action could not be written, so ${whatWouldBeLost} would leave no trail. Nothing was changed — check the server log for the [audit] error and try again.`);
  }
}

/** The same outlet predicate the list at GET /api/grn applies:
 *  `(g.outlet_id = ? OR g.outlet_id IS NULL)`. A GRN the caller's own list does
 *  not show is not a GRN they may amend or void — the id alone is not an
 *  authorisation, and neither PUT nor DELETE read the outlet before this. */
function outletBlock(grn: any, outletId: string | null): string | null {
  if (!outletId) return null;                 // no outlet dimension resolved — nothing to scope by
  if (grn.outlet_id == null) return null;     // shared/unassigned document, visible everywhere
  if (String(grn.outlet_id) === String(outletId)) return null;
  return `${grn.grn_number} belongs to a different outlet than the one you are working in. Switch to that outlet first — a bill is amended and voided from the books it was recorded in.`;
}

/** The po_vendor_bills row receive/route.ts wrote for this GRN.
 *
 *  THE LINK IS PROSE, NOT A COLUMN: that table has no grn_id, and receive writes
 *  `notes = 'GRN <number>'` optionally followed by ' — <charges note>'. Both exact
 *  forms are matched here rather than a `LIKE 'GRN <number>%'`, which would also
 *  catch GRN-2026-00011 when looking for GRN-2026-0001 once the sequence passes
 *  four digits. If the match is not EXACTLY ONE row the caller is refused rather
 *  than a guess being rewritten — this row is the duplicate-bill guard. */
function poVendorBillsFor(db: ReturnType<typeof getDb>, poId: string, grnNumber: string): any[] {
  try {
    return db.prepare(`
      SELECT id, po_id, vendor_name, bill_no, bill_date, notes
      FROM po_vendor_bills
      WHERE po_id = ? AND (notes = ? OR notes LIKE ?)
    `).all(poId, `GRN ${grnNumber}`, `GRN ${grnNumber} — %`) as any[];
  } catch {
    // Table missing on an un-migrated DB. Treated as "cannot identify", which
    // the caller turns into a refusal — never into a silent skip.
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — amend the bill-level fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT IS EDITABLE, AND WHY THE REST IS NOT.
 *
 * Editable — the bill's IDENTITY and its paperwork, none of which moves stock
 * or money: invoice_number, invoice_date, vendor / vendor_id (ad-hoc only),
 * qc_by, notes, and the six qc_* ticks.
 *
 * NOT editable here, each for a specific reason:
 *   · `date` — it is the valuation date of every `purchases` row this GRN wrote
 *     AND the month window updateMaterialPrice averages over. Moving it silently
 *     re-values two months of cost and every recipe underneath them, and on a
 *     PO-sourced GRN it would also drift from purchase_orders.received_at. A
 *     wrong receipt date is a void-and-re-enter, not an amendment.
 *   · line items (quantities, rates, charges) — those ARE the stock movement.
 *     Changing them means reversing and re-applying it; that is the void path.
 *   · vendor on a PO-sourced GRN — the vendor there is not free text, it is the
 *     grouping key receive/route.ts filed the lines and the po_vendor_bills row
 *     under. Rewriting it here would orphan that row.
 * Each of those is REFUSED with its reason when sent, never silently ignored: a
 * caller that believes it changed the date is worse off than one that got a 400.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // ── WHO MAY AMEND A COMMITTED BILL ──────────────────────────────────────
    // A session alone is NOT the bar, even though POST /api/grn (which creates
    // the document) settles for one. Three things make this reach further than
    // a create:
    //   · it rewrites purchases.vendor and purchases.bill_no — the spend ledger
    //     behind /api/reports/purchases and purchase-bill-summary, both of which
    //     403 a staff session for merely READING the same figures;
    //   · it rewrites po_vendor_bills.bill_no, the duplicate-bill guard;
    //   · it reaches BACKWARD into history, which a create cannot.
    // src/proxy.ts guards pages, not APIs, and /grn carries no tier flag, so a
    // waiter on a shared floor tablet could reach this with one fetch.
    // The bar is therefore the people who may record a receipt (store manager)
    // or see vendor money (management) — the same shape as
    // api/purchase-orders/[id]/edit-approved, which amends an already-approved
    // purchase document. FAILS CLOSED: both helpers read the RESOLVED tier off
    // the session (never canAccessPage, which fails open four ways), and an
    // unresolvable role leaves both false.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!(canProcessAsStore(me) || isManagement(me))) {
      return Response.json({
        error: 'Amending a received bill is limited to the store manager, a manager or an admin — it rewrites the vendor and bill number on the purchase ledger and on the duplicate-bill guard.',
      }, { status: 403 });
    }
    const db = getDb();

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
    const outOfOutlet = outletBlock(grn, await getCurrentOutletId());
    if (outOfOutlet) return Response.json({ error: outOfOutlet }, { status: 403 });
    if (String(grn.status) === 'void') {
      return Response.json({
        error: `This bill was voided${grn.voided_by ? ' by ' + grn.voided_by : ''}${grn.voided_at ? ' on ' + istStamp(grn.voided_at) : ''} and can no longer be amended. Record a fresh GRN instead.`,
      }, { status: 409 });
    }

    const b = await request.json().catch(() => ({} as any));
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b || {}, k);

    // Refuse the fields that look editable but are not — with the reason.
    if (has('items')) {
      return Response.json({
        error: 'Line items are not editable on an amendment. Quantities and rates ARE the stock movement — void this GRN and record it again.',
      }, { status: 400 });
    }
    if (has('date') && String(b.date || '').trim() !== String(grn.date || '').trim()) {
      return Response.json({
        error: 'The receipt date cannot be amended: it is the valuation date of every cost row this GRN wrote and the month the weighted average is taken over. Void this GRN and record it on the correct date.',
      }, { status: 400 });
    }
    if (has('status')) {
      return Response.json({ error: 'Status is not editable. Use the void action to cancel a bill.' }, { status: 400 });
    }

    const isPoGrn = !!grn.po_id;
    const changes: Record<string, { from: any; to: any }> = {};
    const sets: string[] = [];
    const vals: any[] = [];
    // BOTH SIDES TRIMMED. Every candidate below arrives .trim()ed, but the
    // STORED value is not guaranteed to be — POST /api/grn writes
    // `invoice_number || ''` verbatim — so comparing a trimmed candidate against
    // a raw column reports '  PAD-99  ' → 'PAD-99' as a real amendment: it
    // stamps a permanent "edited" marker, re-stamps the cost rows and writes an
    // audit event for a bill nobody changed. Whitespace-only difference is NOT
    // a change; a genuine difference still writes the trimmed value.
    const same = (a: any, b: any) => String(a ?? '').trim() === String(b ?? '').trim();
    const put = (col: string, next: any, prev: any) => {
      if (same(prev, next)) return;
      changes[col] = { from: prev ?? null, to: next ?? null };
      sets.push(`${col} = ?`); vals.push(next);
    };

    // ── invoice_number — MANDATORY, and an amendment may not remove it ──────
    // Enforced when the field is SENT (a partial patch touching only `notes`
    // must not be blocked by a legacy PO GRN that never had a bill number). What
    // is forbidden is clearing or blanking it: this number is the only way back
    // to the paper months later, and the duplicate-bill guard skips any row
    // whose bill_no is blank — so a cleared number does not merely lose a
    // reference, it turns the guard off for those rows.
    let invoiceChanged = false;
    if (has('invoice_number')) {
      const next = String(b.invoice_number ?? '').trim();
      if (!next) {
        return Response.json({
          error: 'Vendor invoice / bill number is required — an amendment cannot remove the only link back to the vendor\'s paperwork.',
        }, { status: 400 });
      }
      put('invoice_number', next, grn.invoice_number);
      invoiceChanged = 'invoice_number' in changes;
    }
    let invoiceDateChanged = false;
    if (has('invoice_date')) {
      put('invoice_date', String(b.invoice_date ?? '').trim(), grn.invoice_date);
      invoiceDateChanged = 'invoice_date' in changes;
    }

    // ── vendor — ad-hoc only ────────────────────────────────────────────────
    if (has('vendor') || has('vendor_id')) {
      const nextVendor = has('vendor') ? String(b.vendor ?? '').trim() : String(grn.vendor ?? '');
      const nextVendorId = has('vendor_id') ? (String(b.vendor_id ?? '').trim() || null) : (grn.vendor_id ?? null);
      const vendorMoves = !same(nextVendor, grn.vendor) || !same(nextVendorId, grn.vendor_id);
      if (vendorMoves && isPoGrn) {
        return Response.json({
          error: 'The vendor on a PO-sourced GRN cannot be amended — it is the key the PO lines and the vendor bill row were filed under, not a free-text field. Amend the bill number or date instead.',
        }, { status: 400 });
      }
      if (vendorMoves) {
        put('vendor', nextVendor, grn.vendor);
        put('vendor_id', nextVendorId, grn.vendor_id);
      }
    }

    // qc_by is guarded below with the three kitchen ticks — on a gated receipt
    // it IS the kitchen's signature, not a free-text note.
    if (has('notes')) put('notes', String(b.notes ?? ''), grn.notes);

    // ── THE THREE KITCHEN TICKS ARE NOT THE RECEIVER'S TO WRITE ─────────────
    // On a GRN the kitchen QC gate held (qc_required = 1), quality / temperature
    // / damage belong to the CHECKING DEPARTMENT and are stamped by
    // POST /api/grn/[id]/qc together with qc_kitchen_by and qc_kitchen_at.
    // This route's bar is canProcessAsStore || isManagement — i.e. the store
    // manager, the very person the owner's decision 4 separates from the
    // checker. Letting them flip the ticks here would reinstate the exact defect
    // this feature exists to remove ("ticked by the same person doing the
    // inward"), in two ways: BEFORE sign-off it pre-ticks a check nobody made,
    // and AFTER sign-off — or after an override, where they are deliberately
    // left at 0 — it rewrites the kitchen's answer with no second signature and
    // makes the printed GRN say "Quality OK" on goods no one ever judged.
    // SCOPED TO GATED RECEIPTS ONLY. qc_required is 0 on all 29 historical rows
    // and on every ungated delivery, so the pre-existing amend behaviour there
    // is untouched. The STORE's own three (expiry / weight / invoice match) stay
    // amendable on every receipt — they are this caller's half of the split.
    // qc_by IS IN THIS SET, and leaving it out was a hole the guard itself
    // created the appearance of closing. decideGrnQc writes the kitchen
    // signer's email into qc_by (it is the LEGACY single signature that
    // src/app/grn/print/[id]/page.tsx renders as "QC by" and as the
    // "QC verified by" signature line), and an override deliberately blanks it.
    // Left amendable at this route's bar (canProcessAsStore || isManagement),
    // a store manager could type "Ravi — Head Chef" onto a bill nobody checked,
    // or overwrite the real signer's name after a genuine sign-off while
    // qc_kitchen_by — which is never printed — silently disagreed. The printed
    // sheet is the surface most people read, so that is the one that matters.
    const KITCHEN_TICKS = ['qc_quality', 'qc_temperature', 'qc_damage'] as const;
    if (Number(grn.qc_required) === 1) {
      const attempted: string[] = KITCHEN_TICKS.filter(q => has(q) && (b[q] ? 1 : 0) !== (Number(grn[q]) ? 1 : 0));
      if (has('qc_by') && String(b.qc_by ?? '').trim() !== String(grn.qc_by ?? '').trim()) attempted.push('qc_by');
      if (attempted.length > 0) {
        return Response.json({
          error: `Quality, temperature, damage and the QC signature on ${grn.grn_number} are the checking department's to record, not the receiving desk's — this delivery was held for a ${String(grn.qc_checker || 'kitchen')} check. `
            + (String(grn.status) === 'awaiting_qc'
              ? 'Sign it off on Pending Quality Checks, or ask an admin / head chef to release it with a written reason.'
              : 'It has already been decided; a check cannot be re-ticked or re-signed afterwards. Void and re-record the receipt if it was wrong.'),
          fields: attempted,
        }, { status: 400 });
      }
    } else if (has('qc_by')) {
      // Ungated receipt — unchanged behaviour, qc_by stays the free-text note
      // the receiving bay has always typed.
      put('qc_by', String(b.qc_by ?? '').trim(), grn.qc_by);
    }
    for (const q of ['qc_quality', 'qc_temperature', 'qc_expiry', 'qc_damage', 'qc_weight', 'qc_invoice_match']) {
      if (has(q)) put(q, b[q] ? 1 : 0, Number(grn[q]) ? 1 : 0);
    }

    const changed = Object.keys(changes);
    if (changed.length === 0) {
      // NOT stamped as an edit. edit_count is what the row's "edited" marker
      // hangs on, and a save that altered nothing did not amend the bill —
      // bumping it would put a permanent marker on a document nobody changed.
      return Response.json({
        success: true, changed: [], edit_count: Number(grn.edit_count) || 0,
        message: 'Nothing changed.',
      });
    }

    const warnings: string[] = [];
    const editReason = String(b.edit_reason ?? b.reason ?? '').trim();
    let purchasesRestamped = 0;
    let billRowUpdated = 0;

    // THE BULK-IMPORT WILDCARD, counted BEFORE the re-stamp below overwrites it.
    // api/purchases/bulk/route.ts's duplicate guard treats a STORED row with an
    // EMPTY bill_no as matching ANY incoming bill number, and says why in its
    // own comment: without that wildcard "the same file re-uploaded would insert
    // again and DOUBLE the stock". Filling the number in is the right end state
    // — but it DISARMS the wildcard for these rows, so a re-upload of the same
    // inward sheet is only still caught if the number typed here matches the
    // number in the file. Warned, not refused: refusing would make historically
    // blank rows permanently un-amendable, which is the worse of the two.
    const blankBillRows = invoiceChanged
      ? (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE grn_id = ? AND TRIM(COALESCE(bill_no, '')) = ''`)
          .get(id) as any)?.n || 0
      : 0;

    const txn = db.transaction(() => {
      // 1. ATOMIC CLAIM — the write lock and the replay guard in one statement.
      //    The precondition is REPEATED in the WHERE rather than trusted from the
      //    read above, so a void that landed in between is not amended over.
      const claim = db.prepare(`
        UPDATE goods_receipt_notes
        SET ${sets.join(', ')},
            edited_at = datetime('now'), edited_by = ?, edit_count = COALESCE(edit_count, 0) + 1
        WHERE id = ? AND status <> 'void'
      `).run(...vals, me.email, id);
      if (claim.changes === 0) {
        throw new GrnRefused(409, 'This bill was voided while you were editing it. Reload the page.');
      }

      // 2. po_vendor_bills — the duplicate-bill guard for PO receipts. Kept in
      //    step ONLY when the match is exactly one row; a zero or multi match is
      //    a refusal, because rewriting the wrong row would let the same vendor
      //    bill be received twice on that PO.
      if (isPoGrn && (invoiceChanged || invoiceDateChanged)) {
        const rows = poVendorBillsFor(db, String(grn.po_id), String(grn.grn_number));
        if (rows.length !== 1) {
          throw new GrnRefused(409,
            `Cannot amend the bill number: the vendor bill row behind ${grn.grn_number} could not be identified uniquely (${rows.length} match${rows.length === 1 ? '' : 'es'}). That row is the duplicate-bill guard for this PO, and rewriting the wrong one would let the same bill be received twice.`);
        }
        const nextBillNo = invoiceChanged ? String(changes.invoice_number.to ?? '') : rows[0].bill_no;
        const nextBillDate = invoiceDateChanged ? String(changes.invoice_date.to ?? '') : rows[0].bill_date;
        try {
          billRowUpdated = db.prepare(
            `UPDATE po_vendor_bills SET bill_no = ?, bill_date = ? WHERE id = ?`
          ).run(nextBillNo, nextBillDate, rows[0].id).changes;
        } catch (e: any) {
          if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
            throw new GrnRefused(409,
              `Bill no. "${nextBillNo}" is already recorded for ${rows[0].vendor_name || '(no vendor)'} on this PO. The same bill cannot appear twice.`);
          }
          throw e;
        }
      }

      // 3. MIRROR TO THE COST ROWS. purchases.bill_no must not drift from the
      //    GRN's bill number: it is what the duplicate-bill guard keys on and
      //    what a vendor statement is reconciled against. `vendor` is mirrored
      //    for the same reason — the vendor-rate reports read it off this row,
      //    not off the GRN. Both are scoped by the HARD link (purchases.grn_id);
      //    there is no regex fallback on a write.
      if (invoiceChanged) {
        purchasesRestamped = db.prepare(`UPDATE purchases SET bill_no = ? WHERE grn_id = ?`)
          .run(String(changes.invoice_number.to ?? ''), id).changes;
      }
      if ('vendor' in changes) {
        db.prepare(`UPDATE purchases SET vendor = ? WHERE grn_id = ?`)
          .run(String(changes.vendor.to ?? ''), id);
        // ── AND TO THE COST ROW THAT HAS NOT BEEN WRITTEN YET ────────────────
        // A GRN the kitchen QC gate is holding has NO `purchases` rows: the
        // UPDATE above matches nothing, and the cost row is written hours later
        // by decideGrnQc from goods_receipt_note_items.cost_vendor — the copy
        // taken at inward, because on a mixed PO each line is booked against its
        // OWN vendor and the header's name is not it. Without this the amended
        // vendor would reach the GRN and the ledger would still book the typo.
        // SAFE ON EVERY OTHER RECEIPT because it can only fire where the header
        // vendor IS the line vendor: a vendor change on a PO-sourced GRN is
        // already refused above (it is the grouping key), so this branch is
        // ad-hoc-only, where cost_vendor was written as the header vendor. On an
        // already-applied GRN it rewrites a field nothing reads again, which
        // keeps the document and its cost rows telling one story.
        db.prepare(`UPDATE goods_receipt_note_items SET cost_vendor = ? WHERE grn_id = ?`)
          .run(String(changes.vendor.to ?? ''), id);
      }

      // 4. THE RECORD. audit_events is the authority on WHAT changed; the three
      //    stamps on the header row only say that it did, by whom and when.
      //    VERIFIED, not best-effort — if this row does not land, the stamp and
      //    the marker it drives roll back with it (see logAuditOrThrow).
      logAuditOrThrow(db, {
        event_type: 'grn.edit',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        before: Object.fromEntries(changed.map(k => [k, changes[k].from])),
        after: Object.fromEntries(changed.map(k => [k, changes[k].to])),
        note: `Amended ${grn.grn_number}: ${changed.join(', ')}${editReason ? ` — ${editReason}` : ''}`,
      }, 'this amendment');
    });
    txn();

    // A GRN with accepted lines but no cost rows carrying its grn_id predates
    // that column, so the bill number could not be pushed down to them. Reported
    // rather than refused: blocking a legitimate header correction on old data
    // would be worse, and the caller needs to know the guard is still blind for
    // those rows.
    if (invoiceChanged) {
      const acceptedLines = (db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ? AND quantity_accepted <> 0`
      ).get(id) as any)?.n || 0;
      if (acceptedLines > 0 && purchasesRestamped === 0) {
        warnings.push(
          'The bill number was changed on the GRN but no purchase cost row could be re-stamped — this receipt predates purchases.grn_id, so its cost rows are not linked and the duplicate-bill guard stays blind for them.'
        );
      }
      // The opposite case, and the one that can DOUBLE STOCK rather than merely
      // stay blind: rows that had NO bill number now have one, so the bulk
      // importer's empty-bill wildcard no longer covers them.
      if (blankBillRows > 0 && purchasesRestamped > 0) {
        warnings.push(
          `${blankBillRows} cost row(s) on this receipt had no bill number until now. Until today they matched ANY bill number in the CSV importer's duplicate check; from now on they only match "${String(changes.invoice_number.to ?? '')}". If you re-upload an inward sheet that covers these lines, make sure its bill-number column says exactly that — otherwise the importer will treat them as new lines and add the stock a second time.`
        );
      }
    }

    const after = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    return Response.json({
      success: true,
      changed,
      edit_count: Number(after?.edit_count) || 0,
      edited_at: after?.edited_at || null,
      edited_by: after?.edited_by || '',
      purchases_restamped: purchasesRestamped,
      po_vendor_bill_updated: billRowUpdated,
      warnings,
    });
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      return Response.json({ error: e.message, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[grn PUT]', e);
    return Response.json({ error: e?.message || 'Amend failed' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — reverse the stock, then void the row. ADMIN ONLY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY CONDITION UNDER WHICH THIS REFUSES, in the order it checks them:
 *   403  caller is not an admin (requireRole fails closed — no session, an
 *        unresolvable role and any thrown lookup all deny).
 *   403  the GRN belongs to another outlet than the one the caller is working
 *        in — the same predicate the list applies, so a bill you cannot see is
 *        a bill you cannot void.
 *   404  no such GRN.
 *   409  already voided. The claim's WHERE matches nothing on a replay, so a
 *        second call reverses NOTHING — this is the idempotency guarantee.
 *   409  PO-sourced GRN (po_id NOT NULL). See the file header, reason (1)-(4).
 *   409  the receipt is dated ON OR BEFORE a committed central-store cutover.
 *        The cutover RE-BASED current_stock to a physical count that already
 *        absorbs this receipt, and variance-report floors purchases_to_date at
 *        the cutover date — so debiting the stock now would take the book below
 *        the counted baseline with no offsetting term anywhere.
 *   409  a vendor/internal return ticket references this GRN or one of its
 *        lines and is not cancelled/rejected. Part of the stock has already been
 *        reversed on the returns rail; a full void would debit it twice, and
 *        voiding the lines would orphan the ticket's anchor. A SETTLED
 *        (store-verified) ticket and an OPEN one are told apart, because only
 *        the open one can be cleared — a settled return cannot be cancelled, so
 *        that bill is permanently unvoidable and the message says so instead of
 *        sending the admin round a loop.
 *   409  the cost rows cannot be identified: accepted lines exist but no
 *        `purchases` row carries this grn_id (a receipt older than that column),
 *        or the count of linked cost rows does not match the count of accepted
 *        lines. A destructive reversal does not fall back to matching on prose.
 *   409  a linked `purchases` row has no inventory_transactions movement behind
 *        it — the quantity that actually moved is unknown for that row.
 *   409  reversing would drive a material's current_stock below zero. REFUSED,
 *        NEVER CLAMPED (src/lib/return-stock.ts states the rule): a clamp would
 *        commit a void claiming to have reversed more than really moved.
 *
 * WHAT IT REVERSES BY: the RECORDED inventory_transactions.quantity, never a
 * recomputed accepted × pack_size. pack_size is mutable (that is why the
 * unit-audit lock exists), so a recompute would subtract a different number
 * than was added.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // ADMIN ONLY, FAIL CLOSED. Not canAccessPage — that fails open on NULL, [],
    // bad JSON and a non-array, and is not a gate.
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const me = gate.user;
    const db = getDb();

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any;
    if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
    // Scoped to the outlet the caller is working in, exactly as the list is. An
    // admin can void anything — but from that outlet's books, not across them.
    const outOfOutlet = outletBlock(grn, await getCurrentOutletId());
    if (outOfOutlet) return Response.json({ error: outOfOutlet, refused: true }, { status: 403 });

    // Body read BEFORE the transaction: better-sqlite3 transactions are
    // synchronous and nothing may be awaited inside one.
    let reason = '';
    try { const b = await request.json(); reason = String(b?.reason ?? '').trim(); } catch { /* no body is fine */ }

    const cutoverDate = getCentralStoreCutoverDate(db);

    const result: {
      materials: { material_id: string; material_name: string; reversed_qty: number }[];
      purchases_deleted: number;
      transactions_deleted: number;
      average_price_stale: { material_id: string; material_name: string }[];
      last_purchase_stale: { material_id: string; material_name: string }[];
      last_purchase_kept: { material_id: string; material_name: string }[];
    } = { materials: [], purchases_deleted: 0, transactions_deleted: 0, average_price_stale: [], last_purchase_stale: [], last_purchase_kept: [] };

    const txn = db.transaction(() => {
      // ── 1. CLAIM FIRST. Takes the write lock AND is the replay guard: a
      //       second void matches zero rows and the throw below rolls back
      //       before a single quantity has moved.
      const claim = db.prepare(`
        UPDATE goods_receipt_notes
        SET status = 'void', voided_at = datetime('now'), voided_by = ?, void_reason = ?
        WHERE id = ? AND status <> 'void'
      `).run(me.email, reason, id);
      if (claim.changes === 0) {
        const cur = db.prepare('SELECT voided_by, voided_at FROM goods_receipt_notes WHERE id = ?').get(id) as any;
        throw new GrnRefused(409,
          `${grn.grn_number} is already voided${cur?.voided_by ? ' by ' + cur.voided_by : ''}${cur?.voided_at ? ' on ' + istStamp(cur.voided_at) : ''}. Nothing was reversed a second time.`);
      }

      // ── 2. REFUSALS. Every one of these throws, which rolls the claim back.
      if (grn.po_id) {
        throw new GrnRefused(409,
          `${grn.grn_number} was received against a purchase order and cannot be voided here. Reversing it would also have to reopen the PO, remove its vendor bill row and unblock its received lines — and a voided GRN whose lines are kept would permanently block re-receiving that PO. Raise a vendor return for the goods, or book a back-correction GRN.`);
      }

      if (cutoverDate && String(grn.date) <= String(cutoverDate)) {
        throw new GrnRefused(409,
          `${grn.grn_number} is dated ${grn.date}, on or before the central-store cutover (${cutoverDate}). The cutover re-based on-hand stock to a physical count that already includes this receipt, so reversing it now would debit the same goods twice. Correct it with a stock adjustment instead.`);
      }

      // FAILS CLOSED. If this read throws — the returns tables missing on an
      // un-migrated DB, schema init having swallowed its own error — the answer
      // is "cannot prove nothing was returned", and a destructive reversal does
      // not proceed on an unproven assumption.
      //
      // SETTLED AND OPEN ARE BOTH A BAR, BUT THEY ARE NOT THE SAME BAR, and the
      // message has to say which. A SETTLED (store-verified) return has already
      // debited part of this delivery, so a full reversal would take the same
      // grams out twice — and it can never be cancelled either
      // (api/returns/[id] refuses: "a settled stock movement is never undone in
      // place"). Telling that admin to "cancel or settle the returns first" sent
      // them round a loop the system itself forbids. An OPEN ticket really can
      // be cancelled, so for that one the instruction is real.
      let openReturns = 0;
      let settledReturns = 0;
      try {
        const r = db.prepare(`
          SELECT
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS settled,
            SUM(CASE WHEN status <> 'verified' THEN 1 ELSE 0 END) AS open
          FROM material_returns
          WHERE status NOT IN ('cancelled', 'hod_rejected')
            AND (grn_id = ?
                 OR id IN (SELECT ri.return_id FROM material_return_items ri
                            WHERE ri.grn_item_id IN (SELECT gi.id FROM goods_receipt_note_items gi WHERE gi.grn_id = ?)))
        `).get(id, id) as any;
        settledReturns = Number(r?.settled) || 0;
        openReturns = Number(r?.open) || 0;
      } catch (e: any) {
        throw new GrnRefused(409,
          `Cannot confirm whether anything from ${grn.grn_number} has already been returned (${e?.message || 'returns ledger unreadable'}). Refusing rather than risk reversing the same stock twice.`);
      }
      if (settledReturns > 0) {
        throw new GrnRefused(409,
          `${settledReturns} return ticket(s) against ${grn.grn_number} have already been settled by the store, so part of this delivery has physically gone back and its stock is already out of the book. Voiding the whole receipt would take the same goods out a second time. A settled return cannot be cancelled either — this bill can no longer be voided. Correct the remainder with a stock adjustment, or raise a vendor return for what is left.`);
      }
      if (openReturns > 0) {
        throw new GrnRefused(409,
          `${openReturns} open return ticket(s) reference ${grn.grn_number}. Voiding the receipt would leave them anchored to a voided line, and settling them afterwards would reverse the same stock twice. Cancel those tickets first, then void.`);
      }

      const acceptedLines = (db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_note_items WHERE grn_id = ? AND quantity_accepted <> 0`
      ).get(id) as any)?.n || 0;
      const linkedPurchases = (db.prepare(
        `SELECT COUNT(*) AS n FROM purchases WHERE grn_id = ?`
      ).get(id) as any)?.n || 0;
      if (acceptedLines !== linkedPurchases) {
        throw new GrnRefused(409,
          linkedPurchases === 0
            ? `${grn.grn_number} has ${acceptedLines} accepted line(s) but no cost row carries its id, so the rows it wrote cannot be identified. This receipt predates purchases.grn_id; a destructive reversal will not guess from the note text. Correct the stock with an adjustment instead.`
            : `${grn.grn_number} has ${acceptedLines} accepted line(s) but ${linkedPurchases} linked cost row(s). Something else has already changed this receipt's cost rows; reversing a set that does not match the bill would corrupt the average. Investigate before voiding.`);
      }

      const orphanCost = (db.prepare(`
        SELECT COUNT(*) AS n FROM purchases p
        WHERE p.grn_id = ?
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions it
                           WHERE it.type = 'purchase' AND it.reference_id = p.id)
      `).get(id) as any)?.n || 0;
      if (orphanCost > 0) {
        throw new GrnRefused(409,
          `${orphanCost} cost row(s) on ${grn.grn_number} have no stock movement behind them, so the quantity that actually entered stock is unknown for them. A reversal that guessed the quantity would be a fabricated adjustment.`);
      }

      // ── 3. THE MOVEMENT SET, from the RECORDED rows. Never recomputed from
      //       accepted × pack_size: pack_size is mutable, so a recompute can
      //       subtract a different number than was added.
      const moves = db.prepare(`
        SELECT it.material_id                        AS material_id,
               COALESCE(rm.name, it.material_id)     AS material_name,
               SUM(it.quantity)                      AS qty,
               rm.current_stock                      AS current_stock
        FROM inventory_transactions it
        JOIN purchases p ON p.id = it.reference_id
        LEFT JOIN raw_materials rm ON rm.id = it.material_id
        WHERE it.type = 'purchase' AND p.grn_id = ?
        GROUP BY it.material_id
      `).all(id) as any[];

      // ── 4. NEGATIVE-STOCK GUARD, on EVERY material, BEFORE any write.
      //       Balances are read fresh inside this transaction (the SELECT above
      //       runs under the write lock the claim took). Refuse the WHOLE void
      //       if any one material would go under — a partial reversal is exactly
      //       what a single transaction exists to prevent.
      const wouldGoNegative: string[] = [];
      for (const m of moves) {
        const cur = Number(m.current_stock);
        if (!Number.isFinite(cur)) {
          throw new GrnRefused(409,
            `Material ${m.material_name} no longer exists in the master, so its stock cannot be reversed.`);
        }
        if (r6(cur - Number(m.qty || 0)) < -EPS) {
          wouldGoNegative.push(`${m.material_name} (on hand ${r6(cur)}, this GRN added ${r6(Number(m.qty || 0))})`);
        }
      }
      if (wouldGoNegative.length > 0) {
        throw new GrnRefused(409,
          `Reversing ${grn.grn_number} would drive stock below zero for ${wouldGoNegative.length} material(s): ${wouldGoNegative.join('; ')}. The goods have already been consumed or issued, so the receipt cannot honestly be un-received. Nothing was changed.`,
          { materials: wouldGoNegative });
      }

      // ── 5. SNAPSHOT, then reverse. before_json is the ONLY copy of the cost
      //       rows once they are deleted, and the only record of the
      //       pre-reversal price fields, which nothing else stores.
      const txnRows = db.prepare(`
        SELECT it.id, it.material_id, it.type, it.quantity, it.reference_id, it.notes, it.created_at, it.outlet_id
        FROM inventory_transactions it
        JOIN purchases p ON p.id = it.reference_id
        WHERE it.type = 'purchase' AND p.grn_id = ?
      `).all(id) as any[];
      const purchaseRows = db.prepare(`SELECT * FROM purchases WHERE grn_id = ?`).all(id) as any[];
      const matBefore = moves.map(m => {
        // rate-basis: mixed — a VERBATIM SNAPSHOT for the audit row, never a
        // valuation. raw_materials.last_purchase_price is stored in mixed bases
        // across live rows, and nothing here divides, multiplies or compares it:
        // it is copied into before_json precisely so the pre-void value is
        // recoverable, since the re-derive below overwrites it with no history.
        const rm = db.prepare(`
          -- rate-basis: mixed  (verbatim audit snapshot — never valued, never compared)
          SELECT current_stock, average_price, last_purchase_price, last_purchase_date
          FROM raw_materials WHERE id = ?
        `).get(m.material_id) as any;
        return {
          material_id: m.material_id, material_name: m.material_name,
          reversed_qty: r6(Number(m.qty || 0)),
          current_stock: rm?.current_stock ?? null,
          average_price: rm?.average_price ?? null,
          last_purchase_price: rm?.last_purchase_price ?? null,
          last_purchase_date: rm?.last_purchase_date ?? null,
        };
      });

      // ── WHOSE last_purchase_price IS IT? Decided HERE, before the rows are
      //    deleted, and it decides whether the field is touched at all.
      //
      //    The field is a straight overwrite with no history: whoever received
      //    last owns it. Re-deriving it unconditionally on a void therefore
      //    rewrote materials THIS BILL NEVER SET — measured on the live data,
      //    Sugar's LPP was 10 (set by a different GRN), this bill's rate was
      //    100, and the unconditional re-derive moved it to 60 (a third GRN).
      //    Nothing about voiding this bill justifies that: LPP seeds the default
      //    rate on the next PO and is read on the requisition and unit-audit
      //    screens. Worse, re-deriving RE-BASES the value — the newest surviving
      //    purchases.unit_price is purchase-basis, while ~105 live rows of this
      //    column are recipe-basis (see the LPP trap), so an untouched
      //    recipe-basis row could jump 500×.
      //
      //    OWNERSHIP IS PROVEN, NOT ASSUMED: a deleted row of this GRN must
      //    match BOTH the stored last_purchase_date and the stored
      //    last_purchase_price (to 6 dp) for the material. Anything else —
      //    including "cannot tell" — leaves the column exactly as it is and
      //    names the material in `last_purchase_kept`.
      //
      //    THIS IS AN IDENTITY TEST, NOT A VALUATION — that is why reading the
      //    banned column here is safe. Nothing is converted, scaled, summed or
      //    displayed: the stored value is compared ONLY against the
      //    purchases.unit_price that WROTE it (setLpp below and POST /api/grn
      //    both store that number verbatim), so both sides are the same figure
      //    in whatever basis that receipt used. A basis mismatch cannot make
      //    this comparison wrong — it can only make it not match, which is the
      //    fail-safe answer "leave the column alone".
      const lppBefore = new Map(matBefore.map(m => [m.material_id, m]));
      const ownsLpp = new Set<string>();
      for (const m of moves) {
        const prev = lppBefore.get(m.material_id) as any;
        // rate-basis: mixed — identity test only; compared against the very row that wrote it, never valued.
        if (!prev || prev.last_purchase_date == null || prev.last_purchase_price == null) continue;
        const mine = purchaseRows.filter(p => String(p.material_id) === String(m.material_id));
        if (mine.some(p =>
          String(p.date ?? '').trim() === String(prev.last_purchase_date ?? '').trim() &&
          // rate-basis: mixed — identity test only; compared against the very row that wrote it, never valued.
          r6(Number(p.unit_price)) === r6(Number(prev.last_purchase_price))
        )) ownsLpp.add(String(m.material_id));
      }

      // Movements first — the subquery still needs the purchases rows to resolve
      // reference_id. Both use a SUBQUERY rather than an IN list, so a GRN with
      // hundreds of lines can never hit SQLite's 999-variable ceiling.
      result.transactions_deleted = db.prepare(`
        DELETE FROM inventory_transactions
        WHERE type = 'purchase' AND reference_id IN (SELECT id FROM purchases WHERE grn_id = ?)
      `).run(id).changes;
      result.purchases_deleted = db.prepare(`DELETE FROM purchases WHERE grn_id = ?`).run(id).changes;

      const debit = db.prepare(
        `UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now') WHERE id = ?`
      );
      // `rowid DESC` is the final tiebreak and it is not decorative: every
      // purchase row of one delivery shares a `date`, and `created_at` is
      // second-resolution, so `date DESC, created_at DESC` alone leaves the
      // winner to SQLite's scan order. rowid is monotonic per insert, so
      // "newest" means newest.
      const newestPurchase = db.prepare(
        `SELECT unit_price, date FROM purchases WHERE material_id = ? ORDER BY date DESC, created_at DESC, rowid DESC LIMIT 1`
      );
      const setLpp = db.prepare(
        `UPDATE raw_materials SET last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now') WHERE id = ?`
      );
      for (const m of moves) {
        debit.run(Number(m.qty || 0), m.material_id);
        // last_purchase_price is only touched for the materials whose current
        // value THIS BILL SET (ownsLpp, proven above). For those it was
        // overwritten at receive time with no history kept anywhere, so it is
        // re-derived from the newest surviving purchase — the same derivation
        // db.ts's own backfill uses. When none survives there is nothing honest
        // to put there, so the voided bill's rate is left in place and the
        // material is NAMED in last_purchase_stale rather than the response
        // implying it was restored. For everything else the column belongs to a
        // different receipt and is left exactly as it is.
        if (ownsLpp.has(String(m.material_id))) {
          const latest = newestPurchase.get(m.material_id) as any;
          if (latest) setLpp.run(latest.unit_price, latest.date, m.material_id);
          else result.last_purchase_stale.push({ material_id: m.material_id, material_name: m.material_name });
        } else {
          result.last_purchase_kept.push({ material_id: m.material_id, material_name: m.material_name });
        }
        result.materials.push({ material_id: m.material_id, material_name: m.material_name, reversed_qty: r6(Number(m.qty || 0)) });
      }

      // VERIFIED, NOT BEST-EFFORT — and of the two audit writes in this file
      // this is the one that must not be allowed to fail quietly. before_json
      // below is the ONLY copy of the purchases rows and the movements just
      // deleted, and the only record of the pre-reversal price fields. If the
      // insert is swallowed the reversal still commits: the cost rows are gone,
      // there is nothing to rebuild them from, and the response says success.
      // logAuditOrThrow turns that into a rollback.
      logAuditOrThrow(db, {
        event_type: 'grn.void',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        before: {
          grn: {
            grn_number: grn.grn_number, date: grn.date, status: grn.status,
            vendor: grn.vendor, invoice_number: grn.invoice_number, invoice_date: grn.invoice_date,
            received_by: grn.received_by, outlet_id: grn.outlet_id ?? null,
          },
          materials: matBefore,
          purchases: purchaseRows,
          inventory_transactions: txnRows,
        },
        after: {
          status: 'void', voided_by: me.email, void_reason: reason,
          purchases_deleted: result.purchases_deleted,
          transactions_deleted: result.transactions_deleted,
          stock_reversed: result.materials,
        },
        note: `Voided ${grn.grn_number}${reason ? ` — ${reason}` : ''}. Reversed ${result.materials.length} material(s); deleted ${result.purchases_deleted} cost row(s) and ${result.transactions_deleted} stock movement(s). Header and line items kept.`,
      }, 'the reversal (this row is the only copy of the deleted cost rows and stock movements)');
    });
    txn();

    // ── 6. AFTER THE COMMIT: the weighted average and the recipe cascade.
    //       updateMaterialPrice does its own writes and cascades into every
    //       sub-recipe and recipe, so it must not run inside the transaction
    //       above. Materials left with NO surviving purchase row are detected
    //       BEFORE the call and reported: updateMaterialPrice leaves
    //       average_price untouched in that case (`if (sameMonth.total_qty > 0)`
    //       / `if (latest)`), so the voided bill's price silently stands and the
    //       caller has to be told rather than shown a clean success.
    //
    //  PAST THIS LINE THE VOID HAS COMMITTED, so NOTHING here may surface as a
    //  failure. It used to: a SQLITE_BUSY out of updateMaterialPrice (this route
    //  raised exactly that under contention) fell through to the catch and
    //  returned `500 Void failed` on a void that had happened — an admin who
    //  believes a void failed corrects it by hand, on top of the reversal that
    //  already landed. The averages are recoverable (the next purchase re-derives
    //  them, and updateMaterialPrice can be re-run); a duplicated manual
    //  correction is not. So this phase reports through `warnings`, per material,
    //  and the response still says the void succeeded — because it did.
    const priceWarnings: string[] = [];
    for (const m of result.materials) {
      try {
        const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE material_id = ?`)
          .get(m.material_id) as any)?.n || 0;
        if (remaining === 0) result.average_price_stale.push({ material_id: m.material_id, material_name: m.material_name });
        updateMaterialPrice(db, m.material_id);
      } catch (e: any) {
        console.error('[grn DELETE/void] post-commit price refresh failed', m.material_id, e);
        priceWarnings.push(
          `${m.material_name}: the weighted average could not be re-derived after the reversal (${e?.message || 'unknown error'}). The stock WAS reversed — do not void or adjust again; the next purchase of this material will correct its average.`
        );
      }
    }
    if (result.average_price_stale.length > 0) {
      // Best-effort ON PURPOSE, unlike the two writes inside the transactions:
      // this note is a follow-up about a price field, the reversal it annotates
      // is already recorded in grn.void, and there is no longer a transaction to
      // roll back. Losing it must not turn a committed void into an error.
      logAuditEvent(db, {
        event_type: 'grn.void.price_stale',
        entity_type: 'goods_receipt_note',
        entity_id: id,
        actor_email: me.email,
        outlet_id: grn.outlet_id ?? null,
        after: { materials: result.average_price_stale },
        note: 'No purchase rows remain for these materials, so the weighted average still carries the voided bill\'s price. Nothing stores the pre-receipt average; it must be corrected by hand or by the next real purchase.',
      });
    }

    // Also post-commit, so also guarded: the void does not become a 500 because
    // the read-back of its own row lost a race for the lock.
    let after: any = null;
    try { after = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(id) as any; } catch { /* reported below */ }
    return Response.json({
      success: true,
      voided: true,
      grn_number: grn.grn_number,
      voided_by: after?.voided_by || me.email,
      voided_at: after?.voided_at || null,
      void_reason: after?.void_reason ?? reason,
      stock_reversed: result.materials,
      purchases_deleted: result.purchases_deleted,
      transactions_deleted: result.transactions_deleted,
      average_price_stale: result.average_price_stale,
      last_purchase_stale: result.last_purchase_stale,
      last_purchase_kept: result.last_purchase_kept,
      warnings: priceWarnings,
      notice: [
        'The bill document is kept — header and line items are unchanged; only the stock and cost rows were reversed.',
        // ── A HELD RECEIPT VOIDS TO A CLEAN ZERO, AND THAT IS NOT A FAILURE ──
        // A GRN the kitchen QC gate was still holding never moved stock and
        // never wrote a cost row, so the reversal above legitimately finds
        // nothing: 0 materials, 0 purchases, 0 movements. Said out loud because
        // "reversed 0 material(s)" on an admin's screen otherwise reads as the
        // void having silently failed, and the correction for that belief is
        // another manual adjustment on top of a receipt that never landed.
        // It also takes the receipt out of the Pending Quality Checks queue for
        // good: the sign-off's claim matches only status = 'awaiting_qc', so a
        // voided receipt can never be signed and QC can never un-void one.
        String(grn.status) === 'awaiting_qc'
          ? 'This receipt was still waiting for a quality check, so no stock had ever been added and there was nothing to reverse. It has left the Pending Quality Checks queue and can no longer be signed off.'
          : '',
        result.average_price_stale.length
          ? `${result.average_price_stale.length} material(s) have no purchases left, so their weighted average still carries this bill's price — correct it by hand or with the next purchase.`
          : 'Weighted averages were re-derived from the surviving purchases.',
        result.last_purchase_kept.length
          ? `${result.last_purchase_kept.length} material(s) kept their existing last-purchase rate — it came from a different receipt, not from this bill.`
          : '',
        'Valuations already taken at the old average (closing stock, department variance, party consumption, production batches) are historical and were NOT rewritten.',
      ].filter(Boolean).join(' '),
    });
  } catch (e: any) {
    if (e instanceof GrnRefused) {
      return Response.json({ error: e.message, refused: true, ...(e.payload || {}) }, { status: e.httpStatus });
    }
    console.error('[grn DELETE/void]', e);
    return Response.json({ error: e?.message || 'Void failed' }, { status: 500 });
  }
}
