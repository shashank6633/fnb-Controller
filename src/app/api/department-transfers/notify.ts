import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import { generateId } from '@/lib/db';
import { sendPushToUser } from '@/lib/push';
import type { DeptTransferWithLines, DeptTransferDisputeRow } from '@/lib/dept-ledger';
import { toPurchaseQty } from '@/lib/pack-units';
import { canSendFrom, countDisputesToAct, isAdminOrManager, loadDepartments, type DeptLite } from './access';

/* ══════════════════════════════════════════════════════════════════════════
 * TELLING THE SENDER'S SIDE A TRANSFER IS DISPUTED.
 *
 * The owner's ruling: a dispute flag "records the dispute and alerts the
 * sender's head and managers; it does NOT move stock". The flag itself is
 * written by dept-ledger's flagDeptTransferDispute(); this file only says who
 * is told and tells them.
 *
 * WHO. Resolved from the SAME predicate that decides who may act on it — the
 * house rule grn-qc-notify.ts states ("a badge that reached people who cannot
 * act, or an action nobody was told about, would each be worse than the
 * other"): everyone who may send from the ORIGINAL SENDING department
 * (access.ts canSendFrom: its head_user_id, an HOD posted there or to the
 * department it is a sub-kitchen of (ruling #40), managers —
 * manager tier without the HOD flag — and admin) — exactly the people who can
 * make the one-tap reverse — plus the person who sent it. An HOD posted to
 * another department is NOT told: it is not their department's transfer.
 * Tier and flags are re-derived as getCurrentUser() does (roles.base_role
 * wins the tier, per-user flags only ADD).
 *
 * TWO RAILS, as grn-qc-notify:
 *  1. THE DURABLE ROW in `notifications` (kind 'dept_transfer_dispute'),
 *     deduped by UNIQUE(party_unique_id, kind, channel) on
 *     `dtr:<transfer>:dispute:<first dispute id>` — a retried flag cannot
 *     double-announce. The recipients are ALSO stamped on the dispute rows
 *     themselves (alert_recipients), inside the flag's own transaction, so the
 *     record of who was told cannot be lost to a failed send.
 *  2. WEB PUSH, best-effort, per recipient.
 *  3. THE BELL — the rail people actually see. Neither rail above reaches a
 *     screen on its own: push needs a device subscription (this database has
 *     none) and nothing renders the durable row. So the global bell
 *     (/api/notifications/inbox, bucket 'dept_transfer_disputes') carries a
 *     LIVE COUNT from openDisputesToActFor() below — the same shape as
 *     grn-qc-notify's row + 'grn_qc_pending' bucket. It counts with ONE
 *     predicate (access.ts hasDisputeActionFor: the person holds a take-back
 *     or a close the server accepts), the same one GET
 *     /api/department-transfers' open_disputes_to_act and the page's
 *     "Disputes for you to settle" use, so the badge and the page cannot
 *     disagree, and it falls the moment the dispute is reversed or closed —
 *     or the moment a count leaves this person with nothing to press.
 *     Measured before it existed (xfer-rulings-v probe §9): a fresh flag
 *     reached 0 devices and 0 bells.
 *     WHO IS TOLD (rails 1-2, at the flag) and WHO IS BADGED (rail 3, live)
 *     differ on purpose: the alert goes to the sending side at once; the
 *     badge follows who can still act as counts and closes happen.
 *
 * SERVER ONLY, FIRE-AND-FORGET, NEVER THROWS: call AFTER the flag's
 * transaction has committed. A notification that fails must not fail — or
 * roll back — the dispute it announces.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface TransferAlertRecipient { email: string; name: string; why: 'sender' | 'head' | 'hod' | 'manager' | 'admin' }

export function transferAlertRecipients(
  db: Database.Database, doc: Pick<DeptTransferWithLines, 'from_department_id' | 'created_by'>, all: Map<string, DeptLite>,
): TransferAlertRecipient[] {
  const out = new Map<string, TransferAlertRecipient>();
  const from = all.get(doc.from_department_id);
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.is_head_chef, u.department_id, u.role_id,
             r.base_role AS role_base, r.is_head_chef AS role_head_chef
        FROM users u LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 AND TRIM(COALESCE(u.email, '')) <> ''
    `).all() as Array<{
      id: string; email: string; name: string | null; role: string | null; is_head_chef: number | null;
      department_id: string | null; role_id: string | null; role_base: string | null; role_head_chef: number | null;
    }>;
    const sentBy = String(doc.created_by || '').trim().toLowerCase();
    for (const row of rows) {
      const hasRole = !!row.role_id && !!row.role_base;
      const u = {
        id: String(row.id),
        role: ((hasRole ? row.role_base : row.role) || 'staff') as SessionUser['role'],
        is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
        department_id: row.department_id || null,
      };
      const email = String(row.email).trim();
      const isTheSender = email.toLowerCase() === sentBy;
      const mayAct = canSendFrom(u, from);
      if (!isTheSender && !mayAct) continue;
      // Same arms, same order as canSendFrom — an HOD on the manager-tier Head
      // Chef role is here as the HOD posted to the sending department, not as a
      // "manager" (access.ts isAdminOrManager).
      const why: TransferAlertRecipient['why'] = !mayAct ? 'sender'
        : u.role === 'admin' ? 'admin'
          : isAdminOrManager(u) ? 'manager'
            : (from && from.head_user_id === u.id) ? 'head'
              : 'hod';
      out.set(email.toLowerCase(), { email, name: String(row.name || email), why });
    }
  } catch (e) {
    console.error('[department-transfers notify] recipient lookup failed (non-fatal):', e);
  }
  return [...out.values()];
}

/**
 * Open disputes waiting on THIS PERSON: transfers with an open dispute on
 * which they hold a control the server will ACCEPT — a take-back whose
 * prefill moves something, or a close canDismissDispute allows (access.ts
 * hasDisputeActionFor, THE predicate). The SAME function GET
 * /api/department-transfers returns as open_disputes_to_act and the page
 * lists under "Disputes for you to settle" (permissions.dispute_to_act).
 *
 * It used to count every open dispute OUT OF a department the caller may send
 * from. That badged the Kitchen head for disputes he can never clear — a
 * disputed line counted since it moved (take-back refused) that only the
 * flagger, a manager or the receiving head may close — so the bell said 1 and
 * the page showed nothing to press. And it never badged the receiving head
 * who can close (or send back) the claim, nor the flagger who may withdraw it.
 * Never throws (0 on any failure).
 */
export function openDisputesToActFor(db: Database.Database, user: SessionUser): number {
  try {
    return countDisputesToAct(db, user, loadDepartments(db));
  } catch { return 0; }
}

const KIND_WORDS: Record<string, string> = {
  short: 'short delivery',
  wrong_item: 'wrong item',
  not_received: 'not received',
};

/** The notifications table is created at boot (db.ts); this is the same
 *  defensive CREATE grn-qc-notify uses, as one prepared statement. */
function ensureNotificationsTable(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
      channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, delivery_meta TEXT DEFAULT '',
      UNIQUE (party_unique_id, kind, channel)
    )
  `).run();
}

/** "DTR-2026-0014 disputed by Akan Tandoori: …". NEVER THROWS. */
export async function notifyTransferDispute(
  db: Database.Database,
  input: { doc: DeptTransferWithLines; disputes: DeptTransferDisputeRow[]; raisedBy: string; recipients: TransferAlertRecipient[] },
): Promise<{ recorded: boolean; pushed: number }> {
  let recorded = false;
  let pushed = 0;
  try {
    const { doc, disputes, recipients } = input;
    if (disputes.length === 0) return { recorded, pushed };
    const kinds = [...new Set(disputes.map((d) => KIND_WORDS[d.kind] || d.kind))].join(', ');
    const title = `${doc.transfer_no} disputed by ${doc.to_department_name}: ${kinds}`;
    const lines = disputes.map((d) => {
      const l = doc.lines.find((x) => x.id === d.line_id);
      const meta = l ? { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor } : { unit: '', purchase_unit: '', pack_size: 1 };
      const pu = l ? (l.purchase_unit || l.unit) : '';
      return `· ${l?.material_name || d.line_id}: ${toPurchaseQty(d.qty_disputed, meta)} ${pu} ${KIND_WORDS[d.kind] || d.kind}`;
    }).join('\n');
    const body =
      `${doc.from_department_name} → ${doc.to_department_name}, sent by ${doc.created_by || '—'}\n`
      + `${lines}\n\nReason: ${disputes[0].reason}\nFlagged by: ${input.raisedBy}\n\n`
      + `Nothing has moved back. If the goods did not arrive, open Inventory → Department Transfers and `
      + `reverse the disputed line (one tap, prefilled); if they did, a manager can close the dispute with a note.`;
    try {
      ensureNotificationsTable(db);
      recorded = db.prepare(`
        INSERT OR IGNORE INTO notifications (id, kind, party_unique_id, channel, recipient, title, body)
        VALUES (?, 'dept_transfer_dispute', ?, 'inapp', ?, ?, ?)
      `).run(generateId(), `dtr:${doc.id}:dispute:${disputes[0].id}`,
        recipients.map((r) => r.email).join(',').slice(0, 900), title, body).changes > 0;
    } catch (e) {
      console.error('[department-transfers notify] durable row failed (non-fatal):', e);
    }
    for (const r of recipients) {
      try {
        pushed += await sendPushToUser(db, r.email, { title, body: `${doc.to_department_name}: ${kinds}`, url: '/department-transfers' });
      } catch { /* sendPushToUser never throws by contract; belt and braces */ }
    }
  } catch (e) {
    console.error('[department-transfers notify] failed (non-fatal):', e);
  }
  return { recorded, pushed };
}
