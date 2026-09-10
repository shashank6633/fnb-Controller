/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { sendReportAttachment } from '@/lib/wa-report-send';
import { resolveRecipients, type ResolvedAudience } from '@/lib/wa-report-recipients';
import {
  buildDailyOpsReport, buildStockDifferenceReport, buildCrmDailyOverview,
  defaultOutletId, reportDef, type BuiltReport,
} from '@/lib/wa-report-builders';

/**
 * THE SCHEDULED REPORT RUNNER — the only thing here that sends.
 *
 * The builders in wa-report-builders.ts are pure and send nothing. This module
 * is where a report becomes a message: it reads the toggles, picks the day,
 * calls the builder, and hands the bytes to sendReportAttachment(). It computes
 * NO figure of its own.
 *
 * ── EVERY JOB IS OFF UNTIL SOMEBODY TURNS IT ON ──────────────────────────
 * Settings per report, in their OWN namespace:
 *
 *   wa_report_<key>_enabled       '1' to send at all.            DEFAULT OFF
 *   wa_report_<key>_recipients    comma-separated mobiles.       DEFAULT NONE
 *   wa_report_<key>_audience      JSON audience tokens.          DEFAULT NONE
 *   wa_report_<key>_template      an APPROVED Meta template.     DEFAULT NONE
 *   wa_report_<key>_lang          template language.             DEFAULT 'en'
 *   wa_report_<key>_offset_days   which day to report.           DEFAULT 1
 *   wa_report_<key>_time          IST send time 'HH:MM'.         DEFAULT 08:00
 *   wa_report_<key>_outlets       JSON outlet ids.               DEFAULT default outlet
 *
 * NOT `wa_notify_recipients`. That blob is REBUILT FROM WA_NOTIFY_EVENTS on
 * every save of the Notifications tab, which is exactly how a recipient list
 * has silently vanished in this codebase before (the comment above
 * WA_NOTIFY_EVENTS in whatsapp.ts documents the incident). Reports keep their
 * own keys so no save on that tab can wipe them, and so nothing here has to
 * touch that array.
 *
 * ── THE DAY REPORTED IS YESTERDAY, ON PURPOSE ────────────────────────────
 * offset_days defaults to 1, matching the calls_daily job's reasoning verbatim:
 * the cron runs in the morning, and a part-finished day would send a panic at
 * 9am that fixes itself by lunch. A closing count is also entered at end of
 * day, so "today's stock differences" at 08:00 is always an empty report.
 *
 * ── ONCE A DAY PER OUTLET, ENFORCED BY THE DATABASE ──────────────────────
 * The slot is a row in wa_report_runs, unique on (report_key, outlet_id,
 * run_date) through a PARTIAL index covering scheduler runs only. claimRun()
 * is ONE atomic upsert: the second caller changes no row and stands down. A
 * restart mid-tick, the in-process scheduler racing the external cron POST, a
 * double-clicked "Run now" — none of them can produce two sends, because none
 * of them can produce two winning claims.
 *
 * The slot day is the IST calendar day, not the UTC one. The UTC day rolls at
 * 05:30 IST, so a UTC slot would let a 05:00 report and a 06:00 report land on
 * different days and fire twice on one Indian morning.
 *
 * A FAILURE STILL DOES NOT BURN THE SLOT. Only 'sent', 'partial' and 'skipped'
 * hold it. 'failed', 'refused' and 'nothing_to_report' are re-claimable on the
 * next tick, so a credentials fault, a transient outage, or a closing count
 * entered at 11:00 for a report that had nothing to say at 08:00 all still go
 * out the same day. A 'running' row past the stale window is re-claimable too,
 * so a process killed mid-send does not wedge the report until midnight.
 * ('skipped' is terminal because it is written deliberately — by a save that
 * arms the report for TOMORROW, or by the send-log backstop standing a tick
 * down. Making it re-claimable would undo both.)
 *
 * ── AN EMPTY REPORT IS NEVER SENT AS A BLANK PDF ─────────────────────────
 * When a builder says `empty`, this skips the send entirely and records the
 * builder's own sentence as the status. No document, no template send, no
 * charge, and nothing in anyone's chat that says "0.00" nine times.
 *
 * NEVER THROWS. A cron tick must survive every one of these.
 */

export interface ReportJobStatus {
  key: string;
  /** disabled | not_due | no_recipients | no_template | nothing_to_report |
   *  already_sent_today | sent | partial | refused | error */
  status: string;
  detail?: string;
  period?: string;
  file_id?: number | null;
  sent?: number;
  failed?: number;
  /** Which outlet this run was for. */
  outlet_id?: string;
  /** The IST slot day the run occupied. */
  run_date?: string;
  /** wa_report_runs.id, when a run row was claimed. */
  run_id?: number | null;
}

const SCHEDULED_JOBS: Record<string, (db: Database.Database, date: string, outletId: string | null) => Promise<BuiltReport>> = {
  daily_ops: (db, date, outletId) => buildDailyOpsReport(db, { date, outletId }),
  stock_differences: (db, date, outletId) => buildStockDifferenceReport(db, { date, outletId }),
  crm_daily: (db, date, outletId) => buildCrmDailyOverview(db, { date, outletId }),
};

/** The reports this rail schedules. Event alerts are fired from their own rails. */
export function scheduledReportKeys(): string[] { return Object.keys(SCHEDULED_JOBS); }

function setting(db: Database.Database, key: string, fallback = ''): string {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
    const v = String(r?.value ?? '').trim();
    return v || fallback;
  } catch { return fallback; }
}

/* ═══════════════ configuration ═══════════════ */

export const DEFAULT_REPORT_TIME = '08:00';

export interface ReportConfig {
  enabled: boolean;
  /** Manual numbers typed by an admin (the legacy list). */
  recipients: string[];
  /** Audience tokens — 'mgmt', 'hod:<dept>', 'user:<id>'. See wa-report-recipients.ts. */
  audience: string[];
  template: string;
  lang: string;
  offsetDays: number;
  /** IST 'HH:MM'. */
  time: string;
  /** Minutes past IST midnight, for the due test. */
  timeMinutes: number;
  /** Outlet ids this report runs for. Empty means the default outlet only. */
  outlets: string[];
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.map(v => String(v ?? '').trim()).filter(Boolean) : [];
  } catch { return []; }
}

/** 'HH:MM' to minutes past midnight, or null when it is not a real time of day. */
export function parseHhMm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Read one report's configuration. Pure read; missing keys mean "off". */
export function reportConfig(db: Database.Database, key: string): ReportConfig {
  const raw = setting(db, `wa_report_${key}_recipients`);
  const offset = Number(setting(db, `wa_report_${key}_offset_days`, '1'));
  const timeRaw = setting(db, `wa_report_${key}_time`, DEFAULT_REPORT_TIME);
  const mins = parseHhMm(timeRaw);
  return {
    enabled: setting(db, `wa_report_${key}_enabled`) === '1',
    recipients: raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10),
    audience: parseJsonArray(setting(db, `wa_report_${key}_audience`)),
    template: setting(db, `wa_report_${key}_template`),
    lang: setting(db, `wa_report_${key}_lang`, 'en'),
    offsetDays: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 1,
    // An unparseable time falls back to the default rather than to "never" — a
    // report an admin switched ON must not sit silent because of a typo in a
    // field they may not have touched.
    time: mins == null ? DEFAULT_REPORT_TIME : timeRaw,
    timeMinutes: mins == null ? (parseHhMm(DEFAULT_REPORT_TIME) as number) : mins,
    outlets: parseJsonArray(setting(db, `wa_report_${key}_outlets`)),
  };
}

/**
 * Everyone this report would actually be messaged to, resolved fresh.
 * Audience tokens first, then the manual numbers — see wa-report-recipients.ts.
 */
export function reportAudience(db: Database.Database, cfg: ReportConfig): ResolvedAudience {
  return resolveRecipients(db, { audience: cfg.audience, manual: cfg.recipients });
}

/* ═══════════════ IST clock ═══════════════ */

/** IST calendar date `back` days before now, as YYYY-MM-DD. */
export function istDateBack(back: number, nowMs = Date.now()): string {
  return new Date(nowMs + 330 * 60_000 - back * 86_400_000).toISOString().slice(0, 10);
}

/** The IST wall clock right now: the calendar day and minutes past midnight. */
export function istNow(nowMs = Date.now()): { date: string; minutes: number } {
  const shifted = new Date(nowMs + 330 * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Has this report been SUCCESSFULLY delivered today? Reads the send rail's own
 * whatsapp_events_log rows, and counts ok:true only.
 *
 * THIS IS A BACKSTOP, NOT THE GATE. The gate is the wa_report_runs claim. Both
 * must agree before anything is sent, so the two together can only ever cause
 * FEWER sends than either alone — never more. It earns its place by covering
 * the one case the claim cannot: a process killed AFTER the messages went out
 * but BEFORE finishRun, whose 'running' row becomes re-claimable once the stale
 * window passes. The log rows were written per recipient, as each send
 * returned, so they survive that death.
 *
 * SCOPED PER OUTLET when an outlet is given. Reading it without one on a
 * multi-outlet install is a REAL bug and was one: the first outlet's send makes
 * every other outlet look already-sent, so branch two silently never receives
 * its report. The outlet id is on the log row because sendReportAttachment puts
 * it there. Omitting the argument keeps the old any-outlet reading, which is
 * what a single-outlet install wants and what the existing callers expect.
 *
 * The day is the IST calendar day, matching the ledger's slot. It used to be
 * date('now') — the UTC day — which rolls at 05:30 IST and would therefore
 * disagree with the slot for any schedule between midnight and 05:30.
 *
 * ── A TEST SEND IS NOT A DELIVERY, AND THIS IS WHERE THAT IS ENFORCED ─────
 * "Send Test" reaches the tester and nobody else. It used to leave a log row
 * indistinguishable from a real send — same report_key, same outlet, ok:true —
 * so this backstop then stood the day's REAL send down, the configured
 * recipients got nothing, and the ledger recorded "already delivered today".
 * On the morning an admin sets a report up and tests it, that report never
 * arrived. Every row now carries trigger_source (wa-report-send.ts), and a
 * 'test' row is excluded here.
 *
 * A 'manual' row still counts, deliberately: "Run now" sends the real report to
 * the real audience, so the schedule standing down afterwards is correct.
 */
export function reportSentToday(
  db: Database.Database, key: string, outletId?: string | null, nowMs = Date.now(),
): boolean {
  try {
    const clauses = [
      `kind = 'send_attempt'`,
      `date(created_at, '+330 minutes') = @day`,
      `payload LIKE @key`,
      `payload LIKE '%"ok":true%'`,
      // A TEST IS NOT A DELIVERY. Rows written before trigger_source existed
      // carry no such marker and still count — they were real sends by every
      // reading available, and forgiving history is the safe direction for a
      // backstop whose only job is "not twice".
      `payload NOT LIKE '%"trigger_source":"test"%'`,
    ];
    const params: Record<string, string> = {
      day: istNow(nowMs).date,
      key: `%"report_key":"${key}"%`,
    };
    if (outletId != null) {
      // An UNLABELLED delivery counts for every outlet. Rows written before the
      // outlet was stamped on the log carry no outlet_id at all, and the
      // conservative reading of "this report was delivered today, outlet
      // unknown" is that it might have been this one — otherwise an install
      // upgraded halfway through a morning would re-send the report it had
      // already sent an hour earlier. Every row written from now on carries the
      // field, so this clause only ever forgives history.
      clauses.push(`(payload LIKE @outlet OR payload NOT LIKE '%"outlet_id":%')`);
      params.outlet = `%"outlet_id":"${String(outletId)}"%`;
    }
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM whatsapp_events_log WHERE ${clauses.join(' AND ')}`,
    ).get(params) as { n: number } | undefined;
    return (row?.n || 0) > 0;
  } catch { return false; }
}

/* ═══════════════ the run ledger ═══════════════ */

/**
 * How long a 'running' claim is respected before another tick may take it.
 * Long enough that a genuine send (template lookup, upload, N messages) is
 * never stolen mid-flight; short enough that a killed process does not wedge
 * the report until midnight.
 */
export const RUN_CLAIM_STALE_MS = 10 * 60_000;

export interface ReportRunRow {
  id: number; report_key: string; outlet_id: string; run_date: string;
  period: string; status: string; detail: string; recipients: string;
  sent_count: number; failed_count: number; file_id: number | null;
  trigger_source: string; actor: string; attempts: number;
  claimed_at: string; finished_at: string;
}

/**
 * Claim today's scheduled slot for one report + outlet. Returns the run id, or
 * null when the slot is already held.
 *
 * ONE STATEMENT. That is the whole point: two concurrent ticks both execute
 * this, SQLite serialises them, and exactly one sees changes === 1. There is no
 * window between "check" and "claim" for a second tick to slip through,
 * because there is no separate check.
 */
export function claimRun(
  db: Database.Database,
  args: { key: string; outletId: string; runDate: string; nowMs?: number },
): number | null {
  const staleSeconds = Math.round(RUN_CLAIM_STALE_MS / 1000);
  try {
    const info = db.prepare(`
      INSERT INTO wa_report_runs (report_key, outlet_id, run_date, status, trigger_source, attempts, claimed_at)
      VALUES (@key, @outlet, @date, 'running', 'scheduler', 1, datetime('now'))
      ON CONFLICT(report_key, outlet_id, run_date) WHERE trigger_source = 'scheduler'
      DO UPDATE SET status = 'running', attempts = wa_report_runs.attempts + 1,
                    claimed_at = datetime('now'), finished_at = ''
       WHERE wa_report_runs.status NOT IN ('sent', 'partial', 'skipped')
         AND (wa_report_runs.status <> 'running'
              OR wa_report_runs.claimed_at < datetime('now', @stale))
    `).run({ key: args.key, outlet: args.outletId, date: args.runDate, stale: `-${staleSeconds} seconds` });
    if (!info.changes) return null;
    const row = db.prepare(
      `SELECT id FROM wa_report_runs
        WHERE report_key = ? AND outlet_id = ? AND run_date = ? AND trigger_source = 'scheduler'`,
    ).get(args.key, args.outletId, args.runDate) as any;
    return row?.id != null ? Number(row.id) : null;
  } catch {
    // A ledger fault must not become a send. Refusing to claim means refusing
    // to send, which is the safe direction for a rail whose entire job is
    // "not twice".
    return null;
  }
}

/**
 * Record a run that never occupies the scheduled slot — an admin "run now", a
 * test send, or an event alert. The partial unique index covers
 * trigger_source = 'scheduler' only, so any number of these may exist for the
 * same report on the same day without blocking (or satisfying) the schedule.
 */
export function openAdhocRun(
  db: Database.Database,
  args: {
    key: string; outletId: string; runDate: string;
    trigger: 'manual' | 'test' | 'event'; actor?: string; period?: string;
  },
): number | null {
  try {
    const info = db.prepare(`
      INSERT INTO wa_report_runs (report_key, outlet_id, run_date, period, status, trigger_source, actor, attempts, claimed_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, 1, datetime('now'))
    `).run(
      args.key, args.outletId, args.runDate, String(args.period || ''),
      args.trigger, String(args.actor || '').slice(0, 120),
    );
    return Number(info.lastInsertRowid);
  } catch { return null; }
}

export function finishRun(
  db: Database.Database,
  runId: number | null,
  patch: {
    status: string; detail?: string; period?: string; recipients?: string[];
    sent?: number; failed?: number; fileId?: number | null;
  },
): void {
  if (!runId) return;
  try {
    db.prepare(`
      UPDATE wa_report_runs
         SET status = @status, detail = @detail, period = @period, recipients = @recipients,
             sent_count = @sent, failed_count = @failed, file_id = @file,
             finished_at = datetime('now')
       WHERE id = @id
    `).run({
      id: runId,
      status: String(patch.status || 'error'),
      detail: String(patch.detail || '').slice(0, 2000),
      period: String(patch.period || ''),
      recipients: JSON.stringify(patch.recipients || []),
      sent: Number(patch.sent || 0),
      failed: Number(patch.failed || 0),
      file: patch.fileId == null ? null : Number(patch.fileId),
    });
  } catch { /* the send already happened; a ledger write must not undo it */ }
}

/** The most recent run of a report, whatever its trigger. For the config page. */
export function lastRun(db: Database.Database, key: string): ReportRunRow | undefined {
  try {
    return db.prepare(
      'SELECT * FROM wa_report_runs WHERE report_key = ? ORDER BY id DESC LIMIT 1',
    ).get(key) as ReportRunRow | undefined;
  } catch { return undefined; }
}

export function recentRuns(db: Database.Database, key: string, limit = 10): ReportRunRow[] {
  try {
    return db.prepare(
      'SELECT * FROM wa_report_runs WHERE report_key = ? ORDER BY id DESC LIMIT ?',
    ).all(key, Math.max(1, Math.min(100, limit))) as ReportRunRow[];
  } catch { return []; }
}

/**
 * Mark today's slot as deliberately skipped, so a report switched on AFTER its
 * send time does not fire the moment it is saved.
 *
 * Without this, enabling the 08:00 daily ops report at 16:00 sends it at 16:01
 * — a report the admin was configuring for TOMORROW arrives while they are
 * still typing. With it, the page can honestly say "first send tomorrow at
 * 08:00". A server that was simply down at 08:00 still catches up, because
 * nothing wrote a row for that slot.
 */
export function skipTodaysSlot(
  db: Database.Database,
  args: { key: string; outletId: string; runDate: string; detail: string },
): void {
  try {
    db.prepare(`
      INSERT INTO wa_report_runs (report_key, outlet_id, run_date, status, detail, trigger_source, claimed_at, finished_at)
      VALUES (@key, @outlet, @date, 'skipped', @detail, 'scheduler', datetime('now'), datetime('now'))
      ON CONFLICT(report_key, outlet_id, run_date) WHERE trigger_source = 'scheduler' DO NOTHING
    `).run({ key: args.key, outlet: args.outletId, date: args.runDate, detail: String(args.detail).slice(0, 500) });
  } catch { /* best effort: the worst case is one early report */ }
}

/** The outlets a report runs for: its configured list, else the default outlet. */
export function outletsFor(db: Database.Database, cfg: ReportConfig): string[] {
  if (cfg.outlets.length) return cfg.outlets;
  const d = defaultOutletId(db);
  return [String(d || '')];
}

/* ═══════════════ running one report ═══════════════ */

export interface RunReportOpts {
  /** Skip the once-a-day guard (never the enabled toggle, never the empty check). */
  force?: boolean;
  date?: string;
  outletId?: string | null;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** 'scheduler' claims the slot; 'manual' and 'test' are recorded, never claim. */
  trigger?: 'scheduler' | 'manual' | 'test';
  actor?: string;
  /**
   * Send to THESE numbers instead of the configured audience. The Send Test
   * button's whole safety property: a test reaches the person who pressed it
   * and nobody else, whatever the report is configured to do.
   */
  recipientsOverride?: string[];
}

/**
 * Run one scheduled report end to end. Returns a status; never throws.
 */
export async function runReportJob(
  db: Database.Database,
  key: string,
  opts: RunReportOpts = {},
): Promise<ReportJobStatus> {
  const def = reportDef(key);
  const trigger = opts.trigger || (opts.force ? 'manual' : 'scheduler');
  const nowMs = opts.nowMs ?? Date.now();
  const runDate = istNow(nowMs).date;
  let runId: number | null = null;

  try {
    if (!def) return { key, status: 'error', detail: `Unknown report "${key}".` };
    if (def.unimplemented) return { key, status: 'error', detail: def.unimplementedReason || 'Not implemented.' };
    const build = SCHEDULED_JOBS[key];
    if (!build) return { key, status: 'error', detail: `"${key}" is an event alert, not a scheduled report.` };

    const cfg = reportConfig(db, key);
    // A TEST SEND IS STILL GATED ON THE TOGGLE AND THE TEMPLATE — it only
    // overrides WHO receives. A test that skipped the real path would prove
    // nothing about the real path.
    if (!cfg.enabled) return { key, status: 'disabled' };

    const override = Array.isArray(opts.recipientsOverride) ? opts.recipientsOverride.filter(Boolean) : null;
    const audience = override ? null : reportAudience(db, cfg);
    const numbers = override || (audience ? audience.numbers : []);
    if (!numbers.length) {
      const missing = audience?.unreachable?.length || 0;
      const detail = missing
        ? `Nobody is set to receive this report. ${missing} chosen ${missing === 1 ? 'person has' : 'people have'} no WhatsApp number on file.`
        : 'Nobody is set to receive this report.';
      return { key, status: 'no_recipients', detail };
    }
    if (!cfg.template) {
      return { key, status: 'no_template', detail: `Set wa_report_${key}_template to an APPROVED Meta template with a DOCUMENT header.` };
    }

    const outletId = opts.outletId === undefined ? defaultOutletId(db) : opts.outletId;
    const outletKey = String(outletId || '');

    // ── THE SLOT ────────────────────────────────────────────────────────────
    // Scheduler runs claim; manual and test runs are recorded without claiming,
    // so an admin can press "Run now" as often as they like without either
    // consuming the day's send or being blocked by it.
    if (trigger === 'scheduler' && !opts.force) {
      runId = claimRun(db, { key, outletId: outletKey, runDate, nowMs });
      if (runId == null) {
        return { key, status: 'already_sent_today', outlet_id: outletKey, run_date: runDate };
      }
      // The backstop. Both gates must agree before anything is sent.
      // Recorded as 'skipped', NOT as 'sent': this run sent nothing, and a
      // ledger that says otherwise is a lie in the audit trail. 'skipped' is
      // terminal for the day, so this does not re-claim on every later tick.
      if (reportSentToday(db, key, outletKey, nowMs)) {
        finishRun(db, runId, {
          status: 'skipped',
          detail: 'Already delivered today according to the send log — this tick stood down and sent nothing.',
        });
        return { key, status: 'already_sent_today', outlet_id: outletKey, run_date: runDate, run_id: runId };
      }
    } else {
      runId = openAdhocRun(db, {
        key, outletId: outletKey, runDate,
        trigger: trigger === 'test' ? 'test' : 'manual', actor: opts.actor,
      });
    }

    const date = opts.date || istDateBack(cfg.offsetDays, nowMs);
    const built = await build(db, date, outletId ?? null);
    if (built.empty || !built.pdf) {
      // NOTHING IS SENT. Not an empty PDF, not a "no data" template — the
      // report simply does not go out, and the reason is on the cron response.
      // The slot is NOT held: a closing count entered at 11:00 for a report
      // that had nothing to say at 08:00 still goes out the same day.
      finishRun(db, runId, { status: 'nothing_to_report', detail: built.emptyReason, period: built.period });
      return {
        key, status: 'nothing_to_report', period: built.period, detail: built.emptyReason,
        outlet_id: outletKey, run_date: runDate, run_id: runId,
      };
    }

    const res = await sendReportAttachment(db, {
      reportKey: built.key,
      period: built.period,
      filename: built.filename,
      mime: built.mime,
      data: built.pdf,
      templateName: cfg.template,
      language: cfg.lang,
      bodyParams: built.params,
      recipients: numbers,
      sentBy: `report:${built.key}`,
      // NOT built.text. That text is the report — net collected, discount, tax,
      // payment mix, month to date — and wa_messages.body is readable by every
      // signed-in member through the two open inbox routes, which would defeat
      // the isManagement gate on the PDF sitting beside it. The thread gets the
      // report's NAME; the figures stay in the attachment. See `confidential`
      // in wa-report-send.ts.
      reportLabel: def.label,
      createdBy: trigger === 'scheduler' ? 'scheduler' : (opts.actor || trigger),
      // Which button pressed this. A test send must not satisfy the
      // already-delivered backstop below — see reportSentToday().
      trigger,
      // Stamped on every send-attempt log row, so the backstop above can ask
      // "already sent today?" PER OUTLET rather than for the report as a whole.
      outletId: outletKey,
    }, { fetchImpl: opts.fetchImpl });

    if (res.refused) {
      const detail = `${res.refused.reason}: ${res.refused.detail}`;
      finishRun(db, runId, { status: 'refused', detail, period: built.period, recipients: numbers, fileId: res.file_id });
      return {
        key, status: 'refused', period: built.period, file_id: res.file_id, detail,
        outlet_id: outletKey, run_date: runDate, run_id: runId,
      };
    }

    const ledgerStatus = res.failed.length ? (res.sent.length ? 'partial' : 'failed') : 'sent';
    const detail = res.failed.length ? res.failed.map(f => `${f.to}: ${f.detail}`).join(' | ') : '';
    finishRun(db, runId, {
      status: ledgerStatus, detail, period: built.period, recipients: numbers,
      sent: res.sent.length, failed: res.failed.length, fileId: res.file_id,
    });
    return {
      key,
      // 'failed' (nobody got it) is reported to callers as 'refused', keeping
      // the status vocabulary the cron response and its tests already use.
      status: ledgerStatus === 'failed' ? 'refused' : ledgerStatus,
      period: built.period, file_id: res.file_id,
      sent: res.sent.length, failed: res.failed.length,
      detail: detail || undefined,
      outlet_id: outletKey, run_date: runDate, run_id: runId,
    };
  } catch (e: any) {
    const detail = e?.message || 'Unexpected error running the report job';
    finishRun(db, runId, { status: 'error', detail });
    return { key, status: 'error', detail, run_id: runId };
  }
}

/* ═══════════════ the dispatcher ═══════════════ */

export interface DispatchOpts {
  force?: boolean;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** Ignore the configured send time (an admin asking for the due sweep now). */
  ignoreTime?: boolean;
}

/**
 * Every scheduled report that is DUE, in one pass. Dispatched from the
 * in-process scheduler tick and from the external cron POST.
 *
 * DUE means: enabled, and the IST wall clock has reached the configured send
 * time today, and the slot for today is unclaimed. The tick cadence is 5 min in
 * business hours and 30 min overnight (src/lib/scheduler.ts), so a report fires
 * AT OR SHORTLY AFTER its time — the configured time is the earliest it may go,
 * not a guarantee to the minute. A report whose time passed while the server
 * was down fires on the first tick after it comes back, which is what an owner
 * means by "send me this every morning".
 *
 * Each job is independently gated and independently best-effort: one report's
 * failure never starves another, and one outlet's never starves the next.
 */
export async function runWaReportJobs(
  db: Database.Database,
  opts: DispatchOpts = {},
): Promise<Record<string, ReportJobStatus>> {
  const out: Record<string, ReportJobStatus> = {};
  const nowMs = opts.nowMs ?? Date.now();
  const now = istNow(nowMs);

  for (const key of Object.keys(SCHEDULED_JOBS)) {
    let cfg: ReportConfig;
    try { cfg = reportConfig(db, key); }
    catch { out[key] = { key, status: 'error', detail: 'Could not read this report’s settings.' }; continue; }

    if (!cfg.enabled) { out[key] = { key, status: 'disabled' }; continue; }

    if (!opts.force && !opts.ignoreTime && now.minutes < cfg.timeMinutes) {
      out[key] = { key, status: 'not_due', detail: `Scheduled for ${cfg.time} IST; it is ${hhmm(now.minutes)}.` };
      continue;
    }

    const outlets = outletsFor(db, cfg);
    const results: ReportJobStatus[] = [];
    for (const outletId of outlets) {
      results.push(await runReportJob(db, key, {
        force: opts.force, nowMs, fetchImpl: opts.fetchImpl,
        outletId: outletId || null, trigger: 'scheduler',
      }));
    }
    // One outlet: report it as-is, so the response shape is unchanged for the
    // single-outlet install every one of these runs on today.
    out[key] = results.length === 1 ? results[0] : {
      key,
      status: results.every(r => r.status === results[0].status) ? results[0].status : 'partial',
      detail: results.map(r => `${r.outlet_id || 'default'}: ${r.status}${r.detail ? ' — ' + r.detail : ''}`).join(' | '),
      sent: results.reduce((n, r) => n + (r.sent || 0), 0),
      failed: results.reduce((n, r) => n + (r.failed || 0), 0),
      run_date: now.date,
    };
  }
  return out;
}
