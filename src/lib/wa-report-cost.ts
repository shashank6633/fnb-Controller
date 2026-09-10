/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { reportConfig, reportAudience, outletsFor, scheduledReportKeys } from '@/lib/wa-report-jobs';
import { alertDailyCap, MAX_ALERT_DAILY_CAP } from '@/lib/wa-report-events';
import { WA_REPORT_DEFS } from '@/lib/wa-report-builders';
// The broadcast rail's own settings reader — READ ONLY, so the report page and
// the broadcast page quote the same ₹/message and cannot drift apart.
import { broadcastSettings } from '@/lib/wa-broadcast';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THE REPORTS WILL COST — in rupees, on the page that switches them on
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ A RECURRING, BILLABLE SEND MUST SHOW ITS BILL BEFORE IT IS SWITCHED ON.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 * Every message on this rail is a Meta template conversation and Meta charges
 * for each one. The Scheduled Reports page used to say "5 recipients" and
 * nothing else — no rupee figure, no message count, no monthly projection —
 * while asking an owner to arm standing daily traffic across every outlet. The
 * broadcast page beside it has shown a cost line since the day it shipped
 * ("Meta will bill approximately …"), and there is no argument for the report
 * rail being quieter about money than the marketing rail.
 *
 * ── THE ARITHMETIC IS DELIBERATELY PLAIN ─────────────────────────────────
 *   scheduled report  recipients × outlets, once a day.
 *   event alert       the DAILY CAP — the most it can cost, since that is the
 *                     number the app actually enforces (wa-report-events.ts).
 *                     A typical day costs less; a runaway day cannot cost more.
 *   guest alert       one message per confirmed booking, so it is MEASURED off
 *                     the last 30 days of bookings rather than guessed at.
 * A month is 30 days here. It is a projection on a page, not an invoice, and
 * pretending to know the length of next month would add false precision.
 *
 * ── THE RATE IS THE ONE THE APP ALREADY HAS ──────────────────────────────
 * broadcast_cost_per_msg, the rate the broadcast rail bills against, read
 * through its own reader so the two pages can never quote different money.
 * There is deliberately NO second rate setting for reports: two rates would
 * drift, and the owner would have no way of knowing which one was wrong.
 *
 * PURE READS. Nothing here writes, sends, or reaches the network.
 */

/** Days in the projected month. A round figure, and labelled as one. */
export const COST_MONTH_DAYS = 30;

/** The fallback ₹/message if the broadcast rail cannot be read at all. */
export const FALLBACK_COST_PER_MSG = 0.8;

export interface ReportCostLine {
  key: string;
  label: string;
  kind: 'scheduled' | 'event';
  audience: 'management' | 'guest';
  enabled: boolean;
  /** People one send goes to. */
  recipients: number;
  /** Outlets a scheduled report runs for (1 for an event alert). */
  outlets: number;
  /** Messages in one send. */
  per_send: number;
  /** Messages a day — a ceiling for event alerts, an exact figure otherwise. */
  per_day: number;
  /** True when per_day is a CEILING (the cap) rather than a certainty. */
  ceiling: boolean;
  /** The enforced daily message cap, for alerts that have one. */
  daily_cap: number | null;
  cost_per_day: number;
  cost_per_month: number;
  /** The sum in words, for the screen. */
  basis: string;
}

export interface ReportCostEstimate {
  rate: number;
  rate_source: string;
  month_days: number;
  max_daily_cap: number;
  lines: ReportCostLine[];
  /** Enabled reports only — what switching these on actually costs. */
  messages_per_day: number;
  cost_per_day: number;
  cost_per_month: number;
  /** Everything on the page, enabled or not: what turning it ALL on would cost. */
  potential_messages_per_day: number;
  potential_cost_per_month: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** ₹ per message, from the broadcast rail's own configured rate. */
export function reportCostRate(db: Database.Database): { rate: number; source: string } {
  try {
    // Read through the broadcast rail's OWN reader, so the two pages can never
    // quote different money. Wrapped because a settings-table fault must show
    // the documented fallback rate, never take the config page down.
    const s = broadcastSettings(db);
    const rate = Number(s?.cost_per_msg);
    if (Number.isFinite(rate) && rate >= 0) {
      return { rate, source: 'broadcast_cost_per_msg (WhatsApp broadcast settings)' };
    }
  } catch { /* fall through to the documented fallback */ }
  return { rate: FALLBACK_COST_PER_MSG, source: 'default rate — set broadcast_cost_per_msg to the rate Meta actually charges you' };
}

/**
 * Guest confirmations a day, MEASURED: bookings that reached a confirmed state
 * in the last 30 days, divided by 30. Returns null when the table cannot be
 * read, and the caller then says "depends on bookings" instead of inventing a
 * number.
 */
export function measuredGuestSendsPerDay(db: Database.Database): number | null {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM ct_bookings
       WHERE is_duplicate = 0
         AND lower(status) IN ('confirmed','booked','seated','completed')
         AND date(booking_date) >= date('now', '-30 days')
    `).get() as any;
    const n = Number(r?.n);
    if (!Number.isFinite(n)) return null;
    return Math.round((n / 30) * 10) / 10;
  } catch { return null; }
}

/**
 * Every report on the page, with what it costs. Enabled reports are summed into
 * the headline; disabled ones still carry their own figure, because the whole
 * point is to know the cost BEFORE the switch is flipped.
 */
export function estimateReportCosts(db: Database.Database): ReportCostEstimate {
  const { rate, source } = reportCostRate(db);
  const scheduled = new Set(scheduledReportKeys());
  const guestPerDay = measuredGuestSendsPerDay(db);

  const lines: ReportCostLine[] = [];
  for (const def of WA_REPORT_DEFS) {
    if (def.unimplemented) continue;
    const cfg = reportConfig(db, def.key);
    const isScheduled = scheduled.has(def.key);
    const outlets = isScheduled ? Math.max(1, outletsFor(db, cfg).length) : 1;

    let recipients = 0;
    if (def.audience === 'guest') {
      recipients = 1;                                  // one guest, one message
    } else {
      try { recipients = reportAudience(db, cfg).numbers.length; } catch { recipients = 0; }
    }

    const perSend = recipients * (isScheduled ? outlets : 1);
    const cap = def.audience === 'guest' ? null : alertDailyCap(db, def.key);

    let perDay: number;
    let ceiling: boolean;
    let basis: string;
    if (isScheduled) {
      perDay = perSend;
      ceiling = false;
      basis = outlets > 1
        ? `${recipients} recipient(s) × ${outlets} outlets, once a day`
        : `${recipients} recipient(s), once a day`;
    } else if (def.audience === 'guest') {
      perDay = guestPerDay == null ? 0 : Math.ceil(guestPerDay);
      ceiling = false;
      basis = guestPerDay == null
        ? 'one message per confirmed booking — depends on bookings'
        : `one message per confirmed booking · about ${guestPerDay}/day over the last 30 days`;
    } else {
      // The cap IS the ceiling, and it is enforced, so this is the most this
      // alert can cost however busy the day gets.
      perDay = Math.min(cap as number, recipients ? cap as number : 0);
      ceiling = true;
      basis = recipients
        ? `${recipients} recipient(s) per alert · at most ${cap} message(s)/day (the enforced cap)`
        : 'nobody is set to receive it';
    }

    lines.push({
      key: def.key,
      label: def.label,
      kind: isScheduled ? 'scheduled' : 'event',
      audience: def.audience,
      enabled: cfg.enabled,
      recipients, outlets, per_send: perSend, per_day: perDay,
      ceiling, daily_cap: cap,
      cost_per_day: round2(perDay * rate),
      cost_per_month: round2(perDay * rate * COST_MONTH_DAYS),
      basis,
    });
  }

  const sum = (rows: ReportCostLine[]) => rows.reduce((n, r) => n + r.per_day, 0);
  const onMsgs = sum(lines.filter(l => l.enabled));
  const allMsgs = sum(lines);

  return {
    rate, rate_source: source, month_days: COST_MONTH_DAYS, max_daily_cap: MAX_ALERT_DAILY_CAP,
    lines,
    messages_per_day: onMsgs,
    cost_per_day: round2(onMsgs * rate),
    cost_per_month: round2(onMsgs * rate * COST_MONTH_DAYS),
    potential_messages_per_day: allMsgs,
    potential_cost_per_month: round2(allMsgs * rate * COST_MONTH_DAYS),
  };
}
