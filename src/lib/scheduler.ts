/**
 * In-process background scheduler. ARMED AT SERVER BOOT, from register() in
 * src/instrumentation.ts. It used to arm only when this module was first imported
 * — which happened on the first AUTHENTICATED request to /api/upcoming-parties or
 * /api/crm-calls/broadcasts — so a quiet restart silently stopped every job below
 * until somebody happened to open one of those pages. The route-level calls are
 * still there and still harmless; globalThis makes arming idempotent.
 *
 * Guards against double-start via globalThis so HMR / multi-route imports
 * don't spawn parallel intervals. That guard is PER PROCESS: N pm2 workers get N
 * ticks, which was already true before boot-arming, so every job below carries
 * its own cross-process claim (an expiring SQLite transaction, a per-row
 * compare-and-swap, or a once-per-IST-day sentinel).
 *
 * Every tick, in this order. EVERY ONE of them is wrapped in its own try —
 * including the parties refresh, which until recently was the single unguarded
 * statement here and skipped the nine jobs behind it whenever Sheets failed:
 *   - runReviewAutoRefresh()       — the Google Reviews pull; THIS is its driver
 *   - runWaDailyNotifications()    — low-stock summary + owner digest, once a day
 *   - runTaskAutomation()          — recurring + maintenance task generation,
 *                                    overdue sweep + escalation, once per IST day
 *   - refreshUpcomingParties() + refreshPartyBookings()
 *   - checkDeferDueSoon()          — deferred requisition items coming due
 *   - sweepRecordingRetention()    — call recordings past the admin's window
 *   - sweepStaleTables()           — EMPTY idle open orders (never ones with items)
 *   - checkKitchenExpiry()         — production batches at/near expiry
 *   - runWaReportJobs()            — scheduled WhatsApp reports, each at its own
 *                                    IST time, once per day per outlet
 *
 * runWaDailyNotifications and runTaskAutomation are here because they had NO
 * DRIVER AT ALL: their only call site was POST /api/cron/refresh-parties, which
 * an external caller cannot reach (absent from proxy.ts's isPublic(), so the
 * proxy 401s a token-only POST before the route's x-cron-token check runs).
 *
 * Production-only by default. Set ENABLE_SCHEDULER=1 to force in dev for
 * local testing.
 */

import { refreshUpcomingParties, refreshPartyBookings } from './party-refresh';
import { checkDeferDueSoon } from './defer-due-check';
import { checkKitchenExpiry } from './kitchen-expiry-check';
import { sweepRecordingRetention } from './ct/retention';
import { sweepStaleTables } from './stale-tables';

/**
 * Adaptive cadence:
 *   - Business hours (08:00 – 22:59 IST): refresh every 5 minutes (kitchens
 *     + sales are actively interacting; fast feedback loop matters)
 *   - Off-hours (23:00 – 07:59 IST): refresh every 30 minutes (sheet rarely
 *     changes overnight; conserves Sheets API quota)
 *
 * Worst-case daily reads: 12 reads/hr × 16 business hours + 2 reads/hr × 8
 * off-hours = ~208 reads/day. Well within Sheets API quotas (60 reads/min
 * per user, 300/min per project).
 */
const BUSINESS_START_IST = 8;   // 8 AM IST
const BUSINESS_END_IST   = 23;  // up to (and including) 22:59 IST
const POLL_BUSINESS_MIN  = 5;
const POLL_OFFHOURS_MIN  = 30;

declare global {
  // eslint-disable-next-line no-var
  var __fnbScheduler__: {
    started: boolean;
    lastRun?: number;
    lastResult?: any;
    nextDelayMin?: number;
  } | undefined;
}

/** Get current hour in IST (0-23), regardless of server timezone. */
function istHour(): number {
  const s = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
  }).format(new Date());
  // Some locales emit "24" instead of "00" at midnight — normalize.
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h;
}

function nextDelayMinutes(): number {
  const h = istHour();
  return (h >= BUSINESS_START_IST && h < BUSINESS_END_IST)
    ? POLL_BUSINESS_MIN
    : POLL_OFFHOURS_MIN;
}

export function startSchedulerOnce(): void {
  if (process.env.NODE_ENV !== 'production' && process.env.ENABLE_SCHEDULER !== '1') return;
  if (globalThis.__fnbScheduler__?.started) return;
  globalThis.__fnbScheduler__ = { started: true };

  const tick = async () => {
    try {
      // GOOGLE REVIEWS — the automatic pull. THIS IS THE DRIVER; without it
      // there is none, and src/lib/reviews/refresh.ts says so in its own header
      // ("NOTHING DRIVES THIS YET"). The external-cron alternative needs the
      // refresh endpoint carved out of the proxy's protected prefixes, which is
      // a change to a shared security file — so the in-process hook is the one
      // that costs nothing to be wrong about.
      //
      // SAFE ON EVERY TICK. runReviewAutoRefresh decides for itself whether a
      // pull is owed and returns 'not_due' in microseconds when it is not, so
      // the 5-minute cadence costs a settings read. It also stamps a heartbeat
      // FIRST and unconditionally, which is what lets the Reviews page show an
      // automatic badge on evidence that a driver is alive rather than on the
      // mere fact that a schedule was configured.
      //
      // IT NEVER THROWS by its own contract, and it takes an advisory lock so
      // this tick and a future external cron cannot pull the same page twice
      // against a quota Google does not publish a number for. The try/catch and
      // the dynamic import are still here because every neighbour has them: a
      // fault in the reviews module must not take the rest of the tick with it.
      try {
        const { runReviewAutoRefresh } = await import('./reviews/refresh');
        const { getDb } = await import('./db');
        const rev = await runReviewAutoRefresh({ db: getDb() });
        // 'not_due' is the overwhelmingly common answer and says nothing worth
        // a log line every five minutes. Everything else is worth seeing.
        if (rev.outcome !== 'not_due') {
          const counts = [
            rev.inserted ? `${rev.inserted} new` : '',
            rev.updated ? `${rev.updated} updated` : '',
          ].filter(Boolean).join(', ');
          console.log(`[scheduler] reviews: ${rev.outcome}${counts ? ` (${counts})` : ''} — ${rev.detail}`);
        }
      } catch (e) {
        console.error('[scheduler] reviews refresh failed:', e instanceof Error ? e.message : e);
      }

      // WHATSAPP DAILY JOBS (low-stock summary + owner digest) and TASK
      // MANAGEMENT AUTOMATION (recurring + maintenance generation, overdue sweep
      // + escalation).
      //
      // THESE TWO HAD NO DRIVER AT ALL, which is why they are here. Each had
      // exactly ONE call site in the whole of src — POST
      // /api/cron/refresh-parties — and that route cannot be reached by an
      // external caller: it is absent from proxy.ts's isPublic(), so proxy.ts
      // answers a token-only POST with 401 "Sign in required" before the route's
      // own x-cron-token check can run. Nothing else called them, so they simply
      // never ran. MEASURED on the live database: `settings` has NO
      // tm_automation_last_run row (the job has never completed a run), and all
      // 21 active maintenance_schedules still read last_generated_date =
      // 2026-07-15 — 67 days of daily, weekly and monthly checks never
      // generated.
      //
      // ABOVE refreshUpcomingParties, like every other job here, and for the
      // reason the route below states in its own words: a Sheets failure must
      // never starve the daily pings.
      //
      // SAFE ON EVERY TICK AND SAFE TWICE OVER. Both are idempotent per IST day
      // — runWaDailyNotifications dedupes against whatsapp_events_log and
      // runTaskAutomation short-circuits on last_run_date == today — so the
      // route keeping its own copies, and N pm2 workers each running a tick,
      // cannot produce a second send or a second generated task.
      // NOTE ON THE FILTER: runWaDailyNotifications returns
      // Record<string, string> — the VALUES ARE STATUS STRINGS, not objects. Its
      // neighbours on this tick return {status} objects, so reading r.status here
      // would be undefined for every key and log "3 jobs acted" on every single
      // tick forever.
      try {
        const { runWaDailyNotifications } = await import('./whatsapp');
        const rep = await runWaDailyNotifications();
        const acted = Object.entries(rep)
          .filter(([, status]) => !['skipped', 'disabled', 'already_sent_today'].includes(status));
        if (acted.length) {
          console.log(`[scheduler] wa-daily @ IST ${istHour()}h: `
            + acted.map(([job, status]) => `${job}=${status}`).join(' · '));
        }
      } catch (e) {
        console.error('[scheduler] wa daily notifications failed:', e instanceof Error ? e.message : e);
      }

      try {
        const { runTaskAutomation } = await import('./task-automation');
        const { getDb } = await import('./db');
        const ta: any = runTaskAutomation(getDb());
        if (ta && ta.ran) console.log(`[scheduler] task-automation @ IST ${istHour()}h: ran for ${ta.date}`);
      } catch (e) {
        console.error('[scheduler] task automation failed:', e instanceof Error ? e.message : e);
      }

      // GUARDED — AND THAT IS THE ENTIRE POINT OF THIS try.
      //
      // Until it existed, the call below was the tick's ONLY unguarded
      // statement, so when the Google Sheets credential fails the throw jumped
      // straight to the outer catch and SKIPPED THE NINE JOBS BEHIND IT: party
      // bookings, defer-due warnings, GRN kitchen-QC escalation, the WhatsApp
      // broadcast drain, scheduled reports and price-hike alerts among them.
      // MEASURED: a deferred requisition item due in 2h produced ZERO
      // notifications on a box whose scheduler was armed and ticking normally.
      // Every other job in this tick already carried its own try; this is the
      // one that never did.
      //
      // lastRun is stamped on BOTH paths, so a failing Sheets call can no longer
      // make the tick look like it never happened.
      try {
        const res = await refreshUpcomingParties('cron');
        globalThis.__fnbScheduler__!.lastRun = Date.now();
        globalThis.__fnbScheduler__!.lastResult = res;
        console.log(`[scheduler] refresh @ IST ${istHour()}h: ${res.fetched_parties} parties · ${res.status_changes} status changes · ${res.notifications_created} notifications · ${res.slack_sent} slack sent`);
      } catch (e: any) {
        console.error('[scheduler] parties refresh failed:', e?.message);
        globalThis.__fnbScheduler__!.lastRun = Date.now();
        globalThis.__fnbScheduler__!.lastResult = { error: e?.message };
      }

      // Party Bookings tab → feeds the GRE "What's On" board. Best-effort on the
      // same cadence; a failure here must NEVER break the F&P refresh loop.
      try {
        const pb = await refreshPartyBookings();
        console.log(`[scheduler] party-bookings @ IST ${istHour()}h: ${pb.fetched} bookings cached`);
      } catch (e: any) {
        console.error('[scheduler] party-bookings refresh failed:', e?.message);
      }

      // Feature 4 — warn store managers about deferred requisition items coming
      // due within ~4h. Runs on the same cadence as the party refresh. Fully
      // best-effort: any failure here is logged and swallowed so it can NEVER
      // break the refresh loop.
      try {
        const dd = await checkDeferDueSoon('cron');
        if (dd.candidates > 0 || dd.notifications_created > 0) {
          console.log(`[scheduler] defer-due @ IST ${istHour()}h: ${dd.candidates} due-soon · ${dd.notifications_created} notifications · ${dd.slack_sent} slack sent`);
        }
        if (dd.errors.length) console.warn('[scheduler] defer-due errors:', dd.errors);
      } catch (e: any) {
        console.error('[scheduler] defer-due check failed:', e?.message);
      }

      // GRN kitchen QC — escalate deliveries that have sat unchecked past the
      // admin's window (settings.qc_escalation_hours, default 4h). Same cadence,
      // same best-effort contract as everything else in this tick.
      //
      // THIS IS WHAT MAKES ESCALATION A POLICY RATHER THAN A PAGE, exactly as
      // with recording retention below. Its only trigger was the QC queue page
      // poking POST /api/grn/qc/escalate on load — which fires when somebody
      // opens the queue, i.e. precisely when escalation is LEAST needed, and
      // never on the morning nobody opens it, which is the morning a crate of
      // fish has been sitting unchecked since 06:00. The sweep is idempotent by
      // construction (it claims each row through qc_escalated_at before it
      // sends), so running it here and from the page cannot double-send.
      // Dynamically imported so a QC schema fault can never break the loop.
      try {
        const { escalateOverdueQc } = await import('./grn-qc-notify');
        const { getDb } = await import('./db');
        const qe = await escalateOverdueQc(getDb(), {});
        if (qe.escalated > 0) {
          console.log(`[scheduler] grn-qc @ IST ${istHour()}h: ${qe.escalated} held delivery(s) escalated`);
        }
      } catch (e) {
        console.error('[scheduler] grn-qc escalation failed:', e instanceof Error ? e.message : e);
      }

      // Recording retention — expire recordings past the admin's window
      // (7/15/30 days, default 30). Same cadence, same best-effort contract.
      //
      // THIS IS THE ONLY THING THAT MAKES RETENTION A POLICY RATHER THAN A
      // SETTING. The sweeper otherwise fires only when somebody plays a
      // recording or an admin opens the Telephony console — so on a quiet week
      // nothing expires, which is precisely the week an untouched recording
      // should have aged out. The refusal path is already time-based and needs
      // no job; this is for the deletes, and for the watermark an admin reads.
      // DRAIN, don't single-shot. A pass stops at its batch cap and reports
      // `more` — a field nothing read before, so a backlog (a shortened window,
      // or a first run over old data) was left stranded until someone happened
      // to open the console. Bounded so a huge backlog cannot monopolise a tick.
      try {
        let expired = 0, files = 0, passes = 0;
        for (; passes < 20; passes++) {
          const rr = sweepRecordingRetention();
          expired += rr.expired; files += rr.filesDeleted;
          if (!rr.more) break;
        }
        if (expired > 0 || files > 0) {
          console.log(`[scheduler] recording-retention @ IST ${istHour()}h: ${expired} past window · ${files} files deleted · ${passes + 1} pass(es)`);
        }
      } catch (e: any) {
        console.error('[scheduler] recording-retention sweep failed:', e?.message);
      }

      // Idle tables — close open orders that are EMPTY (zero order_items) and
      // have sat past the admin's window, so an abandoned table frees itself on
      // the cashier floor. OFF until the owner sets
      // settings['stale_table_auto_close_hours'], and structurally incapable of
      // closing an order that has items — the guard is in the UPDATE itself
      // (src/lib/stale-tables.ts). A timer must never decide the fate of a
      // table with money on it; those are only ever FLAGGED for a human.
      //
      // THE JOB IS WHAT MAKES THIS A POLICY RATHER THAN A SETTING, exactly as
      // with recording retention above: the same sweep can ride along on a
      // screen that lists idle tables, but on a quiet day nobody opens that
      // screen — and a quiet day is precisely when yesterday's ghost table
      // should age out. Best-effort by contract (sweepStaleTables swallows its
      // own errors), and wrapped anyway so it can NEVER break the refresh loop.
      try {
        const st = sweepStaleTables({ throttleMs: 0 });
        if (st.closed > 0) {
          console.log(`[scheduler] idle-tables @ IST ${istHour()}h: ${st.closed} empty order(s) closed after ${st.window_hours}h idle${st.freed_tables.length ? ' · tables freed: ' + st.freed_tables.join(', ') : ''}`);
        }
        if (st.skipped === 'error') console.warn('[scheduler] idle-tables sweep reported an error (see above)');
      } catch (e: any) {
        console.error('[scheduler] idle-tables sweep failed:', e?.message);
      }

      // Kitchen Production — auto-expire past-expiry batches and warn the
      // kitchen about batches nearing expiry. Same cadence as the party refresh.
      // Fully best-effort: any failure is logged and swallowed so it can NEVER
      // break the refresh loop or the defer-due check above.
      try {
        const ke = await checkKitchenExpiry('cron');
        if (ke.expired > 0 || ke.notifications_created > 0) {
          console.log(`[scheduler] kitchen-expiry @ IST ${istHour()}h: ${ke.expired} expired · ${ke.alert_candidates} near-expiry · ${ke.notifications_created} notifications · ${ke.slack_sent} slack sent`);
        }
        if (ke.errors.length) console.warn('[scheduler] kitchen-expiry errors:', ke.errors);
      } catch (e: any) {
        console.error('[scheduler] kitchen-expiry check failed:', e?.message);
      }

      // WhatsApp broadcast queue — one budgeted drain per tick. The drain is
      // its own quadruple gate (broadcast_enabled flag, campaign explicitly in
      // 'sending', provider configured, per-recipient consent/cooldown/cap),
      // so on a database that has never heard of broadcasts this is a no-op
      // SELECT. Dynamically imported (grn-qc pattern) so a campaign-schema
      // fault can never break the tick. Same drain also rides
      // POST /api/cron/refresh-parties as the external backstop.
      try {
        const { drainBroadcasts } = await import('./wa-broadcast');
        const { getDb } = await import('./db');
        const bd = await drainBroadcasts(getDb());
        if (bd.attempted > 0 || bd.skipped_optout > 0 || bd.skipped_cooldown > 0) {
          console.log(`[scheduler] broadcasts @ IST ${istHour()}h: ${bd.sent} sent · ${bd.failed} failed · ${bd.skipped_optout} opted-out · ${bd.skipped_cooldown} cooldown${bd.cap_hit ? ' · DAILY CAP' : ''}`);
        }
      } catch (e: any) {
        console.error('[scheduler] broadcast drain failed:', e?.message);
      }

      // WhatsApp SCHEDULED REPORTS — the daily ops / stock differences / CRM
      // overview PDFs, each at its own configured IST time.
      //
      // THIS IS WHAT MAKES A REPORT A SCHEDULE RATHER THAN A SETTING, the same
      // argument as recording retention and idle tables above: until now these
      // only ran when POST /api/cron/refresh-parties was called, so an install
      // with no external cron had a fully configured 08:00 report that never
      // arrived. The tick is the schedule; the cron POST stays as the external
      // backstop for a box nobody has opened a page on.
      //
      // Sending twice is IMPOSSIBLE, not merely unlikely: runWaReportJobs
      // claims each report's slot with one atomic upsert against the partial
      // unique index on wa_report_runs, so this tick and a simultaneous cron
      // POST cannot both win. Cadence is 5 min in business hours, so a report
      // fires at or shortly after its configured time — never before it.
      // Dynamically imported (grn-qc pattern) so a report-schema fault can
      // never break the loop.
      try {
        const { runWaReportJobs } = await import('./wa-report-jobs');
        const { getDb } = await import('./db');
        const rep = await runWaReportJobs(getDb());
        const acted = Object.values(rep).filter(r => !['disabled', 'not_due', 'already_sent_today'].includes(r.status));
        if (acted.length) {
          console.log(`[scheduler] wa-reports @ IST ${istHour()}h: `
            + acted.map(r => `${r.key}=${r.status}${r.sent ? ` (${r.sent} sent)` : ''}`).join(' · '));
        }
      } catch (e) {
        console.error('[scheduler] whatsapp report jobs failed:', e instanceof Error ? e.message : e);
      }

      // PRICE-HIKE ALERTS, ONE PER BILL. A purchase line only QUEUES its bill
      // (POST /api/purchases writes one line per request, so firing there sent
      // one alert per line — every recipient, several times, about one bill).
      // This flush sends for bills that have been quiet for the debounce
      // window, covering every line on them. Separately try/caught so it can
      // neither be starved by, nor starve, the scheduled reports above.
      try {
        const { flushPriceHikeAlerts } = await import('./wa-report-events');
        const { getDb } = await import('./db');
        const fired = await flushPriceHikeAlerts(getDb());
        const acted = fired.filter(r => !['nothing_to_report', 'disabled', 'already_sent'].includes(r.status));
        if (acted.length) {
          console.log(`[scheduler] price-hike alerts: `
            + acted.map(r => `${r.status}${r.sent ? ` (${r.sent} sent)` : ''}`).join(' · '));
        }
      } catch (e) {
        console.error('[scheduler] price-hike alert flush failed:', e instanceof Error ? e.message : e);
      }
    } catch (e: any) {
      console.error('[scheduler] refresh failed:', e?.message);
      globalThis.__fnbScheduler__!.lastResult = { error: e?.message };
    } finally {
      // Self-reschedule with current-window cadence. Picking the delay AT TICK
      // TIME means cadence transitions (8 AM start of business, 11 PM end)
      // take effect on the very next tick — no separate hourly check needed.
      const nextMin = nextDelayMinutes();
      globalThis.__fnbScheduler__!.nextDelayMin = nextMin;
      setTimeout(tick, nextMin * 60_000);
    }
  };

  // First tick after 30s so the server can warm up
  const firstDelay = 30_000;
  globalThis.__fnbScheduler__!.nextDelayMin = nextDelayMinutes();
  setTimeout(tick, firstDelay);
  console.log(`[scheduler] started — adaptive cadence: ${POLL_BUSINESS_MIN} min business hours (${BUSINESS_START_IST}:00–${BUSINESS_END_IST}:00 IST), ${POLL_OFFHOURS_MIN} min off-hours. First tick in 30s.`);
}

export function getSchedulerStatus() {
  return {
    ...(globalThis.__fnbScheduler__ || { started: false }),
    current_window: nextDelayMinutes() === POLL_BUSINESS_MIN ? 'business_hours' : 'off_hours',
    current_ist_hour: istHour(),
    cadence_minutes: nextDelayMinutes(),
  };
}
