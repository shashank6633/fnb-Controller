import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import {
  sendDeptTransfer, reverseDeptTransfer, getDeptTransfer, deptSendableFor, transferQtyToRecipe, isDeptTransferBlocked,
  type DeptTransferWithLines, type ReverseDeptTransferInput,
} from '@/lib/dept-ledger';
import { lineFactor } from '@/lib/issue-stock';
import { planCentralDebit, shownWithStep, holdsAny, type ShownAs } from '@/lib/central-debit-clamp';
import { packFactor, shownPurchaseQty, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import { routedSchema } from '@/lib/routed-schema';
import {
  applyRoutedSend, applyRoutedSendBack, toSendQueue, routedLineState,
  type RoutedApplyResult, type PartyStorePartPending,
} from '@/lib/routed-requisitions';
import { storeStageCheck } from '@/lib/po-helpers';
import {
  loadDepartments, canSendFrom, canSeeDept, sendRefusalMessage, transferErrorBody, bodyNumber,
} from './access';
import { presentChecked } from './send-back-check';

/* ══════════════════════════════════════════════════════════════════════════
 * "TO SEND" — ROUTED REQUISITION LINES A DEPARTMENT HANDS OVER ITSELF
 * (owner rulings #45 + #74; build contract v1 §4).
 *
 * Direct Issue sends Meat / Poultry / Seafood (whatever the owner's rules
 * route) straight from the vendor to Kitchen, so the central store never holds
 * them. After the HOD approves (and management, where Settings require it for
 * party requisitions), any OTHER department's requisition line for those items
 * is stamped with the routed department (src/lib/routed-requisitions.ts) and
 * waits HERE, on that department's "To send" list — never on the store desk.
 * Internal and party requisitions alike.
 *
 * GET  → routed-requisitions toSendQueue() — the queue (THE RULE decides what is
 *        still owed; the store inbox's own stage rule decides which requisitions
 *        are open), grouped by requisition × receiving department, PURCHASE
 *        units first, with what this department's own books let it send
 *        (dept-ledger deptSendableFor — the very figure the send check refuses
 *        on). This file adds only WHO: department.can_send / can_view, and a
 *        line's can_send is false for anyone who may not send from it.
 * POST → ONE department transfer (the one-step rail, rulings #2 #11 #12 #40
 *        #57-#61) whose lines carry the requisition link; inside the SAME
 *        IMMEDIATE transaction routed-requisitions applyRoutedSend() writes each
 *        line's quantity_issued through applyIssueDelta (a 'routed' row — the
 *        central store is NEVER touched) and advances the requisition. Partial
 *        sends are allowed; the rest stays queued. A party line is costed on
 *        its party's P&L exactly as a store-issued line (party-liquor reads
 *        quantity_issued).
 *
 * WHO. Only someone who may send from the department (access.ts canSendFrom —
 * its named head, an HOD posted there or to its parent, managers, admin;
 * rulings #12 #40) may send; whoever may SEE it (canSeeDept) may read the list.
 *
 * WHAT IS NEVER DONE HERE: no central stock moves (the transfer legs are the
 * only movement); no Direct Issue rule, department, role or station mapping is
 * written (the owner's — read only); no line the store already started issuing
 * is touched (it was never stamped routed).
 *
 * Pure functions over (db, user, input); the HTTP shells are ./to-send/route.ts
 * and the ?queue=to_send / linked-POST hand-offs on ../route.ts. Nothing is
 * awaited inside a transaction.
 * ══════════════════════════════════════════════════════════════════════════ */

const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const MAX_LINES = 50;

export interface CoreResult { status: number; body: Record<string, unknown> }

/** The purchase-unit figure every screen prints for a RECIPE quantity, carrying
 *  its printed step — the converter the ONE shown-figure rule
 *  (central-debit-clamp planCentralDebit) matches an ask against. The queue's
 *  owed_purchase / sendable_purchase / max_send_purchase are this figure. */
function purchaseShownAs(meta: PackMeta): ShownAs {
  return shownWithStep((q: number) => shownPurchaseQty(q, meta), 0.001 * packFactor(meta));
}

/** "1 kg" / "2.5 BTL (2,500 ml)" — the PURCHASE unit leads (owner rule). */
function fmtPU(recipeQty: number, meta: PackMeta): string {
  const pf = packFactor(meta);
  const pu = String(meta.purchase_unit || meta.unit || '').trim();
  const ru = String(meta.unit || '').trim();
  const lead = `${fmtQtyNum(shownPurchaseQty(recipeQty, meta))} ${pu}`.trim();
  return pf > 1 ? `${lead} (${fmtQtyNum(r6(recipeQty))} ${ru})` : lead;
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ── GET — the queue ────────────────────────────────────────────────────── */

export function toSendView(db: Database.Database, me: SessionUser, deptId: string, outletId: string | null): CoreResult {
  const depts = loadDepartments(db);
  const dept = depts.get(deptId);
  if (!dept) return { status: 404, body: { error: 'Unknown department' } };
  if (!canSeeDept(me, deptId, depts)) return { status: 403, body: { error: 'Not allowed for this department' } };

  const canSend = canSendFrom(me, dept);
  const q = toSendQueue(db, deptId, outletId);
  // The queue's sentences describe the department's Direct Issue rules. With
  // NO rule sending anything to it, they would describe rules that do not
  // exist — say what IS true instead (lines stamped under a rule since
  // deleted still show, and still say how they got here).
  const explain = q.rules.length > 0 ? q.explain : [
    `No Direct Issue rule sends deliveries to ${dept.name} now, so no new requisition line comes to its To send list.` +
      (q.groups.length > 0
        ? ` The lines below were routed to ${dept.name} by a Direct Issue rule when their requisitions were approved, and are still ${dept.name}'s to send.`
        : ''),
  ];
  const groups = q.groups.map((g) => ({
    ...g,
    lines: g.lines.map((l) => ({ ...l, can_send: canSend && l.can_send && !l.blocked && holdsAny(l.max_send_recipe) })),
  }));
  return {
    status: 200,
    body: {
      department: {
        id: dept.id, name: dept.name, is_active: !!Number(dept.is_active),
        can_send: canSend, can_view: true,
      },
      rules: q.rules,
      explain,
      groups,
      totals: q.totals,
    },
  };
}

/* ── SEND-BACK — the reverse, with the requisition side (contract 3.6) ──── */

/**
 * reverseDeptTransfer() and routed-requisitions applyRoutedSendBack() in ONE
 * IMMEDIATE transaction — the reverse's two legs, the lowered requisition
 * line(s) and the requisition's status commit or roll back together. The
 * reverse nests as a SAVEPOINT. A RETRY (the key already made the reverse)
 * re-syncs nothing: the first call did. A reverse of an ordinary transfer
 * finds no link, so `sync.lines` is empty and nothing else changes. Throws
 * DeptTransferBlocked exactly as reverseDeptTransfer() does.
 */
export function reverseWithRequisitionSync(
  db: Database.Database, input: ReverseDeptTransferInput,
): { res: ReturnType<typeof reverseDeptTransfer>; sync: RoutedApplyResult | null } {
  return db.transaction(() => {
    const res = reverseDeptTransfer(db, input);
    const sync: RoutedApplyResult | null = res.duplicate ? null : applyRoutedSendBack(db, res.transfer, input.user);
    return { res, sync };
  }).immediate();
}

/** The requisition lines a send-back lowered, for the reverse's reply:
 *  `rows` (PURCHASE units, the server's figures) and ONE sentence saying what
 *  is now true ('' when the reverse touched no requisition line). */
export function requisitionSyncOf(db: Database.Database, sync: RoutedApplyResult | null) {
  const rows = (sync?.lines || []).map((s) => {
    let pu = '';
    let sender = '';
    try {
      const m = db.prepare(`
        SELECT rm.unit, rm.purchase_unit, d.name AS sender
          FROM requisition_items ri
          LEFT JOIN raw_materials rm ON rm.id = ri.material_id
          LEFT JOIN departments d ON d.id = ri.routed_department_id
         WHERE ri.id = ?
      `).get(s.req_item_id) as { unit: string; purchase_unit: string; sender: string | null } | undefined;
      pu = String(m?.purchase_unit || m?.unit || '');
      sender = String(m?.sender || '');
    } catch { pu = ''; sender = ''; }
    return {
      req_item_id: s.req_item_id,
      req_number: s.req_number,
      material_name: s.material_name,
      purchase_unit: pu,
      /** The department whose To send list the line is on (the routed department). */
      sender_name: sender,
      sent_purchase_before: s.sent_purchase_before,
      sent_purchase_after: s.sent_purchase_after,
      owed_purchase: s.owed_purchase,
      complete: s.complete,
      reopened: s.reopened,
    };
  });
  const list = (r: { sender_name: string }) => (r.sender_name ? `${r.sender_name}'s To send list` : 'the To send list');
  const parts = rows
    .filter((r) => Math.abs(r.sent_purchase_after - r.sent_purchase_before) > EPS)
    .map((r) => {
      const lead = `${r.req_number}: ${r.material_name} now counts ${fmtQtyNum(r.sent_purchase_after)} ${r.purchase_unit} sent ` +
        `(was ${fmtQtyNum(r.sent_purchase_before)})`;
      const owed = !r.complete && r.owed_purchase > EPS;
      if (r.sent_purchase_after < r.sent_purchase_before) {
        return owed ? `${lead}; ${fmtQtyNum(r.owed_purchase)} ${r.purchase_unit} is owed again and back on ${list(r)}.` : `${lead}.`;
      }
      return owed ? `${lead}; ${fmtQtyNum(r.owed_purchase)} ${r.purchase_unit} is still to send on ${list(r)}.` : `${lead} — complete.`;
    });
  const reopened = (sync?.requisitions || [])
    .filter((q) => q.status_before === 'fulfilled' && !q.fulfilled).map((q) => q.req_number);
  const message = parts.length === 0 ? ''
    : `${parts.join(' ')}${reopened.length ? ` ${listJoin(reopened)} ${reopened.length === 1 ? 'is' : 'are'} open again.` : ''}`;
  return { rows, message };
}

/* ── POST — Send ────────────────────────────────────────────────────────── */

export type RoutedSendRefusal =
  | 'not_routed_here' | 'not_with_store' | 'line_closed' | 'nothing_owed' | 'receiver_mismatch'
  | 'unit_review' | 'line_changed' | 'over_owed' | 'idempotency_conflict';

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: RoutedSendRefusal | 'invalid' | 'not_found',
    message: string,
    readonly reqItemId = '',
  ) { super(message); }
}

interface WantedLine { reqItemId: string; quantityPurchase: number | null; sendAllOwed: boolean; expectSentLine: number | null }

interface ParsedBody { fromId: string; toId: string; reqId: string; clientKey: string; note: string; lines: WantedLine[] }

function parseBody(body: any): ParsedBody {
  const fromId = String(body?.from_department_id || '').trim();
  const toId = String(body?.to_department_id || '').trim();
  const reqId = String(body?.requisition_id || '').trim();
  if (!fromId || !toId || !reqId) {
    throw new Refused(400, 'invalid', 'from_department_id, to_department_id and requisition_id are required');
  }
  const clientKey = typeof body?.client_key === 'string' ? body.client_key.trim() : '';
  if (!clientKey) {
    throw new Refused(400, 'invalid', 'client_key is required: mint one per send (crypto.randomUUID()) and re-send the same key on a retry, so a retry can never post twice.');
  }
  const raw: any[] = Array.isArray(body?.lines) ? body.lines : [];
  if (raw.length === 0) throw new Refused(400, 'invalid', 'Name at least one requisition line to send (lines: [{ req_item_id, quantity_purchase | send_all_owed }]).');
  if (raw.length > MAX_LINES) throw new Refused(400, 'invalid', `At most ${MAX_LINES} lines per send`);
  const seen = new Set<string>();
  const lines: WantedLine[] = [];
  for (const ln of raw) {
    const id = String(ln?.req_item_id || '').trim();
    if (!id) throw new Refused(400, 'invalid', 'Every line needs req_item_id');
    if (seen.has(id)) throw new Refused(400, 'invalid', 'A requisition line is named twice; send its total once.', id);
    seen.add(id);
    const all = ln?.send_all_owed === true;
    const hasQ = ln?.quantity_purchase !== undefined && ln?.quantity_purchase !== null;
    if (all && hasQ) throw new Refused(400, 'invalid', 'Send quantity_purchase OR send_all_owed, not both.', id);
    if (!all && !hasQ) throw new Refused(400, 'invalid', 'Each line needs quantity_purchase (in the purchase unit) or send_all_owed: true.', id);
    let q: number | null = null;
    if (hasQ) {
      q = bodyNumber(ln.quantity_purchase);
      if (!Number.isFinite(q) || q <= 0) throw new Refused(400, 'invalid', 'quantity_purchase must be a number above 0 (in the purchase unit).', id);
    }
    let expect: number | null = null;
    if (ln?.expect_sent_line !== undefined && ln?.expect_sent_line !== null) {
      expect = bodyNumber(ln.expect_sent_line);
      if (!Number.isFinite(expect) || expect < 0) {
        throw new Refused(400, 'invalid', 'expect_sent_line must be the sent figure the screen showed (0 or more, in the line unit).', id);
      }
    }
    lines.push({ reqItemId: id, quantityPurchase: q, sendAllOwed: all, expectSentLine: expect });
  }
  return { fromId, toId, reqId, clientKey, note: String(body?.note ?? body?.notes ?? '').trim(), lines };
}

/** The raw facts routedLineState() does not carry: the requisition's stage and
 *  outlet, the line's material and its pack meta as stored now. */
interface LineFacts {
  id: string; req_id: string; material_id: string; req_number: string; req_status: string; purpose: string;
  outlet_id: string | null; unit: string | null; purchase_unit: string | null; pack_size: number | null;
}

function lineFacts(db: Database.Database, reqItemId: string): LineFacts | null {
  try {
    return (db.prepare(`
      SELECT ri.id, ri.req_id, ri.material_id, r.req_number, r.status AS req_status,
             COALESCE(NULLIF(TRIM(r.purpose), ''), 'internal') AS purpose, r.outlet_id,
             rm.unit, rm.purchase_unit, rm.pack_size
        FROM requisition_items ri
        JOIN requisitions r ON r.id = ri.req_id
        LEFT JOIN raw_materials rm ON rm.id = ri.material_id
       WHERE ri.id = ?
    `).get(reqItemId) as LineFacts | undefined) || null;
  } catch { return null; }
}

/** What each sent line says now — the reply's `lines`. */
function linesNow(db: Database.Database, ids: string[]) {
  const st = routedLineState(db, ids);
  return ids.map((id) => {
    const s = st.get(id);
    return s
      ? {
        req_item_id: id, material_name: s.material_name,
        sent_line: s.sent_line, owed_line: s.owed_line, owed_purchase: s.owed_purchase,
        purchase_unit: s.purchase_unit, complete: s.complete, sentence: s.sentence,
      }
      : { req_item_id: id, material_name: '', sent_line: 0, owed_line: 0, owed_purchase: 0, purchase_unit: '', complete: false, sentence: '' };
  });
}

function requisitionNow(db: Database.Database, reqId: string) {
  const r = db.prepare(`SELECT id, req_number, status, COALESCE(NULLIF(TRIM(purpose), ''), 'internal') AS purpose FROM requisitions WHERE id = ?`)
    .get(reqId) as { id: string; req_number: string; status: string; purpose: string } | undefined;
  return r ? { id: r.id, req_number: r.req_number, status: r.status, purpose: r.purpose, fulfilled: r.status === 'fulfilled' } : null;
}

export function routedSendPost(db: Database.Database, me: SessionUser, body: unknown, outletId: string | null): CoreResult {
  let input: ParsedBody;
  try { input = parseBody(body); } catch (e) {
    if (e instanceof Refused) return { status: e.status, body: { error: e.message, code: e.code, reason: e.code, req_item_id: e.reqItemId || null } };
    throw e;
  }
  const depts = loadDepartments(db);
  const from = depts.get(input.fromId);
  const to = depts.get(input.toId);
  if (!from) return { status: 404, body: { error: 'Unknown sending department' } };
  if (!to) return { status: 404, body: { error: 'Unknown receiving department' } };
  if (!canSendFrom(me, from)) return { status: 403, body: { error: sendRefusalMessage(from, depts) } };

  const schema = routedSchema(db);
  if (!schema.lineCol || !schema.linkCols) {
    return {
      status: 409,
      body: {
        error: `This database has no routed requisition lines yet (the start-up migration has not added them), so nothing is on ` +
          `${from.name}'s To send list. Nothing was sent.`,
        code: 'not_routed_here', reason: 'not_routed_here',
      },
    };
  }

  const wantedIds = input.lines.map((l) => l.reqItemId);
  const atStore = storeStageCheck(db);
  const actor = String(me.email || '').trim();

  try {
    const run = db.transaction((): { doc: DeptTransferWithLines; duplicate: boolean; sync: RoutedApplyResult | null } => {
      // ── 1. THE KEY FIRST. A retry of a send that went through must come back
      // as that send — not as "sent in full already", which re-reading the
      // now-fulfilled line would say (and the screen would think nothing moved).
      const prior = db.prepare(`SELECT id FROM department_transfers WHERE created_by = ? AND client_key = ?`)
        .get(actor, input.clientKey) as { id: string } | undefined;
      if (prior) {
        const doc = getDeptTransfer(db, prior.id);
        const got = new Set((doc?.lines || []).map((l) => l.req_item_id).filter(Boolean));
        const same = !!doc && doc.requisition_id === input.reqId
          && got.size === wantedIds.length && wantedIds.every((id) => got.has(id));
        if (!same) {
          throw new Refused(409, 'idempotency_conflict',
            'This send key was already used for a different transfer. Nothing was written; start a new send.');
        }
        return { doc: doc as DeptTransferWithLines, duplicate: true, sync: null };
      }

      // ── 2. RE-READ every line inside the transaction; one refusal refuses all.
      const states = routedLineState(db, wantedIds);
      const seenMat = new Set<string>();
      const rows = input.lines.map((want) => {
        const x = lineFacts(db, want.reqItemId);
        if (!x || x.req_id !== input.reqId) {
          throw new Refused(404, 'not_found', `Requisition line ${want.reqItemId} is not on that requisition.`, want.reqItemId);
        }
        if (outletId && x.outlet_id && x.outlet_id !== outletId) {
          throw new Refused(404, 'not_found', `${x.req_number} belongs to another outlet; switch outlet to send against it.`, x.id);
        }
        const st = states.get(x.id);
        const name = st?.material_name || 'This item';
        if (!st) {
          throw new Refused(409, 'not_routed_here',
            `That line of ${x.req_number} is served by the store, not sent by ${from.name}. Nothing was sent.`, x.id);
        }
        if (st.department.id !== from.id) {
          throw new Refused(409, 'not_routed_here',
            `${name} on ${x.req_number} is on ${st.department.name || 'another department'}'s To send list, not ${from.name}'s. Nothing was sent.`, x.id);
        }
        if (!atStore(String(x.req_status || ''), x.purpose)) {
          const why = x.purpose === 'party' && x.req_status === 'chef_approved'
            ? 'is waiting for management approval'
            : `is ${String(x.req_status || 'not open').replace(/_/g, ' ')}`;
          throw new Refused(409, 'not_with_store', `${x.req_number} ${why}, so nothing on it is waiting to be sent. Nothing was sent.`, x.id);
        }
        if (st.receiver.id !== to.id) {
          throw new Refused(409, 'receiver_mismatch',
            `${name} on ${x.req_number} was asked for by ${st.receiver.name || 'another department'}, not ${to.name}; ` +
            `it goes to the department that asked. Nothing was sent.`, x.id);
        }
        if (st.closed) {
          throw new Refused(409, 'line_closed', `${name} on ${x.req_number} was rejected, so nothing is owed on it. Nothing was sent.`, x.id);
        }
        if (st.unit_review) {
          throw new Refused(409, 'unit_review',
            `${name} on ${x.req_number} is recorded in "${st.line_unit || '(no unit)'}", which cannot be read as ${st.recipe_unit} or ` +
            `${st.purchase_unit}, so it cannot be sent until the line's unit is fixed. Nothing was sent.`, x.id);
        }
        if (st.approved_line <= EPS) {
          throw new Refused(409, 'nothing_owed', `${name} on ${x.req_number} was approved at 0, so nothing is owed. Nothing was sent.`, x.id);
        }
        if (st.complete || st.owed_recipe <= EPS) {
          throw new Refused(409, 'line_closed', `${name} on ${x.req_number} has been sent in full already. Nothing was sent.`, x.id);
        }
        const meta: PackMeta = { unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_size };
        const { factor } = lineFactor(st.line_unit, meta);
        if (want.expectSentLine != null && Math.abs(want.expectSentLine - st.sent_line) > 1e-6) {
          throw new Refused(409, 'line_changed',
            `${name} on ${x.req_number} changed after this screen was loaded: it showed ${fmtPU(want.expectSentLine * factor, meta)} sent, ` +
            `and ${fmtPU(st.sent_line * factor, meta)} has been sent now. Nothing was sent; look at the list again.`, x.id);
        }
        if (seenMat.has(String(x.material_id))) {
          throw new Refused(400, 'invalid', `${name} is on two lines of ${x.req_number}; send them one at a time.`, x.id);
        }
        seenMat.add(String(x.material_id));
        return { want, x, st, meta, factor };
      });

      // ── 3. HOW MUCH, by the ONE shown-figure rule (planCentralDebit): first
      // against what is OWED (never more), then against what the sender's books
      // hold (only ever snapping DOWN, to "all of it"). A figure that does not
      // fit what it holds goes on as asked, and the transfer writer refuses it
      // 'insufficient' with its own words.
      const lines = rows.map(({ want, x, st, meta, factor }) => {
        const shown = purchaseShownAs(meta);
        const ask = want.sendAllOwed ? st.owed_recipe : transferQtyToRecipe(meta, Number(want.quantityPurchase), 'purchase');
        const owedPlan = planCentralDebit(st.owed_recipe, ask, shown);
        if (!owedPlan.fits) {
          throw new Refused(409, 'over_owed',
            `Only ${fmtPU(st.owed_recipe, meta)} of ${st.material_name} is still owed on ${x.req_number}; ` +
            `cannot send ${fmtPU(ask, meta)}. Nothing was sent.`, x.id);
        }
        let q = r6(owedPlan.debit);
        let wholeOwed = owedPlan.takesAll;
        const held = deptSendableFor(db, from.id, String(x.material_id));
        const heldPlan = planCentralDebit(held.available, q, shown);
        if (heldPlan.fits && heldPlan.takesAll && r6(heldPlan.debit) < q - EPS) {
          q = r6(heldPlan.debit);
          wholeOwed = false;
        }
        // LINE units this send adds to the line — exactly what was owed when it
        // takes the whole of it, so THE RULE closes the line on the dot.
        const reqLineQty = wholeOwed ? st.owed_line : r6(q / factor);
        return { x, q, reqLineQty };
      });

      // ── 4. ONE transfer (nested: a SAVEPOINT inside this transaction), then
      // the requisition side, in the same unit of work. Any throw rolls back
      // the legs, the link and the line together.
      const reqNumber = rows[0].x.req_number;
      const res = sendDeptTransfer(db, {
        fromDepartmentId: from.id,
        toDepartmentId: to.id,
        user: actor,
        clientKey: input.clientKey,
        notes: `Fulfils ${reqNumber}${input.note ? ` — ${input.note}` : ''}`,
        outletId,
        requisitionId: input.reqId,
        lines: lines.map((l) => ({
          materialId: String(l.x.material_id),
          quantity: l.q,
          unit: 'recipe' as const,
          reqItemId: l.x.id,
          reqLineQty: l.reqLineQty,
        })),
      });
      const sync = applyRoutedSend(db, res.transfer, actor);
      return { doc: getDeptTransfer(db, res.transfer.id) as DeptTransferWithLines, duplicate: false, sync };
    });
    const out = run.immediate();

    const req = requisitionNow(db, input.reqId);
    const now = linesNow(db, wantedIds);
    const pending: PartyStorePartPending | null = out.sync?.party_store_part_pending ?? null;
    const moved = out.doc.lines.map((l) =>
      `${fmtPU(l.qty_sent, { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor })} ${l.material_name}`);
    const owing = now.filter((x) => !x.complete && x.owed_purchase > EPS)
      .map((x) => `${fmtQtyNum(x.owed_purchase)} ${x.purchase_unit} ${x.material_name}`);
    const head = out.duplicate
      ? `${out.doc.transfer_no} had already gone through (${listJoin(moved)} from ${out.doc.from_department_name} to ` +
        `${out.doc.to_department_name}); nothing was sent twice.`
      : `${out.doc.transfer_no}: ${listJoin(moved)} moved from ${out.doc.from_department_name}'s books to ` +
        `${out.doc.to_department_name}'s, against ${req?.req_number || 'the requisition'}.`;
    const tail = req?.fulfilled
      ? ` ${req.req_number} is fulfilled.`
      : owing.length > 0 ? ` Still to send on ${req?.req_number || 'it'}: ${listJoin(owing)}.` : '';
    return {
      status: out.duplicate ? 200 : 201,
      body: {
        transfer: presentChecked(me, out.doc, depts, db),
        requisition: req,
        lines: now,
        party_store_part_pending: pending,
        message: `${head}${tail}${pending?.message ? ` ${pending.message}` : ''}`.trim(),
        duplicate: out.duplicate,
      },
    };
  } catch (e) {
    if (e instanceof Refused) {
      return { status: e.status, body: { error: e.message, code: e.code, reason: e.code, req_item_id: e.reqItemId || null } };
    }
    if (isDeptTransferBlocked(e)) {
      const handled = transferErrorBody(db, e);
      if (handled) {
        // Which requisition line the refused material belongs to, so the screen
        // can point at it.
        let hit = '';
        if (e.materialId) {
          for (const w of input.lines) {
            if (lineFacts(db, w.reqItemId)?.material_id === e.materialId) { hit = w.reqItemId; break; }
          }
        }
        return { status: handled.status, body: { ...handled.body, req_item_id: hit || null } };
      }
    }
    throw e;
  }
}
