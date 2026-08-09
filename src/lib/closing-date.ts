import { todayIST } from '@/lib/format-date';

/**
 * THE ONE DATE GUARD FOR EVERY CLOSING-COUNT WRITER (2026-08)
 * ═══════════════════════════════════════════════════════════
 * A closing count is a DATED PHYSICAL COUNT RECORD, and the date is the only
 * field nothing downstream can repair. This module is the single source of
 * truth for what date a count may carry. Every writer that inserts into
 * closing_stock / store_closing_counts — and every writer that calls
 * upsertVarianceApproval() — must run its date through checkClosingDate()
 * before it opens a transaction.
 *
 * WHY A SHARED MODULE AND NOT A COPIED LITERAL. Until now the same
 * /^\d{4}-\d{2}-\d{2}$/ existed in FOUR independent places across the closing
 * family (central route, liquor route, dept-sheet, dept-sheet import) and only
 * ONE of them (central, dfbf0f0) had grown the future + real-calendar checks.
 * A copied literal does not prevent drift — it IS the drift surface: the same
 * bad date entered through a different door produced a different outcome. One
 * import, one behaviour, one place to fix.
 *
 * WHY IT IS LOAD-BEARING. Commit e91c64c ("Variance queue: only the newest
 * count per item can be approved") made a count SUPERSEDED by any later-dated
 * row for the same (source, material, store, department) that is pending or
 * approved — see supersedeWhere() in src/lib/variance-approval.ts. So one
 * fat-fingered 2027-08-09 becomes the newest count for that material FOREVER:
 * every genuine count taken afterwards is reported superseded and
 * approveVariance() refuses it, for a whole year, until somebody notices and
 * rejects the phantom row. The sheet for a real day looks normal — nothing on
 * it names the future date doing the blocking — which is exactly how this
 * would be found late. A malformed date is the quieter twin: it matches no GET
 * date filter, so the count saves and is then invisible on every closing
 * surface.
 *
 * BACKDATING MUST KEEP WORKING and is untouched. Counting last Tuesday is
 * ordinary business here — late sheets, paper counts typed up the next
 * morning, the department-ledger cutover — and several flows depend on it.
 * ONLY future and malformed dates are refused. There is no lower bound.
 *
 * IST, NOT UTC. todayIST() (src/lib/format-date) is the shared helper.
 * `new Date().toISOString().slice(0,10)` returns YESTERDAY for the whole
 * 00:00–05:30 IST window, so a UTC comparison would reject a perfectly
 * ordinary early-morning count of the current day — the same off-by-one
 * already fixed once on the receiving-variance screen.
 *
 * CALL IT ONCE PER SUBMIT, BEFORE THE TRANSACTION OPENS. A ~950-line sheet
 * must not come back with 950 copies of the same complaint, and refusing the
 * submit whole means no half-written day: not one upsert-delete fires against
 * a bad date.
 *
 * NO WHITESPACE TOLERANCE, BY DESIGN. A padded " 2026-08-09 " is refused with
 * the malformed message, exactly as all four writers have always refused it.
 * If your input is a CSV cell or a hand-typed field, trim it at the call site
 * BEFORE calling — do not loosen the shared shape for one caller's paste.
 *
 * SERVER-SIDE ONLY BY CONVENTION: imported by API routes. It deliberately
 * pulls in nothing but the date formatter, so it can never drag @/lib/db
 * (better-sqlite3) into a client bundle.
 */

/**
 * The one date shape a closing count may carry. Exported for callers that need
 * the SHAPE alone (e.g. comparing two already-validated dates); anything
 * validating user input wants checkClosingDate(), not this. Do not copy it.
 */
export const CLOSING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ClosingDateCheck =
  | { ok: true; date: string }
  | { ok: false; error: string };

/**
 * Validate the date a closing count is being saved under.
 *
 * Three refusals, in this order — the FIRST one that applies is returned, so a
 * caller emits exactly one 400 per submit:
 *   1. wrong shape            → 'a count must be dated YYYY-MM-DD.'
 *   2. not a real calendar day→ 'there is no such day on the calendar.'
 *   3. later than today (IST) → 'that is in the future …'
 *
 * On success `date` is the validated, normalized string — bind THAT to SQL,
 * never the raw body value. `["2026-08-09"]` flattens through String() and
 * passes every check, but binding the ARRAY throws at bind time inside the
 * write transaction: a 500 and a full rollback where a clean save was due.
 * Bind what was checked. (A string that satisfies CLOSING_DATE_RE cannot carry
 * surrounding whitespace, so the returned value is already trimmed.)
 */
export function checkClosingDate(raw: unknown): ClosingDateCheck {
  // String(), not a typeof guard: this is the coercion the shipped central
  // route performs, and narrowing it here would change which inputs reach the
  // shape check. Non-strings simply fail that check with their coerced text
  // quoted back, which is the clearest thing to show the user anyway.
  const dateStr = String(raw);
  if (!CLOSING_DATE_RE.test(dateStr)) {
    return { ok: false, error: `Invalid closing date "${dateStr}" — a count must be dated YYYY-MM-DD.` };
  }
  const today = todayIST();
  // A real calendar date, not just the right SHAPE. CLOSING_DATE_RE passes
  // 2026-13-01 and 2026-02-31: the first is lexically greater than today so it
  // used to be refused as "in the future", which is not true — it is not a
  // date at all — and the second is lexically smaller, so it SAVED, dating a
  // count to a day that does not exist. Round-tripping through Date catches
  // both, and the user gets the reason that actually applies.
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const asDate = new Date(Date.UTC(yy, mm - 1, dd));
  // setUTCFullYear undoes Date.UTC's legacy two-digit-year remap: Date.UTC(1, 0, 1)
  // means 1901, so "0001-01-01" would fail the round-trip and be refused as "no
  // such day on the calendar" — a true refusal for a false reason. It is a real
  // calendar day; it is simply an absurd one, and the future check below is what
  // should have no opinion on it. Only years 0000-0099 are affected, and no such
  // count exists, but a wrong reason on screen is the thing this file exists to
  // stop printing.
  if (yy >= 0 && yy <= 99) asDate.setUTCFullYear(yy);
  if (asDate.getUTCFullYear() !== yy || asDate.getUTCMonth() !== mm - 1 || asDate.getUTCDate() !== dd) {
    return { ok: false, error: `Invalid closing date "${dateStr}" — there is no such day on the calendar.` };
  }
  // Fail OPEN if todayIST() ever hands back a non-date: comparing against
  // garbage would reject EVERY count and take the nightly close down outlet-
  // wide. The shape + calendar checks above still stand, so the worst case
  // here is the behaviour these routes already shipped with, not an outage.
  // (Same posture as the supersede test, which also fails open rather than
  // silently matching nothing.)
  if (CLOSING_DATE_RE.test(today) && dateStr > today) {
    return {
      ok: false,
      error: `Cannot record a closing count dated ${dateStr} — that is in the future (today is ${today} IST). `
        // "that differs from system stock" is load-bearing: a count matching
        // system stock has zero variance, and upsertVarianceApproval deletes
        // the pending row and returns null for those, so it supersedes
        // nothing. Claiming otherwise overstates the consequence.
        + 'Counts may be backdated, never forward-dated: a future-dated count supersedes every real count '
        + 'of that item that differs from system stock, until it is rejected.',
    };
  }
  return { ok: true, date: dateStr };
}
