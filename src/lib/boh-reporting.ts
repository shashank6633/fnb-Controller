/**
 * BILL ON HOLD — THE REPORTING LAYER (dashboard + user-wise accountability)
 * =========================================================================
 *
 * WHERE THIS LANE'S CODE LIVES, AND WHY IT IS HERE AND NOT IN db.ts.
 * Nothing in this file touches src/lib/db.ts. db.ts already carries four other
 * lanes' uncommitted hunks (butchering flags, the party_issue migration, the
 * gated liquor block, the store bill-handover fleet); a fifth would make every
 * one of them harder to review and impossible to revert separately. This is a
 * NEW LEAF FILE — it imports from ./boh and ./boh-schema and is imported only
 * by the two read-only routes and the two pages that need it.
 *
 * ── THE ONE RULE THIS FILE MUST NOT BREAK ───────────────────────────────────
 * IT ONLY READS. There is no INSERT, UPDATE or DELETE anywhere below, and no
 * call into anything that writes. That is deliberate and load-bearing: a BOH
 * payment is a payment record, not a sale — revenue and stock were already
 * booked the moment the bill was held (src/lib/station-master.ts:430) — and a
 * REPORT has no business anywhere near that rail. The money rule is enforced
 * inside src/lib/boh.ts's write paths; this file simply never goes there.
 *
 * ── "MISSED" MEANS EXACTLY ONE THING ────────────────────────────────────────
 * This screen judges people, so the definition cannot have two spellings. Every
 * followup_state on every figure below comes from ONE place: the
 * FOLLOWUP_STATE_SQL fragment inside src/lib/boh.ts, read through listBoh().
 * This file does not re-derive it, does not re-spell it in SQL, and cannot
 * drift from the register screen or the reminder job, because it is not a
 * second opinion — it is the same value, counted.
 *
 *     MISSED  = the BOH is still open, its current expected payment date is
 *               BEFORE today (IST), and no follow-up was recorded against that
 *               date.
 *     DUE     = the same, with the date being today. A due follow-up becomes
 *               missed at IST midnight if nothing is logged.
 *     OVERDUE = the date has passed AND a follow-up WAS logged against it —
 *               chased, still unpaid. A different management problem, and never
 *               counted as a miss.
 *
 * ── IST, EVERYWHERE ─────────────────────────────────────────────────────────
 * Every date comparison anchors to bohToday() (Asia/Kolkata). date('now') is
 * UTC and rolls at 05:30 IST, which would mark bills "overdue" for the five and
 * a half hours before the owner's day starts.
 *
 * ── VOIDS ARE NEVER IN SCOPE ────────────────────────────────────────────────
 * A voided BOH is a record created in error, not a debt. listBoh() excludes it
 * by default and the routes never pass status='void', so no figure here can
 * ever include one. The status filter offers open/closed only, for that reason.
 */
import type Database from 'better-sqlite3';
import { bohToday, daysBetween, listBoh, money2, type BohView } from './boh';

/* ════════════════════════════ THE FILTER ══════════════════════════════════ */

export interface BohReportFilter {
  /** Bill date (the day the bill was held), IST YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  /** Expected payment date range, IST YYYY-MM-DD. */
  expFrom?: string | null;
  expTo?: string | null;
  /** Bill number · customer name · company · mobile (10-digit key aware). */
  q?: string | null;
  /** One responsible user. */
  responsibleUserId?: string | null;
  /** 'open' | 'closed'. Never 'void' — see the header. */
  status?: string | null;
  /** 'due' | 'missed' | 'overdue' | 'scheduled' */
  followupState?: string | null;
  /** 'due_today' | 'overdue' | 'partially_paid' | 'contact_missing' | 'reconcile' */
  bucket?: string | null;
  /** Bill amount (the frozen principal), inclusive. */
  amountMin?: number | null;
  amountMax?: number | null;
  /** Whole days past the expected payment date, inclusive. 0 = due today. */
  overdueMin?: number | null;
  overdueMax?: number | null;
  outletId?: string | null;
}

const S = (v: unknown): string => String(v ?? '').trim();
const isDate = (s: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

function numOrNull(v: string | null): number | null {
  if (v == null || S(v) === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Only these two. 'void' is deliberately unreachable from the query string. */
const FILTERABLE_STATUS = new Set(['open', 'closed']);
const FILTERABLE_FOLLOWUP = new Set(['due', 'missed', 'overdue', 'scheduled']);
const FILTERABLE_BUCKET = new Set(['due_today', 'overdue', 'partially_paid', 'contact_missing', 'reconcile', 'no_date']);

/**
 * Read the filter off a URL. Anything unrecognised is DROPPED rather than
 * passed through — a query string is client-supplied and this module feeds a
 * management screen, so the set of things it can ask for is closed.
 */
export function parseBohReportFilter(u: URL): BohReportFilter {
  const p = u.searchParams;
  const status = S(p.get('status'));
  const followup = S(p.get('followup'));
  const bucket = S(p.get('bucket'));
  return {
    from: isDate(p.get('from')) ? S(p.get('from')) : null,
    to: isDate(p.get('to')) ? S(p.get('to')) : null,
    expFrom: isDate(p.get('exp_from')) ? S(p.get('exp_from')) : null,
    expTo: isDate(p.get('exp_to')) ? S(p.get('exp_to')) : null,
    q: S(p.get('q')) || null,
    responsibleUserId: S(p.get('user')) || null,
    status: FILTERABLE_STATUS.has(status) ? status : null,
    followupState: FILTERABLE_FOLLOWUP.has(followup) ? followup : null,
    bucket: FILTERABLE_BUCKET.has(bucket) ? bucket : null,
    amountMin: numOrNull(p.get('amt_min')),
    amountMax: numOrNull(p.get('amt_max')),
    overdueMin: numOrNull(p.get('overdue_min')),
    overdueMax: numOrNull(p.get('overdue_max')),
  };
}

/** True when the caller narrowed anything at all. Drives the empty state's wording. */
export function filterIsActive(f: BohReportFilter): boolean {
  return !!(f.from || f.to || f.expFrom || f.expTo || f.q || f.responsibleUserId ||
            f.status || f.followupState || f.bucket ||
            f.amountMin != null || f.amountMax != null ||
            f.overdueMin != null || f.overdueMax != null);
}

/* ═════════════════════════════ THE ROW SET ════════════════════════════════ */

/** Whole days the bill is past its expected payment date. null = no date set. */
export function overdueDaysOf(r: BohView, today: string): number | null {
  const d = S(r.expected_payment_date);
  if (!isDate(d)) return null;
  return daysBetween(d, today);
}

const PAGE = 1000;
/** 50 pages of 1,000. Far beyond anything this module can plausibly hold, and a
 *  hard stop rather than an unbounded read if it ever is. */
const MAX_PAGES = 50;

export interface BohRowSet {
  rows: BohView[];
  /** True when the hard cap was hit — the screen says so rather than lying. */
  truncated: boolean;
  today: string;
}

/**
 * Every BOH row matching the filter.
 *
 * The listBoh() call carries the filters SQL can express (and therefore the
 * followup_state definition, unchanged). The three the list API does not
 * express — expected-date range, bill amount, overdue days — are applied here,
 * on rows listBoh already shaped, rather than by writing a second query that
 * would need its own copy of PAID_SQL / BALANCE_SQL / FOLLOWUP_STATE_SQL. One
 * definition, one place.
 *
 * Paging is deduped by id: listBoh's ORDER BY is not unique on its last key, so
 * an OFFSET page boundary can in principle repeat a row. Collapsing on the
 * primary key makes a repeat harmless.
 */
export function loadBohReportRows(db: Database.Database, f: BohReportFilter): BohRowSet {
  const today = bohToday();
  const byId = new Map<string, BohView>();
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = listBoh(db, {
      responsibleUserId: f.responsibleUserId || null,
      status: f.status || null,          // null → listBoh's own "status <> 'void'"
      outletId: f.outletId || null,
      followupState: f.followupState || null,
      bucket: f.bucket === 'no_date' ? null : (f.bucket || null),
      from: f.from || null,
      to: f.to || null,
      q: f.q || null,
      limit: PAGE,
      offset: page * PAGE,
    });
    for (const r of batch) byId.set(r.id, r);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  let rows = Array.from(byId.values());

  // ── The filters SQL did not carry ────────────────────────────────────────
  if (f.expFrom) rows = rows.filter(r => isDate(r.expected_payment_date) && r.expected_payment_date >= f.expFrom!);
  if (f.expTo)   rows = rows.filter(r => isDate(r.expected_payment_date) && r.expected_payment_date <= f.expTo!);
  if (f.amountMin != null) rows = rows.filter(r => Number(r.principal_amount) >= f.amountMin!);
  if (f.amountMax != null) rows = rows.filter(r => Number(r.principal_amount) <= f.amountMax!);
  if (f.overdueMin != null || f.overdueMax != null) {
    rows = rows.filter(r => {
      const d = overdueDaysOf(r, today);
      if (d == null) return false;              // no promised date → not an overdue age
      if (f.overdueMin != null && d < f.overdueMin) return false;
      if (f.overdueMax != null && d > f.overdueMax) return false;
      return true;
    });
  }
  // 'no_date' is this module's own bucket — the bills that can never be due,
  // overdue or missed because nobody promised a date. They are the one way a
  // debt hides from an accountability screen, so they are filterable.
  if (f.bucket === 'no_date') {
    rows = rows.filter(r => r.status === 'open' && !isDate(r.expected_payment_date));
  }

  return { rows, truncated, today };
}

/* ═══════════════════════════ THE DASHBOARD ════════════════════════════════ */

export interface BohDashboardFigures {
  /** Every figure below counts ONLY the rows the filter selected. */
  rows_in_view: number;
  total_boh_amount: number;
  total_pending_bills: number;
  pending_amount: number;
  due_today_count: number;
  due_today_amount: number;
  overdue_count: number;
  overdue_amount: number;
  /** The oldest overdue bill in view, in whole days. 0 when nothing is overdue. */
  worst_overdue_days: number;
  followups_due: number;
  followups_missed: number;
  followups_missed_amount: number;
  /** Identical, by construction, to due_today_amount — the balance the bills
   *  dated today are expected to bring in. Named separately because the owner
   *  named it separately; the UI says they are one figure. */
  payments_expected_today: number;
  payments_received_today: number;
  payments_received_total: number;
  partially_paid_count: number;
  partially_paid_amount: number;
  closed_count: number;
  closed_paid_in_full: number;
  written_off_count: number;
  written_off_amount: number;
  /** Open bills with no expected payment date — invisible to due/overdue/missed. */
  no_date_count: number;
  no_date_amount: number;
  /** Open bills with no phone number: nobody can chase these at all. */
  contact_missing_count: number;
  /** Open BOH whose POS bill is no longer 'on_hold' — needs a human. */
  reconcile_needed_count: number;
}

const sum = (xs: number[]): number => money2(xs.reduce((a, b) => a + (Number(b) || 0), 0));

/**
 * Every figure the owner named, computed from one row set so no two can
 * disagree. Each one is a plain filter over `rows` — deliberately readable
 * rather than clever, because this is the screen that has to be defensible.
 */
export function computeBohDashboard(
  db: Database.Database,
  set: BohRowSet,
): BohDashboardFigures {
  const { rows, today } = set;
  const open = rows.filter(r => r.status === 'open');
  const closed = rows.filter(r => r.status === 'closed');

  const dueToday = open.filter(r => r.expected_payment_date === today);
  const overdue = open.filter(r => {
    const d = overdueDaysOf(r, today);
    return d != null && d > 0;
  });
  const missed = open.filter(r => r.followup_state === 'missed');
  const noDate = open.filter(r => overdueDaysOf(r, today) == null);
  const partial = open.filter(r => r.paid_amount > 0 && r.balance_amount > 0);

  // Payments received TODAY, for the bills in view. Read straight from the
  // append-only ledger rather than inferred from a balance, because a balance
  // cannot say WHEN the money arrived.
  const idSet = new Set(rows.map(r => r.id));
  let receivedToday = 0;
  try {
    const paid = db.prepare(
      `SELECT boh_id AS id, amount FROM boh_payments WHERE paid_on = ?`,
    ).all(today) as { id: string; amount: number }[];
    for (const p of paid) if (idSet.has(String(p.id))) receivedToday += Number(p.amount) || 0;
  } catch {
    // The table is absent on a database where the schema never applied. The
    // route has already reported that as a 503; a zero here is not a lie about
    // money because there is no ledger to be wrong about.
    receivedToday = 0;
  }

  const worstOverdue = overdue.reduce((mx, r) => Math.max(mx, overdueDaysOf(r, today) ?? 0), 0);

  return {
    rows_in_view: rows.length,
    // What was EVER put on hold in this view — open plus closed, principal.
    total_boh_amount: sum(rows.map(r => r.principal_amount)),
    total_pending_bills: open.length,
    pending_amount: sum(open.map(r => r.balance_amount)),
    due_today_count: dueToday.length,
    due_today_amount: sum(dueToday.map(r => r.balance_amount)),
    overdue_count: overdue.length,
    overdue_amount: sum(overdue.map(r => r.balance_amount)),
    worst_overdue_days: worstOverdue,
    followups_due: open.filter(r => r.followup_state === 'due').length,
    followups_missed: missed.length,
    followups_missed_amount: sum(missed.map(r => r.balance_amount)),
    payments_expected_today: sum(dueToday.map(r => r.balance_amount)),
    payments_received_today: money2(receivedToday),
    payments_received_total: sum(rows.map(r => r.paid_amount)),
    partially_paid_count: partial.length,
    partially_paid_amount: sum(partial.map(r => r.balance_amount)),
    closed_count: closed.length,
    closed_paid_in_full: closed.filter(r => r.close_kind === 'paid_in_full').length,
    written_off_count: closed.filter(r => r.close_kind === 'write_off').length,
    written_off_amount: sum(closed.filter(r => r.close_kind === 'write_off').map(r => r.balance_amount)),
    no_date_count: noDate.length,
    no_date_amount: sum(noDate.map(r => r.balance_amount)),
    contact_missing_count: open.filter(r => !S(r.customer_mobile)).length,
    reconcile_needed_count: open.filter(r => r.reconcile_needed).length,
  };
}

/* ═══════════════════════ USER-WISE ACCOUNTABILITY ═════════════════════════ */

export interface BohAccountabilityUser {
  user_id: string;
  user_name: string;
  user_email: string;
  /** Open bills currently assigned to this person. */
  total_assigned: number;
  total_assigned_amount: number;
  pending_amount: number;
  overdue_count: number;
  overdue_amount: number;
  /** Whole days of the person's oldest overdue bill. 0 when none is overdue. */
  oldest_overdue_days: number;
  followups_due: number;
  followups_missed: number;
  followups_missed_amount: number;
  /**
   * MONEY THIS PERSON ACTUALLY TOOK, attributed from boh_payments.created_by —
   * the email of whoever recorded each collection — over the bills in view.
   *
   * It used to be sum(paid_amount) of the bills they CURRENTLY HOLD, which is a
   * different question and answered it wrongly even with no reassignment at
   * all: a bill Priya collected Rs 200 on and a manager later collected Rs 300
   * on credited the manager with all 500 and Priya with nothing. Worse, because
   * a reassignment moves the bill, the figure was retroactively editable — a
   * closed, fully-collected record handed to somebody else moved the whole
   * 'Collected' column onto a person who collected none of it.
   */
  payments_collected: number;
  /** The OLD figure, kept as its own column because it is a real (different)
   *  question: how much has been recovered on the bills this person is now
   *  carrying, whoever took it. */
  collected_on_assigned_bills: number;
  /** True when this person appears ONLY because they collected money — they
   *  hold no bill in this view. Without it they would vanish from the table and
   *  their collections with them. */
  collector_only?: boolean;
  /** ACTIVITY, not assignment: follow-ups THIS PERSON logged in the last 30
   *  days, on any bill. This is the column that answers "who is actively
   *  following up". */
  followups_logged_30d: number;
  /** The most recent follow-up they logged, anywhere. '' = never. */
  last_followup_at: string;
  /** How many of their open bills were handed to them by somebody else. The
   *  number that keeps the rest of the row defensible. */
  inherited_count: number;
  /** Open bills with no expected date — they cannot be due, overdue or missed,
   *  so they must be shown or the row understates the person's load. */
  no_date_count: number;
  contact_missing_count: number;
}

/**
 * The user-wise view. MANAGEMENT ONLY — the route enforces it; this function
 * just computes.
 *
 * ATTRIBUTION RULE, stated because this table judges people: every
 * assignment-shaped figure belongs to the CURRENT responsible user. A
 * reassignment moves future accountability without erasing the past — who held
 * the bill and when is in boh_assignments, append-only, and `inherited_count`
 * surfaces on this very row how much of the load arrived from someone else.
 * The two ACTIVITY columns are attributed differently and deliberately: they
 * count what the person themselves logged, by email, wherever they logged it.
 */
export function computeBohAccountability(
  db: Database.Database,
  set: BohRowSet,
): BohAccountabilityUser[] {
  const { rows, today } = set;
  const byUser = new Map<string, BohView[]>();
  for (const r of rows) {
    const k = S(r.responsible_user_id);
    const list = byUser.get(k);
    if (list) list.push(r); else byUser.set(k, [r]);
  }

  // ── Activity, read once for everybody ────────────────────────────────────
  // created_by on boh_followups is the actor's EMAIL (src/lib/boh.ts's
  // addFollowUp), so this joins on a lower-cased email, not on a user id.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const logged = new Map<string, { n: number; last: string }>();
  try {
    const act = db.prepare(`
      SELECT lower(TRIM(created_by)) AS who,
             SUM(CASE WHEN substr(created_at,1,10) >= ? THEN 1 ELSE 0 END) AS n30,
             MAX(created_at) AS last_at
        FROM boh_followups
       WHERE TRIM(created_by) <> ''
       GROUP BY lower(TRIM(created_by))
    `).all(since) as { who: string; n30: number; last_at: string }[];
    for (const a of act) logged.set(S(a.who), { n: Number(a.n30) || 0, last: S(a.last_at) });
  } catch { /* no ledger yet — every user reads 0 / never, which is true */ }

  // ── WHO ACTUALLY TOOK THE MONEY, read once for everybody ─────────────────
  // boh_payments.created_by is the collector's EMAIL (recordBohPayment and
  // absorbTillSettleIntoBoh both write it), so this joins on a lower-cased email
  // exactly as the activity block above does. Scoped to the BOH ids in view, so
  // a filtered screen's totals still reconcile to its own rows. Reversals carry
  // a NEGATIVE amount and are attributed to whoever reversed them, which is
  // right: the sum is money that person is holding responsibility for now.
  const collectedBy = new Map<string, { amount: number; name: string }>();
  const idsInView = new Set(rows.map(r => S(r.id)));
  try {
    const pays = db.prepare(`
      SELECT boh_id, lower(TRIM(created_by)) AS who, MAX(created_by_name) AS who_name, SUM(amount) AS amt
        FROM boh_payments WHERE TRIM(created_by) <> ''
       GROUP BY boh_id, lower(TRIM(created_by))
    `).all() as { boh_id: string; who: string; who_name: string; amt: number }[];
    for (const p of pays) {
      if (!idsInView.has(S(p.boh_id))) continue;
      const k = S(p.who);
      const cur = collectedBy.get(k) || { amount: 0, name: S(p.who_name) };
      cur.amount += Number(p.amt) || 0;
      if (!cur.name) cur.name = S(p.who_name);
      collectedBy.set(k, cur);
    }
  } catch { /* no ledger yet — everybody collected nothing, which is true */ }

  // ── Inherited bills, read once for everybody ─────────────────────────────
  const inherited = new Map<string, Set<string>>();
  try {
    const hand = db.prepare(`
      SELECT boh_id, new_user_id FROM boh_assignments WHERE TRIM(prev_user_id) <> ''
    `).all() as { boh_id: string; new_user_id: string }[];
    for (const h of hand) {
      const k = S(h.new_user_id);
      const s = inherited.get(k) || new Set<string>();
      s.add(S(h.boh_id));
      inherited.set(k, s);
    }
  } catch { /* no history yet */ }

  const out: BohAccountabilityUser[] = [];
  for (const [userId, mine] of byUser) {
    const open = mine.filter(r => r.status === 'open');
    const overdue = open.filter(r => (overdueDaysOf(r, today) ?? 0) > 0);
    const missed = open.filter(r => r.followup_state === 'missed');
    const named = mine.find(r => S(r.responsible_name)) || mine[0];
    const email = S(named?.responsible_email).toLowerCase();
    const act = logged.get(email) || { n: 0, last: '' };
    const inh = inherited.get(userId) || new Set<string>();

    out.push({
      user_id: userId,
      user_name: S(named?.responsible_name) || S(named?.responsible_email) || userId || '(unassigned)',
      user_email: S(named?.responsible_email),
      total_assigned: open.length,
      total_assigned_amount: sum(open.map(r => r.principal_amount)),
      pending_amount: sum(open.map(r => r.balance_amount)),
      overdue_count: overdue.length,
      overdue_amount: sum(overdue.map(r => r.balance_amount)),
      oldest_overdue_days: overdue.reduce((mx, r) => Math.max(mx, overdueDaysOf(r, today) ?? 0), 0),
      followups_due: open.filter(r => r.followup_state === 'due').length,
      followups_missed: missed.length,
      followups_missed_amount: sum(missed.map(r => r.balance_amount)),
      payments_collected: money2((collectedBy.get(email)?.amount) || 0),
      collected_on_assigned_bills: sum(mine.map(r => r.paid_amount)),
      followups_logged_30d: act.n,
      last_followup_at: act.last,
      inherited_count: open.filter(r => inh.has(r.id)).length,
      no_date_count: open.filter(r => overdueDaysOf(r, today) == null).length,
      contact_missing_count: open.filter(r => !S(r.customer_mobile)).length,
    });
  }

  // ── PEOPLE WHO COLLECTED BUT HOLD NOTHING ────────────────────────────────
  // Attributing 'Collected' to the collector means somebody who took money on a
  // bill that has since been handed on — or closed — may hold no bill at all
  // now. Dropping them would lose their collections from the table and make the
  // column stop reconciling with the ledger. They appear with zero assignment
  // figures and collector_only set, so nothing about their row can be mistaken
  // for a workload.
  const seenEmails = new Set(out.map(r => S(r.user_email).toLowerCase()).filter(Boolean));
  for (const [email, c] of collectedBy) {
    if (!email || seenEmails.has(email) || Math.abs(c.amount) < 0.005) continue;
    const act = logged.get(email) || { n: 0, last: '' };
    out.push({
      user_id: '', user_name: c.name || email, user_email: email,
      total_assigned: 0, total_assigned_amount: 0, pending_amount: 0,
      overdue_count: 0, overdue_amount: 0, oldest_overdue_days: 0,
      followups_due: 0, followups_missed: 0, followups_missed_amount: 0,
      payments_collected: money2(c.amount),
      collected_on_assigned_bills: 0,
      followups_logged_30d: act.n, last_followup_at: act.last,
      inherited_count: 0, no_date_count: 0, contact_missing_count: 0,
      collector_only: true,
    });
  }

  // Worst first: the person with the most money outstanding, then the most
  // misses. That is the order the owner's question is asked in.
  out.sort((a, b) =>
    (b.pending_amount - a.pending_amount) ||
    (b.followups_missed - a.followups_missed) ||
    a.user_name.localeCompare(b.user_name));
  return out;
}

/** The responsible users present in a row set, for the filter dropdown. Derived
 *  from the rows already on screen, so it needs no second, differently-gated
 *  call to a users API. */
export function responsibleUsersIn(rows: BohView[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const r of rows) {
    const id = S(r.responsible_user_id);
    if (!id) continue;
    if (!m.has(id)) m.set(id, S(r.responsible_name) || S(r.responsible_email) || id);
  }
  return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
