/**
 * Reservego reservation CSV → the CRM's own booking + guest model.
 *
 * ── WHY THIS FILE IS PURE ──────────────────────────────────────────────────
 * Every rule that decides WHAT a row means — how a guest is identified, when
 * two rows are the same booking, which Reservego status maps to which of ours —
 * lives here as a plain function over plain data, with no database and no
 * request. That is deliberate: the same rules have to run twice, once for the
 * CSV importer and later for the direct Reservego API, and a rule that lives
 * inside a route handler cannot be reused by the other caller without being
 * copied. This repo's recurring failure is exactly that — paired definitions
 * drifting apart — so the mapping is written once, here, and both callers
 * import it.
 *
 * ── THE TARGET MODEL IS THE ONE THAT ALREADY EXISTS ────────────────────────
 * ct_guests is the customer master and ct_bookings is the booking history.
 * They already carry the CRM's phone-call bookings, the /dine-in/reservations
 * seat board (table_id, seated_at) and the guest 360. Reservego rows land in
 * the SAME two tables rather than a parallel pair, so one guest has one profile
 * whether they phoned, walked in or booked through Reservego — which is the
 * entire point of the exercise.
 */

/* ── identity ─────────────────────────────────────────────────────────────── */

/**
 * The last ten digits of a phone number, or ''.
 *
 * TEN DIGITS, NOT THE WHOLE STRING, because the same guest appears as
 * 9392966858, 919392966858 and +91 93929 66858 across the file — verified in
 * the sample, which carries both a 10-digit and a 12-digit form. Matching on
 * the raw text would split one guest into three profiles and quietly destroy
 * every lifetime metric the CRM is being built to produce.
 *
 * This mirrors the norm10 the CRM's existing guest-360 already unifies on, so a
 * Reservego guest and a phone-call guest resolve to the same person.
 */
export function phone10(raw: unknown): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** Lower-cased, trimmed email, or '' — the second identity key after phone. */
export function normEmail(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
}

/** Collapsed-whitespace name for display and as the LAST-RESORT identity key. */
export function normName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The key that decides which guest a row belongs to, strongest first.
 *
 * Phone, then email, then name. Name is last and is deliberately weak: two
 * different people called "Admin" or "Guest" are not the same person, so a
 * name-only match is recorded as low confidence and never merges into a profile
 * that already has a phone. Rows with none of the three cannot be attributed
 * and are reported as failures rather than piled into an anonymous bucket.
 */
export type GuestKey = { kind: 'phone' | 'email' | 'name'; key: string } | null;

export function guestKey(row: ReservegoRow): GuestKey {
  const p = phone10(row['Guest Number']);
  if (p) return { kind: 'phone', key: p };
  const e = normEmail(row['Guest Email']);
  if (e) return { kind: 'email', key: e };
  const n = normName(row['Guest Name']).toLowerCase();
  if (n) return { kind: 'name', key: n };
  return null;
}

/* ── time ─────────────────────────────────────────────────────────────────── */

/**
 * Reservego writes 'YYYY-MM-DD HH:MM:SS' local time. Kept verbatim rather than
 * converted: the whole file is one outlet in one timezone, and every existing
 * date column in this database is naive local text. Converting here would make
 * a Reservego booking sort differently from a phone booking on the same evening.
 */
export function parseStamp(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
}

/** The date half of a stamp — 'YYYY-MM-DD', or ''. */
export function stampDate(stamp: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : '';
}

/* ── which export a row came out of ───────────────────────────────────────── */

/**
 * WHEN THE EXPORT WAS TAKEN, read off the file name.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 * The owner has 129 exports going back to 2024 and will upload them in
 * whatever order the file picker happens to sort them. Every one of them is a
 * SNAPSHOT of the same booking history, so the same booking appears in several
 * files with DIFFERENT content — a row exported Confirmed in January and
 * Cancelled in July is not two bookings, it is one booking and two opinions,
 * and only the July one is current. Without a way to date a file the importer
 * simply applies whichever arrived last: uploading the archive after the recent
 * files walked 5,335 bookings BACK to a stale arrival state (measured, 129 real
 * files, chronological order vs reverse). The stamp is what makes the answer a
 * property of the DATA rather than of the upload order.
 *
 * ── THE FORMAT, AND WHY IT IS READ AS DD-MM-YYYY ──────────────────────────
 * Reservego names its export BookingsService_DD-MM-YYYY_HH-MM-SS_<id>_1_1.csv
 * (the zip wraps a folder of the same name, so both spellings appear). Read as
 * DAY first, which is not a guess: across the owner's 129 real files 83 carry a
 * first field greater than 12 and NONE carries a second field greater than 12,
 * so the first field cannot be a month and the second cannot be a day.
 *
 * Returns '' — never a wrong guess — for anything that does not match or is not
 * a real calendar date, so a renamed file is reported as undated rather than
 * dated wrongly. See ../lib/reservego-import.ts (startImport) for the ladder
 * that falls back to the file's own maximum Booking Time.
 */
export function exportStampFromFileName(name: string): string {
  const m = /(\d{2})-(\d{2})-(\d{4})[_ ](\d{2})-(\d{2})-(\d{2})/.exec(String(name ?? ''));
  if (!m) return '';
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const day = Number(dd), mon = Number(mm), hour = Number(hh), min = Number(mi), sec = Number(ss);
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 59) return '';
  // Reject 31-02: Date rolls it over, so a round-trip through the calendar is
  // what proves the day actually exists in that month.
  const dt = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${yyyy}-${mm}-${dd}`) return '';
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/**
 * Any caller-supplied export stamp, normalised to the one comparable shape.
 *
 * Comparison is plain string ordering — legal only because every stamp in this
 * module is 'YYYY-MM-DD HH:MM:SS', fixed width and big-endian, where
 * lexicographic order IS chronological order. Anything that cannot be read into
 * that shape becomes '', which every caller treats as "undated", never as
 * "1970" (an unreadable stamp that sorted first would make every file look
 * older than everything else and skip the whole import).
 */
export function normalizeExportStamp(raw: unknown): string {
  return parseStamp(raw);
}

/** The time half — 'HH:MM', or ''. */
export function stampTime(stamp: string): string {
  return /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.test(stamp) ? stamp.slice(11, 16) : '';
}

/* ── the night the guest is coming ────────────────────────────────────────── */

/**
 * WHICH OF RESERVEGO'S TWO STAMPS IS THE SLOT — 'Booking Time', not
 * 'Reserved Time'. The names are the reverse of what they sound like.
 *
 * ── MEASURED, 62 of the owner's exports, 83,658 rows (2026-08-13) ─────────
 *   · 'Booking Time' lands on the clock: 63,256 of 77,910 have :00 seconds and
 *     its two commonest minute values are :00 (31,610) and :30 (27,335).
 *     'Reserved Time' has non-zero seconds on 76,560 of 77,910 and its minutes
 *     are flat (:16, :44, :05 … ~1,400 each) — a log, not a slot.
 *   · By hour, 'Booking Time' is dinner-shaped (peaks 20:00 = 20,889,
 *     21:00 = 17,441, 19:00 = 10,061; nothing at all between 04:00 and 10:00).
 *     'Reserved Time' is spread right across the working day, 07:00 included.
 *   · 'Reserved Time' is EARLIER than 'Booking Time' on 62,856 rows and later
 *     on 138 — a booking is made before the night, not after it.
 *   · Against Seated Time, median gap 94 min to 'Booking Time' and 509 min to
 *     'Reserved Time'.
 *   · One row, whole: Booking Time 2024-10-25 11:45:00 (a slot), Reserved Time
 *     2024-10-25 00:33:12 (booked at half past midnight). A walk-in stamps all
 *     three columns with the same value, which is why the fallback below is
 *     harmless where the slot column is blank.
 *
 * SO EVERY DERIVED FIELD HANGS OFF THIS ONE, and not off mapRow's `effective`.
 * `effective` (reservedTime || bookingTime) is the CREATION moment, and it is
 * load-bearing for identity — dedupeKeyFor's fourth component and the
 * (outlet, phone, date) grouping markDuplicateGroups collapses on — so it is
 * deliberately left exactly as it is. Moving it would re-key all 85,558 stored
 * bookings and re-decide every duplicate. The two dates therefore disagree on
 * ~28% of rows (23,407 of 83,658 have different date halves), and that is the
 * one thing to know when reading this table: booking_date is when it was
 * BOOKED, reserved_date is the night they were coming.
 */
export function slotStampOf(bookingTime: string, reservedTime: string): string {
  return bookingTime || reservedTime;
}

/** 0=Sunday…6=Saturday, matching SQLite's strftime('%w') and ct_bookings.dow. */
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export interface DerivedDay {
  /** 'YYYY-MM-DD' the table was booked FOR. */
  reservedDate: string;
  /** 'Saturday' — the label, for display and CSV. '' when there is no date. */
  dayOfWeek: string;
  /** 0=Sunday…6=Saturday, or null. Stored beside the label because sorting a
   *  weekday report by NAME yields Friday, Monday, Saturday. */
  dow: number | null;
  /** 'HH:MM' of the slot, or ''. */
  slotTime: string;
}

/**
 * The date/weekday/slot trio, from one stamp, in one place.
 *
 * THE WEEKDAY IS COMPUTED IN UTC ON PURPOSE. `new Date('2026-08-13')` is parsed
 * as midnight UTC while `.getDay()` answers in the SERVER's zone, so on a host
 * west of Greenwich every date in this archive would report the day before —
 * a Saturday-night report quietly filed under Friday, on 85,558 rows, with
 * nothing on screen to say so. Date.UTC + getUTCDay keeps the calendar
 * arithmetic entirely inside one zone, which is right because these stamps are
 * naive local text (see parseStamp) and carry no zone of their own.
 *
 * The round-trip check is what rejects 2025-02-31: Date.UTC rolls it forward to
 * March 3 and would answer with a real weekday for a day that never existed.
 */
export function deriveDay(stamp: string): DerivedDay {
  const date = stampDate(stamp);
  const time = stampTime(stamp);
  if (!date) return { reservedDate: '', dayOfWeek: '', dow: null, slotTime: time };
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== date) {
    return { reservedDate: date, dayOfWeek: '', dow: null, slotTime: time };
  }
  const dow = dt.getUTCDay();
  return { reservedDate: date, dayOfWeek: WEEKDAY_NAMES[dow], dow, slotTime: time };
}

/* ── lunch or dinner ──────────────────────────────────────────────────────── */

/** Stored lower-case, as db.ts declares the column. Title-case is display. */
export type MealPeriod = 'lunch' | 'dinner';
export const MEAL_PERIOD_LABEL: Record<MealPeriod, string> = { lunch: 'Lunch', dinner: 'Dinner' };

/** settings.reservation_meal_cutoff — seeded by db.ts, editable by the owner.
 *  The KEY is exported so the importer, the query tab and the settings screen
 *  cannot drift onto two spellings of the same row. */
export const MEAL_CUTOFF_KEY = 'reservation_meal_cutoff';
export const MEAL_CUTOFF_DEFAULT = '17:00';

/**
 * Any stored cutoff → 'HH:MM'. Anything unreadable falls back to the default
 * rather than to '', because '' compares LESS than every slot time and would
 * silently file the entire archive as dinner.
 */
export function normalizeCutoff(raw: unknown): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(raw ?? '').trim());
  if (!m) return MEAL_CUTOFF_DEFAULT;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return MEAL_CUTOFF_DEFAULT;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Before the cutoff is lunch, the cutoff itself and after is dinner.
 *
 * Plain string comparison, legal only because both sides are zero-padded
 * 'HH:MM' — fixed width and big-endian, where lexicographic order IS
 * chronological order. A slot with no readable time returns '' (unknown), never
 * a guess: 'lunch' on a row we cannot place would be counted in a lunch report
 * as if it were evidence.
 *
 * AFTER MIDNIGHT READS AS LUNCH, and that is a known consequence of a
 * single-cutoff rule rather than an oversight: 3,546 of 77,910 rows (4.6%) sit
 * between 00:00 and 04:59 on the creation stamp, though on the SLOT stamp —
 * the one this is actually applied to — the venue books nothing between 04:00
 * and 10:00 and only 69 rows fall before 04:00 at all. If the owner ever wants
 * 01:00 counted as the tail of the previous night's dinner, this function is
 * the one place that changes.
 */
export function mealPeriodFor(slotTime: string, cutoff: unknown): MealPeriod | '' {
  if (!/^\d{2}:\d{2}$/.test(String(slotTime ?? '').trim())) return '';
  return slotTime < normalizeCutoff(cutoff) ? 'lunch' : 'dinner';
}

/** deriveDay + the meal split, for callers that hold the setting — the query
 *  tab and any future API. The importer uses the two halves separately because
 *  mapRow is pure and must not invent a cutoff of its own. */
export function deriveNight(stamp: string, cutoff: unknown): DerivedDay & { mealPeriod: MealPeriod | '' } {
  const day = deriveDay(stamp);
  return { ...day, mealPeriod: mealPeriodFor(day.slotTime, cutoff) };
}

/* ── which band was playing ───────────────────────────────────────────────── */

/** settings.reservation_band_lead_in_minutes — how long BEFORE an act starts a
 *  booking still counts as having come for it. Seeded 120 by db.ts. */
export const BAND_LEAD_IN_KEY = 'reservation_band_lead_in_minutes';
export const BAND_LEAD_IN_DEFAULT = 120;

export function normalizeLeadIn(raw: unknown): number {
  const s = String(raw ?? '').trim();
  // '' first: Number('') is 0, so a missing setting would otherwise read as a
  // ZERO-minute window and attribute only the guests who booked after the act
  // had already started — the exact under-count the lead-in exists to prevent.
  if (!s) return BAND_LEAD_IN_DEFAULT;
  const n = Number(s);
  // A day is the ceiling: a lead-in longer than the day would attribute every
  // slot to every act and make the column say nothing.
  return Number.isFinite(n) && n >= 0 ? Math.min(1440, Math.round(n)) : BAND_LEAD_IN_DEFAULT;
}

/**
 * A CLOCK STRING → MINUTES SINCE MIDNIGHT, or null.
 *
 * THE ONE PARSER IN THE HOUSE, and the reason it is spelt out at this length.
 * ct_entertainment.start_time is a free-text box — the What's On write path does
 * .trim().slice(0,10) and validates no format at all — so this has to read what
 * people actually type. It used to read the 24-hour form only, on a PREFIX
 * match, which meant "09:00pm" (ordinary typing, not corruption) came back as
 * 09:00 and a 21:00 act's window opened TWELVE HOURS EARLY, crediting the whole
 * day's lunches to the band with nothing on screen saying so. The Query tab grew
 * a second copy that REFUSED any meridiem instead, so the same calendar row was
 * silently mis-stamped on the write path and silently dropped on the read path,
 * and the two surfaces disagreed about the same night. Refusing is safe but it
 * is not understanding, and a band whose every row carries a meridiem became
 * unqueryable — 18 nights of one act, on production.
 *
 * Both paths now go through THIS function; there is no second copy left to
 * drift. (reservation-query.ts keeps its own local name and delegates straight
 * here — see the note there.) This repo's recurring failure is paired
 * definitions drifting apart, and these two parsers were exactly that pair.
 *
 * ── WHAT IT UNDERSTANDS ───────────────────────────────────────────────────
 *  · TWELVE-HOUR, with a meridiem: "9pm", "9 pm", "9:00pm", "09:00pm",
 *    "9:00 PM", "09:00 p.m.", "9 a m", "9:05Pm". Minutes optional, space
 *    optional, dots optional, case free. Noon and midnight are the two a
 *    careless conversion gets wrong, so they are named: "12:00am" → 0,
 *    "12:30 AM" → 30, "12:00pm" → 720.
 *  · TWENTY-FOUR-HOUR, exactly as before: "19:00", "19:00:00", " 21:00",
 *    "9:30", "21:00 - 23:00". Byte for byte unchanged — these are the forms
 *    already proven correct across the archive and they must not move.
 *
 * ── WHAT IT REFUSES, RATHER THAN GUESSING ─────────────────────────────────
 * The twelve-hour clock runs 1 to 12, so an out-of-range hour BESIDE a meridiem
 * is a typo and is refused outright: "13:00pm", "0:30am", "19:00 pm" → null.
 * Deliberately NOT retried as a 24-hour string, because reading "13:00pm" as
 * 13:00 is the same act of guessing that produced this bug in the first place.
 * "25:00", "9:60", "9:99pm", "pm", "abc" and "" are null for the same reason.
 *
 * A null is never silent: resolveBandWindow() reports the calendar row with its
 * reason, and pickBandForSlot() treats such an act as untimed. Note the second
 * of those WIDENS — an untimed act is the whole-night fallback there — so
 * refusing "13:00pm" moves that act off a wrong 13:00 window and onto the whole
 * night whenever no timed act qualifies. Refusing is still right; it is written
 * down here so nobody discovers it by surprise later.
 *
 * ── BOTH BRANCHES MATCH ON THE PREFIX, AND THAT IS LOAD-BEARING ───────────
 * The 24-hour branch has always been a prefix match — that is what makes
 * "21:00 - 23:00" and "19:00:00" work. The meridiem branch matches the same
 * way, so "09:00pm - 11:00pm" reads 21:00. Anchoring the meridiem branch to the
 * END of the string instead would drop that spelling through to the 24-hour
 * branch and read it as 09:00 — reintroducing the exact twelve-hour error, on
 * the exact form a person is most likely to type into a What's On box.
 *
 * (Both branches are read with String.match rather than RegExp.exec. For a
 * non-global, non-sticky pattern the two are the same call and neither carries
 * lastIndex state; spelt this way so a repo-wide `exec(` search never has to
 * pause on a time parser.)
 *
 * ── AND A MERIDIEM THE PREFIX BRANCH CANNOT REACH REFUSES THE WHOLE STRING ──
 * The paragraph above is only half the rule, and the missing half is the bug
 * this parser exists to kill. MERIDIEM_RE is anchored at ^, so it only sees a
 * meridiem sitting ON the leading hour. Write the SAME twelve-hour night as a
 * range — "09:00 - 11:30pm", "9:00 to 11:00 pm", "8:30 - 11:30 p.m." — and the
 * meridiem is behind a dash where that pattern can never reach it, the match
 * fails, and the string falls into the 24-hour branch to be read as 09:00. That
 * is the original twelve-hour error verbatim, on the very spelling this fix was
 * written for, and it would arrive with an EMPTY skipped[] and a calm box.
 *
 * So: if the meridiem branch did not match and a meridiem is still there
 * anywhere the guard can SEE it (which is not everywhere — the limits are spelt
 * out at the end of this note, and they matter), refuse. This is HEAD's
 * whole-string guard from reservation-query.ts, kept exactly, and demoted from
 * "refuse everything with a meridiem" to "refuse only what the meridiem branch
 * could not read". The read path therefore loses nothing it had at HEAD — every
 * string HEAD refused and reported is still refused and reported — while the
 * adjacent forms people actually type are now understood.
 *
 * "09:00 - 11:30pm" is NOT guessed at as 21:00, though a person would read it
 * that way, because the same shape is genuinely ambiguous elsewhere
 * ("12:00 - 03:00 am") and the house rule is to refuse rather than guess. It is
 * reported as unreadable, and the Slot-time fallback in resolveBandWindow()
 * still lets the reader query those nights.
 *
 * The guard needs a digit before the meridiem, so it cannot fire on ordinary
 * 24-hour text: "21:00hrs" keeps reading 1260.
 *
 * ── WHAT THE GUARD STILL CANNOT SEE ───────────────────────────────────────
 * Written down because the paragraph above reads like a closure and is not one,
 * and a comment that overstates its own cover is how the next reader stops
 * checking. Two classes still fall through to the 24-hour branch and read
 * TWELVE HOURS EARLY, silently, with an empty skipped[] and a calm box:
 *
 *  1. A MERIDIEM GLUED TO A FOLLOWING WORD CHARACTER. Both patterns end in \b,
 *     which needs a non-word character after the "m". "9:00pmish", "9:00pmIST",
 *     "9:00 pmx", "9:00 PM10:" therefore match neither, and all read 540.
 *  2. A MERIDIEM ALREADY AMPUTATED BEFORE IT GOT HERE. The What's On write path
 *     stores String(body.start_time).trim().slice(0, 10) (entertainment/route.ts
 *     and entertainment/[id]/route.ts), so "09:00 - 11:30pm" — the worked
 *     example three paragraphs up — arrives as "09:00 - 11", carrying no
 *     meridiem for any guard to find, and reads 540.
 *
 * NEITHER IS A REGRESSION: HEAD read every one of these identically, on BOTH
 * parsers, so this change neither creates nor widens them. They are left alone
 * DELIBERATELY. The \b is what keeps ordinary venue text readable, and every
 * variant that closes class 1 was measured to move a 24-hour string that parses
 * today — dropping \b or adding a glued-digit guard turns "20:00Amphitheatre"
 * from 1200 into null; anchoring a looser 1–12 meridiem at ^ turns
 * "12:00 Amphitheatre" from 720 into 0, which is the very twelve-hour error
 * this function exists to kill. Class 2 cannot be closed here at all: the
 * meridiem is gone before the call. Closing either one needs the store limit
 * raised and a format check on the What's On box — a change in those two route
 * files, not a wider regex in this one.
 */
const MERIDIEM_RE = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i;
const HH_MM_PREFIX_RE = /^(\d{1,2}):(\d{2})/;
/** A meridiem ANYWHERE, not just on the leading hour. See the note above. */
const MERIDIEM_ANYWHERE_RE = /\d\s*[ap]\.?\s*m\b/i;

export function minutesOfDay(hhmm: unknown): number | null {
  const s = String(hhmm ?? '').trim();
  const mer = s.match(MERIDIEM_RE);
  if (mer) {
    const h = Number(mer[1]);
    const mi = mer[2] === undefined ? 0 : Number(mer[2]);
    // 1–12 only, and no fallthrough to the 24-hour branch — see above.
    if (h < 1 || h > 12 || mi > 59) return null;
    const pm = mer[3].toLowerCase() === 'p';
    const h24 = h === 12 ? (pm ? 12 : 0) : (pm ? h + 12 : h);
    return h24 * 60 + mi;
  }
  // A twelve-hour string the branch above could not read is NOT a 24-hour one.
  // Without this, "09:00 - 11:30pm" reads 09:00 — see the note above.
  if (MERIDIEM_ANYWHERE_RE.test(s)) return null;
  const m = s.match(HH_MM_PREFIX_RE);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/** One act on one night, as ct_entertainment holds it. bandId is ct_bands.id,
 *  '' while the name has no master row yet. */
export interface BandEvent { id: string; name: string; startTime: string; bandId: string }

/**
 * WHICH ACT A BOOKING BELONGS TO, given every band on that date.
 *
 * A 13:00 lunch on a night with a 21:00 band did not come for the band, so a
 * date-only rule would credit the act with every cover the venue took that day
 * and make "which band fills the room" unanswerable. The window is
 * [start − leadIn, end of day): guests booked at 19:00 are there for the 21:00
 * act (hence the owner's 120-minute default), and anyone booked after it starts
 * is plainly there for it.
 *
 * Two acts on one night: the LATEST one the booking qualifies for, because a
 * 22:00 arrival on a 19:00/21:00 double bill is watching the 21:00. An act with
 * no readable start_time covers the whole night and is used only when no timed
 * act qualifies. A booking with no readable slot time takes the night's first
 * act — the date is all we know, and that is still an answer.
 *
 * The sort is total (start, name, id) so two acts equal on start cannot swap
 * between runs and rewrite history on the next relink.
 */
export function pickBandForSlot(
  slotTime: string,
  events: BandEvent[],
  leadInMinutes: number,
): BandEvent | null {
  const named = events.filter((e) => e.name.trim());
  if (!named.length) return null;
  const lead = normalizeLeadIn(leadInMinutes);
  const key = (e: BandEvent) => `${e.name.toLowerCase()}|${e.id}`;
  const timed = named
    .map((e) => ({ e, start: minutesOfDay(e.startTime) }))
    .filter((x) => x.start !== null) as Array<{ e: BandEvent; start: number }>;
  timed.sort((a, b) => (a.start - b.start) || key(a.e).localeCompare(key(b.e)));
  const untimed = named.filter((e) => minutesOfDay(e.startTime) === null)
    .sort((a, b) => key(a).localeCompare(key(b)));

  const slot = minutesOfDay(slotTime);
  if (slot === null) return timed[0]?.e ?? untimed[0] ?? null;
  const qualifying = timed.filter((x) => slot >= x.start - lead);
  return qualifying.length ? qualifying[qualifying.length - 1].e : (untimed[0] ?? null);
}

/* ── status ───────────────────────────────────────────────────────────────── */

/**
 * Reservego status → the status vocabulary ct_bookings already uses
 * (pending | confirmed | seated | completed | cancelled | no_show), so the
 * seat board, the CRM and every existing query keep working unchanged.
 *
 * NOTE 'Finshed or Checked out' — Reservego's own spelling, misspelt at source
 * and present in the export verbatim. It is matched exactly as written, and the
 * corrected spelling is accepted too in case they ever fix it.
 *
 * An unrecognised status maps to null, and the caller keeps the raw string in
 * reservego_status rather than guessing. Guessing here would silently move a
 * booking into "completed" and inflate the arrival rate the CRM exists to
 * report — a wrong number that looks right is worse than an obvious gap.
 */
const STATUS_MAP: Record<string, BookingStatus> = {
  'finshed or checked out': 'completed',
  'finished or checked out': 'completed',
  'checked out': 'completed',
  'completed': 'completed',
  'seated': 'seated',
  'checked in': 'seated',
  'arrived': 'seated',
  'confirmed': 'confirmed',
  'booked': 'confirmed',
  'reserved': 'confirmed',
  'pending': 'pending',
  'waitlist': 'pending',
  'waiting': 'pending',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
  'deleted': 'cancelled',
  'no show': 'no_show',
  'noshow': 'no_show',
  'no-show': 'no_show',
};

export type BookingStatus = 'pending' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show';

export function mapStatus(raw: unknown): BookingStatus | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return STATUS_MAP[s] ?? null;
}

/**
 * THE SQL TWIN of isArrived(), for ct_bookings.arrived.
 *
 * `arrived` is not a column anybody writes: it is a VIRTUAL generated column
 * whose expression is this string, so the database itself derives it from
 * status and seated_at and it CANNOT go stale. It used to be a cache with four
 * writers — the importer, seatBooking(), completeBookingForOrder() and the
 * booking PUT — of which only the importer maintained it, so seating a guest
 * from the Seat board left them reading "Arrived: No" forever.
 *
 * KEEP THE TWO IN STEP. This expression and isArrived() below must say the same
 * sentence; they sit adjacent for exactly that reason, and the acceptance test
 * compares the column against the function over the whole loaded archive. SQL
 * rather than TypeScript because a generated column is the only form of this
 * rule that no future writer can bypass — a helper can be forgotten, a column
 * default cannot.
 *
 * Consumed by the migration in src/lib/db.ts. Not interpolated from any input.
 */
export const ARRIVED_SQL = `CASE
  WHEN status IN ('cancelled', 'no_show') THEN 0
  WHEN status IN ('seated', 'completed') THEN 1
  WHEN seated_at IS NOT NULL AND TRIM(seated_at) <> '' THEN 1
  ELSE 0 END`;

/** Did the guest actually turn up? Drives arrived-count and conversion rate. */
export function isArrived(status: BookingStatus | null, seatedAt: string): boolean {
  // A CANCELLED OR NO-SHOW BOOKING IS NEVER AN ARRIVAL, whatever Seated Time
  // says. Reservego leaves a stale Seated Time on a row that is later cancelled
  // or marked no-show — verified in the owner's real exports — and the earlier
  // version of this function trusted the stamp over the status. That made a
  // guest who never came read as a 100% arrival rate, corrupting the single
  // number this whole feature exists to produce. The status is the venue's
  // decision about what happened; the stamp is a leftover.
  if (status === 'cancelled' || status === 'no_show') return false;
  return status === 'completed' || status === 'seated' || !!seatedAt;
}

/* ── the row ──────────────────────────────────────────────────────────────── */

/** The CSV as Papa hands it over: every column a string, keyed by header. */
export type ReservegoRow = Record<string, string>;

/** One booking, mapped and normalised — what the importer writes. */
export interface MappedBooking {
  /** Stable identity: outlet + guest + the moment the booking was created. */
  dedupeKey: string;
  guest: { key: GuestKey; name: string; phone10: string; email: string };
  outlet: string;
  bookingTime: string;       // Reservego's 'Booking Time' — the SLOT (see slotStampOf)
  reservedTime: string;      // Reservego's 'Reserved Time' — when it was created
  seatedTime: string;        // when they actually sat, '' if they never did
  /** IDENTITY, NOT DISPLAY: the date half of (reservedTime || bookingTime), i.e.
   *  when the booking was created. It is the dedupe key's fourth component and
   *  the same-day grouping key, so it cannot move — see slotStampOf. Read
   *  reservedDate below for the night the guest was coming. */
  bookingDate: string;
  slotStamp: string;         // the slot stamp itself — slotStampOf(booking, reserved)
  reservedDate: string;      // 'YYYY-MM-DD' of slotStamp — ct_bookings.reserved_date
  dayOfWeek: string;         // 'Saturday' of slotStamp
  dow: number | null;        // 0=Sunday…6=Saturday of slotStamp
  slotTime: string;          // HH:MM of slotStamp
  /** Reservego's own "Vist Count" (their spelling). A CROSS-CHECK against the
   *  arrived_visits we compute, never an input to it. null = not reported. */
  visitCount: number | null;
  bookingType: string;       // Reservation | Walkin | …
  status: BookingStatus | null;
  rawStatus: string;
  arrived: boolean;
  pax: number;
  paxBreakdown: Record<string, number>;
  /** True when any pax cell on this row exceeded PAX_MAX and was cut down to
   *  it. Counted in the import summary — a clamp is a correction, and a
   *  correction the owner cannot see is indistinguishable from a bug. */
  paxClamped: boolean;
  reservedBy: string;
  sections: string;
  tables: string;
  source: string;
  preferences: string;
  tags: string;
  guestComments: string;
  outletComments: string;
  deletionType: string;
  deletionReason: string;
  billAmount: number | null;
  billNumber: string;
  bookingAmount: number | null;
  bookingTxnId: string;
  bookingPaymentStatus: string;
  bookingPaymentDate: string;
}

const num = (v: unknown): number | null => {
  const s = String(v ?? '').replace(/[₹,\s]/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * The largest party this importer will believe.
 *
 * Reservego's public web form has no upper bound on Pax, so a guest's typo
 * becomes a booking. Measured over the owner's 129 exports (217,805 rows):
 *
 *   ≤10 covers    209,942 rows      101–200      10
 *   11–20           7,016           201–500       6
 *   21–50             802           501–1,000     4
 *   51–100             23           >1,000        2
 *
 * and the two above 1,000 are 5,000 ("Dilbar", a Cancelled website booking at
 * 03:30) and 123,654,789 ("Aman Khan", Confirmed, Website) — the second of
 * which alone outweighs every real cover in the archive and turns a guest's
 * total_pax, and the venue's, into nonsense.
 *
 * 1,000 rather than the 500 the bookings PUT enforces on hand entry, and the
 * difference is deliberate: the single largest party that actually HAPPENED
 * here is 650 covers ("Athul Arcisium", status Finshed or Checked out, present
 * in 4 separate exports across 19 months), so a 500 ceiling would quietly
 * shrink a real event. 1,000 sits above every genuine booking in the whole
 * archive and below both typos — it clamps exactly 2 rows in 217,805, and both
 * of them are reported in the import summary (pax_clamped) so the source can be
 * corrected rather than silently rewritten.
 *
 * Applied to the breakdown columns too. None of them exceeds it today; the
 * ceiling is on the reader, not on one field, so a future typo in Adult Pax
 * cannot walk in through a door left open.
 */
export const PAX_MAX = 1000;

/** A pax cell → [count, wasClamped]. Negatives floor at 0, PAX_MAX is the roof. */
const paxInt = (v: unknown): [number, boolean] => {
  const n = num(v);
  if (n == null) return [0, false];
  const r = Math.max(0, Math.round(n));
  return r > PAX_MAX ? [PAX_MAX, true] : [r, false];
};

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * THE DEDUPE KEY — the owner's rule, encoded.
 *
 * "Booking Time is the Unique record of a booking."
 *
 * So identity is (outlet, guest, booking time): the moment the booking was
 * CREATED, which Reservego never changes once written. Deliberately NOT the Sno
 * column — that is a per-file row number, so row 1 of the January export and
 * row 1 of the February export both read "1", and keying on it would make every
 * subsequent file collide with the first. Deliberately NOT the reserved time
 * either: a guest can move their table to a new slot, and that is the same
 * booking being amended, which is exactly the case the spec says must UPDATE
 * rather than insert.
 *
 * Guest is part of the key because two different guests can book in the same
 * second, and outlet because the same is true across venues.
 *
 * ── AND THE RESERVED DATE, BECAUSE BOOKING TIME ALONE IS NOT UNIQUE ────────
 * The rule as first written was disproved by the owner's own data. In
 * BookingsService_31-12-2025, Sno 667 and Sno 1000 are the same guest
 * (9052317930) with the IDENTICAL Booking Time 2025-12-31 21:00:00, but
 * different reserved dates and different statuses — two real bookings made in
 * the same second, not one booking exported twice. Keyed on booking time alone
 * they collapsed into one row, and the second write inherited the first's
 * seated stamp: a booking marked pending with arrived=1, giving a guest who
 * never came a 100% arrival rate, on the first import, from one file.
 *
 * The reserved DATE is the tiebreak (the owner's decision, 2026-08-13). Date
 * rather than the full timestamp so that moving a table from 20:00 to 21:30 on
 * the same evening still UPDATES the booking, which is the amendment case the
 * spec explicitly requires. Moving it to another day mints a new key and is
 * therefore recorded as a separate booking.
 */
export function dedupeKeyFor(
  outlet: string,
  gk: GuestKey,
  bookingTime: string,
  reservedDate: string,
): string {
  return [
    outlet.toLowerCase(),
    gk ? `${gk.kind}:${gk.key}` : 'anon',
    bookingTime,
    reservedDate || '-',
  ].join('|');
}

export function mapRow(row: ReservegoRow): MappedBooking | { error: string } {
  const gk = guestKey(row);
  const bookingTime = parseStamp(row['Booking Time']);
  const reservedTime = parseStamp(row['Reserved Time']);
  const outlet = str(row['Outlet Name']) || 'Unknown';

  // Both are refusals rather than best guesses: a booking with no identifiable
  // guest cannot join a customer profile, and one with no booking time has no
  // stable identity, so re-importing the file would duplicate it every time.
  if (!gk) return { error: 'no guest phone, email or name — cannot attribute to a customer' };
  if (!bookingTime) return { error: `unreadable Booking Time ${JSON.stringify(str(row['Booking Time']))}` };

  const rawStatus = str(row['Booking Status']);
  const status = mapStatus(rawStatus);
  const seatedTime = parseStamp(row['Seated Time']);
  // IDENTITY ONLY. Kept exactly as it has always been because dedupeKeyFor()
  // and the same-day grouping are built on it; see the bookingDate field note
  // and slotStampOf for why this is the CREATION moment and not the slot.
  const effective = reservedTime || bookingTime;
  // DISPLAY AND ANALYTICS. The night they were coming — measured, not assumed.
  const night = deriveDay(slotStampOf(bookingTime, reservedTime));

  // Every pax cell goes through the same ceiling, and the row remembers whether
  // any of them hit it — see PAX_MAX.
  let clamped = false;
  const pax = (v: unknown): number => {
    const [n, hit] = paxInt(v);
    if (hit) clamped = true;
    return n;
  };
  const paxTotal = pax(row['Pax']);
  const paxBreakdown = {
    adult: pax(row['Adult Pax']), child: pax(row['Child Pax']),
    veg: pax(row['Veg Pax']), non_veg: pax(row['Non-Veg Pax']),
    male: pax(row['Male Pax']), female: pax(row['Female Pax']),
    infant: pax(row['Infant Pax']), couple: pax(row['Couple Pax']),
    male_stag: pax(row['Male Stags Pax']), female_stag: pax(row['Female Stags Pax']),
  };

  return {
    dedupeKey: dedupeKeyFor(outlet, gk, bookingTime, stampDate(effective)),
    guest: {
      key: gk,
      name: normName(row['Guest Name']),
      phone10: phone10(row['Guest Number']),
      email: normEmail(row['Guest Email']),
    },
    outlet,
    bookingTime,
    reservedTime,
    seatedTime,
    bookingDate: stampDate(effective),
    slotStamp: slotStampOf(bookingTime, reservedTime),
    reservedDate: night.reservedDate,
    dayOfWeek: night.dayOfWeek,
    dow: night.dow,
    slotTime: night.slotTime,
    // "Vist Count" — Reservego's spelling, read exactly as written. A negative
    // (5 rows in 83,658 carry -1) is not a visit count, so it reads as "not
    // reported" rather than as a number that would then be compared to ours.
    visitCount: (() => { const n = num(row['Vist Count']); return n != null && n >= 0 ? Math.round(n) : null; })(),
    bookingType: str(row['Booking Type']),
    status,
    rawStatus,
    arrived: isArrived(status, seatedTime),
    pax: paxTotal,
    paxBreakdown,
    paxClamped: clamped,
    reservedBy: str(row['Reserved By']),
    sections: str(row['Section(s)']),
    tables: str(row['Table(s)']),
    source: str(row['Source of Booking']),
    preferences: str(row['Preferences']),
    tags: str(row['Tags']),
    guestComments: str(row['Guest Comments']),
    outletComments: str(row['Outlet Comments']),
    deletionType: str(row['Deletion Type']),
    deletionReason: str(row['Deleted Reason']),
    billAmount: num(row['Bill Amount']),
    billNumber: str(row['Bill Number']),
    bookingAmount: num(row['Booking Amount']),
    bookingTxnId: str(row['Booking Amount Tranx ID']),
    bookingPaymentStatus: str(row['Booking Amount Payment Status']),
    bookingPaymentDate: parseStamp(row['Booking Amount Payment Date']),
  };
}

/* ── same-day duplicate collapse ──────────────────────────────────────────── */

/**
 * The owner's second rule:
 *
 *   "On a Same Date if there are same mobile numbers then they are Duplicates.
 *    From that take: if it is checked in then take it as a single record; if the
 *    duplicate is also not checked in take it as a single record."
 *
 * Reservego emits a fresh row when a guest is re-booked or moved on the same
 * evening, so one visit can appear two or three times. Counting them all would
 * overstate booking volume and understate the arrival rate, because only one of
 * the copies ever gets seated.
 *
 * WHICH COPY SURVIVES, in order:
 *   1. an ARRIVED one (seated or checked out) — the visit that actually happened
 *   2. failing that, the one with the most information (a bill, then a later
 *      booking time), so a cancelled row never beats a confirmed one purely by
 *      arriving first in the file
 *
 * The losers are not discarded: the caller records them as collapsed duplicates
 * in the import summary, so the numbers in Import History add up and nobody has
 * to wonder where 300 rows went.
 *
 * ── IT MUST BE APPLIED TO THE WHOLE HISTORY, NEVER TO A BATCH ─────────────
 * This function is pure and will happily collapse whatever list it is handed —
 * which is the trap. The importer uploads in 2,000-row batches, and running the
 * collapse per batch made the outcome depend on WHERE THE FILE HAPPENED TO BE
 * CUT: the same pair collapsed when it sat mid-batch and did not when a wider
 * export pushed it across a boundary, leaving a permanent phantom booking that
 * no later import could remove. Reproduced end to end at the production batch
 * size.
 *
 * So callers must run it over a guest's ENTIRE stored history at the end of an
 * import, not over the rows of one request. See markDuplicateGroups below,
 * which is the shape the importer actually uses.
 */
export interface CollapseResult { kept: MappedBooking[]; collapsed: MappedBooking[] }

export function collapseSameDayDuplicates(rows: MappedBooking[]): CollapseResult {
  const groups = new Map<string, MappedBooking[]>();
  const ungrouped: MappedBooking[] = [];
  for (const r of rows) {
    // The rule is stated in terms of MOBILE NUMBERS, so it applies only where
    // there is one. An email-or-name-keyed row is far weaker evidence of
    // identity and is never collapsed on that basis.
    if (!r.guest.phone10 || !r.bookingDate) { ungrouped.push(r); continue; }
    const k = `${r.outlet.toLowerCase()}|${r.guest.phone10}|${r.bookingDate}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const kept: MappedBooking[] = [...ungrouped];
  const collapsed: MappedBooking[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) { kept.push(g[0]); continue; }
    const ranked = [...g].sort((a, b) => {
      if (a.arrived !== b.arrived) return a.arrived ? -1 : 1;
      const ab = a.billAmount ?? -1, bb = b.billAmount ?? -1;
      if (ab !== bb) return bb - ab;
      return b.bookingTime.localeCompare(a.bookingTime);
    });
    kept.push(ranked[0]);
    collapsed.push(...ranked.slice(1));
  }
  return { kept, collapsed };
}

/* ── customer metrics ─────────────────────────────────────────────────────── */

/** The lifetime figures the CRM reports per guest. */
export interface GuestMetrics {
  total_bookings: number;
  arrived_visits: number;
  cancelled_bookings: number;
  no_shows: number;
  arrival_rate: number;       // 0..1, arrived / total
  total_pax: number;
  total_spend: number;
  avg_spend: number;          // per ARRIVED visit, not per booking
  first_booking: string;
  last_booking: string;
  sources: string[];
  visit_frequency_days: number | null;  // mean gap between arrived visits
}

/**
 * Computed from a guest's bookings, in one place, so the Customers list, the
 * guest 360 and any export can never disagree about what "arrival rate" means.
 *
 * avg_spend divides by ARRIVED visits rather than by bookings on purpose: a
 * guest who books ten times, comes twice and spends 10,000 has an average spend
 * of 5,000 per visit, not 1,000 per booking. Dividing by bookings would make
 * every no-show look like a discount.
 */
export function computeGuestMetrics(bookings: Array<{
  status: BookingStatus | null; arrived: boolean; pax: number;
  billAmount: number | null; bookingDate: string; source: string;
}>): GuestMetrics {
  const total = bookings.length;
  const arrivedRows = bookings.filter((b) => b.arrived);
  const spend = arrivedRows.reduce((s, b) => s + (b.billAmount || 0), 0);
  const dates = bookings.map((b) => b.bookingDate).filter(Boolean).sort();
  const visitDates = [...new Set(arrivedRows.map((b) => b.bookingDate).filter(Boolean))].sort();

  let freq: number | null = null;
  if (visitDates.length >= 2) {
    const first = Date.parse(visitDates[0] + 'T00:00:00Z');
    const last = Date.parse(visitDates[visitDates.length - 1] + 'T00:00:00Z');
    if (Number.isFinite(first) && Number.isFinite(last)) {
      freq = Math.round((last - first) / 86400000 / (visitDates.length - 1));
    }
  }
  return {
    total_bookings: total,
    arrived_visits: arrivedRows.length,
    cancelled_bookings: bookings.filter((b) => b.status === 'cancelled').length,
    no_shows: bookings.filter((b) => b.status === 'no_show').length,
    arrival_rate: total ? arrivedRows.length / total : 0,
    total_pax: bookings.reduce((s, b) => s + (b.pax || 0), 0),
    total_spend: Math.round(spend * 100) / 100,
    avg_spend: arrivedRows.length ? Math.round((spend / arrivedRows.length) * 100) / 100 : 0,
    first_booking: dates[0] || '',
    last_booking: dates[dates.length - 1] || '',
    sources: [...new Set(bookings.map((b) => b.source).filter(Boolean))].sort(),
    visit_frequency_days: freq,
  };
}

/* ── deciding duplicates over stored history ──────────────────────────────── */

/**
 * The same-day rule applied to rows ALREADY IN THE DATABASE, which is the only
 * place it can be applied correctly.
 *
 * Every Reservego row is written and keeps its own key, so nothing is ever lost
 * and a re-import always converges; this then decides, per (guest, date), which
 * stored row represents the visit and which are its duplicates. Because it sees
 * the whole history rather than one upload's worth, the answer is identical no
 * matter how the file was split, re-exported or re-uploaded — the property the
 * per-batch version could not have.
 *
 * ONLY IMPORTED ROWS ARE ELIGIBLE. The caller passes Reservego-sourced bookings
 * only (import_id IS NOT NULL). The CRM's own phone bookings are NOT Reservego
 * exports and two of them on one evening are two real bookings; an earlier
 * version collapsed those too and silently deleted genuine history from a
 * module this feature was only supposed to add to.
 *
 * Returns the ids to mark as duplicates. Marking, not deleting: the row stays
 * visible and auditable, the Import History counts add up, and if the rule ever
 * changes the decision can simply be recomputed.
 */
export interface StoredBookingRow {
  id: string;
  phone10: string;
  outlet: string;
  bookingDate: string;
  arrived: boolean;
  billAmount: number | null;
  bookingTime: string;
}

export function markDuplicateGroups(rows: StoredBookingRow[]): { primaryIds: string[]; duplicateIds: string[] } {
  const groups = new Map<string, StoredBookingRow[]>();
  const primaryIds: string[] = [];
  const duplicateIds: string[] = [];
  for (const r of rows) {
    // The rule is stated in terms of mobile numbers, so a row without one is
    // never collapsed on weaker evidence.
    if (!r.phone10 || !r.bookingDate) { primaryIds.push(r.id); continue; }
    const k = `${r.outlet.toLowerCase()}|${r.phone10}|${r.bookingDate}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) { primaryIds.push(g[0].id); continue; }
    const ranked = [...g].sort((a, b) => {
      if (a.arrived !== b.arrived) return a.arrived ? -1 : 1;
      const ab = a.billAmount ?? -1, bb = b.billAmount ?? -1;
      if (ab !== bb) return bb - ab;
      const t = b.bookingTime.localeCompare(a.bookingTime);
      // id last so the order is TOTAL: without it two rows equal on every other
      // field would rank by Array.sort's unspecified tie behaviour, and the
      // primary could change between two runs over identical data.
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
    primaryIds.push(ranked[0].id);
    duplicateIds.push(...ranked.slice(1).map((r) => r.id));
  }
  return { primaryIds, duplicateIds };
}
