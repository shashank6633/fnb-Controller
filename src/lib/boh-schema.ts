/**
 * BILL ON HOLD (BOH) — SCHEMA
 * ===========================
 *
 * The owner's objective, verbatim: "to create a complete BOH lifecycle and
 * accountability system — from the moment a POS bill is placed on hold until
 * the entire payment is collected and the BOH is officially closed."
 *
 * ── WHY THIS FILE IS NOT IN db.ts ────────────────────────────────────────────
 * src/lib/db.ts has FOUR concurrent editors carrying uncommitted hunks inside
 * initializeSchema right now (butchering ~4102, party_issue ~5384, the store
 * bill-handover call site ~7749, and the gated-liquor foundation ~8473, which
 * owns every line to the end of the function). A 400-line DDL block there would
 * be a fifth merge surface in one function. The whole module lives here and
 * db.ts carries ONE require() call site, placed in the largest gap between
 * those hunks — the same shape src/lib/bill-handover-schema.ts already uses,
 * and for the same reason.
 *
 * ── WHY IT VERIFIES ITSELF ───────────────────────────────────────────────────
 * initializeSchema SWALLOWS errors per block, and a multi-statement exec stops
 * at its first failing statement and silently skips the rest of that string. So
 * this file runs ONE try/catch PER STATEMENT, then proves the tables exist
 * against sqlite_master before it will claim success. Every /api/boh route calls
 * ensureBohSchema() on first use as well, so a boot failure swallowed in db.ts
 * is repaired by the next request instead of becoming a permanent
 * "no such table" 500.
 *
 * ── THIS FILE IS A LEAF ──────────────────────────────────────────────────────
 * It imports better-sqlite3's TYPES and nothing else. db.ts pulls it in with
 * require() inside initializeSchema, so importing back into db.ts here would
 * close a cycle at module-init time. Take the `db` handle as a parameter; never
 * call getDb() from this file.
 *
 * ── NOTHING IS EVER OVERWRITTEN OR DELETED ───────────────────────────────────
 * The owner said so twice. Every history table here is APPEND-ONLY by design:
 *   · boh_assignments  — one row per reassignment, previous + new user both kept
 *   · boh_followups    — one row per follow-up, never updated
 *   · boh_payments     — one row per collection; a mistake is corrected by a
 *                        NEW negative row carrying reverses_payment_id, never
 *                        by an UPDATE or a DELETE
 *   · boh_reminders    — one row per (BOH, due date) slot, the fire ledger
 *   · audit_events     — via logAuditEvent (before_json/after_json = the
 *                        owner's "old value / new value"). NOT a second audit
 *                        table: the `boh_audit` VIEW below gives the boh_*
 *                        namespace a queryable window onto the one store.
 * The engine (src/lib/boh.ts) enforces this in code; the schema states it so a
 * future reader cannot mistake an UPDATE here for an accident.
 *
 * ── THE CORRECTNESS RULE OF THE WHOLE MODULE ─────────────────────────────────
 * A BOH PAYMENT IS A PAYMENT RECORD. IT IS NOT A SALE. `on_hold` already
 * performed every irreversible half of a settle except taking the money — it
 * wrote the `sales` rows, deducted the stock and froze the totals
 * (src/lib/station-master.ts:430, src/app/api/dine-in/orders/[id]/hold). So NO
 * table in this namespace may ever be joined to a revenue or stock rail, and
 * the engine snapshots those rails around every write to prove it did not.
 */
import type Database from 'better-sqlite3';

/** Tables that MUST exist for the module to be usable. */
export const BOH_TABLES = [
  'boh_bills',
  'boh_assignments',
  'boh_followups',
  'boh_payments',
  'boh_reminders',
  'boh_notifications',
] as const;

/** The audit VIEW — checked separately because a view is not a table. */
export const BOH_VIEWS = ['boh_audit'] as const;

/**
 * The lifecycle states a BOH row can hold.
 *   open    — money still outstanding; reminders fire; follow-ups expected
 *   closed  — settled. Reached ONLY at balance <= 0 (auto), or by a management
 *             write-off which is a DISTINCT audited action with mandatory
 *             remarks (close_kind = 'write_off').
 *   void    — created in error. ADMIN ONLY. The row and every child row STAY;
 *             void is a status, never a DELETE.
 */
export const BOH_STATUSES = ['open', 'closed', 'void'] as const;
export type BohStatus = (typeof BOH_STATUSES)[number];

/**
 * Follow-up outcomes — the owner's list, verbatim and in his order. Stored as
 * these exact tokens so the accountability view cannot drift from the form.
 */
export const BOH_OUTCOMES = [
  'payment_received',
  'not_received',
  'more_time',
  'not_responding',
  'payment_processing',
  'dispute',
  'other',
] as const;
export type BohOutcome = (typeof BOH_OUTCOMES)[number];

/**
 * Payment modes. DELIBERATELY the same eight tokens as VALID_METHODS in
 * src/app/api/dine-in/orders/[id]/settle/route.ts:14 — when the final clearing
 * payment closes the order, the BOH ledger is replayed into `order_payments`,
 * and a mode this list allows but settle does not would be a row settle could
 * never have written.
 */
export const BOH_PAYMENT_MODES = [
  'cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other',
] as const;
export type BohPaymentMode = (typeof BOH_PAYMENT_MODES)[number];

interface Ddl { name: string; sql: string }

const BOH_TABLE_DDL: Ddl[] = [
  {
    name: 'boh_bills',
    sql: `
      -- ── THE BOH RECORD ────────────────────────────────────────────────────
      -- One row per held POS bill. order_id is the link and the identity: the
      -- POS already holds bills (orders.status='on_hold'), and this module does
      -- NOT build a second hold. The partial UNIQUE index below allows exactly
      -- one LIVE (open|closed) BOH per order while leaving voided rows in place
      -- so a mis-created record can be voided and re-created without deleting
      -- the evidence.
      --
      -- principal_amount IS FROZEN AT CREATION and never recomputed. It is
      -- Math.round(orders.total) — the WHOLE-RUPEE figure, not orders.total
      -- itself — because settle-from-hold collects Math.round(order.total) and
      -- overwrites orders.total with that integer (settle/route.ts:121,237).
      -- Tracking the unrounded value would leave a balance that could never
      -- reach exactly zero, by up to Rs 0.50. /cashier already shows this same
      -- rounded figure (cashier/page.tsx:156).
      --
      -- customer_name / customer_mobile are the module's reason for existing:
      -- measured on the owner's data, 0 of 37 orders carry guest_mobile and 1
      -- carries guest_name. contact_source records where the number came from
      -- so a blank is visibly a blank and not an assumed one.
      CREATE TABLE IF NOT EXISTS boh_bills (
        id                    TEXT PRIMARY KEY,
        order_id              TEXT NOT NULL,
        outlet_id             TEXT,
        -- Denormalised at creation so the register still reads correctly if a
        -- table is renamed or an order row is edited underneath it. The ORDER
        -- remains the source of truth for money; these are labels.
        bill_number           TEXT NOT NULL DEFAULT '',
        bill_date             TEXT NOT NULL DEFAULT '',   -- IST YYYY-MM-DD of the hold
        held_at               TEXT NOT NULL DEFAULT '',
        table_label           TEXT NOT NULL DEFAULT '',
        customer_name         TEXT NOT NULL DEFAULT '',
        customer_mobile       TEXT NOT NULL DEFAULT '',   -- last-10 form (norm10)
        customer_company      TEXT NOT NULL DEFAULT '',
        contact_source        TEXT NOT NULL DEFAULT 'missing', -- captured|order|crm|missing
        crm_guest_id          TEXT NOT NULL DEFAULT '',
        reason                TEXT NOT NULL DEFAULT '',
        remarks               TEXT NOT NULL DEFAULT '',
        department_id         TEXT NOT NULL DEFAULT '',
        department_name       TEXT NOT NULL DEFAULT '',
        -- A BOH MUST NEVER EXIST WITHOUT A RESPONSIBLE USER. NOT NULL with no
        -- default: an INSERT that omits it fails loudly rather than producing an
        -- unowned debt, which is the one record this module cannot be built on.
        responsible_user_id   TEXT NOT NULL,
        responsible_email     TEXT NOT NULL DEFAULT '',
        responsible_name      TEXT NOT NULL DEFAULT '',
        expected_payment_date TEXT NOT NULL DEFAULT '',   -- IST YYYY-MM-DD
        principal_amount      REAL NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'open',
        -- 'paid_in_full' (arithmetic, automatic) | 'write_off' (judgement,
        -- management, mandatory remarks) | 'settled_outside_boh' (the bill was
        -- collected through the POS while this record was open).
        close_kind            TEXT NOT NULL DEFAULT '',
        close_remarks         TEXT NOT NULL DEFAULT '',
        closed_at             TEXT NOT NULL DEFAULT '',
        closed_by             TEXT NOT NULL DEFAULT '',
        void_reason           TEXT NOT NULL DEFAULT '',
        voided_at             TEXT NOT NULL DEFAULT '',
        voided_by             TEXT NOT NULL DEFAULT '',
        -- Records what the clearing step did to the ORDER, so a refusal is
        -- visible rather than silent: '' (nothing yet) | 'settled' | 'skipped'
        -- | 'refused_total_mismatch' | 'already_settled'.
        order_sync            TEXT NOT NULL DEFAULT '',
        order_sync_note       TEXT NOT NULL DEFAULT '',
        created_by            TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  },
  {
    name: 'boh_assignments',
    sql: `
      -- ── RESPONSIBILITY HISTORY ────────────────────────────────────────────
      -- The owner: "every reassignment recorded (previous user, new user,
      -- changed by, when, why)". APPEND-ONLY. The FIRST row is written at
      -- creation with prev_user_id = '' so the chain starts at the cashier who
      -- held the bill rather than at the first hand-off — otherwise the
      -- original owner is the one person the history cannot name.
      CREATE TABLE IF NOT EXISTS boh_assignments (
        id              TEXT PRIMARY KEY,
        boh_id          TEXT NOT NULL,
        prev_user_id    TEXT NOT NULL DEFAULT '',
        prev_user_name  TEXT NOT NULL DEFAULT '',
        new_user_id     TEXT NOT NULL,
        new_user_name   TEXT NOT NULL DEFAULT '',
        reason          TEXT NOT NULL DEFAULT '',
        changed_by      TEXT NOT NULL DEFAULT '',
        changed_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  },
  {
    name: 'boh_followups',
    sql: `
      -- ── FOLLOW-UP LOG ─────────────────────────────────────────────────────
      -- answered_expected_date IS THE LOAD-BEARING COLUMN, and it is why a
      -- "missed follow-up" can be counted exactly.
      --
      -- A follow-up answers a PROMISE, not a clock. Deriving "missed" from
      -- created_at > expected_date breaks the moment someone logs a follow-up
      -- EARLY (the customer rings on the 16th about an 18th date — perfectly
      -- normal), and after three re-dates a bare timestamp cannot say which
      -- promise a row was answering. Storing the date being answered makes
      --   MISSED = open AND expected < today AND NOT EXISTS(followup for that date)
      -- exact, and lets each miss NAME the date that lapsed — which is what
      -- makes the user-wise accountability view defensible to the person it
      -- counts against.
      --
      -- next_expected_date is the new promise. Writing it re-dates the bill and
      -- therefore opens a NEW reminder slot; yesterday's slot is spent and can
      -- never replay. That is the owner's loop, "until settled".
      CREATE TABLE IF NOT EXISTS boh_followups (
        id                     TEXT PRIMARY KEY,
        boh_id                 TEXT NOT NULL,
        answered_expected_date TEXT NOT NULL DEFAULT '',  -- IST YYYY-MM-DD
        outcome                TEXT NOT NULL,
        remarks                TEXT NOT NULL DEFAULT '',
        next_expected_date     TEXT NOT NULL DEFAULT '',  -- IST YYYY-MM-DD
        created_by             TEXT NOT NULL DEFAULT '',
        created_by_name        TEXT NOT NULL DEFAULT '',
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  },
  {
    name: 'boh_payments',
    sql: `
      -- ── PAYMENTS (PARTIALS SUPPORTED) ─────────────────────────────────────
      -- THE ONE TABLE THE MONEY RULE IS ABOUT. A row here is a COLLECTION
      -- EVENT against a sale that was already booked at hold. It is NOT a sale:
      -- writing it must not produce a \`sales\` row, an inventory_transactions
      -- row, a department_material_transactions row, a consumption_skips row,
      -- a store_stock_ledger row, or any change to orders.subtotal /
      -- tax_total / service_charge / discount / total. src/lib/boh.ts snapshots
      -- all six rails inside the same transaction and THROWS (rolling the
      -- payment back) if any of them moved.
      --
      -- AND IT IS NOT order_payments. settle/route.ts:263 is an unconditional
      -- "DELETE FROM order_payments WHERE order_id = ?" on BOTH branches, so a
      -- partial parked there is erased by the final settle. BOH partials need
      -- their own table; they are REPLAYED into order_payments once, by the
      -- clearing step, at the moment the order actually settles.
      --
      -- APPEND-ONLY. amount > 0 for a collection. A mistake is corrected by a
      -- NEW row with a negative amount and reverses_payment_id set (admin
      -- only) — never by an UPDATE and never by a DELETE.
      CREATE TABLE IF NOT EXISTS boh_payments (
        id                  TEXT PRIMARY KEY,
        boh_id              TEXT NOT NULL,
        order_id            TEXT NOT NULL DEFAULT '',
        paid_on             TEXT NOT NULL DEFAULT '',   -- IST YYYY-MM-DD, the owner's "date"
        amount              REAL NOT NULL,
        mode                TEXT NOT NULL DEFAULT 'cash',
        reference           TEXT NOT NULL DEFAULT '',   -- UTR / cheque no / txn ref
        remarks             TEXT NOT NULL DEFAULT '',
        reverses_payment_id TEXT NOT NULL DEFAULT '',
        created_by          TEXT NOT NULL DEFAULT '',
        created_by_name     TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  },
  {
    name: 'boh_reminders',
    sql: `
      -- ── THE REMINDER CLAIM LEDGER ─────────────────────────────────────────
      -- Modelled on wa_report_runs + claimRun (src/lib/wa-report-jobs.ts:296),
      -- because that is the stronger of the two idempotency shapes in this repo.
      -- The unique partial index on (boh_id, due_date) WHERE
      -- trigger_source='scheduler' plus ONE atomic upsert means there is no
      -- window between "check" and "claim" for a second tick to slip through —
      -- because there is no separate check.
      --
      -- Four properties copied deliberately:
      --   · due_date is the IST calendar day. UTC rolls at 05:30 IST, which
      --     would let two reminders on one Indian morning land on different
      --     "days" and fire twice.
      --   · A FAILURE DOES NOT BURN THE SLOT. Only sent|skipped hold it;
      --     failed|refused is re-claimable next tick, so a transient outage
      --     still gets the reminder out the same day.
      --   · A stale 'running' claim is re-claimable after 10 minutes, so a
      --     process killed mid-send does not wedge the bill until midnight.
      --   · The partial index lets any number of manual "remind now" rows
      --     coexist without consuming or satisfying the scheduled slot.
      CREATE TABLE IF NOT EXISTS boh_reminders (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        boh_id         TEXT NOT NULL,
        due_date       TEXT NOT NULL,                 -- IST YYYY-MM-DD being reminded about
        status         TEXT NOT NULL DEFAULT 'running', -- running|sent|skipped|failed|refused
        trigger_source TEXT NOT NULL DEFAULT 'scheduler',
        -- What actually went out, per channel, so the screen can say WHY the
        -- WhatsApp leg was dark without guessing.
        inapp_status   TEXT NOT NULL DEFAULT '',
        wa_status      TEXT NOT NULL DEFAULT '',
        wa_reason      TEXT NOT NULL DEFAULT '',
        recipient      TEXT NOT NULL DEFAULT '',
        detail         TEXT NOT NULL DEFAULT '',
        days_pending   INTEGER NOT NULL DEFAULT 0,
        attempts       INTEGER NOT NULL DEFAULT 0,
        actor          TEXT NOT NULL DEFAULT '',
        claimed_at     TEXT NOT NULL DEFAULT '',
        finished_at    TEXT NOT NULL DEFAULT ''
      )
    `,
  },
  {
    name: 'boh_notifications',
    sql: `
      -- ── DURABLE IN-APP FEED ───────────────────────────────────────────────
      -- Same shape as hr_notifications (db.ts:8460) and written by the same
      -- kind of producer (src/lib/boh-notify.ts, modelled on hr-notify.ts).
      --
      -- DURABLE, NOT localStorage. src/lib/notif-ack.ts acks the bell per
      -- DEVICE, which cannot answer "did the responsible person ever see this
      -- reminder" — and the owner asked that history is never overwritten. The
      -- bell reads ONE counted bucket off this table; see
      -- src/app/api/notifications/inbox/route.ts. The badge SUMS \`count\` across
      -- buckets, so BOH is one item with a count, never one item per bill.
      CREATE TABLE IF NOT EXISTS boh_notifications (
        id              TEXT PRIMARY KEY,
        boh_id          TEXT NOT NULL DEFAULT '',
        recipient_email TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'boh.reminder',
        title           TEXT NOT NULL DEFAULT '',
        body            TEXT NOT NULL DEFAULT '',
        href            TEXT NOT NULL DEFAULT '/boh',
        is_read         INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `,
  },
];

const BOH_INDEX_DDL: Ddl[] = [
  {
    // ONE LIVE BOH PER ORDER. Partial so a voided record does not block a
    // re-create, and so the voided evidence is never deleted to make room.
    name: 'ux_boh_bills_order_live',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS ux_boh_bills_order_live
            ON boh_bills(order_id) WHERE status <> 'void'`,
  },
  {
    // THE CLAIM. One reminder per (BOH, due date) from the scheduler; manual
    // sends are trigger_source <> 'scheduler' and never occupy the slot.
    name: 'ux_boh_reminders_slot',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS ux_boh_reminders_slot
            ON boh_reminders(boh_id, due_date) WHERE trigger_source = 'scheduler'`,
  },
  // The reminder job's "is anything due" query runs on EVERY scheduler tick
  // (~1,435 ticks a day). This index is what makes it cost microseconds when
  // nothing is due, which is the contract the reviews block sets next door.
  {
    name: 'idx_boh_bills_due',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_bills_due
            ON boh_bills(status, expected_payment_date)`,
  },
  {
    name: 'idx_boh_bills_responsible',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_bills_responsible
            ON boh_bills(responsible_user_id, status)`,
  },
  {
    // Permanent searchability by mobile — the owner asked for it by name.
    name: 'idx_boh_bills_mobile',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_bills_mobile ON boh_bills(customer_mobile)`,
  },
  {
    name: 'idx_boh_bills_billno',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_bills_billno ON boh_bills(bill_number)`,
  },
  { name: 'idx_boh_payments_boh',    sql: `CREATE INDEX IF NOT EXISTS idx_boh_payments_boh ON boh_payments(boh_id)` },
  { name: 'idx_boh_followups_boh',   sql: `CREATE INDEX IF NOT EXISTS idx_boh_followups_boh ON boh_followups(boh_id)` },
  {
    // The MISSED / DUE predicate is an EXISTS on exactly this pair.
    name: 'idx_boh_followups_answered',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_followups_answered
            ON boh_followups(boh_id, answered_expected_date)`,
  },
  { name: 'idx_boh_assignments_boh', sql: `CREATE INDEX IF NOT EXISTS idx_boh_assignments_boh ON boh_assignments(boh_id)` },
  {
    name: 'idx_boh_notif_recipient',
    sql: `CREATE INDEX IF NOT EXISTS idx_boh_notif_recipient
            ON boh_notifications(recipient_email, is_read)`,
  },
];

const BOH_VIEW_DDL: Ddl[] = [
  {
    // ── THE AUDIT WINDOW, NOT A SECOND AUDIT TABLE ────────────────────────
    // The owner asked for "a complete audit log (action, old value, new value,
    // updated by, date/time)". logAuditEvent (db.ts:9074) already writes
    // exactly that into audit_events — event_type / before_json / after_json /
    // actor_email / created_at — never throws, and is indexed on
    // (entity_type, entity_id) by idx_audit_entity. Building a boh_audit TABLE
    // would be a second store of the same facts that could disagree with the
    // first.
    //
    // So the store is audit_events and this VIEW is the boh_* namespace's
    // window onto it. One store, one namespace, zero duplication. Every BOH
    // write calls logAuditEvent with entity_type = 'boh'.
    name: 'boh_audit',
    sql: `
      CREATE VIEW IF NOT EXISTS boh_audit AS
        SELECT id,
               event_type  AS action,
               entity_id   AS boh_id,
               before_json AS old_value,
               after_json  AS new_value,
               actor_email AS updated_by,
               note,
               created_at
          FROM audit_events
         WHERE entity_type = 'boh'
    `,
  },
];

/** Process-level memo so the per-request call costs nothing after the first. */
let verified = false;

function runDdl(db: Database.Database, sql: string): void {
  db.prepare(sql).run();
}

/**
 * Create every BOH table / index / view if absent, then PROVE they are there.
 *
 * Idempotent: every statement is CREATE ... IF NOT EXISTS, so a second call on
 * a populated database is a no-op that touches no row. Returns false (and logs
 * the specific object) when verification fails, so a caller can refuse rather
 * than 500 on a missing table.
 *
 * `force` re-runs even when the memo says verified — db.ts passes true on boot
 * so a long-lived process that saw one bad boot is not stuck with the memo.
 */
export function ensureBohSchema(db: Database.Database, force = false): boolean {
  if (verified && !force) return true;

  // ONE try/catch PER STATEMENT, deliberately. A multi-statement exec stops at
  // its first failing statement and silently skips the rest of the string: one
  // combined call would let a single bad CREATE take five tables and two UNIQUE
  // constraints with it behind one misleading log line.
  for (const stmt of BOH_TABLE_DDL) {
    try { runDdl(db, stmt.sql); }
    catch (e) { console.error(`boh schema failed (${stmt.name}):`, e); }
  }
  for (const idx of BOH_INDEX_DDL) {
    try { runDdl(db, idx.sql); }
    catch (e) { console.error(`boh index failed (${idx.name}):`, e); }
  }
  for (const v of BOH_VIEW_DDL) {
    try { runDdl(db, v.sql); }
    catch (e) { console.error(`boh view failed (${v.name}):`, e); }
  }

  // PROVE it rather than assume it — initializeSchema's catch would otherwise
  // let a missing table through in silence.
  let ok = true;
  for (const t of BOH_TABLES) {
    try {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(t) as { name?: string } | undefined;
      if (!row?.name) { ok = false; console.error(`boh schema verification failed: table ${t} is absent`); }
    } catch (e) { ok = false; console.error(`boh schema verification failed (${t}):`, e); }
  }
  for (const v of BOH_VIEWS) {
    try {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name = ?`).get(v) as { name?: string } | undefined;
      // A view over audit_events is a convenience, not a dependency — the
      // engine writes and reads audit_events directly. Log it, don't fail on it.
      if (!row?.name) console.error(`boh schema note: view ${v} is absent (audit still recorded in audit_events)`);
    } catch { /* view check is advisory */ }
  }

  if (ok) verified = true;
  return ok;
}
