'use client';

/**
 * CRM › Reservation Database — the Reservego CSV becomes ONE guest database.
 *
 * Three tabs over the same two tables the CRM already owns (ct_guests as the
 * customer master, ct_bookings as booking history):
 *   Customers      — the guest master with its denormalised lifetime metrics
 *   Bookings       — every booking row, searchable/filterable, guest-scoped
 *   Import History — one card per upload, with the failed-row reasons
 *
 * ── WHY THE UPLOAD IS PARSED HERE AND SENT IN BATCHES ──────────────────────
 * Production is ~106,000 rows / ~30 MB. Measured on this machine with
 * better-sqlite3, that is 1.1s of upserts, 0.4s for an idempotent re-import and
 * 12ms for the metric rollup — so the database is not the bottleneck, the WIRE
 * is. A 30MB JSON body is refused by the proxy long before SQLite is asked to
 * do anything, and even if it were accepted the owner would stare at a frozen
 * button for minutes with no idea whether it was working.
 *
 * So the browser parses the file with papaparse and POSTs it as ~53 batches of
 * 2,000 rows against one import session. That buys three things a single body
 * cannot: a real rows-done/rows-total progress bar, a per-batch retry when a
 * venue link blips, and a partial upload that is safe to re-run — the importer
 * keys on reservego_key (dedupeKeyFor: outlet + guest + Booking Time), so the
 * rows already applied are recognised, not duplicated.
 *
 * ── WHY THE FILE IS PARSED TWICE ───────────────────────────────────────────
 * POST import/start needs rows_total, and a streaming parse only knows the row
 * count when it reaches the end. The alternative — buffer all 106k rows to
 * count them — holds roughly a quarter of a gigabyte of row objects in the tab
 * before a single byte is sent. So pass one counts rows and reads the header
 * (memory stays flat, nothing is retained), pass two streams and uploads. The
 * counting pass also validates the header BEFORE a session row is created, so
 * pointing the picker at the wrong CSV cannot leave an orphan 'running' import
 * in the history.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import type { ReservegoRow } from '@/lib/reservego';
import {
  Database,
  Users,
  CalendarCheck,
  History,
  Upload,
  Download,
  Search,
  X,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Trash2,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  FileSpreadsheet,
  CalendarDays,
  Phone,
  SlidersHorizontal,
  Table2,
  Terminal,
  Play,
} from 'lucide-react';

const PAGE_SIZE = 25;

/**
 * 500 rows per POST.
 *
 * THE 2,000 THAT WAS HERE MADE EVERY UPLOAD FAIL WITH HTTP 413, and the comment
 * that justified it was simply wrong: it claimed "≈ 600KB … comfortably inside
 * any proxy body limit". Measured on the owner's real export, a Reservego row is
 * ~901 bytes of JSON (38 columns, every value a string), so 2,000 rows is
 * ~1.76 MB.
 *
 * And the ceiling is 1 MB, not 25. Probed against production directly: a 900 KB
 * body reaches the app (401), 1,100 KB is refused by the proxy (413). The
 * repo's deploy/nginx.conf does say client_max_body_size 25M — the live box is
 * not running it, which is consistent with those AWS deploy scripts being stale.
 * So the app must fit the limit that EXISTS, not the one that is checked in.
 *
 * 500 x 901 B ≈ 440 KB, less than half the ceiling, which leaves room for rows
 * fatter than the sample (long guest comments, many tags) without going over.
 * A 40 MB file is ~44,000 rows ≈ 88 requests; the 110k-row file ~220. That costs
 * nothing that matters: the database side was measured at 1.1 s for 106,000
 * rows, so this upload is entirely wire-bound either way, and more, smaller
 * requests also make the progress bar honest.
 */
const BATCH_ROWS = 500;

/** How many times a 413 may halve a batch before we admit defeat. 500 -> 250 ->
 *  125 -> 62 -> 31 -> 15; if 15 rows still will not fit, the limit is not a
 *  body-size problem and retrying smaller is just a slower failure. */
const MAX_SPLIT_DEPTH = 5;

/**
 * Pause between batches, in milliseconds.
 *
 * WHY AN UPLOAD HAS TO BE POLITE HERE. The server is ONE Node thread and
 * better-sqlite3 is SYNCHRONOUS, so while a batch is being written nothing else
 * on the box is served — not billing, not a KOT, not a captain's order. Firing
 * ~220 batches back to back for a 110k-row file therefore does not merely load
 * the server, it holds the restaurant's till closed for the duration, and nginx
 * starts answering 504 to whoever was waiting.
 *
 * 150 ms is long enough for the queued requests of a busy service to drain
 * between writes, and costs the upload about 33 seconds across 220 batches —
 * nothing against an import that is measured in minutes, and the difference
 * between a slow upload and a frozen venue.
 */
const BATCH_PAUSE_MS = 150;

/** 2MB read slices. Papa's own default is 10MB; smaller slices make the
 *  progress bar update several times per second instead of once per 10MB. */
const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * Columns the importer cannot work without. Booking Time IS the identity of a
 * booking (the owner's rule), Outlet Name scopes it, and Guest Number is the
 * strongest identity key. Anything else missing is survivable; these three are
 * not, so a file lacking them is refused before an import session exists.
 */
const REQUIRED_COLUMNS = ['Booking Time', 'Outlet Name', 'Guest Number'];

/** The 38 columns of the owner's export, for the "missing columns" warning. */
const EXPECTED_COLUMNS = [
  'Sno', 'Outlet Name', 'Booking Time', 'Seated Time', 'Reserved Time', 'Booking Type',
  'Guest Name', 'Guest Number', 'Guest Email', 'Pax', 'Adult Pax', 'Child Pax', 'Veg Pax',
  'Non-Veg Pax', 'Male Pax', 'Female Pax', 'Infant Pax', 'Couple Pax', 'Male Stags Pax',
  'Female Stags Pax', 'Reserved By', 'Section(s)', 'Table(s)', 'Vist Count', 'Booking Status',
  'Deletion Type', 'Deleted Reason', 'Source of Booking', 'Preferences', 'Tags',
  'Guest Comments', 'Outlet Comments', 'Bill Amount', 'Bill Number', 'Booking Amount',
  'Booking Amount Tranx ID', 'Booking Amount Payment Status', 'Booking Amount Payment Date',
];

/* ── the shapes the API returns (contract D) ───────────────────────────────── */

interface CustomerRow {
  id: string;
  name: string | null;
  phone_e164: string | null;
  phone10: string | null;
  email: string | null;
  total_bookings: number;
  arrived_visits: number;
  cancelled_bookings: number;
  no_shows: number;
  arrival_rate: number;          // 0..1
  total_pax: number;
  total_spend: number;
  avg_spend: number;
  first_booking: string | null;
  last_booking: string | null;
  booking_sources: string | null;
  visit_frequency_days: number | null;
  metrics_updated_at: string | null;
}

interface BookingRow {
  id: string;
  guest_id: string | null;
  guest_name?: string | null;
  guest_phone?: string | null;
  booking_date: string | null;
  slot_time: string | null;
  party_size: number | null;
  status: string | null;
  reservego_status: string | null;
  booking_time: string | null;
  reserved_time: string | null;
  booking_type: string | null;
  outlet_name: string | null;
  pax_breakdown: string | null;   // JSON
  reserved_by: string | null;
  sections: string | null;
  tables_csv: string | null;
  source: string | null;
  preferences: string | null;
  tags: string | null;
  guest_comments: string | null;
  outlet_comments: string | null;
  deletion_type: string | null;
  deletion_reason: string | null;
  bill_amount: number | null;
  bill_number: string | null;
  booking_amount: number | null;
  booking_txn_id: string | null;
  booking_payment_status: string | null;
  booking_payment_date: string | null;
  arrived: number | null;
  /** 1 when the same-day rule says another stored row IS this visit. Shown as a
   *  label, never used to hide the row — see the Duplicate chip below. */
  is_duplicate: number | null;
  import_id: string | null;
}

/** The counters import/batch returns as it runs, and import/finish returns final. */
interface Counters {
  rows_total?: number;
  rows_processed?: number;
  new_bookings?: number;
  updated_bookings?: number;
  duplicate_rows?: number;
  collapsed_rows?: number;
  new_customers?: number;
  updated_customers?: number;
  failed_rows?: number;
  /** Rows refused because the stored booking came from a NEWER export. */
  skipped_stale?: number;
  /** Rows whose Pax was above the ceiling and was cut down to it. */
  pax_clamped?: number;
  errors_json?: string | null;
}

interface ImportRow extends Counters {
  id: string;
  file_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: string | null;         // running | completed | failed
  imported_by: string | null;
  created_at: string | null;
  /** When the Reservego export was taken, and how we know — 'filename' (the
   *  export stamp Reservego puts in the name), 'file-max-booking-time' (the
   *  browser's fallback), or 'none'. An undated import cannot out-rank a dated
   *  row, so this is worth showing next to the file name. */
  source_exported_at?: string | null;
  stamp_source?: string | null;
}

/**
 * What "delete this upload" costs, as counted by the server.
 *
 * THE SAME THIRTEEN NUMBERS come back from GET …?preview=1 (before anything is
 * touched) and from the DELETE itself (what actually went), which is what lets
 * the confirm panel promise a figure and then report against it — and on BOTH
 * surfaces they are nested under `counts`.
 *
 * The reader that used to live here looked for `json.preview` and `json.deleted`
 * envelopes that neither endpoint has ever emitted, then coerced every miss to a
 * confident 0. Measured against production: the server said 371 bookings / 354
 * guests / 100 inherited and the panel rendered 0 / 0 / 0 — with the button
 * still live, because "is there an object?" was the enable test and a zeroed
 * object is an object. A button reading "Delete 0 bookings" destroyed 371 rows.
 * So the parse below is strict and total: all thirteen keys, every one a finite
 * number, or the body is rejected whole and the button stays off (readCounts).
 *
 * bookings_from_earlier_imports is the honest one: ct_bookings.import_id is
 * re-stamped on every UPDATE, so a booking an earlier file created and this one
 * merely re-confirmed now carries THIS import's id and would be deleted with
 * it. It is shown as a warning, not a footnote — but only when `provenance`
 * says the server was able to measure it at all.
 */
interface UndoCounts {
  bookings_to_delete: number;
  guests_to_delete: number;
  guests_to_keep: number;
  bookings_from_earlier_imports: number;
  bookings_created_before_this_import: number;
  bookings_with_older_export_stamp: number;
  guests_affected: number;
  guests_kept_orphan: number;
  bookings_linked_elsewhere: number;
  duplicates_recleared: number;
  duplicates_redemoted: number;
  guests_profile_cleared: number;
  guest_fields_blanked: number;
}

/** The thirteen names the server guarantees, and the only thirteen accepted. */
const COUNT_KEYS = [
  'bookings_to_delete',
  'guests_to_delete',
  'guests_to_keep',
  'bookings_from_earlier_imports',
  'bookings_created_before_this_import',
  'bookings_with_older_export_stamp',
  'guests_affected',
  'guests_kept_orphan',
  'bookings_linked_elsewhere',
  'duplicates_recleared',
  'duplicates_redemoted',
  'guests_profile_cleared',
  'guest_fields_blanked',
] as const;

/**
 * GET …?preview=1 — what the delete WOULD do.
 *
 * `provenance` is the one that stops this panel lying by omission. The three
 * "did this row predate the upload" counts are only meaningful when the upload's
 * own session row survives to be compared against; for orphaned rows carrying a
 * dead import id there is nothing to compare to, the server sends 'unknown', and
 * the panel must say it cannot tell rather than print a reassuring 0.
 *
 * `import` is a reserved word. Alias it (`const summary = preview.import`) —
 * never destructure it.
 */
interface UndoPreview {
  import: any | null;
  counts: UndoCounts;
  notice: string[];
  deletable: boolean;
  blocked_reason: string;
  provenance: 'measured' | 'unknown';
}

/** DELETE — what actually went. */
interface UndoResult {
  found: boolean;
  already_deleted: boolean;
  counts: UndoCounts;
  guests_refreshed: number;
  import_deleted: boolean;
  notice: string[];
  provenance: 'measured' | 'unknown';
}

type Tab = 'customers' | 'bookings' | 'imports' | 'query';
type ImportPhase = 'idle' | 'counting' | 'uploading' | 'finishing' | 'done' | 'error';

/* ── the Query tab's shapes ────────────────────────────────────────────────── */

interface SchemaColumn { name: string; type?: string }
interface SchemaTable { table: string; columns: SchemaColumn[] }

interface SqlResult {
  columns: string[];
  /** A row may arrive as an object keyed by column, or as a positional array. */
  rows: unknown[];
  rowCount: number;
  ms: number;
}

interface BandOption { id: string; label: string }

/**
 * What the band filter actually did, as the query engine reports it back.
 *
 * A band is MANY nights — the engine ORs one window per night the act played —
 * so this says how many nights answered, over what range, and what it could not
 * use. The skipped list is not decoration: a calendar row with an unreadable
 * start time or a broken date is left OUT of the answer, and this is the only
 * way the person reading the number finds out. Nothing here is derived from
 * `qBand`; it is read from the response, because the picker is a debounce ahead
 * of the result and the two must never be shown disagreeing.
 */
interface BandEchoNight {
  event_date: string;
  type: string;
  start_time: string;
  match_from: string;
  clamped: boolean;
}
interface BandEchoSkip {
  event_date: string;
  start_time: string;
  reason: string;
}
interface BandEcho {
  name: string;
  leadIn: number;
  nights: number;
  windows: number;
  firstNight: string;
  lastNight: string;
  clamped: boolean;
  capped: boolean;
  cap: number;
  nightList: BandEchoNight[];
  skipped: BandEchoSkip[];
}

/* ── formatting ────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Dates are formatted by STRING SURGERY, never through `new Date()`.
 * reservego.ts keeps every stamp as naive local text ('YYYY-MM-DD HH:MM:SS')
 * because the whole file is one outlet in one timezone and every other date
 * column in this database is naive too. Parsing them into a Date here would
 * have the browser re-interpret them in ITS zone and shift a 00:30 booking onto
 * the previous evening.
 */
function fmtDate(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

function fmtStamp(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const d = fmtDate(s);
  if (!d) return '';
  const t = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(s);
  return t ? `${d}, ${t[1]}` : d;
}

const fmtInt = (n: unknown): string => Number(n ?? 0).toLocaleString('en-IN');

function fmtMoney(n: unknown): string {
  const v = Number(n ?? 0);
  return `₹${(Number.isFinite(v) ? v : 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

const fmtPct = (rate: unknown): string => `${Math.round((Number(rate) || 0) * 100)}%`;

const dash = <span className="text-[#C4B09A]">—</span>;

/* ── tolerant readers for the list payloads ────────────────────────────────── */

/**
 * The routes under /api/crm/reservations/ are written by another agent in this
 * same build. Reading the rows under the contract key OR the two obvious
 * synonyms costs one line and turns a shape disagreement into an empty table
 * instead of a white screen from `.map` of undefined.
 */
function listOf<T>(json: any, key: string): T[] {
  const v = json?.[key] ?? json?.rows ?? json?.data ?? json;
  return Array.isArray(v) ? (v as T[]) : [];
}

function totalOf(json: any, fallback: number): number {
  const t = Number(json?.total ?? json?.count);
  return Number.isFinite(t) ? t : fallback;
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return String(j?.error || j?.message || `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * errorText's sibling for the one caller that needs the machine-readable half.
 *
 * The delete route's 409 carries `code: 'import_running'` beside its sentence,
 * and the force affordance keys off THAT — never off the prose, which is a
 * human string that may be reworded at any time without anyone thinking they
 * have changed a wire contract. errorText keeps its signature; it has other
 * callers.
 */
async function errorBody(res: Response): Promise<{ message: string; code: string }> {
  try {
    const j = await res.json();
    return {
      message: String(j?.error || j?.message || `HTTP ${res.status}`),
      code: typeof j?.code === 'string' ? j.code : '',
    };
  } catch {
    return { message: `HTTP ${res.status}`, code: '' };
  }
}

interface FailedRow { row?: number; reason: string }

/** errors_json is written server-side; accept a list of strings or of objects. */
function parseFailures(raw: unknown): FailedRow[] {
  if (!raw) return [];
  let v: any = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === '[]' || s === 'null') return [];
    try { v = JSON.parse(s); } catch { return [{ reason: s }]; }
  }
  if (!Array.isArray(v)) return [];
  return v.map((e: any) => {
    if (typeof e === 'string') return { reason: e };
    const n = Number(e?.row ?? e?.line ?? e?.index);
    return {
      row: Number.isFinite(n) ? n : undefined,
      reason: String(e?.error ?? e?.reason ?? e?.message ?? JSON.stringify(e)),
    };
  });
}

/**
 * ── THE STRICT PARSERS FOR THE DESTRUCTIVE PANEL ────────────────────────────
 *
 * Everywhere else on this page a tolerant reader is the right call: a shape
 * disagreement should degrade into an empty table, not a white screen. Here it
 * is the opposite. This panel arms a button that deletes hundreds of rows, and
 * the only thing standing between the owner and a delete he cannot see the size
 * of is whether these numbers are real.
 *
 * So: no `Number()` coercion, no `?? 0`, no synonyms, no partial acceptance.
 * A body either matches the contract exactly or it is rejected whole and comes
 * back as `null`, which the caller treats as "we do not know" — the same state
 * as still-loading and as fetch-failed, and in all three the button is dead.
 * A missing count is NOT a zero, and this is the line where the difference is
 * enforced.
 */
function readCounts(raw: any): UndoCounts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const k of COUNT_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    // Deliberately typeof-then-finite: a numeric STRING, null, undefined, NaN
    // and Infinity all fail. Coercing any of them is the original bug.
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  const c = out as unknown as UndoCounts;
  // The server guarantees this partition on both paths. A body that breaks it
  // is not this contract, and is not to be trusted with a destructive button.
  if (c.guests_affected !== c.guests_to_delete + c.guests_to_keep + c.guests_kept_orphan) return null;
  return c;
}

/** notice carries the server's warnings. An unreadable one is never silently
 *  emptied to [] — that would drop the disclosure and keep the button. */
function readNotice(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const line of v) if (typeof line !== 'string') return null;
  return v as string[];
}

function readProvenance(v: unknown): 'measured' | 'unknown' | null {
  return v === 'measured' || v === 'unknown' ? v : null;
}

function readUndoPreview(json: any): UndoPreview | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const counts = readCounts(json.counts);
  if (!counts) return null;
  const notice = readNotice(json.notice);
  if (!notice) return null;
  const provenance = readProvenance(json.provenance);
  if (!provenance) return null;
  if (typeof json.deletable !== 'boolean') return null;
  if (typeof json.blocked_reason !== 'string') return null;
  // The session row is the only tolerated shape variation: object or null.
  const summary = json.import ?? null;
  return { import: summary, counts, notice, deletable: json.deletable,
           blocked_reason: json.blocked_reason, provenance };
}

function readUndoResult(json: any): UndoResult | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const counts = readCounts(json.counts);
  if (!counts) return null;
  const notice = readNotice(json.notice);
  if (!notice) return null;
  const provenance = readProvenance(json.provenance);
  if (!provenance) return null;
  if (typeof json.found !== 'boolean') return null;
  if (typeof json.already_deleted !== 'boolean') return null;
  if (typeof json.import_deleted !== 'boolean') return null;
  if (typeof json.guests_refreshed !== 'number' || !Number.isFinite(json.guests_refreshed)) return null;
  return { found: json.found, already_deleted: json.already_deleted, counts,
           guests_refreshed: json.guests_refreshed, import_deleted: json.import_deleted,
           notice, provenance };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ── status vocabulary (the one ct_bookings already uses) ──────────────────── */

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700 border-slate-300',
  confirmed: 'bg-blue-100 text-blue-700 border-blue-300',
  seated: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  completed: 'bg-green-100 text-green-700 border-green-300',
  cancelled: 'bg-red-100 text-red-700 border-red-300',
  no_show: 'bg-amber-100 text-amber-800 border-amber-300',
};

const STATUS_OPTIONS: [string, string][] = [
  ['', 'All statuses'],
  ['completed', 'Completed'],
  ['seated', 'Seated'],
  ['confirmed', 'Confirmed'],
  ['pending', 'Pending'],
  ['cancelled', 'Cancelled'],
  ['no_show', 'No-show'],
];

/**
 * Sort keys are sent as a single `sort=` param (contract D), so each option
 * carries its own natural direction in the LABEL rather than offering an
 * asc/desc toggle the API has no parameter for.
 */
const CUSTOMER_SORTS: [string, string][] = [
  ['last_booking', 'Last booking (newest)'],
  ['total_spend', 'Total spend (high → low)'],
  ['avg_spend', 'Avg spend (high → low)'],
  ['total_bookings', 'Bookings (most)'],
  ['arrived_visits', 'Visits (most)'],
  ['arrival_rate', 'Arrival rate (best)'],
  ['no_shows', 'No-shows (most)'],
  ['first_booking', 'First booking (oldest)'],
  ['name', 'Name (A → Z)'],
];

/* ── query tab vocabulary ──────────────────────────────────────────────────── */

/**
 * Day numbers are the ones ct_bookings.dow already stores — 0=Sunday…6=Saturday,
 * matching SQLite's strftime('%w') and deriveDay() in src/lib/reservego.ts. Any
 * other numbering here would silently ask for the wrong night.
 *
 * Listed Mon → Sun so Fri, Sat and Sun end up adjacent, because that is the
 * shape of the questions this tab exists for — "only Friday and Saturday" is
 * then two neighbouring clicks, and "only Sunday dinner" is one day chip plus
 * one meal chip. Nothing else has to be touched: an empty day list means every
 * day, so there is no "all" state to clear first.
 */
const DOW_OPTIONS: [number, string, string][] = [
  [1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [0, 'Sun', 'Sunday'],
];

/**
 * The whole vocabulary, not a sample: mealPeriodFor() in src/lib/reservego.ts
 * splits a slot at one configurable cutoff and returns 'lunch' or 'dinner' —
 * there is no third period to offer, and inventing one would filter on a value
 * ct_bookings.meal_period never holds. Still replaced by whatever the route
 * reports as `meal_periods`, so a future split lands here without an edit.
 */
const MEAL_FALLBACK: [string, string][] = [['lunch', 'Lunch'], ['dinner', 'Dinner']];

/** Page sizes for the results grid. The CSV button exports what is SHOWN, so
 *  the size selector is also how you choose how much lands in the file. */
const QUERY_PAGE_SIZES = [50, 100, 250, 500];

const QUERY_STATUSES = STATUS_OPTIONS.filter(([v]) => v);

/* ── generic renderers for server-shaped rows ──────────────────────────────── */

/** snake_case / camelCase → "Sentence case", for column heads and metric cards. */
function humanize(key: string): string {
  const s = String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

const isMoneyKey = (k: string) => /(spend|revenue|bill_amount|booking_amount|amount)/i.test(k) && !/(count|number|id)$/i.test(k);
const isRateKey = (k: string) => /(rate|pct|percent|share)/i.test(k);

/** A rate arrives either as a 0..1 fraction or as an already-multiplied
 *  percentage; treating >1 as a fraction would print "8300%". */
function fmtRate(v: number): string {
  return v <= 1 ? fmtPct(v) : `${Math.round(v * 10) / 10}%`;
}

/**
 * One cell, formatted from its COLUMN NAME because the query tab renders
 * whatever the server sends and cannot know the shape in advance. Dates go
 * through the same string surgery as the rest of the page — never `new Date()`
 * — and anything that is not a recognised stamp is printed verbatim rather
 * than guessed at, so 'slot_time' ("20:30") survives intact.
 */
function fmtCell(key: string, v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return dash;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (isMoneyKey(key)) return fmtMoney(v);
    if (isRateKey(key)) return fmtRate(v);
    return Number.isInteger(v) ? fmtInt(v) : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return fmtStamp(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
  return s;
}

function fmtAggregate(key: string, v: unknown): string {
  if (typeof v === 'number') {
    if (isMoneyKey(key)) return fmtMoney(v);
    if (isRateKey(key)) return fmtRate(v);
    return Number.isInteger(v) ? fmtInt(v) : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }
  const s = String(v ?? '').trim();
  return s || '—';
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(v => (v && typeof v === 'object' ? String((v as any).value ?? (v as any).name ?? (v as any).id ?? '') : String(v ?? '')))
    .map(s => s.trim())
    .filter(Boolean);
}

/** Adds only what is genuinely new, and returns the SAME array when nothing is
 *  — a fresh array every response would re-render every picker on every run. */
function mergeCapped(prev: string[], next: string[], cap: number): string[] {
  const add = next.filter(v => v && !prev.includes(v));
  if (add.length === 0) return prev;
  return [...prev, ...add].sort((a, b) => a.localeCompare(b)).slice(0, cap);
}

/**
 * The schema panel is fed from the endpoint rather than a list in this file so
 * it cannot drift from the real tables — which only works if a disagreement
 * about the WRAPPER shape does not blank the panel. Accepts
 * [{table, columns:[{name,type}|'name']}] and {table: [...]} alike.
 */
function normalizeSchema(raw: unknown): SchemaTable[] {
  const out: SchemaTable[] = [];
  const push = (name: unknown, cols: unknown) => {
    const table = String(name ?? '').trim();
    if (!table) return;
    const list = Array.isArray(cols) ? cols : [];
    out.push({
      table,
      columns: list
        .map((c: any): SchemaColumn => (typeof c === 'string'
          ? { name: c.trim() }
          : { name: String(c?.name ?? c?.column ?? c?.col ?? '').trim(), type: c?.type ? String(c.type) : undefined }))
        .filter(c => c.name),
    });
  };
  const src: any = (raw as any)?.tables ?? raw;
  if (Array.isArray(src)) {
    for (const t of src) {
      if (typeof t === 'string') { push(t, []); continue; }
      push(t?.table ?? t?.name, t?.columns ?? t?.cols ?? t?.fields);
    }
  } else if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) {
      push(k, Array.isArray(v) ? v : (v as any)?.columns ?? (v as any)?.fields);
    }
  }
  return out;
}

/**
 * Read the band echo off a query response, or null when no band was filtered.
 *
 * Deliberately NOT `listOf` — the echo is an object and listOf's fallback chain
 * would hand back [] and read as "no band". A response without `band` means the
 * filter was not used; a response WITH it always describes what happened, even
 * when the answer is zero nights (a band on the master that has never been put
 * on the calendar), which is a real state the page has to be able to explain
 * rather than leave looking like a broken filter.
 */
function readBandEcho(raw: unknown): BandEcho | null {
  const b = (raw as { band?: unknown } | null | undefined)?.band;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? '').trim();
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const rows = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).map(x => (x && typeof x === 'object' ? x as Record<string, unknown> : {}));
  return {
    name: str(o.name) || 'That band',
    leadIn: num(o.lead_in_minutes),
    nights: num(o.nights_matched),
    windows: num(o.windows_used),
    firstNight: str(o.first_night),
    lastNight: str(o.last_night),
    clamped: o.lead_in_clamped === true,
    capped: o.nights_capped === true,
    cap: num(o.nights_cap),
    nightList: rows(o.nights).map((n): BandEchoNight => ({
      event_date: str(n.event_date),
      type: str(n.type),
      start_time: str(n.start_time),
      match_from: str(n.match_from),
      clamped: n.lead_in_clamped === true,
    })),
    // Every skipped row is printed verbatim, never truncated — a night dropped
    // without a reason on screen is the thing this whole echo exists to prevent.
    skipped: rows(o.skipped).map((s): BandEchoSkip => ({
      event_date: str(s.event_date),
      start_time: str(s.start_time),
      reason: str(s.reason) || 'unusable calendar row',
    })),
  };
}

/** Column order: what the server declared, else the union of the row keys in
 *  the order they first appear (which is SQLite's SELECT order). */
function columnsFrom(json: any, rows: Record<string, unknown>[]): string[] {
  const declared = asStringList(json?.columns);
  if (declared.length) return declared;
  const seen: string[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  }
  return seen;
}

/* ── CSV of exactly what is on screen ──────────────────────────────────────── */

function toCsv(columns: string[], cells: (row: any, col: string, i: number) => unknown, rows: unknown[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(esc).join(',');
  const body = rows.map(r => columns.map((c, i) => esc(cells(r, c, i))).join(','));
  return [head, ...body].join('\r\n');
}

function downloadCsv(fileName: string, text: string) {
  // The BOM is what makes Excel read ₹ and Indian guest names as UTF-8 instead
  // of mojibake — the same reason the server-side export writes one.
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Local wall-clock stamp for a filename — never toISOString(), which would
 *  name a 1am file with yesterday's date. */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ══════════════════════════════════════════════════════════════════════════ */

export default function ReservationDatabasePage() {
  const [tab, setTab] = useState<Tab>('customers');

  /* ── import session ─────────────────────────────────────────────────────── */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [fileName, setFileName] = useState('');
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsSent, setRowsSent] = useState(0);
  /**
   * The same count as `rowsSent`, mirrored in a ref. runImport is one long-lived
   * async call that closes over the render it started in, so reading the STATE
   * in its catch block would report the row count from before the first batch
   * — i.e. "cancelled after 0 rows" no matter how much actually went up.
   */
  const sentRef = useRef(0);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [missingCols, setMissingCols] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  /* ── customers tab ──────────────────────────────────────────────────────── */
  const [custInput, setCustInput] = useState('');
  const [custQ, setCustQ] = useState('');
  const [custSort, setCustSort] = useState('last_booking');
  const [custPage, setCustPage] = useState(1);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [custTotal, setCustTotal] = useState(0);
  const [custLoading, setCustLoading] = useState(true);
  const [custError, setCustError] = useState<string | null>(null);

  /* ── bookings tab ───────────────────────────────────────────────────────── */
  const [bookInput, setBookInput] = useState('');
  const [bookQ, setBookQ] = useState('');
  const [bookStatus, setBookStatus] = useState('');
  const [bookFrom, setBookFrom] = useState('');
  const [bookTo, setBookTo] = useState('');
  const [guestFilter, setGuestFilter] = useState<{ id: string; label: string } | null>(null);
  const [bookPage, setBookPage] = useState(1);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [bookTotal, setBookTotal] = useState(0);
  /** How many of bookTotal are same-day duplicates — counted out of the
   *  headline figure and labelled in the list, never hidden. */
  const [bookDupTotal, setBookDupTotal] = useState(0);
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [openBooking, setOpenBooking] = useState<string | null>(null);

  /* ── import history tab ─────────────────────────────────────────────────── */
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [impLoading, setImpLoading] = useState(false);
  const [impError, setImpError] = useState<string | null>(null);
  const [openImport, setOpenImport] = useState<string | null>(null);

  /* ── deleting one upload ────────────────────────────────────────────────── */
  /**
   * No role check here on purpose. /crm-calls/database is adminOnly in
   * page-catalog.ts and every /api/crm/reservations/* route re-checks
   * me.role === 'admin' for itself, so a client-side gate would be a third copy
   * of the same rule that protects nothing the server does not already refuse.
   */
  const [delTarget, setDelTarget] = useState<ImportRow | null>(null);
  /** null means "we do not know what this would delete" — still loading, the
   *  fetch failed, or the body did not parse. All three keep the button dead. */
  const [delPreview, setDelPreview] = useState<UndoPreview | null>(null);
  const [delPreviewLoading, setDelPreviewLoading] = useState(false);
  const [delPreviewError, setDelPreviewError] = useState<string | null>(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [delRunning, setDelRunning] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  /** The `code` off the last failed DELETE. 'import_running' (409) is the one
   *  that means "there IS a way past this", and it arms the force block for a
   *  preview that was fetched before the upload was marked running. */
  const [delErrorCode, setDelErrorCode] = useState<string>('');
  /** The second, deliberate consent for overriding the still-running guard.
   *  Never sticky: it resets with every panel and every target. */
  const [delForceArmed, setDelForceArmed] = useState(false);
  const [delDone, setDelDone] = useState<{ file: string; result: UndoResult } | null>(null);

  /* ── query tab ──────────────────────────────────────────────────────────── */
  const [qDow, setQDow] = useState<number[]>([]);
  const [qMeal, setQMeal] = useState('');
  const [qFrom, setQFrom] = useState('');
  const [qTo, setQTo] = useState('');
  const [qTimeFrom, setQTimeFrom] = useState('');
  const [qTimeTo, setQTimeTo] = useState('');
  const [qStatus, setQStatus] = useState<string[]>([]);
  const [qSource, setQSource] = useState<string[]>([]);
  const [qBand, setQBand] = useState('');
  const [qOutlet, setQOutlet] = useState('');
  const [qLimit, setQLimit] = useState(QUERY_PAGE_SIZES[0]);
  const [qPage, setQPage] = useState(1);

  const [qRows, setQRows] = useState<Record<string, unknown>[]>([]);
  const [qCols, setQCols] = useState<string[]>([]);
  const [qTotal, setQTotal] = useState(0);
  const [qAgg, setQAgg] = useState<Record<string, unknown> | null>(null);
  /** Response-derived, NOT a filter — so it belongs in neither clearQueryFilters
   *  nor queryFilterCount, and it is replaced or nulled on every single run. */
  const [qBandInfo, setQBandInfo] = useState<BandEcho | null>(null);
  const [qSchema, setQSchema] = useState<SchemaTable[]>([]);
  const [qLoading, setQLoading] = useState(false);
  const [qError, setQError] = useState<string | null>(null);
  const [qRan, setQRan] = useState(false);

  /** Picker contents. Sourced from the response (facets when the route sends
   *  them, otherwise the values actually present in the rows) so the lists are
   *  the venue's real vocabulary and not a guess written into this file. */
  const [mealOptions, setMealOptions] = useState<[string, string][]>(MEAL_FALLBACK);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  const [outletOptions, setOutletOptions] = useState<string[]>([]);
  const [bandOptions, setBandOptions] = useState<BandOption[]>([]);
  const [sourceDraft, setSourceDraft] = useState('');

  /* ── advanced SQL ───────────────────────────────────────────────────────── */
  const [sqlText, setSqlText] = useState('');
  const [sqlRes, setSqlRes] = useState<SqlResult | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlRunning, setSqlRunning] = useState(false);

  const busy = phase === 'counting' || phase === 'uploading' || phase === 'finishing';

  /* ── debounced searches ─────────────────────────────────────────────────── */
  useEffect(() => {
    const t = setTimeout(() => { setCustQ(custInput.trim()); setCustPage(1); }, 300);
    return () => clearTimeout(t);
  }, [custInput]);

  useEffect(() => {
    const t = setTimeout(() => { setBookQ(bookInput.trim()); setBookPage(1); }, 300);
    return () => clearTimeout(t);
  }, [bookInput]);

  /* ── queries ────────────────────────────────────────────────────────────── */
  const customerQuery = useCallback((forExport: boolean) => {
    const p = new URLSearchParams();
    if (custQ) p.set('q', custQ);
    p.set('sort', custSort);
    if (!forExport) {
      p.set('limit', String(PAGE_SIZE));
      p.set('offset', String((custPage - 1) * PAGE_SIZE));
    }
    return p;
  }, [custQ, custSort, custPage]);

  const bookingQuery = useCallback((forExport: boolean) => {
    const p = new URLSearchParams();
    if (bookQ) p.set('q', bookQ);
    if (bookStatus) p.set('status', bookStatus);
    if (bookFrom) p.set('from', bookFrom);
    if (bookTo) p.set('to', bookTo);
    if (guestFilter) p.set('guest_id', guestFilter.id);
    if (!forExport) {
      p.set('limit', String(PAGE_SIZE));
      p.set('offset', String((bookPage - 1) * PAGE_SIZE));
    }
    return p;
  }, [bookQ, bookStatus, bookFrom, bookTo, guestFilter, bookPage]);

  const loadCustomers = useCallback(async (signal?: AbortSignal) => {
    setCustLoading(true);
    setCustError(null);
    try {
      const res = await fetch(`/api/crm/reservations/customers?${customerQuery(false)}`, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      const rows = listOf<CustomerRow>(json, 'customers');
      setCustomers(rows);
      setCustTotal(totalOf(json, rows.length));
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setCustError(e?.message || 'Could not load customers');
      setCustomers([]);
      setCustTotal(0);
    } finally {
      setCustLoading(false);
    }
  }, [customerQuery]);

  const loadBookings = useCallback(async (signal?: AbortSignal) => {
    setBookLoading(true);
    setBookError(null);
    try {
      const res = await fetch(`/api/crm/reservations/bookings?${bookingQuery(false)}`, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      const rows = listOf<BookingRow>(json, 'bookings');
      setBookings(rows);
      const total = totalOf(json, rows.length);
      setBookTotal(total);
      // live_total is the count that means "bookings": the same-day duplicates
      // are excluded from every guest metric in the CRM, so headlining the row
      // count here is what made the Bookings tab say 85,558 while the customer
      // totals behind it added to 81,982. The rows still all appear, labelled.
      // Falls back to the row count on an older server that ships neither.
      const dupes = Number(json?.duplicate_total ?? 0);
      setBookDupTotal(Number.isFinite(dupes) ? dupes : 0);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setBookError(e?.message || 'Could not load bookings');
      setBookings([]);
      setBookTotal(0);
      setBookDupTotal(0);
    } finally {
      setBookLoading(false);
    }
  }, [bookingQuery]);

  const loadImports = useCallback(async (signal?: AbortSignal) => {
    setImpLoading(true);
    setImpError(null);
    try {
      const res = await fetch('/api/crm/reservations/imports', { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      setImports(listOf<ImportRow>(json, 'imports'));
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setImpError(e?.message || 'Could not load import history');
      setImports([]);
    } finally {
      setImpLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'customers') return;
    const c = new AbortController();
    loadCustomers(c.signal);
    return () => c.abort();
  }, [tab, loadCustomers]);

  useEffect(() => {
    if (tab !== 'bookings') return;
    const c = new AbortController();
    loadBookings(c.signal);
    return () => c.abort();
  }, [tab, loadBookings]);

  useEffect(() => {
    if (tab !== 'imports') return;
    const c = new AbortController();
    loadImports(c.signal);
    return () => c.abort();
  }, [tab, loadImports]);

  /* ── the delete flow ────────────────────────────────────────────────────── */

  const askDelete = useCallback((im: ImportRow) => {
    setDelTarget(im);
    setDelPreview(null);
    setDelPreviewError(null);
    setDelConfirm('');
    setDelError(null);
    setDelErrorCode('');
    setDelForceArmed(false);
    setDelDone(null);
  }, []);

  const closeDelete = useCallback(() => {
    setDelTarget(null);
    setDelPreview(null);
    setDelPreviewError(null);
    setDelConfirm('');
    setDelError(null);
    setDelErrorCode('');
    setDelForceArmed(false);
  }, []);

  /**
   * The preview is fetched the moment the panel opens, and the Delete button
   * stays disabled until it lands. The owner asked to be told what an undo
   * costs BEFORE he can spend it — a panel that offered the button while the
   * numbers were still "…" would be a panel that let him guess.
   */
  useEffect(() => {
    if (!delTarget) return;
    const c = new AbortController();
    const id = delTarget.id;
    setDelPreviewLoading(true);
    setDelPreviewError(null);
    setDelForceArmed(false);
    (async () => {
      try {
        const res = await fetch(`/api/crm/reservations/imports/${encodeURIComponent(id)}?preview=1`,
                                { signal: c.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(await errorText(res));
        const parsed = readUndoPreview(await res.json());
        // Rejected outright rather than patched up. A panel that cannot read the
        // answer must not offer a button that acts on it.
        if (!parsed) throw new Error(
          'The server’s answer did not match what this panel knows how to read. Nothing has been deleted.');
        setDelPreview(parsed);
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setDelPreviewError(e?.message || 'Could not work out what this would delete');
      } finally {
        // Guarded: an aborted fetch settles AFTER the next target has already
        // set loading true, and clearing it here would show a ready panel with
        // no numbers in it.
        if (!c.signal.aborted) setDelPreviewLoading(false);
      }
    })();
    return () => c.abort();
  }, [delTarget]);

  /** Typing the file name is the deliberate act; DELETE is the way out when the
   *  name is long, or when the row has no name to type. */
  const delFileName = (delTarget?.file_name || '').trim();
  const delConfirmOk = (() => {
    const t = delConfirm.trim();
    if (!t) return false;
    return t.toUpperCase() === 'DELETE' || (delFileName !== '' && t === delFileName);
  })();

  /**
   * THE ONE ENABLE TEST FOR THE DESTRUCTIVE BUTTON.
   *
   * Derived once and handed both to the button's `disabled` and to runDelete's
   * own guard, because two hand-written approximations of the same rule is how
   * a guard and a button drift apart. Every clause is load-bearing:
   *
   *  · delPreview !== null   — a body that PASSED the strict parse. Not "is
   *    there an object", which is the test that let a panel reading
   *    "Delete 0 bookings" destroy 371 rows: unknown and zero are different
   *    states now, and only one of them arms this.
   *  · !delPreviewLoading    — numbers on screen belong to THIS target.
   *  · delConfirmOk          — the file name or DELETE was typed.
   *  · deletable || forceArmed — the server's refusal stands unless the owner
   *    has deliberately, separately overridden it.
   *
   * A genuinely empty import (counts all zero) stays enabled on purpose:
   * deleting nothing is harmless and idempotent, and the server answers 200
   * already_deleted.
   */
  const canDelete =
    delPreview !== null
    && !delPreviewLoading
    && !delRunning
    && delConfirmOk
    && (delPreview.deletable || delForceArmed);

  const runDelete = async () => {
    // The identical expression the button is disabled by — never a second,
    // looser copy of it.
    if (!canDelete) return;
    const im = delTarget;
    if (!im) return;
    // Read once: the URL and the label must not disagree if state moves.
    const forced = delForceArmed;
    setDelRunning(true);
    setDelError(null);
    try {
      // api(), not fetch(): a DELETE needs the CSRF header this wrapper adds.
      // ?force=1 is the server's only spelling, and it goes on ONLY when the
      // owner ticked the box — never as an automatic retry after a 409.
      const res = await api(
        `/api/crm/reservations/imports/${encodeURIComponent(im.id)}${forced ? '?force=1' : ''}`,
        { method: 'DELETE' });
      if (!res.ok) {
        // The code, not the prose, is what arms the force block: the sentence
        // is a human string that may be reworded without anyone thinking they
        // changed a wire contract.
        const body = await errorBody(res);
        setDelError(body.message);
        setDelErrorCode(body.code);
        return;
      }
      const result = readUndoResult(await res.json());
      if (!result) {
        // The delete may well have run — but a receipt this panel cannot read
        // is never painted green over numbers it had to invent.
        setDelError('The delete may have run, but the server’s answer did not match what this panel '
                  + 'knows how to read. Press Refresh and check Import History before trying again.');
        setDelErrorCode('');
        loadImports();
        return;
      }
      setDelDone({ file: im.file_name || 'Unnamed file', result });
      if (openImport === im.id) setOpenImport(null);
      setDelTarget(null);
      setDelPreview(null);
      setDelConfirm('');
      setDelErrorCode('');
      setDelForceArmed(false);
      loadImports();
    } catch (e: any) {
      setDelError(e?.message || 'That upload could not be deleted');
      setDelErrorCode('');
    } finally {
      setDelRunning(false);
    }
  };

  /* ── the query runner ───────────────────────────────────────────────────── */

  const queryBody = useCallback(() => ({
    // An empty array means "every one of them" on the wire — the route treats a
    // missing filter and an empty list the same, so there is no all-selected
    // state for the chips to fight with.
    dow: qDow,
    mealPeriod: qMeal,
    from: qFrom,
    to: qTo,
    timeFrom: qTimeFrom,
    timeTo: qTimeTo,
    status: qStatus,
    source: qSource,
    liveBandId: qBand,
    outlet: qOutlet,
    limit: qLimit,
    offset: (qPage - 1) * qLimit,
  }), [qDow, qMeal, qFrom, qTo, qTimeFrom, qTimeTo, qStatus, qSource, qBand, qOutlet, qLimit, qPage]);

  /** Keeps the pickers stocked from whatever the last response actually
   *  contained, without ever narrowing them — a filtered run returns fewer
   *  sources, and dropping the rest would make the filter un-widenable. */
  const absorbOptions = useCallback((json: any, rows: Record<string, unknown>[]) => {
    const facets = json?.facets ?? json?.options ?? {};
    const meals = asStringList(facets?.meal_periods ?? facets?.mealPeriods ?? json?.meal_periods);
    if (meals.length) setMealOptions(meals.map(m => [m, humanize(m)] as [string, string]));

    const srcSeen = [...asStringList(facets?.sources ?? facets?.source), ...rows.map(r => String(r?.source ?? '').trim())];
    setSourceOptions(prev => mergeCapped(prev, srcSeen, 300));

    const outSeen = [...asStringList(facets?.outlets ?? facets?.outlet), ...rows.map(r => String(r?.outlet_name ?? r?.outlet ?? '').trim())];
    setOutletOptions(prev => mergeCapped(prev, outSeen, 100));
  }, []);

  const runQuery = useCallback(async (signal?: AbortSignal) => {
    setQLoading(true);
    setQError(null);
    try {
      const res = await api('/api/crm/reservations/query', { method: 'POST', body: queryBody(), signal });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      const rows = listOf<Record<string, unknown>>(json, 'rows');
      setQRows(rows);
      setQCols(columnsFrom(json, rows));
      setQTotal(totalOf(json, rows.length));
      setQAgg(json?.aggregates && typeof json.aggregates === 'object' ? json.aggregates : null);
      // Set UNCONDITIONALLY, exactly like the aggregates above and unlike the
      // schema below: a band summary left on screen after the band filter was
      // cleared is a lie about the rows underneath it.
      setQBandInfo(readBandEcho(json));
      // A run that returns no schema (or a schema this reader cannot parse)
      // leaves the LAST good one on screen rather than emptying the panel the
      // owner asked for.
      const schema = normalizeSchema(json?.schema);
      if (schema.length) setQSchema(schema);
      absorbOptions(json, rows);
      setQRan(true);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setQError(e?.message || 'Could not run that query');
      setQRows([]);
      setQTotal(0);
      setQAgg(null);
      setQBandInfo(null);
      setQRan(true);
    } finally {
      setQLoading(false);
    }
  }, [queryBody, absorbOptions]);

  /**
   * Filters apply themselves — an Apply button would make "only Friday and
   * Saturday" three clicks instead of two.
   *
   * One effect owns the run, and it resets the pager BEFORE firing: without
   * that guard, changing a filter while on page 4 costs two POSTs, the first
   * against an offset that no longer exists in the new result set.
   */
  const filterSig = JSON.stringify([qDow, qMeal, qFrom, qTo, qTimeFrom, qTimeTo, qStatus, qSource, qBand, qOutlet, qLimit]);
  const filterSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (tab !== 'query') return;
    if (filterSigRef.current !== filterSig) {
      filterSigRef.current = filterSig;
      if (qPage !== 1) { setQPage(1); return; }
    }
    const c = new AbortController();
    const t = setTimeout(() => { runQuery(c.signal); }, 250);
    return () => { clearTimeout(t); c.abort(); };
  }, [tab, filterSig, qPage, runQuery]);

  /**
   * The band picker is the ct_bands MASTER, and the engine now agrees with it.
   *
   * ct_bands is the only complete, de-duplicated list of ACT NAMES — one row
   * per band, `name` UNIQUE COLLATE NOCASE — and the name is the ONLY link into
   * ct_entertainment, which has no band id column on it at all. So picking a
   * master id is what lets the server answer "every night this band played":
   * id → name → every calendar row carrying that name → one window per night.
   *
   * (The old note here said the picker was ct_bands because liveBandId is
   * ct_bookings.live_band_id → ct_bands.id. That was never what the query
   * engine did — it does not read b.live_band_id anywhere; it matches the
   * booking's date and slot against the calendar. Right list, wrong reason,
   * and the resolver on the other side was looking these ids up in
   * ct_entertainment, so every band anyone picked came back "not on the
   * entertainment calendar".)
   *
   * include_inactive=1 on purpose: a band that stopped playing last year still
   * has hundreds of nights attributed to it, and leaving retired acts out of
   * the picker would make exactly those nights unaskable. Retired ones are
   * labelled rather than hidden.
   *
   * Fetched once per visit. A failure is not an error state here — the filter
   * stays empty and every other control on the tab still works.
   */
  const bandsFetched = useRef(false);
  useEffect(() => {
    if (tab !== 'query' || bandsFetched.current) return;
    bandsFetched.current = true;
    const c = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/crm-calls/bands?include_inactive=1', { signal: c.signal, cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const bands = listOf<any>(json, 'bands')
          .map((r): BandOption => ({
            id: String(r?.id ?? ''),
            label: `${String(r?.name || 'Unnamed band')}${Number(r?.is_active ?? 1) === 0 ? ' · retired' : ''}`,
          }))
          .filter(b => b.id);
        setBandOptions(bands);
      } catch { /* the picker is optional */ }
    })();
    return () => c.abort();
  }, [tab]);

  const toggleIn = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];

  const addSource = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setQSource(prev => (prev.includes(v) ? prev : [...prev, v]));
    setSourceDraft('');
  };

  const clearQueryFilters = () => {
    setQDow([]); setQMeal(''); setQFrom(''); setQTo(''); setQTimeFrom(''); setQTimeTo('');
    setQStatus([]); setQSource([]); setQBand(''); setQOutlet(''); setSourceDraft('');
  };

  const queryFilterCount =
    qDow.length + qStatus.length + qSource.length +
    [qMeal, qFrom, qTo, qTimeFrom, qTimeTo, qBand, qOutlet].filter(Boolean).length;

  const exportQueryCsv = () => {
    if (qRows.length === 0) return;
    // Exactly what is on screen: the same columns in the same order, the same
    // rows this page is showing. Values go out RAW, not display-formatted, so
    // ₹ figures and dates land in Excel as numbers and dates.
    downloadCsv(`reservation-query-${fileStamp()}.csv`, toCsv(qCols, (row, col) => (row as any)?.[col], qRows));
  };

  const runSql = async () => {
    const text = sqlText.trim();
    if (!text || sqlRunning) return;
    setSqlRunning(true);
    setSqlError(null);
    const t0 = performance.now();
    try {
      const res = await api('/api/crm/reservations/sql', { method: 'POST', body: { sql: text } });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      const rows: unknown[] = Array.isArray(json?.rows) ? json.rows : [];
      const declared = asStringList(json?.columns);
      // A grid with rows and no column heads renders as a blank box, which
      // reads as "the query broke" — so positional rows get positional names
      // when the route did not name them.
      const derived = columnsFrom(null, rows.filter(r => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[]);
      const positional = Array.isArray(rows[0]) ? (rows[0] as unknown[]).map((_, i) => `col_${i + 1}`) : [];
      setSqlRes({
        columns: declared.length ? declared : (derived.length ? derived : positional),
        rows,
        rowCount: Number(json?.rowCount ?? rows.length) || 0,
        // The server's own timing is the honest one; the round trip is the
        // fallback so the panel never shows a blank duration.
        ms: Number.isFinite(Number(json?.ms)) ? Number(json.ms) : Math.round(performance.now() - t0),
      });
    } catch (e: any) {
      setSqlError(e?.message || 'That query did not run');
      setSqlRes(null);
    } finally {
      setSqlRunning(false);
    }
  };

  const exportSqlCsv = () => {
    if (!sqlRes || sqlRes.rows.length === 0) return;
    downloadCsv(
      `reservation-sql-${fileStamp()}.csv`,
      toCsv(sqlRes.columns, (row, col, i) => (Array.isArray(row) ? row[i] : (row as any)?.[col]), sqlRes.rows),
    );
  };

  /* ── the import runner ──────────────────────────────────────────────────── */

  /**
   * Pass one. Counts rows and reads the header WITHOUT retaining a single row —
   * `res.data` is measured and dropped, so a 30MB file costs one chunk of
   * memory at a time. This is what makes rows_total real at import/start.
   *
   * It also carries away the largest Booking Time in the file, which costs a
   * string comparison per row and no memory. That is the FALLBACK export stamp:
   * the server dates an upload from the Reservego file name
   * (BookingsService_DD-MM-YYYY_HH-MM-SS…) and refuses to let an older export
   * overwrite a booking a newer one already wrote, and a renamed file would
   * otherwise be undatable. An export is at least as new as the newest booking
   * in it, so this orders renamed files correctly even though it understates
   * the true export moment. Only ever consulted when the name does not parse —
   * see startImport's stamp ladder in src/lib/reservego-import.ts.
   *
   * Computed HERE, over the whole file, rather than on the server per batch,
   * because the stamp has to be the same for every row of the file no matter
   * how the upload was sliced. A stamp that grew batch by batch would put the
   * result back at the mercy of where the file happened to be cut.
   */
  const countPass = (file: File) =>
    new Promise<{ rows: number; fields: string[]; maxBookingTime: string }>((resolve, reject) => {
      let rows = 0;
      let fields: string[] = [];
      let maxBookingTime = '';
      Papa.parse<ReservegoRow, File>(file, {
        header: true,
        skipEmptyLines: 'greedy',
        chunkSize: CHUNK_BYTES,
        chunk: (res, parser) => {
          if (fields.length === 0) fields = (res.meta.fields || []).map(f => String(f).trim());
          rows += res.data.length;
          for (const r of res.data) {
            // 'YYYY-MM-DD HH:MM:SS' is fixed-width and big-endian, so plain
            // string ordering IS chronological ordering. Shape-checked first so
            // a stray header row or a blank cell cannot win the maximum.
            const v = String((r as Record<string, unknown>)?.['Booking Time'] ?? '').trim();
            if (v > maxBookingTime && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) maxBookingTime = v;
          }
          if (cancelRef.current) parser.abort();
        },
        complete: () => resolve({ rows, fields, maxBookingTime }),
        error: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
    });

  /**
   * One batch, with up to three attempts. A 106k-row upload is ~53 requests and
   * a single blip on a venue link should not throw away a finished upload. A
   * retry cannot double-write: the importer keys every row on reservego_key
   * (outlet + guest + Booking Time) behind a unique index, so a batch that
   * actually landed before the connection dropped is recognised as an update.
   * A 4xx is NOT retried — a payload the server rejected on its merits will be
   * rejected identically the second time.
   */
  const postBatch = async (
    importId: string,
    rows: ReservegoRow[],
    splitDepth = 0,
  ): Promise<Counters> => {
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (cancelRef.current) throw new Error('cancelled');
      try {
        const res = await api('/api/crm/reservations/import/batch', {
          method: 'POST',
          body: { import_id: importId, rows },
        });
        if (res.ok) return (await res.json()) as Counters;
        last = await errorText(res);

        // 413 IS THE ONE 4xx THAT IS NOT ABOUT THE PAYLOAD'S MERITS. The rows
        // are fine; there are merely too many bytes of them for whatever sits
        // in front of the app. So halve and retry instead of giving up — the
        // blanket `4xx -> break` below treated it as unfixable, which is why a
        // single oversized batch killed an entire upload rather than costing
        // one extra round trip.
        //
        // This also means the client stops depending on knowing the proxy's
        // limit. BATCH_ROWS is sized for the 1 MB measured today; if that ever
        // tightens, or a row turns out to be far fatter than the sample, the
        // upload adapts by itself rather than failing at 3am.
        //
        // Splitting cannot double-write: the importer keys every row on
        // reservego_key behind a unique index, so the two halves are the same
        // upsert the whole batch would have been. The server's counters are
        // cumulative per import, so the SECOND half's response is the running
        // total and is what the caller wants.
        if (res.status === 413 && rows.length > 1 && splitDepth < MAX_SPLIT_DEPTH) {
          const mid = Math.ceil(rows.length / 2);
          await postBatch(importId, rows.slice(0, mid), splitDepth + 1);
          return await postBatch(importId, rows.slice(mid), splitDepth + 1);
        }
        if (res.status >= 400 && res.status < 500) break;
      } catch (e: any) {
        last = e?.message || 'network error';
      }
      await sleep(500 * attempt);
    }
    throw new Error(last || 'batch upload failed');
  };

  /**
   * Pass two. Streams the file again, buffers to BATCH_ROWS and uploads.
   * Back-pressure is papaparse's documented pause()/resume() on the parser
   * handed to the chunk callback — without it the reader would race ahead of
   * the network and rebuild in memory exactly the 250MB buffer this design
   * exists to avoid. (pause/resume is unavailable in worker mode, which is why
   * `worker` is left off.)
   */
  const uploadPass = (file: File, importId: string) => new Promise<void>((resolve, reject) => {
    const buffer: ReservegoRow[] = [];
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const flush = async (min: number) => {
      while (buffer.length >= min && buffer.length > 0) {
        if (cancelRef.current) throw new Error('cancelled');
        const batch = buffer.splice(0, BATCH_ROWS);
        const c = await postBatch(importId, batch);
        setCounters(c);
        // Prefer the server's own count of what it has processed; fall back to
        // what we have put on the wire when the route does not report it.
        const processed = Number(c?.rows_processed);
        sentRef.current = Number.isFinite(processed) ? processed : sentRef.current + batch.length;
        setRowsSent(sentRef.current);
        // Let the server breathe before the next write — see BATCH_PAUSE_MS.
        // Only BETWEEN batches, never after the last one, so a small file that
        // fits in a single batch pays nothing at all.
        if (buffer.length > 0) await sleep(BATCH_PAUSE_MS);
      }
    };

    Papa.parse<ReservegoRow, File>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      chunkSize: CHUNK_BYTES,
      chunk: (res, parser) => {
        // Cancel is checked here as well as inside flush(): between two batches
        // the parser is streaming chunks that are each smaller than one batch,
        // and without this Cancel would appear dead until the buffer filled.
        //
        // fail() BEFORE abort(), here and below, and it is not a style choice:
        // papaparse's abort() calls the complete callback SYNCHRONOUSLY, so
        // aborting first would run the tail-flush branch below and keep POSTing
        // batches after we have already given up on this import.
        if (cancelRef.current) { fail(new Error('cancelled')); parser.abort(); return; }
        for (const row of res.data) buffer.push(row);
        if (buffer.length < BATCH_ROWS) return;
        parser.pause();
        flush(BATCH_ROWS)
          .then(() => parser.resume())
          .catch(err => { fail(err); parser.abort(); });
      },
      // The tail — whatever is left below one full batch — is flushed here,
      // after the last chunk. complete() is synchronous, so the promise is what
      // keeps the caller waiting for it.
      complete: () => {
        if (settled) return;
        if (cancelRef.current) { fail(new Error('cancelled')); return; }
        flush(1).then(done).catch(fail);
      },
      error: (err) => fail(err),
    });
  });

  const runImport = async (file: File) => {
    cancelRef.current = false;
    setPhase('counting');
    setFileName(file.name);
    setRowsTotal(0);
    setRowsSent(0);
    sentRef.current = 0;
    setCounters(null);
    setImportError(null);
    setMissingCols([]);
    setTab('imports');

    let importId = '';
    try {
      const { rows, fields, maxBookingTime } = await countPass(file);
      if (cancelRef.current) throw new Error('cancelled');

      if (fields.length === 0) throw new Error('That file has no header row to read.');
      const missingRequired = REQUIRED_COLUMNS.filter(c => !fields.includes(c));
      if (missingRequired.length) {
        throw new Error(
          `This does not look like a Reservego export — missing ${missingRequired.join(', ')}. ` +
          `Found: ${fields.slice(0, 8).join(', ')}${fields.length > 8 ? '…' : ''}`,
        );
      }
      if (rows === 0) throw new Error('The file has a header but no data rows.');
      setMissingCols(EXPECTED_COLUMNS.filter(c => !fields.includes(c)));
      setRowsTotal(rows);

      const startRes = await api('/api/crm/reservations/import/start', {
        method: 'POST',
        // source_exported_at is the FALLBACK stamp only — the server prefers
        // the export time in the Reservego file name and ignores this whenever
        // that parses. See countPass.
        body: { file_name: file.name, rows_total: rows, source_exported_at: maxBookingTime },
      });
      if (!startRes.ok) throw new Error(await errorText(startRes));
      const startJson = await startRes.json();
      importId = String(startJson?.import_id ?? startJson?.id ?? '');
      if (!importId) throw new Error('The server did not return an import_id.');

      setPhase('uploading');
      await uploadPass(file, importId);

      setPhase('finishing');
      const finRes = await api('/api/crm/reservations/import/finish', {
        method: 'POST',
        body: { import_id: importId },
      });
      if (!finRes.ok) throw new Error(await errorText(finRes));
      const finJson = await finRes.json();
      setCounters((finJson?.import ?? finJson?.summary ?? finJson) as Counters);
      setPhase('done');
    } catch (e: any) {
      const cancelled = cancelRef.current || e?.message === 'cancelled';
      // A cancelled or broken run still closes its session. Leaving the row at
      // 'running' forever would make Import History unreadable; rows_processed
      // below rows_total is what marks it partial, and re-uploading the same
      // file is safe because every row is keyed on reservego_key.
      if (importId) {
        try {
          const res = await api('/api/crm/reservations/import/finish', {
            method: 'POST',
            body: { import_id: importId },
          });
          if (res.ok) setCounters((await res.json()) as Counters);
        } catch { /* the session row is the server's to reconcile */ }
      }
      setPhase('error');
      setImportError(cancelled
        ? `Cancelled after ${fmtInt(sentRef.current)} rows. Rows already applied are kept — re-upload the same file to finish; it will not duplicate anything.`
        : (e?.message || 'Import failed'));
    } finally {
      cancelRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadImports();
    }
  };

  const pickFile = (f: File | null | undefined) => {
    if (!f || busy) return;
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      setPhase('error');
      setFileName(f.name);
      setImportError('Only a .csv export is accepted here. Export the reservation list from Reservego as CSV.');
      return;
    }
    runImport(f);
  };

  /* ── derived ────────────────────────────────────────────────────────────── */
  const custPages = Math.max(1, Math.ceil(custTotal / PAGE_SIZE));
  const bookPages = Math.max(1, Math.ceil(bookTotal / PAGE_SIZE));
  const progressPct = rowsTotal > 0 ? Math.min(100, Math.round((rowsSent / rowsTotal) * 100)) : 0;
  const bookFilterCount = [bookStatus, bookFrom, bookTo, guestFilter ? '1' : ''].filter(Boolean).length;
  const qPages = Math.max(1, Math.ceil(qTotal / qLimit));

  const failures = useMemo(() => parseFailures(counters?.errors_json), [counters]);

  const showCustomerBookings = (c: CustomerRow) => {
    setGuestFilter({ id: c.id, label: c.name || formatPhone(c.phone_e164 || '') || c.phone10 || 'Guest' });
    setBookQ(''); setBookInput('');
    setBookStatus(''); setBookFrom(''); setBookTo('');
    setBookPage(1);
    setOpenBooking(null);
    setTab('bookings');
  };

  const exportCsv = (type: 'customers' | 'bookings') => {
    const p = type === 'customers' ? customerQuery(true) : bookingQuery(true);
    p.set('type', type);
    window.open(`/api/crm/reservations/export?${p.toString()}`, '_blank');
  };

  /* ── render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Reservations</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5 flex items-center gap-2">
              <Database className="w-6 h-6 text-[#af4408]" />Reservation Database
            </h1>
            <p className="text-xs text-[#8B7355] mt-1">
              One guest record per person, built from the Reservego export. Same booking uploaded twice stays one booking.
            </p>
          </div>
          <div className="flex gap-2">
            {/* Customers and Bookings only. The Query tab exports the rows IT
                is showing, from its own button — this one would silently ship
                an unfiltered booking list instead. */}
            {(tab === 'customers' || tab === 'bookings') && (
              <button
                onClick={() => exportCsv(tab === 'customers' ? 'customers' : 'bookings')}
                className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors">
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Export {tab === 'customers' ? 'customers' : 'bookings'}</span>
                <span className="sm:hidden">CSV</span>
              </button>
            )}
            <button
              onClick={() => { setTab('imports'); fileInputRef.current?.click(); }}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {busy ? 'Importing…' : 'Import CSV'}
            </button>
          </div>
        </div>

        {/* The picker itself lives at page level so the header button, the drop
            zone and the "choose another file" link all drive one input. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={e => pickFile(e.target.files?.[0])}
        />

        {/* A running import stays visible while the owner browses the other two
            tabs — the upload takes minutes and a progress bar hidden behind a
            tab is a progress bar nobody trusts. */}
        {busy && tab !== 'imports' && (
          <button
            onClick={() => setTab('imports')}
            className="w-full flex items-center gap-3 px-4 py-3 bg-white border border-[#E8D5C4] rounded-xl shadow-sm text-left hover:border-[#af4408] transition-colors">
            <Loader2 className="w-4 h-4 text-[#af4408] animate-spin shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E] truncate">
                {phase === 'counting' ? 'Reading the file…' : `Uploading ${fileName}`}
              </p>
              <div className="h-1.5 bg-[#F0E4D6] rounded-full overflow-hidden mt-1.5">
                <div className="h-full bg-[#af4408] transition-[width] duration-300" style={{ width: `${progressPct}%` }} />
              </div>
            </div>
            <span className="text-xs font-semibold text-[#6B5744] shrink-0">{progressPct}%</span>
          </button>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-[#E8D5C4] rounded-xl p-1 shadow-sm overflow-x-auto">
          <TabButton active={tab === 'customers'} onClick={() => setTab('customers')} icon={Users}
                     label="Customers" count={custTotal} />
          {/* The count on the tab is the LIVE one — what every guest metric in
              the CRM counts — not the number of rows the list paginates. */}
          <TabButton active={tab === 'bookings'} onClick={() => setTab('bookings')} icon={CalendarCheck}
                     label="Bookings" count={bookTotal - bookDupTotal} />
          <TabButton active={tab === 'imports'} onClick={() => setTab('imports')} icon={History}
                     label="Import History" count={imports.length} />
          <TabButton active={tab === 'query'} onClick={() => setTab('query')} icon={SlidersHorizontal}
                     label="Query" count={qRan ? qTotal : 0} />
        </div>

        {/* ══ CUSTOMERS ══════════════════════════════════════════════════════ */}
        {tab === 'customers' && (
          <>
            <div className="flex flex-col lg:flex-row gap-2.5">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input
                  type="text"
                  value={custInput}
                  onChange={e => setCustInput(e.target.value)}
                  placeholder="Search customers by name, phone or email…"
                  aria-label="Search customers"
                  className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm"
                />
                {custLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355] animate-spin" />}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={custSort}
                  onChange={e => { setCustSort(e.target.value); setCustPage(1); }}
                  aria-label="Sort customers"
                  className="flex-1 lg:flex-none px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
                  {CUSTOMER_SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <button onClick={() => loadCustomers()} aria-label="Refresh customers"
                        className="h-[42px] w-[42px] flex items-center justify-center bg-white border border-[#E0D0BE] rounded-xl text-[#6B5744] hover:bg-[#FFF1E3] shadow-sm">
                  <RefreshCw className={`w-4 h-4 ${custLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {custError && <ErrorBox message={custError} />}

            {!custError && customers.length === 0 && !custLoading ? (
              <EmptyBox
                icon={Users}
                title="No customers yet"
                hint={custQ ? 'No customer matches that search.' : 'Import a Reservego CSV and every guest in it appears here with their lifetime metrics.'}
              />
            ) : !custError && (
              <>
                {/* Desktop */}
                <div className="hidden lg:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                          <th className="text-left py-3 px-4 font-semibold">Customer</th>
                          <th className="text-right py-3 px-3 font-semibold">Bookings</th>
                          <th className="text-right py-3 px-3 font-semibold">Visits</th>
                          <th className="text-right py-3 px-3 font-semibold">Arrival</th>
                          <th className="text-right py-3 px-3 font-semibold">No-show</th>
                          <th className="text-right py-3 px-3 font-semibold">Cancelled</th>
                          <th className="text-right py-3 px-3 font-semibold">Pax</th>
                          <th className="text-right py-3 px-3 font-semibold">Total spend</th>
                          <th className="text-right py-3 px-3 font-semibold">Avg / visit</th>
                          <th className="text-left py-3 px-3 font-semibold">First</th>
                          <th className="text-left py-3 px-3 font-semibold">Last</th>
                          <th className="text-right py-3 px-3 font-semibold">Every</th>
                          <th className="text-left py-3 px-3 font-semibold">Sources</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customers.map(c => (
                          <tr key={c.id}
                              onClick={() => showCustomerBookings(c)}
                              onKeyDown={e => { if (e.key === 'Enter') showCustomerBookings(c); }}
                              tabIndex={0}
                              title="Show this customer's bookings"
                              className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0] cursor-pointer focus:outline-none focus:bg-[#FFF1E3]">
                            <td className="py-2.5 px-4">
                              <p className="font-semibold text-[#2D1B0E] text-[13px] truncate max-w-[220px]">{c.name || 'Unknown guest'}</p>
                              <p className="text-[11px] text-[#6B5744] flex items-center gap-1">
                                <Phone className="w-3 h-3" />{formatPhone(c.phone_e164 || '') || c.phone10 || '—'}
                                {c.email && <span className="truncate max-w-[160px]">· {c.email}</span>}
                              </p>
                            </td>
                            <td className="py-2.5 px-3 text-right font-semibold">{fmtInt(c.total_bookings)}</td>
                            <td className="py-2.5 px-3 text-right font-semibold text-[#af4408]">{fmtInt(c.arrived_visits)}</td>
                            <td className="py-2.5 px-3 text-right">{fmtPct(c.arrival_rate)}</td>
                            <td className="py-2.5 px-3 text-right">{c.no_shows ? <span className="text-amber-700 font-medium">{fmtInt(c.no_shows)}</span> : dash}</td>
                            <td className="py-2.5 px-3 text-right">{c.cancelled_bookings ? fmtInt(c.cancelled_bookings) : dash}</td>
                            <td className="py-2.5 px-3 text-right">{fmtInt(c.total_pax)}</td>
                            <td className="py-2.5 px-3 text-right font-semibold">{fmtMoney(c.total_spend)}</td>
                            <td className="py-2.5 px-3 text-right">{fmtMoney(c.avg_spend)}</td>
                            <td className="py-2.5 px-3 whitespace-nowrap text-[13px]">{fmtDate(c.first_booking) || dash}</td>
                            <td className="py-2.5 px-3 whitespace-nowrap text-[13px]">{fmtDate(c.last_booking) || dash}</td>
                            <td className="py-2.5 px-3 text-right whitespace-nowrap text-[13px]">
                              {c.visit_frequency_days != null ? `${fmtInt(c.visit_frequency_days)}d` : dash}
                            </td>
                            <td className="py-2.5 px-3"><SourceChips value={c.booking_sources} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mobile */}
                <div className="lg:hidden space-y-2.5">
                  {customers.map(c => (
                    <div key={c.id} role="button" tabIndex={0}
                         onClick={() => showCustomerBookings(c)}
                         onKeyDown={e => { if (e.key === 'Enter') showCustomerBookings(c); }}
                         className="bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm active:bg-[#FFF8F0] cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#af4408]/30">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm truncate">{c.name || 'Unknown guest'}</p>
                          <p className="text-[11px] text-[#6B5744]">{formatPhone(c.phone_e164 || '') || c.phone10 || '—'}</p>
                        </div>
                        <span className="text-[11px] text-[#6B5744] shrink-0">{fmtDate(c.last_booking) || '—'}</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2 mt-2 pt-2 border-t border-[#F0E4D6] text-center">
                        <Stat label="Bookings" value={fmtInt(c.total_bookings)} />
                        <Stat label="Visits" value={fmtInt(c.arrived_visits)} />
                        <Stat label="Arrival" value={fmtPct(c.arrival_rate)} />
                        <Stat label="Spend" value={fmtMoney(c.total_spend)} />
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#6B5744]">
                        <span>No-shows {fmtInt(c.no_shows)} · Cancelled {fmtInt(c.cancelled_bookings)}</span>
                        <span>Avg {fmtMoney(c.avg_spend)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
                  <p className="text-xs text-[#6B5744]">
                    Showing {custTotal === 0 ? 0 : (custPage - 1) * PAGE_SIZE + 1}–{Math.min(custPage * PAGE_SIZE, custTotal)} of {fmtInt(custTotal)} customers
                  </p>
                  <Pagination page={custPage} pageCount={custPages} onPage={setCustPage} />
                </div>
              </>
            )}
          </>
        )}

        {/* ══ BOOKINGS ═══════════════════════════════════════════════════════ */}
        {tab === 'bookings' && (
          <>
            {guestFilter && (
              <div className="flex items-center gap-2 px-3 py-2 bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl">
                <Users className="w-4 h-4 text-[#af4408] shrink-0" />
                <span className="text-sm text-[#2D1B0E]">
                  Bookings for <strong>{guestFilter.label}</strong>
                </span>
                <button onClick={() => { setGuestFilter(null); setBookPage(1); }}
                        className="ml-auto flex items-center gap-1 text-xs font-medium text-[#af4408] hover:underline">
                  <X className="w-3.5 h-3.5" />Show all bookings
                </button>
              </div>
            )}

            <div className="flex flex-col lg:flex-row gap-2.5">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input
                  type="text"
                  value={bookInput}
                  onChange={e => setBookInput(e.target.value)}
                  placeholder="Search bookings by guest, phone, bill or table…"
                  aria-label="Search bookings"
                  className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm"
                />
                {bookLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355] animate-spin" />}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={bookStatus} onChange={e => { setBookStatus(e.target.value); setBookPage(1); }}
                        aria-label="Filter by status"
                        className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
                  {STATUS_OPTIONS.map(([v, label]) => <option key={v || 'all'} value={v}>{label}</option>)}
                </select>
                <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-xl px-2.5 py-1.5 shadow-sm">
                  <CalendarDays className="w-4 h-4 text-[#8B7355] shrink-0" />
                  <input type="date" value={bookFrom} onChange={e => { setBookFrom(e.target.value); setBookPage(1); }}
                         aria-label="Booking date from"
                         className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" />
                  <span className="text-[#C4B09A]">–</span>
                  <input type="date" value={bookTo} onChange={e => { setBookTo(e.target.value); setBookPage(1); }}
                         aria-label="Booking date to"
                         className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" />
                </div>
                {bookFilterCount > 0 && (
                  <button onClick={() => { setBookStatus(''); setBookFrom(''); setBookTo(''); setGuestFilter(null); setBookPage(1); }}
                          className="flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-[#af4408] hover:bg-[#FFF1E3] rounded-lg transition-colors">
                    <X className="w-3.5 h-3.5" />Clear
                  </button>
                )}
                <button onClick={() => loadBookings()} aria-label="Refresh bookings"
                        className="h-[42px] w-[42px] flex items-center justify-center bg-white border border-[#E0D0BE] rounded-xl text-[#6B5744] hover:bg-[#FFF1E3] shadow-sm">
                  <RefreshCw className={`w-4 h-4 ${bookLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {bookError && <ErrorBox message={bookError} />}

            {!bookError && bookings.length === 0 && !bookLoading ? (
              <EmptyBox
                icon={CalendarCheck}
                title="No bookings found"
                hint={bookFilterCount || bookQ ? 'Try clearing the filters.' : 'Import a Reservego CSV to fill the booking history.'}
              />
            ) : !bookError && (
              <>
                {/* Desktop */}
                <div className="hidden lg:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                          <th className="w-8" />
                          <th className="text-left py-3 px-3 font-semibold">Date</th>
                          <th className="text-left py-3 px-3 font-semibold">Slot</th>
                          <th className="text-left py-3 px-3 font-semibold">Guest</th>
                          <th className="text-right py-3 px-3 font-semibold">Pax</th>
                          <th className="text-left py-3 px-3 font-semibold">Status</th>
                          <th className="text-left py-3 px-3 font-semibold">Type</th>
                          <th className="text-left py-3 px-3 font-semibold">Source</th>
                          <th className="text-left py-3 px-3 font-semibold">Section / Table</th>
                          <th className="text-right py-3 px-3 font-semibold">Bill</th>
                          <th className="text-left py-3 px-3 font-semibold">Booked at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bookings.map(b => {
                          const open = openBooking === b.id;
                          // Keyed Fragment, not <> — the summary row and its
                          // expanded detail row are two siblings of one list
                          // entry, and an unkeyed fragment makes React re-mount
                          // the open row every time the list re-renders.
                          return (
                            <Fragment key={b.id}>
                              <tr
                                  onClick={() => setOpenBooking(open ? null : b.id)}
                                  onKeyDown={e => { if (e.key === 'Enter') setOpenBooking(open ? null : b.id); }}
                                  tabIndex={0}
                                  className={`border-b border-[#F0E4D6] hover:bg-[#FFF8F0] cursor-pointer focus:outline-none focus:bg-[#FFF1E3] ${open ? 'bg-[#FFF8F0]' : ''}`}>
                                <td className="py-2.5 pl-3 text-[#8B7355]">
                                  {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                </td>
                                <td className="py-2.5 px-3 whitespace-nowrap font-medium">{fmtDate(b.booking_date) || dash}</td>
                                <td className="py-2.5 px-3 whitespace-nowrap">{b.slot_time || dash}</td>
                                <td className="py-2.5 px-3">
                                  <p className="font-medium text-[13px] truncate max-w-[200px]">{b.guest_name || 'Unknown guest'}</p>
                                  {b.guest_phone && <p className="text-[11px] text-[#6B5744]">{formatPhone(b.guest_phone)}</p>}
                                  <DuplicateChip on={b.is_duplicate} />
                                </td>
                                <td className="py-2.5 px-3 text-right">{b.party_size ?? dash}</td>
                                <td className="py-2.5 px-3"><StatusChip status={b.status} raw={b.reservego_status} /></td>
                                <td className="py-2.5 px-3 text-[13px]">{b.booking_type || dash}</td>
                                <td className="py-2.5 px-3 text-[13px] truncate max-w-[140px]">{b.source || dash}</td>
                                <td className="py-2.5 px-3 text-[13px] truncate max-w-[160px]">
                                  {[b.sections, b.tables_csv].filter(Boolean).join(' · ') || dash}
                                </td>
                                <td className="py-2.5 px-3 text-right font-medium">
                                  {b.bill_amount != null ? fmtMoney(b.bill_amount) : dash}
                                </td>
                                <td className="py-2.5 px-3 text-[12px] text-[#6B5744] whitespace-nowrap">{fmtStamp(b.booking_time) || dash}</td>
                              </tr>
                              {open && (
                                <tr className="border-b border-[#F0E4D6] bg-[#FFFDF9]">
                                  <td colSpan={11} className="px-6 py-4"><BookingDetail b={b} /></td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mobile */}
                <div className="lg:hidden space-y-2.5">
                  {bookings.map(b => {
                    const open = openBooking === b.id;
                    return (
                      <div key={b.id} className="bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm">
                        <div role="button" tabIndex={0}
                             onClick={() => setOpenBooking(open ? null : b.id)}
                             onKeyDown={e => { if (e.key === 'Enter') setOpenBooking(open ? null : b.id); }}
                             className="cursor-pointer focus:outline-none">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-semibold text-sm truncate">{b.guest_name || 'Unknown guest'}</p>
                              <p className="text-[11px] text-[#6B5744]">
                                {fmtDate(b.booking_date) || '—'}{b.slot_time ? ` · ${b.slot_time}` : ''}
                                {b.party_size ? ` · ${b.party_size} pax` : ''}
                              </p>
                              <DuplicateChip on={b.is_duplicate} />
                            </div>
                            <StatusChip status={b.status} raw={b.reservego_status} />
                          </div>
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#6B5744]">
                            <span className="truncate">{b.booking_type || '—'} · {b.source || 'no source'}</span>
                            <span className="font-semibold text-[#2D1B0E]">{b.bill_amount != null ? fmtMoney(b.bill_amount) : '—'}</span>
                          </div>
                        </div>
                        {open && <div className="mt-3 pt-3 border-t border-[#F0E4D6]"><BookingDetail b={b} /></div>}
                      </div>
                    );
                  })}
                </div>

                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
                  {/* Both numbers, and which is which. The row count is what
                      the pager walks; the bookings count is what the guest
                      metrics and the Customers tab add up to. Stating only one
                      of them is how the two screens came to disagree. */}
                  <p className="text-xs text-[#6B5744]">
                    Showing {bookTotal === 0 ? 0 : (bookPage - 1) * PAGE_SIZE + 1}–{Math.min(bookPage * PAGE_SIZE, bookTotal)} of {fmtInt(bookTotal - bookDupTotal)} bookings
                    {bookDupTotal > 0 && (
                      <> · {fmtInt(bookDupTotal)} same-day duplicate{bookDupTotal === 1 ? '' : 's'} listed but not counted</>
                    )}
                  </p>
                  <Pagination page={bookPage} pageCount={bookPages} onPage={setBookPage} />
                </div>
              </>
            )}
          </>
        )}

        {/* ══ IMPORT HISTORY ═════════════════════════════════════════════════ */}
        {tab === 'imports' && (
          <>
            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
              className={`border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center transition-colors ${
                dragOver ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E0D0BE] bg-white'
              } ${busy ? 'opacity-60' : ''}`}>
              <FileSpreadsheet className="w-9 h-9 mx-auto text-[#af4408] opacity-70" />
              <p className="mt-3 text-sm font-semibold text-[#2D1B0E]">Drop the Reservego CSV here</p>
              <p className="text-xs text-[#8B7355] mt-1 max-w-xl mx-auto">
                Parsed in this browser and uploaded in batches of {fmtInt(BATCH_ROWS)} rows, so a 106,000-row export
                goes up with a progress bar instead of one enormous request. Re-uploading a file you have already
                imported updates those bookings; it never duplicates them.
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
                <Upload className="w-4 h-4" />Choose CSV file
              </button>
            </div>

            {/* Live progress / result of the current session */}
            {phase !== 'idle' && (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 sm:p-5 shadow-sm space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
                      {phase === 'done' ? 'Import complete' : phase === 'error' ? 'Import stopped' : 'Import in progress'}
                    </p>
                    <p className="font-semibold text-[#2D1B0E] truncate">{fileName}</p>
                  </div>
                  {busy ? (
                    <button
                      onClick={() => { cancelRef.current = true; }}
                      className="px-3 py-2 text-xs font-semibold text-[#af4408] border border-[#E0D0BE] rounded-lg hover:bg-[#FFF1E3]">
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={() => { setPhase('idle'); setCounters(null); setImportError(null); setMissingCols([]); }}
                      aria-label="Dismiss import summary"
                      className="p-2 text-[#8B7355] hover:bg-[#FFF1E3] rounded-lg">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {busy && (
                  <div>
                    <div className="flex items-center justify-between text-xs text-[#6B5744] mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {phase === 'counting' ? 'Reading the file and checking its columns…'
                          : phase === 'finishing' ? 'Rolling up customer metrics…'
                          : `Uploading batch ${Math.floor(rowsSent / BATCH_ROWS) + 1} of ${Math.max(1, Math.ceil(rowsTotal / BATCH_ROWS))}`}
                      </span>
                      <span className="font-semibold">
                        {rowsTotal > 0 ? `${fmtInt(rowsSent)} / ${fmtInt(rowsTotal)} rows` : 'counting…'}
                      </span>
                    </div>
                    <div className="h-2.5 bg-[#F0E4D6] rounded-full overflow-hidden">
                      <div className={`h-full bg-[#af4408] transition-[width] duration-300 ${rowsTotal === 0 ? 'animate-pulse w-1/4' : ''}`}
                           style={rowsTotal > 0 ? { width: `${progressPct}%` } : undefined} />
                    </div>
                  </div>
                )}

                {importError && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
                    <XCircle className="w-5 h-5 text-red-500 shrink-0" />
                    <p className="text-sm text-red-700">{importError}</p>
                  </div>
                )}

                {phase === 'done' && !importError && (
                  <div className="flex items-center gap-2 text-sm text-green-700">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>{fmtInt(counters?.rows_processed ?? rowsSent)} rows applied to the guest database.</span>
                  </div>
                )}

                {missingCols.length > 0 && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800">
                      {missingCols.length} expected column{missingCols.length > 1 ? 's are' : ' is'} not in this file
                      ({missingCols.join(', ')}). Those fields import empty; everything else is unaffected.
                    </p>
                  </div>
                )}

                {counters && <CounterGrid c={counters} rowsTotal={rowsTotal} />}

                {failures.length > 0 && <FailureList failures={failures} />}

                {phase === 'done' && !importError && (
                  <p className="text-xs text-[#8B7355]">
                    Lifetime metrics were rolled up as part of this import — the Customers tab reads the stored
                    figures, so it is already up to date.
                  </p>
                )}
              </div>
            )}

            {/* What the last delete actually removed, reported against the
                numbers the confirm panel promised. */}
            {delDone && (() => {
              const r = delDone.result;
              const c = r.counts;
              // A no-op DELETE used to paint the green "was deleted" banner over
              // real-looking numbers. It gets its own neutral box now: nothing
              // happened, and the receipt says so rather than taking credit.
              const nothingToDo = r.already_deleted || !r.found;
              return (
                <div className={`flex items-start gap-2 p-3 rounded-xl border ${
                  nothingToDo ? 'bg-[#FFF8F0] border-[#E8D5C4]' : 'bg-green-50 border-green-200'}`}>
                  {nothingToDo
                    ? <AlertCircle className="w-5 h-5 text-[#8B7355] shrink-0" />
                    : <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />}
                  <div className="flex-1 min-w-0 space-y-2.5">
                    <p className={`text-sm ${nothingToDo ? 'text-[#6B5744]' : 'text-green-800'}`}>
                      {nothingToDo ? (
                        <>There was nothing left to delete under <strong>{delDone.file}</strong> — it had already been removed.</>
                      ) : (
                        <>
                          <strong>{delDone.file}</strong> was deleted — {fmtInt(c.bookings_to_delete)} booking
                          {c.bookings_to_delete === 1 ? '' : 's'} and {fmtInt(c.guests_to_delete)} guest
                          {c.guests_to_delete === 1 ? '' : 's'} removed; {fmtInt(c.guests_to_keep)} guest
                          {c.guests_to_keep === 1 ? '' : 's'} kept; {fmtInt(r.guests_refreshed)} guest total
                          {r.guests_refreshed === 1 ? '' : 's'} recalculated
                          {r.import_deleted
                            ? ''
                            : ' — no upload record was found to remove, these were orphaned rows'}.
                        </>
                      )}
                    </p>
                    {/* The server's own account of what it did, verbatim and in
                        order. Same rule as the confirm panel: this page prints
                        the sentences, it does not write them. */}
                    <div className={`p-2.5 rounded-lg border ${
                      nothingToDo ? 'bg-white border-[#F0E4D6]' : 'bg-white/70 border-green-200'}`}>
                      <p className="text-[11px] font-semibold text-[#2D1B0E] mb-1.5">What this delete did</p>
                      <ul className="list-disc pl-4 space-y-1.5">
                        {r.notice.map((line, i) => (
                          <li key={i} className="text-xs text-[#6B5744] leading-relaxed">{line}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <button onClick={() => setDelDone(null)} aria-label="Dismiss delete summary"
                          className={`p-1 rounded-lg shrink-0 ${
                            nothingToDo ? 'text-[#8B7355] hover:bg-[#FFF1E3]' : 'text-green-700 hover:bg-green-100'}`}>
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })()}

            {/* History */}
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#2D1B0E]">Previous imports</h2>
              <button onClick={() => loadImports()} aria-label="Refresh import history"
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#6B5744] bg-white border border-[#E0D0BE] rounded-lg hover:bg-[#FFF1E3]">
                <RefreshCw className={`w-3.5 h-3.5 ${impLoading ? 'animate-spin' : ''}`} />Refresh
              </button>
            </div>

            {impError && <ErrorBox message={impError} />}

            {!impError && imports.length === 0 && !impLoading ? (
              <EmptyBox icon={History} title="Nothing imported yet" hint="Every upload is recorded here with its full counter set." />
            ) : (
              <div className="space-y-2.5">
                {imports.map(im => (
                  <ImportCard
                    key={im.id}
                    im={im}
                    open={openImport === im.id}
                    onToggle={() => setOpenImport(openImport === im.id ? null : im.id)}
                    onDelete={() => askDelete(im)}
                    // An upload is landing batch by batch right now. Deleting
                    // any import mid-run would race the rows still arriving, so
                    // the whole column waits for the upload to finish.
                    deleteBlocked={busy}
                  />
                ))}
              </div>
            )}

            {delTarget && (
              <DeleteImportDialog
                im={delTarget}
                preview={delPreview}
                loading={delPreviewLoading}
                previewError={delPreviewError}
                confirmText={delConfirm}
                onConfirmText={setDelConfirm}
                canDelete={canDelete}
                running={delRunning}
                error={delError}
                errorCode={delErrorCode}
                forceArmed={delForceArmed}
                onForceArmed={setDelForceArmed}
                onCancel={closeDelete}
                onDelete={runDelete}
              />
            )}
          </>
        )}

        {/* ══ QUERY ══════════════════════════════════════════════════════════ */}
        {tab === 'query' && (
          <div className="grid grid-cols-1 xl:grid-cols-[19rem_minmax(0,1fr)] gap-4 items-start">

            <SchemaPanel
              tables={qSchema}
              loading={qLoading && qSchema.length === 0}
              onInsert={t => setSqlText(s => (s ? `${s}${/\s$/.test(s) ? '' : ' '}${t}` : t))}
            />

            <div className="min-w-0 space-y-4">

              {/* ── filter builder ─────────────────────────────────────────── */}
              <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                      <SlidersHorizontal className="w-4 h-4 text-[#af4408]" />Filter builder
                    </p>
                    <p className="text-[11px] text-[#8B7355] mt-0.5">
                      Every filter applies as you click it. Nothing selected in a row means that row is not filtering.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {queryFilterCount > 0 && (
                      <button
                        onClick={clearQueryFilters}
                        className="flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-[#af4408] hover:bg-[#FFF1E3] rounded-lg transition-colors">
                        <X className="w-3.5 h-3.5" />Clear {queryFilterCount}
                      </button>
                    )}
                    <button onClick={() => runQuery()} aria-label="Run this query again"
                            className="h-9 w-9 flex items-center justify-center bg-white border border-[#E0D0BE] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                      <RefreshCw className={`w-4 h-4 ${qLoading ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

                <FilterRow label="Days">
                  {DOW_OPTIONS.map(([n, short, full]) => (
                    <Chip key={n} on={qDow.includes(n)} title={full} onClick={() => setQDow(d => toggleIn(d, n))}>
                      {short}
                    </Chip>
                  ))}
                  {qDow.length === 0 && <span className="text-[11px] text-[#8B7355] pl-1">every day</span>}
                </FilterRow>

                <FilterRow label="Service">
                  <Chip on={!qMeal} onClick={() => setQMeal('')}>Whole day</Chip>
                  {mealOptions.map(([v, label]) => (
                    <Chip key={v} on={qMeal === v} onClick={() => setQMeal(qMeal === v ? '' : v)}>{label}</Chip>
                  ))}
                </FilterRow>

                <FilterRow label="Window">
                  <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-lg px-2.5 py-1.5">
                    <CalendarDays className="w-4 h-4 text-[#8B7355] shrink-0" />
                    <input type="date" value={qFrom} onChange={e => setQFrom(e.target.value)}
                           aria-label="Reserved date from"
                           className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" />
                    <span className="text-[#C4B09A]">–</span>
                    <input type="date" value={qTo} onChange={e => setQTo(e.target.value)}
                           aria-label="Reserved date to"
                           className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" />
                  </div>
                  <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-lg px-2.5 py-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">Slot</span>
                    <input type="time" value={qTimeFrom} onChange={e => setQTimeFrom(e.target.value)}
                           aria-label="Slot time from"
                           className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[5.5rem]" />
                    <span className="text-[#C4B09A]">–</span>
                    <input type="time" value={qTimeTo} onChange={e => setQTimeTo(e.target.value)}
                           aria-label="Slot time to"
                           className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[5.5rem]" />
                  </div>
                </FilterRow>

                <FilterRow label="Status">
                  {QUERY_STATUSES.map(([v, label]) => (
                    <Chip key={v} on={qStatus.includes(v)} onClick={() => setQStatus(s => toggleIn(s, v))}>{label}</Chip>
                  ))}
                </FilterRow>

                <FilterRow label="Source">
                  {qSource.map(s => (
                    <span key={s} className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1.5 rounded-lg bg-[#FFF1E3] text-[#a8632b] border border-[#E8D5C4]">
                      {s}
                      <button onClick={() => setQSource(prev => prev.filter(v => v !== s))} aria-label={`Remove source ${s}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    list="rq-sources"
                    value={sourceDraft}
                    onChange={e => setSourceDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSource(sourceDraft); } }}
                    onBlur={() => addSource(sourceDraft)}
                    placeholder={sourceOptions.length ? 'Add a source…' : 'Add a source (type it)…'}
                    aria-label="Add a booking source"
                    className="px-2.5 py-2 bg-white border border-[#E0D0BE] rounded-lg text-xs w-44 focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
                  />
                  {/* Suggestions are the sources the server has actually
                      returned, so the list matches the data, not a guess. */}
                  <datalist id="rq-sources">
                    {sourceOptions.filter(s => !qSource.includes(s)).map(s => <option key={s} value={s} />)}
                  </datalist>
                </FilterRow>

                <FilterRow label="Where">
                  <input
                    list="rq-outlets"
                    value={qOutlet}
                    onChange={e => setQOutlet(e.target.value)}
                    placeholder="Any outlet"
                    aria-label="Outlet"
                    className="px-2.5 py-2 bg-white border border-[#E0D0BE] rounded-lg text-xs w-48 focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
                  />
                  <datalist id="rq-outlets">
                    {outletOptions.map(o => <option key={o} value={o} />)}
                  </datalist>
                  <select
                    value={qBand}
                    onChange={e => setQBand(e.target.value)}
                    disabled={bandOptions.length === 0}
                    aria-label="Live band"
                    title={bandOptions.length === 0 ? 'No bands on the band master yet' : 'Only the nights this band played'}
                    className="px-2.5 py-2 bg-white border border-[#E0D0BE] rounded-lg text-xs max-w-[16rem] disabled:opacity-50">
                    <option value="">Any live band</option>
                    {bandOptions.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                </FilterRow>
              </div>

              {qError && <ErrorBox message={qError} />}

              {/* What the band filter matched. Sits above the numbers because
                  it qualifies them — how many nights they cover, and which
                  nights were left out of them. */}
              {qBandInfo && <BandNotice info={qBandInfo} />}

              {qAgg && <AggregateCards agg={qAgg} />}

              {/* ── results ────────────────────────────────────────────────── */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <p className="text-xs text-[#6B5744] flex items-center gap-1.5">
                  {qLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {qLoading ? 'Running…' : `${fmtInt(qTotal)} matching row${qTotal === 1 ? '' : 's'}`}
                  {!qLoading && qRows.length > 0 && qTotal > qRows.length && (
                    <> · showing {fmtInt(qRows.length)} on this page</>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <select value={qLimit} onChange={e => setQLimit(Number(e.target.value) || QUERY_PAGE_SIZES[0])}
                          aria-label="Rows per page"
                          className="px-2.5 py-2 bg-white border border-[#E0D0BE] rounded-lg text-xs shadow-sm">
                    {QUERY_PAGE_SIZES.map(n => <option key={n} value={n}>{n} rows</option>)}
                  </select>
                  <button onClick={exportQueryCsv} disabled={qRows.length === 0}
                          title="Downloads the rows and columns on screen, exactly as this filter returned them"
                          className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-40 disabled:hover:border-[#E0D0BE] disabled:hover:bg-white text-[#6B5744] rounded-lg text-xs font-medium shadow-sm transition-colors">
                    <Download className="w-3.5 h-3.5" />CSV of these {fmtInt(qRows.length)} rows
                  </button>
                </div>
              </div>

              {!qError && qRows.length === 0 && !qLoading ? (
                <EmptyBox
                  icon={SlidersHorizontal}
                  title="Nothing matches those filters"
                  hint={queryFilterCount ? 'Loosen one of them — the day chips and the service period are the two that narrow hardest.' : 'Pick a day, a service period or a date range to start.'}
                />
              ) : qRows.length > 0 ? (
                <ResultTable columns={qCols} rows={qRows} />
              ) : null}

              <div className="flex justify-end">
                <Pagination page={qPage} pageCount={qPages} onPage={setQPage} />
              </div>

              {/* ── advanced SQL ───────────────────────────────────────────── */}
              <SqlConsole
                text={sqlText}
                onText={setSqlText}
                onRun={runSql}
                running={sqlRunning}
                result={sqlRes}
                error={sqlError}
                onExport={exportSqlCsv}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── components ───────────────────────────────── */

function TabButton({ active, onClick, icon: Icon, label, count }: {
  active: boolean; onClick: () => void; icon: typeof Users; label: string; count: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
        active ? 'bg-[#af4408] text-white shadow-sm' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
      }`}>
      <Icon className="w-4 h-4" />
      {label}
      {count > 0 && (
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
          active ? 'bg-white/20' : 'bg-[#FFF1E3] text-[#a8632b] border border-[#E8D5C4]'
        }`}>{fmtInt(count)}</span>
      )}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-[#6B5744] uppercase tracking-wide">{label}</p>
      <p className="text-sm font-bold text-[#2D1B0E]">{value}</p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl">
      <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
      <p className="text-sm text-red-700">{message}</p>
    </div>
  );
}

/**
 * WHAT THE BAND FILTER MATCHED — the plural answer, on screen.
 *
 * A band is many nights, so "23 nights, Mar 2025 – Aug 2026" is the honest
 * headline and a single date would be a lie. Three things it must never hide:
 *
 *  · ZERO NIGHTS. A band on the master that was never put on the calendar
 *    returns nothing, and without this box that is indistinguishable from a
 *    filter that is broken — which is exactly the bug this page just had.
 *  · SKIPPED NIGHTS. A calendar row whose start time is not readable is left
 *    out of the answer. Every one is printed, with its reason, never collapsed
 *    behind a count and never truncated.
 *  · THE NIGHT CAP. Past the engine's cap the oldest nights are dropped; saying
 *    so is what lets the reader narrow the date range instead of trusting a
 *    number that quietly answers a shorter history than they asked for.
 *
 * Amber, not red: none of this is an error. The query ran and the rows below
 * are real — this says what they cover.
 */
function BandNotice({ info }: { info: BandEcho }) {
  const range = info.firstNight && info.lastNight
    ? (info.firstNight === info.lastNight
      ? fmtDate(info.firstNight)
      : `${fmtDate(info.firstNight)} – ${fmtDate(info.lastNight)}`)
    : '';
  // ZERO NIGHTS IS TWO DIFFERENT ANSWERS AND THEY NEED DIFFERENT SENTENCES.
  // Branching on nights === 0 alone printed "has no nights on the entertainment
  // calendar … Add its nights under What's On" DIRECTLY ABOVE this box's own
  // list of the calendar rows it had just read and could not use — a flat
  // contradiction, and the one remedy it named was the one that cannot help.
  // A blank or "9:00 PM" start time is enough to land here (the What's On start
  // time is a plain text box with no format check), so this is an ordinary
  // state, not an exotic one.
  const noNights = info.nights === 0;
  const allSkipped = noNights && info.skipped.length > 0;
  const empty = noNights && !allSkipped;
  // The engine matches every calendar row carrying the band's name, not only
  // the ones typed 'band'. Said out loud rather than hidden, because the
  // live_band_id backfill elsewhere in the CRM only credits type='band' and the
  // two surfaces would otherwise report different night counts for one act.
  const offTypes = [...new Set(
    info.nightList.map(n => n.type.trim()).filter(t => t && t.toLowerCase() !== 'band'),
  )];
  const offTypeNights = info.nightList.filter(n => n.type.trim() && n.type.trim().toLowerCase() !== 'band').length;
  return (
    <div className={`p-4 border rounded-xl ${noNights || info.skipped.length || info.capped
      ? 'bg-amber-50 border-amber-200' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
      <div className="flex items-start gap-2">
        <AlertCircle className={`w-5 h-5 shrink-0 ${noNights || info.skipped.length || info.capped ? 'text-amber-500' : 'text-[#af4408]'}`} />
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm text-[#2D1B0E]">
            <span className="font-semibold">{info.name}</span>
            {allSkipped ? (
              info.skipped.length === 1 ? (
                <> has <span className="font-semibold">one</span> row on the entertainment calendar and it could not be
                  used, so nothing can match it. Fix it under What&apos;s On — the reason is below — then run this again.</>
              ) : (
                <> has <span className="font-semibold">{fmtInt(info.skipped.length)}</span> rows on the entertainment
                  calendar and <span className="font-semibold">not one</span> of them could be used, so nothing can match
                  it. Fix them under What&apos;s On — the reasons are below — then run this again.</>
              )
            ) : empty ? (
              <> is on the band list but has no nights on the entertainment calendar, so nothing can match it. Add its nights under What&apos;s On, then run this again.</>
            ) : (
              <>
                {' '}played <span className="font-semibold">{fmtInt(info.nights)}</span> night{info.nights === 1 ? '' : 's'}
                {range && <> · {range}</>}
                {info.windows > info.nights && <> · {fmtInt(info.windows)} calendar entries</>}
              </>
            )}
          </p>
          {!noNights && (
            <p className="text-xs text-[#6B5744]">
              Each night counts bookings from {fmtInt(info.leadIn)} minutes before the act starts through the end of that night
              {info.clamped && <> — on at least one night that reached before midnight and was held at 00:00, so the evening before is not counted</>}.
            </p>
          )}
          {offTypeNights > 0 && (
            <p className="text-xs text-[#6B5744]">
              {/* "of those" read back to the NIGHT count above, but this counts calendar
                  ENTRIES, and an act billed twice on one night makes entries > nights —
                  "played 4 nights … 5 of those are typed 'dj'". Counted in its own unit. */}
              {fmtInt(offTypeNights)} calendar {offTypeNights === 1 ? 'entry is' : 'entries are'} typed{' '}
              {offTypes.map(t => `“${t}”`).join(' / ')} on the calendar rather than “band” — counted, because it is the
              same act on the night. The type is quoted exactly as the calendar holds it, which is what you would edit.
            </p>
          )}
          {/* The cap keeps the most recent rows and drops the rest UNEXAMINED,
              so the skipped list under it covers only what survived: an undated
              row sorts oldest of all and is the first thing the cap discards.
              Said out loud, because "N rows are not included" reading as the
              complete list of what was left out is the same silent drop this
              box exists to prevent. */}
          {info.capped && (
            <p className="text-xs text-amber-800">
              This band has more than {fmtInt(info.cap)} rows on the entertainment calendar. Only the most recent{' '}
              {fmtInt(info.cap)} were used — set a date range to ask about the rest. The older rows were never
              examined, so any unusable ones among them are not counted here either.
            </p>
          )}
          {info.skipped.length > 0 && (
            <div className="text-xs text-amber-800">
              <p className="font-medium">
                {fmtInt(info.skipped.length)} calendar {info.skipped.length === 1 ? 'row is' : 'rows are'} not included:
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {info.skipped.map((s, i) => (
                  <li key={`${s.event_date}-${i}`}>
                    · {s.event_date ? fmtDate(s.event_date) || s.event_date : 'no date'} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyBox({ icon: Icon, title, hint }: { icon: typeof Users; title: string; hint: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl py-14 text-center text-[#8B7355]">
      <Icon className="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p className="font-medium text-[#6B5744]">{title}</p>
      <p className="text-xs mt-1 px-6">{hint}</p>
    </div>
  );
}

/**
 * A status the mapper did not recognise shows the RAW Reservego string in an
 * amber chip rather than being dressed up as one of ours. mapStatus() returns
 * null for anything unknown precisely so the gap stays visible — a guess here
 * would quietly move a booking into "completed" and inflate the arrival rate
 * this whole page exists to report.
 */
function StatusChip({ status, raw }: { status: string | null; raw: string | null }) {
  const s = String(status || '').toLowerCase();
  if (s && STATUS_STYLES[s]) {
    return (
      <span title={raw || s}
            className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS_STYLES[s]}`}>
        {s === 'no_show' ? 'NO-SHOW' : s.toUpperCase()}
      </span>
    );
  }
  const label = raw || status || '—';
  return (
    <span title={`Unmapped Reservego status: ${label}`}
          className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-300 whitespace-nowrap max-w-[140px] truncate">
      {label}
    </span>
  );
}

/**
 * The same-day duplicate label.
 *
 * Reservego emits a fresh row when a guest is re-booked or moved on the same
 * evening, so one visit can appear two or three times; markDuplicateGroups()
 * (src/lib/reservego.ts) decides which stored row IS the visit and flags the
 * rest. Those rows are excluded from every count in the CRM — the guest's
 * lifetime metrics, the Customers tab, this tab's own headline figure.
 *
 * They are NOT hidden from this list, and that is the deliberate half. The
 * owner can still see all three rows in Reservego; a list that quietly showed
 * two would read as a bug in the import, and the one thing worse than a
 * confusing number is a missing row nobody can account for. So the row stays
 * and says what it is.
 */
function DuplicateChip({ on }: { on: number | null }) {
  if (Number(on ?? 0) !== 1) return null;
  return (
    <span title="Same date and mobile as another booking — shown here, but not counted in any total"
          className="inline-block mt-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-[#F3EDE6] text-[#6B5744] border-[#D9C8B4] whitespace-nowrap">
      DUPLICATE · NOT COUNTED
    </span>
  );
}

function SourceChips({ value }: { value: string | null }) {
  const parts = String(value || '')
    .replace(/^\[|\]$/g, '')
    .split(/[,|]/)
    .map(s => s.replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(Boolean);
  if (parts.length === 0) return dash;
  const shown = parts.slice(0, 2);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map(p => (
        <span key={p} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#FFF1E3] text-[#a8632b] border border-[#E8D5C4] whitespace-nowrap">
          {p}
        </span>
      ))}
      {parts.length > shown.length && <span className="text-[10px] text-[#8B7355]">+{parts.length - shown.length}</span>}
    </span>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</p>
      <p className="text-[13px] text-[#2D1B0E] break-words">{value || dash}</p>
    </div>
  );
}

/** Everything the CSV carried for one booking, including the columns that have
 *  no place in the summary table (pax split, comments, deletion, payment). */
function BookingDetail({ b }: { b: BookingRow }) {
  let pax: Record<string, number> = {};
  try { pax = b.pax_breakdown ? JSON.parse(b.pax_breakdown) : {}; } catch { pax = {}; }
  const paxParts = Object.entries(pax).filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Field label="Outlet" value={b.outlet_name} />
        <Field label="Booked at" value={fmtStamp(b.booking_time)} />
        <Field label="Reserved for" value={fmtStamp(b.reserved_time)} />
        <Field label="Arrived" value={b.arrived ? 'Yes' : 'No'} />
        <Field label="Reserved by" value={b.reserved_by} />
        <Field label="Pax split" value={paxParts.length ? paxParts.join(' · ') : null} />
        <Field label="Bill no." value={b.bill_number} />
        <Field label="Bill amount" value={b.bill_amount != null ? fmtMoney(b.bill_amount) : null} />
        <Field label="Booking amount" value={b.booking_amount != null ? fmtMoney(b.booking_amount) : null} />
        <Field label="Payment" value={[b.booking_payment_status, fmtStamp(b.booking_payment_date)].filter(Boolean).join(' · ')} />
        <Field label="Txn ID" value={b.booking_txn_id} />
        <Field label="Raw status" value={b.reservego_status} />
        <Field label="Deletion" value={[b.deletion_type, b.deletion_reason].filter(Boolean).join(' — ')} />
        <Field label="Tags" value={b.tags} />
        <Field label="Import" value={b.import_id} />
      </div>
      {(b.preferences || b.guest_comments || b.outlet_comments) && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-[#F0E4D6]">
          <Field label="Preferences" value={b.preferences} />
          <Field label="Guest comments" value={b.guest_comments} />
          <Field label="Outlet comments" value={b.outlet_comments} />
        </div>
      )}
    </div>
  );
}

/** The eight counters the owner asked to see after every upload. */
function CounterGrid({ c, rowsTotal }: { c: Counters; rowsTotal: number }) {
  const tiles: [string, string, string?][] = [
    ['Total rows', fmtInt(c.rows_total ?? rowsTotal)],
    ['Rows processed', fmtInt(c.rows_processed)],
    ['New bookings', fmtInt(c.new_bookings), 'text-green-700'],
    ['Updated bookings', fmtInt(c.updated_bookings)],
    ['Duplicate rows', fmtInt(c.duplicate_rows)],
    ['Collapsed same-day', fmtInt(c.collapsed_rows)],
    ['New customers', fmtInt(c.new_customers), 'text-green-700'],
    ['Updated customers', fmtInt(c.updated_customers)],
    ['Failed rows', fmtInt(c.failed_rows), Number(c.failed_rows) > 0 ? 'text-red-600' : undefined],
    // Not a failure and not a change: rows this file was not allowed to
    // overwrite because the stored booking came from a NEWER export. On the
    // owner's archive, uploading the 129 files newest-first refuses 130,264
    // rows this way — that is the guard doing its job, so it gets its own tile
    // instead of hiding inside "duplicate rows".
    ['Older than stored', fmtInt(c.skipped_stale)],
    ['Pax clamped', fmtInt(c.pax_clamped), Number(c.pax_clamped) > 0 ? 'text-amber-700' : undefined],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      {tiles.map(([label, value, tone]) => (
        <div key={label} className="bg-[#FFF8F0] border border-[#F0E4D6] rounded-xl px-3 py-2.5">
          <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</p>
          <p className={`text-lg font-bold ${tone || 'text-[#2D1B0E]'}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Collapsed rows are the owner's second identity rule made visible: same date +
 * same mobile is one visit, the checked-in copy wins, and the losers are
 * REPORTED here rather than silently dropped so the numbers add up.
 */
function FailureList({ failures }: { failures: FailedRow[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? failures : failures.slice(0, 3);
  return (
    <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-3 py-2 bg-[#FFF8F0] text-xs font-semibold text-[#6B5744] flex items-center justify-between">
        <span>{fmtInt(failures.length)} row{failures.length === 1 ? '' : 's'} could not be imported</span>
        {failures.length > 3 && (
          <button onClick={() => setOpen(o => !o)} className="text-[#af4408] hover:underline">
            {open ? 'Show less' : `Show all ${fmtInt(failures.length)}`}
          </button>
        )}
      </div>
      <ul className="divide-y divide-[#F0E4D6] max-h-72 overflow-y-auto">
        {shown.map((f, i) => (
          <li key={i} className="px-3 py-2 text-xs text-[#3D2614] flex gap-2">
            <span className="text-[#8B7355] shrink-0 tabular-nums">{f.row != null ? `Row ${fmtInt(f.row)}` : '—'}</span>
            <span className="min-w-0 break-words">{f.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const IMPORT_STATUS_STYLES: Record<string, string> = {
  running: 'bg-blue-100 text-blue-700 border-blue-300',
  completed: 'bg-green-100 text-green-700 border-green-300',
  failed: 'bg-red-100 text-red-700 border-red-300',
};

function ImportCard({ im, open, onToggle, onDelete, deleteBlocked }: {
  im: ImportRow; open: boolean; onToggle: () => void; onDelete: () => void; deleteBlocked: boolean;
}) {
  const failures = useMemo(() => parseFailures(im.errors_json), [im.errors_json]);
  const status = String(im.status || '').toLowerCase();
  const partial = Number(im.rows_processed ?? 0) < Number(im.rows_total ?? 0);

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
      <div role="button" tabIndex={0} onClick={onToggle}
           onKeyDown={e => { if (e.key === 'Enter') onToggle(); }}
           className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-[#FFF8F0] focus:outline-none focus:bg-[#FFF1E3]">
        <FileSpreadsheet className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-sm text-[#2D1B0E] truncate">{im.file_name || 'Unnamed file'}</p>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${IMPORT_STATUS_STYLES[status] || 'bg-slate-100 text-slate-700 border-slate-300'}`}>
              {(im.status || 'unknown').toUpperCase()}
            </span>
            {/* Not a failure — a run that stopped early. The unique reservego_key
                makes re-uploading the same file safe, so this is a prompt, not
                an alarm. */}
            {partial && status !== 'running' && (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-300">
                PARTIAL — RE-UPLOAD TO FINISH
              </span>
            )}
            {/* An undated file cannot out-rank a booking that carries an export
                stamp, so its rows are refused rather than applied. Said here,
                on the card, because the fix is to restore the Reservego file
                name and the owner is the only one who can do that. */}
            {im.stamp_source === 'none' && (
              <span title="No Reservego export stamp in the file name and no Booking Time to fall back on — this upload cannot overwrite anything that came from a dated export."
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-800 border-amber-300">
                UNDATED FILE
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#6B5744] mt-0.5">
            {fmtStamp(im.started_at || im.created_at) || '—'}
            {im.finished_at ? ` → ${fmtStamp(im.finished_at)}` : ''}
            {im.imported_by ? ` · by ${im.imported_by}` : ''}
          </p>
          <p className="text-[11px] text-[#6B5744] mt-0.5">
            {fmtInt(im.rows_processed)} / {fmtInt(im.rows_total)} rows ·
            {' '}{fmtInt(im.new_bookings)} new · {fmtInt(im.updated_bookings)} updated ·
            {' '}{fmtInt(im.new_customers)} new customers
            {Number(im.skipped_stale) > 0 && <> · {fmtInt(im.skipped_stale)} older than stored</>}
            {Number(im.failed_rows) > 0 && <span className="text-red-600 font-medium"> · {fmtInt(im.failed_rows)} failed</span>}
          </p>
          {im.source_exported_at && (
            <p className="text-[11px] text-[#8B7355] mt-0.5">Export taken {fmtStamp(im.source_exported_at)}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Inside a role="button" row, so both the click and the Enter that
              produced it are stopped here — otherwise opening the confirm panel
              would also toggle the card open behind it. */}
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            onKeyDown={e => e.stopPropagation()}
            disabled={deleteBlocked}
            title={deleteBlocked
              ? 'An upload is running — deleting an import now would race the rows still arriving.'
              : 'Delete the bookings this upload wrote, so the file can be fixed and uploaded again'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-[#8B7355] border border-[#E0D0BE] rounded-lg hover:text-red-700 hover:border-red-300 hover:bg-red-50 disabled:opacity-40 disabled:hover:text-[#8B7355] disabled:hover:border-[#E0D0BE] disabled:hover:bg-transparent transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Delete this upload</span>
          </button>
          <div className="text-[#8B7355] pl-1">{open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</div>
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[#F0E4D6] pt-3">
          <CounterGrid c={im} rowsTotal={Number(im.rows_total ?? 0)} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Import ID" value={im.id} />
            <Field label="Started" value={fmtStamp(im.started_at)} />
            <Field label="Finished" value={fmtStamp(im.finished_at)} />
            <Field label="Recorded" value={fmtStamp(im.created_at)} />
          </div>
          {failures.length > 0
            ? <FailureList failures={failures} />
            : <p className="text-xs text-[#8B7355]">No failed rows recorded for this import.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The confirm panel for "delete this upload".
 *
 * ONE VOICE. Every sentence here that makes a claim about what the delete does,
 * keeps, removes or cannot tell is computed by the server and printed verbatim,
 * in the order it arrives. This component authors NO claim-bearing prose of its
 * own: only tile labels, one mechanical sentence assembled from the counts, and
 * the fixed chrome around them.
 *
 * That rule is here because the previous build broke it. The server computed a
 * notice, a deletable flag and a blocked reason; the panel dropped all three
 * and printed two hardcoded paragraphs of its own beside numbers that had
 * silently parsed to zero. One of those paragraphs promised that a surviving
 * guest keeps an unchanged profile — while the undo was busy rewriting that
 * profile. Two sources of truth, and the wrong one on screen.
 *
 * The second rule is the owner's: the numbers come first, and the button stays
 * dead until a body has passed the strict parse. `canDelete` is computed
 * upstream and handed in whole, so the guard and the button cannot drift.
 */
function DeleteImportDialog({
  im, preview, loading, previewError, confirmText, onConfirmText, canDelete, running,
  error, errorCode, forceArmed, onForceArmed, onCancel, onDelete,
}: {
  im: ImportRow;
  preview: UndoPreview | null;
  loading: boolean;
  previewError: string | null;
  confirmText: string;
  onConfirmText: (v: string) => void;
  canDelete: boolean;
  running: boolean;
  error: string | null;
  errorCode: string;
  forceArmed: boolean;
  onForceArmed: (v: boolean) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const fileName = (im.file_name || '').trim();

  // Escape closes — but never mid-delete, when the request is already gone and
  // closing the panel would only hide what is happening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onCancel]);

  // `import` is a reserved word: aliased, never destructured.
  const summary = preview?.import ?? null;
  const stillRunning = String(summary?.status ?? '') === 'running';
  /**
   * The three "did this row predate the upload" counts are only measurements
   * when the upload's own session row survived to be compared against. With it
   * gone the server sends 'unknown', and a 0 here would read as "nothing older
   * is caught in this", which is the one thing nobody can know. So the whole
   * provenance row is withheld and warning 8 takes its place.
   */
  const measured = preview?.provenance === 'measured';
  const inherited = measured ? (preview?.counts.bookings_from_earlier_imports ?? 0) : 0;
  const blocked = preview !== null && !preview.deletable;
  // Two roads to Force: the preview already knows the server will refuse, or a
  // DELETE came back 409 because the preview had gone stale under us.
  const forceFromError = errorCode === 'import_running';

  /**
   * Written once, rendered under whichever of the two triggers fired. Force
   * overrides a guard that exists for a real reason, so it carries its own
   * consent: the typed confirmation alone will not arm it.
   */
  const forceBlock = (
    <div className="p-3 bg-amber-50 border border-amber-300 rounded-xl space-y-2">
      <p className="text-xs font-bold text-amber-900">Force this delete</p>
      <p className="text-xs text-amber-900 leading-relaxed">
        The server refuses this delete because the upload is still marked as running. Forcing it overrides that
        check. If a browser is still posting batches, those rows will keep arriving under an id that no longer
        appears in Import History and only a second delete will find them.
      </p>
      <label className="flex items-start gap-2 text-xs font-medium text-amber-900 cursor-pointer">
        <input
          type="checkbox"
          checked={forceArmed}
          onChange={e => onForceArmed(e.target.checked)}
          disabled={running}
          className="mt-0.5 w-4 h-4 shrink-0 accent-amber-600"
        />
        <span>I have checked that this upload is not still running.</span>
      </label>
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete this upload"
      onClick={() => { if (!running) onCancel(); }}
      className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-xl my-auto">

        <div className="flex items-start gap-3 px-5 py-4 border-b border-[#F0E4D6]">
          <div className="w-9 h-9 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
            <Trash2 className="w-4 h-4 text-red-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-[#2D1B0E]">Delete this upload</h3>
            <p className="text-xs text-[#6B5744] truncate">{im.file_name || 'Unnamed file'}</p>
            <p className="text-[11px] text-[#8B7355]">
              Imported {fmtStamp(im.started_at || im.created_at) || 'at an unknown time'}
              {im.imported_by ? ` · by ${im.imported_by}` : ''}
            </p>
            {stillRunning && (
              <span className="inline-block mt-1 px-2 py-0.5 text-[10px] font-semibold text-amber-900 bg-amber-50 border border-amber-300 rounded-full">
                Still marked running
              </span>
            )}
          </div>
          <button onClick={onCancel} disabled={running} aria-label="Cancel"
                  className="p-2 text-[#8B7355] hover:bg-[#FFF1E3] rounded-lg disabled:opacity-40 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">

          {/* ── the refusal, if there is one ───────────────────────────────
              Heaviest element on the panel and above the inventory, because a
              refusal outranks a list of what would have gone. The reason is
              the server's sentence, printed as it arrived. */}
          {blocked && preview && (
            <>
              <div className="flex items-start gap-2 p-3 bg-red-50 border-2 border-red-300 rounded-xl">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
                <p className="text-xs text-red-900 leading-relaxed font-medium">{preview.blocked_reason}</p>
              </div>
              {forceBlock}
            </>
          )}

          {/* ── the numbers, fetched before anything can be deleted ────────── */}
          {loading && (
            <div className="flex items-center gap-2 p-3 bg-[#FFF8F0] border border-[#F0E4D6] rounded-xl text-sm text-[#6B5744]">
              <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" />
              Counting exactly what this upload would take with it…
            </div>
          )}

          {previewError && !loading && (
            <>
              <ErrorBox message={previewError} />
              <p className="text-xs text-[#8B7355]">
                Nothing can be deleted until this count comes back — close the panel, hit Refresh and try again.
              </p>
            </>
          )}

          {preview && !loading && (
            <>
              {/* Mechanical: numbers and nothing else. Every claim about what
                  those numbers MEAN lives in the notice below, in the server's
                  words. */}
              <p className="text-sm text-[#2D1B0E] leading-relaxed">
                This removes <strong>{fmtInt(preview.counts.bookings_to_delete)}</strong> booking
                {preview.counts.bookings_to_delete === 1 ? '' : 's'} and{' '}
                <strong>{fmtInt(preview.counts.guests_to_delete)}</strong> guest
                {preview.counts.guests_to_delete === 1 ? '' : 's'};{' '}
                <strong>{fmtInt(preview.counts.guests_to_keep)}</strong> guest
                {preview.counts.guests_to_keep === 1 ? '' : 's'} keep other history and stay.
              </p>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <DeleteTile label="Bookings deleted" value={fmtInt(preview.counts.bookings_to_delete)} tone="text-red-700" />
                <DeleteTile label="Guests deleted" value={fmtInt(preview.counts.guests_to_delete)} tone="text-red-700" />
                <DeleteTile label="Guests kept" value={fmtInt(preview.counts.guests_to_keep)} />
                <DeleteTile label="Kept with no bookings left" value={fmtInt(preview.counts.guests_kept_orphan)}
                            tone={preview.counts.guests_kept_orphan > 0 ? 'text-amber-700' : undefined} />
              </div>

              {/* Second weight: everything else the server counted. None of it
                  is dropped, and the ones that mean "look here" go amber. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <DeleteTile size="sm" label="Guests affected" value={fmtInt(preview.counts.guests_affected)} />
                <DeleteTile size="sm" label="Still linked elsewhere" value={fmtInt(preview.counts.bookings_linked_elsewhere)}
                            tone={preview.counts.bookings_linked_elsewhere > 0 ? 'text-amber-700' : undefined} />
                <DeleteTile size="sm" label="Profiles cleared" value={fmtInt(preview.counts.guests_profile_cleared)}
                            tone={preview.counts.guests_profile_cleared > 0 ? 'text-amber-700' : undefined} />
                <DeleteTile size="sm" label="Duplicates re-counted"
                            value={fmtInt(preview.counts.duplicates_recleared + preview.counts.duplicates_redemoted)}
                            tone={preview.counts.duplicates_recleared + preview.counts.duplicates_redemoted > 0
                              ? 'text-amber-700' : undefined} />
              </div>

              {/* Provenance, and ONLY when the server could measure it. The
                  older-export-stamp half is structurally near-always 0, so it
                  never appears alone: beside its sibling a 0 reads as "this
                  half did not fire", not as "nothing here is inherited". */}
              {measured && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <DeleteTile size="sm" label="From earlier uploads" value={fmtInt(inherited)}
                              tone={inherited > 0 ? 'text-amber-700' : undefined} />
                  <DeleteTile size="sm" label="Created before this upload"
                              value={fmtInt(preview.counts.bookings_created_before_this_import)} />
                  <DeleteTile size="sm" label="Older export stamp"
                              value={fmtInt(preview.counts.bookings_with_older_export_stamp)} />
                </div>
              )}
            </>
          )}

          {/* ── the notice, above the confirmation ─────────────────────────
              Every line the server sent, in its order, word for word. Never
              indexed into, never truncated, never folded behind a "show more",
              never summarised — the array has many shapes and any one of its
              lines may be the one the owner needed to read. The box stays put
              whenever a preview is loaded, so its absence always means "no
              preview", never "no warnings". */}
          {preview && (
            <div className="p-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl space-y-2">
              <p className="text-xs font-semibold text-[#2D1B0E]">Read this before you confirm</p>
              <ul className="list-disc pl-4 space-y-1.5">
                {preview.notice.map((line, i) => (
                  <li key={i} className="text-xs text-[#6B5744] leading-relaxed">{line}</li>
                ))}
              </ul>
            </div>
          )}

          {measured && inherited > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-300 rounded-xl">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <p className="text-xs text-amber-900 leading-relaxed">
                <strong>{fmtInt(inherited)} of these {fmtInt(preview?.counts.bookings_to_delete ?? 0)} bookings
                came from an earlier upload.</strong> This file only re-confirmed them, and deleting it takes them with
                it. To get them back, re-upload the file that created them.
              </p>
            </div>
          )}

          {/* Instead of the warning above, never alongside it: where provenance
              is unknowable, a reassuring number would be a lie of omission. */}
          {preview && !measured && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-300 rounded-xl">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <p className="text-xs text-amber-900 leading-relaxed">
                <strong>This upload’s own record is gone.</strong> Nothing here can work out which of these bookings
                existed before it, so treat every one of them as possibly older than this file.
              </p>
            </div>
          )}

          {error && <ErrorBox message={error} />}

          {/* The 409 said "repeat with force" and, until now, gave the owner no
              way to do it. Shown here only when the blocked banner has not
              already carried it. */}
          {forceFromError && !blocked && forceBlock}

          {/* ── typed confirmation ─────────────────────────────────────────── */}
          <div>
            <label htmlFor="delete-import-confirm" className="block text-xs font-semibold text-[#2D1B0E] mb-1.5">
              {fileName
                ? <>Type the file name <span className="font-mono text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-1.5 py-0.5 break-all">{fileName}</span> or the word <span className="font-mono">DELETE</span> to confirm</>
                : <>Type <span className="font-mono">DELETE</span> to confirm</>}
            </label>
            <input
              id="delete-import-confirm"
              type="text"
              value={confirmText}
              onChange={e => onConfirmText(e.target.value)}
              // Not `!preview`: truthiness is the test that armed a button over
              // numbers nobody could read. Only a parsed body opens this.
              disabled={running || preview === null}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={fileName || 'DELETE'}
              className="w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:border-red-400 disabled:bg-[#FBF6F0] disabled:text-[#8B7355]"
            />
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-5 py-4 border-t border-[#F0E4D6] bg-[#FFFDF9] rounded-b-2xl">
          <button
            onClick={onCancel}
            disabled={running}
            className="px-4 py-2.5 bg-white border border-[#E0D0BE] text-[#6B5744] rounded-xl text-sm font-medium hover:bg-[#FFF1E3] disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={onDelete}
            // canDelete is the whole rule, computed once upstream and shared
            // with runDelete's guard. Nothing is re-derived here.
            disabled={!canDelete}
            title={preview === null
              ? 'Waiting for the count of what this would delete'
              : blocked && !forceArmed
                ? 'The server refuses this delete — tick the force box to override it'
                : undefined}
            className={`flex items-center justify-center gap-2 px-4 py-2.5 text-white rounded-xl text-sm font-semibold shadow-sm transition-colors disabled:opacity-40 ${
              forceArmed
                ? 'bg-red-700 hover:bg-red-800 disabled:hover:bg-red-700 ring-2 ring-amber-400 ring-offset-1'
                : 'bg-red-600 hover:bg-red-700 disabled:hover:bg-red-600'}`}>
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {running
              ? 'Deleting…'
              : preview
                ? `${forceArmed ? 'Force delete' : 'Delete'} ${fmtInt(preview.counts.bookings_to_delete)} booking${preview.counts.bookings_to_delete === 1 ? '' : 's'}`
                : 'Delete this upload'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** `size="sm"` is the secondary weight: same tile, quieter, for the counts that
 *  are context rather than headline. Tone is how a count says "look at me". */
function DeleteTile({ label, value, tone, size }:
                    { label: string; value: string; tone?: string; size?: 'sm' }) {
  const small = size === 'sm';
  return (
    <div className={`bg-[#FFF8F0] border border-[#F0E4D6] rounded-xl ${small ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}>
      <p className={`${small ? 'text-[9px]' : 'text-[10px]'} text-[#8B7355] uppercase tracking-wide leading-tight`}>{label}</p>
      <p className={`${small ? 'text-sm' : 'text-lg'} font-bold ${tone || 'text-[#2D1B0E]'}`}>{value}</p>
    </div>
  );
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  if (pageCount <= 1) return null;
  const set = new Set<number>([1, 2, page - 1, page, page + 1, pageCount - 1, pageCount]);
  const nums = [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: (number | string)[] = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1] > 1) items.push(`gap${i}`); items.push(n); });
  return (
    <div className="flex items-center gap-1">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]">
        <ChevronLeft className="w-4 h-4" />
      </button>
      {items.map(n => typeof n === 'string'
        ? <span key={n} className="px-1 text-[#8B7355]">…</span>
        : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
                  className={`min-w-[36px] h-9 px-2 rounded-lg text-sm font-medium ${n === page ? 'bg-[#af4408] text-white' : 'border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>{n}</button>)}
      <button disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]">
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ─────────────────────── query tab components ───────────────────────────── */

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 py-1.5 border-t border-[#F5EDE3]">
      <span className="sm:w-[4.5rem] shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[#8B7355]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, title, children }: {
  on: boolean; onClick: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
        on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'
      }`}>
      {children}
    </button>
  );
}

/**
 * The schema panel the owner asked for by name: which TABLES can be queried and
 * which COLUMNS they hold.
 *
 * Every name here comes off the query response, never from a list in this file.
 * A hardcoded copy would look right the day it was written and lie the first
 * time a column was added — and the SQL box below is the one place on this page
 * where a wrong column name costs the reader a round trip to find out.
 */
function SchemaPanel({ tables, loading, onInsert }: {
  tables: SchemaTable[]; loading: boolean; onInsert: (text: string) => void;
}) {
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needle = find.trim().toLowerCase();

  return (
    <aside className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden xl:sticky xl:top-4">
      <div className="px-4 py-3 border-b border-[#F0E4D6]">
        <p className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
          <Table2 className="w-4 h-4 text-[#af4408]" />What you can query
        </p>
        <p className="text-[11px] text-[#8B7355] mt-0.5">
          Tables and columns exactly as the server reports them. Click a column to drop its name into the SQL box.
        </p>
        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8B7355]" />
          <input
            value={find}
            onChange={e => setFind(e.target.value)}
            placeholder="Find a column…"
            aria-label="Find a column"
            className="w-full pl-8 pr-2.5 py-2 bg-white border border-[#E0D0BE] rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-[#af4408]/30"
          />
        </div>
      </div>

      <div className="max-h-[26rem] xl:max-h-[34rem] overflow-y-auto divide-y divide-[#F0E4D6]">
        {loading && (
          <p className="px-4 py-6 text-xs text-[#8B7355] flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />Reading the schema…
          </p>
        )}

        {!loading && tables.length === 0 && (
          <p className="px-4 py-6 text-xs text-[#8B7355]">
            The query returned no schema. Run a filter above and it will fill in.
          </p>
        )}

        {tables.map((t, i) => {
          const cols = needle ? t.columns.filter(c => c.name.toLowerCase().includes(needle)) : t.columns;
          const tableMatches = t.table.toLowerCase().includes(needle);
          if (needle && cols.length === 0 && !tableMatches) return null;
          // While searching every surviving table is forced open — a hit hidden
          // behind a collapsed header is a hit the reader will never see.
          const isOpen = needle ? true : (open[t.table] ?? i === 0);
          const shown = needle ? cols : t.columns;
          return (
            <div key={t.table}>
              <button
                onClick={() => setOpen(o => ({ ...o, [t.table]: !isOpen }))}
                className="w-full px-4 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[#FFF8F0]">
                <span className="font-mono text-[12px] font-semibold text-[#2D1B0E] truncate">{t.table}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] text-[#8B7355]">{t.columns.length} cols</span>
                  {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-[#8B7355]" /> : <ChevronDown className="w-3.5 h-3.5 text-[#8B7355]" />}
                </span>
              </button>
              {isOpen && (
                <ul className="pb-2">
                  {shown.map(c => (
                    <li key={c.name}>
                      <button
                        onClick={() => onInsert(`${t.table}.${c.name}`)}
                        title={`Insert ${t.table}.${c.name} into the SQL box`}
                        className="w-full px-4 py-1 flex items-baseline justify-between gap-2 text-left hover:bg-[#FFF1E3]">
                        <span className="font-mono text-[11px] text-[#3D2614] truncate">{c.name}</span>
                        {c.type && <span className="text-[10px] text-[#A8927A] shrink-0">{c.type}</span>}
                      </button>
                    </li>
                  ))}
                  {shown.length === 0 && <li className="px-4 py-1 text-[11px] text-[#A8927A]">no matching column</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The aggregate cards. Rendered from whatever keys the route sends rather than
 *  a fixed set, so a metric added server-side appears without a UI change. */
function AggregateCards({ agg }: { agg: Record<string, unknown> }) {
  const entries = Object.entries(agg).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
  if (entries.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      {entries.map(([k, v]) => (
        <div key={k} className="bg-white border border-[#E8D5C4] rounded-xl px-3 py-2.5 shadow-sm">
          <p className="text-[10px] text-[#8B7355] uppercase tracking-wide truncate" title={humanize(k)}>{humanize(k)}</p>
          <p className="text-lg font-bold text-[#2D1B0E]">{fmtAggregate(k, v)}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Alignment is decided from the first row that actually has a value for the
 * column: numbers right, everything else left. Reading a column of figures that
 * is left-aligned because row one happened to be NULL is the kind of small
 * wrongness that makes a results grid feel untrustworthy.
 */
function numericColumns(columns: string[], rows: unknown[], cell: (row: any, col: string, i: number) => unknown): Set<string> {
  const out = new Set<string>();
  columns.forEach((c, i) => {
    for (const r of rows) {
      const v = cell(r, c, i);
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') out.add(c);
      break;
    }
  });
  return out;
}

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const cell = (row: any, col: string) => row?.[col];
  const numeric = useMemo(() => numericColumns(columns, rows, cell), [columns, rows]);
  if (columns.length === 0) return null;
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-auto max-h-[34rem]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
              {columns.map(c => (
                <th key={c} title={c}
                    className={`py-2.5 px-3 font-semibold whitespace-nowrap bg-[#FFF8F0] ${numeric.has(c) ? 'text-right' : 'text-left'}`}>
                  {humanize(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                {columns.map(c => (
                  <td key={c} className={`py-2 px-3 align-top ${numeric.has(c) ? 'text-right tabular-nums' : ''}`}>
                    <span className="block max-w-[18rem] truncate" title={r?.[c] == null ? '' : String(r[c])}>
                      {fmtCell(c, r?.[c])}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The escape hatch, for the questions the chips above cannot ask.
 *
 * No extra permission check lives here on purpose: /crm-calls/database is an
 * adminOnly page and the route behind this box is admin-only too, so a second
 * gate in the UI would be theatre — the real one is on the server, which is
 * also where read-only and the time limit are enforced. The warning says so
 * plainly rather than promising anything this component can guarantee.
 */
function SqlConsole({ text, onText, onRun, running, result, error, onExport }: {
  text: string;
  onText: (v: string) => void;
  onRun: () => void;
  running: boolean;
  result: SqlResult | null;
  error: string | null;
  onExport: () => void;
}) {
  const cell = (row: any, col: string, i: number) => (Array.isArray(row) ? row[i] : row?.[col]);
  const numeric = useMemo(
    () => (result ? numericColumns(result.columns, result.rows, cell) : new Set<string>()),
    [result],
  );

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[#F0E4D6] flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[#af4408]" />Advanced SQL
        </p>
        {result && (
          <p className="text-[11px] text-[#6B5744] whitespace-nowrap">
            {fmtInt(result.rowCount)} row{result.rowCount === 1 ? '' : 's'} · {fmtInt(result.ms)} ms
          </p>
        )}
      </div>

      <div className="p-4 space-y-3">
        <p className="text-xs text-[#6B5744]">
          Read-only. The server runs one SELECT, refuses anything that would write, and cuts the query off if it
          runs too long. Nothing typed here can change or delete a booking.
        </p>

        <textarea
          value={text}
          onChange={e => onText(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onRun(); } }}
          rows={5}
          spellCheck={false}
          placeholder={"SELECT strftime('%w', booking_date) AS dow, COUNT(*) AS bookings\nFROM ct_bookings\nWHERE is_duplicate = 0\nGROUP BY 1\nORDER BY 2 DESC"}
          aria-label="SQL query"
          className="w-full font-mono text-[12px] leading-5 p-3 bg-[#FFFDF9] border border-[#E0D0BE] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#af4408]/30 focus:border-[#af4408] resize-y"
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onRun}
            disabled={running || !text.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-lg text-sm font-semibold shadow-sm transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Running…' : 'Run'}
          </button>
          <span className="text-[11px] text-[#8B7355]">⌘/Ctrl + Enter</span>
          {result && result.rows.length > 0 && (
            <button onClick={onExport}
                    className="ml-auto flex items-center gap-2 px-3 py-2 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium transition-colors">
              <Download className="w-3.5 h-3.5" />CSV of these {fmtInt(result.rows.length)} rows
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
            <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700 font-mono break-words">{error}</p>
          </div>
        )}

        {result && result.rows.length === 0 && !error && (
          <p className="text-xs text-[#8B7355]">That ran fine and returned no rows.</p>
        )}

        {result && result.rows.length > 0 && (
          <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="overflow-auto max-h-[28rem]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4]">
                    {result.columns.map(c => (
                      <th key={c} title={c}
                          className={`py-2.5 px-3 font-semibold whitespace-nowrap bg-[#FFF8F0] ${numeric.has(c) ? 'text-right' : 'text-left'}`}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                      {result.columns.map((c, ci) => {
                        const v = cell(r, c, ci);
                        return (
                          <td key={c} className={`py-2 px-3 align-top ${numeric.has(c) ? 'text-right tabular-nums' : ''}`}>
                            <span className="block max-w-[18rem] truncate" title={v == null ? '' : String(v)}>
                              {fmtCell(c, v)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
