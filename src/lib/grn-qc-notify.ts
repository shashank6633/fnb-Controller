import type Database from 'better-sqlite3';
import { generateId } from './db';
import { sendPushToUser } from './push';
import { sendWhatsAppTemplate, sendWhatsAppMessage } from './whatsapp';
import { canSignQcFor, qcEscalationHours, QC_AWAITING, type QcChecker } from './grn-qc';
import type { SessionUser } from './auth';

/* ══════════════════════════════════════════════════════════════════════════
 * TELLING SOMEBODY A DELIVERY IS WAITING.
 *
 * SERVER ONLY. Every function here is FIRE-AND-FORGET and NEVER THROWS: a
 * notification that fails must not fail — or roll back — the receipt it is
 * announcing. Call them AFTER the caller's db.transaction() has committed, in
 * their own try/catch, which is the house rule hr-notify.ts states.
 *
 * ── THREE RAILS, AND WHY THREE ─────────────────────────────────────────────
 *  1. THE BELL is the one that actually reaches people today, and it is NOT
 *     written here: GET /api/notifications/inbox computes a live COUNT over
 *     status = 'awaiting_qc' (pendingQcCount / overdueQcCount in grn-qc.ts).
 *     No row to write, nothing to keep in sync, and it can never disagree with
 *     the queue page because both read the same status.
 *  2. THE DURABLE ROW, written here into the existing `notifications` table —
 *     the same rail the PO deviation alert uses (receive/route.ts). It is the
 *     permanent "this was announced, to these people, at this time" record and
 *     the Slack fan-out. Deduped by UNIQUE(party_unique_id, kind, channel) on
 *     the key `grn:<id>:qc`, so a retry of the receive cannot double-announce.
 *  3. WEB PUSH, best-effort, per resolved recipient. push_subscriptions is
 *     EMPTY in this deployment (measured 2026-08-21), so this is a no-op today
 *     and is written to stay a no-op rather than to fail.
 *
 * ── WHY THE HOD CANNOT BE ADDRESSED THE OBVIOUS WAY ────────────────────────
 * ALL 19 departments have an empty head_user_id, so "notify the Kitchen HOD"
 * cannot route through the department record — the existing project rule that
 * is_head_chef is the real gate and head_user_id is visibility-only is not a
 * preference here, it is the only thing that works. Recipients are therefore
 * resolved from the SAME predicate that decides who may sign (canSignQcFor),
 * unioned with the head chefs and admins who get the escalation. A badge that
 * reached people who cannot act, or an action nobody was told about, would
 * each be worse than the other.
 *
 * ── WHATSAPP IS BUILT AND DARK ─────────────────────────────────────────────
 * The owner: "1 & 2 until WhatsApp is integrated" — build the path, leave it
 * off until a template is approved. isWaQcNotifyEnabled() below requires BOTH
 * the master switch `wa_notifications_enabled` AND `wa_notify_grn_qc_pending`,
 * and the second key is NEVER SEEDED by db.ts. A missing settings key reads ''
 * which is not '1', so the path is off BY CONSTRUCTION, not by a default value
 * somebody can flip by accident.
 *
 * `grn_qc_pending` IS NOW REGISTERED in WA_NOTIFY_EVENTS (src/lib/whatsapp.ts),
 * and registration does NOT arm it — isWaNotifyEnabled() and isWaQcNotifyEnabled()
 * both require the master switch AND this key, which is never seeded. What
 * registration fixes is a silent data loss: getWaNotifyRecipients() rebuilds the
 * whole `wa_notify_recipients` JSON FROM that array, so while this event sat
 * outside it, ANY save on Settings → WhatsApp → Notifications deleted the QC
 * recipient mobiles, after which waSend below logged `no_recipients` and sent
 * nothing at all. The key can still be flipped through PUT /api/grn/qc/categories
 * (admin-only), where the rest of this feature's settings live; both readers read
 * the same key, so nothing about behaviour changed.
 *
 * ONE KEY STILL COVERS TWO EVENTS: waSend() gates the OVERDUE rail on
 * WA_QC_EVENT_KEY too. Fine while both are dark; split them before a template is
 * approved, or "notify me when a delivery lands" also subscribes you to the
 * 4-hourly nag.
 *
 * MEASURED: wa_phone_number_id is EMPTY, so isWaConfigured() is false and every
 * send would return { ok:false, reason:'not_configured' } even with the toggle
 * on. That is logged, once, and never surfaced as an error.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The settings key that arms the WhatsApp rail. Never seeded — absent = off. */
export const WA_QC_EVENT_KEY = 'wa_notify_grn_qc_pending';
/** Approved template name + language. Blank template ⇒ free-form fallback. */
const WA_QC_TEMPLATE_KEY = 'wa_qc_template';
const WA_QC_TEMPLATE_LANG_KEY = 'wa_qc_template_lang';

const setting = (db: Database.Database, key: string): string => {
  try {
    return String((db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any)?.value ?? '');
  } catch { return ''; }
};

/** Master switch AND the per-event toggle, exactly as isWaNotifyEnabled() does
 *  for the registered events. Absent key ⇒ '' ⇒ off. */
export function isWaQcNotifyEnabled(db: Database.Database): boolean {
  return setting(db, 'wa_notifications_enabled') === '1' && setting(db, WA_QC_EVENT_KEY) === '1';
}

/** Admin-typed mobiles for this event, from the SAME `wa_notify_recipients`
 *  JSON every other event uses. Capped at 10, like setWaNotifyRecipients. */
export function waQcRecipients(db: Database.Database): string[] {
  try {
    const raw = JSON.parse(setting(db, 'wa_notify_recipients') || '{}');
    const v = raw?.grn_qc_pending;
    if (!Array.isArray(v)) return [];
    return v.map((m: unknown) => String(m).trim()).filter(Boolean).slice(0, 10);
  } catch { return []; }
}

export interface QcRecipient { email: string; name: string; is_hod: boolean; is_admin: boolean }

/**
 * Who is told. The union of:
 *   · everyone canSignQcFor() would let sign this checker (the people who can
 *     actually clear it), and
 *   · every head chef and admin (the escalation audience, and — on today's
 *     data, where no user resolves to main department Kitchen — very likely
 *     the ONLY people in the first list too).
 *
 * The effective tier and flags are re-derived exactly as getCurrentUser() does
 * (roles.base_role wins the tier, per-user flags can only ADD), so this can
 * never disagree with the gate it is announcing work for.
 */
export function qcNotifyRecipients(db: Database.Database, checker: QcChecker): QcRecipient[] {
  const out: QcRecipient[] = [];
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.is_head_chef, u.is_store_manager,
             u.can_approve_requisitions, u.department_id, u.section, u.page_access,
             u.visible_department_ids, u.preferred_zones, u.preferred_table_ids,
             u.position, u.role_id,
             r.base_role AS role_base, r.is_head_chef AS role_head_chef
        FROM users u LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 AND TRIM(COALESCE(u.email, '')) <> ''
    `).all() as any[];
    for (const row of rows) {
      const hasRole = !!row.role_id && !!row.role_base;
      const u = {
        ...row,
        role: (hasRole ? row.role_base : row.role) || 'staff',
        is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
        section: row.section || '',
      } as unknown as SessionUser;
      const isAdmin = u.role === 'admin';
      if (!canSignQcFor(db, u, checker) && !u.is_head_chef && !isAdmin) continue;
      out.push({
        email: String(row.email), name: String(row.name || row.email),
        is_hod: !!u.is_head_chef, is_admin: isAdmin,
      });
    }
  } catch (e) {
    console.error('[grn-qc-notify] recipient lookup failed (non-fatal):', e);
  }
  return out;
}

/** The `notifications` table is created lazily by the PO deviation alert; this
 *  rail must not depend on that having run first. Same DDL, verbatim. */
function ensureNotificationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
      channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, delivery_meta TEXT DEFAULT '',
      UNIQUE (party_unique_id, kind, channel)
    )
  `);
}

function logWa(db: Database.Database, payload: Record<string, unknown>): void {
  try {
    db.prepare(`INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)`)
      .run(JSON.stringify(payload));
  } catch { /* logging must never break a caller */ }
}

/** Fire the WhatsApp rail if — and only if — both switches are on. Awaited by
 *  the caller's `void`, never by the request. */
async function waSend(db: Database.Database, kind: string, text: string, params: string[]): Promise<void> {
  if (!isWaQcNotifyEnabled(db)) return;            // toggled off ⇒ silent no-op, no log row
  const to = waQcRecipients(db);
  if (to.length === 0) { logWa(db, { event: kind, reason: 'no_recipients' }); return; }
  const template = setting(db, WA_QC_TEMPLATE_KEY).trim();
  const lang = setting(db, WA_QC_TEMPLATE_LANG_KEY).trim() || 'en';
  for (const num of to) {
    try {
      // An APPROVED TEMPLATE delivers at any hour, which is the whole point of
      // a 6am delivery alert. Free-form is the fallback and only reaches a
      // number inside Meta's 24h customer-service window — correct for a reply,
      // useless for a cold ping, so it is the fallback and not the default.
      const res = template
        ? await sendWhatsAppTemplate(num, template, lang, params)
        : await sendWhatsAppMessage(num, text);
      logWa(db, { event: kind, to: num, via: template ? 'template' : 'freeform', ok: res.ok, reason: (res as any).reason });
    } catch (e) {
      logWa(db, { event: kind, to: num, ok: false, reason: 'threw', detail: String((e as any)?.message || e) });
    }
  }
}

export interface AwaitingQcInput {
  grnId: string;
  grnNumber: string;
  vendor: string;
  date: string;
  checker: QcChecker;
  /** Display category names that triggered the hold. */
  categories: string[];
  lineCount: number;
  /** Bill value of what is waiting, ₹. rate-basis: purchase. */
  heldValue: number;
  receivedBy: string;
  outletId: string | null;
}

/**
 * "A delivery is at the bay and nobody has checked it yet."
 *
 * NEVER THROWS. Returns the recipients it addressed, for the caller's response
 * — a receiver who is told "the kitchen has been notified" and cannot see WHO
 * has been told nothing useful, and on today's data the honest answer is
 * sometimes "only the admins".
 */
export async function notifyGrnAwaitingQc(
  db: Database.Database,
  input: AwaitingQcInput,
): Promise<{ recipients: QcRecipient[] }> {
  let recipients: QcRecipient[] = [];
  try {
    recipients = qcNotifyRecipients(db, input.checker);
    const who = input.checker === 'both' ? 'Kitchen or Bar' : input.checker === 'bar' ? 'Bar' : 'Kitchen';
    const title = `${input.grnNumber} is waiting for a ${who.toLowerCase()} quality check — no stock added yet`;
    const body =
      `Vendor: ${input.vendor || '—'}\nDate: ${input.date}\n`
      + `Lines: ${input.lineCount} · Bill value ₹${Math.round(input.heldValue || 0).toLocaleString('en-IN')}\n`
      + `Needs checking: ${input.categories.join(', ') || '—'}\n`
      + `Received by: ${input.receivedBy || 'system'}\n\n`
      + `${who} must confirm quality, temperature and damage before these goods enter stock. `
      + `Open Purchasing → Pending Quality Checks (/grn/qc).`;

    try {
      ensureNotificationsTable(db);
      db.prepare(`
        INSERT OR IGNORE INTO notifications
          (id, kind, party_unique_id, channel, recipient, title, body)
        VALUES (?, 'grn_qc_pending', ?, 'inapp', ?, ?, ?)
      `).run(generateId(), `grn:${input.grnId}:qc`,
              recipients.map(r => r.email).join(',').slice(0, 900), title, body);
    } catch (e) {
      console.error('[grn-qc-notify] durable row failed (non-fatal):', e);
    }

    // Web push, best-effort and never awaited into the request's critical path
    // in a way that can fail it. push_subscriptions is empty today ⇒ 0 sends.
    for (const r of recipients) {
      try { await sendPushToUser(db, r.email, { title, body: `${input.vendor || ''} · ${input.categories.join(', ')}`, url: '/grn/qc' }); }
      catch { /* sendPushToUser never throws by contract; belt and braces */ }
    }

    await waSend(db, 'grn_qc_pending',
      `⏸ ${title}\n\n${body}`,
      [input.grnNumber, input.vendor || '—', who, input.categories.join(', ') || '—',
       String(Math.round(input.heldValue || 0))]);
  } catch (e) {
    console.error('[grn-qc-notify] notifyGrnAwaitingQc failed (non-fatal):', e);
  }
  return { recipients };
}

export interface EscalationResult { escalated: number; grns: Array<{ id: string; grn_number: string; waiting_hours: number }> }

/**
 * THE ESCALATION — "this has waited too long."
 *
 * Idempotent by construction: a GRN is escalated only while qc_escalated_at IS
 * NULL, and the stamp is written in the SAME statement that claims it
 * (`UPDATE … WHERE id = ? AND status = 'awaiting_qc' AND qc_escalated_at IS
 * NULL`), so a sweep that runs every five minutes pings once, not twelve times
 * an hour — the throttle error-alerts.ts learned the hard way.
 *
 * NOT A CRON. There is no scheduler in this app; this is called by
 * POST /api/grn/qc/escalate, which the queue page (and any external cron) may
 * poll. Running it twice concurrently is safe for the same reason.
 *
 * The audience is the HODs and admins ONLY — an escalation that pinged the same
 * staff who already have the bell badge would just be the badge again, louder.
 */
export async function escalateOverdueQc(
  db: Database.Database,
  opts: { outletId?: string | null } = {},
): Promise<EscalationResult> {
  const out: EscalationResult = { escalated: 0, grns: [] };
  try {
    const hrs = qcEscalationHours(db);
    const params: any[] = [QC_AWAITING, hrs];
    let outletSql = '';
    if (opts.outletId) { outletSql = ' AND (outlet_id = ? OR outlet_id IS NULL)'; params.push(opts.outletId); }
    const due = db.prepare(`
      SELECT id, grn_number, vendor, date, qc_checker, outlet_id, received_by,
             CAST((julianday('now') - julianday(created_at)) * 24 AS REAL) AS waiting_hours
        FROM goods_receipt_notes
       WHERE status = ?
         AND qc_escalated_at IS NULL
         AND (julianday('now') - julianday(created_at)) * 24 >= ?
         ${outletSql}
       ORDER BY created_at ASC
       LIMIT 50
    `).all(...params) as any[];
    if (due.length === 0) return out;

    // CLAIM-THEN-SEND, per GRN. The stamp is the dedup key, so it is taken
    // before the message goes out: a send that fails must not leave the row
    // un-stamped and re-ping on the next sweep for ever.
    const claim = db.prepare(`
      UPDATE goods_receipt_notes SET qc_escalated_at = datetime('now')
       WHERE id = ? AND status = ? AND qc_escalated_at IS NULL
    `);
    for (const g of due) {
      let claimed = false;
      try { claimed = claim.run(g.id, QC_AWAITING).changes > 0; }
      catch (e) { console.error('[grn-qc-notify] escalation claim failed:', e); }
      if (!claimed) continue;
      out.escalated++;
      const waited = Math.round((Number(g.waiting_hours) || 0) * 10) / 10;
      out.grns.push({ id: String(g.id), grn_number: String(g.grn_number), waiting_hours: waited });

      const checker = (String(g.qc_checker || 'kitchen') as QcChecker);
      const who = checker === 'both' ? 'Kitchen or Bar' : checker === 'bar' ? 'Bar' : 'Kitchen';
      const title = `OVERDUE: ${g.grn_number} has waited ${waited}h for a ${who.toLowerCase()} quality check`;
      const body =
        `Vendor: ${g.vendor || '—'}\nDelivery date: ${g.date}\nReceived by: ${g.received_by || 'system'}\n\n`
        + `No stock has been added and the vendor is long gone. Sign it off, reject the bad lines, `
        + `or release it with a written reason (admin / head chef) on /grn/qc.`;
      try {
        ensureNotificationsTable(db);
        db.prepare(`
          INSERT OR IGNORE INTO notifications
            (id, kind, party_unique_id, channel, recipient, title, body)
          VALUES (?, 'grn_qc_overdue', ?, 'inapp', 'admin', ?, ?)
        `).run(generateId(), `grn:${g.id}:qc_overdue`, title, body);
      } catch (e) { console.error('[grn-qc-notify] overdue row failed (non-fatal):', e); }

      for (const r of qcNotifyRecipients(db, checker).filter(r => r.is_hod || r.is_admin)) {
        try { await sendPushToUser(db, r.email, { title, body: `${g.vendor || ''} · waiting ${waited}h`, url: '/grn/qc' }); }
        catch { /* best-effort */ }
      }
      await waSend(db, 'grn_qc_overdue', `⚠️ ${title}\n\n${body}`,
        [String(g.grn_number), String(g.vendor || '—'), who, String(waited), g.date]);
    }
  } catch (e) {
    console.error('[grn-qc-notify] escalateOverdueQc failed (non-fatal):', e);
  }
  return out;
}
