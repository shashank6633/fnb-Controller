import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef, canIssueAsStore } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';
import {
  RETURN_KINDS, RETURN_DISPOSITIONS, isReturnKind, isReturnDisposition,
  nextReturnNumber, checkReturnWindow, returnMaterialBlock,
  resolveLineUnitsFor, returnedRecipeQtyForGrnItem,
} from '@/lib/returns';

/**
 * Material Returns REST API — the list + the draft.  (Requirements 72-79.)
 *
 * ── THE ONE THING TO KNOW BEFORE READING ANY FURTHER ───────────────────────
 * NOTHING IN THIS FILE MOVES STOCK. Not the draft, not the submit, not the
 * HOD approval. A return ticket is a piece of paper until the STORE ACCEPTS
 * it, and the whole stock consequence lives in that single accept transaction
 * (src/lib/return-stock.ts, called from /api/returns/[id]/store-verify).
 *
 *   raise (department) → HOD/Manager approves → reaches Store
 *                      → Store verifies, Accept or Reject with a mandatory reason
 *                                     ↑
 *                          stock moves HERE, once, atomically
 *
 * A rejected return leaves stock exactly where it was. That is why every
 * refusal this route can make is made AT CREATION: a ticket that could never
 * legally be accepted should never be raised, because by accept time the
 * goods are on the counter and a refusal there is an argument, not a
 * validation.
 *
 * ── THE TWO KINDS ARE OPPOSITE, NOT VARIANTS ───────────────────────────────
 * `kind` is the fork, and it decides the SIGN of the central stock movement:
 *
 *   kind='internal'  Department → Central Store. The goods stay in the
 *                    building. Department stock DOWN, central stock UP.
 *                    This is requirement 76/77's shape.
 *
 *   kind='vendor'    Central Store → out of the building, back to the vendor.
 *                    Central stock DOWN. There is NO department leg, and
 *                    crediting central here would invent inventory that has
 *                    physically left the premises. The money is a credit note,
 *                    recorded-only on the header (requirement 72).
 *
 * Requirement 76's wording — "added back to Store stock" — describes the
 * INTERNAL shape ONLY. Read literally and applied to a vendor return it
 * manufactures stock. So `kind` is set at creation, CHECK-constrained in the
 * schema, and never updated by any route: this file is the only place it is
 * ever written, and it writes it once.
 *
 * GET  /api/returns   → list, scoped by requisitionVisibility, filterable by
 *                       ?status= &kind= &department_id= &from= &to= &grn_id=
 * POST /api/returns   → create a draft ticket + its lines
 *
 * Stage actions (submit / hod-approve / hod-reject / store-verify / cancel)
 * live under /api/returns/[id]/[action], mirroring the requisition module's
 * one-route-per-verb layout.
 */

const EPS = 1e-9;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WHO SEES a ticket — never who may act on one.
 *
 * requisitionVisibility writes its predicate against the alias `r`, so the
 * returns list aliases material_returns as `r` and inherits the requisition
 * module's scoping wholesale: admin + store see the full pipeline, a main-dept
 * head sees their subtree, everyone else sees only what they raised.
 *
 * It reads `r.department_id` and `r.drafted_by`, both of which exist on
 * material_returns with the same meaning (drafted_by is an EMAIL, as on
 * requisitions). A VENDOR ticket has a NULL department_id, so a dept-head's
 * subtree predicate excludes it and only the raiser, store and admin see it.
 * That is the fail-closed direction and is deliberate.
 */
async function visibilityFilter() {
  const me = await getCurrentUser();
  if (!me) return { sql: '0=1', params: [] as any[], me: null };
  const vis = requisitionVisibility(getDb(), me);
  if (!vis) return { sql: '1=1', params: [] as any[], me };   // null = see all (admin/store)
  return { sql: vis.sql, params: vis.params, me };
}

// ---------- GET (list) ----------
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const { sql: visSql, params: visParams, me } = await visibilityFilter();

    const status       = url.searchParams.get('status');
    const kind         = url.searchParams.get('kind');
    const departmentId = url.searchParams.get('department_id');
    const grnId        = url.searchParams.get('grn_id');
    const from         = url.searchParams.get('from');
    const to           = url.searchParams.get('to');

    const where: string[] = [visSql];
    const params: any[] = [...visParams];

    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(r.outlet_id = ? OR r.outlet_id IS NULL)'); params.push(outletId); }

    if (status)       { where.push('r.status = ?');        params.push(status); }
    if (kind)         { where.push('r.kind = ?');          params.push(kind); }
    if (departmentId) { where.push('r.department_id = ?'); params.push(departmentId); }
    if (grnId)        { where.push('r.grn_id = ?');        params.push(grnId); }
    if (from)         { where.push('r.date >= ?');         params.push(from); }
    if (to)           { where.push('r.date <= ?');         params.push(to); }

    const rows = db.prepare(`
      SELECT r.*,
             d.name  AS department_name, d.code AS department_code,
             g.grn_number,
             po.po_number,
             (SELECT COUNT(*) FROM material_return_items WHERE return_id = r.id) AS item_count,
             -- Requirement 78's "separate reports" needs the disposal/wastage
             -- lines findable from the list, not only from the report. Counted
             -- as LINES, never summed as quantities: a ticket can mix grams and
             -- millilitres and a summed quantity across materials is a number
             -- with no unit.
             (SELECT COUNT(*) FROM material_return_items
               WHERE return_id = r.id AND disposition IN ('wastage','disposal')) AS lines_written_off
      FROM material_returns r
      LEFT JOIN departments        d  ON d.id  = r.department_id
      LEFT JOIN goods_receipt_notes g ON g.id  = r.grn_id
      LEFT JOIN purchase_orders    po ON po.id = r.po_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.date DESC, r.created_at DESC
    `).all(...params) as any[];

    // Per-row UI hints. These mirror the server-side gates in the stage routes
    // exactly, and they are hints ONLY — every action route re-checks. Note
    // what is NOT here: isMainDeptHead. Approval is gated on the ROLE
    // (canApproveAsChef), never on a department's head_user_id; conflating the
    // two was a live bug in the requisition module and is not repeated here.
    const rowsWithPerm = rows.map((r) => {
      const mine = !!me && r.drafted_by === me.email;
      const admin = me?.role === 'admin';
      return {
        ...r,
        can_submit:        !!me && r.status === 'draft' && (mine || admin),
        can_hod_approve:   !!me && r.status === 'submitted' && canApproveAsChef(me),
        // The only stage that moves stock, and deliberately no admin bypass:
        // accepting goods over the counter is a physical act (see the reasoning
        // recorded on canIssueAsStore in src/lib/auth.ts).
        can_store_verify:  !!me && r.status === 'hod_approved' && canIssueAsStore(me),
        can_cancel:        !!me && (r.status === 'draft' || r.status === 'submitted') && (mine || admin),
      };
    });

    return Response.json({
      returns: rowsWithPerm,
      viewer_email: me?.email || '',
      viewer_role: me?.role || 'guest',
      viewer_can_approve_hod: me ? canApproveAsChef(me) : false,
      viewer_can_verify_store: me ? canIssueAsStore(me) : false,
    });
  } catch (e: any) {
    console.error('[/api/returns GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ---------- POST (create draft) ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();

    // ── 1. The fork, first, before anything else is read ────────────────────
    // Everything below branches on this, so an unrecognised value must never
    // fall through to a default. There is no default: a ticket that cannot say
    // which direction its stock moves is not a ticket.
    const kind = String(b.kind || '').trim().toLowerCase();
    if (!isReturnKind(kind)) {
      return Response.json({ error: `kind must be one of ${RETURN_KINDS.join(' | ')} — 'internal' is department → store, 'vendor' is store → vendor` }, { status: 400 });
    }

    const departmentId = String(b.department_id || '').trim();
    const grnId        = String(b.grn_id || '').trim();

    // INTERNAL: the department is the whole point — it is the side that gets
    // debited at accept. A vendor anchor on an internal ticket is not a
    // harmless extra field; it is two contradictory claims about where the
    // goods are going.
    if (kind === 'internal') {
      if (!departmentId) {
        return Response.json({ error: 'department_id is required for an internal department return' }, { status: 400 });
      }
      if (grnId) {
        return Response.json({ error: 'An internal department return cannot carry a GRN — goods are going back to the store, not to a vendor.' }, { status: 400 });
      }
    }
    // VENDOR: anchored on a GRN, never on a department. See the picker note in
    // the GRN-line block below for why the GRN is mandatory rather than guessed.
    if (kind === 'vendor') {
      if (!grnId) {
        return Response.json({ error: 'grn_id is required for a vendor return — pick the GRN line the goods arrived on' }, { status: 400 });
      }
      if (departmentId) {
        return Response.json({ error: 'A vendor return cannot carry a department — the goods leave the building; they do not move between departments.' }, { status: 400 });
      }
    }

    // ── 2. Lines ────────────────────────────────────────────────────────────
    const rawItems = Array.isArray(b.items) ? b.items : [];
    if (rawItems.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }

    type Draft = {
      materialId: string;
      materialName: string;
      quantity: number;
      unit: string;
      packFactor: number;
      recipeQty: number;
      reason: string;
      disposition: string;
      grnItemId: string | null;
      poItemId: string | null;
      reqItemId: string | null;
      notes: string;
    };
    const drafts: Draft[] = [];

    // Vendor over-return is checked per GRN LINE, and the running total has to
    // span the lines of THIS ticket too. Two lines of 3 against a GRN line with
    // 4 accepted each pass a per-line check and together return 6. Accumulate.
    const claimedByGrnItem = new Map<string, number>();

    // ── 2a. The vendor anchor: GRN → PO → vendor, denormalised once ─────────
    let grn: any = null;
    if (kind === 'vendor') {
      grn = db.prepare(`
        SELECT g.id, g.grn_number, g.date, g.po_id, g.vendor_id, g.vendor,
               po.po_number
        FROM goods_receipt_notes g
        LEFT JOIN purchase_orders po ON po.id = g.po_id
        WHERE g.id = ?
      `).get(grnId) as any;
      if (!grn) return Response.json({ error: 'GRN not found' }, { status: 404 });

      // Requirement 75 — the PO return window. Measured from the GRN's own
      // date, NOT from received_at: received_at stays NULL while a multi-vendor
      // PO is part-delivered, which would hold the window open indefinitely and
      // then slam it shut the moment the last vendor delivers. Absent setting =
      // no limit = exactly today's behaviour.
      const win = checkReturnWindow(db, String(grn.date || ''));
      if (!win.ok) return Response.json({ error: win.error }, { status: 400 });
    }

    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i] || {};
      const label = `Line ${i + 1}`;
      const materialId = String(it.material_id || '').trim();
      const quantity = Number(it.quantity);

      if (!materialId) return Response.json({ error: `${label}: material_id is required` }, { status: 400 });
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return Response.json({ error: `${label}: quantity must be greater than zero` }, { status: 400 });
      }

      // Requirement 72 makes Reason part of the ticket, not an afterthought.
      // Blank-but-present is the same as absent.
      const reason = String(it.reason || '').trim();
      if (!reason) return Response.json({ error: `${label}: a reason is required for every returned line` }, { status: 400 });

      const disposition = String(it.disposition || 'reusable').trim().toLowerCase();
      if (!isReturnDisposition(disposition)) {
        return Response.json({ error: `${label}: disposition must be one of ${RETURN_DISPOSITIONS.join(', ')}` }, { status: 400 });
      }
      // Requirement 78 is a write-off of goods the DEPARTMENT holds — at accept
      // it debits the department and credits nobody, so the grams never re-enter
      // the sellable pool. A vendor return has no department leg to debit, and
      // the goods physically go back to the supplier, so "dispose" there would
      // either mean nothing or mean deducting central twice. Refuse the
      // combination rather than resolve it at accept time.
      if (kind === 'vendor' && disposition !== 'reusable') {
        return Response.json({
          error: `${label}: a vendor return cannot be marked ${disposition} — the goods go back to the supplier. Raise an internal return (or the Wastage screen) to write stock off.`,
        }, { status: 400 });
      }

      const rm = db.prepare(`
        SELECT id, name, unit,
               COALESCE(NULLIF(TRIM(purchase_unit), ''), unit) AS purchase_unit,
               COALESCE(pack_size, 1) AS pack_size
        FROM raw_materials WHERE id = ?
      `).get(materialId) as any;
      if (!rm) return Response.json({ error: `${label}: material not found` }, { status: 404 });

      // Store-mapped (liquor) materials never enter Central Store flows — the
      // purchase, GRN, PO and inward-import routes all refuse them, and their
      // stock lives in store_stock_ledger, not raw_materials.current_stock.
      // A vendor return would debit a central balance that never held them; an
      // internal return would credit one. issue-stock SKIPS these lines; a
      // workflow whose whole promise is "stock moves when the store accepts"
      // cannot silently skip, so this REFUSES at creation instead.
      const blocked = returnMaterialBlock(db, materialId);
      if (blocked) return Response.json({ error: `${label}: ${blocked}` }, { status: 400 });

      // ── UNITS. The screen leads with the PURCHASE unit (owner rule); the
      // ledgers take RECIPE units only and refuse to convert for you. The
      // conversion happens ONCE, here, at the boundary, and the factor is
      // SNAPSHOTTED onto the line — the same discipline as
      // requisition_issue_ledger.pack_factor — so the accept can reverse the
      // movement with the factor it was made with rather than with whatever
      // pack_size says next month.
      //
      // needsReview means the line's unit is blank or unrecognised ON A PACKED
      // MATERIAL — the one genuinely ambiguous case, where reading it as
      // purchase vs recipe differs by pack_size. Guessing is a 750x stock
      // error; refuse, and hand back the lib's own reason verbatim so the
      // screen and the server say the same thing. PICKLED GINGER 1.5KG
      // (kg / kg / 1.5) is NOT ambiguous: both halves of the guard must hold,
      // its two units are the same word, so its factor is 1 and it stores 1.
      const resolved = resolveLineUnitsFor(rm, it.unit, quantity);
      if (resolved.needsReview) {
        return Response.json({ error: `${label}: ${resolved.reviewReason}` }, { status: 400 });
      }
      // The LINE factor (recipe units per unit-as-typed) — what this line's
      // quantity converts by. Distinct from resolved.materialPackFactor, which
      // is recipe units per PURCHASE unit; conflating the two is the trap
      // handled in the GRN cap below.
      const packFactorUsed = resolved.packFactor;
      const recipeQty = resolved.recipeQty;
      const lineUnit = resolved.unit || resolved.purchaseUnit;

      let grnItemId: string | null = null;
      let poItemId: string | null = null;

      if (kind === 'vendor') {
        // Requirement 72's auto-fill is a REAL JOIN off a chosen GRN line, not
        // a lookup by material. The same material commonly arrives on several
        // GRNs at different prices, some with a PO and some ad-hoc; defaulting
        // to the most recent would file the credit note against the wrong PO at
        // the wrong price. The user picks the line; the server never guesses.
        grnItemId = String(it.grn_item_id || '').trim() || null;
        if (!grnItemId) {
          return Response.json({ error: `${label}: grn_item_id is required on a vendor return — pick the GRN line these goods arrived on` }, { status: 400 });
        }
        const gi = db.prepare(`
          SELECT gi.id, gi.grn_id, gi.material_id, gi.po_item_id, gi.quantity_accepted
          FROM goods_receipt_note_items gi WHERE gi.id = ?
        `).get(grnItemId) as any;
        if (!gi) return Response.json({ error: `${label}: GRN line not found` }, { status: 404 });
        if (gi.grn_id !== grn.id) {
          return Response.json({ error: `${label}: that GRN line belongs to a different GRN` }, { status: 400 });
        }
        if (gi.material_id !== materialId) {
          return Response.json({ error: `${label}: the GRN line is for a different material` }, { status: 400 });
        }
        poItemId = String(it.po_item_id || gi.po_item_id || '').trim() || null;

        // You cannot return more than arrived, minus what has already gone
        // back. "Already returned" is DERIVED by summing accepted quantities on
        // verified tickets — mirroring receivedPoItemIds()'s derived-ledger
        // discipline — rather than decremented onto
        // goods_receipt_note_items.quantity_accepted, because that column is
        // what decides whether a PO is complete: writing to it here would
        // silently reopen or close a purchase order as a side effect of a
        // return.
        //
        // BASIS: the comparison happens entirely in RECIPE units, the one basis
        // both sides can be stated in without a guess.
        //
        // quantity_accepted is PURCHASE units by canon, so it scales by
        // materialPackFactor — recipe units per PURCHASE unit — and NOT by
        // packFactorUsed, which is recipe units per unit-as-TYPED. The two
        // differ exactly when the user typed the recipe unit: the line factor
        // is then 1, and multiplying a purchase-unit receipt by 1 would treat
        // 2 litres received as 2 millilitres and refuse a perfectly legal
        // 500 ml return. returnedRecipeQtyForGrnItem already answers in recipe
        // units, summed over VERIFIED tickets only.
        //
        // Reported back in the line's own unit — what the user typed and what
        // the screen shows — by dividing through the LINE factor.
        const acceptedRecipe = Number(gi.quantity_accepted || 0) * resolved.materialPackFactor;
        const returnedRecipe = returnedRecipeQtyForGrnItem(db, grnItemId);
        const claimedRecipe = claimedByGrnItem.get(grnItemId) || 0;
        const remainingRecipe = acceptedRecipe - returnedRecipe - claimedRecipe;
        if (recipeQty > remainingRecipe + EPS) {
          const inLineUnit = (r: number) => Number((r / (packFactorUsed || 1)).toFixed(4));
          return Response.json({
            error: `${label}: cannot return ${quantity} ${lineUnit} of "${rm.name}" — only ${inLineUnit(remainingRecipe)} ${lineUnit} remain returnable on GRN ${grn.grn_number} (received ${inLineUnit(acceptedRecipe)} ${lineUnit}, already returned ${inLineUnit(returnedRecipe + claimedRecipe)} ${lineUnit}).`,
          }, { status: 400 });
        }
        claimedByGrnItem.set(grnItemId, claimedRecipe + recipeQty);
      }

      drafts.push({
        materialId,
        materialName: rm.name,
        quantity,
        unit: lineUnit,
        packFactor: packFactorUsed,
        recipeQty,
        reason,
        disposition,
        grnItemId,
        poItemId,
        // INTERNAL reference only, and usually null. Department stock is pooled
        // per (department, material) with no lot tracking, so a kitchen
        // returning onion that arrived across three requisitions has no single
        // line to cite. It is never a cap input at accept and is never written
        // back to requisition_items.quantity_issued — the returns module is not
        // a writer of the store's record of what it handed over.
        reqItemId: String(it.req_item_id || '').trim() || null,
        notes: String(it.notes || ''),
      });
    }

    // ── 3. Who may raise what ───────────────────────────────────────────────
    // Same rule the requisition composer enforces: a plain department user
    // raises for their own department only. Store and admin are cross-cutting;
    // a vendor return is a store-side act and carries no department at all.
    if (kind === 'internal' && me.role !== 'admin' && !me.is_head_chef && !me.is_store_manager) {
      if (me.department_id && departmentId !== me.department_id) {
        return Response.json({ error: 'You can only raise returns for your own department' }, { status: 403 });
      }
    }

    if (kind === 'internal') {
      const dept = db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId) as any;
      if (!dept) return Response.json({ error: 'Department not found' }, { status: 404 });
    }

    const rawDate = String(b.date || '').trim();
    const isoDate = DATE_RE.test(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
    const outletId = await getCurrentOutletId();
    const id = generateId();

    // Credit note (requirement 72's money side) is RECORDED-ONLY. It never
    // touches stock, never touches average_price, and deliberately writes no
    // negative `purchases` row: updateMaterialPrice takes the latest unit_price
    // on the FIFO branch, so a negative purchase would become THE price and
    // cascade into every sub-recipe and recipe cost. There are zero negative
    // purchases in this database and this route does not add the first.
    const creditNoteNo     = String(b.credit_note_no || '').trim();
    const creditNoteDate   = String(b.credit_note_date || '').trim();
    const creditNoteAmount = Number(b.credit_note_amount) || 0;
    const notes            = String(b.notes || '');

    let retNumber = '';
    const txn = db.transaction(() => {
      // Generated INSIDE the transaction, as the generator's own contract
      // requires: read-then-insert across a transaction boundary is how two
      // tickets get the same number, and ret_number is UNIQUE.
      retNumber = nextReturnNumber(db, isoDate);
      db.prepare(`
        INSERT INTO material_returns
          (id, ret_number, kind, date, status, department_id,
           grn_id, po_id, vendor_id, vendor,
           credit_note_no, credit_note_date, credit_note_amount,
           notes, outlet_id, drafted_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        id, retNumber, kind, isoDate,
        kind === 'internal' ? departmentId : null,
        // Denormalised from the CHOSEN GRN, not from the client: po_id and the
        // vendor travel with the GRN row, and 9 of the live GRNs have no PO at
        // all, so a null here is an honest "this arrived ad-hoc" rather than a
        // nearest match.
        kind === 'vendor' ? grn.id : null,
        kind === 'vendor' ? (grn.po_id || null) : null,
        kind === 'vendor' ? (grn.vendor_id || null) : null,
        kind === 'vendor' ? (grn.vendor || '') : '',
        creditNoteNo, creditNoteDate, creditNoteAmount,
        notes, outletId, me.email,
      );

      const insLine = db.prepare(`
        INSERT INTO material_return_items
          (id, return_id, material_id, quantity, unit, pack_factor, recipe_qty,
           reason, disposition, grn_item_id, po_item_id, req_item_id, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      for (const d of drafts) {
        insLine.run(
          generateId(), id, d.materialId,
          d.quantity, d.unit, d.packFactor, d.recipeQty,
          d.reason, d.disposition, d.grnItemId, d.poItemId, d.reqItemId, d.notes,
        );
      }
    });
    txn();

    try {
      logAuditEvent(db, {
        event_type: 'return.create',
        entity_type: 'material_return',
        entity_id: id,
        actor_email: me.email,
        outlet_id: outletId,
        after: {
          ret_number: retNumber, kind, date: isoDate,
          department_id: kind === 'internal' ? departmentId : null,
          grn_id: kind === 'vendor' ? grn.id : null,
          lines: drafts.length,
        },
        note: `${kind} return drafted with ${drafts.length} line(s) — no stock moves until the store accepts`,
      });
    } catch { /* audit must never break the ticket */ }

    const created = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id);
    const items = db.prepare('SELECT * FROM material_return_items WHERE return_id = ?').all(id);
    return Response.json({ return: created, items }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/returns POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
