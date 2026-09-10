/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  sendWhatsAppTemplate, isWaConfigured, normalizeWaNumber, logWaSendAttempt,
  type WaSendResult,
} from '@/lib/whatsapp';
import { upsertConversation, recordOutbound } from '@/lib/wa-inbox';
import { sendReportAttachment, reportThreadCaption } from '@/lib/wa-report-send';
import { reportConfig, reportAudience, istNow, openAdhocRun, finishRun } from '@/lib/wa-report-jobs';
import {
  buildPriceHikeAlert, buildDiscountAlert, buildReservationConfirmation,
  reportDef, type BuiltReport,
} from '@/lib/wa-report-builders';

/**
 * EVENT ALERTS — a price hike, a discount decision, a confirmed reservation.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BUSINESS ACTION IS THE POINT. THE MESSAGE IS A BY-PRODUCT.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Every function here is called AFTER its transaction has committed, as
 * `void fireX(...)`, and NONE of them can throw. A vendor bill is money that
 * changed hands; a discount decision is a manager's ruling; a confirmed table
 * is a promise to a guest. Not one of them may be undone, delayed or failed by
 * WhatsApp being down, a template being unapproved, or Meta answering 500.
 *
 * That is enforced three ways, and the third is the one that matters:
 *   1. the call sites wrap the call in try/catch (belt);
 *   2. these functions catch everything internally and return a status (braces);
 *   3. they are NOT AWAITED by the routes, so even a hung socket cannot hold a
 *      response open — the purchase POST has already returned 201 by the time
 *      Meta answers.
 * The proof is in scripts/wa-report-event-tests.js: an injected send failure
 * (and an injected THROW) leaves the purchase row, the discount decision and
 * the booking status exactly as they were.
 *
 * ── EACH EVENT IS OFF UNTIL CONFIGURED, in the reports namespace ──────────
 *   wa_report_<key>_enabled / _audience / _recipients / _template / _lang
 * Same keys, same reader (reportConfig) and same resolver (reportAudience) as
 * the scheduled reports, so the config page has one shape to render and there
 * is one place recipients are decided.
 *
 * ── THE RESERVATION CONFIRMATION IS DIFFERENT, ON PURPOSE ─────────────────
 * It is the only message here that leaves the building. Its recipient is NOT
 * the configured audience — it is the guest on the booking, read off the
 * booking row itself. The config supplies only the toggle and the template.
 * A guest-facing template must be UTILITY (WA_REPORT_DEFS says so); it confirms
 * a transaction the guest initiated, and a MARKETING template here would be
 * both a policy breach and a spam complaint.
 *
 * ── SENT ONCE PER THING, NOT ONCE PER CALL ───────────────────────────────
 * Every fire carries a dedupe key naming the thing it is about — this booking,
 * this discount request, this purchase. The run ledger is consulted before the
 * send, so a retried request, a double-clicked button or a status toggled
 * confirmed → pending → confirmed cannot put a second "your table is confirmed"
 * in a guest's chat.
 */

export type EventKey = 'price_hike' | 'discount_alert' | 'reservation_confirmation';

/* ═══════════════ the daily cap ═══════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY STAFF ALERT IS CAPPED PER DAY. THE CAP CANNOT BE SWITCHED OFF.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * An event alert is billable WhatsApp traffic multiplied by the audience: one
 * alert to a 20-strong management list is 20 messages Meta charges for. Before
 * this, nothing in the report rails counted them — a day of grocery entry could
 * emit hundreds of messages and the first anyone would know was the invoice.
 *
 * So: messages for one alert key, per IST day, are counted from the send log
 * and compared with a cap before anything is sent. An alert that would cross
 * the cap is REFUSED WHOLE — never half-delivered to the first few recipients,
 * which would leave the rest wondering why they were left out.
 *
 * The cap is configurable per alert (wa_report_<key>_daily_cap) between 1 and
 * MAX_ALERT_DAILY_CAP. A missing, unparseable, zero or negative value falls
 * back to the default; there is deliberately no "0 = unlimited" reading,
 * because "unlimited" is exactly the state this exists to end.
 *
 * GUEST-FACING messages are NOT capped: a reservation confirmation is one
 * message answering one booking a guest just made, and silently not confirming
 * a table to save 80 paise is not a trade this app is willing to make.
 */
export const DEFAULT_ALERT_DAILY_CAP = 60;
export const MAX_ALERT_DAILY_CAP = 1000;

/** The effective per-day message cap for one alert key. Always ≥ 1. */
export function alertDailyCap(db: Database.Database, key: string): number {
  let raw = '';
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(`wa_report_${key}_daily_cap`) as { value?: string } | undefined;
    raw = S(r?.value);
  } catch { raw = ''; }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ALERT_DAILY_CAP;
  return Math.min(Math.floor(n), MAX_ALERT_DAILY_CAP);
}

/**
 * Messages already BILLED for this alert today (IST), from the same send log
 * every rail writes to. Counts ok:true rows only — a refusal costs nothing —
 * and counts test sends too, because Meta bills those exactly the same.
 */
export function alertMessagesSentToday(db: Database.Database, key: string, nowMs = Date.now()): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM whatsapp_events_log
       WHERE kind = 'send_attempt'
         AND date(created_at, '+330 minutes') = @day
         AND payload LIKE @key
         AND payload LIKE '%"ok":true%'
         AND payload LIKE '%"to":%'
    `).get({ day: istNow(nowMs).date, key: `%"report_key":"${key}"%` }) as { n: number } | undefined;
    return Number(row?.n) || 0;
  } catch { return 0; }
}

export interface EventFireResult {
  key: string;
  /** disabled | nothing_to_report | no_recipients | no_template | not_configured |
   *  already_sent | sent | partial | refused | error */
  status: string;
  detail?: string;
  sent?: number;
  failed?: number;
  file_id?: number | null;
  run_id?: number | null;
}

const S = (v: unknown) => String(v ?? '').trim();

/**
 * Has this exact thing already been alerted on? Reads the run ledger, counting
 * only runs that actually delivered.
 *
 * A 'failed' event row does NOT block: the same purchase can be alerted on
 * again once credentials are fixed, exactly as a scheduled report can.
 */
export function eventAlreadySent(db: Database.Database, key: string, dedupeKey: string): boolean {
  if (!dedupeKey) return false;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM wa_report_runs
       WHERE report_key = ? AND period = ? AND trigger_source = 'event'
         AND status IN ('sent', 'partial')
    `).get(key, dedupeKey) as { n: number } | undefined;
    return (row?.n || 0) > 0;
  } catch { return false; }
}

/**
 * Send one built alert to a list of numbers and record it in the guest/staff
 * thread — the plain-template path, for an alert with no document.
 *
 * The thread echo is the same one wa-broadcast.ts does after a campaign send,
 * and for the same reason: the delivery ladder (sent → delivered → read) is
 * driven by the status webhook, which needs a wa_messages row to ladder onto.
 * A send with no row is a send nobody can audit.
 */
async function sendTemplateTo(
  db: Database.Database,
  args: {
    key: string; to: string[]; templateName: string; language: string;
    params: string[]; body: string; sentBy: string; fetchImpl?: typeof fetch;
    /** 'event' | 'test' — stamped on the log row, read by the schedulers. */
    trigger?: string;
  },
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const out = { sent: 0, failed: 0, errors: [] as string[] };
  const params = args.params.map(v => String(v).replace(/\s+/g, ' ').trim());

  for (const to of args.to) {
    let res: WaSendResult;
    try {
      res = await sendWhatsAppTemplate(to, args.templateName, args.language, params, { fetchImpl: args.fetchImpl });
    } catch (e: any) {
      // sendWhatsAppTemplate is not supposed to throw; if it ever does, the
      // remaining recipients must still be attempted.
      res = { ok: false, reason: 'send_failed', detail: e?.message || 'unexpected error' } as any;
    }
    const detail = res.ok ? '' : S((res as any).detail || (res as any).reason || 'send failed').slice(0, 500);
    const wamid = res.ok ? (S(res.message_id) || null) : null;

    try {
      const conv = upsertConversation(db, to);
      if (conv) {
        recordOutbound(db, {
          conversationId: conv.id,
          wamid,
          msgType: 'template',
          body: args.body,
          status: res.ok ? 'sent' : 'failed',
          errorDetail: detail,
          sentBy: args.sentBy,
        });
      }
    } catch (e: any) {
      logWaSendAttempt({ event: 'report_event', report_key: args.key, to, ok: false, reason: 'thread_record_failed', detail: e?.message });
    }

    logWaSendAttempt({
      event: 'report_event', report_key: args.key, to, template: args.templateName,
      trigger_source: S(args.trigger) || 'event', ...res,
    });
    if (res.ok) out.sent++;
    else { out.failed++; if (out.errors.length < 10) out.errors.push(`${to}: ${detail}`); }
  }
  return out;
}

export interface FireOpts {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  /** Override the audience — used only by the config page's Send Test. */
  recipientsOverride?: string[];
  actor?: string;
  /** A test send is recorded as a test and never satisfies the dedupe. */
  trigger?: 'event' | 'test';
}

/**
 * The shared engine. Takes an already-built alert and gets it out of the
 * building — or explains, on the result, why it did not.
 *
 * NEVER THROWS. Every path returns an EventFireResult.
 */
async function fireBuilt(
  db: Database.Database,
  key: EventKey,
  built: BuiltReport,
  args: { dedupeKey: string; recipients?: string[] | null },
  opts: FireOpts = {},
): Promise<EventFireResult> {
  const trigger = opts.trigger === 'test' ? 'test' : 'event';
  const nowMs = opts.nowMs ?? Date.now();
  let runId: number | null = null;

  try {
    const def = reportDef(key);
    if (!def) return { key, status: 'error', detail: `Unknown alert "${key}".` };

    const cfg = reportConfig(db, key);
    if (!cfg.enabled) return { key, status: 'disabled' };

    // NOTHING TO SAY IS AN ANSWER. A price hike with no spike, a confirmation
    // for a booking that is not confirmed — the builder's own sentence is the
    // status, and no message is sent.
    if (built.empty) return { key, status: 'nothing_to_report', detail: built.emptyReason };

    if (trigger === 'event' && eventAlreadySent(db, key, args.dedupeKey)) {
      return { key, status: 'already_sent', detail: `An alert for ${args.dedupeKey} has already gone out.` };
    }

    const override = Array.isArray(opts.recipientsOverride) ? opts.recipientsOverride.filter(Boolean) : null;
    let numbers: string[];
    if (override) {
      numbers = override.map(n => normalizeWaNumber(n)).filter(Boolean);
    } else if (args.recipients) {
      // A fixed recipient list decided by the event itself — the guest on the
      // booking. NOT the configured staff audience, and never merged with it:
      // a guest confirmation must not also land on the management group, and
      // management must not be silently CC'd on a message to a customer.
      numbers = args.recipients.map(n => normalizeWaNumber(n)).filter(Boolean);
    } else {
      numbers = reportAudience(db, cfg).numbers;
    }
    numbers = Array.from(new Set(numbers));
    if (!numbers.length) return { key, status: 'no_recipients', detail: 'Nobody is set to receive this alert.' };

    if (!cfg.template) {
      return { key, status: 'no_template', detail: `Set wa_report_${key}_template to an APPROVED Meta template.` };
    }
    if (!isWaConfigured()) {
      logWaSendAttempt({ event: 'report_event', report_key: key, ok: false, reason: 'not_configured' });
      return { key, status: 'not_configured', detail: 'WhatsApp is not configured — Settings → Integrations → WhatsApp.' };
    }

    // ── THE DAILY CAP ───────────────────────────────────────────────────────
    // Counted in MESSAGES, because that is what Meta bills. Checked here, after
    // the audience is known and before a single one is sent, so an alert that
    // would cross the cap is refused whole rather than delivered to the first
    // four of seven people. Guest confirmations are exempt — see the cap's own
    // comment above.
    if (def.audience !== 'guest') {
      const cap = alertDailyCap(db, key);
      const already = alertMessagesSentToday(db, key, nowMs);
      if (already + numbers.length > cap) {
        const detail =
          `${def.label} has already sent ${already} message(s) today and this alert needs ${numbers.length} more, `
          + `which is over the ${cap}/day cap for this alert. Nothing was sent. `
          + `Raise it on the Scheduled Reports page (setting wa_report_${key}_daily_cap, at most ${MAX_ALERT_DAILY_CAP}) if this is a normal day's traffic.`;
        logWaSendAttempt({
          event: 'report_event', report_key: key, ok: false, reason: 'daily_cap_reached',
          detail, cap, already, wanted: numbers.length, trigger_source: trigger,
        });
        return { key, status: 'daily_cap_reached', detail };
      }
    }

    // WHAT THE THREAD RECORDS. Every signed-in member can read wa_messages.body
    // through the open inbox routes, so an alert addressed to MANAGEMENT
    // records a caption — its name and what it was about — and never its own
    // text, which carries rates, vendors and discount rupees. A GUEST-facing
    // confirmation is the exception: that bubble is the guest's own message.
    const confidential = def.audience !== 'guest';
    const bubble = confidential
      ? reportThreadCaption({ reportKey: key, label: def.label, period: built.period, filename: built.filename })
      : built.text;

    // The ledger row is opened BEFORE the send and carries the dedupe key, so
    // a crash between "sent" and "recorded" leaves a 'running' row naming the
    // thing — which is at least a trail — rather than nothing at all.
    runId = openAdhocRun(db, {
      key, outletId: '', runDate: istNow(nowMs).date,
      trigger, actor: opts.actor, period: args.dedupeKey,
    });

    // A document rides along only when the builder made one (the price-hike
    // list). Everything else is a sentence, and sendReportAttachment would
    // rightly refuse an empty attachment.
    if (built.pdf && built.pdf.byteLength) {
      const res = await sendReportAttachment(db, {
        reportKey: built.key, period: built.period, filename: built.filename,
        mime: built.mime, data: built.pdf,
        templateName: cfg.template, language: cfg.lang, bodyParams: built.params,
        recipients: numbers, sentBy: `alert:${key}`,
        reportLabel: def.label, confidential, threadBody: confidential ? '' : built.text,
        createdBy: opts.actor || trigger, trigger,
      }, { fetchImpl: opts.fetchImpl });

      if (res.refused) {
        const detail = `${res.refused.reason}: ${res.refused.detail}`;
        finishRun(db, runId, { status: 'refused', detail, period: args.dedupeKey, recipients: numbers, fileId: res.file_id });
        return { key, status: 'refused', detail, file_id: res.file_id, run_id: runId };
      }
      const status = res.failed.length ? (res.sent.length ? 'partial' : 'failed') : 'sent';
      finishRun(db, runId, {
        status, period: args.dedupeKey, recipients: numbers,
        sent: res.sent.length, failed: res.failed.length, fileId: res.file_id,
        detail: res.failed.map(f => `${f.to}: ${f.detail}`).join(' | '),
      });
      return {
        key, status: status === 'failed' ? 'refused' : status,
        sent: res.sent.length, failed: res.failed.length, file_id: res.file_id, run_id: runId,
        detail: res.failed.length ? res.failed.map(f => `${f.to}: ${f.detail}`).join(' | ') : undefined,
      };
    }

    const r = await sendTemplateTo(db, {
      key, to: numbers, templateName: cfg.template, language: cfg.lang,
      params: built.params, body: bubble, sentBy: `alert:${key}`,
      trigger, fetchImpl: opts.fetchImpl,
    });
    const status = r.failed ? (r.sent ? 'partial' : 'failed') : 'sent';
    finishRun(db, runId, {
      status, period: args.dedupeKey, recipients: numbers,
      sent: r.sent, failed: r.failed, detail: r.errors.join(' | '),
    });
    return {
      key, status: status === 'failed' ? 'refused' : status,
      sent: r.sent, failed: r.failed, run_id: runId,
      detail: r.errors.length ? r.errors.join(' | ') : undefined,
    };
  } catch (e: any) {
    const detail = e?.message || 'Unexpected error firing the alert';
    finishRun(db, runId, { status: 'error', detail, period: args.dedupeKey });
    try { console.error(`[wa-report-events ${key}]`, detail); } catch { /* never */ }
    return { key, status: 'error', detail, run_id: runId };
  }
}

/* ═══════════════ the three events ═══════════════ */

/**
 * A vendor bill came in above the item's own average by more than the
 * configured threshold.
 *
 * `materialIds` is what makes this an ALERT ABOUT THIS BILL rather than a
 * digest of the whole backlog: without it the first purchase of the day would
 * report every historical spike in the system and the storekeeper would learn
 * to ignore it. `sourceId` (the GRN id) is the dedupe key, so a retried save
 * alerts once.
 *
 * ── DO NOT CALL THIS PER PURCHASE LINE ───────────────────────────────────
 * POST /api/purchases writes ONE LINE PER REQUEST, so a six-line grocery bill
 * is six requests. Calling this from there alerted six times — six × every
 * recipient, all about the same bill, all within a minute. The busiest day in
 * this install's own data (44 lines) would have been 44 alerts, and at the
 * 20-recipient cap that is 880 billable messages from one afternoon of typing.
 * A per-line caller must use queuePriceHikeForPurchase() below, which collects
 * the whole bill and fires ONCE. This function stays for callers whose event
 * IS the bill — a GRN receipt, and the config page's Send Test.
 *
 * Call AFTER the purchase has committed, as `void firePriceHikeAlert(...)`.
 */
export async function firePriceHikeAlert(
  db: Database.Database,
  args: { materialIds: string[]; sourceId: string; period?: string },
  opts: FireOpts = {},
): Promise<EventFireResult> {
  try {
    const ids = (Array.isArray(args.materialIds) ? args.materialIds : []).map(S).filter(Boolean);
    if (!ids.length) return { key: 'price_hike', status: 'nothing_to_report', detail: 'No materials on this bill.' };
    const built = await buildPriceHikeAlert(db, { materialIds: ids, period: args.period });
    return await fireBuilt(db, 'price_hike', built, { dedupeKey: `purchase:${S(args.sourceId)}` }, opts);
  } catch (e: any) {
    try { console.error('[wa-report-events price_hike]', e?.message || e); } catch { /* never */ }
    return { key: 'price_hike', status: 'error', detail: e?.message || 'unexpected error' };
  }
}

/* ═══════════════ ONE ALERT PER BILL, NOT PER LINE ═══════════════ */

/**
 * How long a bill must sit untouched before its price-hike alert goes out.
 *
 * A storekeeper enters a bill line by line, seconds apart. Each line extends
 * this window, so the alert fires once, after they stop — and covers every line
 * they entered, which alerting on line 1 immediately could not do.
 *
 * Two minutes, against a scheduler that ticks every 5 minutes in business
 * hours: the wait in practice is the tick, not this number. A price alert is
 * not an alarm — it is read when someone next looks at their phone — so trading
 * a few minutes for "one message about one bill" is the right way round.
 */
export const PRICE_HIKE_QUIET_MS = 2 * 60_000;

/** How many bills one flush pass will send for, so a backlog cannot storm. */
export const PRICE_HIKE_FLUSH_LIMIT = 5;

/**
 * The bill a purchase line belongs to, and every material on it.
 *
 * invoice_id is OUR per-bill number: every line of one vendor bill shares it
 * (see POST /api/purchases). It is therefore the natural bill identity here.
 * A row without one falls back to the vendor + the vendor's own bill number +
 * the date — the same triple that mints an invoice_id — and, failing that, to
 * the line itself, which is honestly a bill of one.
 */
function billScope(db: Database.Database, purchaseId: string): {
  dedupeKey: string; materialIds: string[]; period: string;
} | null {
  try {
    const row = db.prepare(`
      SELECT id, material_id, COALESCE(invoice_id,'') AS invoice_id,
             COALESCE(bill_no,'') AS bill_no, COALESCE(vendor,'') AS vendor, date
        FROM purchases WHERE id = ?
    `).get(S(purchaseId)) as any;
    if (!row) return null;

    const period = S(row.date).slice(0, 10);
    const invoice = S(row.invoice_id);
    if (invoice) {
      const ids = db.prepare(
        `SELECT DISTINCT material_id FROM purchases WHERE COALESCE(invoice_id,'') = ?`,
      ).all(invoice) as any[];
      return { dedupeKey: `bill:inv:${invoice}`, materialIds: ids.map(r => S(r.material_id)).filter(Boolean), period };
    }
    const billNo = S(row.bill_no);
    if (billNo) {
      const vendorKey = S(row.vendor).toLowerCase();
      const ids = db.prepare(`
        SELECT DISTINCT material_id FROM purchases
         WHERE LOWER(TRIM(COALESCE(vendor,''))) = ? AND LOWER(TRIM(COALESCE(bill_no,''))) = ? AND date = ?
      `).all(vendorKey, billNo.toLowerCase(), S(row.date)) as any[];
      return {
        dedupeKey: `bill:vbd:${vendorKey}|${billNo.toLowerCase()}|${S(row.date)}`,
        materialIds: ids.map(r => S(r.material_id)).filter(Boolean), period,
      };
    }
    return { dedupeKey: `purchase:${S(row.id)}`, materialIds: [S(row.material_id)], period };
  } catch { return null; }
}

/** Re-derive a queued bill's materials from its dedupe key at flush time. */
function materialsForDedupeKey(db: Database.Database, dedupeKey: string): string[] {
  try {
    if (dedupeKey.startsWith('bill:inv:')) {
      const inv = dedupeKey.slice('bill:inv:'.length);
      return (db.prepare(`SELECT DISTINCT material_id FROM purchases WHERE COALESCE(invoice_id,'') = ?`)
        .all(inv) as any[]).map(r => S(r.material_id)).filter(Boolean);
    }
    if (dedupeKey.startsWith('bill:vbd:')) {
      const [vendorKey, billNo, date] = dedupeKey.slice('bill:vbd:'.length).split('|');
      return (db.prepare(`
        SELECT DISTINCT material_id FROM purchases
         WHERE LOWER(TRIM(COALESCE(vendor,''))) = ? AND LOWER(TRIM(COALESCE(bill_no,''))) = ? AND date = ?
      `).all(S(vendorKey), S(billNo), S(date)) as any[]).map(r => S(r.material_id)).filter(Boolean);
    }
    if (dedupeKey.startsWith('purchase:')) {
      const r = db.prepare('SELECT material_id FROM purchases WHERE id = ?').get(dedupeKey.slice('purchase:'.length)) as any;
      return r ? [S(r.material_id)] : [];
    }
  } catch { /* fall through */ }
  return [];
}

/**
 * QUEUE a price-hike alert for the bill this purchase line belongs to.
 *
 * Synchronous, tiny, and never throws — it writes ONE 'pending' row in the run
 * ledger keyed on the bill and returns. The next flush (the scheduler tick, or
 * the cron POST) sends at most one alert for that bill, covering every line on
 * it. A second line on the same bill finds the pending row and simply pushes
 * its clock forward; it cannot create a second alert.
 *
 * Call AFTER the purchase has committed.
 */
export function queuePriceHikeForPurchase(
  db: Database.Database,
  args: { purchaseId: string },
  opts: { nowMs?: number } = {},
): { key: string; status: string; detail?: string; dedupe_key?: string } {
  const key = 'price_hike';
  try {
    // OFF MEANS OFF, INCLUDING THE PAPERWORK. An install that has never armed
    // this alert must not accumulate a ledger row for every purchase line
    // somebody types. Checked first, so the common case is one settings read.
    if (!reportConfig(db, key).enabled) return { key, status: 'disabled' };

    const scope = billScope(db, args.purchaseId);
    if (!scope) return { key, status: 'nothing_to_report', detail: 'That purchase line no longer exists.' };

    // Already alerted for this bill? Then there is nothing to queue — the same
    // question fireBuilt would ask, asked before writing a row.
    if (eventAlreadySent(db, key, scope.dedupeKey)) {
      return { key, status: 'already_sent', dedupe_key: scope.dedupeKey };
    }

    const runDate = istNow(opts.nowMs ?? Date.now()).date;
    // Extend the quiet window if this bill is already waiting…
    const upd = db.prepare(`
      UPDATE wa_report_runs
         SET claimed_at = datetime('now'), attempts = attempts + 1
       WHERE report_key = ? AND trigger_source = 'event' AND period = ? AND status = 'pending'
    `).run(key, scope.dedupeKey);
    if (upd.changes) return { key, status: 'queued', dedupe_key: scope.dedupeKey };

    // …otherwise open the wait. A race that inserts two pending rows for one
    // bill is harmless: the first to flush sends, and the second is answered by
    // the dedupe check with 'already_sent' and dropped.
    db.prepare(`
      INSERT INTO wa_report_runs (report_key, outlet_id, run_date, period, status, detail, trigger_source, attempts, claimed_at)
      VALUES (?, '', ?, ?, 'pending', ?, 'event', 1, datetime('now'))
    `).run(key, runDate, scope.dedupeKey,
      'Waiting for the rest of this bill before alerting — one alert per bill, not one per line.');
    return { key, status: 'queued', dedupe_key: scope.dedupeKey };
  } catch (e: any) {
    try { console.error('[wa-report-events price_hike queue]', e?.message || e); } catch { /* never */ }
    return { key, status: 'error', detail: e?.message || 'unexpected error' };
  }
}

/**
 * Send the alerts for bills that have stopped growing. Called from the
 * scheduler tick and from the cron POST; NEVER throws.
 *
 * The pending row is a transient, not the record: once an outcome is known it
 * is deleted (the run row fireBuilt wrote is the record) — except when the
 * daily cap refused the send, which is kept precisely so somebody can see that
 * it happened. A process killed mid-send leaves the pending row behind, and the
 * next pass finds the alert already sent and clears it without sending again.
 */
export async function flushPriceHikeAlerts(
  db: Database.Database,
  opts: { nowMs?: number; quietMs?: number; fetchImpl?: typeof fetch; limit?: number } = {},
): Promise<EventFireResult[]> {
  const key = 'price_hike';
  const out: EventFireResult[] = [];
  try {
    const quietSeconds = Math.max(0, Math.round((opts.quietMs ?? PRICE_HIKE_QUIET_MS) / 1000));
    const limit = Math.max(1, Math.min(50, opts.limit ?? PRICE_HIKE_FLUSH_LIMIT));
    const due = db.prepare(`
      SELECT id, period FROM wa_report_runs
       WHERE report_key = ? AND trigger_source = 'event' AND status = 'pending'
         AND claimed_at <= datetime('now', ?)
       ORDER BY id LIMIT ?
    `).all(key, `-${quietSeconds} seconds`, limit) as any[];

    for (const row of due) {
      const dedupeKey = S(row.period);
      const materialIds = materialsForDedupeKey(db, dedupeKey);
      let res: EventFireResult;
      if (!materialIds.length) {
        res = { key, status: 'nothing_to_report', detail: 'No purchase line remains on that bill.' };
      } else {
        const built = await buildPriceHikeAlert(db, { materialIds });
        res = await fireBuilt(db, 'price_hike', built, { dedupeKey }, {
          fetchImpl: opts.fetchImpl, nowMs: opts.nowMs, trigger: 'event',
        });
      }
      out.push(res);

      try {
        if (res.status === 'daily_cap_reached') {
          finishRun(db, Number(row.id), { status: 'daily_cap_reached', detail: res.detail, period: dedupeKey });
        } else {
          db.prepare('DELETE FROM wa_report_runs WHERE id = ?').run(Number(row.id));
        }
      } catch { /* the send already happened; bookkeeping must not undo it */ }
    }
  } catch (e: any) {
    try { console.error('[wa-report-events price_hike flush]', e?.message || e); } catch { /* never */ }
  }
  return out;
}

/**
 * A bill discount or a service-charge waiver was decided.
 * Call AFTER the decision has committed, as `void fireDiscountAlert(...)`.
 */
export async function fireDiscountAlert(
  db: Database.Database,
  args: { requestId: string },
  opts: FireOpts = {},
): Promise<EventFireResult> {
  try {
    const id = S(args.requestId);
    const built = await buildDiscountAlert(db, { requestId: id });
    return await fireBuilt(db, 'discount_alert', built, { dedupeKey: `discount:${id}` }, opts);
  } catch (e: any) {
    try { console.error('[wa-report-events discount_alert]', e?.message || e); } catch { /* never */ }
    return { key: 'discount_alert', status: 'error', detail: e?.message || 'unexpected error' };
  }
}

/**
 * A table was CONFIRMED to a guest.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ONE GOES TO A CUSTOMER, AND ONLY TO THAT CUSTOMER.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * The recipient is the guest phone on the booking. The configured audience is
 * NOT consulted and NOT added: a confirmation is addressed to one person, and
 * quietly copying management onto a guest's message would leak the guest's
 * booking to a staff group nobody told them about.
 *
 * The builder refuses on an allowlist (confirmed | booked | seated | completed),
 * so a booking still at its DEFAULT 'pending' — a request nobody has accepted —
 * can never produce "your table is confirmed". Fire this on the transition to
 * confirmed, never on creation.
 */
export async function fireReservationConfirmation(
  db: Database.Database,
  args: { bookingId: string },
  opts: FireOpts = {},
): Promise<EventFireResult> {
  try {
    const id = S(args.bookingId);
    const built = await buildReservationConfirmation(db, { bookingId: id });
    if (built.empty) return { key: 'reservation_confirmation', status: 'nothing_to_report', detail: built.emptyReason };
    const guest = normalizeWaNumber(built.guestPhone);
    if (!guest) {
      return { key: 'reservation_confirmation', status: 'no_recipients', detail: 'That reservation has no guest phone number.' };
    }
    return await fireBuilt(db, 'reservation_confirmation', built, {
      dedupeKey: `booking:${id}`, recipients: [guest],
    }, opts);
  } catch (e: any) {
    try { console.error('[wa-report-events reservation_confirmation]', e?.message || e); } catch { /* never */ }
    return { key: 'reservation_confirmation', status: 'error', detail: e?.message || 'unexpected error' };
  }
}

/* ═══════════════ the call-site helpers ═══════════════ */

/**
 * FIRE AND FORGET, from inside a route, with no await.
 *
 * This is the shape every call site uses. It exists so no route has to
 * remember the `void` + try/catch dance, and so the "must never block the
 * business action" rule is expressed once instead of at four call sites where
 * one of them would eventually be written without it.
 */
export function fireAndForget(p: () => Promise<unknown>): void {
  try {
    Promise.resolve()
      .then(p)
      .catch((e) => { try { console.error('[wa-report-events] alert failed (action unaffected):', e?.message || e); } catch { /* never */ } });
  } catch (e: any) {
    try { console.error('[wa-report-events] alert could not start (action unaffected):', e?.message || e); } catch { /* never */ }
  }
}
