import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import { isDeptTransferBlocked, type DeptTransferWithLines, type TransferEntryUnit } from '@/lib/dept-ledger';
import { toPurchaseQty } from '@/lib/pack-units';

/**
 * 'purchase' | 'recipe' | a unit's own NAME ('kg', 'g', 'btl') → the entry
 * basis dept-ledger's transferQtyToRecipe() takes, or null when the name
 * matches neither of the material's units. LABEL MATCHING ONLY — no arithmetic
 * here; dept-ledger converts once, through packFactor(). Omitted = 'purchase'
 * (owner rule: screens lead with the purchase unit). When the two unit names
 * are the same string, 'purchase' wins and packFactor() is 1 for it anyway.
 */
export function resolveEntryUnit(
  raw: unknown, m: { unit?: string | null; purchase_unit?: string | null },
): TransferEntryUnit | null {
  const u = String(raw ?? '').trim().toLowerCase();
  if (!u || u === 'purchase') return 'purchase';
  if (u === 'recipe') return 'recipe';
  const pu = String(m.purchase_unit || m.unit || '').trim().toLowerCase();
  const ru = String(m.unit || '').trim().toLowerCase();
  if (u === pu) return 'purchase';
  if (u === ru) return 'recipe';
  return null;
}

/**
 * WHO MAY DO WHAT on a department-to-department transfer. One file, so the
 * four routes under /api/department-transfers cannot disagree.
 *
 * The STOCK rules (the sender must hold it, units, the NULL balance, the anchor
 * window, the liquor carve-out, "the receiver may not be the sender") live in
 * src/lib/dept-ledger.ts and are enforced there whatever the caller. This file
 * decides only WHO — the ledger lane says so in its own header: "who may send,
 * receive or cancel ... is the route's job".
 *
 * ── THE RULES, and the house precedent each one copies ──────────────────────
 *
 * SEND (creates a PENDING document; moves NO stock):
 *   admin · any HOD (is_head_chef) · the head NAMED on the sending department or
 *   its main department (departments.head_user_id / head_chef_user_id) · a
 *   MANAGER-tier user posted to that exact department (users.department_id).
 *   A STAFF-tier user is refused even inside the department: sending promises
 *   the department's stock to someone else, which is a head's call.
 *   Precedent: canApproveAsChef (admin || HOD, global) with the department head
 *   OR'd in the way the requisition detail screen ORs isMainDeptHead.
 *   head_user_id is EMPTY on every department today (approval moved off it in
 *   b8ba6b7 because it 403'd every HOD) — so it is OR'd in, never the gate.
 *   NOT a sender on their own: can_approve_requisitions (an approval
 *   capability, says nothing about who holds the goods) and is_store_manager
 *   (the store never shelves Direct Issue goods — they go straight to Kitchen).
 *
 * RECEIVE (posts the debit AND the credit in one transaction):
 *   admin · any HOD · ANY member of the RECEIVING department, any tier (exact
 *   users.department_id) · the head named on it or its main department.
 *   Precedent: Kitchen QC sign-off (canSignQcFor) — the owner's ruling that any
 *   member of the department may sign ("6am with a truck waiting") — and its
 *   "THE RECEIVER MAY NOT BE THE CHECKER" block, here "the receiver may not be
 *   the sender", with the same escape hatch: an admin or HOD may confirm their
 *   own transfer only with a WRITTEN reason, stored permanently on the document.
 *   NOT visible_department_ids: QC refuses it too — it grants visibility, not
 *   custody.
 *
 * CANCEL (a pending document only; moves nothing): the person who sent it, or
 *   anyone who may send from the sending department, or anyone who may receive
 *   into the receiving department (a hand-over that never arrived is the
 *   receiver's to refuse). A reason is required (dept-ledger enforces it).
 *
 * SEE: admin / manager / HOD / store manager see every transfer
 *   (canSeeAllDeptStock — the /api/department-stock rule). Everyone else sees a
 *   transfer when they belong to either end (allowedDeptIds: own department +
 *   granted visible_department_ids), or could send/receive for either end.
 */

export interface DeptLite {
  id: string;
  name: string;
  parent_id: string | null;
  is_active: number;
  head_user_id: string | null;
  head_chef_user_id: string | null;
}

/** Every department, keyed by id. head_chef_user_id is vestigial and may be
 *  absent on an old database — probed, never assumed. */
export function loadDepartments(db: Database.Database): Map<string, DeptLite> {
  let hasHeadChefCol = false;
  try {
    const cols = db.prepare('PRAGMA table_info(departments)').all() as Array<{ name: string }>;
    hasHeadChefCol = cols.some((c) => c.name === 'head_chef_user_id');
  } catch { /* fall through — the column is optional */ }
  const rows = db.prepare(`
    SELECT id, name, parent_id, COALESCE(is_active, 1) AS is_active, head_user_id,
           ${hasHeadChefCol ? 'head_chef_user_id' : 'NULL AS head_chef_user_id'}
      FROM departments
  `).all() as DeptLite[];
  return new Map(rows.map((d) => [d.id, d]));
}

function isHeadOf(user: SessionUser, dept: DeptLite, all: Map<string, DeptLite>): boolean {
  const named = (d: DeptLite | undefined | null) =>
    !!d && ((!!d.head_user_id && d.head_user_id === user.id) || (!!d.head_chef_user_id && d.head_chef_user_id === user.id));
  if (named(dept)) return true;
  // The head named on the MAIN department governs everything under it
  // (dept-hierarchy.ts mainDeptOf: a sub-department's main is its parent).
  return !!dept.parent_id && named(all.get(dept.parent_id));
}

/** Admin or any HOD — the two global arms every rule below starts with. */
export function isAdminOrHod(user: SessionUser): boolean {
  return user.role === 'admin' || !!user.is_head_chef;
}

export function canSendFrom(user: SessionUser, dept: DeptLite | null | undefined, all: Map<string, DeptLite>): boolean {
  if (!dept) return false;
  if (isAdminOrHod(user)) return true;
  if (isHeadOf(user, dept, all)) return true;
  return user.role === 'manager' && !!user.department_id && user.department_id === dept.id;
}

export function canReceiveInto(user: SessionUser, dept: DeptLite | null | undefined, all: Map<string, DeptLite>): boolean {
  if (!dept) return false;
  if (isAdminOrHod(user)) return true;
  if (isHeadOf(user, dept, all)) return true;
  return !!user.department_id && user.department_id === dept.id;
}

export function canSeeDept(user: SessionUser, deptId: string, all: Map<string, DeptLite>): boolean {
  if (canSeeAllDeptStock(user)) return true;
  if (allowedDeptIds(user).has(deptId)) return true;
  const d = all.get(deptId);
  return canSendFrom(user, d, all) || canReceiveInto(user, d, all);
}

export function isSender(user: SessionUser, doc: { created_by: string }): boolean {
  return String(doc.created_by || '').trim().toLowerCase() === String(user.email || '').trim().toLowerCase();
}

/** What the CALLER may do with one document — sent with every document so the
 *  screen shows exactly the buttons the server will accept. */
export function permissionsFor(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>) {
  const pending = doc.status === 'pending';
  const from = all.get(doc.from_department_id);
  const to = all.get(doc.to_department_id);
  const sender = isSender(user, doc);
  const receiverSide = canReceiveInto(user, to, all);
  return {
    is_sender: sender,
    // The sender may only confirm their own transfer as admin/HOD with a
    // written reason (needs_override_reason tells the screen to ask for it).
    can_receive: pending && receiverSide && (!sender || isAdminOrHod(user)),
    needs_override_reason: pending && receiverSide && sender && isAdminOrHod(user),
    can_cancel: pending && (sender || canSendFrom(user, from, all) || receiverSide),
  };
}

/** A document for the wire: the stored row (RECIPE units, as the ledger keeps
 *  them) plus each quantity in the PURCHASE unit through toPurchaseQty() with
 *  the line's own snapshotted pack factor — the screen leads with these. */
export function presentTransfer(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>) {
  return {
    ...doc,
    lines: doc.lines.map((l) => {
      const meta = { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor };
      // `quantity` = THE figure for this line, RECIPE units: what actually moved
      // once received (qty_received — may be short of qty_sent), else what was
      // sent (pending: still on the sender's ledger; cancelled: never moved).
      const quantity = doc.status === 'received' ? Number(l.qty_received) || 0 : l.qty_sent;
      return {
        ...l,
        qty_sent_purchase: toPurchaseQty(l.qty_sent, meta),
        qty_received_purchase: l.qty_received == null ? null : toPurchaseQty(l.qty_received, meta),
        quantity,
        quantity_purchase: toPurchaseQty(quantity, meta),
        // The line's snapshotted packFactor() under the PackMeta field name, so a
        // screen can hand the line straight to pack-units' helpers.
        pack_size: l.pack_factor,
      };
    }),
    permissions: permissionsFor(user, doc, all),
  };
}

/**
 * Map a refusal from dept-ledger to a response. DeptTransferBlocked carries its
 * own status (400 / 404 / 409) and a message that already LEADS with the
 * purchase unit ("Kitchen holds only 3 kg of …"). The numbers ride along in
 * both bases so a screen never has to convert.
 */
export function transferErrorResponse(db: Database.Database, e: unknown): Response | null {
  if (!isDeptTransferBlocked(e)) return null;
  let purchase: { purchase_unit: string; unit: string; requested_purchase: number; available_purchase: number } | null = null;
  if (e.materialId) {
    try {
      const m = db.prepare('SELECT unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?')
        .get(e.materialId) as { unit: string; purchase_unit: string; pack_size: number } | undefined;
      if (m) {
        purchase = {
          unit: String(m.unit || ''),
          purchase_unit: String(m.purchase_unit || m.unit || ''),
          requested_purchase: toPurchaseQty(e.requested, m),
          available_purchase: toPurchaseQty(e.available, m),
        };
      }
    } catch { /* the message already says it in the purchase unit */ }
  }
  return Response.json({
    error: e.message,
    code: e.code,
    reason: e.reason,
    material_id: e.materialId || null,
    requested: e.requested,
    available: e.available,
    ...(purchase || {}),
  }, { status: e.httpStatus });
}
