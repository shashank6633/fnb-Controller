/**
 * BILL ON HOLD — WHO MAY DO WHAT
 * ==============================
 *
 * ONE FILE DECIDES, and every /api/boh route calls it. The reason is the same
 * one src/lib/settle-authority.ts states in its own header: when two surfaces
 * each carry their own copy of an authority rule, they drift, and the looser
 * one becomes the bypass.
 *
 * ⚠️ proxy.ts GUARDS PAGES, NOT APIs, and canAccessPage FAILS OPEN four ways.
 * Measured on the owner's live data: role_id is set on 0 of 9 users and
 * page_access is NULL on 8 (NULL = all pages), so page gating is effectively
 * inert in production. EVERY ROUTE'S OWN CHECK IS THE ONLY REAL GATE. Nothing
 * in this module may rely on the proxy having already refused anyone.
 *
 * ── THE THREE TIERS, AND WHY THEY DIFFER ─────────────────────────────────────
 *
 * 1. ACT ON A BOH (create · capture a payment · log a follow-up · reassign)
 *    → settleAuthority(), THE SAME CALL the hold route makes, unchanged.
 *    Rationale: hold already lets that person decide what the bill will cost —
 *    it writes the sales rows, deducts the stock and freezes the totals.
 *    Collecting against a bill someone already finalised is strictly LESS
 *    power than finalising it. Reusing the function means the two can never
 *    drift, which is exactly the failure settle-authority.ts exists to prevent.
 *
 * 2. CLOSE A BOH THAT STILL CARRIES A BALANCE → isManagement(), STRICTER than
 *    hold. Hold is a forward commitment a cashier makes with a guest standing
 *    there; a non-zero close is the WRITE-OFF OF AN ACCOUNTABILITY RECORD ABOUT
 *    THAT CASHIER. Letting the responsible user close their own outstanding
 *    bill removes the only thing this module is for. A zero-balance close is
 *    NOT this tier — that is arithmetic, done by the system inside
 *    recordBohPayment(), not judgement.
 *    VOID is stricter still: admin only.
 *
 * 3. SEE A BOH → three tiers, per the brief's sensitivity note. A bill carries
 *    money AND a customer's phone number.
 *      · own BOH bills            — any till-capable user
 *      · cross-user lists, the accountability view, every money TOTAL
 *                                 — isManagement()
 *    ⚠️ GET /api/dine-in/orders?status=on_hold (orders/route.ts:7-31) has no
 *    gate beyond a session and returns o.* — guest_name, guest_mobile, total,
 *    the lot — to any signed-in user. The BOH list APIs must NOT copy that
 *    shape. That route is outside this lane and /cashier depends on it; it is
 *    not retrofitted here.
 *
 * ── NO NEW ROLES ─────────────────────────────────────────────────────────────
 * There is no "Accounts" role and no "Supervisor" role. Live roles are
 * Administrator, Manager, Floor Manager, Bar Manager, Head Chef, Store Manager,
 * Captain, Cashier, Staff. Production config is the owner's — never create one.
 */
import type Database from 'better-sqlite3';
import { isManagement, type SessionUser } from './auth';
import { settleAuthority, tillCapable, type SettleActor } from './settle-authority';
import type { BohView } from './boh';

export interface BohDecision {
  allowed: boolean;
  /** A sentence fit to show on screen, naming the person to ask where relevant. */
  message: string;
  status: 200 | 401 | 403;
  /** Extra facts a refusal carries, so the UI can offer check-in instead of a bare 403. */
  detail?: Record<string, unknown>;
}

const OK: BohDecision = { allowed: true, message: '', status: 200 };

const actorOf = (me: SessionUser): SettleActor => ({
  id: me.id, name: me.name, email: me.email, role: me.role,
  role_name: me.role_name, page_access: me.page_access, is_head_chef: me.is_head_chef,
});

/**
 * Management FOR THIS MODULE: the app's own isManagement() — Admin, any Manager,
 * or an HOD — AND able to open the module at all.
 *
 * ── WHY THE SECOND HALF IS NOT REDUNDANT ─────────────────────────────────────
 * isManagement() counts `is_head_chef`, which is a PER-USER column independent
 * of the role tier; tillCapable() (canUseBoh below) counts admin/manager TIER,
 * or staff with an explicit /cashier grant. A staff-tier user carrying
 * is_head_chef fell in the gap between them, and the module used both predicates
 * in different places — so that person was refused READ access to a BOH with a
 * 403 and could still WRITE OFF its balance and REASSIGN it. Measured, live: a
 * staff-tier HOD wrote off Rs 216 on a record they could not open, and could not
 * see the register their own write-off appeared on.
 *
 * One predicate, both halves, and the strict half wins. Not exploitable on the
 * owner's data today (no live user is staff-tier with is_head_chef), but
 * is_head_chef is a tick box in Settings and the shape can appear at any time.
 */
export function bohIsManagement(me: SessionUser | null): boolean {
  return isManagement(me) && canUseBoh(me);
}

/**
 * May this user open the BOH module at all?
 *
 * tillCapable(): management always; staff ONLY with an EXPLICIT page_access map
 * containing /cashier. A NULL map does NOT pass here — deliberately stricter
 * than page-catalog's canAccessPage, because with role_id NULL on every user a
 * null-map test passes literally everyone (settle-authority.ts:70-84, review
 * defect D5). That strictness is the whole reason this is the right predicate
 * for a module holding customer phone numbers and money.
 */
export function canUseBoh(me: SessionUser | null): boolean {
  if (!me) return false;
  return tillCapable(actorOf(me));
}

/**
 * May this user ACT on this BOH — record a payment, log a follow-up, reassign?
 *
 * Delegates to settleAuthority() against the BOH's own order, so the answer is
 * byte-for-byte the answer the hold and settle routes would give for the same
 * bill on the same floor. If the owner changes who may settle, this changes
 * with it and cannot be left behind.
 */
export function canActOnBoh(
  db: Database.Database,
  me: SessionUser | null,
  boh: Pick<BohView, 'order_id' | 'responsible_user_id'>,
  outletId?: string | null,
): BohDecision {
  if (!me) return { allowed: false, message: 'Sign in required', status: 401 };
  const order = db.prepare('SELECT id, table_id, outlet_id, status FROM orders WHERE id = ?').get(boh.order_id) as any;
  if (!order) {
    // The bill is gone but the accountability record is not. Fall back to the
    // module's own floor-less rule rather than failing open: the debt still has
    // to be chased by someone, and management must always be able to reach it.
    return canUseBoh(me)
      ? OK
      : { allowed: false, message: 'Your role does not include the Cashier page, so you cannot act on a bill on hold.', status: 403 };
  }
  const a = settleAuthority(db, actorOf(me), order, outletId);
  if (a.allowed) return OK;
  return {
    allowed: false,
    message: a.message,
    status: a.status,
    detail: {
      reason: a.reason, floor: a.floor, floorName: a.floorName,
      cashier: a.cashier ? { userId: a.cashier.userId, userName: a.cashier.userName } : null,
      offerCheckIn: a.offerCheckIn, offerTakeOver: a.offerTakeOver,
    },
  };
}

/**
 * Reassignment has ONE extra door beyond canActOnBoh: the CURRENT responsible
 * user may always hand their own bill on, even if they have since left the
 * floor it sits on. Passing a debt to the person who will actually chase it is
 * not a till operation, and someone who cannot reach the bill cannot be held
 * accountable for it either.
 */
export function canReassignBoh(
  db: Database.Database,
  me: SessionUser | null,
  boh: Pick<BohView, 'order_id' | 'responsible_user_id'>,
  outletId?: string | null,
): BohDecision {
  if (!me) return { allowed: false, message: 'Sign in required', status: 401 };
  if (bohIsManagement(me)) return OK;
  if (me.id && me.id === boh.responsible_user_id) return OK;
  return canActOnBoh(db, me, boh, outletId);
}

/**
 * May this user SEE this particular BOH?
 *
 * Management sees everything. Anyone else sees the bills they are responsible
 * for, and the bills they created. Not "anyone till-capable sees everything":
 * a BOH carries a customer's name, number and an amount owed.
 */
export function canViewBoh(me: SessionUser | null, boh: Pick<BohView, 'responsible_user_id' | 'created_by'>): boolean {
  if (!me) return false;
  if (bohIsManagement(me)) return true;
  if (!canUseBoh(me)) return false;
  if (me.id && me.id === boh.responsible_user_id) return true;
  const email = String(me.email || '').toLowerCase();
  return !!email && String(boh.created_by || '').toLowerCase() === email;
}

/**
 * The scope filter a LIST or DASHBOARD must be built with.
 *
 * Returns null for management — no restriction. Returns the caller's own user
 * id for everyone else, which listBoh()/bohDashboard() turn into
 * `responsible_user_id = ?`. Returning the id rather than a boolean means a
 * route cannot forget to apply it and still compile a sensible query: the value
 * IS the filter.
 */
export function bohScopeFor(me: SessionUser | null): string | null {
  if (!me) return '';                    // matches nothing
  return bohIsManagement(me) ? null : String(me.id || '');
}

/** May this user close a BOH that still carries a balance? Management only. */
export function canCloseBoh(me: SessionUser | null): BohDecision {
  if (!me) return { allowed: false, message: 'Sign in required', status: 401 };
  if (bohIsManagement(me)) return OK;
  return {
    allowed: false,
    status: 403,
    message:
      'Only a manager or admin can close a bill on hold that still has money outstanding. ' +
      'Closing it is a write-off of an accountability record — record the payment instead, or ask a manager.',
  };
}

/** May this user void a BOH, or reverse a recorded payment? Admin only. */
export function canVoidBoh(me: SessionUser | null): BohDecision {
  if (!me) return { allowed: false, message: 'Sign in required', status: 401 };
  if (me.role === 'admin') return OK;
  return { allowed: false, status: 403, message: 'Only an administrator can void a BOH record or reverse a recorded payment.' };
}

/** May this user see cross-user money totals and the accountability table? */
export function canSeeBohTotals(me: SessionUser | null): BohDecision {
  if (!me) return { allowed: false, message: 'Sign in required', status: 401 };
  if (bohIsManagement(me)) return OK;
  return { allowed: false, status: 403, message: 'The user-wise accountability view is management only.' };
}
