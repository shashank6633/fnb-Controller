import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canIssueAsStore } from '@/lib/auth';
import { isDeptReversalBlocked } from '@/lib/dept-ledger';
import {
  acceptInternalReturnLine,
  acceptVendorReturnLine,
  isReturnStockRefused,
  type ReturnMoveResult,
} from '@/lib/return-stock';
import { isReturnDisposition, type ReturnDisposition } from '@/lib/returns';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ REQUIREMENT 74 — STORE VERIFICATION.  THE ONLY DOOR STOCK MOVES THROUGH. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Store should verify returned items and either Accept or Reject them with a
 *  mandatory reason."  Plus requirements 76 (the accepted goods go back on the
 *  books), 77 (internal department returns) and 78 (unusable goods are written
 *  off instead).
 *
 * ── 1. STOCK MOVES ONLY HERE, AND ONLY ON ACCEPT ──────────────────────────
 * The chain is: raise (draft) -> submit -> HOD approve -> Store verify (this
 * route). Every step before this one is paperwork: raising a return moves
 * nothing, approving it moves nothing, and a ticket can sit at 'hod_approved'
 * for a week with the goods on the store counter and not one gram has changed
 * hands. THIS transition is the first and last moment any balance moves, and it
 * moves exactly once. That single door is what makes the module's promise true
 * — a returned kilogram leaves the department exactly once and re-enters the
 * store exactly once.
 *
 * A REJECTED LINE MOVES NOTHING AT ALL. Not a partial credit, not a write-off,
 * nothing: the goods are still physically wherever they were, so the books must
 * say so too. Rejecting requires a reason, and the reason is enforced here
 * rather than trusted from the screen.
 *
 * ── 2. A VENDOR RETURN AND AN INTERNAL RETURN DO OPPOSITE THINGS TO CENTRAL ──
 * This is the single most dangerous thing in the module to get wrong, so it is
 * decided by an immutable column and dispatched to two separately named
 * functions — never by an if-branch on a value this route computes:
 *
 *   kind = 'internal'  DEPARTMENT -> CENTRAL STORE. The goods stay in the
 *                      building. Department stock DOWN, central stock UP.
 *                      This is what requirement 76 means by "added back to
 *                      Store stock as Returned Stock".
 *   kind = 'vendor'    CENTRAL STORE -> OUT OF THE BUILDING, back to the
 *                      supplier. Central stock DOWN, and there is NO department
 *                      leg whatsoever. Crediting central here would invent
 *                      inventory that is physically on the vendor's lorry.
 *
 * `material_returns.kind` is set at ticket creation and is never updated by any
 * route. This route reads it and calls the matching mover. It does not accept a
 * kind from the request body, and it must never be given one — a kind supplied
 * by the caller is a sign flip on a stock movement handed to whoever can post a
 * form.
 *
 * ── 3. ONE ATOMIC COMMIT, CLAIMED ONCE ────────────────────────────────────
 * Verification is a SINGLE transaction over the whole ticket, not a line at a
 * time. Inside it, before anything is moved:
 *
 *     UPDATE material_returns SET status='verified' ... WHERE id=? AND status='hod_approved'
 *
 * and `changes === 1` is asserted. That single-shot claim IS the double-move
 * guard: a replayed or double-clicked verify finds the row no longer at
 * 'hod_approved', changes === 0, and the second request moves nothing and
 * answers 400. (applyIssueDelta's clientToken idempotency is not reusable here
 * — this ticket has no such token — so the status itself is the token.)
 *
 * Everything after the claim throws rather than clamps, and a throw rolls the
 * status change back with it: a refused line leaves the ticket at
 * 'hod_approved', re-verifiable, rather than half-accepted and terminal. That
 * is why the line validation lives INSIDE the transaction and not in a
 * pre-flight pass — a pre-flight that passes and a transaction that fails on
 * line 3 of 5 is exactly the torn write this shape exists to prevent.
 *
 * ── 4. WHY THE REVERSAL GUARD RUNS HERE AND NOWHERE EARLIER ───────────────
 * assertReversible (via acceptInternalReturnLine) runs inside this transaction.
 * Not at raise, not at HOD approval. The department may legitimately have
 * cooked the goods while the ticket waited, and the balance AT ACCEPT is the
 * only authoritative one. Two pending tickets for the same material can both
 * look feasible when they are raised; the first accept succeeds and the second
 * correctly 409s with the operator-readable message, its status rolled back to
 * 'hod_approved' so somebody can fix the count and try again.
 *
 * body: {
 *   note?: string,                       header-level store note
 *   items: [{
 *     id: string,                        material_return_items.id — every line must appear
 *     rejected?: boolean,                true = reject this line, moves nothing
 *     reject_reason?: string,            MANDATORY when rejected (req 74)
 *     accepted_qty?: number,             in the LINE's unit; defaults to the full line quantity
 *     disposition?: 'reusable'|'wastage'|'disposal',   internal lines only (req 78)
 *     note?: string
 *   }]
 * }
 */
export const dynamic = 'force-dynamic';

/** Same tolerance and the same 6dp rounding as dept-ledger.ts, return-stock.ts
 *  and issue-stock.ts, so a figure that passes a bound here cannot fail it two
 *  calls deeper in the 15th decimal. */
const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * A refusal raised inside the transaction so that better-sqlite3 rolls the
 * status claim back with it. `httpStatus` carries the answer the operator
 * should get: 400 for "your request is wrong", 409 for "the stock says no".
 * Without this, an operator-answerable refusal would surface as a 500 and read
 * like a crash.
 */
class VerifyRefused extends Error {
  readonly httpStatus: number;
  readonly currentStatus?: string;
  constructor(message: string, httpStatus = 400, currentStatus?: string) {
    super(message);
    this.name = 'VerifyRefused';
    this.httpStatus = httpStatus;
    this.currentStatus = currentStatus;
  }
}

interface DecisionInput {
  id: string;
  rejected: boolean;
  rejectReason: string;
  acceptedQty: number | null;
  disposition: ReturnDisposition | null;
  note: string;
}

interface LineRow {
  id: string;
  material_id: string;
  quantity: number;
  unit: string | null;
  pack_factor: number;
  recipe_qty: number;
  disposition: ReturnDisposition;
  material_name?: string | null;
}

/** Only the header columns this route actually reads. The ticket carries far
 *  more, but naming what is used keeps the kind fork honest — `kind` is read
 *  from the row and never from the request. */
interface ReturnHeaderRow {
  id: string;
  ret_number: string;
  kind: string;
  status: string;
  department_id: string | null;
  grn_id: string | null;
  outlet_id: string | null;
  /** Email of whoever raised the ticket. Read by the separation-of-duties check
   *  below — the raiser may not also be the one who accepts the goods. The row
   *  is fetched with SELECT *, so the column was always present; only this
   *  declaration was missing. */
  drafted_by: string | null;
}

/** The request as it arrives — every field `unknown` until it is checked, so a
 *  hostile or merely stale screen cannot smuggle a type past the validation. */
interface RawDecision {
  id?: unknown;
  rejected?: unknown;
  reject_reason?: unknown;
  reason?: unknown;
  accepted_qty?: unknown;
  disposition?: unknown;
  note?: unknown;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();

    const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as ReturnHeaderRow | undefined;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    // THE STORE, AND ONLY THE STORE. canIssueAsStore is `!!is_store_manager`
    // with DELIBERATELY NO ADMIN BYPASS, and that is copied on purpose from the
    // issue side (auth.ts:165): taking goods back over the counter is a
    // physical act, and an admin accepting a return from a desk is signing for
    // a sack of onions nobody looked at. An admin who genuinely mans the store
    // can grant themselves the flag; they cannot shortcut it from here.
    //
    // Note this is a STRICTER gate than the HOD step above it (canApproveAsChef)
    // — different act, different person, by design.
    if (!canIssueAsStore(me)) {
      return Response.json(
        { error: 'Only the store manager can verify a return — accepting goods at the counter is a physical handover.' },
        { status: 403 },
      );
    }

    // SEPARATION OF DUTIES: THE PERSON WHO RAISED IT CANNOT BE THE ONE WHO
    // ACCEPTS IT. This is the single step that writes stock, and until now
    // nothing anywhere compared the actor to any earlier actor — so one account
    // holding admin + is_head_chef + is_store_manager could raise, approve and
    // accept a cross-department stock movement alone, with no second pair of
    // eyes at any point. Two live accounts hold exactly that combination.
    //
    // NO ADMIN BYPASS, deliberately, and this is the whole reason the control
    // works: both of those accounts ARE admins, so an admin override would
    // excuse precisely the two people it exists to check and leave the rule
    // decorative. It also matches canIssueAsStore itself, which already refuses
    // admins-without-the-flag on the same reasoning — accepting goods is a
    // physical act, not a desk permission.
    //
    // The cost is real and accepted: if you raised it, someone else must accept
    // it. Returns are not time-critical the way a bill is — the goods sit on the
    // counter until the next store person is on — so the error names who can,
    // rather than leaving a dead end.
    if (String(r.drafted_by || '').trim().toLowerCase() === String(me.email || '').trim().toLowerCase()) {
      const others = db.prepare(
        `SELECT name FROM users
          WHERE is_active = 1 AND is_store_manager = 1 AND lower(email) <> lower(?)
          ORDER BY name`,
      ).all(String(me.email || '')) as { name: string }[];
      const who = others.length
        ? others.map((u) => u.name).join(', ')
        : 'nobody else currently holds the store role — ask an admin to assign it';
      return Response.json({
        error: `You raised this return, so you cannot also accept it. Accepting is the step that moves stock, and it needs a second person: ${who}.`,
        needs_second_person: true,
      }, { status: 403 });
    }

    // Friendly pre-check. NOT the guard: the authoritative one is the
    // single-shot claim inside the transaction below, which is what makes a
    // concurrent double-verify safe. This one only exists so the common case
    // ("someone already verified it") reads as a sentence instead of a race.
    if (r.status !== 'hod_approved') {
      return Response.json(
        { error: `Only a Department-Head-approved return can be verified by the store (current: ${r.status})` },
        { status: 400 },
      );
    }

    const kind: string = String(r.kind || '');
    if (kind !== 'internal' && kind !== 'vendor') {
      return Response.json({ error: `Return ${r.ret_number} has an unknown kind '${kind}'` }, { status: 400 });
    }
    // An internal ticket without a department has no department to debit, and
    // crediting central without debiting anybody is how inventory gets invented.
    // Creation refuses this; this is the backstop, and it refuses rather than
    // guessing a department.
    const departmentId: string = String(r.department_id || '').trim();
    if (kind === 'internal' && !departmentId) {
      return Response.json(
        { error: `Return ${r.ret_number} is an internal return with no department — it cannot be accepted.` },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => ({})) as { note?: unknown; items?: unknown };
    const headerNote: string = typeof body?.note === 'string' ? body.note.trim() : '';
    const rawItems: RawDecision[] = Array.isArray(body?.items) ? (body.items as RawDecision[]) : [];
    if (rawItems.length === 0) {
      return Response.json(
        { error: 'Verify needs a decision for every line — send items: [{ id, rejected? , reject_reason?, accepted_qty? }]' },
        { status: 400 },
      );
    }

    // Body shape only. Everything that has to be true about the LINES is
    // checked inside the transaction against the lines as they are at commit
    // time, not against a copy read a moment earlier.
    const decisions = new Map<string, DecisionInput>();
    for (const raw of rawItems) {
      const lineId = String(raw?.id || '').trim();
      if (!lineId) return Response.json({ error: 'Every item needs an id (material_return_items.id)' }, { status: 400 });
      if (decisions.has(lineId)) {
        // Two decisions for one line is not a merge problem, it is a screen bug.
        // Picking one silently is how a line gets accepted when the store meant
        // to reject it.
        return Response.json({ error: `Line ${lineId} appears twice in the request` }, { status: 400 });
      }
      const dispRaw = raw?.disposition;
      if (dispRaw != null && dispRaw !== '' && !isReturnDisposition(dispRaw)) {
        return Response.json(
          { error: `Unknown disposition '${String(dispRaw)}' — expected reusable, wastage or disposal` },
          { status: 400 },
        );
      }
      decisions.set(lineId, {
        id: lineId,
        rejected: raw?.rejected === true,
        rejectReason: typeof raw?.reject_reason === 'string'
          ? raw.reject_reason.trim()
          : (typeof raw?.reason === 'string' ? raw.reason.trim() : ''),
        acceptedQty: raw?.accepted_qty == null || raw.accepted_qty === ''
          ? null
          : Number(raw.accepted_qty),
        disposition: isReturnDisposition(dispRaw) ? dispRaw : null,
        note: typeof raw?.note === 'string' ? raw.note.trim() : '',
      });
    }

    const setRejected = db.prepare(`
      UPDATE material_return_items
      SET store_rejected = 1, store_reject_reason = ?,
          accepted_qty = 0, accepted_recipe_qty = 0,
          dept_txn_id = NULL, inv_txn_id = NULL,
          notes = CASE WHEN ? = '' THEN notes ELSE ? END
      WHERE id = ?
    `);
    const setAccepted = db.prepare(`
      UPDATE material_return_items
      SET store_rejected = 0, store_reject_reason = '',
          accepted_qty = ?, accepted_recipe_qty = ?,
          disposition = ?, dept_txn_id = ?, inv_txn_id = ?,
          notes = CASE WHEN ? = '' THEN notes ELSE ? END
      WHERE id = ?
    `);

    type LineResult = {
      id: string;
      material_id: string;
      material_name: string;
      accepted: boolean;
      accepted_qty: number;
      accepted_recipe_qty: number;
      unit: string;
      disposition: ReturnDisposition;
      central_delta: number;
      dept_txn_id: string | null;
      inv_txn_id: string | null;
      reject_reason: string;
    };

    const txn = db.transaction((): { results: LineResult[]; accepted: number; rejected: number; centralDelta: number } => {
      // ── THE CLAIM. FIRST STATEMENT, BEFORE A SINGLE GRAM MOVES. ──────────
      // The status is the idempotency token. Two verifies racing each other
      // both reach here; exactly one finds the row at 'hod_approved' and gets
      // changes === 1. The loser moves nothing, because nothing below runs.
      // Do NOT "optimise" this by trusting the status read outside the
      // transaction — that read is a snapshot, this is a claim.
      const claim = db.prepare(`
        UPDATE material_returns
        SET status = 'verified',
            store_verified_at = datetime('now'),
            store_verified_by = ?,
            store_note = ?,
            updated_at = datetime('now')
        WHERE id = ? AND status = 'hod_approved'
      `).run(me.email, headerNote, id);
      if (claim.changes !== 1) {
        const now = db.prepare('SELECT status FROM material_returns WHERE id = ?').get(id) as { status?: string } | undefined;
        throw new VerifyRefused(
          `Only a Department-Head-approved return can be verified by the store (current: ${now?.status ?? 'unknown'})`,
          400,
          String(now?.status ?? 'unknown'),
        );
      }

      // Read the lines AFTER the claim, inside the transaction: these are the
      // lines the decisions are applied to, and nothing can edit them under us
      // now that the ticket is no longer at 'hod_approved'.
      const lines = db.prepare(`
        SELECT i.id, i.material_id, i.quantity, i.unit, i.pack_factor, i.recipe_qty, i.disposition,
               m.name AS material_name
        FROM material_return_items i
        LEFT JOIN raw_materials m ON m.id = i.material_id
        WHERE i.return_id = ?
        ORDER BY i.created_at, i.id
      `).all(id) as LineRow[];

      if (lines.length === 0) {
        throw new VerifyRefused('This return has no items to verify', 400);
      }

      // Every line needs a decision, and no decision may name a line that is
      // not on this ticket. An omitted line would end up neither accepted nor
      // rejected on a TERMINAL ticket — goods with no answer and no way back.
      const lineIds = new Set(lines.map((l) => l.id));
      for (const d of decisions.keys()) {
        if (!lineIds.has(d)) throw new VerifyRefused(`Line ${d} does not belong to return ${r.ret_number}`, 400);
      }
      const missing = lines.filter((l) => !decisions.has(l.id));
      if (missing.length > 0) {
        throw new VerifyRefused(
          `Every line must be accepted or rejected — ${missing.length} line(s) have no decision`,
          400,
        );
      }

      const results: LineResult[] = [];
      let acceptedCount = 0;
      let rejectedCount = 0;
      let centralDelta = 0;

      for (const line of lines) {
        const d = decisions.get(line.id)!;
        const name = String(line.material_name || '') || line.material_id;
        const lineUnit = String(line.unit || '').trim();

        // ── REJECT. Requirement 74's "with a mandatory reason". ───────────
        // Nothing moves. Not a gram, not a write-off, not a partial. The flag
        // and the reason are set TOGETHER (never half-set), and the movement
        // receipts are cleared so no reader can mistake a rejected line for one
        // that moved.
        if (d.rejected) {
          if (!d.rejectReason) {
            throw new VerifyRefused(`Rejecting ${name} needs a reason — requirement 74 makes it mandatory`, 400);
          }
          setRejected.run(d.rejectReason, d.note, d.note, line.id);
          rejectedCount++;
          results.push({
            id: line.id, material_id: line.material_id, material_name: name,
            accepted: false, accepted_qty: 0, accepted_recipe_qty: 0, unit: lineUnit,
            disposition: line.disposition, central_delta: 0,
            dept_txn_id: null, inv_txn_id: null, reject_reason: d.rejectReason,
          });
          continue;
        }

        // ── ACCEPT. ──────────────────────────────────────────────────────
        // Default is the full line quantity, so a screen that only offers
        // Accept / Reject (which is literally what requirement 74 asks for)
        // never has to send a number.
        const lineQty = r6(Number(line.quantity) || 0);
        const acceptedQty = r6(d.acceptedQty == null ? lineQty : Number(d.acceptedQty));

        if (!Number.isFinite(acceptedQty) || acceptedQty <= EPS) {
          throw new VerifyRefused(
            `Accepted quantity for ${name} must be greater than zero — to take nothing, reject the line with a reason`,
            400,
          );
        }
        // REFUSE, NEVER CLAMP. Accepting more than the department or the vendor
        // ticket declared is not a rounding problem, it is a different quantity
        // of goods than anybody approved.
        if (acceptedQty > lineQty + EPS) {
          throw new VerifyRefused(
            `Cannot accept ${acceptedQty} ${lineUnit || ''} of ${name}: the return only claims ${lineQty}`.replace(/\s+/g, ' '),
            400,
          );
        }
        // A SHORT ACCEPT MUST BE EXPLAINED. The difference is stock the ticket
        // said was coming back and the store did not take, and an unexplained
        // shortfall on the return report (req 79) is exactly the unlabelled
        // stock movement the report exists to prevent.
        if (acceptedQty < lineQty - EPS && !d.note && !headerNote) {
          throw new VerifyRefused(
            `Accepting only ${acceptedQty} of ${lineQty} ${lineUnit || ''} for ${name} needs a note explaining the shortfall`.replace(/\s+/g, ' '),
            400,
          );
        }

        // ── THE ONE CONVERSION, FROM THE FACTOR THE LINE WAS RAISED WITH ──
        // pack_factor was snapshotted onto the line at creation by
        // resolveLineUnits, which carries the both-halves guard
        // (pack_size > 1 AND unit !== purchase_unit) — so PICKLED GINGER 1.5KG
        // rode in at 1 and rides out at 1. Re-deriving it here would value the
        // movement with whatever pack_size says today rather than what the
        // ticket was approved against.
        //
        // A missing or non-positive factor is REFUSED, not defaulted to 1.
        // Defaulting is the 750x class of error: on a packed material it would
        // move grams where the operator typed kilos.
        const packFactor = Number(line.pack_factor);
        if (!Number.isFinite(packFactor) || packFactor <= 0) {
          throw new VerifyRefused(
            `Line for ${name} has no usable pack factor — it cannot be converted to recipe units and will not be moved`,
            400,
          );
        }
        const recipeQty = r6(acceptedQty * packFactor);
        if (!(recipeQty > EPS)) {
          throw new VerifyRefused(`Accepted quantity for ${name} converts to zero recipe units`, 400);
        }

        // Requirement 78: the STORE is the one who inspects, so the store may
        // overrule the disposition the department claimed when it raised the
        // ticket. Internal only — on a vendor return the goods leave the
        // building whatever state they are in, and a write-off disposition
        // there would describe a movement that is not happening.
        let disposition: ReturnDisposition = line.disposition;
        if (d.disposition) {
          if (kind === 'vendor' && d.disposition !== 'reusable') {
            throw new VerifyRefused(
              `A vendor return cannot be marked ${d.disposition} — the goods go back to the supplier, they are not written off here`,
              400,
            );
          }
          disposition = d.disposition;
        }

        // ── THE FORK. Structural, on the header's IMMUTABLE kind. ────────
        // internal -> department DOWN, central UP (or, on a write-off,
        //             department DOWN and central untouched — unusable goods
        //             never re-enter the sellable pool).
        // vendor   -> central DOWN, no department leg at all.
        // Two separately named functions, so there is no single call site that
        // could take the wrong side on a bad flag. Neither opens a transaction;
        // both refuse to run outside this one.
        let move: ReturnMoveResult;
        if (kind === 'internal') {
          move = acceptInternalReturnLine(db, {
            departmentId,
            materialId: line.material_id,
            recipeQty,
            disposition,
            returnItemId: line.id,
            returnId: id,
            retNumber: r.ret_number,
            outletId: r.outlet_id || null,
            actor: me.email,
            notes: d.note || '',
          });
        } else {
          move = acceptVendorReturnLine(db, {
            materialId: line.material_id,
            recipeQty,
            returnItemId: line.id,
            returnId: id,
            // The ticket's GRN anchor, which is how the mover finds the
            // stamped direct-issue cost rows and reverses the rail the goods
            // ACTUALLY arrived on: a direct-routed line debits the receiving
            // DEPARTMENT's ledger (central never held it, centralDelta 0);
            // everything else debits central exactly as before.
            grnId: r.grn_id || null,
            retNumber: r.ret_number,
            outletId: r.outlet_id || null,
            actor: me.email,
            notes: d.note || '',
          });
        }

        // THE RECEIPTS, written back on the same line in the same transaction.
        // A verified line carrying a quantity and a NULL receipt is then a
        // DETECTABLE integrity fault rather than a silent zero-credit — the
        // failure mode that makes applyIssueDelta unusable for this rail.
        setAccepted.run(
          acceptedQty,
          move.recipeQty,
          move.disposition,
          move.deptTxnId,
          move.invTxnId,
          d.note,
          d.note,
          line.id,
        );

        acceptedCount++;
        centralDelta = r6(centralDelta + move.centralDelta);
        results.push({
          id: line.id, material_id: line.material_id, material_name: name,
          accepted: true, accepted_qty: acceptedQty, accepted_recipe_qty: move.recipeQty,
          unit: lineUnit, disposition: move.disposition, central_delta: move.centralDelta,
          dept_txn_id: move.deptTxnId, inv_txn_id: move.invTxnId, reject_reason: '',
        });
      }

      // A ticket where the store rejected EVERY line is a rejected ticket, and
      // the header carries columns that say so. This is DERIVED from the lines,
      // not a second verb: the status is still 'verified' because verification
      // is what happened, and no stock moved because no line was accepted.
      if (acceptedCount === 0 && rejectedCount > 0) {
        const summary = headerNote || results.map((x) => x.reject_reason).find(Boolean) || 'All lines rejected by store';
        db.prepare(`
          UPDATE material_returns
          SET store_rejected_at = datetime('now'), store_rejected_by = ?, store_rejected_reason = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(me.email, summary, id);
      }

      return { results, accepted: acceptedCount, rejected: rejectedCount, centralDelta };
    });

    const out = txn();

    // Audit AFTER the commit and in a try/catch: the movement is the thing that
    // must not fail, and a broken audit insert must never undo a physical
    // handover that already happened at the counter.
    try {
      logAuditEvent(db, {
        event_type: 'return.store_verify',
        entity_type: 'return_ticket',
        entity_id: id,
        actor_email: me.email,
        outlet_id: r.outlet_id || null,
        before: { status: 'hod_approved' },
        after: {
          status: 'verified',
          ret_number: r.ret_number,
          kind,
          department_id: r.department_id || null,
          grn_id: r.grn_id || null,
          accepted_lines: out.accepted,
          rejected_lines: out.rejected,
          central_delta_recipe_units: out.centralDelta,
          stock_moved: out.accepted > 0,
          lines: out.results,
          note: headerNote,
        },
        note: headerNote,
      });
    } catch { /* audit must never break the action */ }

    return Response.json({
      success: true,
      status: 'verified',
      kind,
      accepted_lines: out.accepted,
      rejected_lines: out.rejected,
      /** Signed RECIPE-unit change to central stock across the whole ticket:
       *  POSITIVE for an internal return (goods came back in), NEGATIVE for a
       *  vendor return (goods went out), 0 when everything was rejected or
       *  written off — and 0 for a vendor line received under DIRECT ISSUE,
       *  whose goods central never held (the department ledger is debited
       *  instead; see the per-line dept_txn_id). There is deliberately no
       *  unsigned "total returned". */
      central_delta_recipe_units: out.centralDelta,
      items: out.results,
    });
  } catch (e: unknown) {
    // A refused verify is an operator-answerable 400/409, not a 500: the
    // transaction rolled back on the throw, so the ticket is still at
    // 'hod_approved' and nothing moved. Same shape as the party reconcile
    // route, so the two rails fail the same way.
    if (e instanceof VerifyRefused) {
      console.warn('[return store-verify] refused:', e.message);
      return Response.json({ error: e.message, current_status: e.currentStatus }, { status: e.httpStatus });
    }
    if (isDeptReversalBlocked(e)) {
      console.warn('[return store-verify] blocked:', e.message);
      return Response.json({
        error: e.message,
        code: e.code,
        details: {
          material_id: e.materialId, material_name: e.materialName,
          department_id: e.departmentId, department_name: e.departmentName,
          requested: e.requested, available: e.available, consumed_since: e.consumedSince,
        },
      }, { status: 409 });
    }
    if (isReturnStockRefused(e)) {
      console.warn('[return store-verify] refused by stock:', e.message);
      return Response.json({
        error: e.message,
        code: e.code,
        details: {
          material_id: e.materialId, material_name: e.materialName,
          requested: e.requested, available: e.available,
        },
      }, { status: 409 });
    }
    const err = e as { message?: string };
    console.error('[return store-verify]', e);
    return Response.json({ error: err?.message || 'Store verification failed' }, { status: 500 });
  }
}
