import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canApproveAsChef, canIssueAsStore } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';
import { packFactor, dualQty, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { materialRate, rateMap } from '@/lib/closing-valuation';
import {
  getPoReturnWindowDays, checkReturnWindow, resolveLineUnits, returnMaterialBlock,
  alreadyReturnedByGrnItem, vendorReturnLineValue, isReturnDisposition,
  RETURN_DISPOSITIONS, type ReturnDisposition,
} from '@/lib/returns';
import { todayIST } from '@/lib/format-date';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE RETURN TICKET — read, edit-while-draft, discard-while-draft.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Requirements 72 (Return Authorization), 74 (Store Verification — the READ
 * side the store looks at), 77 (Internal Department Returns) and 79 (the ticket
 * detail the Return Report links out to).
 *
 * ── TWO THINGS EVERY READER OF THIS FILE MUST KNOW ────────────────────────
 *
 * 1. NOTHING IN THIS FILE MOVES STOCK. Not GET, not PUT, not DELETE. Stock
 *    moves in exactly one place in the whole returns module — the Store Accept
 *    step (/api/returns/[id]/store-verify) — and only for lines the store
 *    actually accepted. A ticket that is drafted, submitted, HOD-approved,
 *    edited here ten times, or deleted here has moved not one gram. That is
 *    what makes "a returned kilogram leaves the department exactly once and
 *    re-enters the store exactly once" true: there is a single door.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK, and `material_returns.kind` is the only thing that decides which:
 *
 *      kind='internal'  department -> central store. Goods STAY in the
 *                       building. Department stock DOWN, central stock UP.
 *                       This is requirement 76's "added back to Store stock".
 *      kind='vendor'    central store -> out of the building, back to the
 *                       supplier. Central stock DOWN. NO department leg, and
 *                       emphatically NO central credit — crediting central for
 *                       goods that have physically left would invent inventory.
 *                       The money is a credit note, recorded-only on the header.
 *
 *    `kind` is set at creation and is IMMUTABLE. This route refuses to change
 *    it (see PUT), because a ticket that flips kind after the fact flips the
 *    sign of a future stock movement, and the person who approved it approved
 *    the other direction.
 *
 * ── WHAT THE GET IS FOR ───────────────────────────────────────────────────
 * Requirement 72 asks the ticket to "auto-fill PO No. & GRN No.". That is a
 * REAL JOIN and not a guess — but only for a VENDOR line, and only because a
 * vendor line is raised FROM a goods_receipt_note_items row, so it carries
 * grn_item_id and the PO comes back through goods_receipt_notes.po_id.
 *
 * For an INTERNAL line the chain physically does not exist: the department
 * ledger carries no grn_id and no purchase_id, and department stock is pooled
 * per (department, material) with no lot tracking, so a kitchen returning onion
 * that arrived across three requisitions has no GRN to name. This route prints
 * BLANK for those, deliberately. It never falls back to "the most recent GRN
 * for this material" — measured on live data, Sugar arrived on five GRNs, four
 * of them ad-hoc with no PO at all, so a nearest-match would file a return at
 * the wrong rate against the wrong (or no) purchase order. A blank the user can
 * see is honest; a plausible wrong number is not.
 *
 * GET    /api/returns/[id]  -> header + lines + auto-filled PO/GRN + gates
 * PUT    /api/returns/[id]  -> edit a DRAFT only (400 naming the status otherwise)
 * DELETE /api/returns/[id]  -> discard a DRAFT only (400 naming the status otherwise)
 *
 * The workflow verbs live in their own routes, mirroring the requisition
 * module's one-route-per-verb layout:
 *   submit, hod-approve, hod-reject, store-verify, cancel
 */
export const dynamic = 'force-dynamic';

/** Only a draft may be edited or discarded through this route. */
const EDITABLE_STATUSES = ['draft'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Who may SEE this ticket. Reuses requisitionVisibility rather than inventing a
 * second visibility rule, because material_returns carries the same two columns
 * the helper predicates on — `r.department_id` and `r.drafted_by` (an email) —
 * so aliasing the header as `r` makes the generated SQL fit exactly. One rule
 * for "which department's paperwork can I see" is the point; two would drift.
 *
 * Consequence worth stating: a VENDOR ticket has department_id NULL, so a
 * department-scoped viewer (a main-dept head) does not see it, while admin /
 * store / global approvers do, and the raiser always sees their own via
 * drafted_by. That fails CLOSED, which is the correct direction for a document
 * that carries vendor money.
 */
async function visibility() {
  const me = await getCurrentUser();
  if (!me) return { sql: '0=1', params: [] as any[], me: null };
  const vis = requisitionVisibility(getDb(), me);
  if (!vis) return { sql: '1=1', params: [] as any[], me };   // null = see everything
  return { sql: vis.sql, params: vis.params, me };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — one ticket, its lines, the auto-filled PO/GRN, and the viewer's gates
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const { sql: visSql, params: visParams, me } = await visibility();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const ret = db.prepare(`
      SELECT r.*,
             d.name  AS department_name,
             d.code  AS department_code,
             g.grn_number,
             g.date  AS grn_date,
             po.po_number,
             po.status AS po_status,
             po.date   AS po_date,
             COALESCE(NULLIF(TRIM(v.name), ''), NULLIF(TRIM(r.vendor), ''), '') AS vendor_name
        FROM material_returns r
        LEFT JOIN departments         d  ON d.id  = r.department_id
        LEFT JOIN goods_receipt_notes g  ON g.id  = r.grn_id
        LEFT JOIN purchase_orders     po ON po.id = COALESCE(r.po_id, g.po_id)
        LEFT JOIN vendors             v  ON v.id  = r.vendor_id
       WHERE r.id = ? AND (${visSql})
    `).get(id, ...visParams) as any;
    if (!ret) return Response.json({ error: 'Return ticket not found' }, { status: 404 });

    const isVendor = String(ret.kind) === 'vendor';

    /**
     * THE AUTO-FILL JOIN (req 72). Everything PO/GRN hangs off `gi` — the GRN
     * LINE the vendor return was raised from — never off the material. On an
     * INTERNAL line grn_item_id is NULL, every LEFT JOIN below yields NULL, and
     * the COALESCE(..., '') below turns that into a printed blank. That is the
     * whole mechanism: internal lines print blank because there is genuinely
     * nothing to print, not because we suppressed something.
     *
     * NULLIF(TRIM(rm.purchase_unit), '') and not a bare COALESCE: an
     * empty-string purchase_unit would ship '' to the client, where every
     * reader falls back to the recipe unit and the row silently prints grams.
     * Same expression as the requisition + store-process routes.
     */
    const items = db.prepare(`
      SELECT mri.*,
             rm.name  AS material_name,
             rm.sku   AS material_sku,
             rm.unit  AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1)   AS material_pack_size,
             COALESCE(rm.case_size, 1)   AS material_case_size,
             rm.average_price,
             gi.quantity_accepted        AS grn_qty_accepted,
             gi.unit_price               AS grn_unit_price,
             g.grn_number                AS line_grn_number,
             g.date                      AS line_grn_date,
             po.po_number                AS line_po_number
        FROM material_return_items mri
        JOIN raw_materials rm             ON rm.id  = mri.material_id
        LEFT JOIN goods_receipt_note_items gi ON gi.id = mri.grn_item_id
        LEFT JOIN goods_receipt_notes      g  ON g.id  = gi.grn_id
        LEFT JOIN purchase_orders          po ON po.id = g.po_id
       WHERE mri.return_id = ?
       ORDER BY mri.created_at, mri.rowid
    `).all(id) as any[];

    // One SELECT for the whole ticket's rates instead of one per line.
    const rates = rateMap(db);

    const lines = items.map((it) => {
      const meta: PackMeta = {
        unit: it.material_unit,
        purchase_unit: it.material_purchase_unit,
        pack_size: it.material_pack_size,
        case_size: it.material_case_size,
      };
      const livePf = packFactor(meta);
      const snapPf = Number(it.pack_factor) || 1;

      // OWNER RULE: the screen LEADS with the purchase unit. dualQty is the
      // frozen wire shape { qty, unit, qty_purchase, purchase_unit, pack_factor }
      // — built from recipe_qty, which is the stored truth and the only number
      // stock ever moves by. qty_purchase is a ROUNDED DERIVATIVE: display it,
      // never store it, never sum it across materials.
      const requested = dualQty(Number(it.recipe_qty) || 0, meta);
      const accepted = dualQty(Number(it.accepted_recipe_qty) || 0, meta);

      // rate-basis: purchase
      // Rs per PURCHASE unit on both branches, multiplied by a PURCHASE-unit
      // quantity, so the pair is dimensionally sound. Vendor lines value at the
      // rate the goods actually came in at on that GRN line
      // (goods_receipt_note_items.unit_price is Rs/purchase-unit by canon) —
      // that is what a credit note has to agree with, so the multiplication is
      // handed to vendorReturnLineValue rather than repeated here. Internal
      // lines have no vendor bill, so they value through materialRate(), which
      // derives Rs/purchase-unit from the purchases table and NEVER reads
      // raw_materials.last_purchase_price (that column is stored in mixed bases
      // and may not be read at all).
      //
      // Both figures are DISPLAY / paperwork. Nothing here reaches
      // updateMaterialPrice, a purchases row or any recipe cost.
      const vendorRate = Number(it.grn_unit_price) || 0;
      const mr = materialRate(db, {
        id: it.material_id,
        unit: it.material_unit,
        purchase_unit: it.material_purchase_unit,
        pack_size: it.material_pack_size,
        average_price: it.average_price,
      }, rates.get(it.material_id) ?? null);
      const useGrnRate = isVendor && vendorRate > 0;
      const ratePerPurchaseUnit = useGrnRate ? vendorRate : mr.ratePerPurchaseUnit;
      const rateSource = useGrnRate ? 'grn_line' : mr.source;
      const value = vendorReturnLineValue(requested.qty_purchase, ratePerPurchaseUnit);
      const acceptedValue = vendorReturnLineValue(accepted.qty_purchase, ratePerPurchaseUnit);

      return {
        ...it,
        requested,
        accepted,
        // The factor the line was SNAPSHOTTED with, and whether the material's
        // pack has moved since. A movement must be reversible with the factor
        // it was made with; a silent drift is how a 750 becomes a 1.
        pack_factor_snapshot: snapPf,
        pack_factor_live: livePf,
        pack_factor_drift: Math.abs(snapPf - livePf) > 1e-9,
        // req 72 auto-fill. Blank — not a nearest match — on internal lines.
        po_number: String(it.line_po_number || ''),
        grn_number: String(it.line_grn_number || ''),
        grn_date: String(it.line_grn_date || ''),
        rate_per_purchase_unit: r2(ratePerPurchaseUnit),
        rate_basis: 'purchase' as const,
        rate_source: rateSource,
        value,
        accepted_value: acceptedValue,
      };
    });

    /**
     * The viewer's EFFECTIVE gates, resolved server-side so the page never has
     * to re-derive a permission rule (and get it subtly different).
     *
     * canApproveAsChef is the ROLE helper for requirement 73 — deliberately NOT
     * "is this user the department's head_user_id". That distinction was a live
     * bug in the requisition module once: head_user_id governs who SEES a
     * department's paperwork, never who may act on it.
     *
     * canIssueAsStore has NO admin bypass, matching auth.ts: accepting goods
     * back over the counter is a physical act, and an admin at a desk should
     * not be able to sign for a sack of onions they never touched.
     */
    const isAdmin = me.role === 'admin';
    const isAuthor = String(ret.drafted_by || '') === me.email;
    const can = {
      edit:         ret.status === 'draft' && (isAuthor || isAdmin),
      delete:       ret.status === 'draft' && (isAuthor || isAdmin),
      submit:       ret.status === 'draft' && (isAuthor || isAdmin),
      hod_approve:  ret.status === 'submitted' && canApproveAsChef(me),
      hod_reject:   ret.status === 'submitted' && canApproveAsChef(me),
      // The ONLY gate behind which stock moves.
      store_verify: ret.status === 'hod_approved' && canIssueAsStore(me),
      cancel:       ['draft', 'submitted', 'hod_approved'].includes(ret.status) && (isAuthor || isAdmin),
    };

    return Response.json({
      ret: {
        ...ret,
        // Restated on the wire so a client cannot mis-read the fork: these two
        // are opposite stock consequences, and only `kind` decides.
        kind_label: isVendor ? 'Vendor Return' : 'Internal Department Return',
        stock_effect: isVendor
          ? 'On Store Accept: central stock DECREASES. Goods leave the building; no department leg.'
          : 'On Store Accept: department stock DECREASES and central stock INCREASES. Goods stay in the building.',
        stock_moved: ret.status === 'verified',
      },
      items: lines,
      can,
      meta: {
        po_return_window_days: getPoReturnWindowDays(db),
        // Said plainly where a reader will hit it, not only in a comment.
        stock_note: 'Stock moves ONLY when the Store accepts this ticket. Draft, submitted and HOD-approved tickets have moved nothing.',
      },
    });
  } catch (e: any) {
    console.error('[/api/returns/[id] GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — edit a DRAFT only
// ─────────────────────────────────────────────────────────────────────────────
/**
 * A draft is the only editable state, and this is not squeamishness. Past
 * `draft` the ticket has been read and signed by someone: the HOD approved a
 * specific list of goods (req 73) and the store is about to accept that list
 * over a counter (req 74). Silently re-writing the lines under an approval
 * makes the approval a signature on a blank page. So: 400, naming the status,
 * and the caller cancels and raises a fresh ticket.
 *
 * Every creation-time refusal is re-run here, in full, on the incoming lines.
 * An edit is a creation of the line set — the previous validation applied to
 * quantities and materials that no longer exist on the row.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const ret = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as any;
    if (!ret) return Response.json({ error: 'Return ticket not found' }, { status: 404 });

    if (!EDITABLE_STATUSES.includes(String(ret.status))) {
      return Response.json({
        error: `Cannot edit a return ticket in '${ret.status}' state — only a draft can be edited.` +
          (ret.status === 'verified'
            ? ' This ticket has been store-verified and its stock movement is already posted; cancel is not available either. Raise a new ticket for any correction.'
            : ' Cancel it and raise a new ticket instead.'),
        status: ret.status,
      }, { status: 400 });
    }

    const isAdmin = me.role === 'admin';
    if (String(ret.drafted_by || '') !== me.email && !isAdmin) {
      return Response.json({ error: 'Only the person who raised this return, or an admin, can edit it.' }, { status: 403 });
    }

    const b = await req.json();

    // `kind` is IMMUTABLE. Flipping it flips the SIGN of the stock movement the
    // store will later post — an internal return credits central, a vendor
    // return debits it — so a ticket that changed kind mid-life would move
    // stock in the direction nobody approved. Refuse loudly rather than ignore
    // the field silently; a caller that sent it believes it took effect.
    if (b.kind !== undefined && String(b.kind) !== String(ret.kind)) {
      return Response.json({
        error: `A return ticket's kind cannot be changed (this one is '${ret.kind}'). A vendor return sends goods OUT of the building and debits central stock; an internal return brings them back IN and credits it. Raise a new ticket of the correct kind.`,
      }, { status: 400 });
    }
    const isVendor = String(ret.kind) === 'vendor';

    // ── header fields ──────────────────────────────────────────────────────
    let isoDate: string | null = null;
    if (b.date !== undefined) {
      const s = String(b.date || '').trim();
      if (!DATE_RE.test(s)) return Response.json({ error: 'date must be YYYY-MM-DD.' }, { status: 400 });
      if (s > todayIST()) return Response.json({ error: 'A return cannot be dated in the future.' }, { status: 400 });
      isoDate = s;
    }
    const notes = typeof b.notes === 'string' ? b.notes.trim() : undefined;
    // Credit note is RECORDED-ONLY: it never feeds stock, never feeds
    // average_price, and never becomes a (negative) purchases row. It exists so
    // the vendor's credit has somewhere honest to live on the paperwork.
    const creditNoteNo = typeof b.credit_note_no === 'string' ? b.credit_note_no.trim() : undefined;
    const creditNoteDate = typeof b.credit_note_date === 'string' ? b.credit_note_date.trim() : undefined;
    let creditNoteAmount: number | undefined;
    if (b.credit_note_amount !== undefined) {
      const n = Number(b.credit_note_amount);
      if (!Number.isFinite(n) || n < 0) {
        return Response.json({ error: 'credit_note_amount must be a number >= 0.' }, { status: 400 });
      }
      creditNoteAmount = r2(n);
    }
    if (creditNoteDate !== undefined && creditNoteDate !== '' && !DATE_RE.test(creditNoteDate)) {
      return Response.json({ error: 'credit_note_date must be YYYY-MM-DD (or blank).' }, { status: 400 });
    }
    if (!isVendor && (creditNoteNo || creditNoteAmount)) {
      return Response.json({
        error: 'An internal department return has no vendor and therefore no credit note — the goods never left the building.',
      }, { status: 400 });
    }

    // ── lines: re-run every creation-time refusal ──────────────────────────
    type Prepared = {
      lineId: string; materialId: string; quantity: number; unit: string;
      packFactor: number; recipeQty: number; reason: string; disposition: ReturnDisposition;
      grnItemId: string | null; poItemId: string | null; reqItemId: string | null; notes: string;
    };
    let prepared: Prepared[] | null = null;

    if (Array.isArray(b.items)) {
      const incoming = b.items.filter((it: any) => it && it.material_id && Number(it.quantity) > 0);
      if (incoming.length === 0) {
        return Response.json({ error: 'A return ticket needs at least one line with a quantity greater than zero.' }, { status: 400 });
      }

      const matStmt = db.prepare(`
        SELECT id, name, unit,
               COALESCE(NULLIF(TRIM(purchase_unit), ''), unit) AS purchase_unit
          FROM raw_materials WHERE id = ?
      `);
      const grnLineStmt = db.prepare(`
        SELECT gi.id, gi.grn_id, gi.po_item_id, gi.material_id, gi.quantity_accepted,
               g.grn_number, g.date AS grn_date, g.po_id
          FROM goods_receipt_note_items gi
          JOIN goods_receipt_notes g ON g.id = gi.grn_id
         WHERE gi.id = ?
      `);
      prepared = [];

      for (const it of incoming) {
        const materialId = String(it.material_id);
        const rm = matStmt.get(materialId) as any;
        if (!rm) return Response.json({ error: `Unknown material on one of the lines (${materialId}).` }, { status: 400 });

        // LIQUOR / STORE-MAPPED CARVE-OUT, through the module's own eligibility
        // helper (which wraps centralFlowBlock). These materials live on the
        // TGBCL store ledger; raw_materials.current_stock is not their truth, so
        // a vendor return would debit a central balance that never held them and
        // an internal return would credit one. Refused at CREATION rather than
        // skipped at accept time, because a workflow whose promise is "stock
        // moves on Accept" must not quietly accept and move nothing.
        const blocked = returnMaterialBlock(db, materialId);
        if (blocked) return Response.json({ error: blocked }, { status: 400 });

        const quantity = Number(it.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return Response.json({ error: `Quantity on "${rm.name}" must be greater than zero.` }, { status: 400 });
        }

        // ONE conversion, at the boundary, through the module's shared resolver
        // — never a local `pack_size > 1`, which drops the second half of the
        // guard and mis-converts every material whose recipe unit already
        // equals its purchase unit (live example: PICKLED GINGER 1.5KG, kg/kg,
        // pack 1.5). A blank or unrecognised unit is AMBIGUOUS; resolveLineUnits
        // says so and we refuse rather than guess, because guessing wrong here
        // is a 1000x stock error.
        //
        // A blank line unit is never STORED blank either. The client normally
        // sends the purchase unit (the screen leads with it), but the server
        // must not depend on that, so a blank defaults to the material's
        // purchase unit — the same resolution the requisition POST uses.
        // resolveLineUnits then sees a real unit and either converts or
        // refuses, on the record.
        const unit = String(it.unit || '').trim() || String(rm.purchase_unit || rm.unit || '');
        const ru = resolveLineUnits(db, materialId, unit, quantity);
        if (ru.needsReview) return Response.json({ error: ru.reviewReason }, { status: 400 });

        // RE-SNAPSHOTTED on every edit, exactly as at creation: the factor
        // stored on the row is the factor this quantity means, so the movement
        // can later be reversed with the factor it was actually made with
        // rather than with whatever pack_size says next month.
        const pf = ru.packFactor;
        const recipeQty = r3(ru.recipeQty);
        if (recipeQty <= 0) {
          return Response.json({ error: `Quantity on "${rm.name}" resolves to zero recipe units — nothing would move.` }, { status: 400 });
        }

        const reason = String(it.reason || '').trim();
        if (!reason) {
          return Response.json({ error: `A Reason is required on every return line (missing on "${rm.name}").` }, { status: 400 });
        }

        const disposition = String(it.disposition || 'reusable').trim();
        if (!isReturnDisposition(disposition)) {
          return Response.json({ error: `disposition must be one of ${RETURN_DISPOSITIONS.join(' / ')} (got "${disposition}" on "${rm.name}").` }, { status: 400 });
        }
        // req 78. Unusable goods are written off the department and never
        // re-enter the sellable pool; there is no such thing as writing off
        // stock that is on its way back to a vendor.
        if (isVendor && disposition !== 'reusable') {
          return Response.json({
            error: `"${disposition}" is a department write-off (requirement 78) and cannot apply to a vendor return — those goods go back to the supplier, they are not scrapped by us.`,
          }, { status: 400 });
        }

        let grnItemId: string | null = null;
        let poItemId: string | null = null;

        if (isVendor) {
          // req 72's auto-fill anchor. A vendor line MUST name the GRN line it
          // is returning; the system never picks one. Sugar arrived on five
          // GRNs, four of them ad-hoc with no PO — defaulting to the latest
          // would file a credit note against the wrong purchase order at the
          // wrong rate.
          grnItemId = it.grn_item_id ? String(it.grn_item_id) : null;
          if (!grnItemId) {
            return Response.json({
              error: `A vendor return line must be raised from a specific GRN line so the PO No. and GRN No. are exact (missing on "${rm.name}"). Pick the receipt the goods came in on.`,
            }, { status: 400 });
          }
          const gl = grnLineStmt.get(grnItemId) as any;
          if (!gl) return Response.json({ error: `GRN line not found for "${rm.name}".` }, { status: 400 });
          if (String(gl.material_id) !== materialId) {
            return Response.json({
              error: `The chosen GRN line is not for "${rm.name}" — returning against another material's receipt would credit the wrong PO.`,
            }, { status: 400 });
          }
          // The header names ONE receipt (and through it one vendor and one
          // PO). A line from a different GRN would split the credit note across
          // two vendors' paperwork while the header still shows one.
          if (ret.grn_id && String(ret.grn_id) !== String(gl.grn_id)) {
            return Response.json({
              error: `"${rm.name}" is on GRN ${gl.grn_number}, but this ticket was raised against a different receipt. One return ticket covers one GRN — raise a separate ticket for ${gl.grn_number}.`,
            }, { status: 400 });
          }
          poItemId = gl.po_item_id ? String(gl.po_item_id) : null;

          // req 75 — THE PO RETURN WINDOW, re-checked here because an edit is a
          // creation of the line set. 0 days = no limit, which is exactly
          // today's behaviour (a PO has always been open for returns forever).
          // The window is measured from the GRN DATE, not
          // purchase_orders.received_at, and the whole rule lives in
          // checkReturnWindow so the create route and this one cannot drift.
          // Nothing here writes a PO status; no PO is ever closed by this route.
          const win = checkReturnWindow(db, gl.grn_date);
          if (!win.ok) {
            return Response.json({ error: `${gl.grn_number}: ${win.error}` }, { status: 400 });
          }

          // Cannot send back more than the GRN line accepted, minus what has
          // already gone back on a VERIFIED ticket. quantity_accepted is
          // PURCHASE units by canon, so the comparison happens in purchase
          // units — alreadyReturnedByGrnItem returns that basis directly,
          // reversing each prior row with the pack_factor SNAPSHOTTED ON THAT
          // ROW rather than with today's pack_size. Comparing against its recipe
          // figure instead would over-count by the pack size and refuse every
          // second return. This draft cannot appear in that sum: only verified
          // tickets are counted, and a draft has moved nothing.
          const accepted = Number(gl.quantity_accepted) || 0;
          const done = alreadyReturnedByGrnItem(db, [grnItemId]).get(grnItemId);
          const donePurchase = Number(done?.returned_purchase_qty) || 0;
          const remaining = r3(accepted - donePurchase);
          // This line's own quantity in the SAME basis. toPurchaseQty, never a
          // hand-rolled divide; ru.materialPackFactor is the both-halves-guarded
          // recipe-per-purchase factor resolveLineUnits already computed.
          const thisPurchaseQty = toPurchaseQty(recipeQty, {
            unit: ru.materialUnit, purchase_unit: ru.purchaseUnit, pack_size: ru.materialPackFactor,
          } as PackMeta);
          if (thisPurchaseQty > remaining + 1e-6) {
            return Response.json({
              error: `GRN ${gl.grn_number} accepted ${r3(accepted)} ${ru.purchaseUnit} of "${rm.name}" and ${r3(donePurchase)} has already been returned — at most ${remaining} ${ru.purchaseUnit} can go back (this line asks for ${thisPurchaseQty}).`,
            }, { status: 400 });
          }
        } else {
          // INTERNAL. The PO/GRN chain physically does not exist for goods that
          // came out of the department's pooled stock, so these stay NULL and
          // the report prints blank. Refuse a caller that tries to attach one:
          // an internal line carrying a GRN would be read as a vendor line by
          // the report and land in the wrong half of requirement 79's split.
          if (it.grn_item_id || it.po_item_id) {
            return Response.json({
              error: `An internal department return has no GRN or PO line — department stock is pooled per (department, material) with no lot tracking, so "${rm.name}" cannot name the receipt it arrived on.`,
            }, { status: 400 });
          }
        }

        prepared.push({
          lineId: generateId(),
          materialId,
          quantity: r3(quantity),
          unit,
          packFactor: pf,
          recipeQty,
          reason,
          disposition,
          grnItemId,
          poItemId,
          // Reference only, and usually NULL. NEVER a cap input to
          // assertReversible and NEVER written back to
          // requisition_items.quantity_issued — the returns module is not a
          // writer of that column.
          reqItemId: it.req_item_id ? String(it.req_item_id) : null,
          notes: String(it.notes || '').trim(),
        });
      }
    }

    const txn = db.transaction(() => {
      db.prepare(`
        UPDATE material_returns SET
          date               = COALESCE(?, date),
          notes              = COALESCE(?, notes),
          credit_note_no     = COALESCE(?, credit_note_no),
          credit_note_date   = COALESCE(?, credit_note_date),
          credit_note_amount = COALESCE(?, credit_note_amount),
          updated_at         = datetime('now')
        WHERE id = ? AND status = 'draft'
      `).run(
        isoDate, notes ?? null,
        creditNoteNo ?? null, creditNoteDate ?? null, creditNoteAmount ?? null,
        id,
      );

      if (prepared) {
        // Wholesale replace. Safe here and ONLY here: a draft has no
        // dept_txn_id / inv_txn_id on any line, because nothing has moved. The
        // status guard in the UPDATE above and the EDITABLE_STATUSES check are
        // what keep it that way — dropping a line that carries a movement
        // receipt would strand a posted stock movement with no row to explain
        // it, which is the returns-module equivalent of the requisition
        // "cannot change items after issue" refusal.
        db.prepare('DELETE FROM material_return_items WHERE return_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO material_return_items
            (id, return_id, material_id, quantity, unit, pack_factor, recipe_qty,
             reason, disposition, grn_item_id, po_item_id, req_item_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const p of prepared) {
          ins.run(p.lineId, id, p.materialId, p.quantity, p.unit, p.packFactor, p.recipeQty,
                  p.reason, p.disposition, p.grnItemId, p.poItemId, p.reqItemId, p.notes);
        }
      }
    });
    txn();

    const fresh = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id);
    return Response.json({ ret: fresh, items_replaced: prepared ? prepared.length : null });
  } catch (e: any) {
    console.error('[/api/returns/[id] PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — discard a DRAFT only
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Drafts are the only disposable state, for the same reason they are the only
 * editable one: past `draft` the ticket is somebody's signature, and past
 * `verified` it is the explanation for a posted stock movement. Deleting a
 * verified ticket would leave department_material_transactions and
 * inventory_transactions rows pointing at a return_item_id that no longer
 * exists — the grams would still have moved, with nothing on file saying why.
 * So: 400, naming the status, and the row survives. Non-draft tickets are
 * retired with `cancel`, which is a status, not a deletion.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const ret = db.prepare('SELECT id, status, drafted_by, ret_number FROM material_returns WHERE id = ?').get(id) as any;
    if (!ret) return Response.json({ error: 'Return ticket not found' }, { status: 404 });

    if (String(ret.status) !== 'draft') {
      return Response.json({
        error: `Only a draft return can be deleted — ${ret.ret_number} is '${ret.status}'.` +
          (ret.status === 'verified'
            ? ' It is the record of a posted stock movement and must stay on file.'
            : ' Cancel it instead; the ticket stays on the Return Report.'),
        status: ret.status,
      }, { status: 400 });
    }
    if (String(ret.drafted_by || '') !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the person who raised this return, or an admin, can delete it.' }, { status: 403 });
    }

    // Lines are deleted explicitly rather than left to ON DELETE CASCADE. The
    // cascade is real (db.ts sets `foreign_keys = ON`), but a stock document
    // should say out loud what it removes.
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM material_return_items WHERE return_id = ?').run(id);
      db.prepare(`DELETE FROM material_returns WHERE id = ? AND status = 'draft'`).run(id);
    });
    txn();

    return Response.json({ success: true, deleted: ret.ret_number });
  } catch (e: any) {
    console.error('[/api/returns/[id] DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
