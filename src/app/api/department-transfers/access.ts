import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { allowedDeptIds, canSeeAllDeptStock } from '@/lib/dept-stock';
import {
  isDeptTransferBlocked, deptTransferCountedSinceMessage, getDeptTransfer, deptSendableFor,
  type DeptTransferWithLines, type DeptTransferDisputeRow, type TransferEntryUnit, type DeptReverseBasis,
} from '@/lib/dept-ledger';
import { toPurchaseQty } from '@/lib/pack-units';
import { resolveDirectIssueBulk } from '@/lib/direct-issue';
import { isStoreMappedMaterial } from '@/lib/store-engine';

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
 *   (is_head_chef) POSTED to that department or to the department it is a
 *   sub-kitchen of (ruling #40, 2026-10-15: "a head chef sends ONLY from the
 *   department he is posted to (and its sub-kitchens)") — plus managers
 *   (manager tier, NOT an HOD — see isAdminOrManager) and admin.
 *   Nobody else: staff, an HOD posted elsewhere (even on the manager-tier Head
 *   Chef role — a sibling sub-kitchen or a child is "elsewhere"), the NAMED
 *   head (head_user_id) of a parent department, can_approve_requisitions.
 *
 * SEE: admin / manager / HOD / store manager see every transfer
 *   (canSeeAllDeptStock — the /api/department-stock rule). Everyone else sees
 *   transfers INTO and OUT OF their own department (and any granted
 *   visible_department_ids), or one they could send from.
 *
 * FLAG A DISPUTE (records + alerts; moves nothing): ruling #61 — anyone ON
 *   the RECEIVING department ALWAYS: posted to it (any tier — staff included,
 *   the owner's words) or its named head, even if they may also send from the
 *   SENDING department; plus managers and admin; plus an HOD who acts for it
 *   as head chef of its parent department, unless he may also send from the
 *   SENDING department (then he is on the side that sent it). canFlagDispute.
 *   Only CLOSING stays barred for anyone who may send from the sender's side.
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
 *   the RECEIVING department (whose claim it is) may close it too — never the
 *   sender's head, and never a person who heads BOTH ends (the Kitchen HOD may
 *   send from Akan Tandoori too, ruling #40): see canDismissDispute.
 *
 * "WAITING ON YOU" (the bell, open_disputes_to_act, the page's "Disputes for
 *   you to settle"): ONE predicate, hasDisputeActionFor() — this person holds
 *   at least one control on an open dispute that the server will ACCEPT (a
 *   close canDismissDispute allows, or a take-back whose prefill moves
 *   something the ledger lets move). Nothing else badges: a count owed
 *   elsewhere is not a control.
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

/**
 * May this person SEND this department's stock (and so act for it)?
 *   · admin, and managers (isAdminOrManager — the HOD flag excluded): any;
 *   · the department's NAMED head (head_user_id): that department only;
 *   · an HOD (is_head_chef) POSTED to it (users.department_id), or posted to
 *     the department it is a SUB-KITCHEN of (its parent_id) — ruling #40: "a
 *     head chef sends ONLY from the department he is posted to (and its
 *     sub-kitchens)". So the HOD posted to Kitchen sends from Kitchen and
 *     from Akan Tandoori, Akan Main Kitchen …; the HOD posted to Akan Tandoori
 *     sends from Akan Tandoori only (never its parent, never a sibling).
 * One level, as the department tree is (Settings → Departments nests once).
 */
export function canSendFrom(
  user: Pick<SessionUser, 'id' | 'role' | 'is_head_chef' | 'department_id'>,
  dept: DeptLite | null | undefined,
): boolean {
  if (!dept) return false;
  if (isAdminOrManager(user)) return true;
  if (dept.head_user_id && dept.head_user_id === user.id) return true;
  if (!user.is_head_chef || !user.department_id) return false;
  return user.department_id === dept.id || (!!dept.parent_id && user.department_id === dept.parent_id);
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

/**
 * Who may FLAG — ruling #61 (2026-10-22): "anyone on the RECEIVING department
 * can always flag a problem; only CLOSING a dispute stays barred for anyone
 * who can send from the sender's side."
 *   · admin and managers (isAdminOrManager);
 *   · anyone ON the receiving department — POSTED to it (users.department_id,
 *     any tier, staff included: ruling #12) or its NAMED head (head_user_id) —
 *     ALWAYS, even when they may also send from the SENDING department: the
 *     Kitchen HOD flags a short delivery from Akan Pizza although he sends from
 *     that sub-kitchen too (ruling #40), and a parent department's HOD flags on
 *     a child-to-parent transfer (Akan Tandoori → Kitchen, Akan Bar → Bar);
 *   · whoever else may send from the receiving department — an HOD posted to
 *     the department it is a sub-kitchen of (ruling #40) — unless they may also
 *     send from the SENDING department. Such a person is not ON the receiving
 *     department: the HOD posted to Kitchen, on Kitchen → Akan Tandoori, is
 *     posted to the side that SENT it (ruling #12: senders send, the receiving
 *     side flags) and may send it back himself (reverseAuthority 'receiver');
 *     on Akan Pizza → Akan Tandoori (two of his sub-kitchens) Akan Tandoori's
 *     own people flag it. This is the round-2/3 rule for him, unchanged.
 * isOnReceivingDept() is the "ON the receiving department" test, shared with
 * the dispute route's refusal words.
 *
 * Round 3 put the sender check FIRST for everyone, which took "Flag a problem"
 * away from receivers who also head the sender (dispute-who-reverify: the HOD
 * posted to Kitchen on Akan Tandoori → Kitchen, the HOD posted to Bar on Akan
 * Bar → Bar, a named head of Kitchen posted to Akan Tandoori on Kitchen → Akan
 * Tandoori). #61 gives it back to them.
 *
 * What a sender may NOT do stays on CLOSING (canDismissDispute, unchanged):
 * apart from managers and admin, a person who may send from the sending
 * department never closes someone else's dispute on it — the HOD flag keeps
 * him out of the manager arm (isAdminOrManager) and the "both counted" arm
 * refuses him. Two consequences to know:
 *   · a line holds ONE open dispute, so whoever flags first owns the line until
 *     the claim is sent back, taken back or closed (a second flag is 409);
 *   · canDismissDispute's first arm lets the person who RAISED a claim withdraw
 *     it ("Withdraw my claim"), and that includes a receiver who also heads the
 *     sender — his own claim, never someone else's. Measured (flag-61 silence
 *     S10/S11): such a person can flag 0.001 kg first (201), a cook's real claim
 *     on that line is then 409, and he can withdraw his own (200). Barring that
 *     too is one line: the sender check above the flagger arm in
 *     canDismissDispute (and ../resolve's CLOSE_WHO words with it).
 */
export function canFlagDispute(user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>): boolean {
  if (isAdminOrManager(user)) return true;
  if (isOnReceivingDept(user, doc, all)) return true;
  if (canSendFrom(user, all.get(doc.from_department_id))) return false;
  return canSendFrom(user, all.get(doc.to_department_id));
}

/** ON the receiving department (ruling #61): posted to it (any tier), or its
 *  named head (departments.head_user_id). NOT an HOD who acts for it only as
 *  the head chef of the department it is a sub-kitchen of — see canFlagDispute. */
export function isOnReceivingDept(
  user: Pick<SessionUser, 'id' | 'department_id'>,
  doc: Pick<DeptTransferWithLines, 'to_department_id'>,
  all: Map<string, DeptLite>,
): boolean {
  if (!!user.department_id && user.department_id === doc.to_department_id) return true;
  const to = all.get(doc.to_department_id);
  return !!to?.head_user_id && to.head_user_id === user.id;
}

/**
 * Who may CLOSE one open dispute (moves nothing): the person who raised it,
 * managers and admin — and, ONLY ONCE BOTH ENDS HAVE COUNTED the disputed
 * line's material since it moved (dept-ledger line.counted_since.sender AND
 * .receiver), whoever may send from the RECEIVING department (its head, an HOD
 * posted there) too. NEVER the sending department's head on that ground.
 *
 * Why the one extra arm. Once both shelves have been counted since the
 * transfer, both books already say what is on each shelf, the take-back is
 * REFUSED (reason 'counted_since', or it would correct the books twice), and
 * the server's own words say "close the dispute with a note". The claim is the
 * RECEIVER's, so its own head may then close it when the cook who raised it is
 * off shift.
 *
 * Why NOT the sender's head. A claim against your own department is not yours
 * to close — and "both counted" is something the sender's head can make true
 * alone: the closing-stock API lets him count the RECEIVER's department too.
 * Measured with the arm open to either head (rc-v2 edge.cjs SC=silence): the
 * Kitchen head counted Akan Tandoori at its book figure (4, shelf 3.5) and
 * Kitchen at 6 (shelf 6.5), then closed Tandoori's claim against Kitchen
 * (200); the managers' to-act count fell to 0 with both books wrong. The
 * sender's head still sees the dispute and the server's words (who closes it);
 * a manager, the flagger or the receiver's head closes it.
 *
 * Why NOT a person who heads BOTH ends either. "The receiver's head" is
 * canSendFrom(to_department), and one person can pass it for BOTH ends: the
 * HOD posted to Kitchen sends from its sub-kitchen Akan Tandoori too (ruling
 * #40), and one user can be the named head of two departments. Such a person
 * IS the sender's head, so the arm refuses anyone who may send from the
 * SENDING department — whatever else they head. (Round 2 left this open: the
 * Kitchen HOD counted both departments through /api/closing-stock and closed
 * Tandoori's claim against Kitchen — the silence exploit by another door.)
 * Managers and admin are not affected (they returned above), nor is the
 * flagger withdrawing their own claim.
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
  // Never anyone who may send from the SENDING department — a head of both
  // ends included. See "Why NOT a person who heads BOTH ends" above.
  if (canSendFrom(user, all.get(doc.from_department_id))) return false;
  // The RECEIVER's side only — see "Why NOT the sender's head" above.
  return canSendFrom(user, all.get(doc.to_department_id));
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
  // WHAT the one tap means, not only how much: 'disputed' = it settles the open
  // claim (the goods never reached the receiver's shelf — a correction on
  // paper); 'standing' = no claim is open, so it returns goods that are on the
  // receiver's shelf. The page echoes it back with the quantities (`expect`):
  // a claim of the WHOLE line that someone else closed leaves the same
  // quantity on offer with the opposite meaning (dept-ledger "A STALE TAP
  // MOVES NOTHING").
  const basis: DeptReverseBasis = anyOpen ? 'disputed' : 'standing';
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
        basis,
      };
    })
    .filter((p) => p.quantity > 1e-9);
}

/**
 * THE ONE RULE FOR "THIS DISPUTE IS WAITING ON YOU".
 *
 * The controls this person holds on ONE document's OPEN dispute(s) that the
 * server will ACCEPT — nothing else:
 *   · take_back: the one-tap reverse settles the claim — reverseAuthority()
 *     gives them authority AND reversePrefill() would actually move something
 *     (a disputed line counted since it moved is left out of the prefill and
 *     the reverse refuses it, 'counted_since', so it is NOT a control) AND the
 *     ledger would let that prefill move: the original RECEIVER still holds it
 *     by dept-ledger's own deptSendableFor() (the figure the send check
 *     refuses on, 'insufficient') and the original sender is still switched on
 *     ('inactive_department'). Measured without this: Tandoori sent 3.8 of
 *     its 4 kg on, the take-back of the disputed 0.5 was refused 409, and
 *     the Kitchen head's bell still said 1. And each material may still ride
 *     the department rail (materialRidesDeptRail: it exists, and it is not
 *     store-mapped NOW — 'unknown_material' / 'store_mapped');
 *   · close_ids: the open disputes canDismissDispute() lets them close (the
 *     flagger withdrawing, a manager / admin, the receiving head — not a head
 *     of the sending end — once both have counted).
 * Both POST routes first require canSeeTransfer(), so it is required here too.
 *
 * hasDisputeActionFor() (any control at all) is what the BELL counts
 * (notify.ts openDisputesToActFor), what GET /api/department-transfers returns
 * as open_disputes_to_act (countDisputesToAct) and what the page lists under
 * "Disputes for you to settle" (permissions.dispute_to_act). One predicate, so
 * a badge always opens a page with a button the server accepts, and a dispute
 * someone can settle is never left unbadged. A count owed on the other shelf
 * (the take-back refused because one side counted) is NOT a control here: the
 * document still shows the server's words (reverse_blocked) to whoever acts
 * for it, but it badges only the people who can close it.
 */
export interface DisputeActions {
  take_back: boolean;
  close_ids: string[];
}

/**
 * May this material still move between departments? The two questions
 * dept-ledger's writer (postDeptTransferInTxn, and sendDeptTransfer before it)
 * asks of a material before it looks at any quantity, asked the same way:
 *   · the raw material still exists (transferMaterial → 'unknown_material');
 *   · it is NOT store-mapped NOW — store-engine isStoreMappedMaterial(), the
 *     very function storeRailBlock() calls (→ 'store_mapped', 409).
 * The store map is read live, so a material that BECAME store-mapped after it
 * moved — the owner re-categorises a liquor-looking item in Raw Materials
 * (ruling #6), or Settings → Stores maps its category — can no longer be sent
 * back at all. Measured without this (bell-page verifier, store_mapped): every
 * head holding only a take-back was badged 1 on a dispute whose take-back was
 * refused 409 'store_mapped', with no other control — a badge nobody could
 * clear. A manager, admin or the flagger still closes it (canDismissDispute).
 * FAILS CLOSED like storeRailBlock(): if the map cannot be read the writer
 * refuses, so the take-back is not counted as a control.
 */
function materialRidesDeptRail(db: Database.Database, materialId: string): boolean {
  const id = String(materialId || '');
  try {
    if (!db.prepare('SELECT 1 FROM raw_materials WHERE id = ?').get(id)) return false;
    return !isStoreMappedMaterial(db, id);
  } catch { return false; }
}

/**
 * Would the one-tap reverse's prefill get past the ledger's send checks? The
 * reverse is an ordinary send from the ORIGINAL RECEIVER back to the ORIGINAL
 * SENDER through the same writer (dept-ledger resolveEnds + the "sender must
 * hold it" check per line), so this asks the same two questions with the same
 * functions: both ends exist and the one receiving it back is switched on;
 * and the original receiver can send each material's prefilled total by
 * deptSendableFor() — the very figure the writer refuses on. Lines of one
 * material are summed, as the writer posts them one after another. Before any
 * quantity, the writer's material checks (materialRidesDeptRail below): one
 * line refused refuses the whole tap, so one store-mapped line is enough.
 */
function prefillPassesLedger(
  db: Database.Database, doc: DeptTransferWithLines, all: Map<string, DeptLite>,
  prefill: ReturnType<typeof reversePrefill>,
): boolean {
  const backTo = all.get(doc.from_department_id);
  if (!backTo || !all.has(doc.to_department_id) || !Number(backTo.is_active)) return false;
  const need = new Map<string, number>();
  for (const p of prefill) need.set(p.material_id, (need.get(p.material_id) || 0) + p.quantity);
  for (const [materialId, q] of need) {
    if (!materialRidesDeptRail(db, materialId)) return false;
    const want = Math.round(q * 1e6) / 1e6;
    if (want > deptSendableFor(db, doc.to_department_id, materialId).available + 1e-9) return false;
  }
  return true;
}

function disputeActions(
  db: Database.Database, user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>,
  authority: ReverseAuthority | null, prefill: ReturnType<typeof reversePrefill>,
): DisputeActions {
  const none: DisputeActions = { take_back: false, close_ids: [] };
  if (doc.status !== 'posted' || doc.dispute_status !== 'open') return none;
  if (!doc.disputes.some((d) => d.status === 'open')) return none;
  if (!canSeeTransfer(user, doc, all)) return none;
  // The reverse settles a claim only when a line has an open disputed amount —
  // then the prefill IS the disputed amounts (never the whole line).
  const anyOpen = doc.lines.some((l) => l.qty_open_disputed > 1e-9);
  return {
    take_back: anyOpen && !!authority && prefill.length > 0 && prefillPassesLedger(db, doc, all, prefill),
    close_ids: doc.disputes.filter((d) => canDismissDispute(user, d, doc, all)).map((d) => d.id),
  };
}

export function disputeActionsFor(
  db: Database.Database, user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>,
): DisputeActions {
  const authority = reverseAuthority(user, doc, all);
  return disputeActions(db, user, doc, all, authority, reversePrefill(doc, authority));
}

/** THE predicate: this person holds at least one control on an open dispute of
 *  this document that the server will accept. See DisputeActions above. */
export function hasDisputeActionFor(
  db: Database.Database, user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>,
): boolean {
  const a = disputeActionsFor(db, user, doc, all);
  return a.take_back || a.close_ids.length > 0;
}

/** Open-dispute transfers waiting on this person (hasDisputeActionFor), every
 *  one of them — no page limit. The ids, newest first. Never throws ([] on a
 *  failure: a bell must never break the inbox). */
export function disputesToActIds(db: Database.Database, user: SessionUser, all?: Map<string, DeptLite>): string[] {
  try {
    const depts = all || loadDepartments(db);
    const rows = db.prepare(`
      SELECT id FROM department_transfers WHERE dispute_status = 'open' ORDER BY created_at DESC, rowid DESC
    `).all() as Array<{ id: string }>;
    const out: string[] = [];
    for (const { id } of rows) {
      const doc = getDeptTransfer(db, id);
      if (doc && hasDisputeActionFor(db, user, doc, depts)) out.push(doc.id);
    }
    return out;
  } catch { return []; }
}

/** The bell's and open_disputes_to_act's figure: transfers (not lines) with an
 *  open dispute this person can settle. */
export function countDisputesToAct(db: Database.Database, user: SessionUser, all?: Map<string, DeptLite>): number {
  return disputesToActIds(db, user, all).length;
}

/** What the CALLER may do with one document — sent with every document so the
 *  screen shows exactly the buttons the server will accept. */
export function permissionsFor(
  user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>, db: Database.Database,
) {
  const authority = reverseAuthority(user, doc, all);
  const prefill = reversePrefill(doc, authority);
  const flaggable = doc.lines.some((l) => l.qty_net > 1e-9
    && !doc.disputes.some((d) => d.line_id === l.id && d.status === 'open'));
  const acts = disputeActions(db, user, doc, all, authority, prefill);
  return {
    is_sender: isSender(user, doc),
    can_flag_dispute: doc.status === 'posted' && flaggable && canFlagDispute(user, doc, all),
    can_reverse: doc.status === 'posted' && prefill.length > 0,
    reverse_authority: authority,
    /** What the one-tap Send back / Take back moves NOW, and what it means
     *  (`basis`: 'disputed' settles the open claim, 'standing' returns goods).
     *  The page echoes it back on the tap as `expect` ({ line_id, quantity,
     *  basis } — this recipe-unit `quantity`, unconverted); the reverse refuses
     *  ('stale', 409) when either has changed since, e.g. someone else settled
     *  or closed the claim (dept-ledger "A STALE TAP MOVES NOTHING"). */
    reverse_prefill: prefill,
    /** For someone who could otherwise take a disputed line back: why one or
     *  more disputed lines CANNOT be — counted since it moved — and what to do
     *  instead. The same words the reverse refusal prints. null = nothing blocked. */
    reverse_blocked: authority && doc.status === 'posted' ? deptTransferCountedSinceMessage(doc) : null,
    dismissable_dispute_ids: doc.disputes.filter((d) => canDismissDispute(user, d, doc, all)).map((d) => d.id),
    /** THE predicate (hasDisputeActionFor): an open dispute here is waiting on
     *  this person — they hold a take-back or a close the server accepts. The
     *  page's "Disputes for you to settle" lists exactly these; the bell and
     *  open_disputes_to_act count exactly these. */
    dispute_to_act: acts.take_back || acts.close_ids.length > 0,
  };
}

/** A document for the wire: the stored rows (RECIPE units, as the ledger keeps
 *  them) plus each quantity in the PURCHASE unit through toPurchaseQty() with
 *  the line's own snapshotted pack factor — the screen leads with these.
 *  `db` is for permissions.dispute_to_act (the take-back's ledger check). */
export function presentTransfer(
  user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>, db: Database.Database,
) {
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
    permissions: permissionsFor(user, doc, all, db),
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
