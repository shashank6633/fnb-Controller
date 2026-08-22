import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from './db';
import { GrnRefused, logAuditOrThrow, r6 } from './grn-reversal';

/* ══════════════════════════════════════════════════════════════════════════
 * THE PO → REQUISITION FULFIL CASCADE, IN ONE PLACE.
 *
 * SERVER ONLY. Call INSIDE the caller's db.transaction(): it writes
 * requisitions, raw_materials.current_stock and inventory_transactions, and
 * those must commit or roll back with the decision that triggered them.
 *
 * ── WHY IT MOVED HERE ──────────────────────────────────────────────────────
 * It used to live inline at the end of POST /api/purchase-orders/[id]/receive,
 * gated on `po.requisition_id && isComplete`. The kitchen QC gate broke that
 * single trigger in two: a PO can now be COMPLETE on the receipt ledger (every
 * line has a GRN row) while its goods are still sitting in 'awaiting_qc' and no
 * stock has been credited. Firing the party branch there would DEDUCT stock
 * that was never added — taking the goods out of some other receipt's balance.
 *
 * So the cascade now fires from whichever of the two places is LAST:
 *   · POST …/receive          — when the PO completes and NO GRN of it is held
 *   · decideGrnQc (grn-qc.ts) — when a sign-off clears the LAST held GRN of a
 *                               complete PO
 * One helper, two callers, one behaviour. Copying it would have been two
 * behaviours the day one of them was edited.
 *
 * ── THE BODY IS UNCHANGED ──────────────────────────────────────────────────
 * Lifted verbatim from receive/route.ts. Only three names were rewritten —
 * po.requisition_id → requisitionId, po.outlet_id → poOutletId,
 * receivedByEmail → actorEmail. Every comment, every guard, the effective-qty
 * rule, the pack factor and the average_price basis are exactly as they were;
 * they are load-bearing and are documented in place below.
 *
 * ── IT IS ITS OWN REPLAY GUARD ─────────────────────────────────────────────
 * Two guards, both pre-existing:
 *   · the requisitions UPDATE is `WHERE … AND status = 'store_processed'`, so a
 *     second call moves nothing, and `willFulfill` is read BEFORE it — a second
 *     caller sees 'fulfilled', not 'store_processed', and skips the party
 *     branch entirely;
 *   · the party branch additionally probes inventory_transactions for an
 *     existing 'party_consumption' row on this requisition and logs a skip.
 * Do not add a third; these two already make the double-call safe, which is
 * exactly what two callers require.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface RequisitionCascadeInput {
  requisitionId: string;
  /** The PO's outlet — the fallback stamp when the requisition has none. */
  poOutletId: string | null;
  /** Who is credited in the audit trail: the receiver, or the QC signer. */
  actorEmail: string;
}

export function fulfilRequisitionFromPo(
  db: Database.Database,
  { requisitionId, poOutletId, actorEmail }: RequisitionCascadeInput,
): void {
  if (!requisitionId) return;
  const reqRow = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(requisitionId) as any;
  const willFulfill = reqRow && reqRow.status === 'store_processed';
  db.prepare(`
    UPDATE requisitions
    SET status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'store_processed'
  `).run('po-received-cascade', requisitionId);

  // Party requisition fulfilled via PO-receive cascade — deduct now.
  // (Internal requisitions remain audit-only and never enter this branch.)
  if (willFulfill && reqRow.purpose === 'party') {
    const already = db.prepare(`
      SELECT 1 FROM inventory_transactions
      WHERE reference_id = ? AND type = 'party_consumption'
      LIMIT 1
    `).get(requisitionId);
    if (already) {
      logAuditEvent(db, {
        event_type: 'requisition.party_consumption.skipped',
        entity_type: 'requisition',
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { reason: 'already_deducted' },
        note: 'Party consumption skipped — inventory_transactions row already exists',
      });
    } else {
      const reqItems = db.prepare(`
        -- No last_purchase_price here on purpose. That column is stored in
        -- MIXED bases (some rows ₹/purchase-unit, some already ₹/recipe-unit),
        -- so it cannot be normalised by any formula. average_price is the
        -- sanctioned single-basis rate — see src/lib/closing-valuation.ts and
        -- src/app/api/department-variance/route.ts:620-622.
        SELECT ri.*, rm.name AS material_name, rm.average_price,
               rm.unit AS rm_unit, rm.purchase_unit AS rm_purchase_unit,
               COALESCE(rm.pack_size, 1) AS rm_pack_size
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.req_id = ?
          -- A line the chef or the store REFUSED never leaves the store, so
          -- it can never be consumed. Without this filter a rejected line
          -- still carried its quantity_requested into the fallback below.
          AND COALESCE(ri.is_rejected, 0) = 0
          AND COALESCE(ri.store_rejected, 0) = 0
      `).all(requisitionId) as any[];
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
      const partyOutletId = reqRow.outlet_id || poOutletId || null;
      const partyNote = `Party: ${reqRow.event_name || '(unnamed)'} @ ${reqRow.event_date || ''}`.trim();
      const auditItems: any[] = [];
      let totalCost = 0;
      for (const it of reqItems) {
        /* EFFECTIVE QTY — the house rule (store-issue/route.ts, dept-stock,
           party-approvals): what the chef APPROVED, falling back to what was
           requested only when no approval was recorded. The old fallback was
           raw quantity_requested, so a line the chef trimmed 10 → 4, or
           rejected outright, still deducted 10 — and once the pack factor
           below was applied that became 7,500 ml of a material nobody
           released. Cap at the approved figure and this cannot recur. */
        const effApproved = (it.chef_approved_qty != null
          ? Number(it.chef_approved_qty)
          : Number(it.quantity_requested)) || 0;
        const issuedReq = Math.min(Number(it.quantity_issued) || effApproved, effApproved);
        if (issuedReq <= 0) continue;
        // ri.unit → RECIPE units. Requisition quantities are stored in the
        // LINE's OWN unit (option B), so a "2 BTL" line is TWO BOTTLES —
        // deducting it verbatim took 2 ml off stock instead of 1,500 ml
        // and wrote a −2 party_consumption row. Same pack-factor CASE as
        // src/lib/party-fulfillment.ts and the department-consumption SQL;
        // keep the three byte-equivalent.
        const rPack = Number(it.rm_pack_size) || 1;
        const reqPackFactor =
          (String(it.unit ?? '').trim() !== '' &&
           it.unit === it.rm_purchase_unit &&
           it.unit !== it.rm_unit &&
           rPack > 1)
            ? rPack : 1;
        const issued = issuedReq * reqPackFactor;   // RECIPE units
        decStock.run(issued, it.material_id);
        insPartyTx.run(generateId(), it.material_id, -issued, requisitionId, partyNote, partyOutletId);
        /* BOTH SIDES OF THIS MULTIPLICATION ARE ON THE RECIPE BASIS.
           LEFT  — `issued` is RECIPE units (ml/g): issuedReq is in the LINE's
                   own unit and reqPackFactor above lifted a purchase-unit
                   line into recipe units.
           RIGHT — raw_materials.average_price is ₹ per RECIPE unit by canon,
                   so it needs NO pack conversion. Dividing it by rPack, or
                   multiplying it up, would break the trio.
           It used to read last_purchase_price / rPack here. That column is
           stored in MIXED bases: of the 190 packed materials that hold both a
           stored LPP and a purchase history, 71 are ALREADY ₹/recipe-unit, so
           the divide fired a second time — MALA STRAWBERRY CRUSH 5 LTR
           (ml/BTL, pack 5000, avg ₹0.13482/ml) logged ₹0.13 for a full bottle
           instead of ₹674.10, and `lppRecipe || average_price` short-circuited
           on that non-zero wrong value so the correct rate on the same row was
           never reached. average_price is the sanctioned rate for a
           recipe-unit quantity (src/lib/closing-valuation.ts ladder). */
        const unitCost = Number(it.average_price) || 0;   // ₹ / RECIPE unit
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
        entity_id: requisitionId,
        actor_email: actorEmail,
        after: { items: auditItems, total_cost: Math.round(totalCost * 100) / 100 },
        note: partyNote,
      });
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE INVERSE — WHEN THE RECEIPT THAT FIRED THE CASCADE IS VOIDED.
 *
 * It lives in THIS file, directly under the forward, for the same reason the
 * forward was extracted: two triggers, one behaviour. A reversal written in the
 * void's own route would be a second reading of what the cascade did, and the
 * day someone changes the effective-qty rule or the pack factor above, only one
 * of the two would learn about it.
 *
 * WHAT THE FORWARD DID, AND SO WHAT THIS UNDOES:
 *   1. requisitions: store_processed → fulfilled, stamping fulfilled_at and
 *      fulfilled_by = 'po-received-cascade'.
 *   2. purpose='party' ONLY: per non-rejected line, current_stock -= issued and
 *      an inventory_transactions row (type 'party_consumption', quantity
 *      = −issued, reference_id = the requisition).
 *
 * ── THE PROVENANCE TRAP, WHICH IS THE REAL HAZARD HERE ────────────────────
 * TWO writers produce an IDENTICALLY SHAPED party_consumption row keyed on the
 * same reference_id: this cascade, and applyPartyFulfillment()
 * (src/lib/party-fulfillment.ts, called from store-issue and store-process).
 * Same type, same reference_id, same negative quantity, same
 * `Party: <event> @ <date>` note. NOTHING ON THE ROW SAYS WHICH RAIL WROTE IT,
 * and deleting blindly would credit back stock this PO never caused to move.
 *
 * So three discriminators are read before a single row is touched, and where
 * they cannot agree the void is REFUSED:
 *   · requisitions.fulfilled_by = 'po-received-cascade' — that literal is
 *     written nowhere else in the codebase; it is this cascade's signature. It
 *     proves the cascade FULFILLED the requisition. It does NOT prove the
 *     cascade DEDUCTED anything: see the third one.
 *   · NO department_material_transactions row of type 'received' carrying this
 *     requisition as reference_id. applyPartyFulfillment credits the department
 *     alongside the store deduction (party-fulfillment.ts:126-138); this cascade
 *     writes NEITHER. A dept 'received' row is therefore positive proof the
 *     other rail ran. It is NOT proof of the converse — that write is guarded
 *     `if (deptId)`, so its absence proves nothing.
 *   · THE CASCADE'S OWN AUDIT ROW, which is the only positive evidence of what
 *     the forward actually did. See cascadeDeductionWitness below. The forward
 *     stamps its signature UNCONDITIONALLY and only then checks whether party
 *     rows already exist (:61-75); when they do it deducts NOTHING and writes
 *     'requisition.party_consumption.skipped'. Without reading that, a signature
 *     over another rail's party rows looked exactly like our own deduction —
 *     which meant a reachable void was refused for ever as "both rails" (a dead
 *     end for the very correction this feature exists to provide), and, one
 *     falsy department_id away, a credit for goods this receipt never moved.
 *

 * ── AND IT REVERSES BY THE RECORDED QUANTITY, NEVER A RECOMPUTE ───────────
 * Exactly the doctrine reverseGrnMovement follows: credit back ABS(the stored
 * inventory_transactions.quantity). Recomputing issued × pack factor would
 * subtract a different number than was added the moment pack_size is edited —
 * and pack_size is mutable, which is the whole reason the unit-audit lock
 * exists.
 *
 * ── THE REPLAY GUARDS ARE THE FORWARD'S, MIRRORED — NOT NEW ONES ──────────
 *   · the demotion is `WHERE id = ? AND status = 'fulfilled' AND fulfilled_by =
 *     'po-received-cascade'`, so a second call moves nothing, and `willUnfulfil`
 *     is read BEFORE it exactly as `willFulfill` is above;
 *   · the party branch acts only on rows that are actually THERE, which is the
 *     same probe the forward uses to decide it has already run.
 * A double void cannot credit twice — and cannot even reach here, because the
 * GRN void's own conditional claim refuses the second call first.
 * ══════════════════════════════════════════════════════════════════════════ */

/** WHERE THE PARTY DEDUCTION CAME FROM. The forward stamps this literal and
 *  nothing else in the codebase writes it. */
export const PO_CASCADE_ACTOR = 'po-received-cascade';

/** What the forward's own audit trail says it did on this requisition.
 *  'deducted' — it wrote the party movements; 'skipped' — it wrote none because
 *  another rail had already booked them; 'unknown' — no audit row either way
 *  (a pre-audit row, or an insert that was swallowed), in which case the two
 *  older discriminators decide, exactly as they did before. */
type CascadeWitness = 'deducted' | 'skipped' | 'unknown';

export interface RequisitionUndoPlan {
  requisition_id: string;
  purpose: string;
  /** true iff this void will demote the requisition back to 'store_processed'. */
  willUnfulfil: boolean;
  /** true iff it will ALSO delete the party movements and credit their stock
   *  back. FALSE with willUnfulfil TRUE is a real and correct outcome: the
   *  cascade fulfilled the requisition but deducted nothing, so only the
   *  fulfilment is undone. */
  reverseParty: boolean;
  /** The party_consumption rows about to be deleted — verbatim, the only copy.
   *  EMPTY when reverseParty is false, even where rows exist on the ledger. */
  partyRows: any[];
  /** Party movements deliberately LEFT STANDING because another rail booked
   *  them. Reported so the response never implies this void examined nothing. */
  partyRowsLeftIntact: number;
  /** What the forward's audit trail says it did — carried for the audit row. */
  witness: CascadeWitness;
  /** material_id → RECIPE units this reversal will CREDIT BACK.
   *  Feed it to assertNoNegativeStock as `replacement`: the receipt reversal
   *  debits and this credits, and the guard's whole job is the NET of the two. */
  credit: Map<string, number>;
  /** Names for the messages, resolved once. */
  materialNames: Map<string, string>;
}

/**
 * DID THE FORWARD ACTUALLY DEDUCT, OR DID IT SKIP? — the discriminator the
 * signature alone cannot give.
 *
 * 'requisition.party_consumption' and 'requisition.party_consumption.skipped'
 * are written by fulfilRequisitionFromPo above and BY NOTHING ELSE in the
 * codebase (applyPartyFulfillment writes no audit event at all), so either row
 * is positive proof about this cascade in particular.
 *
 * THE MOST RECENT OF THE TWO WINS, because both can legitimately exist on one
 * requisition over its life: deduct → void (rows deleted, audit kept) → another
 * rail books its own → re-receive → the cascade now finds rows and skips. Only
 * the latest describes the state a void is about to unwind.
 *
 * A SAME-SECOND TIE READS AS 'skipped', which is the conservative direction:
 * misreading a skip as a deduction fabricates stock and destroys another rail's
 * ledger rows; misreading a deduction as a skip leaves stock understated, which
 * is visible, reversible with an adjustment, and invents nothing. (audit_events
 * has no monotonic key — its id is a random UUID — so created_at at second
 * resolution is the only ordering available.)
 *
 * NEVER THROWS. An unreadable audit table returns 'unknown', which puts the
 * decision back on the two older discriminators rather than blocking a void on
 * a reporting table.
 */
function cascadeDeductionWitness(db: Database.Database, requisitionId: string): CascadeWitness {
  try {
    const row = db.prepare(`
      SELECT event_type FROM audit_events
       WHERE entity_id = ?
         AND event_type IN ('requisition.party_consumption', 'requisition.party_consumption.skipped')
       ORDER BY created_at DESC,
                CASE event_type WHEN 'requisition.party_consumption.skipped' THEN 0 ELSE 1 END
       LIMIT 1
    `).get(requisitionId) as any;
    if (!row) return 'unknown';
    return String(row.event_type) === 'requisition.party_consumption.skipped' ? 'skipped' : 'deducted';
  } catch {
    return 'unknown';
  }
}

/**
 * PROVE IT IS OURS TO UNDO. NO WRITES — every branch either returns a plan or
 * throws GrnRefused, which the caller's transaction turns into "nothing
 * happened". Refusing is reversible; a stray stock credit is not.
 */
export function planRequisitionUndoFromPo(
  db: Database.Database,
  requisitionId: string,
  poNumber: string,
): RequisitionUndoPlan {
  const empty = (purpose = ''): RequisitionUndoPlan => ({
    requisition_id: requisitionId, purpose, willUnfulfil: false, reverseParty: false,
    partyRows: [], partyRowsLeftIntact: 0, witness: 'unknown',
    credit: new Map(), materialNames: new Map(),
  });
  if (!requisitionId) return empty();

  const req = db.prepare(`SELECT * FROM requisitions WHERE id = ?`).get(requisitionId) as any;
  if (!req) {
    throw new GrnRefused(409,
      `${poNumber} was raised to fulfil a requisition that no longer exists (${requisitionId}), so the fulfilment this receipt completed cannot be undone. Voiding the bill would leave the order reopened and the requisition unaccounted for. Investigate the requisition before voiding.`,
      { requisition_id: requisitionId }, 'requisition_missing');
  }

  const partyRows = db.prepare(`
    SELECT id, material_id, quantity, reference_id, notes, outlet_id, created_at
    FROM inventory_transactions
    WHERE reference_id = ? AND type = 'party_consumption'
  `).all(requisitionId) as any[];

  // DISCRIMINATOR 1 — the cascade's signature.
  const ours = String(req.fulfilled_by || '') === PO_CASCADE_ACTOR;
  // DISCRIMINATOR 2 — positive proof the OTHER rail ran.
  let deptWitness = false;
  try {
    deptWitness = !!db.prepare(`
      SELECT 1 FROM department_material_transactions
      WHERE reference_id = ? AND type = 'received' LIMIT 1
    `).get(requisitionId);
  } catch (e: any) {
    // Cannot read the discriminator ⇒ cannot tell the two rails apart. That is
    // a refusal, never a silent "assume it is ours".
    throw new GrnRefused(409,
      `The department ledger could not be read (${e?.message || 'unreadable'}), so it cannot be proved which rail deducted the party stock on requisition ${req.req_number || requisitionId}. Refusing rather than credit back goods this receipt never moved.`,
      { requisition_id: requisitionId }, 'party_provenance_unreadable');
  }

  if (!ours) {
    // The cascade did not fulfil this requisition — either it never fired (the
    // ordinary case: the PO is still open, or the requisition was already
    // fulfilled by the store) or another rail has since taken it over.
    if (partyRows.length > 0 && !deptWitness) {
      // Party stock IS out on this requisition, with no dept credit to name the
      // other rail and no cascade signature to name ours. Undoing it would be a
      // guess; leaving it while reopening the PO would hide a deduction this
      // delivery may well have caused.
      throw new GrnRefused(409,
        `Requisition ${req.req_number || requisitionId} has ${partyRows.length} party-consumption movement(s) that cannot be attributed: it is not marked as fulfilled by the purchase-order cascade, and no department receipt names the other rail either. Voiding ${poNumber}'s receipt would either credit back goods it never moved or silently leave a deduction it did. Settle the requisition's history first.`,
        { requisition_id: requisitionId, party_rows: partyRows.length }, 'party_unattributable');
    }
    return empty(String(req.purpose || ''));
  }

  // ── ours ──────────────────────────────────────────────────────────────────
  if (String(req.status || '') !== 'fulfilled') {
    throw new GrnRefused(409,
      `Requisition ${req.req_number || requisitionId} was fulfilled by this purchase order's receipt but has since moved to "${req.status}". Undoing the fulfilment now would overwrite whatever moved it. Void is refused; correct the requisition first.`,
      { requisition_id: requisitionId, requisition_status: String(req.status || '') }, 'requisition_moved_on');
  }

  // ── DISCRIMINATOR 3 — DID OUR CASCADE DEDUCT, OR DID IT SKIP? ─────────────
  // The signature above proves the cascade FULFILLED this requisition. It does
  // not prove the cascade DEDUCTED, because the forward stamps the signature
  // before it decides, and skips the deduction outright when party rows already
  // exist. Where the audit trail says it skipped, the party movements on this
  // requisition are ANOTHER rail's and this void's business is only the
  // fulfilment: demote the requisition, touch not one quantity.
  //
  // That turns what used to be a permanent 'party_two_rails' dead end into a
  // correct partial — and a partial is precisely what the forward performed. It
  // is not a half-apply: the reversal is exactly as wide as the action.
  const witness = cascadeDeductionWitness(db, requisitionId);
  if (witness === 'skipped') {
    return {
      requisition_id: requisitionId,
      purpose: String(req.purpose || ''),
      willUnfulfil: true,
      reverseParty: false,
      partyRows: [],
      partyRowsLeftIntact: partyRows.length,
      witness,
      credit: new Map(),
      materialNames: new Map(),
    };
  }

  // No positive proof of a skip. Either the audit says we deducted, or there is
  // no audit row at all — and in the second case the two older discriminators
  // decide exactly as they did before, which means a genuine both-rails collision
  // is still refused rather than guessed.
  if (partyRows.length > 0 && deptWitness) {
    throw new GrnRefused(409,
      `Requisition ${req.req_number || requisitionId} carries a party deduction on BOTH rails — this purchase order's cascade and a store issue that also credited the department. Reversing one of them cannot be done without knowing which movement belongs to which, and the rows are identical. Void is refused.`,
      { requisition_id: requisitionId, party_rows: partyRows.length }, 'party_two_rails');
  }

  const credit = new Map<string, number>();
  const materialNames = new Map<string, string>();
  for (const row of partyRows) {
    const qty = Number(row.quantity);
    if (!Number.isFinite(qty) || qty >= 0) {
      // The forward writes −issued and skips issued <= 0, so a zero or positive
      // row is not something this cascade wrote. Crediting ABS() of it would
      // invent stock.
      throw new GrnRefused(409,
        `A party-consumption movement on requisition ${req.req_number || requisitionId} records ${row.quantity} rather than a deduction, so the quantity to credit back is unknown. Void is refused.`,
        { requisition_id: requisitionId, transaction_id: row.id }, 'party_row_shape');
    }
    const mat = db.prepare(`SELECT id, name FROM raw_materials WHERE id = ?`).get(String(row.material_id)) as any;
    if (!mat) {
      throw new GrnRefused(409,
        `A party-consumption movement on requisition ${req.req_number || requisitionId} belongs to a material that no longer exists in the master (${row.material_id}), so its stock cannot be credited back. Void is refused.`,
        { requisition_id: requisitionId, material_id: String(row.material_id) }, 'party_material_missing');
    }
    materialNames.set(String(row.material_id), String(mat.name));
    credit.set(String(row.material_id), r6((credit.get(String(row.material_id)) || 0) + Math.abs(qty)));
  }

  return {
    requisition_id: requisitionId,
    purpose: String(req.purpose || ''),
    willUnfulfil: true,
    reverseParty: true,
    partyRows,
    partyRowsLeftIntact: 0,
    witness,
    credit,
    materialNames,
  };
}

export interface RequisitionUndoOutcome {
  requisition_id: string;
  /** true iff the requisitions row was demoted fulfilled → store_processed. */
  unfulfilled: boolean;
  party_rows_deleted: number;
  /** Movements another rail booked, deliberately left standing. */
  party_rows_left_intact: number;
  /** Credited back, RECIPE units, BY THE RECORDED QUANTITY. */
  stock_restored: Array<{ material_id: string; material_name: string; quantity: number }>;
  /** Verbatim, for the caller's audit snapshot — the only copy of the deleted rows. */
  party_rows: any[];
  requisition_before: { status: string; fulfilled_at: string | null; fulfilled_by: string | null } | null;
}

/**
 * PERFORM IT. Call INSIDE the caller's db.transaction(), with a plan that
 * planRequisitionUndoFromPo returned and after the caller's own
 * assertNoNegativeStock has already passed on the NET of debit and credit.
 */
export function reverseRequisitionFulfilFromPo(
  db: Database.Database,
  { plan, actorEmail, poNumber, grnNumber }:
    { plan: RequisitionUndoPlan; actorEmail: string; poNumber: string; grnNumber: string },
): RequisitionUndoOutcome {
  const out: RequisitionUndoOutcome = {
    requisition_id: plan.requisition_id, unfulfilled: false, party_rows_deleted: 0,
    party_rows_left_intact: plan.partyRowsLeftIntact,
    stock_restored: [], party_rows: plan.partyRows, requisition_before: null,
  };
  if (!plan.willUnfulfil) return out;

  const before = db.prepare(
    `SELECT status, fulfilled_at, fulfilled_by FROM requisitions WHERE id = ?`
  ).get(plan.requisition_id) as any;
  out.requisition_before = before
    ? { status: String(before.status ?? ''), fulfilled_at: before.fulfilled_at ?? null, fulfilled_by: before.fulfilled_by ?? null }
    : null;

  // THE DEMOTION — the mirror of the forward's conditional UPDATE, and its own
  // replay guard. fulfilled_at / fulfilled_by are CLEARED, not kept: both
  // re-fulfil paths stamp them through COALESCE (store-issue/route.ts:455-466
  // documents this), so a leftover stamp would survive the round trip and the
  // eventual re-fulfilment would report this attempt's time for ever — and
  // /requisitions renders "Fulfilled: <date>" off the column alone, whatever
  // the status says. store_processed_at/by are deliberately NOT cleared: the
  // store genuinely did process this requisition.
  const demoted = db.prepare(`
    UPDATE requisitions
    SET status = 'store_processed', fulfilled_at = NULL, fulfilled_by = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'fulfilled' AND fulfilled_by = ?
  `).run(plan.requisition_id, PO_CASCADE_ACTOR);
  if (demoted.changes === 0) {
    // The plan proved both conditions a moment ago under this same write lock,
    // so this cannot happen — and if it somehow does, the honest answer is that
    // the requisition is not in the state we are about to write about.
    throw new GrnRefused(409,
      `Requisition ${plan.requisition_id} could not be returned to the store queue — it is no longer marked as fulfilled by this purchase order. Nothing was changed.`,
      { requisition_id: plan.requisition_id }, 'requisition_moved_on');
  }
  out.unfulfilled = true;

  // GATED ON reverseParty, not on the rows existing. When the forward SKIPPED
  // its deduction the rows on this requisition belong to another rail, plan
  // carries none of them, and not one quantity is touched here.
  if (plan.reverseParty && plan.partyRows.length > 0) {
    const credit = db.prepare(
      `UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?`
    );
    for (const [materialId, qty] of plan.credit) {
      credit.run(qty, materialId);
      out.stock_restored.push({
        material_id: materialId,
        material_name: plan.materialNames.get(materialId) || materialId,
        quantity: r6(qty),
      });
    }
    out.party_rows_deleted = db.prepare(
      `DELETE FROM inventory_transactions WHERE reference_id = ? AND type = 'party_consumption'`
    ).run(plan.requisition_id).changes;
  }

  // VERIFIED, NOT BEST-EFFORT. The forward's own audit row is best-effort
  // because it destroys nothing; this one is the only copy of the movements
  // just deleted and of the fulfilment stamps just cleared.
  logAuditOrThrow(db, {
    event_type: 'requisition.po_fulfil.reversed',
    entity_type: 'requisition',
    entity_id: plan.requisition_id,
    actor_email: actorEmail,
    before: {
      requisition: out.requisition_before,
      inventory_transactions: plan.partyRows,
    },
    after: {
      status: 'store_processed',
      party_rows_deleted: out.party_rows_deleted,
      party_rows_left_intact: out.party_rows_left_intact,
      cascade_witness: plan.witness,
      stock_restored: out.stock_restored,
      voided_grn: grnNumber, purchase_order: poNumber,
    },
    note: `Requisition returned to the store queue because ${grnNumber} on ${poNumber} was voided`
      + (out.party_rows_deleted
        ? `. Reversed ${out.party_rows_deleted} party-consumption movement(s) and credited ${out.stock_restored.length} material(s) back.`
        : out.party_rows_left_intact
          // NOT "no party consumption had been booked" — some was, by a different
          // rail, and it is still standing. Saying the wrong one of those two is
          // how an admin ends up correcting stock that was never wrong.
          ? `. ${out.party_rows_left_intact} party-consumption movement(s) on this requisition were booked by a store issue, not by this purchase order, so they were left exactly as they are and no stock was credited back.`
          : '. No party consumption had been booked.'),
  }, 'the requisition reversal (this row is the only copy of the deleted party movements and the cleared fulfilment stamps)');

  return out;
}
