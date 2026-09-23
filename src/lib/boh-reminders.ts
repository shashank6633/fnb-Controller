/**
 * BILL ON HOLD — THE REMINDER JOB
 * ===============================
 *
 * The owner: an expected payment date "generates a REMINDER on the day, in-app
 * and by WhatsApp where available, showing BOH Bill No. | Customer | Amount |
 * Expected Payment Date | Days Pending".
 *
 * ── THE CONTRACT WITH THE SCHEDULER ─────────────────────────────────────────
 * This module is imported dynamically by src/lib/scheduler.ts, inside its own
 * try/catch, ABOVE the tick's unguarded refreshUpcomingParties() call. Four
 * properties, copied from the runReviewAutoRefresh block added next door:
 *
 *   1. IT NEVER THROWS. Every path returns an outcome object.
 *   2. IT IS CHEAP WHEN NOTHING IS DUE. The first statement is one indexed
 *      COUNT over idx_boh_bills_due that returns in microseconds on the ~1,435
 *      ticks a day when nothing is owed, and the function returns 'not_due'
 *      before touching anything else.
 *   3. IT IS PLACED WHERE IT CANNOT BE STARVED. refreshUpcomingParties is the
 *      tick's UNGUARDED first statement — when Google Sheets fails (expired
 *      ADC, org policy, quota, network), control jumps to the outer catch and
 *      every job after it is skipped for that tick. A reminder that only fires
 *      on days Sheets is reachable is not a reminder; the owner's money is
 *      chased on the other days too.
 *   4. IT STAMPS ITS OWN HEARTBEAT (boh_reminders rows are the heartbeat)
 *      rather than trusting globalThis.__fnbScheduler__.lastRun, which is
 *      never stamped on exactly the ticks that half-fail.
 *
 * ── ONCE PER BOH PER DUE DATE, PROVEN BY A CLAIM ────────────────────────────
 * claimSlot() below is ONE atomic upsert against a UNIQUE partial index, taken
 * verbatim in shape from claimRun() in src/lib/wa-report-jobs.ts:296. Two
 * concurrent ticks both execute it, SQLite serialises them, and exactly one
 * sees changes === 1. There is no window between "check" and "claim" for a
 * second tick to slip through, BECAUSE THERE IS NO SEPARATE CHECK.
 *
 * A ledger fault returns null — refusing to claim means refusing to send, the
 * safe direction for a rail whose entire job is "not twice".
 *
 * ── AND WHY THE SLOT IS A DATE, NOT A TIMESTAMP ─────────────────────────────
 * due_date is the BOH's CURRENT expected payment date as an IST YYYY-MM-DD. So
 * when a follow-up sets a NEW expected date, that is a new due_date, a new slot
 * and a new reminder — the owner's loop, "until settled" — with no risk that
 * re-dating replays yesterday's reminder.
 */
import type Database from 'better-sqlite3';
import { ensureBohSchema } from './boh-schema';
import { bohToday, daysBetween, IST_TODAY_SQL, money2 } from './boh';
import {
  notifyBohUser, sendBohWaReminder, bohWaReadiness, bohReminderText,
  type BohReminderFacts,
} from './boh-notify';

/**
 * How long a 'running' claim is respected before another tick may take it.
 * Long enough that a genuine send is never stolen mid-flight; short enough that
 * a process killed mid-send does not wedge the reminder until midnight.
 */
export const BOH_CLAIM_STALE_MS = 10 * 60_000;

export interface BohReminderRun {
  outcome: 'not_due' | 'ran' | 'schema_unavailable' | 'error';
  due: number;
  claimed: number;
  inapp_sent: number;
  wa_sent: number;
  wa_blocked: number;
  skipped: number;
  detail: string;
}

const S = (v: unknown): string => String(v ?? '').trim();

/**
 * Claim one (BOH, due date) slot. Returns the row id, or null when the slot is
 * already held.
 *
 * ONE STATEMENT. That is the whole point.
 *
 * Three properties copied deliberately from claimRun:
 *   · A FAILURE DOES NOT BURN THE SLOT. Only 'sent' and 'skipped' hold it;
 *     'failed' and 'refused' are re-claimable on the next tick, so a transient
 *     outage still gets the reminder out the same day.
 *   · A STALE 'running' CLAIM is re-claimable after BOH_CLAIM_STALE_MS.
 *   · The partial index covers trigger_source='scheduler' only, so any number
 *     of manual "remind now" rows can coexist without consuming or satisfying
 *     the scheduled slot.
 */
export function claimSlot(db: Database.Database, bohId: string, dueDate: string): number | null {
  const staleSeconds = Math.round(BOH_CLAIM_STALE_MS / 1000);
  try {
    const info = db.prepare(`
      INSERT INTO boh_reminders (boh_id, due_date, status, trigger_source, attempts, claimed_at)
      VALUES (@boh, @due, 'running', 'scheduler', 1, datetime('now'))
      ON CONFLICT(boh_id, due_date) WHERE trigger_source = 'scheduler'
      DO UPDATE SET status = 'running', attempts = boh_reminders.attempts + 1,
                    claimed_at = datetime('now'), finished_at = ''
       WHERE boh_reminders.status NOT IN ('sent', 'skipped')
         AND (boh_reminders.status <> 'running'
              OR boh_reminders.claimed_at < datetime('now', @stale))
    `).run({ boh: S(bohId), due: S(dueDate), stale: `-${staleSeconds} seconds` });
    if (!info.changes) return null;
    const row = db.prepare(
      `SELECT id FROM boh_reminders WHERE boh_id = ? AND due_date = ? AND trigger_source = 'scheduler'`,
    ).get(S(bohId), S(dueDate)) as any;
    return row?.id != null ? Number(row.id) : null;
  } catch {
    // A ledger fault must not become a send.
    return null;
  }
}

function finishSlot(
  db: Database.Database,
  id: number,
  patch: { status: string; inapp?: string; wa?: string; waReason?: string; recipient?: string; detail?: string; days?: number },
): void {
  try {
    db.prepare(`
      UPDATE boh_reminders SET status = ?, inapp_status = ?, wa_status = ?, wa_reason = ?,
             recipient = ?, detail = ?, days_pending = ?, finished_at = datetime('now')
       WHERE id = ?
    `).run(patch.status, patch.inapp || '', patch.wa || '', (patch.waReason || '').slice(0, 500),
           patch.recipient || '', (patch.detail || '').slice(0, 500), patch.days ?? 0, id);
  } catch (e) { console.error('[boh] finishSlot failed:', e); }
}

/**
 * THE DUE QUERY. An open BOH whose current expected payment date is TODAY OR
 * EARLIER (IST) and which still has money outstanding.
 *
 * "or earlier", not "exactly today", deliberately: a reminder that only fires
 * on the day itself is silent forever on a bill nobody re-dated, which is
 * precisely the bill most in need of chasing. Each overdue day is still ONE
 * slot, because the slot key is the expected date, not the calendar day — so an
 * un-re-dated bill is reminded once and then waits for a follow-up to move it.
 *
 * A BOH whose underlying bill is no longer 'on_hold' is EXCLUDED: that money
 * was collected through the POS, and telling someone to chase it would be
 * wrong. Those rows are surfaced on the dashboard as reconcile_needed instead —
 * they are never silently auto-closed.
 */
const DUE_SQL = `
  FROM boh_bills b
  LEFT JOIN orders o ON o.id = b.order_id
 WHERE b.status = 'open'
   AND b.expected_payment_date <> ''
   AND b.expected_payment_date <= ${IST_TODAY_SQL}
   AND (b.principal_amount - COALESCE((SELECT SUM(p.amount) FROM boh_payments p WHERE p.boh_id = b.id), 0)) > 0.005
   AND COALESCE(o.status, '') = 'on_hold'
`;

/**
 * The scheduler's entry point. NEVER THROWS.
 *
 * `limit` caps one tick's work so a backlog (a venue that just switched the
 * module on with 200 old held bills) cannot make a single tick long. The rest
 * are picked up on the next tick five minutes later; the claim makes that safe.
 */
export async function runBohReminders(
  db: Database.Database,
  opts: { limit?: number } = {},
): Promise<BohReminderRun> {
  const out: BohReminderRun = {
    outcome: 'not_due', due: 0, claimed: 0, inapp_sent: 0, wa_sent: 0, wa_blocked: 0, skipped: 0, detail: '',
  };
  try {
    // THE CHEAP GATE. One indexed COUNT over idx_boh_bills_due. On the ~1,435
    // ticks a day when nothing is owed this is the whole cost of the job.
    let due = 0;
    try {
      due = Number((db.prepare(`SELECT COUNT(*) AS n ${DUE_SQL}`).get() as any)?.n ?? 0);
    } catch {
      // The tables are not there yet (first boot on an existing database, or a
      // swallowed schema error). Build them once, then answer honestly.
      if (!ensureBohSchema(db, true)) { out.outcome = 'schema_unavailable'; out.detail = 'BOH tables unavailable'; return out; }
      try { due = Number((db.prepare(`SELECT COUNT(*) AS n ${DUE_SQL}`).get() as any)?.n ?? 0); }
      catch (e2) { out.outcome = 'schema_unavailable'; out.detail = String((e2 as any)?.message || e2); return out; }
    }
    out.due = due;
    if (due === 0) return out;                       // 'not_due' — the common answer

    out.outcome = 'ran';
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const rows = db.prepare(`
      SELECT b.id, b.bill_number, b.customer_name, b.customer_mobile, b.expected_payment_date,
             b.principal_amount, b.responsible_user_id, b.responsible_email, b.responsible_name,
             (b.principal_amount - COALESCE((SELECT SUM(p.amount) FROM boh_payments p WHERE p.boh_id = b.id), 0)) AS balance
      ${DUE_SQL}
      ORDER BY b.expected_payment_date ASC, b.created_at ASC
      LIMIT ?
    `).all(limit) as any[];

    // Read the WhatsApp gate ONCE per tick, not once per bill: it is a settings
    // read plus a template lookup and the answer cannot differ between two rows
    // of the same tick.
    const wa = bohWaReadiness(db);
    const today = bohToday();

    for (const r of rows) {
      const bohId = S(r.id);
      const dueDate = S(r.expected_payment_date);
      const slot = claimSlot(db, bohId, dueDate);
      if (slot == null) { out.skipped++; continue; }   // another tick holds it — stand down
      out.claimed++;

      const facts: BohReminderFacts = {
        bohId,
        billNo: S(r.bill_number),
        customer: S(r.customer_name) || (S(r.customer_mobile) ? `+91 ${S(r.customer_mobile)}` : 'Guest'),
        amount: money2(r.balance),
        expectedDate: dueDate,
        daysPending: Math.max(daysBetween(dueDate, today), 0),
        responsibleUserId: S(r.responsible_user_id),
        responsibleEmail: S(r.responsible_email),
        responsibleName: S(r.responsible_name),
      };

      // RAIL 1 — in-app. Works today, with no configuration, so it goes first
      // and its success is what makes the slot 'sent'. The WhatsApp leg is a
      // bonus, never the thing the reminder depends on.
      const inapp = notifyBohUser(db, facts);
      if (inapp.ok) out.inapp_sent++;

      // RAIL 2 — WhatsApp, only if it can actually deliver.
      let waStatus = 'blocked';
      let waReason = wa.blockers[0] || '';
      let waTo = '';
      if (wa.ready) {
        try {
          const res = await sendBohWaReminder(db, facts);
          waStatus = res.status; waReason = res.reason; waTo = res.to;
          if (res.ok) out.wa_sent++; else out.wa_blocked++;
        } catch (e) { waStatus = 'failed'; waReason = String((e as any)?.message || e); out.wa_blocked++; }
      } else {
        out.wa_blocked++;
      }

      // The slot is SPENT once the in-app reminder landed, even if WhatsApp
      // could not deliver: re-firing tomorrow would badge the same person about
      // the same promise twice. 'failed' (nothing delivered at all) stays
      // re-claimable, which is the whole reason the status vocabulary has both.
      finishSlot(db, slot, {
        status: inapp.ok ? 'sent' : 'failed',
        inapp: inapp.ok ? 'sent' : `failed:${inapp.reason}`,
        wa: waStatus, waReason, recipient: facts.responsibleEmail,
        detail: bohReminderText(facts), days: facts.daysPending,
      });
    }

    out.detail =
      `${out.claimed} claimed of ${out.due} due · ${out.inapp_sent} in-app · ` +
      `${out.wa_sent} WhatsApp · ${out.wa_blocked} WhatsApp blocked · ${out.skipped} already held`;
    return out;
  } catch (e) {
    // The contract: never throw into the tick.
    out.outcome = 'error';
    out.detail = String((e as any)?.message || e);
    console.error('[boh] runBohReminders failed:', e);
    return out;
  }
}
