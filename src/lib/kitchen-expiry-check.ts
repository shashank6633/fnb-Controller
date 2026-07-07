/**
 * Kitchen Production — expiry watchdog.
 *
 * Runs on the SAME in-process scheduler tick as checkDeferDueSoon()
 * (./scheduler.ts). Best-effort: a failure here must NEVER break the refresh /
 * defer-due checks — the scheduler wraps this in its own try/catch and we also
 * swallow per-batch / per-notification errors.
 *
 * Two jobs, over ACTIVE production_batches only:
 *   (a) AUTO-EXPIRE — any batch whose expiry (date+time) has already PASSED is
 *       flipped to status='expired' and gets an 'expired' batch_transactions row
 *       (quantity = remaining that expired, balance = same). Idempotent because
 *       once flipped it is no longer status='active'.
 *   (b) EXPIRY ALERTS — batches still in the future but near expiry enqueue a
 *       deduped notification per threshold bucket they currently fall into:
 *         3d       (≤ 72h)   → kind 'kbatch_expiry_3d'
 *         tomorrow (IST day) → kind 'kbatch_expiry_tomorrow'
 *         today    (IST day) → kind 'kbatch_expiry_today'
 *         24h      (≤ 24h)   → kind 'kbatch_expiry_24h'
 *       Each is deduped by party_unique_id = 'kbatch-expiry:<batch_id>:<expiry_date>'
 *       + kind + channel via the notifications table's
 *       UNIQUE(party_unique_id, kind, channel) constraint, so a batch fires each
 *       bucket at most once as it counts down. Addressed to
 *       chef/kitchen manager/store manager/admin.
 *
 * Dates: expiry_date ('YYYY-MM-DD') + expiry_time ('HH:mm') are bare local
 * (IST) wall-clock values the kitchen picked; parseDateTime() reads them in the
 * server's local timezone, and we compare against new Date() the same way — the
 * same convention defer-due-check uses.
 */
import { getDb, generateId } from './db';
import { parseDateTime, ProductionBatch } from './production-batch';
import { fmtISTIsoDate, todayIST } from './format-date';

const H = 3_600_000;
const RECIPIENT = 'chef,kitchen_manager,store_manager,admin';

export interface KitchenExpiryResult {
  scanned: number;              // active batches with a parseable expiry
  expired: number;              // batches flipped active → expired this run
  alert_candidates: number;     // near-expiry batches that matched ≥1 bucket
  notifications_created: number;
  slack_sent: number;
  errors: string[];
}

/** Threshold buckets a still-future batch currently qualifies for. */
function bucketsFor(delta: number, expDay: string, today: string, tomorrow: string): string[] {
  const kinds: string[] = [];
  if (delta <= 72 * H) kinds.push('kbatch_expiry_3d');
  if (expDay === tomorrow) kinds.push('kbatch_expiry_tomorrow');
  if (expDay === today) kinds.push('kbatch_expiry_today');
  if (delta <= 24 * H) kinds.push('kbatch_expiry_24h');
  return kinds;
}

export async function checkKitchenExpiry(triggeredBy: 'cron' | 'manual' = 'cron'): Promise<KitchenExpiryResult> {
  const errors: string[] = [];
  let scanned = 0, expired = 0, alertCandidates = 0, notifsCreated = 0, slackSent = 0;

  let slackPings: { key: string; kind: string; title: string; body: string }[] = [];
  let webhook = '';

  try {
    const db = getDb();
    const now = new Date();
    const nowMs = now.getTime();
    const today = todayIST();
    const tomorrow = fmtISTIsoDate(new Date(nowMs + 24 * H));

    const rows = db.prepare(
      `SELECT * FROM production_batches WHERE status = 'active'`
    ).all() as ProductionBatch[];

    const insertNotif = db.prepare(`
      INSERT OR IGNORE INTO notifications
        (id, kind, party_unique_id, fp_id, event_name, event_date, channel, recipient, title, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const expireBatch = db.prepare(
      `UPDATE production_batches SET status = 'expired', updated_at = datetime('now') WHERE id = ?`
    );
    const insertTx = db.prepare(
      `INSERT INTO batch_transactions
         (id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );

    const pending: { key: string; kind: string; title: string; body: string }[] = [];

    const txn = db.transaction(() => {
      for (const b of rows) {
        const exp = parseDateTime(b.expiry_date, b.expiry_time);
        if (!exp) continue;
        scanned += 1;
        const delta = exp.getTime() - nowMs;
        const remaining = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));

        // (a) already expired → flip + audit row.
        if (delta <= 0) {
          expireBatch.run(b.id);
          insertTx.run(
            generateId(), b.id, b.outlet_id, 'expired', remaining, remaining,
            'system', '', `auto-expired (${triggeredBy})`,
          );
          expired += 1;
          continue;
        }

        // (b) near-expiry alerts (only meaningful while stock remains).
        if (remaining <= 0) continue;
        const expDay = fmtISTIsoDate(exp);
        const kinds = bucketsFor(delta, expDay, today, tomorrow);
        if (!kinds.length) continue;
        alertCandidates += 1;

        const dedupKey = `kbatch-expiry:${b.id}:${b.expiry_date}`;
        const unit = (b.unit || '').trim();
        const hours = delta / H;
        let expLabel = `${b.expiry_date} ${b.expiry_time || ''}`.trim();
        try {
          expLabel = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
          }).format(exp);
        } catch { /* keep raw */ }

        for (const kind of kinds) {
          const title = `⏰ ${b.item_name} expires in ${hours < 24 ? hours.toFixed(1) + 'h' : Math.round(hours / 24) + 'd'} (${b.batch_number})`;
          const body = `Batch ${b.batch_number} of ${b.item_name} expires ${expLabel}. ` +
                       `${remaining}${unit ? ' ' + unit : ''} still on hand — use or dispose.`;

          const rIn = insertNotif.run(
            generateId(), kind, dedupKey, null, b.item_name, b.expiry_date,
            'inapp', RECIPIENT, title, body,
          );
          if (rIn.changes > 0) notifsCreated += 1;

          const rSl = insertNotif.run(
            generateId(), kind, dedupKey, null, b.item_name, b.expiry_date,
            'slack', RECIPIENT, title, body,
          );
          if (rSl.changes > 0) {
            notifsCreated += 1;
            pending.push({ key: dedupKey, kind, title, body });
          }
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
    errors.push(`kitchen-expiry scan: ${e?.message || e}`);
    return { scanned, expired, alert_candidates: alertCandidates, notifications_created: notifsCreated, slack_sent: slackSent, errors };
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
              .run(ping.key, ping.kind);
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
    scanned,
    expired,
    alert_candidates: alertCandidates,
    notifications_created: notifsCreated,
    slack_sent: slackSent,
    errors,
  };
}
