/**
 * BILL ON HOLD — THE TWO NOTIFICATION RAILS
 * =========================================
 *
 * THE REMINDER GOES TO THE RESPONSIBLE USER (staff), NOT THE CUSTOMER. Nothing
 * in this module messages a guest. The owner did not ask for it, a cold
 * free-form WhatsApp to a customer would not deliver outside Meta's 24h window
 * anyway, and these are real people's phone numbers.
 *
 * RAIL 1 — IN-APP. Works TODAY, with no configuration. One durable
 * boh_notifications row per (BOH, due date), addressed to the responsible
 * user's login email, plus best-effort web push. Modelled line-for-line on
 * src/lib/hr-notify.ts: own INSERT, called OUTSIDE the caller's transaction,
 * push fired in a queueMicrotask, and it NEVER THROWS by contract.
 *
 * Durable, not localStorage: src/lib/notif-ack.ts acks the bell per DEVICE,
 * which cannot answer "did the responsible person ever see this reminder" — and
 * the owner asked that history is never overwritten.
 *
 * RAIL 2 — WHATSAPP. Dark until the owner does two separate things, and the
 * screen must say BOTH, separately, because they are different fixes:
 *
 *   BLOCKER A — NO APPROVED TEMPLATE. Measured on the snapshot: 11 templates
 *   exist and meta_status is EMPTY on all 11. Free-form is never used here —
 *   sendWhatsAppMessage only delivers inside a 24h window, which is useless for
 *   a scheduled morning reminder. The owner authors and submits
 *   `boh_payment_reminder` through the W3 lifecycle himself; Meta takes 24-48h.
 *   NOTHING IN THIS FILE EVER CALLS META TO CREATE OR SUBMIT A TEMPLATE.
 *
 *   BLOCKER B — NO NUMBER ON FILE, and it is INDEPENDENT of Meta. Measured:
 *   0 of 9 users have users.wa_mobile and hr_employees is EMPTY, so
 *   numberForUserId() resolves no number for ANY user. Even with an approved
 *   template the reminder reaches nobody until the owner fills in staff numbers.
 *
 * Both blockers are reported as structured facts by bohWaReadiness() so a
 * screen can render the reason verbatim rather than inventing one.
 *
 * ── WHY THIS FILE OWNS ITS OWN waSend ────────────────────────────────────────
 * src/lib/whatsapp.ts is NOT edited by this module. WA_NOTIFY_EVENTS is a tuple
 * in that shared file with a documented wipe hazard around setWaNotifyRecipients
 * (~line 686), so adding an event there is a change to a file four other rails
 * depend on. The in-repo precedent for a module owning its own send is
 * src/lib/grn-qc-notify.ts:171 — a private waSend() that calls
 * sendWhatsAppTemplate directly and keeps its parameter order in its own file.
 * That is copied here; whatsapp.ts stays byte-untouched.
 */
import type Database from 'better-sqlite3';
import { generateId } from './db';
import { sendPushToUser } from './push';
import { isWaConfigured, sendWhatsAppTemplate } from './whatsapp';
import { templateSendability } from './wa-template-authoring';
import { numberForUserId } from './wa-report-recipients';

/**
 * THE TEMPLATE THE OWNER SUBMITS. Name must match /^[a-z0-9_]{1,512}$/.
 *
 * Suggested body (UTILITY, not MARKETING — this goes to our own staff about our
 * own operation, and the price gap is ~7x):
 *
 *   Payment follow-up due. BOH bill {{1}} for {{2}} is pending. Amount Rs {{3}},
 *   expected on {{4}}, now {{5}} day(s) pending. Please record today's follow-up
 *   in F&B Controller.
 *
 * It starts with text and ends with text and no two variables are adjacent —
 * the two rules (docs/interakt-templates.md:25-27) that cause most rejections.
 */
export const BOH_WA_TEMPLATE = 'boh_payment_reminder';
export const BOH_WA_LANG = 'en';

/**
 * The name -> position contract, in WA_EVENT_PARAM_ORDER style. {{1}}..{{5}}.
 * Exactly the five fields the owner named: "BOH Bill No. | Customer | Amount |
 * Expected Payment Date | Days Pending".
 */
export const BOH_REMINDER_PARAM_ORDER = [
  'bill_no', 'customer', 'amount', 'expected_date', 'days_pending',
] as const;

export interface BohReminderFacts {
  bohId: string;
  billNo: string;
  customer: string;
  amount: number;
  expectedDate: string;
  daysPending: number;
  responsibleUserId: string;
  responsibleEmail: string;
  responsibleName: string;
}

const S = (v: unknown): string => String(v ?? '').trim();

/**
 * Meta rejects parameters carrying newlines, tabs, or runs of more than four
 * spaces. Collapse exactly as notifyEvent does (whatsapp.ts:866) so a customer
 * name typed with a line break cannot make a whole send fail.
 */
const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/** The five body params, in position order. One function so the screen, the
 *  send and the audit line can never disagree about what {{3}} is. */
export function bohReminderParams(f: BohReminderFacts): string[] {
  return [
    clean(f.billNo) || '-',
    clean(f.customer) || 'Guest',
    new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Math.max(f.amount, 0)),
    clean(f.expectedDate) || '-',
    String(Math.max(f.daysPending, 0)),
  ];
}

/** The human sentence for one reminder — the owner's five fields, in his order. */
export function bohReminderText(f: BohReminderFacts): string {
  const amt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Math.max(f.amount, 0));
  return `BOH Bill ${f.billNo || '-'} | ${f.customer || 'Guest'} | Rs ${amt} | expected ${f.expectedDate || '-'} | ${Math.max(f.daysPending, 0)} day(s) pending`;
}

/* ══════════════════════════ RAIL 1 — IN-APP ═══════════════════════════════ */

/**
 * Insert one durable boh_notifications row for the responsible user and fire
 * best-effort web push.
 *
 * CALL OUTSIDE / AFTER the caller's transaction — better-sqlite3 is
 * synchronous, and nesting a second write path inside a decision transaction
 * couples the decision's fate to the notification's. NEVER THROWS.
 */
export function notifyBohUser(
  db: Database.Database,
  f: BohReminderFacts,
  opts: { kind?: string; title?: string; body?: string } = {},
): { ok: boolean; reason: string } {
  try {
    const email = S(f.responsibleEmail);
    if (!email) return { ok: false, reason: 'no_login_email' };
    const title = opts.title || 'Payment follow-up due';
    const body = opts.body || bohReminderText(f);
    db.prepare(`
      INSERT INTO boh_notifications (id, boh_id, recipient_email, kind, title, body, href)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), S(f.bohId), email, opts.kind || 'boh.reminder', title, body, `/boh/${S(f.bohId)}`);

    // Push AFTER the row exists, off the request's critical path.
    // sendPushToUser never throws (its own contract), so this microtask is safe.
    queueMicrotask(() => {
      void sendPushToUser(db, email, { title, body, url: `/boh/${S(f.bohId)}` });
    });
    return { ok: true, reason: '' };
  } catch (e) {
    console.error('[boh] notifyBohUser failed (non-fatal):', e);
    return { ok: false, reason: 'threw' };
  }
}

/**
 * Mark this user's unread reminders for ONE bill as read.
 *
 * Called when they OPEN that bill's record — the bell's whole question is "has
 * the responsible person seen this", and opening the record is the answer.
 * is_read is a READ RECEIPT, not history: the row, its body and its timestamp
 * stay exactly where they are, which is what the owner asked for. Never throws;
 * a failed receipt must not fail the page.
 */
export function markBohNotificationsRead(db: Database.Database, bohId: string, email: string): number {
  try {
    const who = S(email);
    if (!who) return 0;
    const info = db.prepare(`
      UPDATE boh_notifications SET is_read = 1
       WHERE boh_id = ? AND is_read = 0 AND lower(TRIM(recipient_email)) = lower(TRIM(?))
    `).run(S(bohId), who);
    return Number(info.changes) || 0;
  } catch (e) {
    console.error('[boh] markBohNotificationsRead failed (non-fatal):', e);
    return 0;
  }
}

/* ═══════════════════════ RAIL 2 — WHATSAPP ════════════════════════════════ */

export interface BohWaReadiness {
  /** Can a WhatsApp reminder actually be delivered right now? */
  ready: boolean;
  /** Is the Meta/Interakt transport configured at all? */
  configured: boolean;
  /** Is the template approved and sendable? */
  templateOk: boolean;
  /** The lifecycle's OWN sentence — render it verbatim, do not re-word it. */
  templateReason: string;
  templateStatus: string;
  templateName: string;
  /** Per-blocker, because "no approved template" and "no number for X" are
   *  different fixes and must not be collapsed into one line on screen. */
  blockers: string[];
}

/**
 * Why the WhatsApp leg is dark, in the gate's own words.
 *
 * TWO CONDITIONS, BOTH REQUIRED, and the order matters:
 *   1. whatsapp_templates holds a row for this name with meta_status
 *      'approved'. Read here, directly, because it is a FACT.
 *   2. templateSendability() (wa-template-authoring.ts:2764) also says yes, so a
 *      paused / rejected / wrong-language row still fails. Its `advisory` /
 *      `reason` strings are written for an operator to read and are passed
 *      through untouched where they apply.
 *
 * It must NOT be condition 2 alone. sendabilityFrom returns ok:true for a name
 * nothing here has ever heard of (its `if (!synced)` branch — right for a
 * hand-authored broadcast, wrong for an automated send), which is how this gate
 * came to report "template OK" against zero rows.
 */
export function bohWaReadiness(db: Database.Database): BohWaReadiness {
  const blockers: string[] = [];
  let configured = false;
  try { configured = isWaConfigured(); } catch { configured = false; }
  if (!configured) {
    blockers.push(
      'WhatsApp is not connected yet. Settings → Integrations → WhatsApp needs a Phone Number ID and access token ' +
      '(the current provider is set but the Phone Number ID is empty), so nothing can be sent on this rail.',
    );
  }

  // ── APPROVAL IS A FACT ABOUT A ROW, NOT AN ADVISORY ────────────────────
  // templateSendability() is the app's general-purpose predicate and it returns
  // ok:true for a template NOBODY HAS EVER HEARD OF — sendabilityFrom's
  // `if (!synced)` branch treats an unknown name as an unmanaged local template
  // and declines to block it. That is right for a hand-authored broadcast and
  // catastrophic here: measured, bohWaReadiness() reported templateOk = TRUE
  // and pushed NO template blocker while zero rows existed for this name, so
  // the only thing keeping the leg dark was an empty Phone Number ID. Filling
  // that in — which the owner is mid-rollout on — would have started POSTing an
  // unapproved template to Meta for every due bill, silently, with a green
  // light on screen (five such POSTs were intercepted by a network tripwire).
  //
  // So this gate reads the row ITSELF and requires meta_status 'approved'.
  // templateSendability is still consulted, and can only ever make the answer
  // STRICTER (a paused / rejected / wrong-language APPROVED row still fails).
  let templateOk = false;
  let templateReason = '';
  let templateStatus = '';
  let templatePresent = false;
  try {
    let row: any;
    try { row = db.prepare(`SELECT name, meta_status FROM whatsapp_templates WHERE name = ?`).get(BOH_WA_TEMPLATE); }
    catch { row = undefined; }
    templatePresent = !!row;
    templateStatus = String(row?.meta_status || '').trim().toLowerCase();
    const approved = templateStatus === 'approved';

    const s = templateSendability(db, BOH_WA_TEMPLATE, BOH_WA_LANG);
    // `advisory` is the owner-readable sentence the template list already
    // shows; `reason` is the refusal. Prefer the advisory, fall back.
    const lifecycleReason = String((s as any).advisory || s.reason || '');
    templateOk = approved && !!s.ok;
    templateReason = approved
      ? (s.ok ? '' : lifecycleReason)
      : !templatePresent
        ? `No WhatsApp template named "${BOH_WA_TEMPLATE}" exists on this install yet. Author and submit it from ` +
          `Settings → Integrations → WhatsApp → Templates; Meta's approval usually takes 24-48 hours. Nothing is sent on this rail until it is APPROVED.`
        : templateStatus === ''
          ? `The WhatsApp template "${BOH_WA_TEMPLATE}" exists here but has never been submitted to Meta — no approval status is recorded against it. ` +
            `Submit it from Settings → Integrations → WhatsApp → Templates and wait for Meta to approve it (24-48 hours).`
          : `The WhatsApp template "${BOH_WA_TEMPLATE}" is "${templateStatus}" at Meta, not approved${lifecycleReason ? ` — ${lifecycleReason}` : ''}. ` +
            `Nothing is sent on this rail until Meta approves it.`;
  } catch (e) {
    templateOk = false;
    templateReason = 'The WhatsApp template list could not be read on this install, so no template can be proved approved.';
    console.error('[boh] template approval check failed:', e);
  }
  if (!templateOk) {
    blockers.push(
      templateReason ||
      `No approved WhatsApp template named "${BOH_WA_TEMPLATE}" — submit it from Settings → Integrations → WhatsApp → Templates. ` +
      `WhatsApp approval usually takes 24-48 hours. The in-app reminder works in the meantime.`,
    );
  }

  return {
    ready: configured && templateOk,
    configured, templateOk, templateReason, templateStatus,
    templateName: BOH_WA_TEMPLATE,
    blockers,
  };
}

/** Where a reminder would be sent for one user, and why not when it wouldn't. */
export function bohWaNumberFor(db: Database.Database, userId: string): { number: string; source: string; name: string; blocker: string } {
  let r = { number: '', source: '', name: '' };
  try { r = numberForUserId(db, S(userId)); } catch { /* resolver unavailable */ }
  const blocker = r.number
    ? ''
    : `No WhatsApp number on file for ${r.name || 'this user'}. Add it on their user record (WhatsApp mobile), ` +
      `or link them to an HR employee record with a phone number. This is separate from template approval — both are needed.`;
  return { ...r, blocker };
}

/**
 * Send ONE reminder on the WhatsApp rail. TEMPLATE ONLY — never free-form.
 *
 * Returns a structured outcome rather than throwing, because the caller is a
 * scheduler tick whose contract is "never throw". A refusal here does NOT burn
 * the reminder slot; the in-app rail has already delivered.
 */
export async function sendBohWaReminder(
  db: Database.Database,
  f: BohReminderFacts,
): Promise<{ ok: boolean; status: string; reason: string; to: string }> {
  const ready = bohWaReadiness(db);
  if (!ready.ready) {
    return { ok: false, status: 'blocked', reason: ready.blockers[0] || 'WhatsApp is not ready', to: '' };
  }
  const who = bohWaNumberFor(db, f.responsibleUserId);
  if (!who.number) return { ok: false, status: 'no_number', reason: who.blocker, to: '' };

  try {
    // AN APPROVED TEMPLATE delivers at any hour, which is the whole point of a
    // morning reminder. There is deliberately NO free-form fallback: it would
    // silently fail outside a 24h window and report success.
    const res = await sendWhatsAppTemplate(who.number, BOH_WA_TEMPLATE, BOH_WA_LANG, bohReminderParams(f));
    return {
      ok: !!res.ok,
      status: res.ok ? 'sent' : 'failed',
      reason: res.ok ? '' : String((res as any).reason || 'send refused'),
      to: who.number,
    };
  } catch (e) {
    return { ok: false, status: 'failed', reason: String((e as any)?.message || e), to: who.number };
  }
}
