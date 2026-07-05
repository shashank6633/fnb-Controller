/**
 * Feature 4 — Smarter defer: warn the store manager BEFORE a deferred
 * requisition item is due, so they can either issue it in time or raise a
 * vendor PO instead of the department getting stranded.
 *
 * Runs on the SAME schedule as refreshUpcomingParties() (the in-process
 * scheduler, ./scheduler.ts, invoked from party-refresh's caller). Best-effort:
 * a failure here must NEVER break the refresh/queue — the caller wraps this in
 * its own try/catch and we also swallow per-notification errors.
 *
 * Detection: requisition_items with
 *   - deferred_until set,
 *   - not yet fully issued (quantity_issued < effective qty, where effective =
 *     chef_approved_qty ?? quantity_requested),
 *   - not chef-rejected (is_rejected) and not store-rejected (store_rejected),
 *   - deferred_until falling within the next ~4 hours (0 ≤ due−now ≤ 4h).
 *
 * For each such line we enqueue ONE notification, deduped by a stable key
 * ('defer-due:'+item_id+':'+deferred_until) carried in party_unique_id so the
 * notifications table's UNIQUE(party_unique_id, kind, channel) constraint makes
 * re-runs idempotent — it fires once per channel. We enqueue an 'inapp' row (so
 * store managers see it in /api/notifications) and, when a Slack webhook is
 * configured, a 'slack' row that we also POST best-effort.
 *
 * Note: deferred_until is stored as the value the store manager picked in a
 * <input type="datetime-local"> (local/IST wall-clock, no timezone suffix).
 * Date.parse() on such a string interprets it in the SERVER's local timezone.
 * We compare against new Date() (also server-local), so the "within 4h" window
 * is consistent as long as both are read the same way. We never use Date.now()
 * arithmetic that would assume a UTC epoch for these bare strings.
 */
import { getDb, generateId } from './db';

const LOOKAHEAD_MS = 4 * 60 * 60 * 1000;   // 4 hours
const DEFER_DUE_KIND = 'defer_due_soon';

export interface DeferDueResult {
  candidates: number;         // deferred, unissued, due within 4h
  notifications_created: number;
  slack_sent: number;
  errors: string[];
}

interface DeferRow {
  id: string;
  req_id: string;
  material_name: string;
  department_name: string | null;
  quantity_requested: number;
  chef_approved_qty: number | null;
  quantity_issued: number;
  deferred_until: string;
  unit: string | null;
  material_unit: string | null;
}

/** Effective qty owed on a line: chef-approved override if set, else requested. */
function effectiveQty(r: DeferRow): number {
  const eff = r.chef_approved_qty != null ? Number(r.chef_approved_qty) : Number(r.quantity_requested);
  return Number.isFinite(eff) ? eff : 0;
}

/**
 * Scan for deferred items about to come due and enqueue store-manager alerts.
 * Idempotent + deduped. Best-effort — always returns; never throws into the
 * scheduler tick.
 */
export async function checkDeferDueSoon(triggeredBy: string = 'cron'): Promise<DeferDueResult> {
  const errors: string[] = [];
  let notifsCreated = 0;
  let slackSent = 0;
  let candidateCount = 0;

  let slackPings: { key: string; title: string; body: string }[] = [];
  let webhook = '';

  try {
    const db = getDb();

    // Pull deferred, still-open, non-rejected lines with their material +
    // department names. We filter the "due within 4h" window in JS so we can
    // parse deferred_until the same way the UI wrote it (bare local datetime).
    const rows = db.prepare(`
      SELECT ri.id, ri.req_id, ri.quantity_requested, ri.chef_approved_qty,
             ri.quantity_issued, ri.deferred_until,
             ri.unit AS unit,
             rm.name AS material_name, rm.unit AS material_unit,
             d.name AS department_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(ri.department_id, (
        SELECT department_id FROM requisitions WHERE id = ri.req_id
      ))
      WHERE ri.deferred_until IS NOT NULL
        AND ri.deferred_until != ''
        AND COALESCE(ri.is_rejected, 0) = 0
        AND COALESCE(ri.store_rejected, 0) = 0
    `).all() as DeferRow[];

    const now = new Date();
    const nowMs = now.getTime();

    const insertNotif = db.prepare(`
      INSERT OR IGNORE INTO notifications
        (id, kind, party_unique_id, fp_id, event_name, event_date, channel, recipient, title, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const pending: { key: string; title: string; body: string }[] = [];

    const txn = db.transaction(() => {
      for (const r of rows) {
        // Skip already-fulfilled lines.
        const eff = effectiveQty(r);
        const got = Number(r.quantity_issued) || 0;
        if (got >= eff && eff > 0) continue;

        const dueMs = Date.parse(r.deferred_until);
        if (!Number.isFinite(dueMs)) continue;
        const delta = dueMs - nowMs;
        // Due within the next 4h (and not already past — past-due is a separate
        // concern the queue already surfaces as "deferred").
        if (delta < 0 || delta > LOOKAHEAD_MS) continue;

        candidateCount += 1;

        const dedupKey = `defer-due:${r.id}:${r.deferred_until}`;
        const hoursUntil = delta / 3_600_000;
        const unit = (r.unit || r.material_unit || '').trim();
        const remaining = Math.max(0, eff - got);
        const dept = r.department_name || 'a department';
        // Render the due time in IST for the human-readable message.
        let dueLabel = r.deferred_until;
        try {
          dueLabel = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
          }).format(new Date(dueMs));
        } catch { /* keep raw string */ }

        const title = `⏳ Deferred item due in ${hoursUntil.toFixed(1)}h: ${r.material_name} for ${dept}`;
        const body = `Deferred item due to ${dept} at ${dueLabel}: ${r.material_name} × ${remaining}${unit ? ' ' + unit : ''}. ` +
                     `Issue now or raise a vendor PO.`;

        // In-app row (surfaced via /api/notifications).
        const rIn = insertNotif.run(
          generateId(), DEFER_DUE_KIND, dedupKey, null, r.material_name, r.deferred_until,
          'inapp', 'store_managers', title, body,
        );
        if (rIn.changes > 0) notifsCreated += 1;

        // Slack row (deduped independently by channel). Only queue a live ping
        // if this row was newly inserted, so a webhook fires exactly once.
        const rSl = insertNotif.run(
          generateId(), DEFER_DUE_KIND, dedupKey, null, r.material_name, r.deferred_until,
          'slack', 'store_managers', title, body,
        );
        if (rSl.changes > 0) {
          notifsCreated += 1;
          pending.push({ key: dedupKey, title, body });
        }
      }
    });
    txn();

    slackPings = pending;

    if (slackPings.length > 0) {
      const webhookRow = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value: string } | undefined;
      webhook = webhookRow?.value?.trim() || '';
    }
  } catch (e: any) {
    // Detection/enqueue failed — record and bail. Never rethrow.
    errors.push(`defer-due scan: ${e?.message || e}`);
    return { candidates: candidateCount, notifications_created: notifsCreated, slack_sent: slackSent, errors };
  }

  // Dispatch Slack outside the DB transaction — best-effort, never throws.
  if (slackPings.length > 0 && webhook) {
    const db = getDb();
    for (const ping of slackPings) {
      try {
        const resp = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `${ping.title}\n${ping.body}` }),
        });
        if (resp.ok) {
          slackSent += 1;
          try {
            db.prepare(`UPDATE notifications SET sent_at = datetime('now'), delivery_meta = 'ok' WHERE party_unique_id = ? AND kind = ? AND channel = 'slack' AND sent_at IS NULL`)
              .run(ping.key, DEFER_DUE_KIND);
          } catch { /* logging only */ }
        } else {
          errors.push(`Slack ${resp.status}: ${ping.title}`);
        }
      } catch (e: any) {
        errors.push(`Slack ${e?.message}: ${ping.title}`);
      }
    }
  }

  return {
    candidates: candidateCount,
    notifications_created: notifsCreated,
    slack_sent: slackSent,
    errors,
  };
}
