import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  sendDeptTransfer, getDeptTransfer, type DeptTransferLineInput,
} from '@/lib/dept-ledger';
import {
  loadDepartments, canSendFrom, canSeeDept, countDisputesToAct,
  transferErrorResponse, resolveEntryUnit, bodyNumber, sendRefusalMessage,
} from './access';
import { presentChecked, type SendableCache } from './send-back-check';
import { toSendView, routedSendPost } from './routed-send';

/**
 * DEPARTMENT → DEPARTMENT TRANSFERS — the HTTP layer. ONE STEP (owner's ruling).
 *
 * Kitchen receives MEAT / POULTRY / SEAFOOD straight onto its own department
 * ledger (Direct Issue), but every requisition for them comes from its
 * sub-kitchens, and roll-up runs downward only. A transfer is how Kitchen hands
 * that stock on to Akan Tandoori, Akan Main Kitchen and the rest.
 *
 *   GET  /api/department-transfers                      list documents
 *          ?department_id=<id>      only transfers this department sends or receives
 *          &direction=in|out        relative to department_id ("Transfers in" = in)
 *          &dispute=open|resolved|any   filter on the document's dispute state
 *          &limit=<1..500>          default 100, newest first
 *        → { transfers, departments, open_disputes_to_act }
 *   POST /api/department-transfers                      SEND — moves the stock NOW
 *          { from_department_id, to_department_id, client_key, notes? (or note),
 *            lines: [{ material_id, quantity, unit?, notes? }] }
 *          A line may give `quantity_purchase` instead of `quantity` — the same
 *          number, explicitly in the purchase unit (both at once → 400).
 *        → 201 { transfer, duplicate: false }  — the sender's ledger is already
 *          down and the receiver's up, in one transaction.
 *        → 200 { transfer, duplicate: true }   — this client_key already made
 *          that transfer (a retry after a lost response); NOTHING new written.
 *        → 409 reason 'idempotency_conflict'   — the key was used for different goods.
 *   GET  /api/department-transfers/<id>                 one document
 *   POST /api/department-transfers/<id>/dispute         receiver flags short / wrong item / not received
 *   POST /api/department-transfers/<id>/reverse         the one-tap correction (receiver → sender)
 *   POST /api/department-transfers/<id>/resolve         close a dispute with a note, moving nothing
 *   GET  /api/department-transfers/holdings?department_id=<id>
 *                                                       what that ONE department can send, + receivers
 *   GET  /api/department-transfers/to-send?department_id=<id>   (also ?queue=to_send here)
 *   POST /api/department-transfers/to-send              RULING 45: the routed requisition lines this
 *          department sends itself, and the send that FULFILS them (./routed-send.ts). A POST to
 *          THIS url naming requisition_id / req_item_id is handed to it too — it is never sent on
 *          as an ordinary (unlinked) transfer.
 *
 * ── ONE STEP ───────────────────────────────────────────────────────────────
 * The moment a transfer is SENT the sender's ledger goes down and the
 * receiver's goes up, in ONE transaction (dept-ledger sendDeptTransfer →
 * postDeptTransfer per line). There is no pending state, no /receive, no
 * /cancel, no waiting list. The receiver sees it under "Transfers in"
 * (direction=in) and may flag a dispute — which records and alerts, and moves
 * nothing; the correction is a reverse transfer, one tap from the disputed row.
 *
 * ── CLIENT KEY (idempotency) ───────────────────────────────────────────────
 * REQUIRED on every send. The screen mints it ONCE per tray (crypto.randomUUID)
 * and re-sends the SAME key when it retries after a network error; it mints a
 * new one only after a send is confirmed. The server finds the transfer that
 * key already made and returns it (200, duplicate: true) — a retried send can
 * never become a second transfer. 8–120 chars of [A-Za-z0-9._:-].
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * `quantity` is in the material's PURCHASE unit unless `unit` says otherwise
 * (owner rule: screens lead with the purchase unit). `unit` may be 'purchase'
 * (default), 'recipe', or the unit's own name ('kg', 'g', 'btl'), which this
 * route maps to one of those two by matching the material's purchase_unit /
 * unit. It NEVER converts: dept-ledger's transferQtyToRecipe() does that ONCE
 * through packFactor(). Every document comes back with the stored RECIPE
 * quantities AND *_purchase twins, so a screen never converts either.
 *
 * ── NEVER COUNTED IS NOT ZERO ──────────────────────────────────────────────
 * Kitchen is in practice never counted, so its balance is NULL. Refusing on
 * NULL would block every hand-over. The send check is dept-ledger's
 * deptSendable(): the counted balance (capped by the count plus every movement
 * since it), or — never counted — the all-time signed ledger sum, an UPPER
 * BOUND the holdings screen labels "up to". The refusal message names the basis
 * and what IS available, in the purchase unit.
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * Signed-in only (401). WHO may send / flag / reverse / dismiss / see is
 * ./access.ts — the owner's ruling: senders are the SENDING department's head
 * (head_user_id, or an HOD posted there or to the department it is a
 * sub-kitchen of — ruling #40) plus managers and admin. The proxy
 * never checks page access on an API, so each handler authorises itself.
 * CSRF: '/api/department-transfers' is its own CSRF_REQUIRED_PREFIXES line in
 * src/proxy.ts and covers every POST below it.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_LINES = 50;
const DISPUTE_FILTERS = new Set(['open', 'resolved', 'any']);

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || '').trim();
    // RULING 45: ?queue=to_send is the "To send" list — the same answer as
    // GET /api/department-transfers/to-send (./routed-send.ts), one code path.
    const queue = (url.searchParams.get('queue') || '').trim().toLowerCase();
    if (queue) {
      if (queue !== 'to_send') return Response.json({ error: "queue must be 'to_send'" }, { status: 400 });
      const deptForQueue = departmentId || String(me.department_id || '').trim();
      if (!deptForQueue) return Response.json({ error: 'department_id is required' }, { status: 400 });
      const out = toSendView(getDb(), me, deptForQueue, await getCurrentOutletId());
      return Response.json(out.body, { status: out.status });
    }
    const direction = (url.searchParams.get('direction') || '').trim().toLowerCase();
    const dispute = (url.searchParams.get('dispute') || '').trim().toLowerCase();
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));

    if (direction && direction !== 'in' && direction !== 'out') {
      return Response.json({ error: "direction must be 'in' or 'out'" }, { status: 400 });
    }
    if (direction && !departmentId) {
      return Response.json({ error: 'direction needs department_id' }, { status: 400 });
    }
    if (dispute && !DISPUTE_FILTERS.has(dispute)) {
      return Response.json({ error: 'dispute must be open, resolved or any' }, { status: 400 });
    }

    const db = getDb();
    const depts = loadDepartments(db);
    if (departmentId) {
      if (!depts.has(departmentId)) return Response.json({ error: 'Unknown department' }, { status: 404 });
      if (!canSeeDept(me, departmentId, depts)) {
        return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
      }
    }

    // Transfers with an open dispute WAITING ON THIS CALLER — they hold a
    // take-back or a close the server accepts (access.ts hasDisputeActionFor,
    // THE predicate). The bell (notify.ts openDisputesToActFor) and the page's
    // "Disputes for you to settle" (permissions.dispute_to_act) use the same
    // one, so the three never disagree. Every open dispute, not this page.
    const openToAct = countDisputesToAct(db, me, depts);

    const where: string[] = [];
    const params: string[] = [];
    if (departmentId) {
      if (direction === 'out') { where.push('t.from_department_id = ?'); params.push(departmentId); }
      else if (direction === 'in') { where.push('t.to_department_id = ?'); params.push(departmentId); }
      else { where.push('(t.from_department_id = ? OR t.to_department_id = ?)'); params.push(departmentId, departmentId); }
    } else if (!canSeeAllDeptStock(me)) {
      // Not privileged and no department named: only transfers touching a
      // department this user may see. Fail CLOSED — an empty set lists nothing.
      const visible = [...depts.keys()].filter((id) => canSeeDept(me, id, depts));
      if (visible.length === 0) {
        return Response.json({ transfers: [], departments: deptOptions(me, depts), open_disputes_to_act: openToAct });
      }
      const json = JSON.stringify(visible);
      where.push(`(t.from_department_id IN (SELECT value FROM json_each(?))
                OR t.to_department_id IN (SELECT value FROM json_each(?)))`);
      params.push(json, json);
    }
    if (dispute === 'open') where.push(`t.dispute_status = 'open'`);
    else if (dispute === 'resolved') where.push(`t.dispute_status = 'resolved'`);
    else if (dispute === 'any') where.push(`t.dispute_status <> ''`);

    const ids = db.prepare(`
      SELECT t.id FROM department_transfers t
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC, t.rowid DESC
       LIMIT ${limit}
    `).all(...params) as Array<{ id: string }>;

    // Each document's one-tap send-back is checked against the ledger before
    // it is offered (./send-back-check.ts); one sendable figure per
    // (department, material) for the whole list.
    const cache: SendableCache = new Map();
    const transfers = [];
    for (const { id } of ids) {
      const doc = getDeptTransfer(db, id);
      if (doc) transfers.push(presentChecked(me, doc, depts, db, cache));
    }

    return Response.json({ transfers, departments: deptOptions(me, depts), open_disputes_to_act: openToAct });
  } catch (e: any) {
    console.error('[department-transfers GET]', e);
    return Response.json({ error: e?.message || 'Failed to list transfers' }, { status: 500 });
  }
}

/** Every department with what the caller may do there — the screen's pickers
 *  read this instead of guessing the rules. Receivers for a chosen sender, in
 *  the owner's order, come from /holdings. */
function deptOptions(me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>, depts: ReturnType<typeof loadDepartments>) {
  return [...depts.values()]
    .map((d) => ({
      id: d.id,
      name: d.name,
      parent_id: d.parent_id,
      parent_name: d.parent_id ? depts.get(d.parent_id)?.name || '' : '',
      is_active: !!Number(d.is_active),
      can_send: canSendFrom(me, d),
      can_view: canSeeDept(me, d.id, depts),
      is_mine: !!me.department_id && me.department_id === d.id,
    }))
    .sort((a, b) => (a.parent_name || a.name).localeCompare(b.parent_name || b.name)
      || (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0)
      || a.name.localeCompare(b.name));
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });

  // The outlet is read BEFORE any transaction — nothing is awaited inside one.
  const outletId = await getCurrentOutletId();
  const db = getDb();

  // RULING 45: a send that names requisition lines FULFILS them — it is the
  // "To send" route's (./routed-send.ts), whichever URL it arrived on. Never
  // sent on as an ordinary transfer: that would move the goods and leave the
  // line owed (sent twice, or counted twice).
  const rawForLink: any[] = Array.isArray(body.lines) ? body.lines : [];
  if (String(body.requisition_id || '').trim() || rawForLink.some((l) => String(l?.req_item_id || '').trim())) {
    try {
      const out = routedSendPost(db, me, body, outletId);
      return Response.json(out.body, { status: out.status });
    } catch (e: any) {
      console.error('[department-transfers POST → to-send]', e);
      return Response.json({ error: e?.message || 'Send failed' }, { status: 500 });
    }
  }

  try {
    const fromId = String(body.from_department_id || '').trim();
    const toId = String(body.to_department_id || '').trim();
    if (!fromId || !toId) {
      return Response.json({ error: 'from_department_id and to_department_id are required' }, { status: 400 });
    }
    const depts = loadDepartments(db);
    const from = depts.get(fromId);
    const to = depts.get(toId);
    if (!from) return Response.json({ error: 'Unknown sending department' }, { status: 404 });
    if (!to) return Response.json({ error: 'Unknown receiving department' }, { status: 404 });

    if (!canSendFrom(me, from)) {
      return Response.json({ error: sendRefusalMessage(from, depts) }, { status: 403 });
    }

    const clientKey = typeof body.client_key === 'string' ? body.client_key.trim() : '';
    if (!clientKey) {
      return Response.json({
        error: 'client_key is required: mint one per send (crypto.randomUUID()) and re-send the same key on a retry, so a retry can never post twice.',
      }, { status: 400 });
    }

    const rawLines: any[] = Array.isArray(body.lines)
      ? body.lines
      : (body.material_id != null
        ? [{ material_id: body.material_id, quantity: body.quantity, quantity_purchase: body.quantity_purchase, unit: body.unit, notes: body.line_notes }]
        : []);
    if (rawLines.length === 0) return Response.json({ error: 'Add at least one line (material_id, quantity)' }, { status: 400 });
    if (rawLines.length > MAX_LINES) {
      return Response.json({ error: `At most ${MAX_LINES} lines per transfer` }, { status: 400 });
    }

    const lookup = db.prepare('SELECT id, name, unit, purchase_unit FROM raw_materials WHERE id = ?');
    const lines: DeptTransferLineInput[] = [];
    for (const ln of rawLines) {
      const materialId = String(ln?.material_id || '').trim();
      if (!materialId) return Response.json({ error: 'Every line needs material_id' }, { status: 400 });
      // `quantity_purchase` is the explicitly-named form: the number IS in the
      // purchase unit, full stop. Giving it alongside `quantity`, or with a
      // `unit` that is not the purchase unit, is ambiguous and refused rather
      // than guessed — guessing a basis is the 750x class of error.
      const hasQP = ln?.quantity_purchase !== undefined;
      if (hasQP && ln?.quantity !== undefined) {
        return Response.json({ error: `Send quantity OR quantity_purchase, not both (material ${materialId})` }, { status: 400 });
      }
      const qty = bodyNumber(hasQP ? ln.quantity_purchase : ln?.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return Response.json({ error: `quantity must be a number above 0 (material ${materialId})` }, { status: 400 });
      }
      const m = lookup.get(materialId) as { id: string; name: string; unit: string; purchase_unit: string } | undefined;
      if (!m) return Response.json({ error: `Unknown material ${materialId}` }, { status: 404 });
      const unit = resolveEntryUnit(ln?.unit, m);
      if (hasQP && unit !== 'purchase') {
        return Response.json({
          error: `quantity_purchase is in ${m.name}'s purchase unit (${m.purchase_unit || m.unit}); unit '${String(ln.unit)}' contradicts it`,
        }, { status: 400 });
      }
      if (!unit) {
        return Response.json({
          error: `unit '${String(ln.unit)}' is not ${m.name}'s purchase unit (${m.purchase_unit || m.unit}) ` +
            `or recipe unit (${m.unit})`,
        }, { status: 400 });
      }
      lines.push({ materialId, quantity: qty, unit, notes: String(ln?.notes || '').trim() });
    }

    // sendDeptTransfer opens its own IMMEDIATE transaction: the idempotency
    // gate first, then the document and every line's transfer_out/transfer_in
    // pair. It refuses on every stock invariant (same department, inactive
    // receiver, liquor, more than the sender can send).
    const res = sendDeptTransfer(db, {
      fromDepartmentId: fromId,
      toDepartmentId: toId,
      lines,
      user: me.email,
      clientKey,
      // `note` accepted as a synonym — one free-text field, whichever the screen names it.
      notes: String(body.notes ?? body.note ?? '').trim(),
      outletId,
    });
    return Response.json(
      { transfer: presentChecked(me, res.transfer, depts, db), duplicate: res.duplicate },
      { status: res.duplicate ? 200 : 201 },
    );
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers POST]', e);
    return Response.json({ error: e?.message || 'Transfer failed' }, { status: 500 });
  }
}
