import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  createDeptTransfer, getDeptTransfer, type DeptTransferLineInput,
} from '@/lib/dept-ledger';
import {
  loadDepartments, canSendFrom, canReceiveInto, canSeeDept,
  presentTransfer, transferErrorResponse, resolveEntryUnit,
} from './access';

/**
 * DEPARTMENT → DEPARTMENT TRANSFERS — the HTTP layer.
 *
 * Kitchen receives MEAT / POULTRY / SEAFOOD straight onto its own department
 * ledger (Direct Issue), but every requisition for them comes from its
 * sub-kitchens, and roll-up runs downward only. A transfer is how Kitchen hands
 * that stock on to Akan Tandoori, Akan Main Kitchen and the rest.
 *
 *   GET  /api/department-transfers                      list documents
 *          ?department_id=<id>      only transfers this department sends or receives
 *          &direction=in|out        relative to department_id
 *          &status=pending|received|cancelled
 *          &limit=<1..500>          default 100, newest first
 *   POST /api/department-transfers                      SEND — a PENDING document
 *          { from_department_id, to_department_id, notes? (or note),
 *            lines: [{ material_id, quantity, unit?, notes? }] }
 *          A line may give `quantity_purchase` instead of `quantity` — the same
 *          number, explicitly in the purchase unit (both at once → 400).
 *          (one-line shorthand: material_id / quantity / unit at the top level)
 *          → 201 { transfer }. Every document on the wire carries `lines[]`
 *          with qty_sent / qty_received (RECIPE), their *_purchase twins,
 *          `quantity` (what moved, or is pending) + `quantity_purchase`, and a
 *          `permissions` block { is_sender, can_receive, needs_override_reason,
 *          can_cancel } — show exactly the buttons the server will accept.
 *          GET also returns `departments[]` with can_send / can_receive per
 *          department, and `pending_to_receive` (the caller's inbox count).
 *   GET  /api/department-transfers/<id>                 one document
 *   POST /api/department-transfers/<id>/receive         CONFIRM — moves the stock
 *   POST /api/department-transfers/<id>/cancel          drop a pending document
 *   GET  /api/department-transfers/holdings?department_id=<id>
 *                                                       what that ONE department can send
 *
 * ── WHY TWO STEPS (send, then receive) ─────────────────────────────────────
 * Both maps of the house pattern say so: the Kitchen QC ruling ("stock moves
 * only when the receiver signs", "the receiver may not be the checker") and
 * the store→store transfer's request/issue/receive split. Unlike store→store,
 * NOTHING moves at send: the kilo stays on the SENDER's ledger until the
 * receiver confirms, and the confirm debits the sender and credits the
 * receiver in ONE transaction (postDeptTransfer in src/lib/dept-ledger.ts), so
 * the kilo is in exactly one ledger at every instant — never both, never none.
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
 * NULL would block every hand-over. The rule is dept-ledger's deptReleasable():
 * the counted balance, or — never counted — the all-time signed ledger sum,
 * minus what is already promised on pending transfers. The refusal message
 * names the basis ("by its ledger (never counted)") and what IS available, in
 * the purchase unit. /holdings returns the same figure, so the screen cannot
 * offer what the server will refuse.
 *
 * ── AUTH ───────────────────────────────────────────────────────────────────
 * Signed-in only (401). WHO may send / receive / cancel / see is ./access.ts.
 * The proxy never checks page access on an API, so each handler authorises
 * itself. CSRF: '/api/department-transfers' is its own CSRF_REQUIRED_PREFIXES
 * line in src/proxy.ts — neither '/api/departments' nor
 * '/api/department-materials' is a prefix of this path.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUSES = new Set(['pending', 'received', 'cancelled']);
const MAX_LINES = 50;

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(request.url);
    const departmentId = (url.searchParams.get('department_id') || '').trim();
    const direction = (url.searchParams.get('direction') || '').trim().toLowerCase();
    const status = (url.searchParams.get('status') || '').trim().toLowerCase();
    const limitRaw = Number(url.searchParams.get('limit') || 100);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));

    if (direction && direction !== 'in' && direction !== 'out') {
      return Response.json({ error: "direction must be 'in' or 'out'" }, { status: 400 });
    }
    if (direction && !departmentId) {
      return Response.json({ error: 'direction needs department_id' }, { status: 400 });
    }
    if (status && !STATUSES.has(status)) {
      return Response.json({ error: 'status must be pending, received or cancelled' }, { status: 400 });
    }

    const db = getDb();
    const depts = loadDepartments(db);
    if (departmentId) {
      if (!depts.has(departmentId)) return Response.json({ error: 'Unknown department' }, { status: 404 });
      if (!canSeeDept(me, departmentId, depts)) {
        return Response.json({ error: 'Not allowed for this department' }, { status: 403 });
      }
    }

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
        return Response.json({ transfers: [], pending_to_receive: 0, departments: deptOptions(me, depts) });
      }
      const json = JSON.stringify(visible);
      where.push(`(t.from_department_id IN (SELECT value FROM json_each(?))
                OR t.to_department_id IN (SELECT value FROM json_each(?)))`);
      params.push(json, json);
    }
    if (status) { where.push('t.status = ?'); params.push(status); }

    const ids = db.prepare(`
      SELECT t.id FROM department_transfers t
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC, t.rowid DESC
       LIMIT ${limit}
    `).all(...params) as Array<{ id: string }>;

    const transfers = [];
    let pendingToReceive = 0;
    for (const { id } of ids) {
      const doc = getDeptTransfer(db, id);
      if (!doc) continue;
      const p = presentTransfer(me, doc, depts);
      if (p.permissions.can_receive) pendingToReceive++;
      transfers.push(p);
    }

    return Response.json({ transfers, pending_to_receive: pendingToReceive, departments: deptOptions(me, depts) });
  } catch (e: any) {
    console.error('[department-transfers GET]', e);
    return Response.json({ error: e?.message || 'Failed to list transfers' }, { status: 500 });
  }
}

/** Every department with what the caller may do there — the screen's pickers
 *  read this instead of guessing the rules. */
function deptOptions(me: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>, depts: ReturnType<typeof loadDepartments>) {
  return [...depts.values()]
    .map((d) => ({
      id: d.id,
      name: d.name,
      parent_id: d.parent_id,
      parent_name: d.parent_id ? depts.get(d.parent_id)?.name || '' : '',
      is_active: !!Number(d.is_active),
      can_send: canSendFrom(me, d, depts),
      can_receive: canReceiveInto(me, d, depts),
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

    if (!canSendFrom(me, from, depts)) {
      return Response.json({
        error: `Only an admin, a head of department, ${from.name}'s named head, or a manager posted to ` +
          `${from.name} can send its stock.`,
      }, { status: 403 });
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
      const rawQty = hasQP ? ln.quantity_purchase : ln?.quantity;
      const qty = Number(rawQty);
      if (rawQty === null || rawQty === '' || rawQty === undefined || !Number.isFinite(qty) || qty <= 0) {
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

    // createDeptTransfer opens its own IMMEDIATE transaction and refuses on
    // every stock invariant (same department, inactive receiver, liquor,
    // more than the sender can release minus what is already pending).
    const doc = createDeptTransfer(db, {
      fromDepartmentId: fromId,
      toDepartmentId: toId,
      lines,
      user: me.email,
      // `note` accepted as a synonym — one free-text field, whichever the screen names it.
      notes: String(body.notes ?? body.note ?? '').trim(),
      outletId,
    });
    return Response.json({ transfer: presentTransfer(me, doc, depts) }, { status: 201 });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers POST]', e);
    return Response.json({ error: e?.message || 'Transfer failed' }, { status: 500 });
  }
}
