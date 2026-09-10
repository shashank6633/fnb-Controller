/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  reportConfig, reportAudience, lastRun, recentRuns, outletsFor,
  parseHhMm, istNow, skipTodaysSlot, DEFAULT_REPORT_TIME, scheduledReportKeys,
} from '@/lib/wa-report-jobs';
import { WA_REPORT_DEFS } from '@/lib/wa-report-builders';
import { audienceOptions, MAX_REPORT_RECIPIENTS } from '@/lib/wa-report-recipients';
import { alertDailyCap, alertMessagesSentToday, MAX_ALERT_DAILY_CAP } from '@/lib/wa-report-events';
// WHAT IT COSTS, on the page that switches it on. See wa-report-cost.ts.
import { estimateReportCosts } from '@/lib/wa-report-cost';

/**
 * GET  /api/crm-calls/reports/config — every report, its settings, its resolved
 *                                      recipients and its last run.
 * PUT  /api/crm-calls/reports/config — save ONE report's settings.
 *
 * ── WHY THIS IS NOT ON THE WHATSAPP SETTINGS PAGE ────────────────────────
 * That page owns the PROVIDER (credentials, the master switch, the
 * Notifications tab). This owns the REPORTS. They are deliberately separate
 * surfaces writing deliberately separate settings keys, because the
 * Notifications tab rebuilds `wa_notify_recipients` wholesale on every save —
 * the documented way a recipient list has silently vanished here before. A
 * report's recipients live under wa_report_<key>_* and nothing on that tab can
 * reach them.
 *
 * ── WHO MAY DO WHAT ──────────────────────────────────────────────────────
 * READ  — isManagement (admin | manager | HOD), the tier that already gates
 *         Sales Reports and the report-file download. This page shows what the
 *         daily P&L is and who receives it.
 * WRITE — admin ONLY. Changing who receives the takings, or when, is not a
 *         management-tier decision: it redirects the restaurant's financials to
 *         a phone number. A manager sees the page and reads it; the save button
 *         is refused here, not merely hidden in the UI.
 *
 * ── THE ALLOWLIST IS EXHAUSTIVE ──────────────────────────────────────────
 * Only the keys below may be written, and only for a key in WA_REPORT_DEFS. A
 * settings route that accepts an arbitrary key is a settings route that can be
 * asked to write `wa_access_token`.
 */
export const dynamic = 'force-dynamic';

const FIELDS = ['enabled', 'recipients', 'audience', 'template', 'lang', 'offset_days', 'time', 'outlets', 'daily_cap'] as const;
type Field = (typeof FIELDS)[number];

function outletList(db: any): Array<{ id: string; name: string; is_default: number }> {
  try {
    return db.prepare('SELECT id, name, is_default FROM outlets ORDER BY is_default DESC, name').all() as any[];
  } catch { return []; }
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Scheduled reports are limited to admins, managers and heads of department.' }, { status: 403 });
  }

  const db = getDb();
  const scheduled = new Set(scheduledReportKeys());
  const now = istNow();

  const reports = WA_REPORT_DEFS.map(def => {
    const cfg = reportConfig(db, def.key);
    const isScheduled = scheduled.has(def.key);
    // A guest-facing alert is addressed by the EVENT (the booking's guest), so
    // resolving a staff audience for it would show a list nobody will receive.
    const resolved = def.audience === 'guest' ? null : reportAudience(db, cfg);
    const run = lastRun(db, def.key);

    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      audience_kind: def.audience,
      attachment: def.attachment,
      template_category: def.templateCategory,
      param_order: def.paramOrder,
      unimplemented: !!def.unimplemented,
      unimplemented_reason: def.unimplementedReason || '',
      scheduled: isScheduled,
      config: {
        enabled: cfg.enabled,
        recipients: cfg.recipients,
        audience: cfg.audience,
        template: cfg.template,
        lang: cfg.lang,
        offset_days: cfg.offsetDays,
        time: cfg.time,
        outlets: cfg.outlets,
        // The enforced per-day message cap for an event alert. Meaningless for
        // a scheduled report (once a day is already the cap) and for a guest
        // confirmation (never capped) — the page hides it in both cases.
        daily_cap: alertDailyCap(db, def.key),
      },
      /** Messages this alert has already had billed today (IST). */
      sent_today: def.audience === 'guest' ? 0 : alertMessagesSentToday(db, def.key),
      resolved: resolved && {
        recipients: resolved.recipients,
        unreachable: resolved.unreachable,
        empty_tokens: resolved.emptyTokens,
        capped: resolved.capped,
        count: resolved.recipients.length,
      },
      runs_for_outlets: isScheduled ? outletsFor(db, cfg) : [],
      last_run: run || null,
      history: recentRuns(db, def.key, 5),
      next_due: isScheduled && cfg.enabled
        ? (now.minutes < cfg.timeMinutes ? `today ${cfg.time} IST` : `tomorrow ${cfg.time} IST`)
        : '',
    };
  });

  return Response.json({
    reports,
    outlets: outletList(db),
    audience_options: audienceOptions(db),
    // WHAT IT COSTS. Standing, recurring, billable Meta traffic must show its
    // bill on the screen that arms it — the broadcast page has done so since it
    // shipped, and this rail is no different.
    cost: estimateReportCosts(db),
    max_recipients: MAX_REPORT_RECIPIENTS,
    max_daily_cap: MAX_ALERT_DAILY_CAP,
    default_time: DEFAULT_REPORT_TIME,
    ist_now: `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`,
    ist_date: now.date,
    can_edit: me.role === 'admin',
  });
}

export async function PUT(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') {
    return Response.json({
      error: 'Only an admin may change who receives a report, or when. Managers and HODs can read this page and send themselves a test.',
    }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as any;
  const key = String(body?.key || '').trim();
  const def = WA_REPORT_DEFS.find(d => d.key === key);
  if (!def) return Response.json({ error: `"${key}" is not a report this app knows about.` }, { status: 400 });
  if (def.unimplemented) {
    return Response.json({ error: def.unimplementedReason || 'That report is not built.' }, { status: 400 });
  }

  const incoming = body?.config;
  if (!incoming || typeof incoming !== 'object') {
    return Response.json({ error: 'Expected { key, config: { … } }' }, { status: 400 });
  }

  const db = getDb();
  const writes: Array<[string, string]> = [];

  for (const [field, raw] of Object.entries(incoming)) {
    if (!(FIELDS as readonly string[]).includes(field)) {
      return Response.json({ error: `“${field}” is not a setting this page may write.` }, { status: 400 });
    }
    const f = field as Field;

    if (f === 'enabled') {
      writes.push([`wa_report_${key}_enabled`, raw === true || raw === '1' ? '1' : '0']);
    } else if (f === 'time') {
      const v = String(raw ?? '').trim();
      if (parseHhMm(v) == null) {
        return Response.json({ error: 'Send time must be a 24-hour time of day, like 08:00.' }, { status: 400 });
      }
      writes.push([`wa_report_${key}_time`, v]);
    } else if (f === 'offset_days') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 30) {
        return Response.json({ error: 'Report day offset must be between 0 (today) and 30.' }, { status: 400 });
      }
      writes.push([`wa_report_${key}_offset_days`, String(Math.floor(n))]);
    } else if (f === 'recipients') {
      // Manual numbers. Validated to digits here so a typo shows up on save
      // rather than as a silent non-delivery at 08:00 tomorrow.
      const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map(v => String(v ?? '').trim()).filter(Boolean);
      for (const n of list) {
        const digits = n.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) {
          return Response.json({ error: `“${n}” is not a phone number — 10 to 15 digits, with or without the country code.` }, { status: 400 });
        }
      }
      if (list.length > 10) return Response.json({ error: 'At most 10 manually typed numbers per report.' }, { status: 400 });
      writes.push([`wa_report_${key}_recipients`, list.join(',')]);
    } else if (f === 'audience') {
      const list = (Array.isArray(raw) ? raw : []).map(v => String(v ?? '').trim()).filter(Boolean);
      for (const t of list) {
        if (t !== 'mgmt' && t !== 'admin' && !t.startsWith('hod:') && !t.startsWith('user:')) {
          return Response.json({ error: `“${t}” is not a recipient group.` }, { status: 400 });
        }
      }
      if (list.length > 30) return Response.json({ error: 'Too many recipient groups.' }, { status: 400 });
      writes.push([`wa_report_${key}_audience`, JSON.stringify(list)]);
    } else if (f === 'outlets') {
      const known = new Set(outletList(db).map(o => String(o.id)));
      const list = (Array.isArray(raw) ? raw : []).map(v => String(v ?? '').trim()).filter(Boolean);
      for (const o of list) {
        if (!known.has(o)) return Response.json({ error: 'One of the chosen outlets no longer exists.' }, { status: 400 });
      }
      writes.push([`wa_report_${key}_outlets`, JSON.stringify(list)]);
    } else if (f === 'template') {
      const v = String(raw ?? '').trim().slice(0, 200);
      // Meta template names are lowercase letters, digits and underscores. A
      // name that cannot exist at Meta is refused now rather than at 08:00.
      if (v && !/^[a-z0-9_]+$/.test(v)) {
        return Response.json({ error: 'A Meta template name is lowercase letters, digits and underscores only.' }, { status: 400 });
      }
      writes.push([`wa_report_${key}_template`, v]);
    } else if (f === 'daily_cap') {
      // The per-day MESSAGE cap for an event alert. It can be raised or
      // lowered; it cannot be switched off. A 0 or a blank is stored as 0 and
      // read back as the default (wa-report-events.ts), because "unlimited" is
      // the state the cap exists to end — one day of grocery entry once meant
      // hundreds of billable messages.
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > MAX_ALERT_DAILY_CAP) {
        return Response.json({
          error: `The daily message cap must be between 1 and ${MAX_ALERT_DAILY_CAP}. (0 leaves it at the default — it does not remove the cap.)`,
        }, { status: 400 });
      }
      writes.push([`wa_report_${key}_daily_cap`, String(Math.floor(n))]);
    } else if (f === 'lang') {
      const v = String(raw ?? '').trim().slice(0, 20) || 'en';
      if (!/^[A-Za-z]{2}(_[A-Za-z]{2})?$/.test(v)) {
        return Response.json({ error: 'Language must look like "en" or "en_US".' }, { status: 400 });
      }
      writes.push([`wa_report_${key}_lang`, v]);
    }
  }

  if (!writes.length) return Response.json({ error: 'Nothing to save.' }, { status: 400 });

  const save = db.transaction(() => {
    const stmt = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of writes) stmt.run(k, v);
  });
  save();

  // ── DO NOT FIRE THE MOMENT IT IS SWITCHED ON ────────────────────────────
  // Enabling the 08:00 report at 16:00 would otherwise send it at 16:01, while
  // the admin is still filling in the template name. Today's slot is marked
  // skipped so the first real send is tomorrow at the configured time — and
  // the response says so. A server that was merely DOWN at 08:00 is unaffected:
  // nothing wrote a row for that slot, so it still catches up.
  const cfg = reportConfig(db, key);
  const now = istNow();
  let first_send = '';
  if (cfg.enabled && scheduledReportKeys().includes(key)) {
    if (now.minutes >= cfg.timeMinutes) {
      for (const outletId of outletsFor(db, cfg)) {
        skipTodaysSlot(db, {
          key, outletId: String(outletId || ''), runDate: now.date,
          detail: `Enabled at ${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')} IST, after today's ${cfg.time} send time — first send is tomorrow.`,
        });
      }
      first_send = `tomorrow ${cfg.time} IST`;
    } else {
      first_send = `today ${cfg.time} IST`;
    }
  }

  const resolved = def.audience === 'guest' ? null : reportAudience(db, cfg);
  return Response.json({
    ok: true,
    key,
    config: {
      enabled: cfg.enabled, recipients: cfg.recipients, audience: cfg.audience,
      template: cfg.template, lang: cfg.lang, offset_days: cfg.offsetDays,
      time: cfg.time, outlets: cfg.outlets, daily_cap: alertDailyCap(db, key),
    },
    // The saved figure, recomputed — so the page's cost panel updates on save
    // rather than on the next full refresh.
    cost: estimateReportCosts(db),
    resolved: resolved && {
      recipients: resolved.recipients, unreachable: resolved.unreachable,
      empty_tokens: resolved.emptyTokens, capped: resolved.capped,
      count: resolved.recipients.length,
    },
    first_send,
  });
}
