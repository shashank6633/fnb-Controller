import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { requisitionVisibility } from '@/lib/dept-hierarchy';
import { packFactor, dualQty, type PackMeta } from '@/lib/pack-units';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE AUDIT TIMELINE FOR ONE RETURN TICKET (requirements 72-79).           ║
 * ║ READ-ONLY. This route writes nothing, anywhere, ever.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Mirrors /api/requisitions/[id]/audit — aggregate the events on the document
 * itself plus every one of its lines, decorate them with the unit metadata a
 * reader needs to make sense of the quantities, hand back a timeline. The two
 * modules should feel like one system to the person reading the drawer.
 *
 * ── THE TWO THINGS A READER OF A RETURN AUDIT MUST KNOW ───────────────────
 *
 * 1. STOCK MOVES ONLY ON STORE ACCEPT, AND IT MOVES EXACTLY ONCE.
 *    A ticket is raised by a department (draft), submitted, approved by the
 *    Department Head, and only then reaches the store. Not one gram moves in
 *    any of those steps. The goods sit physically on the store counter while
 *    the ticket waits at `hod_approved` — that waiting IS the holding state,
 *    which is why the module has no second "returned stock" bucket. The
 *    Store's Accept (/api/returns/[id]/store-verify) is the first and last
 *    moment `raw_materials.current_stock` and
 *    `department_material_transactions` are touched, and only for the lines the
 *    store actually accepted. A REJECTED line leaves stock exactly where it
 *    was. This is why every stage below carries an explicit `moves_stock`
 *    flag rather than leaving the reader to infer it: on a document whose
 *    whole promise is "stock moves on Accept", an audit that is vague about
 *    WHICH step moved the goods is worse than no audit.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK. `material_returns.kind` is the only thing that decides which, it is
 *    set at creation and never updated:
 *
 *      kind='internal'  department -> central store. Goods STAY in the
 *                       building. Department stock DOWN, central stock UP.
 *                       (requirement 76's "added back to Store stock")
 *      kind='vendor'    central store -> out of the door, back to the supplier.
 *                       Central stock DOWN. NO department leg at all, and
 *                       emphatically no central credit — crediting central for
 *                       goods that are on a lorry back to the vendor would
 *                       invent inventory.
 *
 *    So a reader must never sum the two into one "total returned" figure, and
 *    this route deliberately does not offer one. What it offers instead is the
 *    SIGNED central delta and the actual inventory_transactions row behind it,
 *    so the direction is something you can see rather than something you trust.
 *
 * ── WHY THIS ROUTE RESOLVES THE MOVEMENT RECEIPTS ─────────────────────────
 * `material_return_items` carries dept_txn_id and inv_txn_id, written back
 * inside the accept transaction. A non-null id is the on-the-row proof that the
 * line moved and moved once. But an id is only proof if it points at something:
 * this route LOOKS EACH ONE UP and hands back the real ledger row — type,
 * signed quantity, reference_id — so the stock consequence of the accept is
 * inspectable from the ticket itself instead of requiring somebody to go
 * spelunking in two other tables. A dangling id, or an accepted line with a
 * quantity and no receipt at all, is reported as an integrity fault rather than
 * being quietly rendered as a successful return. A silent zero-credit is
 * exactly the failure mode this module was built to make impossible, so the
 * audit refuses to be the place it hides.
 *
 * GET /api/returns/[id]/audit
 */
export const dynamic = 'force-dynamic';

/**
 * WHY TWO SPELLINGS. Five of the six writers stamp entity_type 'return_ticket'
 * (submit, hod-approve, hod-reject, store-verify, cancel) but the CREATE event
 * in /api/returns POST stamps 'material_return'. Reading only one of the two
 * would silently drop a whole stage from the timeline — and the dropped stage
 * would be the raise, the one that names who started this. An audit reader is
 * the wrong place to be strict about a writer's spelling: it accepts both and
 * the divergence is reported upstream to be aligned at the writer.
 */
const HEADER_ENTITY_TYPES = ['return_ticket', 'material_return'] as const;

/**
 * No route writes a per-line audit event today — the store's per-line accept /
 * reject outcome is carried inside the store_verify header event's `after.lines`
 * array and on the material_return_items row itself. Both spellings are still
 * queried so that the day a writer starts emitting line events this reader
 * already surfaces them, in the right place in the timeline, without a change
 * here. Until then the query simply returns nothing and the per-line entries
 * below are reconstructed — each one says which of the two it came from.
 */
const ITEM_ENTITY_TYPES = ['return_ticket_item', 'material_return_item'] as const;

/**
 * The workflow spine. `moves_stock` is a property of the STAGE, not of the
 * ticket: it marks the single stage at which stock is even capable of moving.
 * Whether it actually moved on this ticket is `stock_moved` on the stage, read
 * off what the store accepted.
 */
const STAGES: Record<string, { stage: string; label: string; status: string; moves_stock: boolean }> = {
  'return.create':       { stage: 'draft',        label: 'Raised (draft)',            status: 'draft',        moves_stock: false },
  'return.submit':       { stage: 'submitted',    label: 'Submitted for approval',    status: 'submitted',    moves_stock: false },
  'return.hod_approve':  { stage: 'hod_approved', label: 'Approved by Dept Head',     status: 'hod_approved', moves_stock: false },
  'return.hod_reject':   { stage: 'hod_rejected', label: 'Rejected by Dept Head',     status: 'hod_rejected', moves_stock: false },
  'return.store_verify': { stage: 'verified',     label: 'Verified by Store',         status: 'verified',     moves_stock: true  },
  'return.cancel':       { stage: 'cancelled',    label: 'Cancelled',                 status: 'cancelled',    moves_stock: false },
};

/** Belt-and-braces cap. A return ticket has six events; this is for a pathological one. */
const MAX_EVENTS = 500;

/**
 * The audit_events columns this route selects. Spelled out rather than left as
 * a Record<string, unknown>, because the decorated event below is built by
 * spreading this row and a spread of an index signature carries no named keys
 * — the stage spine would then be reading `event_type` off a type that does not
 * admit it having one.
 */
interface AuditRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_email: string;
  before_json: string | null;
  after_json: string | null;
  note: string | null;
  created_at: string;
}

const r3 = (n: unknown) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Same visibility rule as GET /api/returns/[id], and deliberately NOT the
 * sign-in-only gate the requisition audit route uses. This timeline carries the
 * same department, quantity and vendor detail the ticket page does; gating the
 * page and leaving its audit open would just be the leak with an extra step.
 * requisitionVisibility predicates on `r.department_id` and `r.drafted_by`, so
 * the header is aliased `r` and the generated SQL fits as-is.
 */
async function visibility() {
  const me = await getCurrentUser();
  if (!me) return { sql: '0=1', params: [] as unknown[], me: null };
  const vis = requisitionVisibility(getDb(), me);
  if (!vis) return { sql: '1=1', params: [] as unknown[], me };   // null = see everything
  return { sql: vis.sql, params: vis.params as unknown[], me };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const { sql: visSql, params: visParams, me } = await visibility();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    // The header, scoped. A 404 rather than a 403 for an out-of-scope ticket,
    // matching GET /api/returns/[id] — the two must not disagree about whether
    // a ticket exists.
    const ret = db.prepare(`
      SELECT r.id, r.ret_number, r.kind, r.status, r.date,
             r.department_id, r.grn_id, r.po_id, r.outlet_id, r.drafted_by,
             d.name  AS department_name,
             g.grn_number,
             po.po_number
        FROM material_returns r
        LEFT JOIN departments         d  ON d.id  = r.department_id
        LEFT JOIN goods_receipt_notes g  ON g.id  = r.grn_id
        LEFT JOIN purchase_orders     po ON po.id = COALESCE(r.po_id, g.po_id)
       WHERE r.id = ? AND (${visSql})
    `).get(id, ...visParams) as Record<string, unknown> | undefined;
    if (!ret) return Response.json({ error: 'Return ticket not found' }, { status: 404 });

    const kind = String(ret.kind || '');
    const isVendor = kind === 'vendor';

    // ── EVENTS ────────────────────────────────────────────────────────────
    // ORDERED BY created_at THEN rowid. The tiebreaker is not decoration:
    // logAuditEvent stamps datetime('now'), which is SECOND resolution, and the
    // whole chain — raise, submit, approve, verify — can comfortably land
    // inside one second when it is driven by a script or a fast operator. On
    // created_at alone those four stages come back in arbitrary order and the
    // timeline reads as nonsense. rowid is monotonic insert order on this
    // table (audit_events is not WITHOUT ROWID), so it is the true sequence.
    //
    // Fetched ASCENDING so that if a pathological ticket ever hits the cap it
    // is the newest noise that falls off, never the raise/submit/approve spine
    // the timeline is built from. `events` is reversed to newest-first below to
    // match the requisition drawer's shape.
    const headerQ = HEADER_ENTITY_TYPES.map(() => '?').join(',');
    const itemQ   = ITEM_ENTITY_TYPES.map(() => '?').join(',');
    const events = db.prepare(`
      SELECT id, event_type, entity_type, entity_id, actor_email,
             before_json, after_json, note, created_at
        FROM audit_events
       WHERE (entity_type IN (${headerQ}) AND entity_id = ?)
          OR (entity_type IN (${itemQ}) AND entity_id IN (
                SELECT id FROM material_return_items WHERE return_id = ?
             ))
       ORDER BY created_at ASC, rowid ASC
       LIMIT ${MAX_EVENTS + 1}
    `).all(...HEADER_ENTITY_TYPES, id, ...ITEM_ENTITY_TYPES, id) as AuditRow[];

    const truncated = events.length > MAX_EVENTS;
    if (truncated) events.length = MAX_EVENTS;

    // ── LINES ─────────────────────────────────────────────────────────────
    // LEFT JOIN, not JOIN. An audit reader must never make a row disappear: if
    // a material were ever deleted out from under a historical ticket, the
    // returned quantity still happened and still moved stock, and the timeline
    // has to keep saying so. The unit metadata just comes back null.
    const lineRows = db.prepare(`
      SELECT i.id, i.material_id, i.quantity, i.unit, i.pack_factor, i.recipe_qty,
             i.reason, i.disposition, i.grn_item_id, i.po_item_id, i.req_item_id,
             i.accepted_qty, i.accepted_recipe_qty, i.store_rejected, i.store_reject_reason,
             i.dept_txn_id, i.inv_txn_id, i.notes, i.created_at,
             rm.name          AS material_name,
             rm.unit          AS material_unit,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1)                             AS material_pack_size
        FROM material_return_items i
        LEFT JOIN raw_materials rm ON rm.id = i.material_id
       WHERE i.return_id = ?
       ORDER BY i.created_at ASC, i.rowid ASC
    `).all(id) as Record<string, unknown>[];

    const metaByLine = new Map<string, PackMeta>();
    for (const l of lineRows) {
      metaByLine.set(String(l.id), {
        unit: l.material_unit as string,
        purchase_unit: l.material_purchase_unit as string,
        pack_size: l.material_pack_size as number,
      });
    }

    // ── MOVEMENT RECEIPTS ─────────────────────────────────────────────────
    // Resolved one prepared statement at a time rather than by joining onto the
    // lines: a receipt that resolves to NOTHING is the finding, and a JOIN
    // renders a dangling id and a null id identically.
    const getDeptTxn = db.prepare(`
      SELECT id, type, quantity, department_id, material_id, reference_id, notes, created_at
        FROM department_material_transactions WHERE id = ?
    `);
    const getInvTxn = db.prepare(`
      SELECT id, type, quantity, material_id, reference_id, notes, created_at
        FROM inventory_transactions WHERE id = ?
    `);

    const faults: { line_id: string; material_name: string; fault: string }[] = [];

    const lines = lineRows.map((l) => {
      const lineId = String(l.id);
      const meta = metaByLine.get(lineId) ?? { unit: '', purchase_unit: '', pack_size: 1 };
      const name = String(l.material_name || '(material removed)');
      const rejected = Number(l.store_rejected) === 1;
      const acceptedRecipe = r3(l.accepted_recipe_qty);
      const disposition = String(l.disposition || 'reusable');
      const writeOff = disposition === 'wastage' || disposition === 'disposal';

      // PURCHASE UNITS LEAD (owner rule). The line stores what the operator
      // typed (`quantity` in `unit`, normally already the purchase unit) plus
      // the SNAPSHOTTED pack_factor and the derived recipe_qty. Stock only ever
      // moved by recipe_qty, so the purchase-unit view is derived from THAT,
      // through the same dualQty layer every other screen uses — no hand-rolled
      // division here, because every hand-rolled copy in this repo has dropped
      // the second half of the both-halves guard and PICKLED GINGER 1.5KG
      // (unit kg, purchase_unit kg, pack 1.5) is the live casualty.
      const currentFactor = packFactor(meta);
      const snapshotFactor = Number(l.pack_factor) || 1;
      // The factor is snapshotted precisely so a movement can be read back with
      // the factor it was MADE with. If the material has been re-packed since,
      // the purchase-unit rendering below (which uses today's factor, like the
      // rest of the app) will not agree with the stored `quantity`. Say so
      // rather than letting the two numbers quietly contradict each other.
      const packFactorDrifted = Math.abs(currentFactor - snapshotFactor) > 1e-9;

      const deptTxnId = l.dept_txn_id ? String(l.dept_txn_id) : null;
      const invTxnId  = l.inv_txn_id  ? String(l.inv_txn_id)  : null;
      const deptTxn = deptTxnId ? (getDeptTxn.get(deptTxnId) as Record<string, unknown> | undefined) ?? null : null;
      const invTxn  = invTxnId  ? (getInvTxn.get(invTxnId)   as Record<string, unknown> | undefined) ?? null : null;

      // INTEGRITY. What counts as a missing receipt depends on the kind and the
      // disposition, and getting that wrong in either direction would make the
      // check useless — so it is spelled out rather than reduced to "id != null":
      //   internal + accepted            -> a department debit MUST exist
      //   internal + accepted + reusable -> a central credit MUST exist
      //   internal + accepted + write-off-> NO central row is CORRECT: unusable
      //                                     goods must never re-enter the pool
      //   vendor   + accepted            -> EITHER a central debit (the goods
      //                                     were on the central shelf) OR a
      //                                     department 'direct_receipt_reversal'
      //                                     (a DIRECT-ISSUE line — the goods
      //                                     were booked straight onto the
      //                                     department ledger and central never
      //                                     held them). Exactly one; both would
      //                                     take the same goods out twice, and
      //                                     neither is a movement that never
      //                                     happened.
      const directVendorLeg = isVendor && !!deptTxn && String((deptTxn as { type?: unknown }).type || '') === 'direct_receipt_reversal';
      if (!rejected && acceptedRecipe > 0) {
        if (isVendor && directVendorLeg) {
          if (invTxnId) faults.push({ line_id: lineId, material_name: name, fault: 'Direct-issue vendor line carries a central receipt as well as the department reversal — central never held these goods, so both moving means the same quantity left two ledgers.' });
        } else if (isVendor) {
          if (!invTxnId) faults.push({ line_id: lineId, material_name: name, fault: 'Vendor line accepted but no movement receipt — neither central stock nor a direct-issue department ledger was debited.' });
          if (deptTxnId) faults.push({ line_id: lineId, material_name: name, fault: 'Vendor line carries a department ledger receipt that is not a direct-issue reversal. A central-booked vendor return has no department leg.' });
        } else {
          if (!deptTxnId) faults.push({ line_id: lineId, material_name: name, fault: 'Internal line accepted but no department ledger receipt — the department may not have been debited.' });
          if (!writeOff && !invTxnId) faults.push({ line_id: lineId, material_name: name, fault: 'Internal reusable line accepted but no inventory_transactions receipt — central stock may not have been credited.' });
        }
      }
      if (deptTxnId && !deptTxn) faults.push({ line_id: lineId, material_name: name, fault: `Dangling dept_txn_id ${deptTxnId} — no such department_material_transactions row.` });
      if (invTxnId && !invTxn)   faults.push({ line_id: lineId, material_name: name, fault: `Dangling inv_txn_id ${invTxnId} — no such inventory_transactions row.` });

      return {
        id: lineId,
        material_id: l.material_id,
        material_name: name,
        reason: l.reason,
        disposition,
        /** A write-off never re-enters the sellable pool — department debit only. */
        is_write_off: writeOff,
        notes: l.notes,
        created_at: l.created_at,

        // req 72's anchors. Blank on an internal line, honestly — the
        // department ledger carries no GRN and no PO, and a nearest match
        // would be a fabrication.
        grn_item_id: l.grn_item_id ?? null,
        po_item_id: l.po_item_id ?? null,
        req_item_id: l.req_item_id ?? null,

        // Claimed, as typed.
        quantity: r3(l.quantity),
        unit: String(l.unit || ''),
        pack_factor: snapshotFactor,
        recipe_qty: r3(l.recipe_qty),
        /** Purchase-unit view of the claim. This is what a screen leads with. */
        claimed: dualQty(r3(l.recipe_qty), meta),

        // Store verification outcome (req 74).
        store_rejected: rejected,
        store_reject_reason: rejected ? String(l.store_reject_reason || '') : '',
        accepted_qty: r3(l.accepted_qty),
        accepted_recipe_qty: acceptedRecipe,
        /** Purchase-unit view of what the store actually took. */
        accepted: dualQty(acceptedRecipe, meta),

        material_unit: l.material_unit ?? null,
        material_purchase_unit: l.material_purchase_unit ?? null,
        material_pack_size: l.material_pack_size ?? null,
        pack_factor_drifted: packFactorDrifted,

        /** TRUE when this vendor line's goods arrived under Direct Issue: the
         *  movement receipt is the department's 'direct_receipt_reversal' and
         *  central was — correctly — never touched. */
        direct_issue: directVendorLeg,

        // THE MOVEMENT RECEIPTS, RESOLVED. `quantity` on each is the SIGNED
        // ledger quantity in RECIPE units, so the direction is visible: the
        // department row is negative (goods left the department) and the
        // central row is POSITIVE on an internal return and NEGATIVE on a
        // vendor return. Opposite signs, same module — that is the point.
        dept_txn_id: deptTxnId,
        inv_txn_id: invTxnId,
        dept_txn: deptTxn,
        inv_txn: invTxn,
        receipts_resolved: (!deptTxnId || !!deptTxn) && (!invTxnId || !!invTxn),
      };
    });

    // ── DECORATED EVENTS ──────────────────────────────────────────────────
    // Item events get the LINE unit and the material's pack meta, for the same
    // reason the requisition audit does it: a logged before/after quantity is
    // in the line's own unit and is unreadable without them.
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const decorated = events.map((e) => {
      const isItem = (ITEM_ENTITY_TYPES as readonly string[]).includes(String(e.entity_type));
      const l = isItem ? lineById.get(String(e.entity_id)) : null;
      return {
        ...e,
        material_name: l?.material_name ?? null,
        unit: l?.unit ?? null,
        material_unit: l?.material_unit ?? null,
        material_purchase_unit: l?.material_purchase_unit ?? null,
        material_pack_size: l?.material_pack_size ?? null,
        before: safeParse(e.before_json),
        after: safeParse(e.after_json),
      };
    });

    // ── THE STAGE SPINE ───────────────────────────────────────────────────
    // Oldest-first, one entry per workflow event, in true insert order. This is
    // the four-stage story of the ticket: raise -> submit -> HOD approve ->
    // Store verify. Every entry states whether stock moved at it, and only the
    // last one can ever say yes.
    //
    // WHAT THE STORE ACCEPT REPORT IS CROSS-CHECKED AGAINST. The counts and the
    // delta below come from the store_verify event's JSON, which is a snapshot
    // written after the commit. The LINES are the durable record — they carry
    // the resolved receipts. If the event JSON is ever missing a field (a
    // partial audit write, a writer that changes shape), trusting it alone
    // would make the timeline say NO STOCK MOVED on a ticket where it did, and
    // under-reporting a movement is the one direction an audit must never fail
    // in. So the line-derived figures are the fallback, and a disagreement
    // between the two is surfaced rather than silently resolved.
    const movedLines = lines.filter((l) => !l.store_rejected && l.accepted_recipe_qty > 0);
    const derived = {
      accepted: movedLines.length,
      rejected: lines.filter((l) => l.store_rejected).length,
      // Summed off the resolved inventory_transactions rows, so it is the
      // actual signed central movement rather than a restatement of intent.
      centralDelta: r3(lines.reduce((sum, l) => sum + (Number(l.inv_txn?.quantity) || 0), 0)),
    };

    const stages = decorated
      .filter((e) => STAGES[String(e.event_type)])
      .map((e) => {
        const s = STAGES[String(e.event_type)];
        const after = (e.after ?? {}) as Record<string, unknown>;
        // `== null` and not `||`: a genuine 0 (every line rejected) must survive
        // and must not be mistaken for an absent field.
        const acceptedLines = after.accepted_lines == null ? derived.accepted : Number(after.accepted_lines) || 0;
        const rejectedLines = after.rejected_lines == null ? derived.rejected : Number(after.rejected_lines) || 0;
        const centralDelta = after.central_delta_recipe_units == null
          ? derived.centralDelta
          : r3(after.central_delta_recipe_units);
        return {
          stage: s.stage,
          label: s.label,
          status: s.status,
          event_type: e.event_type,
          at: e.created_at,
          by: e.actor_email,
          note: e.note || '',
          /** TRUE only for Store Accept: the single stage capable of moving stock. */
          moves_stock: s.moves_stock,
          /**
           * TRUE only if it actually did. Deliberately an OR across the event
           * snapshot and the lines: if EITHER says a line was accepted, stock
           * moved. An audit may overstate that something needs looking at; it
           * may never quietly say a movement did not happen.
           */
          stock_moved: s.moves_stock && (acceptedLines > 0 || derived.accepted > 0),
          accepted_lines: s.moves_stock ? acceptedLines : null,
          rejected_lines: s.moves_stock ? rejectedLines : null,
          /**
           * The store_verify snapshot and the lines do not agree. Not
           * necessarily corruption — but it is the reader's business, not
           * something to average away.
           */
          disagrees_with_lines: s.moves_stock
            ? (acceptedLines !== derived.accepted || Math.abs(centralDelta - derived.centralDelta) > 1e-9)
            : false,
          /**
           * SIGNED recipe-unit change to central stock. POSITIVE on an internal
           * return (goods came back in), NEGATIVE on a vendor return (goods went
           * out), 0 when every line was rejected or written off. Deliberately
           * signed and deliberately never summed with the other kind.
           */
          central_delta_recipe_units: s.moves_stock ? centralDelta : null,
        };
      });

    return Response.json({
      return: {
        id: ret.id,
        ret_number: ret.ret_number,
        kind,
        status: ret.status,
        date: ret.date,
        department_id: ret.department_id ?? null,
        department_name: ret.department_name ?? null,
        grn_number: ret.grn_number ?? null,
        po_number: ret.po_number ?? null,
        /**
         * Stated on the payload so a client cannot get the direction wrong by
         * accident, and so it reads the same in a log as it does on screen.
         * A vendor ticket says which rail the goods actually left on: a line
         * received under DIRECT ISSUE never reached central, so its return
         * debits the receiving department's ledger and central stays flat.
         */
        central_stock_effect: isVendor
          ? (lines.some((l) => l.direct_issue)
              ? 'VENDOR return — goods leave the building. Direct-issue lines debit the receiving DEPARTMENT ledger (central never held them); any central-booked lines decrease central stock.'
              : 'VENDOR return — goods leave the building. Central stock DECREASES. No department leg.')
          : 'INTERNAL return — department to central store. Department stock DECREASES, central stock INCREASES.',
        stock_moves_at: 'store_verify',
      },
      stages,
      lines,
      events: decorated.slice().reverse(),   // newest-first, like the requisition drawer
      truncated,
      integrity: {
        ok: faults.length === 0,
        faults,
        /**
         * No per-line audit_events writer exists yet, so the store's per-line
         * accept/reject outcome comes from the material_return_items rows (and
         * is echoed inside the store_verify event's `after.lines`). Said out
         * loud so nobody reads an empty item-event list as "the store never
         * touched the lines".
         */
        line_events_source: decorated.some((e) => (ITEM_ENTITY_TYPES as readonly string[]).includes(String(e.entity_type)))
          ? 'audit_events'
          : 'material_return_items',
      },
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('[/api/returns/[id]/audit GET]', e);
    return Response.json({ error: err?.message || 'Failed to load return audit' }, { status: 500 });
  }
}

function safeParse(s: unknown): unknown {
  if (!s) return null;
  try { return JSON.parse(String(s)); } catch { return s; }
}
