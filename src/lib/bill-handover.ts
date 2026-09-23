/**
 * BILL SUBMISSION QUALITY CHECK — DOMAIN LAYER
 * ============================================
 * Gates, cutoff resolution, queries and mutations. The routes under
 * /api/bill-submissions are thin wrappers over this file; every rule that
 * matters lives here so the two screens (store + accounts) cannot drift apart
 * by re-implementing one of them.
 *
 * Schema, the chosen key, and the cutoff's rationale: src/lib/bill-handover-schema.ts.
 *
 * ── THE THREE RULES THAT MUST NOT BE WEAKENED ───────────────────────────────
 *
 * 1. NOTHING AUTO-CONFIRMS. "Received by Accounts" is only ever reached by
 *    confirmBillHandover(), which requires a live session belonging to a human
 *    who passes canConfirmBillHandover(). There is no scheduler, no backfill, no
 *    "if submitted more than N days ago" rule, and no code path that writes
 *    status='received' other than that one function. The whole feature exists to
 *    answer "did Accounts actually get this bill" — a machine-set confirmation is
 *    a lie in the exact place the owner asked for the truth.
 *
 * 2. THE SUBMITTER CANNOT CONFIRM THEIR OWN SUBMISSION. Enforced server-side in
 *    confirmBillHandover() against BOTH created_by_id and submitted_by_id, with
 *    no admin exemption. Two people or it is not evidence.
 *
 * 3. NOTHING BEFORE THE CUTOFF IS EVER PENDING. Pending Submission is read only
 *    from bill_handovers (which starts empty), AND bounded by received_date >=
 *    the recorded cutoff, AND refused at creation. A missing cutoff means the
 *    register is NOT READY and every list returns empty — the fail-closed
 *    direction, because the failure being defended against is a 2,121-item
 *    day-one backlog of months-old bills.
 *
 * ── THE "ACCOUNTS" ROLE ─────────────────────────────────────────────────────
 * Decision 2: the Accounts view is gated on a role the owner will create himself
 * in Settings -> Roles. It DOES NOT EXIST YET (live roles: Administrator, Bar
 * Manager, Floor Manager, Head Chef, Manager, Store Manager, Captain, Cashier,
 * Staff). We never create a role — production config is his.
 *
 * So the gate matches the role by NAME, case-insensitively, off the session field
 * that getCurrentUser() already resolves (auth.ts:120). See isAccountsUser() for
 * the landmine that shape avoids.
 */
import type Database from 'better-sqlite3';
import { getDb, generateId } from './db';
import { isManagement, type SessionUser } from './auth';
import {
  BH_PENDING,
  BH_SUBMITTED,
  BH_RECEIVED,
  BH_VOID,
  BH_STATUS_LABEL,
  type BillHandoverStatus,
  ensureBillHandoverSchema,
  getBillHandoverCutoff,
  getBillHandoverCutoffCommittedAt,
  billHandoverCutoffAnchor,
} from './bill-handover-schema';

export {
  BH_PENDING,
  BH_SUBMITTED,
  BH_RECEIVED,
  BH_VOID,
  BH_STATUS_LABEL,
  BH_STATUS_SHORT,
  BH_FILE_MAX_BYTES,
  type BillHandoverStatus,
} from './bill-handover-schema';

/** The exact role name the owner must type in Settings -> Roles. One word. */
export const ACCOUNTS_ROLE_NAME = 'Accounts';

/* ════════════════════════════════════════════════════════════════════════════
   GATES
   ════════════════════════════════════════════════════════════════════════════ */

/** trim -> collapse internal whitespace -> lowercase. */
function normName(v: unknown): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Does this user hold the role named "Accounts"?
 *
 * Reads the ALREADY-RESOLVED session field. No database lookup, so "no such role
 * exists" is not even a case: when the role does not exist every user has
 * role_id NULL -> role_name null -> normName(null) === '' -> false. Fails closed
 * by construction.
 *
 * THE LANDMINE THIS AVOIDS — do not "simplify" it back into an id comparison:
 *
 *     const acc = db.prepare("SELECT id FROM roles WHERE lower(name)='accounts'")
 *                   .get()?.id ?? null;
 *     if (me.role_id === acc) { ... }        // CATASTROPHIC
 *
 * Measured on the live database: role_id is NULL on 9 of 9 users and no role is
 * named Accounts, so that lookup returns nothing and the test becomes
 * null === null — true for every signed-in user in the building.
 *
 * Case-insensitive EQUALITY, not `includes`. store-engine.ts:320 uses
 * `.toLowerCase().includes('bar manager')`, which a role named "No Accounts
 * Access" would pass; service-charge/route.ts:50 uses `role_name === 'Cashier'`,
 * which a role typed "accounts" would silently fail. This is the middle.
 *
 * TWO CONSEQUENCES, stated rather than discovered later:
 *  · getCurrentUser() joins roles WITHOUT `is_active = 1` (auth.ts:101, and the
 *    comment there explains why — a deactivated role must keep governing, else
 *    its users fall back to page_access NULL = every page). So DEACTIVATING the
 *    Accounts role does NOT revoke confirm rights. That is consistent with how
 *    every other role behaves here; to actually revoke, unassign the role from
 *    the user in Settings -> Users.
 *  · An admin renaming an existing role to "Accounts" hands that role's holders
 *    the Accounts side. Acceptable — renaming roles is an admin-only action —
 *    but it is the one way this gate can be widened without anyone creating
 *    anything.
 */
export function isAccountsUser(u: Pick<SessionUser, 'role_name'> | null | undefined): boolean {
  return !!u && normName(u.role_name) === normName(ACCOUNTS_ROLE_NAME);
}

/**
 * Who may click "Confirm Received".
 *
 * Decision 2's fail-safe: admin keeps the Accounts side alive on day one, when
 * the role does not exist yet and the feature would otherwise be dead on
 * arrival. NOTHING ELSE. Deliberately not isManagement(), not the manager tier,
 * not is_store_manager, and no "if the role is missing, let managers in"
 * fallback — a widened fallback is indistinguishable from the bug it is meant to
 * paper over.
 *
 * Note this is the ONLY place the tier is consulted at all for the Accounts side.
 * If the owner creates "Accounts" at manager tier, its holders silently become
 * management everywhere else in the app (isManagement passes every manager tier,
 * which reaches /reports/sales, /hr/employees and the rest). That is why the
 * on-screen instructions say tier: Staff.
 */
export function canConfirmBillHandover(u: SessionUser | null | undefined): boolean {
  if (!u) return false;
  return u.role === 'admin' || isAccountsUser(u);
}

/**
 * Who may record a bill and mark it submitted — the STORE side.
 *
 * Membership mirrors poWriteGate() (src/lib/po-helpers.ts:51,
 * `isManagement(user) || user.is_store_manager`), because that is already the
 * set of people who receive a delivery, and the prompt lives inside the store
 * half of that receiving flow's quality check. Anyone who can create the GRN
 * must be able to record its handover, or the register acquires rows nobody is
 * allowed to fill in.
 *
 * AN ACCOUNTS-ROLE HOLDER IS REFUSED HERE, by name, even if the owner creates
 * the role at manager tier. That makes rule 2 structural rather than merely
 * per-row: the accounts team does not receive goods, and the audit trail is only
 * worth something if the two ends are two different jobs. Admin is exempt (the
 * day-one operator must be able to work both sides) but an admin still cannot
 * confirm a bill they themselves recorded or submitted — see
 * selfConfirmRefusal().
 */
export function canRecordBillHandover(u: SessionUser | null | undefined): boolean {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (isAccountsUser(u)) return false;
  return isManagement(u) || u.is_store_manager;
}

/**
 * Who may READ the register.
 *
 * The owner: "Store Manager AND Accounts can both track the whole handover
 * history." So it is the union of the two working sets — and nothing wider.
 * Bill values and vendor terms are commercial data; this is not a page for every
 * signed-in captain and cashier, and the proxy does not gate API GETs at all
 * (src/proxy.ts guards PAGES), so this function is the whole boundary.
 */
export function canViewBillHandovers(u: SessionUser | null | undefined): boolean {
  return canRecordBillHandover(u) || canConfirmBillHandover(u);
}

/** Who may VOID a row that Accounts has already confirmed. Admin only: undoing a
 *  recorded confirmation is undoing the evidence itself. */
export function canVoidConfirmedBillHandover(u: SessionUser | null | undefined): boolean {
  return !!u && u.role === 'admin';
}

/**
 * RULE 2, the separation of duties. Returns a refusal reason, or null if this
 * user may confirm this row.
 *
 * Checks BOTH ends of the store side: whoever created the record and whoever
 * pressed "Submitted to Accounts". Either one disqualifies. No admin exemption —
 * the point of the feature is that two people saw the bill, and an admin
 * confirming their own submission produces exactly the "confusion about whether
 * the bill was actually handed over" the owner is trying to end.
 *
 * Identity is compared on the USER ID, not the name or email: names repeat and
 * an email can be edited, while users.id is the stable identity the session
 * carries.
 */
export function selfConfirmRefusal(
  row: { created_by_id?: string; submitted_by_id?: string; submitted_by_name?: string },
  u: SessionUser,
): string | null {
  const submitter = String(row.submitted_by_id ?? '');
  const creator = String(row.created_by_id ?? '');
  if (submitter && submitter === u.id) {
    return 'You submitted this bill, so you cannot also confirm that Accounts received it. Ask someone else on the Accounts side to confirm.';
  }
  if (creator && creator === u.id) {
    return 'You recorded this bill on the store side, so you cannot also confirm that Accounts received it. Ask someone else on the Accounts side to confirm.';
  }
  return null;
}

/** A short description of the actor's effective role, stamped into the audit
 *  trail so the history still reads correctly after a role is renamed or a user
 *  is reassigned. */
export function actorRoleLabel(u: SessionUser): string {
  return u.role_name ? `${u.role_name} (${u.role})` : u.role;
}

/* ── The Accounts-role banner (DIAGNOSIS ONLY, never the gate) ────────────── */

export interface AccountsRoleState {
  exists: boolean;
  is_active: boolean;
  /** The role's name as actually stored, so a stray space or case shows up. */
  stored_name: string;
  /** Every live role name, so a typo is self-diagnosing on screen. */
  all_role_names: string[];
}

/**
 * Is there a role named "Accounts"? For the on-screen banner ONLY.
 *
 * NEVER feed this into a permission decision. isAccountsUser() is the gate, and
 * it reads the session — this reads the roles table, and a roles-table lookup
 * that returns nothing is precisely the shape that produced the null === null
 * landmine documented on isAccountsUser().
 */
export function accountsRoleState(db: Database.Database): AccountsRoleState {
  try {
    const rows = db.prepare('SELECT name, is_active FROM roles ORDER BY name').all() as {
      name: string;
      is_active: number;
    }[];
    const hit = rows.find((r) => normName(r.name) === normName(ACCOUNTS_ROLE_NAME));
    return {
      exists: !!hit,
      is_active: !!hit && !!hit.is_active,
      stored_name: hit?.name ?? '',
      all_role_names: rows.map((r) => r.name),
    };
  } catch {
    return { exists: false, is_active: false, stored_name: '', all_role_names: [] };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   THE CUTOFF
   ════════════════════════════════════════════════════════════════════════════ */

export interface CutoffState {
  /** 'YYYY-MM-DD' business date, or null when never seeded. */
  date: string | null;
  /** UTC instant the stamp was written — the evidence it never moved. */
  committed_at: string | null;
  /** false = the register is NOT READY. Every list returns empty. */
  ready: boolean;
  /** Plain words for the screens. The owner asked that they say where this starts. */
  notice: string;
}

/**
 * Resolve the cutoff once per request. THE single place "what does a missing
 * cutoff mean" is decided, so the two screens and four routes cannot answer it
 * differently.
 *
 * ready=false returns EMPTY lists and zero counts. It never returns "everything"
 * — an unbounded Pending list is the 2,121-item day-one backlog.
 */
export function cutoffState(db: Database.Database): CutoffState {
  const date = getBillHandoverCutoff(db);
  const committed_at = getBillHandoverCutoffCommittedAt(db);
  const anchor = billHandoverCutoffAnchor(db);

  // THE TWO COPIES DISAGREE. Something moved the start date of a register that
  // is already in service, and this module cannot tell which copy is the
  // original — so it serves NEITHER. Reading through the settings value would
  // hide bills; reading through the anchor would contradict what the screens
  // printed yesterday. Held closed, with both dates named so the owner can see
  // what happened and settle it deliberately.
  if (anchor.diverged) {
    return {
      date: null,
      committed_at,
      ready: false,
      notice:
        `This register is closed because its start date does not match its own record: the app setting says ` +
        `${anchor.settings_date}, the register's write-once anchor says ${anchor.anchor_date}` +
        `${anchor.anchor_committed_at ? ` (fixed ${anchor.anchor_committed_at})` : ''}. ` +
        `The start date was changed outside the app. No bills are shown until the two agree — nothing has been ` +
        `deleted, and ${anchor.recorded_rows} recorded bill(s) are intact. Restore the anchor's date to reopen it.`,
    };
  }

  if (!date) {
    // BOTH COPIES GONE ON A REGISTER THAT HAS RUN. The old text here said
    // "Restart the app once; nothing is lost" — advice that was actively
    // dangerous, because restarting is precisely what used to mint a NEW start
    // date from today. It no longer does (seedBillHandoverCutoff refuses), so
    // the screen must stop promising that a restart fixes it.
    if (anchor.lost) {
      return {
        date: null,
        committed_at,
        ready: false,
        notice:
          `This register is closed: its start date is missing from BOTH places that hold it, and ` +
          `${anchor.recorded_rows} bill(s) have already been recorded against it. A new start date has ` +
          `deliberately NOT been invented — doing so would silently change which bills this register covers. ` +
          `Restarting will not fix it. Restore the database backup, or have whoever deploys set the original ` +
          `date back. No recorded bill has been lost.`,
      };
    }
    return {
      date: null,
      committed_at,
      ready: false,
      notice:
        'This register is not ready yet — its start date has not been recorded. Restart the app once; nothing is lost. No bills are shown until then.',
    };
  }
  return {
    date,
    committed_at,
    ready: true,
    notice: `This register covers vendor bills received on or after ${date}. Bills received before that date are deliberately not tracked here — the owner's instruction was to start forward, not to review past bills.`,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   ROW SHAPE + READS
   ════════════════════════════════════════════════════════════════════════════ */

export interface BillHandoverRow {
  id: string;
  source: string;
  grn_id: string | null;
  grn_number: string;
  invoice_id: string;
  bill_no: string;
  vendor_id: string;
  vendor_name: string;
  bill_date: string;
  received_date: string;
  bill_value: number;
  outlet_id: string | null;
  status: BillHandoverStatus;
  created_by_id: string;
  created_by_name: string;
  created_by_email: string;
  created_at: string;
  submitted_by_id: string;
  submitted_by_name: string;
  submitted_by_email: string;
  submitted_at: string | null;
  confirmed_by_id: string;
  confirmed_by_name: string;
  confirmed_by_email: string;
  confirmed_at: string | null;
  voided_by_id: string;
  voided_by_name: string;
  voided_at: string | null;
  void_reason: string;
  note: string;
  cutoff_date: string;
  updated_at: string;
  /** Joined, not stored: does this row carry a bill scan? */
  attachment_count?: number;
}

export interface BillHandoverEvent {
  id: string;
  handover_id: string;
  action: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  actor_name: string;
  actor_email: string;
  actor_role: string;
  note: string;
  at: string;
}

/** Every column of bill_handovers plus the attachment count. The BLOB never
 *  rides a JSON response — it is fetched separately by the attachment route. */
const ROW_SELECT = `
  SELECT h.*,
         (SELECT COUNT(*) FROM bill_handover_files f WHERE f.handover_id = h.id) AS attachment_count
    FROM bill_handovers h`;

export interface ListFilters {
  status?: BillHandoverStatus | 'all' | 'open';
  from?: string;
  to?: string;
  vendor?: string;
  q?: string;
  include_void?: boolean;
  page?: number;
  pageSize?: number;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * The handover history — what the owner asked both the Store Manager and
 * Accounts to be able to track: bill number, vendor, value, the store submission
 * timestamp, the accounts confirmation timestamp, and the current status.
 *
 * EVERY read is bounded by `received_date >= cutoff`. Not because the table
 * could contain an older row (creation refuses those), but because a filter that
 * is present in one place and absent in another is how a "forward only" promise
 * quietly stops being true. One bound, applied here, inherited by every caller.
 */
export function listBillHandovers(
  db: Database.Database,
  f: ListFilters = {},
): { rows: BillHandoverRow[]; total: number; cutoff: CutoffState } {
  const cutoff = cutoffState(db);
  if (!cutoff.ready || !cutoff.date) return { rows: [], total: 0, cutoff };

  const where: string[] = ['h.received_date >= ?'];
  const params: unknown[] = [cutoff.date];

  const status = f.status ?? 'all';
  if (status === 'open') {
    where.push(`h.status IN (?, ?)`);
    params.push(BH_PENDING, BH_SUBMITTED);
  } else if (status !== 'all') {
    where.push('h.status = ?');
    params.push(status);
  } else if (!f.include_void) {
    // 'all' means all the LIVE ones. A voided row is audit, not a bill in flight;
    // it is reachable with include_void=1 and on the record's own history.
    where.push('h.status <> ?');
    params.push(BH_VOID);
  }

  if (isIsoDate(f.from)) {
    where.push('h.received_date >= ?');
    params.push(f.from);
  }
  if (isIsoDate(f.to)) {
    where.push('h.received_date <= ?');
    params.push(f.to);
  }
  if (f.vendor) {
    where.push('(h.vendor_id = ? OR lower(h.vendor_name) = lower(?))');
    params.push(f.vendor, f.vendor);
  }
  if (f.q) {
    const like = `%${String(f.q).trim().toLowerCase()}%`;
    where.push(
      `(lower(h.bill_no) LIKE ? OR lower(h.vendor_name) LIKE ? OR lower(h.grn_number) LIKE ? OR lower(h.invoice_id) LIKE ?)`,
    );
    params.push(like, like, like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  // parseInt, not Number — a float reaching LIMIT/OFFSET trips SQLite's
  // "datatype mismatch" 500 (the crm-calls convention).
  const page = Math.max(1, parseInt(String(f.page ?? 1), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(f.pageSize ?? 50), 10) || 50));

  // COUNT shares the exact WHERE + params so total and rows can never disagree.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM bill_handovers h ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `${ROW_SELECT} ${whereSql}
        ORDER BY h.received_date DESC, h.created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as BillHandoverRow[];

  return { rows, total: totalRow?.n ?? 0, cutoff };
}

export function getBillHandover(db: Database.Database, id: string): BillHandoverRow | null {
  const row = db.prepare(`${ROW_SELECT} WHERE h.id = ?`).get(id) as BillHandoverRow | undefined;
  return row ?? null;
}

export function getBillHandoverTrail(db: Database.Database, id: string): BillHandoverEvent[] {
  return db
    .prepare('SELECT * FROM bill_handover_events WHERE handover_id = ? ORDER BY at ASC, rowid ASC')
    .all(id) as BillHandoverEvent[];
}

/* ── The dashboard ───────────────────────────────────────────────────────── */

export interface BillHandoverSummary {
  cutoff: CutoffState;
  counts: Record<BillHandoverStatus, number>;
  values: Record<BillHandoverStatus, number>;
  /**
   * Deliveries received on/after the cutoff that have NO handover record at all.
   *
   * A SEPARATE FIGURE, deliberately NOT folded into Pending Submission. It is the
   * leak detector: a GRN whose store person skipped the quality-check prompt.
   * Folding it into Pending would make Pending a derived query over
   * goods_receipt_notes, and a derived Pending is exactly the mechanism that
   * could one day surface the historical backlog. Pending stays a pure read of
   * rows that were deliberately created.
   *
   * On the owner's real data this is 0: all 29 GRNs are dated 2026-08-07, long
   * before any realistic cutoff.
   */
  not_yet_recorded: number;
  oldest_pending_date: string | null;
  oldest_submitted_date: string | null;
}

export function billHandoverSummary(db: Database.Database): BillHandoverSummary {
  const cutoff = cutoffState(db);
  const counts = { [BH_PENDING]: 0, [BH_SUBMITTED]: 0, [BH_RECEIVED]: 0, [BH_VOID]: 0 } as Record<
    BillHandoverStatus,
    number
  >;
  const values = { [BH_PENDING]: 0, [BH_SUBMITTED]: 0, [BH_RECEIVED]: 0, [BH_VOID]: 0 } as Record<
    BillHandoverStatus,
    number
  >;

  if (!cutoff.ready || !cutoff.date) {
    return {
      cutoff,
      counts,
      values,
      not_yet_recorded: 0,
      oldest_pending_date: null,
      oldest_submitted_date: null,
    };
  }

  const grouped = db
    .prepare(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(bill_value), 0) AS v
         FROM bill_handovers
        WHERE received_date >= ?
        GROUP BY status`,
    )
    .all(cutoff.date) as { status: string; n: number; v: number }[];
  for (const g of grouped) {
    if (g.status in counts) {
      counts[g.status as BillHandoverStatus] = g.n;
      values[g.status as BillHandoverStatus] = g.v;
    }
  }

  // The leak detector. Voided GRNs are excluded — a cancelled receipt has no bill
  // to hand over. NOT EXISTS ignores voided handovers so a voided-then-not-redone
  // record correctly reappears as unrecorded.
  const leak = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM goods_receipt_notes g
        WHERE g.date >= ?
          AND COALESCE(g.voided_at, '') = ''
          AND NOT EXISTS (
                SELECT 1 FROM bill_handovers h
                 WHERE h.grn_id = g.id AND h.status <> ?
              )`,
    )
    .get(cutoff.date, BH_VOID) as { n: number };

  const oldest = (status: BillHandoverStatus): string | null => {
    const r = db
      .prepare(
        `SELECT MIN(received_date) AS d FROM bill_handovers
          WHERE status = ? AND received_date >= ?`,
      )
      .get(status, cutoff.date) as { d: string | null };
    return r?.d ?? null;
  };

  return {
    cutoff,
    counts,
    values,
    not_yet_recorded: leak?.n ?? 0,
    oldest_pending_date: oldest(BH_PENDING),
    oldest_submitted_date: oldest(BH_SUBMITTED),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
   WRITES
   ════════════════════════════════════════════════════════════════════════════ */

function logEvent(
  db: Database.Database,
  p: {
    handover_id: string;
    action: string;
    from_status?: string;
    to_status?: string;
    actor: SessionUser;
    note?: string;
  },
): void {
  db.prepare(
    `INSERT INTO bill_handover_events
       (id, handover_id, action, from_status, to_status, actor_id, actor_name, actor_email, actor_role, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    generateId(),
    p.handover_id,
    p.action,
    p.from_status ?? '',
    p.to_status ?? '',
    p.actor.id,
    p.actor.name || '',
    p.actor.email || '',
    actorRoleLabel(p.actor),
    p.note ?? '',
  );
}

/** Append an audit event from outside this module (the attachment route). */
export function recordBillHandoverEvent(
  db: Database.Database,
  handoverId: string,
  action: string,
  actor: SessionUser,
  note = '',
): void {
  try {
    logEvent(db, { handover_id: handoverId, action, actor, note });
  } catch (e) {
    console.error('bill_handover event log failed:', e);
  }
}

export type BhResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; extra?: unknown };

export interface CreateInput {
  grn_id?: string;
  bill_no?: string;
  invoice_id?: string;
  vendor_id?: string;
  vendor_name?: string;
  bill_date?: string;
  received_date?: string;
  bill_value?: number;
  outlet_id?: string | null;
  note?: string;
  /** Mark it submitted in the same call — the store person is handing the bill
   *  over right now. Still a deliberate human act, never a default. */
  submit_now?: boolean;
  /** Manual path only: proceed despite a same vendor + bill no + date match. */
  confirm_duplicate?: boolean;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * THE VENDOR'S BILL FACE VALUE FOR ONE GOODS RECEIPT — what is owed the vendor,
 * not what was booked as cost. Summed from the GRN's own LINES, because the GRN
 * line IS the bill document. `grnRef` is a SQL reference to the receipt id: '?'
 * for a bound parameter, or a column like 'g.id' inside a correlated subquery.
 *
 * 2026-09-18. This used to be `SELECT SUM(total_price) FROM purchases WHERE
 * grn_id = ?` and it was wrong by 21.6% of the money. A PO-receive `purchases`
 * row is a deliberately TAX-FREE COST MIRROR: the receive route binds discount
 * to the literal 0 (the discount is already inside the net rate) and binds no
 * cgst/sgst at all, because tax there would poison average_price and destroy the
 * input credit — src/lib/purchase-bill-summary.ts §4 records the measurement,
 * SUM(cgst + sgst) = 0 and SUM(discount) = 0 across every mirror row. The tax,
 * the cess and the gross discount live on the GRN LINE.
 *
 * MEASURED on the live snapshot, over all 29 goods receipts: the mirror sums to
 * Rs 25,280.00 where the bills say Rs 30,732.20 — 28 of the 29 individually
 * wrong. That is byte-for-byte the bug this codebase already found and fixed
 * once, on 2026-09-10, on these same 29 receipts; the register had re-summed the
 * very table that module warns about.
 *
 * IT MATTERS MORE HERE THAN ANYWHERE ELSE IN THE APP. bill_value is written ONCE
 * at creation and nothing ever recomputes it (the three UPDATE statements in
 * this file touch status and stamps only), and the register is forward-only with
 * no backfill — so a row written wrong stays wrong for ever. And the feature
 * exists so the store and Accounts reconcile against the SAME number as the
 * paper in the receiver's hand: both receiving doors already show that number
 * before this row is written (purchase-orders/page.tsx `tax.billTotal`, whose
 * own comment reads "what is actually owed the vendor", and grn/page.tsx
 * `bill.totalInward`).
 *
 * The expression is deliberately character-identical to the GRN list's
 * `inward_value` (src/app/api/grn/route.ts:557-560) and to the per-line
 * `total_inward_amount` on the detail read (:348-351) — what the screens print
 * as "Inward" and what the inward register totals. quantity_RECEIVED, not
 * accepted: the vendor billed for what he delivered, and a rejection is settled
 * by a debit note, not by pretending the bill said less. Keep the three in step.
 */
const bhGrnBillValueSql = (grnRef: string): string => `
  SELECT COALESCE(ROUND(SUM(quantity_received * unit_price
                            - discount + cgst + sgst + compensation_cess
                            + special_excise_cess + tcs
                            + delivery_charges + mrp_round_off), 2), 0) AS t
    FROM goods_receipt_note_items
   WHERE grn_id = ${grnRef}`;

/** The tax-free cost mirror. ONLY a fallback for a receipt whose lines are gone
 *  (a repair, a half-finished void) — never the figure when lines exist. */
const bhMirrorValueSql = (grnRef: string): string =>
  `SELECT COALESCE(SUM(total_price), 0) AS t FROM purchases WHERE grn_id = ${grnRef}`;

/**
 * Record a vendor bill handover.
 *
 * SOURCE. grn_id present -> source='grn', and the GRN is the key. Identity is
 * read FROM THE GRN, not from whatever the client posted: the owner's brief is
 * explicit that "a store person retyping a number the system already knows is
 * how the two copies come to disagree". The client's bill_no/vendor/value are
 * used only to fill what the GRN does not hold.
 *
 * Without grn_id -> source='manual'. The fallback for a bill that arrived with no
 * purchase behind it. It requires a bill number and a vendor typed by hand,
 * because there is nothing else to identify it by.
 *
 * DUPLICATES. The GRN path is protected by a partial UNIQUE index. The manual
 * path deliberately is NOT: measured on live data, his suppliers reuse bill
 * numbers across dates (FAMOUS MUTTON SUPPLIER wrote "1122" on eight), and
 * grn/page.tsx:3481-3487 records that a flat refusal on (vendor, bill no) walled
 * off 5.3% of his real bills. So a manual match WARNS and asks for
 * confirm_duplicate, and never refuses on its own.
 */
export function createBillHandover(
  db: Database.Database,
  input: CreateInput,
  actor: SessionUser,
): BhResult<BillHandoverRow> {
  const cutoff = cutoffState(db);
  if (!cutoff.ready || !cutoff.date) {
    return { ok: false, status: 503, error: cutoff.notice };
  }

  const grnId = str(input.grn_id);
  let source = grnId ? 'grn' : 'manual';
  let grn_number = '';
  let bill_no = str(input.bill_no);
  let invoice_id = str(input.invoice_id);
  let vendor_id = str(input.vendor_id);
  let vendor_name = str(input.vendor_name);
  let bill_date = str(input.bill_date);
  let received_date = str(input.received_date);
  let bill_value = num(input.bill_value);
  let outlet_id: string | null = input.outlet_id ? str(input.outlet_id) : null;

  if (grnId) {
    const grn = db
      .prepare(
        `SELECT id, grn_number, date, vendor_id, vendor, invoice_number, invoice_date, outlet_id, voided_at
           FROM goods_receipt_notes WHERE id = ?`,
      )
      .get(grnId) as
      | {
          id: string;
          grn_number: string;
          date: string;
          vendor_id: string | null;
          vendor: string | null;
          invoice_number: string | null;
          invoice_date: string | null;
          outlet_id: string | null;
          voided_at: string | null;
        }
      | undefined;
    if (!grn) {
      return { ok: false, status: 404, error: 'That goods receipt no longer exists.' };
    }
    if (str(grn.voided_at)) {
      return {
        ok: false,
        status: 400,
        error: 'That goods receipt has been voided — there is no bill to hand over.',
      };
    }
    source = 'grn';
    grn_number = str(grn.grn_number);
    // The SYSTEM's copy wins for everything the GRN already knows.
    received_date = str(grn.date) || received_date;
    vendor_id = str(grn.vendor_id) || vendor_id;
    vendor_name = str(grn.vendor) || vendor_name;
    bill_no = str(grn.invoice_number) || bill_no;
    bill_date = str(grn.invoice_date) || bill_date || received_date;
    outlet_id = grn.outlet_id ?? outlet_id;

    // The bill's total is the vendor's FACE VALUE for this receipt, read off the
    // GRN's own lines — the same number the receiving screen put in front of the
    // store person with the paper in his hand. Computed, never retyped.
    // The tax-free purchases mirror is a FALLBACK ONLY, for a receipt whose
    // lines no longer exist; see bhGrnBillValueSql for why it is the wrong
    // number whenever they do. The client's bill_value is the last resort.
    const face = db.prepare(bhGrnBillValueSql('?')).get(grnId) as { t: number } | undefined;
    let computed = num(face?.t);
    if (!(computed > 0)) {
      const mirror = db.prepare(bhMirrorValueSql('?')).get(grnId) as { t: number } | undefined;
      computed = num(mirror?.t);
    }
    if (computed > 0) bill_value = computed;
    if (!invoice_id) {
      const inv = db
        .prepare(
          `SELECT invoice_id FROM purchases
            WHERE grn_id = ? AND COALESCE(invoice_id, '') <> '' LIMIT 1`,
        )
        .get(grnId) as { invoice_id?: string } | undefined;
      invoice_id = str(inv?.invoice_id);
    }
  } else {
    // Manual fallback. Nothing else identifies this bill, so both are required.
    if (!bill_no) {
      return {
        ok: false,
        status: 400,
        error: 'A manually entered bill needs the vendor\'s bill number.',
      };
    }
    if (!vendor_name && !vendor_id) {
      return { ok: false, status: 400, error: 'A manually entered bill needs the vendor.' };
    }
    if (!received_date) received_date = bill_date;
  }

  if (!isIsoDate(received_date)) {
    return {
      ok: false,
      status: 400,
      error: 'A valid received date (YYYY-MM-DD) is required — it is what the register is dated by.',
    };
  }
  if (bill_date && !isIsoDate(bill_date)) {
    return { ok: false, status: 400, error: 'The bill date must be YYYY-MM-DD.' };
  }
  if (!(bill_value >= 0)) {
    return { ok: false, status: 400, error: 'The bill value cannot be negative.' };
  }

  // ── THE CUTOFF, enforced at the only place rows are born ──────────────────
  // received_date, NOT bill_date: a bill printed on the 17th and delivered on
  // the 20th is a bill received after the cutoff and belongs in the register.
  if (received_date < cutoff.date) {
    return {
      ok: false,
      status: 400,
      error: `This register starts from ${cutoff.date}. A bill received on ${received_date} is before that and is deliberately not tracked here — the instruction was to start forward, not to review past bills.`,
      extra: { cutoff_date: cutoff.date, received_date },
    };
  }

  if (grnId) {
    const clash = db
      .prepare(`SELECT id, status FROM bill_handovers WHERE grn_id = ? AND status <> ?`)
      .get(grnId, BH_VOID) as { id: string; status: BillHandoverStatus } | undefined;
    if (clash) {
      return {
        ok: false,
        status: 409,
        error: `That goods receipt already has a handover record (${BH_STATUS_LABEL[clash.status] ?? clash.status}).`,
        extra: { existing_id: clash.id, status: clash.status },
      };
    }
  } else if (!input.confirm_duplicate) {
    // WARN, never refuse — see the DUPLICATES note above.
    const dup = db
      .prepare(
        `SELECT id, status, received_date FROM bill_handovers
          WHERE status <> ? AND lower(bill_no) = lower(?)
            AND (vendor_id = ? OR lower(vendor_name) = lower(?))
            AND received_date = ?
          LIMIT 1`,
      )
      .get(BH_VOID, bill_no, vendor_id, vendor_name, received_date) as
      | { id: string; status: string; received_date: string }
      | undefined;
    if (dup) {
      return {
        ok: false,
        status: 409,
        error: `A bill ${bill_no} from ${vendor_name || 'this vendor'} received on ${received_date} is already recorded. If this is a second, genuinely different bill, confirm to record it anyway.`,
        extra: { duplicate_of: dup.id, needs_confirm_duplicate: true },
      };
    }
  }

  const id = generateId();
  const submitNow = !!input.submit_now;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO bill_handovers
         (id, source, grn_id, grn_number, invoice_id, bill_no, vendor_id, vendor_name,
          bill_date, received_date, bill_value, outlet_id, status,
          created_by_id, created_by_name, created_by_email, created_at,
          submitted_by_id, submitted_by_name, submitted_by_email, submitted_at,
          note, cutoff_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
               ?, ?, ?, ${submitNow ? "datetime('now')" : 'NULL'}, ?, ?, datetime('now'))`,
    ).run(
      id,
      source,
      grnId || null,
      grn_number,
      invoice_id,
      bill_no,
      vendor_id,
      vendor_name,
      bill_date,
      received_date,
      bill_value,
      outlet_id,
      submitNow ? BH_SUBMITTED : BH_PENDING,
      actor.id,
      actor.name || '',
      actor.email || '',
      submitNow ? actor.id : '',
      submitNow ? actor.name || '' : '',
      submitNow ? actor.email || '' : '',
      str(input.note),
      cutoff.date,
    );
    logEvent(db, {
      handover_id: id,
      action: 'created',
      to_status: BH_PENDING,
      actor,
      note: grnId ? `From goods receipt ${grn_number || grnId}` : 'Manual entry (no goods receipt)',
    });
    if (submitNow) {
      logEvent(db, {
        handover_id: id,
        action: 'submitted',
        from_status: BH_PENDING,
        to_status: BH_SUBMITTED,
        actor,
        note: 'Handed to Accounts at the time of recording',
      });
    }
  });

  try {
    tx();
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    // The partial unique index is the last line of defence against two receiving
    // clicks racing on one GRN. Report it as the 409 it is, not a 500.
    if (msg.includes('UNIQUE') || msg.includes('uq_bill_handover_grn')) {
      return { ok: false, status: 409, error: 'That goods receipt already has a handover record.' };
    }
    console.error('createBillHandover failed:', e);
    return { ok: false, status: 500, error: 'Could not record the bill handover.' };
  }

  return { ok: true, value: getBillHandover(db, id)! };
}

/** Store clicks "Submitted to Accounts". Pending -> Submitted, stamped. */
export function submitBillHandover(
  db: Database.Database,
  id: string,
  actor: SessionUser,
  note = '',
): BhResult<BillHandoverRow> {
  const row = getBillHandover(db, id);
  if (!row) return { ok: false, status: 404, error: 'That bill record no longer exists.' };
  if (row.status === BH_VOID) {
    return { ok: false, status: 400, error: 'That bill record was voided.' };
  }
  if (row.status === BH_SUBMITTED) {
    return { ok: false, status: 409, error: 'That bill is already submitted and awaiting Accounts.' };
  }
  if (row.status === BH_RECEIVED) {
    return { ok: false, status: 409, error: 'Accounts has already confirmed receipt of that bill.' };
  }

  try {
    const tx = db.transaction(() => {
      // Guarded UPDATE: the WHERE re-asserts the from-status, so two clicks
      // racing cannot both stamp a submission time.
      const res = db
        .prepare(
          `UPDATE bill_handovers
              SET status = ?, submitted_by_id = ?, submitted_by_name = ?, submitted_by_email = ?,
                  submitted_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status = ?`,
        )
        .run(BH_SUBMITTED, actor.id, actor.name || '', actor.email || '', id, BH_PENDING);
      if (res.changes !== 1) throw new Error('status moved under us');
      logEvent(db, {
        handover_id: id,
        action: 'submitted',
        from_status: BH_PENDING,
        to_status: BH_SUBMITTED,
        actor,
        note: str(note),
      });
    });
    tx();
  } catch {
    return { ok: false, status: 409, error: 'That bill changed while you were working on it. Reload and try again.' };
  }

  return { ok: true, value: getBillHandover(db, id)! };
}

/**
 * Accounts clicks "Confirm Received". Submitted -> Received, stamped.
 *
 * THE ONLY code path in the app that writes status='received'. It requires a
 * human actor who passes canConfirmBillHandover() AND who is neither the creator
 * nor the submitter. There is no automatic, scheduled or inferred confirmation,
 * and adding one would destroy the thing the owner asked for.
 *
 * It also refuses to skip Pending -> Received: a bill Accounts "confirms" that
 * the store never said it handed over is not a handover, it is a guess.
 */
export function confirmBillHandover(
  db: Database.Database,
  id: string,
  actor: SessionUser,
  note = '',
): BhResult<BillHandoverRow> {
  if (!canConfirmBillHandover(actor)) {
    return {
      ok: false,
      status: 403,
      error: `Only the ${ACCOUNTS_ROLE_NAME} team (or an Administrator) can confirm that a bill was received.`,
    };
  }

  const row = getBillHandover(db, id);
  if (!row) return { ok: false, status: 404, error: 'That bill record no longer exists.' };
  if (row.status === BH_VOID) {
    return { ok: false, status: 400, error: 'That bill record was voided.' };
  }
  if (row.status === BH_RECEIVED) {
    return { ok: false, status: 409, error: 'That bill is already confirmed as received.' };
  }
  if (row.status !== BH_SUBMITTED) {
    return {
      ok: false,
      status: 409,
      error: 'The store has not marked that bill as submitted yet, so there is nothing to confirm receipt of.',
    };
  }

  // RULE 2. No admin exemption, on purpose.
  const refusal = selfConfirmRefusal(row, actor);
  if (refusal) return { ok: false, status: 403, error: refusal };

  try {
    const tx = db.transaction(() => {
      const res = db
        .prepare(
          `UPDATE bill_handovers
              SET status = ?, confirmed_by_id = ?, confirmed_by_name = ?, confirmed_by_email = ?,
                  confirmed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status = ?
              AND COALESCE(submitted_by_id, '') <> ?
              AND COALESCE(created_by_id, '') <> ?`,
        )
        .run(
          BH_RECEIVED,
          actor.id,
          actor.name || '',
          actor.email || '',
          id,
          BH_SUBMITTED,
          actor.id,
          actor.id,
        );
      // The WHERE re-states rule 2 in SQL as well as in TypeScript. Belt and
      // braces: this is the one transition the whole feature is evidence for.
      if (res.changes !== 1) throw new Error('status moved under us');
      logEvent(db, {
        handover_id: id,
        action: 'confirmed',
        from_status: BH_SUBMITTED,
        to_status: BH_RECEIVED,
        actor,
        note: str(note),
      });
    });
    tx();
  } catch {
    return { ok: false, status: 409, error: 'That bill changed while you were working on it. Reload and try again.' };
  }

  return { ok: true, value: getBillHandover(db, id)! };
}

/**
 * Void with a reason. NEVER a delete.
 *
 * The owner asked for an audit trail, so a record that was wrong must still be
 * visible as having existed and been withdrawn — a DELETE is the one operation
 * that turns "we can prove what happened" back into "we think we remember".
 * The row keeps every stamp it had; only the status and the void fields change.
 */
export function voidBillHandover(
  db: Database.Database,
  id: string,
  actor: SessionUser,
  reason: string,
): BhResult<BillHandoverRow> {
  const why = str(reason);
  if (why.length < 3) {
    return { ok: false, status: 400, error: 'Give a reason for voiding this bill record.' };
  }
  const row = getBillHandover(db, id);
  if (!row) return { ok: false, status: 404, error: 'That bill record no longer exists.' };
  if (row.status === BH_VOID) {
    return { ok: false, status: 409, error: 'That bill record is already voided.' };
  }
  if (row.status === BH_RECEIVED && !canVoidConfirmedBillHandover(actor)) {
    return {
      ok: false,
      status: 403,
      error: 'Accounts has already confirmed that bill. Only an Administrator can void a confirmed record.',
    };
  }

  try {
    const tx = db.transaction(() => {
      const res = db
        .prepare(
          `UPDATE bill_handovers
              SET status = ?, voided_by_id = ?, voided_by_name = ?, voided_at = datetime('now'),
                  void_reason = ?, updated_at = datetime('now')
            WHERE id = ? AND status = ?`,
        )
        .run(BH_VOID, actor.id, actor.name || '', why, id, row.status);
      if (res.changes !== 1) throw new Error('status moved under us');
      logEvent(db, {
        handover_id: id,
        action: 'voided',
        from_status: row.status,
        to_status: BH_VOID,
        actor,
        note: why,
      });
    });
    tx();
  } catch {
    return { ok: false, status: 409, error: 'That bill changed while you were working on it. Reload and try again.' };
  }

  return { ok: true, value: getBillHandover(db, id)! };
}

/* ════════════════════════════════════════════════════════════════════════════
   THE HOOK FOR THE RECEIVING FLOW
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Create the handover row for a GRN that has just been received — the one-line
 * call for whoever wires this INTO the receiving transaction later.
 *
 * NOT CALLED FROM THE RECEIVING ROUTES TODAY, and the reason is deliberate:
 * src/app/api/grn/route.ts and src/app/api/purchase-orders/[id]/receive/route.ts
 * both carry uncommitted work from other lanes right now, and a fourth editor in
 * those files is how a merge loses a stock write. Until that wiring is done, the
 * quality-check UI calls POST /api/bill-submissions immediately after the GRN is
 * created, and billHandoverSummary().not_yet_recorded catches anything that
 * slipped between the two calls.
 *
 * When it IS wired in, call this INSIDE the existing transaction that mints the
 * GRN (receive/route.ts:1391-1497, grn/route.ts:1420-1576). Then a handover row
 * cannot exist for a bill received before the feature shipped — forward-only by
 * construction rather than by filter.
 *
 * NEVER throws: a bill-register hiccup must not roll back a goods receipt. It
 * returns null and the leak detector picks the GRN up.
 */
export function recordBillHandoverForGrn(
  db: Database.Database,
  grnId: string,
  actor: SessionUser,
  opts: { submit_now?: boolean; note?: string } = {},
): string | null {
  try {
    const res = createBillHandover(
      db,
      { grn_id: grnId, submit_now: opts.submit_now, note: opts.note },
      actor,
    );
    return res.ok ? res.value.id : null;
  } catch (e) {
    console.error('recordBillHandoverForGrn failed:', e);
    return null;
  }
}

/**
 * Goods receipts on/after the cutoff with no handover record — the rows behind
 * the not_yet_recorded count, so the store screen can offer "record this one".
 */
export function listUnrecordedReceipts(
  db: Database.Database,
  limit = 100,
): { id: string; grn_number: string; date: string; vendor: string; bill_no: string; bill_value: number }[] {
  const cutoff = cutoffState(db);
  if (!cutoff.ready || !cutoff.date) return [];
  const n = Math.min(500, Math.max(1, parseInt(String(limit), 10) || 100));
  return db
    .prepare(
      `SELECT g.id, g.grn_number, g.date,
              COALESCE(g.vendor, '')         AS vendor,
              COALESCE(g.invoice_number, '') AS bill_no,
              -- The SAME face value the row will carry once it is recorded, by
              -- the same expression (bhGrnBillValueSql) with the same mirror
              -- fallback. This list is the store's "bill not recorded" work
              -- list, so a receipt must not quote one figure here and a
              -- different one the moment somebody records it.
              COALESCE(NULLIF((${bhGrnBillValueSql('g.id')}), 0),
                       (${bhMirrorValueSql('g.id')}), 0) AS bill_value
         FROM goods_receipt_notes g
        WHERE g.date >= ?
          AND COALESCE(g.voided_at, '') = ''
          AND NOT EXISTS (
                SELECT 1 FROM bill_handovers h WHERE h.grn_id = g.id AND h.status <> ?
              )
        ORDER BY g.date DESC, g.grn_number DESC
        LIMIT ?`,
    )
    .all(cutoff.date, BH_VOID, n) as {
    id: string;
    grn_number: string;
    date: string;
    vendor: string;
    bill_no: string;
    bill_value: number;
  }[];
}

/** getDb() + a defensive schema repair, for the routes. See the SILENT-FAILURE
 *  NOTE in bill-handover-schema.ts: initializeSchema swallows its errors, so the
 *  first API hit re-asserts the tables rather than 500-ing on "no such table". */
export function billHandoverDb(): Database.Database {
  const db = getDb();
  ensureBillHandoverSchema(db);
  return db;
}
