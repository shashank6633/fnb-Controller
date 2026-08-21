import { getDb, generateId, updateMaterialPrice } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canProcessAsStore, isManagement } from '@/lib/auth';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { duplicateLineError } from '@/lib/po-helpers';
import { resolveQcRequirement, storePreRejectBlock, QC_AWAITING } from '@/lib/grn-qc';
import { notifyGrnAwaitingQc } from '@/lib/grn-qc-notify';

/**
 * GRN read API. Listing + detail.
 *
 * GET /api/grn                  → list (?from=&to=&vendor_id=&status=)
 * GET /api/grn?id=X             → detail with line items + linked PO
 *
 * POST /api/grn → ad-hoc GRN for receipts WITHOUT a parent PO (cash buy, sample,
 *                  donation, return). Creates the GRN + a `purchases` row per
 *                  accepted line + bumps stock + writes inventory_transactions.
 *   body: {
 *     date, vendor_id?, vendor, invoice_number?, invoice_date?, qc_by?, notes?,
 *     items: [{
 *       material_id, quantity_received, quantity_accepted?, rejection_reason?,
 *       unit_price, notes?, gst_rate?, cess_rate?
 *     }]
 *   }
 *
 *   gst_rate is a PERCENT (5 | 12 | 18 …), per line. When it is present the
 *   server DERIVES cgst/sgst from this route's own accepted value and IGNORES
 *   whatever cgst/sgst the client sent (they are read only to log a divergence),
 *   exactly as /api/purchases and the PO-receive path already do. When it is
 *   absent the hand-typed cgst/sgst are stored as-is — the pre-existing manual
 *   path, unchanged.
 *
 *   cess_rate is ALSO a PERCENT, and it is GST COMPENSATION CESS — a SEPARATE
 *   levy (12% on aerated drinks, tobacco at the bar), never a third slice of the
 *   GST split and never the TGBCL `special_excise_cess`, which means state excise
 *   everywhere it is read and labelled. It is seeded from raw_materials.cess_percent
 *   the way gst_rate is seeded from tax_percent. TWO THINGS DIFFER FROM GST AND
 *   BOTH ARE DELIBERATE:
 *     • THE TAXABLE BASE IS DIFFERENT. GST is charged on the POST-DISCOUNT line
 *       value; cess is charged on the GROSS line value, BEFORE discount. The
 *       owner ruled it that way on 2026-08-07, so on 10 kg @ ₹100 with a ₹100
 *       discount: GST 18% on ₹900 = ₹162, CESS 12% on ₹1,000 = ₹120. The two
 *       bases are NOT a bug to be tidied into one.
 *     • THE RUPEES ARE ONLY EVER SERVER-DERIVED. Unlike cgst/sgst there is no
 *       legacy client posting a hand-typed figure, so a `compensation_cess` in
 *       the body is not read at all and cannot write money this line's goods
 *       value can't justify.
 *   Like the other recorded-only charges it never touches unit_price /
 *   total_price / the weighted average — it joins Total Inward on read.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The amendment stamps are ADMIN-ONLY on the wire.
 *
 * The owner's rule for the "edited" marker is that it is shown TO ADMIN — so it
 * is stripped here rather than merely hidden by the page, because a field the
 * browser receives is a field anyone with devtools can read. `voided_*` is NOT
 * stripped: a void is a fact about the document that every reader must see, and
 * the row is struck through for everybody.
 *
 * FAILS CLOSED. `isAdmin` is a plain `role === 'admin'` on a resolved session;
 * no session, an unresolvable role, or a thrown lookup all leave it false and
 * the stamps are removed. canAccessPage is NOT consulted — it fails open four
 * ways and is not a gate (see src/proxy.ts).
 */
const EDIT_STAMPS = ['edited_at', 'edited_by', 'edit_count'] as const;
function stripEditStamps<T extends Record<string, any>>(row: T, isAdmin: boolean): T {
  if (isAdmin || !row) return row;
  const out: any = { ...row };
  for (const k of EDIT_STAMPS) delete out[k];
  return out;
}

/** CSV cell escaping — BYTE-FOR-BYTE the `clean()` the /grn page uses for the
 *  bulk register download (src/app/grn/page.tsx), so a one-GRN file and a
 *  date-range file are the same document in every respect but their filter.
 *  Formula-injection guard, but only on genuinely non-numeric cells, so signed
 *  numbers (negative MRP round-off, back-correction qtys) stay summable in
 *  Excel instead of arriving as text. */
const csvCell = (v: any): string => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The Inward Register column order. THE SAME 26 HEADINGS, IN THE SAME ORDER,
 *  as the client-side bulk export at src/app/grn/page.tsx — keep the two in
 *  step: two "inward register" files that disagree about column order are worse
 *  than one. COMPENSATION CESS sits between SGST and SPECIAL EXCISE CESS (the
 *  order db.ts's Total Inward term list uses); the two cesses are DIFFERENT
 *  levies and must never be folded together. */
const REGISTER_HEADER = ['GRN No.', 'INVOICE ID', 'INWARD DATE', 'SUPPLIER NAME', 'CATEGORY NAME', 'ITEM NAME',
  'PO QTY', 'INWARD QTY', 'PURCHASE UNIT', 'RATE', 'SUBTOTAL', 'DISCOUNT', 'CGST', 'SGST',
  'COMPENSATION CESS', 'SPECIAL EXCISE CESS', 'TCS', 'DELIVERY CHARGES', 'MRP ROUND OFF', 'TOTAL INWARD AMOUNT',
  'ACCEPTED QTY', 'REJECTED QTY', 'REJECT REASON', 'STATUS', 'RECEIVED BY', 'INVOICE DATE'];

/** Same field order as REGISTER_HEADER, against a row of the register query. */
const registerRow = (r: any) => [
  r.grn_number, r.invoice_number, r.inward_date, r.supplier, r.category_name, r.item_name,
  r.po_qty, r.inward_qty, r.purchase_unit, r.rate, r.subtotal, r.discount, r.cgst, r.sgst,
  r.compensation_cess, r.special_excise_cess, r.tcs, r.delivery_charges, r.mrp_round_off, r.total_inward_amount,
  r.quantity_accepted, r.quantity_rejected, r.rejection_reason, r.status, r.received_by, r.invoice_date,
];

export async function GET(request: Request) {
  try {
    const db = getDb();
    // SELF-AUTHENTICATES. src/proxy.ts guards PAGES, not APIs — its only cover
    // for a GET is that a cookie exists, which is not a session and says nothing
    // about role. This read now needs a role (the amendment stamps below), so it
    // resolves one. Every caller of this route is a signed-in browser page
    // (/grn, /grn/print/[id]); there is no script or server-side caller, so
    // nothing that worked before stops working.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const isAdmin = me.role === 'admin';
    // Mirrors the bar PUT /api/grn/[id] actually enforces, so the page can hide
    // an Edit control the server would refuse. ADVISORY ONLY — the write
    // re-derives it from the session and fails closed.
    const canAmend = canProcessAsStore(me) || isManagement(me);
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) {
      const grn = db.prepare(`
        SELECT g.*, po.po_number AS po_number, po.status AS po_status
        FROM goods_receipt_notes g
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        WHERE g.id = ?
      `).get(id) as any;
      if (!grn) return Response.json({ error: 'Not found' }, { status: 404 });
      // SCOPED TO THE CALLER'S OUTLET, like the list and like the register
      // download. This branch feeds View (the row's detail panel), Print
      // (/grn/print/[id]) and the Edit form, and it returns the whole bill —
      // vendor, invoice number, every line, every charge. All three surfaces
      // are reached from the outlet-scoped list, so nothing legitimate changes;
      // what stops working is pasting a GRN id from another outlet.
      const detailOutletId = await getCurrentOutletId();
      if (detailOutletId && grn.outlet_id != null && String(grn.outlet_id) !== String(detailOutletId)) {
        return Response.json({
          error: 'This bill belongs to a different outlet than the one you are working in. Switch outlets to open it.',
        }, { status: 403 });
      }
      // compensation_cess is the EIGHTH charge and it is summed HERE, on read,
      // exactly like the other seven — a levy that was actually paid and is not
      // in the rate has to reach Total Inward, or the GRN totals to less than
      // the vendor was paid. gi.* already ships the raw column; this is the
      // computed total that every reader trusts.
      const items = db.prepare(`
        SELECT gi.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
               rm.pack_size, rm.purchase_unit, rm.category AS material_category,
               ROUND(gi.quantity_received * gi.unit_price, 2) AS subtotal,
               ROUND(gi.quantity_received * gi.unit_price
                     - gi.discount + gi.cgst + gi.sgst + gi.compensation_cess
                     + gi.special_excise_cess
                     + gi.tcs + gi.delivery_charges + gi.mrp_round_off, 2) AS total_inward_amount
        FROM goods_receipt_note_items gi
        JOIN raw_materials rm ON rm.id = gi.material_id
        WHERE gi.grn_id = ?
        ORDER BY rm.name
      `).all(id);
      // The amendment trail, ADMIN ONLY and read from the append-only
      // audit_events log — the authority on WHAT changed. The three stamps on
      // the header row only say that it changed, who and when; this is the
      // field-level diff behind the marker. `before_json`/`after_json` are
      // parsed here so the caller never has to double-decode, and a corrupt row
      // degrades to null rather than 500-ing the whole detail read.
      //
      // THE TIEBREAK IS `rowid`, NOT `id`. audit_events.created_at is
      // datetime('now') — ONE-SECOND resolution — and its id is a
      // crypto.randomUUID(), so `id DESC` sorted same-second events at random:
      // six amendments inside one second came back 5,1,3,4,6,2 while the row's
      // own "last amended by" said 6, so the panel and the marker contradicted
      // each other and the old → new chain read backwards. Two events in one
      // second is a double-click, a retry, or two people. audit_events has a
      // TEXT primary key and therefore an implicit monotonic rowid: it is the
      // insertion order, which is what "newest" means here.
      //
      // The cap is read one row DEEP so the panel can say it is capped rather
      // than quietly disagreeing with the row's edit_count.
      const HISTORY_LIMIT = 200;
      let editHistory: any[] = [];
      let historyTruncated = false;
      if (isAdmin) {
        const parse = (s: any) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
        const raw = db.prepare(`
          SELECT id, event_type, actor_email, before_json, after_json, note, created_at
          FROM audit_events
          WHERE entity_type = 'goods_receipt_note' AND entity_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `).all(id, HISTORY_LIMIT + 1) as any[];
        historyTruncated = raw.length > HISTORY_LIMIT;
        editHistory = raw.slice(0, HISTORY_LIMIT).map(r => ({
          id: r.id, event_type: r.event_type, actor_email: r.actor_email,
          note: r.note, created_at: r.created_at,
          before: parse(r.before_json), after: parse(r.after_json),
        }));
      }
      return Response.json({
        grn: { ...stripEditStamps(grn, isAdmin), items },
        is_admin: isAdmin,
        can_amend: canAmend,
        edit_history: editHistory,
        edit_history_truncated: historyTruncated,
      });
    }
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    const vendorId = url.searchParams.get('vendor_id');
    const status   = url.searchParams.get('status');
    const register = url.searchParams.get('register');   // flat line-level inward register (export)
    const where: string[] = ['1=1']; const params: any[] = [];
    const outletId = await getCurrentOutletId();

    // Flat inward register — one row PER LINE, header fields repeated, in the
    // sheet's column order + our extras. Used by the "Download Inward Register"
    // export. Same filters as the list.
    // compensation_cess ships as its own column beside the other charges and is
    // inside total_inward_amount: it is GST compensation cess, NOT the TGBCL
    // special excise cess sitting next to it, and a register that folded the two
    // together would report an excise figure the state never levied.
    if (register) {
      const rw: string[] = ['1=1']; const rp: any[] = [];
      // ── PER-ENTRY DOWNLOAD ────────────────────────────────────────────────
      // `grn_id` narrows the register to ONE inward entry, and when it is given
      // the DATE RANGE, VENDOR and STATUS pickers are dropped: they belong to
      // the list the user is browsing, and a "Download" on a row must not return
      // an empty file because the row happens to sit at the edge of the range or
      // because a status filter is on. The register SQL, its column list and its
      // ORDER BY are untouched, so a one-row file is a slice of the same
      // document, never a second format that can drift from it.
      //
      // THE OUTLET CLAUSE IS NOT ONE OF THE PICKERS AND STAYS ON. This branch is
      // reached by a plain <a href> carrying a GRN id, and this file is a full
      // money breakdown per line (rate, discount, both cesses, TCS, total inward)
      // — the sort of figure /reports/purchases 403s a non-manager for. Dropping
      // the outlet clause here would have made any id downloadable from any
      // outlet's session. Every row the list can show still passes it, so no
      // legitimate Download changes.
      const grnId = String(url.searchParams.get('grn_id') || '').trim();
      if (grnId) {
        rw.push('g.id = ?'); rp.push(grnId);
        if (outletId) { rw.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); rp.push(outletId); }
      } else {
      if (outletId) { rw.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); rp.push(outletId); }
      if (from)     { rw.push('g.date >= ?'); rp.push(from); }
      if (to)       { rw.push('g.date <= ?'); rp.push(to); }
      if (vendorId) { rw.push('g.vendor_id = ?'); rp.push(vendorId); }
      if (status)   { rw.push('g.status = ?'); rp.push(status); }
      // ── VOIDED BILLS ARE OUT OF THE RANGE REGISTER ────────────────────────
      // This file is what gets reconciled against vendor paperwork and summed
      // in Excel; a voided bill's stock and cost rows have been reversed, so
      // including it at full value restates the period's inward total upwards
      // for ever. The only signal it carried was the word "void" 24 columns in,
      // which no SUM() reads — and the /grn header Σ already excludes it, so
      // the screen and its own export disagreed.
      // Excluded only when the user has NOT asked for them: `?status=void` is
      // the auditor's "list the cancelled bills" view and must still work, and
      // a per-entry Download (the grn_id branch above) always returns its row,
      // because a voided bill is still a document you may print a copy of.
      if (status !== 'void') rw.push(`g.status <> 'void'`);
      }
      const rows = db.prepare(`
        SELECT g.grn_number, g.invoice_number, g.date AS inward_date, g.vendor AS supplier,
               rm.category AS category_name, rm.name AS item_name,
               gi.quantity_ordered AS po_qty, gi.quantity_received AS inward_qty,
               COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
               gi.unit_price AS rate,
               ROUND(gi.quantity_received * gi.unit_price, 2) AS subtotal,
               gi.discount, gi.cgst, gi.sgst, gi.compensation_cess,
               gi.special_excise_cess, gi.tcs,
               gi.delivery_charges, gi.mrp_round_off,
               ROUND(gi.quantity_received * gi.unit_price - gi.discount + gi.cgst + gi.sgst
                     + gi.compensation_cess
                     + gi.special_excise_cess + gi.tcs + gi.delivery_charges + gi.mrp_round_off, 2) AS total_inward_amount,
               gi.quantity_accepted, gi.quantity_rejected, gi.rejection_reason,
               g.status, g.received_by, g.invoice_date
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g  ON g.id  = gi.grn_id
        JOIN raw_materials       rm ON rm.id = gi.material_id
        WHERE ${rw.join(' AND ')}
        ORDER BY g.date DESC, g.grn_number, rm.name
      `).all(...rp) as any[];
      // ?format=csv → the finished file, rendered here rather than assembled in
      // the browser, so a per-entry "Download Bill" is a plain <a href> with no
      // JS, no Blob and no second copy of the column order to keep in step.
      // The JSON shape is unchanged for every caller that does not ask for csv.
      if (String(url.searchParams.get('format') || '').toLowerCase() === 'csv') {
        const lines = [REGISTER_HEADER.join(',')];
        for (const r of rows) lines.push(registerRow(r).map(csvCell).join(','));
        // Named off the GRN when it is one entry (that is the document's own
        // identity, and the number is what an auditor searches for), off the
        // date range otherwise — matching the bulk export's filename exactly.
        const one = grnId ? String(rows[0]?.grn_number || grnId) : '';
        const filename = one
          ? `GRN-inward-${one}.csv`
          : `GRN-inward-register-${from || 'all'}_to_${to || 'all'}.csv`;
        return new Response(lines.join('\n'), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv;charset=utf-8;',
            // The filename can carry a comma or a quote via grn_number, so it is
            // sanitised rather than interpolated raw into the header.
            'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
            'Cache-Control': 'no-store',
          },
        });
      }
      return Response.json({ rows });
    }
    if (outletId)  { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(outletId); }
    if (from)      { where.push('g.date >= ?'); params.push(from); }
    if (to)        { where.push('g.date <= ?'); params.push(to); }
    if (vendorId)  { where.push('g.vendor_id = ?'); params.push(vendorId); }
    if (status)    { where.push('g.status = ?'); params.push(status); }
    const rows = db.prepare(`
      SELECT g.*,
             po.po_number AS po_number,
             (SELECT COUNT(*)        FROM goods_receipt_note_items WHERE grn_id = g.id)                    AS line_count,
             (SELECT SUM(quantity_rejected) FROM goods_receipt_note_items WHERE grn_id = g.id)             AS total_rejected,
             -- total_rejected sums the rejected qty of EVERY line, and GRN qtys are
             -- PURCHASE units — so a mixed GRN adds 2 kg to 3 BTL and the number is
             -- meaningless. These two say whether it can honestly be labelled: one
             -- distinct purchase unit across the rejected lines → print "N <unit>";
             -- more than one → the list prints the rejected LINE COUNT instead.
             (SELECT COUNT(DISTINCT LOWER(TRIM(COALESCE(NULLIF(TRIM(rm2.purchase_unit), ''), rm2.unit))))
                FROM goods_receipt_note_items gi2
                JOIN raw_materials rm2 ON rm2.id = gi2.material_id
               WHERE gi2.grn_id = g.id AND gi2.quantity_rejected > 0)                                     AS rejected_unit_count,
             (SELECT MIN(COALESCE(NULLIF(TRIM(rm2.purchase_unit), ''), rm2.unit))
                FROM goods_receipt_note_items gi2
                JOIN raw_materials rm2 ON rm2.id = gi2.material_id
               WHERE gi2.grn_id = g.id AND gi2.quantity_rejected > 0)                                     AS rejected_unit,
             (SELECT COUNT(*) FROM goods_receipt_note_items WHERE grn_id = g.id AND quantity_rejected > 0) AS rejected_lines,
             (SELECT SUM(quantity_accepted * unit_price) FROM goods_receipt_note_items WHERE grn_id = g.id) AS accepted_value,
             (SELECT SUM(quantity_received * unit_price
                         - discount + cgst + sgst + compensation_cess
                         + special_excise_cess + tcs + delivery_charges + mrp_round_off)
                FROM goods_receipt_note_items WHERE grn_id = g.id) AS inward_value
      FROM goods_receipt_notes g
      LEFT JOIN purchase_orders po ON po.id = g.po_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.date DESC, g.created_at DESC
    `).all(...params) as any[];
    // g.* already carries edited_*/voided_* — no query edit was needed for the
    // row markers. `is_admin` rides along so the page can render the admin-only
    // Delete control and the "edited" hint without a second /api/auth/me round
    // trip; it is advisory for the UI only — every write re-checks the role
    // server-side and fails closed.
    return Response.json({ grns: rows.map(r => stripEditStamps(r, isAdmin)), is_admin: isAdmin, can_amend: canAmend });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { date, vendor_id, vendor, invoice_number, invoice_date, qc_by, notes, items,
            qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match } = b;
    if (!date)  return Response.json({ error: 'date required' }, { status: 400 });
    // MANDATORY, ENFORCED HERE TOO. The form marks it required, but a `required`
    // attribute is a courtesy to the person typing, not a rule — anything posting
    // straight at this route bypasses it. POST /api/grn has exactly ONE caller (the
    // ad-hoc form at grn/page.tsx:818); PO receipts go through
    // /api/purchase-orders/[id]/receive, so no other flow can be broken by this.
    //
    // It matters because this number is the only way back to the paper: months on,
    // the stock line survives and the bill does not. It is also what the
    // duplicate-bill guard keys on, and that guard skips a blank bill_no entirely.
    if (!String(invoice_number || '').trim()) {
      return Response.json(
        { error: 'Vendor invoice / bill number is required on an ad-hoc GRN — it is the only link back to the vendor\'s paperwork.' },
        { status: 400 },
      );
    }
    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }
    // ONE MATERIAL = ONE LINE (owner rule) — the same helper the PO routes and
    // POST/PUT /api/requisitions call, imported from @/lib/po-helpers rather
    // than restated (see the header of @/lib/line-dedupe). This is the ad-hoc,
    // human-composed GRN: /grn already blocks a repeat client-side through
    // MaterialTypeahead's excludeIds, but a direct POST could book one delivery
    // twice — two goods_receipt_note_items rows, two `purchases` rows, two stock
    // bumps and two passes through updateMaterialPrice's weighted average for a
    // single delivered item.
    // PLACED HERE, on the raw payload, with the other shape checks and BEFORE
    // the store-mapped split below, for two reasons. The "Line N" in the message
    // then names the caller's own row — checking the filtered `receivable` list
    // instead would silently renumber it past any store-blocked line and send a
    // storekeeper to the wrong row. And a repeated material is a defect in the
    // payload the caller authored, true independently of which lines turn out to
    // be store-mapped. The two can never disagree about WHAT a duplicate is:
    // centralFlowBlock keys on the material, so two lines for one material are
    // always both blocked or both receivable.
    const dupLine = duplicateLineError(items);
    if (dupLine) return Response.json({ error: dupLine }, { status: 400 });

    // Configurable backdate window: non-admins can't set a GRN receipt date older
    // than N days or in the future; admins are exempt.
    const dateCheck = checkPurchaseDate(db, date, me.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });
    const outletId = await getCurrentOutletId();

    // Phase B store guard (batch endpoint → skip + report per line, never fail
    // the whole GRN): store-mapped materials (liquor) can't be received into
    // Central stock — they're procured on the store ledger instead.
    const storeBlocked: { material_id: string; error: string }[] = [];
    const receivable = items.filter((it: any) => {
      const msg = centralFlowBlock(db, String(it.material_id || ''));
      if (msg) { storeBlocked.push({ material_id: it.material_id, error: msg }); return false; }
      return true;
    });
    if (receivable.length === 0) {
      return Response.json({
        error: `No receivable lines — ${storeBlocked.length} store-mapped line(s) blocked. ${storeBlocked[0]?.error || ''}`,
        store_blocked: storeBlocked,
      }, { status: 400 });
    }

    // Per-line GST, as a PERCENT (5 | 12 | 18 …). Validated HERE, before the
    // transaction opens, because a Response cannot be returned from inside
    // db.transaction() — a bad rate has to be a clean 400 with no GRN number
    // burned and no row written. ABSENT means exactly what it meant before this
    // field existed: the clerk's hand-typed cgst/sgst are stored as-is, so every
    // older client (and the manual half of the /grn modal) keeps working. A
    // PRESENT but unusable value is REJECTED rather than quietly zeroed —
    // silently dropping the tax on a bill forfeits the input credit, and nothing
    // in the stored row would ever show that it went missing. Wording is
    // /api/purchases' wording verbatim; two purchase surfaces answering the same
    // mistake differently is how a clerk learns to distrust the message.
    const gstProvided = (it: any) =>
      it?.gst_rate !== undefined && it?.gst_rate !== null && String(it.gst_rate).trim() !== '';
    // GST COMPENSATION CESS, also a per-line PERCENT, seeded from the material
    // master's cess_percent the way gst_rate is seeded from tax_percent. Same
    // absent/present contract, same pre-transaction validation, and rejected
    // rather than quietly zeroed for the same reason: a cess silently dropped is
    // real money the venue paid and can no longer show it paid. NOT a slice of
    // the GST split and NOT special_excise_cess — see the header doc.
    const cessProvided = (it: any) =>
      it?.cess_rate !== undefined && it?.cess_rate !== null && String(it.cess_rate).trim() !== '';
    for (const it of receivable) {
      if (!gstProvided(it)) continue;
      const n = Number(it.gst_rate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return Response.json({
          error: 'gst_rate must be a percentage between 0 and 100 (0 = exempt) — send no gst_rate at all to record a line with no tax',
        }, { status: 400 });
      }
    }
    for (const it of receivable) {
      if (!cessProvided(it)) continue;
      const n = Number(it.cess_rate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return Response.json({
          error: 'cess_rate must be a percentage between 0 and 100 (0 = none) — send no cess_rate at all to record a line with no compensation cess',
        }, { status: 400 });
      }
    }

    // ── KITCHEN QC GATE ───────────────────────────────────────────────────
    // Does anything on this delivery need a quality check before it becomes
    // ours? The decision lives in ONE helper both receiving routes call
    // (src/lib/grn-qc.ts) — 20 of the 29 live GRNs come through the PO route,
    // so a gate wired only here would leave the main road open, and a gate
    // written twice would drift.
    //
    // ── WHICH LINES THE GATE IS ALLOWED TO SEE — PER LINE, NEVER PER BILL ────
    // Two lines are excluded, and BOTH exclusions used to be wrong here:
    //
    //  1. A BACK-CORRECTION IS NEVER GATED. Negative lines REDUCE stock to undo
    //     an earlier over-booking; holding a reduction for a quality check is
    //     meaningless and would leave the overstatement on the book for as long
    //     as the queue takes. This route is the only one that can produce them.
    //     THIS USED TO BE A WHOLE-PAYLOAD FLAG (`hasNegativeLine`) handed to
    //     resolveQcRequirement, which returned "no check at all" for EVERY line
    //     on the bill. One −1 kg sugar correction alongside 40 kg of asparagus
    //     and 25 kg of raw meat inwarded the lot instantly, with no hold, no
    //     bell and no queue row — two clicks from the UI, and precisely the
    //     failure this feature exists to stop. The exemption is now per LINE:
    //     the negative line is dropped, everything else is still weighed.
    //  2. A LINE THAT WILL NOT BE INSERTED CANNOT BE CHECKED. The insert loop
    //     below skips `received === 0 && accepted === 0`. Letting such a line
    //     arm the gate produced a GRN held with ZERO line rows, which could then
    //     be neither signed nor overridden ("has no line items to sign off") and
    //     sat in the queue, the bell and the escalation sweep for ever.
    const gateable = receivable.filter((it: any) => {
      const rec = Number(it.quantity_received) || 0;
      const acc = it.quantity_accepted != null ? Number(it.quantity_accepted) : rec;
      if (rec < 0 || acc < 0) return false;        // back-correction — exempt
      if (rec === 0 && acc === 0) return false;    // skipped by the insert loop below
      return true;
    });
    const qc = resolveQcRequirement(db, gateable.map((it: any) => String(it.material_id || '')));
    // On a HELD delivery the store records what ARRIVED and the checking
    // department records what is ACCEPTED. A receiver pre-rejecting part of a
    // gated line is refused with the honest remedy — short-receive it — because
    // that separation is the whole of the owner's decision 4 and it is also what
    // makes `quantity_accepted = 0 while waiting` mean one unambiguous thing.
    // ── A BACK-CORRECTION MAY NOT RIDE ON A HELD BILL ───────────────────────
    // The exemption above says a negative line is never gated. Under "THE GRN IS
    // THE UNIT" that promise cannot be kept on a mixed bill: the correction line
    // is still INSERTED on a held receipt, so its stock reduction is deferred
    // behind a kitchen check exactly like everything else — which is precisely
    // what the exemption exists to prevent, since holding a reduction leaves the
    // overstatement on the book for as long as the queue takes.
    //
    // WORSE, IT STRANDED THE WHOLE RECEIPT. Measured: 40 kg asparagus + a −1 kg
    // sugar correction saved as one held GRN, and decideGrnQc then refused BOTH
    // sign and override with "Accepted quantity on Sugar must be zero or more"
    // — a receipt in the queue, in the bell and in the escalation sweep that no
    // authority in the building could clear.
    //
    // Refused HERE, before anything is written, with the lever the doctrine
    // already names: two documents. The correction saves on its own and applies
    // instantly (it is never gated when it is alone), and the delivery waits.
    // decideGrnQc also learned to pass a negative line through unjudged, so a
    // row born before this guard — or by any other route — is still clearable;
    // this is the guard, that is the safety net.
    if (qc.required) {
      const negatives = receivable.filter((it: any) =>
        (Number(it.quantity_received) || 0) < 0
        || (it.quantity_accepted != null && Number(it.quantity_accepted) < 0));
      if (negatives.length > 0) {
        const names = negatives.slice(0, 3).map((it: any) =>
          (db.prepare('SELECT name FROM raw_materials WHERE id = ?').get(String(it.material_id || '')) as any)?.name || 'a line');
        return Response.json({
          error:
            `This bill mixes a back-correction with goods that need a quality check, and the two cannot share one receipt. `
            + `${negatives.length} correction line(s): ${names.join(', ')}${negatives.length > 3 ? '…' : ''}. `
            + `The delivery has to WAIT for the kitchen; the correction has to apply NOW, or the over-booking it is undoing stays on the book until the queue clears. `
            + `Save them as two receipts: the correction on its own (it is never held), then this delivery.`,
          qc_required: true,
          back_correction_conflict: true,
        }, { status: 400 });
      }
      const block = storePreRejectBlock(gateable.map((it: any) => ({
        material_name: (db.prepare('SELECT name FROM raw_materials WHERE id = ?')
          .get(String(it.material_id || '')) as any)?.name,
        received: Number(it.quantity_received) || 0,
        declaredAccepted: it.quantity_accepted != null ? Number(it.quantity_accepted) : (Number(it.quantity_received) || 0),
      })));
      if (block) return Response.json({ error: block, qc_required: true }, { status: 400 });
    }

    // THE STORE HALF OF DECISION 4, and whether it was actually answered.
    // Expiry / use-by, weight-and-count vs invoice, invoice matches PO — the
    // three checks the receiving desk owns. All three, or it is not a signature;
    // see the qc_store_by binding in the header INSERT below for why a partial
    // or empty checklist must not be stamped with a name.
    const storeSigned = !!(qc_expiry && qc_weight && qc_invoice_match);

    // Generate GRN number
    const yr = String(date).slice(0, 4);
    const lastGrn = db.prepare(`SELECT grn_number FROM goods_receipt_notes WHERE grn_number LIKE 'GRN-' || ? || '-%' ORDER BY grn_number DESC LIMIT 1`).get(yr) as any;
    const nextNum = lastGrn?.grn_number ? parseInt(lastGrn.grn_number.split('-').pop() || '0', 10) + 1 : 1;
    const grnNumber = `GRN-${yr}-${String(nextNum).padStart(4, '0')}`;
    const grnId = generateId();
    const touched = new Set<string>();

    const txn = db.transaction(() => {
      // ── THE HELD HEADER ────────────────────────────────────────────────
      // 'awaiting_qc' instead of 'received' is the WHOLE gate: it is what the
      // sign-off's conditional claim matches on, what the queue lists, and what
      // every downstream reader must learn about the way it learned 'void'.
      // qc_required / qc_checker record that this receipt WAS gated and by whom,
      // so the fact survives the status returning to received/partial later.
      // ── THE KITCHEN'S THREE TICKS ARE DROPPED ON A HELD RECEIPT ─────────
      // The STORE's three (expiry / weight / invoice match) are stored exactly
      // as sent — they are this desk's half of the owner's decision-4 split.
      // The KITCHEN's three (quality / temperature / damage) are FORCED TO 0
      // whenever the gate holds the delivery, whatever the payload said.
      // "The sign-off rewrites them" was the old justification and it is not
      // true on the OVERRIDE path, where they are deliberately left unticked:
      // a receiver who ticked all three at the bay produced a permanently
      // released bill whose printed sheet certified a quality check that
      // qc_outcome = 'override' says nobody made. It is also not true in the
      // window BEFORE sign-off, where the row would claim a check that had not
      // happened. Enforced HERE rather than only in the browser, because the
      // client can only strip what it knows is gated and the category map is
      // admin-readable — a store manager's form cannot see it.
      const kitchenTick = (v: any) => (qc.required ? 0 : (v ? 1 : 0));
      db.prepare(`
        INSERT INTO goods_receipt_notes
          (id, grn_number, date, po_id, vendor_id, vendor, invoice_number, invoice_date,
           received_by, qc_by, status, notes, outlet_id,
           qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match,
           qc_required, qc_checker, qc_outcome, qc_store_by, qc_store_at,
           created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                -- ── THE STORE'S SIGNATURE, AND ONLY WHEN THERE IS ONE ─────────
                -- qc_store_by / qc_store_at are the STORE half of the owner's
                -- decision-4 split: expiry / use-by checked, weight / count
                -- verified vs invoice, invoice matches PO. They are stamped ONLY
                -- when the receiver actually confirmed ALL THREE — the same bar
                -- the kitchen's own three ticks meet before decideGrnQc will let
                -- it sign. All six qc_* booleans are optional on this form (all
                -- blank is a valid save, and across 29 live GRNs SUM(qc_quality)
                -- is 0), so stamping a name unconditionally would put a
                -- signature on a checklist nobody filled in — which is precisely
                -- the "receiver self-certifying their own receipt" this whole
                -- feature exists to end, reintroduced on the other half of the
                -- split. Unsigned is left as '' / NULL, which reads as what it
                -- is: the store did not answer. received_by already records who
                -- typed the receipt, so nothing is lost by refusing to conflate
                -- the two.
                -- CASE, not a JS ternary, so the stamp and the name can never
                -- disagree, and datetime('now') rather than a JS clock so every
                -- stamp in this table is on one clock.
                ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, datetime('now'))
      `).run(grnId, grnNumber, date, vendor_id || null, vendor || '', invoice_number || '', invoice_date || '',
              me.email,
              // qc_by is the LEGACY single QC signature the print sheet renders
              // under "QC verified by". On a held receipt it is not the store's
              // to pre-fill: decideGrnQc writes the real signer's email into it
              // at sign-off, and an override leaves it blank on purpose.
              qc.required ? '' : (qc_by || ''),
              qc.required ? QC_AWAITING : 'received', notes || '', outletId,
              kitchenTick(qc_quality), kitchenTick(qc_temperature), qc_expiry ? 1 : 0,
              kitchenTick(qc_damage), qc_weight ? 1 : 0, qc_invoice_match ? 1 : 0,
              qc.required ? 1 : 0, qc.required ? qc.checker : '',
              qc.required ? 'pending' : '',
              storeSigned ? me.email : '', storeSigned ? 1 : 0);

      const insGrnItem = db.prepare(`
        INSERT INTO goods_receipt_note_items
          (id, grn_id, po_item_id, material_id, quantity_ordered, quantity_received,
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes,
           discount, cgst, sgst, compensation_cess, special_excise_cess, tcs,
           delivery_charges, mrp_round_off, gst_rate, cess_rate, cost_vendor, cost_note)
        VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Per-line inward charges (₹). mrp_round_off is signed; the rest ≥ 0.
      const chg = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; };
      const chgSigned = (v: any) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
      // grn_id is the HARD link from the cost row back to the delivery that
      // created it. Before it existed the only tie was the sentence in
      // `notes` below, which purchase-log.ts has to regex back out — a link
      // that breaks the moment anyone rewords a note. The column is additive
      // and soft (no FK: SQLite cannot ADD one, and rebuilding `purchases` on
      // a live system is not a trade worth making), so the two writers that
      // genuinely hold a GRN in scope — this route and PO-receive — bind it,
      // and the five that do not (direct purchase, opening stock, bulk,
      // inward-import, seed) correctly leave it NULL. Old rows stay NULL: no
      // backfill, and the note text below is unchanged so the regex path
      // keeps reading history exactly as it did.
      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, bill_no,
                               is_emergency, payment_mode, emergency_reason, outlet_id, grn_id, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, datetime('now'))
      `);
      const bumpStock = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?, last_purchase_price = ?, last_purchase_date = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const insTx = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at, outlet_id)
        VALUES (?, ?, 'purchase', ?, ?, ?, datetime('now'), ?)
      `);
      const getPackInfo = db.prepare(`SELECT pack_size, unit, purchase_unit FROM raw_materials WHERE id = ?`);

      let hasReject = false;
      for (const it of receivable) {
        const received = Number(it.quantity_received) || 0;
        const accepted = it.quantity_accepted != null ? Number(it.quantity_accepted) : received;
        // Rejected qty only makes sense in the positive-receipt case
        // (received some, didn't accept some). For back-corrections we skip
        // the "rejected" math entirely — both numbers move in lockstep.
        const isNegative = received < 0 || accepted < 0;
        const rejected = isNegative ? 0 : Math.max(0, received - accepted);
        const reason   = String(it.rejection_reason || '').trim();
        const price    = Number(it.unit_price) || 0;
        // Skip ONLY truly empty lines. Allow negatives so back-corrections
        // actually save (this was silently dropping every adjustment).
        if (received === 0 && accepted === 0) continue;
        if (rejected > 0) hasReject = true;

        // ── PER-LINE GST — DERIVED HERE, server-side, from this route's own figures ──
        // This row is the input-credit record. The figure on it must follow from
        // the goods value on the SAME row, or a miscalculating modal — or a
        // replayed/hand-edited payload — writes a tax the row cannot justify to
        // an auditor. So when a rate is sent, the client's cgst/sgst are read
        // ONLY to log a divergence, never obeyed. Same contract as
        // /api/purchases and PO-receive; this was the one manual purchase
        // surface still trusting the browser's arithmetic.
        //
        // THE BASE IS THE ACCEPTED GROSS, NOT THE RECEIVED GROSS, and that is
        // deliberate: receive/route.ts taxes `effAcc` too, so the inward
        // register — which mixes rows from BOTH GRN sources — stays homogeneous.
        // A rejected quantity was never accepted, so no credit is claimable on
        // it. A back-correction (negative) floors to 0 here, which is what the
        // chg() below would have stored for it anyway — screen and row agree.
        //
        // ARITHMETIC IS api/purchases/route.ts:363-367 BYTE-FOR-BYTE. `taxable`
        // is already 2-dp rupees, so taxable × rate IS the tax in whole paise
        // (the ÷100 for percent and the ×100 for paise cancel). Halving in
        // integer paise is what keeps cgst + sgst re-adding to the tax EXACTLY —
        // the house invariant every reader re-adds; halving in floats drifts a
        // paisa. A third rounding convention across the purchase paths is how a
        // GST return stops reconciling.
        const hasGst = gstProvided(it);
        // LIQUOR IS ZERO-RATED — its duty rides on the TGBCL bill (excise / cess
        // / TCS), never on GST, so a credit here would be claimed twice.
        // centralFlowBlock already dropped these lines from `receivable`, so in
        // practice this never fires; it is the second lock, mirroring
        // receive/route.ts. If that guard is ever relaxed per-category, a client
        // sending 18% still must not write a credit the TGBCL charges carry.
        const gstRate = (!hasGst || isStoreMappedMaterial(db, String(it.material_id || '')))
          ? 0 : Number(it.gst_rate);
        // rate-basis: purchase — `accepted` is purchase units (quantity_accepted,
        // by canon) and `price` is ₹/purchase-unit, the same pairing the
        // `purchases` mirror and updateMaterialPrice below already assume.
        const grossTax  = Math.round((accepted > 0 ? accepted : 0) * price * 100) / 100;
        const taxable   = Math.round((grossTax - chg(it.discount)) * 100) / 100;
        const taxPaise  = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
        const sgstPaise = Math.floor(taxPaise / 2);
        const cgstPaise = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract

        // ── COMPENSATION CESS — SAME LINE, DIFFERENT TAXABLE BASE ──────────────
        // READ THIS BEFORE "SIMPLIFYING" THE TWO INTO ONE. The bases genuinely
        // differ and the difference is the owner's ruling of 2026-08-07:
        //     GST  → `taxable`  = gross MINUS the discount (POST-discount)
        //     CESS → `grossTax` = the gross line value, BEFORE any discount
        // On his worked example — 10 kg @ ₹100 = ₹1,000, discount ₹100 —
        // GST 18% on ₹900 = ₹162 and CESS 12% on ₹1,000 = ₹120. Collapsing cess
        // onto `taxable` would quietly under-declare the cess on every
        // discounted line, and collapsing GST onto `grossTax` would over-claim
        // the input credit. They are two levies with two bases, not one with a
        // typo. The identical pair sits in receive/route.ts for PO receipts, so
        // the inward register stays homogeneous across both GRN sources.
        //
        // Everything else is GST's contract verbatim: ACCEPTED (not received)
        // and floored at 0, so a fully-rejected line and a back-correction both
        // carry ₹0 cess exactly as they carry ₹0 GST; whole-paise, since
        // `grossTax` is already 2-dp rupees so grossTax × rate IS paise (the
        // ÷100 for percent and the ×100 for paise cancel).
        //
        // NEVER HALVED, and never folded into cgst/sgst: the house invariant
        // tax_value = cgst + sgst is a statement about GST alone, and adding a
        // separate levy into it would misstate the GST on a return.
        //
        // Zero-rated on store-mapped (TGBCL liquor) lines for a REASON SHARPER
        // than GST's: that bill already carries its own special excise cess, so
        // a master cess% seeded onto a liquor line would charge the venue the
        // cess twice — once as excise on the store ledger and once again here.
        const hasCess = cessProvided(it);
        const cessRate = (!hasCess || isStoreMappedMaterial(db, String(it.material_id || '')))
          ? 0 : Number(it.cess_rate);
        // rate-basis: purchase — `grossTax` is the purchase-basis line value
        // computed above; `cessRate` is a PERCENT, not a ₹/unit rate.
        const cessPaise = cessRate > 0 ? Math.max(0, Math.round(grossTax * cessRate)) : 0;
        // Compared in INTEGER paise with a 1-paisa allowance: a client doing
        // round2(taxable × rate ÷ 100) legitimately lands a paisa off on
        // half-paisa amounts, and that is agreement, not drift. Anything wider
        // is a real UI divergence and must stay visible rather than be silently
        // corrected on every bill for months.
        if (hasGst && (it.cgst !== undefined || it.sgst !== undefined)) {
          const sentTax = (Number(it.cgst) || 0) + (Number(it.sgst) || 0);
          if (Math.abs(Math.round(sentTax * 100) - taxPaise) > 1) {
            console.warn(
              `[grn POST] client tax ₹${sentTax.toFixed(2)} ≠ server-derived ₹${(taxPaise / 100).toFixed(2)} ` +
              `(${grnNumber}, material ${it.material_id}, taxable ₹${taxable.toFixed(2)} @ ${gstRate}%) — stored the derived figure`
            );
          }
        }

        // THE COST ROW'S OWN WORDING, MINTED HERE EVEN WHEN NOTHING IS BOOKED.
        // On a held GRN the `purchases` row is written hours later by the
        // sign-off, from a different route, and src/lib/purchase-log.ts parses
        // this exact sentence with an anchored regex — so the finished string is
        // stored on the line rather than re-composed later from prose. Same
        // reason cost_vendor is stored: re-deriving either at sign-off is
        // parsing prose to write prose, which is the failure grn_id was added to
        // end. On an UNHELD GRN it is the identical string the insert below
        // already used, so nothing about that path changes.
        const noteTag = accepted < 0
          ? `BACK-CORRECTION GRN ${grnNumber}${invoice_number ? ' · invoice ' + invoice_number : ''}`
          : `Ad-hoc GRN ${grnNumber}${invoice_number ? ' · invoice ' + invoice_number : ''}`;

        // ── WHAT quantity_accepted MEANS ON A HELD LINE: 0, AND NOT "REJECTED" ──
        // The store records what ARRIVED; the checking department records what is
        // ACCEPTED, later. Writing `received` here provisionally would make every
        // downstream reader value goods nobody has accepted — two of them
        // dangerously: src/lib/returns.ts offers a line for VENDOR RETURN on
        // quantity_accepted > 0 (and settling it debits stock that was never
        // credited), and src/lib/purchase-log.ts would book the value with no
        // purchases mirror and report it as billed-but-never-booked. Both close
        // on their own at 0, with no edit to either file.
        // ZERO ACCEPTED IS THE ABSENCE OF A DECISION, and status='awaiting_qc' is
        // what says so — read one without the other and you will misreport the
        // delivery. storePreRejectBlock() above has already refused any payload
        // that tried to declare a smaller accepted on a gated line, so nothing
        // the receiver typed is being silently discarded here.
        const heldQty = qc.required;
        insGrnItem.run(generateId(), grnId, it.material_id, received,
                       heldQty ? 0 : accepted, heldQty ? 0 : rejected, heldQty ? '' : reason, price,
                       it.notes || (!heldQty && rejected > 0 ? `Rejected ${rejected} (${reason || 'no reason given'})` : ''),
                       chg(it.discount),
                       hasGst ? cgstPaise / 100 : chg(it.cgst),
                       hasGst ? sgstPaise / 100 : chg(it.sgst),
                       // No chg(it.compensation_cess) fallback, deliberately: cgst/sgst
                       // keep one because a hand-typed ₹ predates the rate field on this
                       // modal, but cess has never had a hand-typed box on any surface —
                       // so the body's figure is never read and can't write money this
                       // line's goods value can't justify. Absent rate ⇒ a stored 0.
                       cessPaise / 100,
                       chg(it.special_excise_cess),
                       chg(it.tcs), chg(it.delivery_charges), chgSigned(it.mrp_round_off),
                       // The PERCENTS behind the ₹ above. Stored so a QC rejection can
                       // re-derive the tax on the smaller accepted quantity with the SAME
                       // arithmetic instead of reverse-engineering a rate out of rupees.
                       // 0 when the client sent none — which writes ₹0 either way.
                       hasGst ? gstRate : 0, hasCess ? cessRate : 0,
                       vendor || '', noteTag);

        // Mirror into purchases + inventory_transactions for ANY non-zero
        // accepted qty (including negatives, which represent reversal of a
        // prior over-booking). updateMaterialPrice handles the weighted-avg
        // recomputation correctly on either sign.
        //
        // ── AND NOT AT ALL WHEN THE DELIVERY IS HELD ─────────────────────────
        // These three writes ARE "the goods are ours". Deferring them to the
        // sign-off (src/lib/grn-qc.ts decideGrnQc, which replays exactly this
        // shape from the stored row) is the entire feature. The GRN header and
        // its line rows are NOT deferred: the document is the record that the
        // truck arrived, and it is what the kitchen signs against.
        if (!qc.required && accepted !== 0) {
          const purchaseId = generateId();
          const lineTotal = Math.round(accepted * price * 100) / 100;
          // grnId is minted above and inserted in THIS same transaction, so the
          // link is never dangling — the GRN header row and its cost rows commit
          // or roll back together. A BACK-CORRECTION (negative accepted) is bound
          // to its own GRN too, deliberately: the reversal is a delivery event in
          // its own right and the log must show it against the GRN that recorded
          // it, not silently under the original receipt.
            // THE VENDOR'S BILL NUMBER IS NOW STORED, NOT JUST NARRATED. It used to
            // survive only inside noteTag — "Ad-hoc GRN GRN-2026-0002 · invoice R71-T3"
            // — so months later the stock line was still there and the bill it came
            // from was findable only by reading prose. It could not be filtered, matched
            // against a vendor statement, or seen in the Bill No column; and the
            // duplicate-bill guard SKIPS any row whose bill_no is blank, so every ad-hoc
            // receipt was invisible to it. PO-receive has always written bill_no — this
            // makes the two receiving routes agree.
            //
            // noteTag itself is deliberately UNCHANGED: the PO No column and the po_id
            // backfill both read history through that exact sentence.
          insPurchase.run(purchaseId, it.material_id, vendor || '', accepted, price, lineTotal, date,
                          noteTag, String(invoice_number || '').trim(), outletId, grnId);
          // ── Unit-basis boundary (CORE CONVENTION) ──────────────────────
          // GRN lines are entered in PURCHASE units at ₹/purchase-unit (same
          // basis as /api/purchases — also the only reading consistent with
          // accepted × unit_price = line value). The `purchases` row above
          // stays in purchase units (updateMaterialPrice ÷pack_size assumes
          // it), but current_stock + inventory_transactions live in RECIPE
          // units, so ×pack_size here under the SAME pack>1 + recipe≠purchase
          // unit condition updateMaterialPrice applies. Negatives (back-
          // corrections) convert identically. last_purchase_price stays
          // ₹/purchase-unit (canonical — db.ts backfill derives it from
          // purchases.unit_price).
          const mat = getPackInfo.get(it.material_id) as any;
          const packSize = Number(mat?.pack_size) || 1;
          const ru = String(mat?.unit || '').toLowerCase().trim();
          const pu = String(mat?.purchase_unit || mat?.unit || '').toLowerCase().trim();
          const stockQty = (packSize > 1 && ru !== pu) ? accepted * packSize : accepted;
          bumpStock.run(stockQty, price, date, it.material_id);
          insTx.run(generateId(), it.material_id, stockQty, purchaseId,
                    accepted < 0 ? `BACK-CORRECTION ${grnNumber}` : `Ad-hoc GRN ${grnNumber}`,
                    outletId);
          touched.add(it.material_id);
        }
      }
      // NEVER on a held GRN: 'partial' would overwrite 'awaiting_qc' and the
      // sign-off's `WHERE status = 'awaiting_qc'` claim would then match nothing
      // — the delivery would be stuck, un-inwarded and un-signable. It cannot
      // fire anyway (storePreRejectBlock refuses a gated pre-reject, so
      // hasReject is false), and this is the second lock. decideGrnQc sets
      // 'partial' itself, by the same rule, when the kitchen rejects.
      if (!qc.required && hasReject) db.prepare(`UPDATE goods_receipt_notes SET status = 'partial' WHERE id = ?`).run(grnId);
    });
    txn();

    // Cascade weighted-avg + recipe re-cost. `touched` is EMPTY on a held GRN
    // (nothing was booked), so this is a no-op there rather than a special case.
    for (const mid of touched) updateMaterialPrice(db, mid);

    // ── TELL SOMEBODY, AFTER THE COMMIT ─────────────────────────────────────
    // Fire-and-forget and never throws: a notification failure must not fail —
    // or roll back — the receipt it announces. The BELL needs nothing written
    // (it counts status='awaiting_qc' live); this writes the durable record,
    // the push, and the WhatsApp ping that is dark by default.
    let qcRecipients: Array<{ email: string; name: string }> = [];
    if (qc.required) {
      try {
        const held = db.prepare(`
          SELECT COUNT(*) AS n, COALESCE(ROUND(SUM(quantity_received * unit_price), 2), 0) AS v
            FROM goods_receipt_note_items WHERE grn_id = ?`).get(grnId) as any;
        const r = await notifyGrnAwaitingQc(db, {
          grnId, grnNumber, vendor: vendor || '', date: String(date),
          checker: qc.checker, categories: qc.categories,
          lineCount: Number(held?.n) || 0, heldValue: Number(held?.v) || 0,
          receivedBy: me.email, outletId: outletId ?? null,
        });
        qcRecipients = r.recipients.map(x => ({ email: x.email, name: x.name }));
      } catch (e) {
        console.error('[grn POST] QC notification failed (non-fatal):', e);
      }
    }

    const grn = db.prepare('SELECT * FROM goods_receipt_notes WHERE id = ?').get(grnId);
    return Response.json({ success: true, grn_id: grnId, grn_number: grnNumber, grn,
                           materials_touched: touched.size,
                           store_blocked: storeBlocked,
                           // The receiving desk must be told, in the response it
                           // already reads, that NOTHING entered stock and who is
                           // expected to clear it — a silent hold at the bay is the
                           // one way this feature could make things worse.
                           qc_required: qc.required,
                           qc_status: qc.required ? QC_AWAITING : 'received',
                           qc_checker: qc.required ? qc.checker : 'none',
                           qc_categories: qc.categories,
                           qc_message: qc.message,
                           qc_notified: qcRecipients,
                         }, { status: 201 });
  } catch (e: any) {
    console.error('[grn POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
