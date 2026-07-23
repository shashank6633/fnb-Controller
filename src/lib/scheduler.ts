/**
 * In-process background scheduler. Boots when this module is first imported
 * (which happens on the first API request thanks to Next's lazy route bundling).
 *
 * Guards against double-start via globalThis so HMR / multi-route imports
 * don't spawn parallel intervals.
 *
 * Currently runs:
 *   - refreshUpcomingParties() every POLL_MINUTES minutes
 *
 * Production-only by default. Set ENABLE_SCHEDULER=1 to force in dev for
 * local testing.
 */

import { refreshUpcomingParties, refreshPartyBookings } from './party-refresh';
import { checkDeferDueSoon } from './defer-due-check';
import { checkKitchenExpiry } from './kitchen-expiry-check';

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
      const res = await refreshUpcomingParties('cron');
      globalThis.__fnbScheduler__!.lastRun = Date.now();
      globalThis.__fnbScheduler__!.lastResult = res;
      console.log(`[scheduler] refresh @ IST ${istHour()}h: ${res.fetched_parties} parties · ${res.status_changes} status changes · ${res.notifications_created} notifications · ${res.slack_sent} slack sent`);

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
