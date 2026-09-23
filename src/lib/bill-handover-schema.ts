/**
 * BILL SUBMISSION QUALITY CHECK — SCHEMA + THE CUTOFF
 * ===================================================
 *
 * The owner's words: "Add a new Bill Submission Quality Check for the Store team
 * to ensure that all vendor bills are properly submitted to the Accounts team and
 * tracked within the system... This will create a proper audit trail and prevent
 * situations where there is confusion about whether a vendor bill was actually
 * handed over to the Accounts department."
 *
 * WHY THIS FILE IS A LEAF. It imports better-sqlite3's TYPES and ./format-date
 * (which itself imports nothing) and nothing else — deliberately. db.ts pulls it
 * in with require() inside initializeSchema, so an import back into db.ts here
 * would close a cycle at module-init time. Take the `db` handle as a parameter;
 * never call getDb() from this file.
 *
 * ── THE KEY: ONE HANDOVER ROW PER GRN ────────────────────────────────────────
 * A vendor bill is MANY purchase rows (measured on the owner's real data:
 * 354 bills over 2,118 imported rows, mean 5.98 rows/bill, worst 44). The
 * handover is per BILL, so the key cannot be a purchases row.
 *
 * The key is goods_receipt_notes.id, because:
 *   · one GRN is exactly one vendor-bill receiving event, by construction;
 *   · it is a hard column stamped inside the same transaction by BOTH receiving
 *     roads (purchase-orders/[id]/receive and /api/grn);
 *   · it survives a blank bill number and a later-amended one;
 *   · src/lib/purchase-bill-summary.ts already ranks grn_id AHEAD of bill_no in
 *     its billKeyExpr precedence, for exactly the same reason.
 *
 * bill_no is NOT the key and must never become one. Measured on live data:
 * 9 of 354 keys (2.54%) and 94 of 2,118 rows (4.44%) are ambiguous under
 * (vendor, bill_no) — FAMOUS MUTTON SUPPLIER wrote "1122" on eight different
 * dates. grn/page.tsx:3481-3487 already records that a flat refusal on
 * (vendor, bill no) walled off 5.3% of his real bills. bill_no is carried here
 * as a NON-UNIQUE attribute so a bill split across two GRNs can be shown
 * together — never so it can refuse one.
 *
 * WHAT THE KEY CANNOT REPRESENT, stated plainly:
 *   1. A bill with no GRN behind it -> source='manual', grn_id NULL. The owner's
 *      fallback, never the default.
 *   2. Liquor / TGBCL bills. Measured: 62 purchase rows in store-routed
 *      categories, ZERO with a grn_id. Liquor inward is a separate rail
 *      (store_stock_ledger / store_bill_charges) behind its own deploy gate.
 *      Out of scope for v1 — the screens must SAY so rather than imply the
 *      register is complete.
 *   3. The 2,121 historical purchase rows with no bill identity. Correct and
 *      intended: see the cutoff below.
 *   4. One vendor bill split across two GRNs (grn-qc.ts actively recommends
 *      splitting a mixed delivery) -> two rows, one piece of paper, joined for
 *      display on bill_no.
 *   5. A voided GRN. The unique index excludes status='void' so a re-entry after
 *      a void is possible; the voided row STAYS as the audit trail.
 *
 * ── THE CUTOFF ──────────────────────────────────────────────────────────────
 * The owner: "DONT NEED TO REVIEW ANY PAST BILLS FROM THE NEXT DAY OF DEPLOYMENT
 * IT SHOULD ASK IN QUALITY CHECK FOR STORE PERSON."
 *
 * His database holds 2,165 purchase rows of which 2,121 have NO bill identity at
 * all. If the dashboard counted those as "Pending Submission" he would open the
 * screen on day one to a 2,121-item backlog of bills from months ago. He
 * pre-empted that, so this module defends it twice:
 *
 *   DEFENCE 1 (structural, and the strong one). Pending Submission is read ONLY
 *   from bill_handovers. Nothing derives a pending bill from `purchases`. The
 *   table starts empty, so a legacy row cannot appear in it — a stronger
 *   guarantee than any date filter, which a later edit could get wrong.
 *
 *   DEFENCE 2 (the recorded cutoff). Two write-once settings keys, following the
 *   house precedent getCentralStoreCutoverDate / ...CommittedAt in
 *   src/lib/central-cutover.ts, which stores a business DATE and a committed-at
 *   INSTANT as two keys precisely because one value cannot answer both questions:
 *
 *     bill_handover_cutoff_date          'YYYY-MM-DD' — the first business day
 *                                        the register covers. = IST date of first
 *                                        boot + 1 day ("the next day of
 *                                        deployment", his words, taken literally).
 *     bill_handover_cutoff_committed_at  UTC instant the stamp was written. The
 *                                        evidence that it never moved.
 *
 *   Written ONCE, on first boot, with INSERT OR IGNORE. Never recomputed from
 *   "now" on a read — a moving cutoff would silently change what the screens show
 *   and the owner would have no way to tell.
 *
 * ── WHICH DATE THE CUTOFF COMPARES, and why it is not the bill's own date ────
 * TWO dates are stored and they are not interchangeable:
 *   received_date  the business date of the RECEIVING EVENT (GRN.date /
 *                  purchases.date). THIS is what the cutoff compares.
 *   bill_date      the date printed on the vendor's bill. Informational.
 *
 * A vendor bill printed on the 17th and delivered on the 20th is a bill received
 * AFTER the cutoff and must enter the register; comparing the cutoff against
 * bill_date would silently refuse it. Conversely a delivery received before the
 * cutoff is out of scope no matter what its paper says. The handover is an
 * event, so it is dated by the event.
 *
 * Do NOT switch either of these to created_at. Measured on the owner's data:
 * 2,121 of 2,165 purchase rows were TYPED more than the app's own 3-day backdate
 * window after their business date (mean 26.3 days, max 41). A cutoff keyed on
 * created_at pulls in all 2,165 rows; keyed on the business date it pulls 47.
 * All 29 real GRN receiving events have created_at - date = 0 — receiving is a
 * same-day act, importing is not.
 *
 * ── SILENT-FAILURE NOTE ─────────────────────────────────────────────────────
 * initializeSchema() swallows errors per block, and a multi-statement script
 * stops at its first failing statement and silently skips the rest. So this file
 * runs ONE try/catch PER STATEMENT (the lesson the liquor lane paid for: a name
 * collision on one CREATE took four tables and two UNIQUE constraints with it
 * behind a single misleading log line). It also re-verifies against sqlite_master
 * afterwards, and every route calls ensureBillHandoverSchema() again — so a
 * swallowed boot failure is repaired on the first API hit instead of becoming a
 * permanent "no such table" 500.
 */
import type Database from 'better-sqlite3';
import { todayIST } from './format-date';

/* ── Status vocabulary — the owner's own words, and the stored codes ──────── */

export const BH_PENDING = 'pending_submission' as const;
export const BH_SUBMITTED = 'submitted' as const;
export const BH_RECEIVED = 'received' as const;
export const BH_VOID = 'void' as const;

export type BillHandoverStatus =
  | typeof BH_PENDING
  | typeof BH_SUBMITTED
  | typeof BH_RECEIVED
  | typeof BH_VOID;

export const BH_STATUSES: BillHandoverStatus[] = [BH_PENDING, BH_SUBMITTED, BH_RECEIVED, BH_VOID];

/**
 * Display labels, verbatim from the brief. The screens must show THESE strings —
 * they are the words the owner uses with his own staff, and a paraphrase
 * ("Sent", "Done") is how a handover report stops matching the conversation
 * being had about it.
 */
export const BH_STATUS_LABEL: Record<BillHandoverStatus, string> = {
  [BH_PENDING]: 'Pending Submission',
  [BH_SUBMITTED]: 'Submitted - Awaiting Accounts Confirmation',
  [BH_RECEIVED]: 'Received by Accounts',
  [BH_VOID]: 'Voided',
};

/** Short label for a dashboard tile / table chip where the long one won't fit. */
export const BH_STATUS_SHORT: Record<BillHandoverStatus, string> = {
  [BH_PENDING]: 'Pending Submission',
  [BH_SUBMITTED]: 'Submitted to Accounts',
  [BH_RECEIVED]: 'Received by Accounts',
  [BH_VOID]: 'Voided',
};

export function isBillHandoverStatus(v: unknown): v is BillHandoverStatus {
  return typeof v === 'string' && (BH_STATUSES as string[]).includes(v);
}

/* ── Settings keys for the cutoff ────────────────────────────────────────── */

export const BH_CUTOFF_DATE_KEY = 'bill_handover_cutoff_date';
export const BH_CUTOFF_COMMITTED_KEY = 'bill_handover_cutoff_committed_at';

/* ── The anchor's own keys, inside bill_handover_meta ─────────────────────────
 * The SECOND copy of the start date, in this module's own table. The settings
 * row is what the app reads; this is what proves the settings row is the
 * original. Two copies in two tables, so a restored backup or a hand-run DELETE
 * that takes out one of them is DETECTABLE rather than silently absorbed.
 */
export const BH_ANCHOR_CUTOFF_KEY = 'cutoff_date';
export const BH_ANCHOR_COMMITTED_KEY = 'cutoff_committed_at';

/**
 * Hard ceiling for one stored bill scan, in bytes.
 *
 * 600 KB, NOT the HR vault's 5 MB. src/app/crm-calls/database/page.tsx:81-85
 * records a direct probe of THIS production box: a 900 KB body reaches the app,
 * 1,100 KB is refused by the proxy with a 413. deploy/nginx.conf says
 * client_max_body_size 25M but the live box is not running it (those AWS deploy
 * scripts are stale). 600 KB leaves room for multipart framing and a long
 * filename under the measured 1 MB ceiling.
 *
 * Consequence the CLIENT must honour: a phone photo of a bill is routinely
 * 3-5 MB, so it has to be compressed in the browser before it is sent (port the
 * ladder in the menu-image uploader). "If applicable" must never mean "fails
 * silently" — which is exactly what the HR vault does today, because it caps at
 * 5 MB while the proxy kills the request at 1 MB and the client's error handler
 * swallows the non-JSON 413 body.
 */
export const BH_FILE_MAX_BYTES = 600 * 1024;

/* ── DDL ─────────────────────────────────────────────────────────────────── */

/**
 * One statement per array entry. See the SILENT-FAILURE NOTE above: these are
 * executed one at a time so a failure names itself and takes nothing with it.
 *
 * No FOREIGN KEY declarations anywhere. foreign_keys=ON is set in getDb(), and
 * the house style for late-arriving namespaces (task_*, ct_*, hr_*) is plain
 * TEXT + an index: an FK column with a DEFAULT '' throws on insert, and a real
 * FK to goods_receipt_notes would make voiding a GRN fail rather than leave
 * behind the audit row the owner asked for.
 */
const BH_DDL: { name: string; sql: string }[] = [
  {
    name: 'bill_handovers',
    sql: `
      CREATE TABLE IF NOT EXISTS bill_handovers (
        id                 TEXT PRIMARY KEY,

        -- ── identity (see "THE KEY" above) ─────────────────────────────────
        source             TEXT NOT NULL DEFAULT 'grn',  -- 'grn' | 'manual'
        grn_id             TEXT,                         -- goods_receipt_notes.id; THE key when present
        grn_number         TEXT NOT NULL DEFAULT '',     -- cached GRN-YYYY-NNNN for display
        invoice_id         TEXT NOT NULL DEFAULT '',     -- OUR PINV-yyyy-#### when known
        bill_no            TEXT NOT NULL DEFAULT '',     -- the VENDOR's own number. NON-UNIQUE by design.
        vendor_id          TEXT NOT NULL DEFAULT '',     -- vendors.id when resolvable
        vendor_name        TEXT NOT NULL DEFAULT '',     -- purchases.vendor is TEXT, so the name is carried too
        bill_date          TEXT NOT NULL DEFAULT '',     -- date PRINTED on the vendor bill (informational)
        received_date      TEXT NOT NULL,                -- business date of the receiving event. CUTOFF BASIS.
        bill_value         REAL NOT NULL DEFAULT 0,      -- total bill value in rupees
        outlet_id          TEXT,

        -- ── status ─────────────────────────────────────────────────────────
        status             TEXT NOT NULL DEFAULT 'pending_submission',

        -- ── who / when. Every stamp is UTC via datetime('now'); render through
        --    src/lib/format-date.ts, the app's only IST renderer. ────────────
        created_by_id      TEXT NOT NULL DEFAULT '',
        created_by_name    TEXT NOT NULL DEFAULT '',
        created_by_email   TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),

        submitted_by_id    TEXT NOT NULL DEFAULT '',
        submitted_by_name  TEXT NOT NULL DEFAULT '',
        submitted_by_email TEXT NOT NULL DEFAULT '',
        submitted_at       TEXT,

        confirmed_by_id    TEXT NOT NULL DEFAULT '',
        confirmed_by_name  TEXT NOT NULL DEFAULT '',
        confirmed_by_email TEXT NOT NULL DEFAULT '',
        confirmed_at       TEXT,

        voided_by_id       TEXT NOT NULL DEFAULT '',
        voided_by_name     TEXT NOT NULL DEFAULT '',
        voided_at          TEXT,
        void_reason        TEXT NOT NULL DEFAULT '',

        note               TEXT NOT NULL DEFAULT '',

        -- The cutoff that was in force when this row was written. Stored ON the
        -- row so a later look at the register can tell what the rule was at the
        -- time, without trusting that the settings key still says the same thing.
        cutoff_date        TEXT NOT NULL DEFAULT '',

        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
  },
  {
    name: 'bill_handover_events',
    sql: `
      CREATE TABLE IF NOT EXISTS bill_handover_events (
        id           TEXT PRIMARY KEY,
        handover_id  TEXT NOT NULL,
        -- WHAT IS ACTUALLY WRITTEN, and by whom — every value here is grep-able
        -- to exactly one writer:
        --   'created'            createBillHandover()          (lib)
        --   'submitted'          createBillHandover(submit_now) + submitBillHandover()
        --   'confirmed'          confirmBillHandover()
        --   'voided'             voidBillHandover()
        --   'attachment_added'   POST   …/[id]/attachment
        --   'attachment_removed' DELETE …/[id]/attachment
        --
        -- 'edited' USED TO BE LISTED HERE AND IS NOT WRITTEN BY ANYTHING. There is
        -- no edit path: GET is the only verb on /api/bill-submissions/[id], and a
        -- recorded bill's fields are never updated (the three UPDATE statements in
        -- bill-handover.ts touch status and stamps only). An action listed in the
        -- schema is a promise that the trail can show it, so the name is gone
        -- until a writer exists. The field/old_value/new_value columns below are
        -- what such a writer must fill: the owner asked for "Action | Old Value |
        -- New Value | Updated By | Date", and before those columns existed an
        -- 'edited' row could only have said THAT something changed.
        action       TEXT NOT NULL,
        from_status  TEXT NOT NULL DEFAULT '',
        to_status    TEXT NOT NULL DEFAULT '',
        actor_id     TEXT NOT NULL DEFAULT '',
        actor_name   TEXT NOT NULL DEFAULT '',
        actor_email  TEXT NOT NULL DEFAULT '',
        actor_role   TEXT NOT NULL DEFAULT '',  -- resolved tier + role_name at the time

        -- WHAT MOVED, AND FROM WHAT TO WHAT. The owner asked the audit trail for
        -- "Action | Old Value | New Value | Updated By | Date", and from_status /
        -- to_status answer that for a STATUS move only. These three answer it for
        -- any field, so an action that changes a value can record the change
        -- rather than merely assert that one happened. The 'field' column names
        -- the column that moved
        -- ('status', 'bill_value', …); both values are rendered strings, because
        -- an audit trail is read, not recomputed.
        field        TEXT NOT NULL DEFAULT '',
        old_value    TEXT NOT NULL DEFAULT '',
        new_value    TEXT NOT NULL DEFAULT '',

        note         TEXT NOT NULL DEFAULT '',
        at           TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
  },
  {
    // ── THE CUTOFF'S ANCHOR ─────────────────────────────────────────────────
    // One row, written the first time the register's start date is derived, and
    // never rewritten. Its only job is to make the derivation UNREPEATABLE: see
    // seedBillHandoverCutoff below, where a missing settings row is restored
    // FROM here instead of being re-derived from today's date.
    //
    // WHY NOT JUST THE SETTINGS ROW. Because the settings row is exactly what
    // goes missing. `settings` is a flat k/v table that ~40 routes write, that a
    // restored backup replaces wholesale, and that a hand-run DELETE can prune;
    // MEASURED on a snapshot copy, deleting the two keys and restarting moved
    // the register's start from 2026-08-01 to 2026-09-20, reported ready:true,
    // and hid 4 already-recorded bills — with no error anywhere. A second,
    // separate table does not make that impossible, but it makes it DETECTABLE,
    // which is the difference between a wrong register and a register that says
    // so. Deliberately NOT a column on bill_handovers: the anchor has to exist
    // before the first bill is recorded.
    name: 'bill_handover_meta',
    sql: `
      CREATE TABLE IF NOT EXISTS bill_handover_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        at    TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
  },
  {
    name: 'bill_handover_files',
    sql: `
      CREATE TABLE IF NOT EXISTS bill_handover_files (
        id               TEXT PRIMARY KEY,
        handover_id      TEXT NOT NULL,
        filename         TEXT NOT NULL DEFAULT '',
        mime             TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes       INTEGER NOT NULL DEFAULT 0,
        data             BLOB NOT NULL,
        uploaded_by_id   TEXT NOT NULL DEFAULT '',
        uploaded_by_name TEXT NOT NULL DEFAULT '',
        uploaded_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
  },
];

const BH_INDEX_DDL: { name: string; sql: string }[] = [
  // ONE non-void handover per GRN. Partial, so (a) manual rows with grn_id NULL
  // are unconstrained and (b) a GRN whose handover was VOIDED can be re-entered
  // while the voided row stays put as the audit trail.
  {
    name: 'uq_bill_handover_grn',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_handover_grn
            ON bill_handovers(grn_id)
          WHERE grn_id IS NOT NULL AND grn_id <> '' AND status <> 'void'`,
  },
  // Dashboard + Pending/Submitted lists: every one of them filters on status and
  // bounds on received_date.
  {
    name: 'idx_bill_handover_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_status
            ON bill_handovers(status, received_date)`,
  },
  {
    name: 'idx_bill_handover_received',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_received
            ON bill_handovers(received_date)`,
  },
  // Duplicate WARNING lookups on the manual path, and joining a bill split
  // across two GRNs. Deliberately NOT unique — see "THE KEY" above.
  {
    name: 'idx_bill_handover_billno',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_billno
            ON bill_handovers(bill_no, vendor_name)`,
  },
  {
    name: 'idx_bill_handover_vendor',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_vendor
            ON bill_handovers(vendor_id)`,
  },
  {
    name: 'idx_bill_handover_events_parent',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_events_parent
            ON bill_handover_events(handover_id, at)`,
  },
  {
    name: 'idx_bill_handover_files_parent',
    sql: `CREATE INDEX IF NOT EXISTS idx_bill_handover_files_parent
            ON bill_handover_files(handover_id)`,
  },
];

/** Every table this module owns — used by the post-build verification. */
export const BH_TABLES = [
  'bill_handovers',
  'bill_handover_events',
  'bill_handover_meta',
  'bill_handover_files',
] as const;

/* ── Additive columns for a table that already exists ────────────────────────
 * CREATE TABLE IF NOT EXISTS is a no-op on a database that already has the
 * table, so a column added after first deployment needs its own ALTER. House
 * style (db.ts does this ~200 times): read PRAGMA table_info, add what is
 * missing, never rebuild the table. Each ALTER is idempotent by that check and
 * survives being run on every boot.
 */
const BH_ALTERS: { table: string; column: string; sql: string }[] = [
  { table: 'bill_handover_events', column: 'field',
    sql: `ALTER TABLE bill_handover_events ADD COLUMN field TEXT NOT NULL DEFAULT ''` },
  { table: 'bill_handover_events', column: 'old_value',
    sql: `ALTER TABLE bill_handover_events ADD COLUMN old_value TEXT NOT NULL DEFAULT ''` },
  { table: 'bill_handover_events', column: 'new_value',
    sql: `ALTER TABLE bill_handover_events ADD COLUMN new_value TEXT NOT NULL DEFAULT ''` },
];

/** Add any missing additive column. Existing rows read '' — which is the truth
 *  about them: they were written before the trail could record old/new. */
function runBhAlters(db: Database.Database): void {
  for (const a of BH_ALTERS) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${a.table})`).all() as { name: string }[];
      if (!cols.length) continue;                       // table absent; the CREATE above owns that
      if (cols.some((c) => c.name === a.column)) continue;
      db.prepare(a.sql).run();
    } catch (e) {
      console.error(`bill_handover alter failed (${a.table}.${a.column}):`, e);
    }
  }
}

/* ── The cutoff ──────────────────────────────────────────────────────────── */

/** 'YYYY-MM-DD' + n days, computed on a UTC-midnight anchor so no host timezone
 *  can shift it. (The same trick /api/hr/documents uses for expiry thresholds.) */
function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return isoDate;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ── The anchor ──────────────────────────────────────────────────────────── */

/** Read one anchor value from this module's own table. Returns null when the
 *  table or the row is absent — never throws, because it runs inside boot. */
function readBhAnchor(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM bill_handover_meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    const v = String(row?.value ?? '').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Write an anchor value ONCE. INSERT OR IGNORE on a PRIMARY KEY, so the first
 *  value written is the only value this table ever holds for that key. */
function writeBhAnchorOnce(db: Database.Database, key: string, value: string): void {
  try {
    db.prepare(`INSERT OR IGNORE INTO bill_handover_meta (key, value) VALUES (?, ?)`).run(key, value);
  } catch (e) {
    console.error(`bill_handover anchor write failed (${key}):`, e);
  }
}

/** How many handover rows exist at all — the evidence that the register has been
 *  used, and therefore that its start date must not be invented. */
function bhRecordedCount(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM bill_handovers').get() as { n?: number } | undefined;
    return Number(row?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** What the two copies of the start date say, and whether they agree.
 *
 *  `diverged` is the state no read may serve through: the settings row the app
 *  reads and the write-once anchor disagree, so SOMETHING moved the start date
 *  of a live register and this module cannot tell which copy is the original.
 *  cutoffState() turns this into ready:false plus a notice naming both dates.
 *
 *  `lost` is both copies absent while rows exist — the start date is
 *  unrecoverable and was deliberately NOT re-derived. */
export interface BillHandoverCutoffAnchor {
  settings_date: string | null;
  anchor_date: string | null;
  anchor_committed_at: string | null;
  diverged: boolean;
  lost: boolean;
  recorded_rows: number;
}

export function billHandoverCutoffAnchor(db: Database.Database): BillHandoverCutoffAnchor {
  const settings_date = getBillHandoverCutoff(db);
  const anchor_date = readBhAnchor(db, BH_ANCHOR_CUTOFF_KEY);
  const recorded_rows = bhRecordedCount(db);
  return {
    settings_date,
    anchor_date,
    anchor_committed_at: readBhAnchor(db, BH_ANCHOR_COMMITTED_KEY),
    diverged: !!settings_date && !!anchor_date && settings_date !== anchor_date,
    lost: !settings_date && !anchor_date && recorded_rows > 0,
    recorded_rows,
  };
}

/**
 * Seed the cutoff ONCE. Returns the cutoff date in force after the call.
 *
 * INSERT OR IGNORE against a PRIMARY KEY makes the WRITE a no-op on every boot
 * after the first, so the cutoff cannot drift with the clock while its row is
 * there. That alone was not enough, because it protects the row and not the
 * DATE: with the row gone the insert is no longer ignored, and the value being
 * inserted was derived from today. The four cases below close that. In order:
 *
 *   1. anchor present  → RESTORE the settings row from the anchor. Never re-derive.
 *   2. anchor absent, settings row present → ADOPT the date in force as the anchor.
 *   3. both absent, rows already recorded  → REFUSE. Seed nothing, log, stay closed.
 *   4. both absent, register never used    → derive once (deploy day + 1), anchor it.
 *
 * Only case 4 reads the clock, and only on a register that has never run. Moving
 * the date would retroactively change what the screens show, which is the one
 * failure the owner explicitly pre-empted. Changing it is a deliberate DB edit,
 * not an app action — and now a DB edit to one copy is DETECTED (see
 * billHandoverCutoffAnchor) rather than absorbed.
 *
 * "NO ROUTE WRITES THESE KEYS" IS NOT SOMETHING THIS MODULE CAN ASSERT ON ITS
 * OWN, and for a while the comment here asserted it and was wrong. PUT/POST
 * /api/settings is a GENERIC writer whose floor is admin-OR-MANAGER and whose
 * per-key rules are a denylist: a key nobody registers is writable. MEASURED
 * before it was registered — a store manager PUT bill_handover_cutoff_date =
 * '2026-01-01' → 200, and 29 pre-deployment goods receipts appeared on the
 * register. Both keys are now `frozen:` in KEY_POLICY (src/app/api/settings/
 * route.ts), which refuses the write for everyone, admins included. IF A NEW
 * SETTINGS KEY IS EVER ADDED TO THIS MODULE, REGISTER IT THERE IN THE SAME EDIT.
 */
export function seedBillHandoverCutoff(db: Database.Database): string {
  try {
    const settingsDate = getBillHandoverCutoff(db);
    const anchorDate = readBhAnchor(db, BH_ANCHOR_CUTOFF_KEY);

    // ── CASE 1. The anchor remembers the date. RESTORE, never re-derive. ────
    // This is the case INSERT OR IGNORE alone got wrong: with the settings row
    // gone, the old code derived a fresh cutoff from TODAY and the INSERT
    // succeeded, because there was no longer a row to ignore. MEASURED on a
    // snapshot copy (see bill_handover_meta above): the start moved 2026-08-01 →
    // 2026-09-20, ready:true, 4 already-recorded bills disappeared, no error.
    // INSERT OR IGNORE against the ANCHOR's value is the same one-line
    // statement, but the value it inserts is the original rather than the clock,
    // so a deleted row heals back to the date the register actually started.
    if (anchorDate) {
      db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
        BH_CUTOFF_DATE_KEY,
        anchorDate,
      );
      const anchorAt = readBhAnchor(db, BH_ANCHOR_COMMITTED_KEY);
      if (anchorAt) {
        db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(
          BH_CUTOFF_COMMITTED_KEY,
          anchorAt,
        );
      }
      // A settings row that was PRESENT is left exactly as it was — IGNORE, not
      // REPLACE. If it disagrees with the anchor this function does NOT pick a
      // winner: it cannot know which copy was edited, and healing to the wrong
      // one would be the same silent redefinition in a new costume. The
      // disagreement is surfaced by billHandoverCutoffAnchor() and the register
      // refuses to serve until a person settles it.
      if (settingsDate && settingsDate !== anchorDate) {
        console.error(
          `bill_handover cutoff DIVERGED: settings says ${settingsDate}, anchor says ${anchorDate}. ` +
            'The register is held closed until the two agree. Neither copy was overwritten.',
        );
      }
      return getBillHandoverCutoff(db) || '';
    }

    // ── CASE 2. No anchor, but a date is already in force. ADOPT it. ────────
    // A database that ran the register before this table existed. The date it
    // has been using IS the original, so it becomes the anchor. Deriving a new
    // one here would move the start date of a register already in service.
    if (settingsDate) {
      writeBhAnchorOnce(db, BH_ANCHOR_CUTOFF_KEY, settingsDate);
      const committed = getBillHandoverCutoffCommittedAt(db);
      if (committed) writeBhAnchorOnce(db, BH_ANCHOR_COMMITTED_KEY, committed);
      return settingsDate;
    }

    // ── CASE 3. Nothing anywhere, but the register HAS been used. REFUSE. ───
    // Both copies are gone and rows exist that were recorded against a start
    // date nobody can now name. Deriving one from today would silently redefine
    // which bills the register believes exist — and it would look healthy while
    // doing it. Fail LOUD and CLOSED instead: seed nothing, so cutoffState()
    // reports not-ready and every list stays empty until a person restores the
    // value on purpose. An empty register that says why beats a confident one
    // that is wrong.
    const used = bhRecordedCount(db);
    if (used > 0) {
      console.error(
        `bill_handover cutoff MISSING with ${used} bill(s) already recorded: both the settings row ` +
          `('${BH_CUTOFF_DATE_KEY}') and the ${BH_ANCHOR_CUTOFF_KEY} anchor in bill_handover_meta are ` +
          'absent, so the register\'s original start date cannot be recovered. NOT re-deriving it from ' +
          'today — that would change which bills the register covers. The register stays closed until ' +
          'the date is restored deliberately (restore the backup, or set both copies to the original date).',
      );
      return '';
    }

    // ── CASE 4. Genuine first boot. Derive once, and anchor it. ─────────────
    // "FROM THE NEXT DAY OF DEPLOYMENT" — his words, taken literally. A bill
    // received on deploy day itself was handled the old way; day+1 is the first
    // day the store person is asked. Strictly safer than day+0: it can never
    // reach backwards past the moment the feature existed.
    const cutoff = addDays(todayIST(), 1);
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(BH_CUTOFF_DATE_KEY, cutoff);
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))`).run(
      BH_CUTOFF_COMMITTED_KEY,
    );
    // Anchor the value that actually landed, not the one just computed: on a
    // race, the row already there wins and the anchor must match the row.
    const landed = getBillHandoverCutoff(db) || cutoff;
    writeBhAnchorOnce(db, BH_ANCHOR_CUTOFF_KEY, landed);
    writeBhAnchorOnce(
      db,
      BH_ANCHOR_COMMITTED_KEY,
      getBillHandoverCutoffCommittedAt(db) || new Date().toISOString(),
    );
  } catch (e) {
    console.error('bill_handover cutoff seed failed:', e);
  }
  return getBillHandoverCutoff(db) || '';
}

/**
 * The stored cutoff business date ('YYYY-MM-DD'), or null if it was never seeded.
 *
 * NULL IS NOT "NO CUTOFF" — every caller must treat null as "the register is not
 * ready" and show an EMPTY Pending list, never an unbounded one. That is the
 * fail-closed direction: an unbounded Pending list is precisely the 2,121-item
 * day-one backlog the owner pre-empted. cutoffState() in bill-handover.ts is the
 * single place that decision is made; prefer it to this raw reader.
 */
export function getBillHandoverCutoff(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(BH_CUTOFF_DATE_KEY) as { value?: string } | undefined;
    const v = String(row?.value ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The UTC instant the cutoff was committed, or null. The evidence it never moved. */
export function getBillHandoverCutoffCommittedAt(db: Database.Database): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(BH_CUTOFF_COMMITTED_KEY) as { value?: string } | undefined;
    const v = String(row?.value ?? '').trim();
    return v || null;
  } catch {
    return null;
  }
}

/* ── Build ───────────────────────────────────────────────────────────────── */

let verified = false;

/** Run ONE DDL statement. prepare().run() rather than a multi-statement script,
 *  so a failure is attributable to the statement that caused it. */
function runDdl(db: Database.Database, sql: string): void {
  db.prepare(sql).run();
}

/**
 * Create the three tables + indexes and seed the cutoff. Idempotent: safe to run
 * on every boot AND from a route on every request.
 *
 * Called from TWO places on purpose:
 *   1. initializeSchema() in db.ts, so a fresh database is complete at boot;
 *   2. every route under /api/bill-submissions, because initializeSchema
 *      swallows its errors and a swallowed CREATE would otherwise surface as a
 *      permanent "no such table" 500 on a live box. After one successful
 *      verification this is a single in-process boolean check.
 *
 * `force` skips the memo — used by the proof scripts.
 */
export function ensureBillHandoverSchema(db: Database.Database, force = false): boolean {
  if (verified && !force) return true;

  for (const stmt of BH_DDL) {
    try {
      runDdl(db, stmt.sql);
    } catch (e) {
      console.error(`bill_handover schema failed (${stmt.name}):`, e);
    }
  }
  // ADDITIVE COLUMNS, AND THEY MUST RUN ON EVERY BOOT — NOT ONLY THE FIRST.
  // CREATE TABLE IF NOT EXISTS above is a NO-OP on a database that already has
  // the table, so a column added to the DDL after first deployment arrives
  // through BH_ALTERS or it never arrives at all. BH_ALTERS was written for
  // exactly that and then nothing called it: MEASURED on a copy of the owner's
  // database, which had run this module before field/old_value/new_value were
  // added to the CREATE — PRAGMA table_info(bill_handover_events) returned
  // eleven columns, none of them the three the owner's "Action | Old Value |
  // New Value | Updated By | Date" trail is made of. A fresh database looked
  // perfect and an UPGRADED one silently lacked them, which is the worst shape
  // this bug can take: production is the upgraded one.
  //
  // Before the DDL's own verification below, so the check sees the true shape.
  runBhAlters(db);

  for (const idx of BH_INDEX_DDL) {
    try {
      runDdl(db, idx.sql);
    } catch (e) {
      console.error(`bill_handover index failed (${idx.name}):`, e);
    }
  }

  seedBillHandoverCutoff(db);

  // PROVE it rather than assume it — initializeSchema's catch would otherwise
  // let a missing table through in silence.
  let ok = true;
  for (const t of BH_TABLES) {
    try {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(t) as { name?: string } | undefined;
      if (!row?.name) {
        ok = false;
        console.error(`bill_handover schema verification failed: table ${t} is absent`);
      }
    } catch (e) {
      ok = false;
      console.error(`bill_handover schema verification failed (${t}):`, e);
    }
  }

  // A TABLE THAT EXISTS IS NOT A TABLE THAT IS RIGHT. The loop above proves the
  // four tables are present; it would have passed happily on the measured
  // database whose events table was missing all three audit columns. Verify the
  // additive columns too, for the same reason the tables are verified: this is
  // the only place that can notice, because initializeSchema swallows the throw.
  for (const a of BH_ALTERS) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${a.table})`).all() as { name: string }[];
      if (cols.length && !cols.some((c) => c.name === a.column)) {
        ok = false;
        console.error(
          `bill_handover schema verification failed: ${a.table}.${a.column} is absent after ALTER. ` +
            'The audit trail cannot record Old Value / New Value on this database.',
        );
      }
    } catch (e) {
      ok = false;
      console.error(`bill_handover column verification failed (${a.table}.${a.column}):`, e);
    }
  }

  if (ok) verified = true;
  return ok;
}
