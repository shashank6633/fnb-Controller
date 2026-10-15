import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  isDeptTransferBlocked, deptTransferCountedSinceMessage,
  type DeptTransferWithLines, type DeptTransferDisputeRow, type TransferEntryUnit,
} from '@/lib/dept-ledger';
import { toPurchaseQty } from '@/lib/pack-units';
import { resolveDirectIssueBulk } from '@/lib/direct-issue';

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
 * A quantity from a JSON body: a finite number, or a numeric string. NOT a
 * boolean (Number(true) is 1 — `quantity: true` must not send one kilo), not
 * null / '' / an object. Returns NaN for anything else.
 */
export function bodyNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) return Number(v);
  return NaN;
}

/**
 * WHO MAY DO WHAT on a department-to-department transfer — the OWNER'S RULING
 * (final). One file, so every route under /api/department-transfers agrees.
 *
 * The STOCK rules (the sender must hold it, units, the NULL balance, the leg
 * window, the liquor carve-out, idempotency, a reverse never exceeding what
 * moved) live in src/lib/dept-ledger.ts and are enforced there whatever the
 * caller. This file decides only WHO.
 *
 * SEND (one step — the stock moves when the document is written):
 *   the SENDING department's head — departments.head_user_id, or an HOD
 *   (is_head_chef) POSTED to that department (users.department_id) — plus
 *   managers (manager tier, NOT an HOD — see isAdminOrManager) and admin.
 *   Nobody else: staff, an HOD posted elsewhere (even on the manager-tier Head
 *   Chef role), the head of a parent department, can_approve_requisitions.
 *
 * SEE: admin / manager / HOD / store manager see every transfer
 *   (canSeeAllDeptStock — the /api/department-stock rule). Everyone else sees
 *   transfers INTO and OUT OF their own department (and any granted
 *   visible_department_ids), or one they could send from.
 *
 * FLAG A DISPUTE (records + alerts; moves nothing): anyone POSTED to the
 *   RECEIVING department, any tier — staff included, the owner's words — plus
 *   whoever may send from it (its head, managers, admin).
 *
 * REVERSE (the one correction; a one-step transfer receiver → sender):
 *   · whoever may send from the ORIGINAL RECEIVER — it is a send from there —
 *     up to what each line still has standing ('receiver' authority);
 *   · whoever may send from the ORIGINAL SENDER, but ONLY on an OPEN dispute
 *     and only up to the disputed quantity ('disputed_only'): the receiver's
 *     own claim is the consent, and these are the people the flag alerted.
 *
 * DISMISS A DISPUTE (closes it, moves nothing): the person who raised it
 *   (withdrawing their own claim), managers and admin. NOT the sender's head
 *   or HOD — a claim against your own department is not yours to close, and
 *   the Head Chef role being manager tier does not make its holder a
 *   "manager" here (isAdminOrManager). ONE exception: once BOTH departments
 *   have counted the disputed line since it moved, the claim can no longer
 *   change any book (the take-back is refused, counted_since), and the head of
 *   either department may close it too — see canDismissDispute.
 */

export interface DeptLite {
  id: string;
  name: string;
  parent_id: string | null;
  is_active: number;
  head_user_id: string | null;
}

/** Every department, keyed by id. */
export function loadDepartments(db: Database.Database): Map<string, DeptLite> {
  const rows = db.prepare(`
    SELECT id, name, parent_id, COALESCE(is_active, 1) AS is_active, head_user_id
      FROM departments
  `).all() as DeptLite[];
  return new Map(rows.map((d) => [d.id, d]));
}

export function isAdmin(user: Pick<SessionUser, 'role'>): boolean {
  return user.role === 'admin';
}

/**
 * The two GLOBAL arms of the ruling: admin, and "managers".
 *
 * "MANAGERS" IS THE MANAGER TIER **WITHOUT** THE HOD FLAG. The ruling names
 * HODs separately — "an HOD posted to that department" — and on this database
 * the real Head Chef role is itself manager tier (roles.base_role 'manager',
 * is_head_chef 1). Read "managers" as the bare tier and that HOD clause never
 * binds anyone: every Head Chef could send any department's stock, and the
 * Kitchen HOD could close a dispute raised AGAINST Kitchen. So an HOD is
 * governed by the HOD clause whatever their tier — they act for the department
 * they are posted to (or one whose head_user_id names them). Measured before
 * this line (xfer-r3-ledger r3-prove B/D8): a Head Chef posted to Akan Bar sent
 * Kitchen's chicken (201) and the Kitchen Head Chef dismissed Tandoori's claim
 * against Kitchen (200). If the owner wants every Head Chef to send from every
 * department, this is the one line to change.
 */
export function isAdminOrManager(user: Pick<SessionUser, 'role' | 'is_head_chef'>): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'manager' && !user.is_head_chef;
}

export function canSendFrom(
  user: Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'department_id'>,
  dept: DeptLite | null | undefined,
): boolean {
  if (!dept) return false;
  if (isAdminOrManager(user)) return true;
  if (dept.head_user_id && dept.head_user_id === user.id) return true;
  return !!user.is_head_chef && !!user.department_id && user.department_id === dept.id;
}

export function canSeeDept(user: SessionUser, deptId: string, all: Map<string, DeptLite>): boolean {
  if (canSeeAllDeptStock(user)) return true;
  if (allowedDeptIds(user).has(deptId)) return true;
  return canSendFrom(user, all.get(deptId));
}

export function canSeeTransfer(user: SessionUser, doc: { from_department_id: string; to_department_id: string }, all: Map<string, DeptLite>): boolean {
  return canSeeDept(user, doc.from_department_id, all) || canSeeDept(user, doc.to_department_id, all);
}

export function isSender(user: SessionUser, doc: { created_by: string }): boolean {
  return String(doc.created_by || '').trim().toLowerCase() === String(user.email || '').trim().toLowerCase();
}

export function canFlagDispute(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>): boolean {
  if (!!user.department_id && user.department_id === doc.to_department_id) return true;
  return canSendFrom(user, all.get(doc.to_department_id));
}

/**
 * Who may CLOSE one open dispute (moves nothing): the person who raised it,
 * managers and admin — and, ONLY ONCE BOTH ENDS HAVE COUNTED the disputed
 * line's material since it moved (dept-ledger line.counted_since.sender AND
 * .receiver), the head of either department too.
 *
 * Why that one extra arm. A claim against your own department is not yours to
 * close while it can still change the books — that is the rule above. Once both
 * shelves have been counted since the transfer, it cannot: both books already
 * say what is on each shelf, and the take-back is REFUSED (reason
 * 'counted_since', or it would correct the books twice). The server's own words
 * then say "close the dispute with a note"; without this arm the Kitchen head
 * was told that and refused it (403), with the dispute sat in his "to settle"
 * list and no button that worked. Measured (the-real-case order.cjs, ORDER=both,
 * re-run as rc-fix order-fix.cjs).
 *
 * `doc` / `all` omitted = the strict rule only (fail closed for any caller that
 * does not pass the document).
 */
export function canDismissDispute(
  user: SessionUser,
  d: Pick<DeptTransferDisputeRow, 'raised_by' | 'status' | 'line_id'>,
  doc?: DeptTransferWithLines,
  all?: Map<string, DeptLite>,
): boolean {
  if (d.status !== 'open') return false;
  if (isAdminOrManager(user)) return true;
  if (String(d.raised_by || '').trim().toLowerCase() === String(user.email || '').trim().toLowerCase()) return true;
  if (!doc || !all) return false;
  const c = doc.lines.find((l) => l.id === d.line_id)?.counted_since;
  if (!c || !c.sender || !c.receiver) return false;
  return canSendFrom(user, all.get(doc.from_department_id)) || canSendFrom(user, all.get(doc.to_department_id));
}

export type ReverseAuthority = 'receiver' | 'disputed_only';

export function reverseAuthority(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>): ReverseAuthority | null {
  if (canSendFrom(user, all.get(doc.to_department_id))) return 'receiver';
  const anyOpen = doc.lines.some((l) => l.qty_open_disputed > 1e-9);
  if (anyOpen && canSendFrom(user, all.get(doc.from_department_id))) return 'disputed_only';
  return null;
}

/** The quantities a ONE-TAP reverse would move for this caller — exactly what
 *  dept-ledger's reverseDeptTransfer() uses when `lines` is omitted, including
 *  leaving out a disputed line that was COUNTED since it moved (reversing it
 *  would correct it twice — dept-ledger "a correction must not correct twice"). */
function reversePrefill(doc: DeptTransferWithLines, authority: ReverseAuthority | null) {
  if (!authority) return [];
  const anyOpen = doc.lines.some((l) => l.qty_open_disputed > 1e-9);
  return doc.lines
    .map((l) => {
      const q = anyOpen ? (l.counted_since ? 0 : l.qty_open_disputed) : (authority === 'receiver' ? l.qty_net : 0);
      const meta = { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor };
      return {
        line_id: l.id,
        material_id: l.material_id,
        material_name: l.material_name,
        quantity: q,
        quantity_purchase: toPurchaseQty(q, meta),
        unit: l.unit,
        purchase_unit: l.purchase_unit || l.unit,
      };
    })
    .filter((p) => p.quantity > 1e-9);
}

/** What the CALLER may do with one document — sent with every document so the
 *  screen shows exactly the buttons the server will accept. */
export function permissionsFor(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>) {
  const authority = reverseAuthority(user, doc, all);
  const prefill = reversePrefill(doc, authority);
  const flaggable = doc.lines.some((l) => l.qty_net > 1e-9
    && !doc.disputes.some((d) => d.line_id === l.id && d.status === 'open'));
  return {
    is_sender: isSender(user, doc),
    can_flag_dispute: doc.status === 'posted' && flaggable && canFlagDispute(user, doc, all),
    can_reverse: doc.status === 'posted' && prefill.length > 0,
    reverse_authority: authority,
    reverse_prefill: prefill,
    /** For someone who could otherwise take a disputed line back: why one or
     *  more disputed lines CANNOT be — counted since it moved — and what to do
     *  instead. The same words the reverse refusal prints. null = nothing blocked. */
    reverse_blocked: authority && doc.status === 'posted' ? deptTransferCountedSinceMessage(doc) : null,
    dismissable_dispute_ids: doc.disputes.filter((d) => canDismissDispute(user, d, doc, all)).map((d) => d.id),
  };
}

/** A document for the wire: the stored rows (RECIPE units, as the ledger keeps
 *  them) plus each quantity in the PURCHASE unit through toPurchaseQty() with
 *  the line's own snapshotted pack factor — the screen leads with these. */
export function presentTransfer(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>) {
  const lineMeta = new Map(doc.lines.map((l) => [l.id, { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor }]));
  return {
    ...doc,
    lines: doc.lines.map((l) => {
      const meta = lineMeta.get(l.id)!;
      return {
        ...l,
        // `quantity` = what this line MOVED (both legs) — one step, so sent IS moved.
        quantity: l.qty_sent,
        quantity_purchase: toPurchaseQty(l.qty_sent, meta),
        qty_sent_purchase: toPurchaseQty(l.qty_sent, meta),
        qty_reversed_purchase: toPurchaseQty(l.qty_reversed, meta),
        qty_net_purchase: toPurchaseQty(l.qty_net, meta),
        qty_open_disputed_purchase: toPurchaseQty(l.qty_open_disputed, meta),
        // The line's snapshotted packFactor() under the PackMeta field name, so a
        // screen can hand the line straight to pack-units' helpers.
        pack_size: l.pack_factor,
      };
    }),
    disputes: doc.disputes.map((d) => {
      const meta = lineMeta.get(d.line_id) || { unit: '', purchase_unit: '', pack_size: 1 };
      const line = doc.lines.find((l) => l.id === d.line_id);
      return {
        ...d,
        material_name: line?.material_name || '',
        qty_disputed_purchase: toPurchaseQty(d.qty_disputed, meta),
        qty_reversed_purchase: toPurchaseQty(d.qty_reversed, meta),
        purchase_unit: line ? (line.purchase_unit || line.unit) : '',
        unit: line?.unit || '',
      };
    }),
    permissions: permissionsFor(user, doc, all),
  };
}

/**
 * RECEIVERS for one sender, in the order the owner ruled: the sender's OWN
 * FAMILY first (its children; or, for a child, its parent and siblings), and
 * within each group the departments where requisitions LAND first — busiest
 * first. Every other active department follows; any may still be chosen.
 *
 * "WHERE REQUISITIONS LAND" IS MEASURED ON THE GOODS THIS SENDER HOLDS. Kitchen
 * hands routed meat / poultry / seafood to the AKAN-* departments that raise
 * the requisitions FOR THOSE GOODS, so the count is requisition LINES for the
 * materials Direct Issue routes to this sender (resolveDirectIssueBulk — the
 * ONE resolver, so a material rule beats a category rule exactly as at
 * receipt). Counting any requisition instead put Akan Security and Akan
 * Stationery (4 and 1 lines of anything, none of it meat) level with Akan
 * Tandoori. A sender nothing is routed to (a sub-kitchen handing stock on)
 * falls back to all requisition lines. Cancelled requisitions never count.
 *
 * `usage_booked_here` repeats the station-mapping fact per receiver (the
 * owner's mapping; read, never edited): false = sales never deduct there.
 */
export function receiversFor(db: Database.Database, fromId: string, all: Map<string, DeptLite>) {
  const from = all.get(fromId);
  if (!from) return [];
  const family = new Set<string>();
  for (const d of all.values()) if (d.parent_id === from.id) family.add(d.id);
  if (from.parent_id) {
    family.add(from.parent_id);
    for (const d of all.values()) if (d.parent_id === from.parent_id) family.add(d.id);
  }
  family.delete(from.id);

  // Materials Direct Issue routes to THIS sender (empty when it routes nothing).
  let routedTo: string[] = [];
  try {
    const ids = (db.prepare(`SELECT DISTINCT material_id FROM requisition_items WHERE TRIM(COALESCE(material_id, '')) <> ''`)
      .all() as Array<{ material_id: string }>).map((r) => String(r.material_id));
    for (const [mid, t] of resolveDirectIssueBulk(db, ids)) if (t.departmentId === from.id) routedTo.push(mid);
  } catch { routedTo = []; }
  const basis: 'routed' | 'all' = routedTo.length > 0 ? 'routed' : 'all';

  const reqs = new Map<string, { n: number; last: string }>();
  try {
    const rows = (basis === 'routed'
      ? db.prepare(`
          SELECT r.department_id, COUNT(*) AS n, MAX(r.date) AS last
            FROM requisition_items ri JOIN requisitions r ON r.id = ri.req_id
           WHERE COALESCE(r.status, '') <> 'cancelled' AND TRIM(COALESCE(r.department_id, '')) <> ''
             AND ri.material_id IN (SELECT value FROM json_each(?))
           GROUP BY r.department_id
        `).all(JSON.stringify(routedTo))
      : db.prepare(`
          SELECT r.department_id, COUNT(*) AS n, MAX(r.date) AS last
            FROM requisition_items ri JOIN requisitions r ON r.id = ri.req_id
           WHERE COALESCE(r.status, '') <> 'cancelled' AND TRIM(COALESCE(r.department_id, '')) <> ''
           GROUP BY r.department_id
        `).all()) as Array<{ department_id: string; n: number; last: string }>;
    for (const r of rows) reqs.set(String(r.department_id), { n: Number(r.n) || 0, last: String(r.last || '') });
  } catch { /* no requisitions table — ordering falls back to family + name */ }
  const mapped = new Set<string>();
  try {
    for (const r of db.prepare(`
      SELECT DISTINCT department_id FROM station_departments WHERE COALESCE(is_active, 1) = 1
    `).all() as Array<{ department_id: string }>) mapped.add(String(r.department_id));
  } catch { /* mapping table absent — every receiver reads "not booked here" */ }

  return [...all.values()]
    .filter((d) => d.id !== from.id && !!Number(d.is_active))
    .map((d) => {
      const rq = reqs.get(d.id);
      const fam = family.has(d.id);
      const lands = !!rq && rq.n > 0;
      return {
        id: d.id,
        name: d.name,
        parent_id: d.parent_id,
        parent_name: d.parent_id ? all.get(d.parent_id)?.name || '' : '',
        family: fam,
        requisitions_land: lands,
        /** Requisition LINES counted for the ordering — see `requisition_basis`. */
        requisition_count: rq?.n || 0,
        /** 'routed' = lines for the materials Direct Issue routes to the sender;
         *  'all' = every line (the sender has nothing routed to it). */
        requisition_basis: basis,
        last_requisition_date: rq?.last || null,
        usage_booked_here: mapped.has(d.id),
        rank: (fam ? 0 : 2) + (lands ? 0 : 1),
      };
    })
    .sort((a, b) => a.rank - b.rank || b.requisition_count - a.requisition_count || a.name.localeCompare(b.name));
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
