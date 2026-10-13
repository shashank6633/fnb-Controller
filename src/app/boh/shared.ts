/**
 * Shared shapes and formatting for the BOH record screen.
 *
 * Kept in one leaf file so the page and its action dialogs cannot drift on what
 * a rupee looks like, what a date looks like, or what the seven outcomes are
 * called. The outcome TOKENS here are the same tokens src/lib/boh-schema.ts
 * stores (BOH_OUTCOMES); the labels are the owner's words for them, and only
 * the labels are ever shown.
 */

export interface Boh {
  id: string; order_id: string; bill_number: string; bill_date: string; held_at: string;
  table_label: string; customer_name: string; customer_mobile: string; customer_company: string;
  contact_source: string; reason: string; remarks: string; department_name: string;
  responsible_user_id: string; responsible_name: string; responsible_email: string;
  expected_payment_date: string; principal_amount: number; status: string;
  close_kind: string; close_remarks: string; closed_at: string; closed_by: string;
  void_reason: string; voided_at: string; voided_by: string;
  created_by: string; created_at: string;
  paid_amount: number; balance_amount: number; days_pending: number;
  followup_state: string; order_status: string; reconcile_needed: boolean;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: unknown) => '₹' + inr.format(Number(n) || 0);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * '2026-09-18' → '18 Sep 2026'. The owner reads dates, not ISO strings.
 *
 * FOR A DATE COLUMN ONLY — bill_date, expected_payment_date, paid_on, due_date,
 * answered_expected_date. Every one of those is written by the server as
 * date('now','+5 hours','+30 minutes'), i.e. it is ALREADY an IST calendar
 * date, so it must be printed exactly as stored and never shifted.
 * For a DATETIME column (created_at, held_at, closed_at, changed_at) use
 * stampDate() instead — those are UTC and slicing the first ten characters off
 * one gives the wrong day for anything after 18:30 UTC.
 */
export function niceDate(d: unknown): string {
  const s = String(d || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  const [y, m, day] = s.split('-');
  // AN IMPOSSIBLE DATE IS BLANK, NOT HALF-PRINTED. The shape test alone passes
  // '2026-13-45', which used to render as "45 ? 2026" — measured, and it is
  // also what stamp()/stampDate() fall back to when istParts() refuses a
  // corrupt datetime. On a permanent record a legible-looking nonsense date is
  // worse than an obvious blank, which is the same reasoning istParts() applies
  // one screen down. Nothing SQLite's date('now') writes can fail this.
  //
  // ── THE RANGE TEST WAS NOT THE TEST THIS COMMENT PROMISED ────────────────
  // month 1-12 plus day 1-31 catches '2026-13-45' and nothing subtler, so
  // '2026-11-31' — November has thirty days — rendered as "31 Nov 2026": a
  // date that does not exist, printed legibly, on a permanent record about
  // money. MEASURED end-to-end on a booted server, not reasoned about:
  //   POST /api/boh/<id>/follow-up {"outcome":"more_time",
  //        "next_expected_date":"2026-11-31"}            -> HTTP 200
  //   boh_bills.expected_payment_date                     -> '2026-11-31'
  //   niceDate('2026-11-31')                              -> '31 Nov 2026'
  // It gets in because the write path's validator (isDate in src/lib/boh.ts)
  // is the same SHAPE regex as line 42 above, and the follow-up route's only
  // other date test is "not in the past", which '2026-11-31' passes.
  //
  // So the guard now does what the paragraph above says it does: a calendar
  // ROUND TRIP. Build the day in UTC and demand the calendar hand back the
  // same month and day — the one check that cannot be fooled by a month
  // length or a leap year, and the arithmetic is identical to the UTC-only
  // arithmetic istParts() uses next door. Every real date is untouched.
  //
  // THIS IS THE DISPLAY HALF ONLY. Rendering '—' stops the screen from
  // asserting a day that does not exist; it does not stop the value being
  // stored, and the row still carries '2026-11-31' underneath. The other half
  // is a calendar check in isDate() (src/lib/boh.ts:92), which would refuse it
  // at the door — that file is outside this lane and is reported, not edited.
  const Y = Number(y), M = Number(m), D = Number(day);
  if (M < 1 || M > 12 || D < 1 || D > 31) return '—';
  const probe = new Date(Date.UTC(Y, M - 1, D));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== M - 1 || probe.getUTCDate() !== D) return '—';
  return `${D} ${MON[M - 1] || '?'} ${y}`;
}

/**
 * ── EVERY STORED DATETIME IN THIS MODULE IS UTC ────────────────────────────
 *
 * boh_bills.held_at / created_at / closed_at / voided_at, boh_assignments
 * .changed_at, boh_followups.created_at, boh_payments.created_at,
 * boh_reminders.claimed_at / finished_at, audit_events.created_at and
 * orders.held_at / created_at are ALL written by SQLite's datetime('now'),
 * which is UTC — never local time. Printing those digits as they stand renders
 * every event 5 hours 30 minutes early: measured, a bill held at 21:46:47 IST
 * stored '2026-09-18 16:16:47' and the timeline read '18 Sep · 4:16 pm'.
 * Between midnight and 05:30 IST it also showed the wrong DAY.
 *
 * So the display layer converts, and it converts by FIXED OFFSET rather than
 * by the viewer's clock: the server anchors every BOH date to IST with
 * date('now','+5 hours','+30 minutes'), India has no daylight saving, and a
 * tablet left on the wrong timezone must not be able to move a permanent
 * record. The arithmetic is done in UTC on purpose (Date.UTC + getUTC*), so
 * the machine's own timezone cannot leak into the answer.
 *
 * A string that carries its own 'Z' or ±HH:MM offset is honoured as written;
 * a bare one is read as UTC, which is what every producer above emits.
 */
const IST_OFFSET_MIN = 330;

interface IstParts { y: number; mo: number; d: number; h: number; mi: number }

function istParts(ts: unknown): IstParts | null {
  const s = String(ts ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  // Date.UTC happily rolls '2026-13-45 99:99' forward into a real-looking date.
  // On a permanent record a fabricated date is worse than an obvious blank, so
  // an out-of-range component is refused rather than normalised. Nothing that
  // datetime('now') writes can fail this; only a corrupted value can.
  const mo0 = Number(m[2]), d0 = Number(m[3]), h0 = Number(m[4]), mi0 = Number(m[5]), s0 = Number(m[6] || 0);
  if (mo0 < 1 || mo0 > 12 || d0 < 1 || d0 > 31 || h0 > 23 || mi0 > 59 || s0 > 59) return null;
  let offMin = 0;                       // the offset the STORED string is in
  const z = m[7];
  if (z && z !== 'Z') {
    const sign = z[0] === '-' ? -1 : 1;
    const hh = Number(z.slice(1, 3));
    const mm = Number(z.slice(z.length - 2));
    offMin = sign * (hh * 60 + mm);
  }
  const t = Date.UTC(Number(m[1]), mo0 - 1, d0, h0, mi0, s0)
    - offMin * 60000            // → true UTC
    + IST_OFFSET_MIN * 60000;   // → IST wall clock
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** A stored UTC datetime → '15 Sep · 6:04 pm' IST. His own timeline shape. */
export function stamp(ts: unknown): string {
  const p = istParts(ts);
  if (!p) return niceDate(String(ts || '').slice(0, 10));
  const ap = p.h >= 12 ? 'pm' : 'am';
  const h = p.h % 12 || 12;
  return `${p.d} ${MON[p.mo - 1] || '?'} · ${h}:${String(p.mi).padStart(2, '0')} ${ap}`;
}

/**
 * A stored UTC datetime → '15 Sep 2026' IST — niceDate's counterpart for a
 * column that carries a time. Slicing a datetime and handing it to niceDate
 * names the wrong day for everything logged after 18:30 UTC, which is 00:00 IST
 * onwards: a bill closed at 00:30 IST would have read as the previous day.
 */
export function stampDate(ts: unknown): string {
  const p = istParts(ts);
  if (!p) return niceDate(String(ts || '').slice(0, 10));
  return `${p.d} ${MON[p.mo - 1] || '?'} ${p.y}`;
}

/**
 * IST today as YYYY-MM-DD.
 *
 * The server anchors every BOH date to IST (date('now','+5 hours','+30 minutes')),
 * so the date pickers must too. A plain new Date() on a laptop left on UTC would
 * offer yesterday as "today" for the five and a half hours before the owner's
 * day starts, and the server would then refuse the follow-up as a past date.
 */
export function istToday(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
}

/** The owner's seven outcomes, in his order, with his words on screen. */
export const OUTCOMES: { key: string; label: string; paid: boolean }[] = [
  { key: 'payment_received',   label: 'Payment received',                 paid: true  },
  { key: 'not_received',       label: 'Not received',                     paid: false },
  { key: 'more_time',          label: 'Customer requested more time',     paid: false },
  { key: 'not_responding',     label: 'Customer not responding',          paid: false },
  { key: 'payment_processing', label: 'Payment processing',               paid: false },
  { key: 'dispute',            label: 'Dispute / clarification required', paid: false },
  { key: 'other',              label: 'Other',                            paid: false },
];
export const outcomeLabel = (k: string) => OUTCOMES.find(o => o.key === k)?.label || k;

/** The eight tender types settle accepts, so a BOH payment can never carry a
 *  mode the POS could not have recorded. */
export const MODES = ['cash', 'upi', 'card', 'zomato', 'swiggy', 'dineout', 'cheque', 'other'];

export const inputCls = 'w-full px-3 py-2 text-sm border border-[#D4B896] rounded-lg bg-white text-[#2D1B0E] outline-none focus:border-[#af4408]';
export const labelCls = 'block text-xs uppercase font-semibold text-[#6B5744] mb-1';
