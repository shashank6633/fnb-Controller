/**
 * BOH TIMELINE — THE INSERTION-ORDER TIE-BREAK
 * ============================================
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
 * Every BOH history row is stamped by SQLite's datetime('now'), which has
 * ONE-SECOND resolution, and every row's primary key is crypto.randomUUID()
 * (db.ts:9115 — random, not time-sortable). getBohTimeline therefore orders by
 * `created_at ASC, id ASC`, and rows written inside the same second come back
 * in RANDOM order.
 *
 * Measured on a booted server before this file existed: three handovers fired
 * back to back rendered as
 *     Handed from ZZFX Admin to Ravi   (first handover)
 *     Handed from Priya to Ravi        (THIRD handover)
 *     Handed from Ravi to Priya        (second handover)
 * — a chain in which Priya hands the bill on before she is ever given it. The
 * audit log was shuffled outright, with `create` rendered last and a payment
 * that took the balance 300 -> 600 shown above the one that took it 0 -> 100.
 *
 * On a record whose entire purpose is to be the permanent, unrewritable account
 * of what happened, an impossible order is a correctness defect, not a cosmetic
 * one.
 *
 * ── THE FIX: rowid, WHICH IS ALREADY THERE ─────────────────────────────────
 * boh_assignments / boh_followups / boh_payments / audit_events all declare a
 * TEXT PRIMARY KEY, so each is an ordinary rowid table and SQLite already keeps
 * a monotonically increasing insertion counter for it. Nothing had to be added
 * to the schema, nothing had to be migrated, and no existing row had to change:
 * the ordering information was in the database the whole time, it was simply
 * never selected (`SELECT *` does not return rowid).
 *
 * WHY THAT IS SOUND HERE, precisely: SQLite hands a new row max(rowid)+1, and
 * it reuses a rowid only after the row holding the maximum is DELETED. These
 * are the append-only history tables — `grep -rnoE "DELETE FROM +(boh_followups
 * |boh_payments|boh_assignments|audit_events)" src/` returns nothing, and
 * reverseBohPayment appends a linked negative row rather than removing one — so
 * within a BOH's rows the sequence is strictly increasing and is the true order
 * of writing. If a future lane ever adds a DELETE to one of these tables it
 * breaks THIS guarantee too, which is one more reason not to.
 *
 * ── WHAT IT DOES AND DOES NOT ORDER ────────────────────────────────────────
 * A rowid is per-table, so `seq` is comparable only BETWEEN ROWS OF THE SAME
 * KIND. Across kinds the screen keeps the existing kind precedence
 * (hold < assign < follow-up < payment < reminder < close), and the timestamp
 * still decides whenever the timestamps differ. So:
 *     · two handovers in one second   — now ordered by when they were written
 *     · two payments in one second    — now ordered by when they were written
 *     · every audit row               — now ordered by when it was written
 *     · a payment and a follow-up in the same second — still ordered by kind,
 *       which is a convention, not a measurement. Closing that would need one
 *       global sequence shared by every table; it is not worth a schema change
 *       for a sub-second ambiguity, and it is recorded here rather than hidden.
 *
 * ── WHY THIS IS A SEPARATE FILE ────────────────────────────────────────────
 * src/lib/boh.ts is being edited by another lane in the same working tree. This
 * lane adds ZERO lines to it, and zero to src/lib/db.ts. The only shared file
 * touched is src/app/api/boh/[id]/route.ts, which gains one import and wraps
 * one existing call. Precedent for a leaf file like this: boh-schema.ts,
 * bill-handover-schema.ts, reviews/schema.ts.
 */
import type Database from 'better-sqlite3';

/** A history row as the screen receives it, once the sequence is attached. */
export type SeqRow = Record<string, unknown> & { id?: unknown; seq?: number };

interface Timeline {
  assignments: any[];
  followups: any[];
  payments: any[];
  reminders: any[];
  audit: any[];
}

/** id -> rowid for one table's rows belonging to this BOH. Never throws. */
function seqMap(db: Database.Database, sql: string, param: string): Map<string, number> {
  const m = new Map<string, number>();
  try {
    for (const r of db.prepare(sql).all(param) as any[]) {
      m.set(String(r.id), Number(r.seq) || 0);
    }
  } catch {
    /* A missing table or column must never take the record page down: the
       screen falls back to the kind precedence it used before this file. */
  }
  return m;
}

/** Stamp `seq` onto each row and re-sort the array by (timestamp, seq). */
function order<T extends SeqRow>(rows: T[], m: Map<string, number>, tsKey: string): T[] {
  const out = (rows || []).map(r => ({ ...r, seq: m.get(String((r as any).id)) ?? 0 }));
  return out.sort((a, b) =>
    String((a as any)[tsKey] || '').localeCompare(String((b as any)[tsKey] || '')) || (a.seq! - b.seq!));
}

/**
 * Attach the true insertion order to every history array of one BOH's timeline.
 *
 * Four extra reads, each on an existing index (idx_boh_assignments_boh,
 * idx_boh_followups_boh, idx_boh_payments_boh, idx_audit_entity). Read-only:
 * there is no INSERT, UPDATE or DELETE anywhere in this file.
 */
export function attachTimelineSeq<T extends Timeline>(db: Database.Database, bohId: string, timeline: T): T {
  const id = String(bohId || '');

  const assignments = order(
    timeline.assignments,
    seqMap(db, 'SELECT id, rowid AS seq FROM boh_assignments WHERE boh_id = ?', id),
    'changed_at',
  );
  const followups = order(
    timeline.followups,
    seqMap(db, 'SELECT id, rowid AS seq FROM boh_followups WHERE boh_id = ?', id),
    'created_at',
  );
  const payments = order(
    timeline.payments,
    seqMap(db, 'SELECT id, rowid AS seq FROM boh_payments WHERE boh_id = ?', id),
    'created_at',
  );
  // boh_reminders is INTEGER PRIMARY KEY AUTOINCREMENT, so its own id IS the
  // monotonic sequence — no lookup needed and none possible to get wrong.
  const reminders = (timeline.reminders || []).map(r => ({ ...r, seq: Number(r?.id) || 0 }))
    .sort((a: any, b: any) => (a.seq - b.seq));
  // The audit array comes from the boh_audit VIEW, which has no rowid of its
  // own; its `id` is audit_events.id, so the base table supplies the sequence.
  // The same map also serves getBohTimeline's raw-table fallback, which selects
  // the identical id.
  const audit = order(
    timeline.audit,
    seqMap(db, `SELECT id, rowid AS seq FROM audit_events WHERE entity_type = 'boh' AND entity_id = ?`, id),
    'created_at',
  );

  return { ...timeline, assignments, followups, payments, reminders, audit };
}
