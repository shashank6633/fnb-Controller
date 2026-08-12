'use client';

/**
 * CENTRAL STORE CUTOVER — count the shelf once, and start the book from truth.
 *
 * WHY THIS SCREEN EXISTS (read before changing a word of the copy).
 * raw_materials.current_stock is a RUNNING BALANCE, never an observation:
 * opening + every recorded inflow − every recorded outflow. Outflows record
 * themselves; inflows need a human to type a purchase or a GRN, and cash-market
 * runs, doorstep deliveries and emergency top-ups never get typed. The error is
 * therefore one-directional and cumulative, and every variance report in this
 * app is currently measuring DRIFT, not LOSS. A cutover is the fix: count
 * everything physically on one date, record it as the opening figure, and from
 * that date a variance means something real.
 *
 * WHAT THIS SCREEN IS ALLOWED TO DO — the owner's rulings, in effect:
 *  · RULING 1 — the correction is NON-FINANCIAL. commitBatch writes NO purchases
 *    row, NO inventory_transactions row, NO closing_stock row, NO
 *    variance_approvals row, and never touches average_price or
 *    last_purchase_price. The rupee columns here are INFORMATION ONLY and enter
 *    no report. This page must never imply otherwise.
 *  · "an alert for every single variance" — every line whose counted figure
 *    differs from the book gets its OWN durable record (central_cutover_lines),
 *    listed here line by line with book / counted / difference / rupee value.
 *    Nothing is aggregated away. The bell gets ONE entry per batch; that wiring
 *    lives in the notifications route, not here.
 *
 * THE FOUR JOBS, in the order the operator does them:
 *   1 PREPARE  — read the consequences, pick the count date, open a draft,
 *                download the count sheet.
 *   2 ENTER    — upload the filled CSV or type counts inline. What was accepted,
 *                what was rejected and WHY, and above all WHAT IS STILL
 *                UNCOUNTED — the uncounted list is the most important thing on
 *                this screen before commit.
 *   3 REVIEW   — every line, biggest rupee impact first, filterable down to just
 *                the ones that moved. Quantities LEAD IN PURCHASE UNITS.
 *   4 COMMIT   — a confirmation that says in plain words how many materials are
 *                overwritten, how many are left untouched because nobody counted
 *                them, and that it cannot be undone. Then the batch becomes a
 *                permanent record.
 *
 * A BLANK IS NEVER A ZERO. The engine refuses blanks by name; this page never
 * sends a row the operator left empty, and says how many it skipped. Sending
 * them would both drown the rejection report and risk reading "untouched" as
 * "empty".
 *
 * THE COUNT SHEET IS BLIND, AND THE DOWNLOAD IS THE SERVER'S, NOT THIS PAGE'S.
 * GET .../sheet?format=csv emits a sheet carrying NO book quantity for anyone,
 * admin included, plus its own instruction banner. A counter who can see the
 * expected number stops counting and starts confirming, and on a cutover that
 * would bake six months of drift in permanently. So this page does NOT build the
 * walking sheet client-side; the one CSV it does generate (the uncounted
 * follow-up list) carries the same blind columns and the same headers, so it
 * re-uploads through the same parser.
 *
 * THE CONSEQUENCE COPY COMES FROM THE API (`notices`), rendered verbatim. It is
 * served rather than hard-coded here for the same reason /api/variance-report
 * serves its own title and formula: the page, the preview and the confirmation
 * must not be able to drift apart on what they promise.
 *
 * API CONTRACT — matches src/app/api/inventory/central-cutover/route.ts:26-38.
 * Every call degrades to a named on-screen error rather than a blank screen.
 *   GET    /api/inventory/central-cutover              state of play
 *   POST   /api/inventory/central-cutover              open (or fetch) the draft
 *   GET    .../sheet[?format=csv&include_inert=1]      the blind count sheet
 *   GET    .../lines?batch_id=                         what is staged
 *   POST   .../lines        { batch_id, lines[] }      stage / re-stage
 *   DELETE .../lines?batch_id=&material_id=            drop one staged count
 *   POST   .../upload       (multipart file)           stage a filled CSV
 *   GET    .../preview?batch_id=                       book vs counted vs rupees
 *   POST   .../commit       { batch_id, confirm }      ADMIN — apply it
 *   GET    .../batches/<id>                            review a batch afterwards
 *   DELETE .../batches/<id>                            abandon a draft
 *   POST   .../alerts       { batch_id, material_ids } ADMIN — mark reviewed
 * Types mirror src/lib/central-cutover.ts.
 *
 * ADMIN ONLY in the page catalog, because the commit is a one-way overwrite of
 * hundreds of stock figures. The API is deliberately wider (any signed-in user
 * may read a BLIND sheet, a stager may stage, only an admin may commit), so this
 * page honours `blind`, `can_stage` and `can_commit` from the payload rather
 * than assuming its viewer: if the catalog gate is ever widened, the screen
 * degrades correctly instead of printing nulls as zeroes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import { api } from '@/lib/api';
import { fmtQtyNum, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, CheckCircle2,
  ClipboardList, FileWarning, History, Info, Loader2, Lock, PackageX,
  RefreshCw, Search, ShieldAlert, Trash2, Upload, Wine, X,
} from 'lucide-react';

/* ──────────────────────────────────────────────────────────────────────────
 * Wire types — mirror src/lib/central-cutover.ts, with the blind-count nulls
 * the route's _lib/guards.ts substitutes for a non-admin. Every book-derived
 * field is `number | null | undefined`, and every reader below treats null as
 * "not shown", never as 0. A confident zero here is a wrong stock figure.
 * ────────────────────────────────────────────────────────────────────────── */

type BatchStatus = 'draft' | 'committed' | 'cancelled';
type Nullable = number | null | undefined;

interface Batch {
  id: string;
  cutover_date: string;
  status: BatchStatus;
  note?: string;
  created_by?: string;
  created_at?: string;
  committed_by?: string;
  committed_at?: string;
  cancelled_by?: string;
  cancelled_at?: string;
  counted_lines?: number;
  /** Blind-stripped to null for a non-admin. */
  variance_lines?: Nullable;
  net_variance_value?: Nullable;
  shortage_value?: Nullable;
  excess_value?: Nullable;
  stamped?: number;
}

interface SheetRow {
  material_id: string;
  name: string;
  sku?: string;
  category?: string;
  /** RECIPE units — null for a non-admin (blind count). */
  book_qty?: Nullable;
  /** PURCHASE units — what this page leads with. Null for a non-admin. */
  book_qty_purchase?: Nullable;
  unit?: string;
  purchase_unit?: string;
  pack_factor?: number;
  unit_value?: Nullable;
  rate_source?: string;
  book_value?: Nullable;
  has_activity?: boolean;
  staged?: boolean;
  staged_qty?: Nullable;
  staged_unit?: string;
}

interface SheetSummary {
  total_materials?: number;
  store_excluded?: number;
  central_materials?: number;
  with_activity?: number;
  inert?: number;
  book_value?: Nullable;
  store_excluded_reason?: string;
}

interface StageRejection {
  row: number; material_id: string; name: string;
  reason: 'blank' | 'not_a_number' | 'negative' | 'unknown_material' | 'unit_required' | 'unknown_unit' | 'store_mapped';
  detail: string;
}
interface StageBlocked { row: number; material_id: string; name: string; error: string }

interface PreviewLine {
  material_id: string;
  name: string;
  counted_qty: number;
  counted_unit: string;
  pack_factor?: number;
  counted_qty_recipe: number;
  counted_qty_purchase?: Nullable;
  book_qty_recipe?: Nullable;
  book_qty_purchase?: Nullable;
  variance_recipe?: Nullable;
  variance_purchase?: Nullable;
  unit?: string;
  purchase_unit?: string;
  unit_value?: Nullable;
  rate_source?: string;
  variance_value?: Nullable;
  will_alert?: boolean | null;
  blocked?: boolean;
  moved_since_stage?: number;
  stock_changed?: boolean;
  record_edited?: boolean;
  pack_factor_changed?: boolean;
  now_store_mapped?: boolean;
  staged_at?: string;
  /** The instant this line's count SPEAKS FOR — the lower bound the movement
   *  probe measured from. staged_at on a same-day count; the IST start of the
   *  count date on a BACKDATED batch. */
  counted_as_of?: string;
  /** The count date is earlier than the day the line was typed in, so the fence
   *  runs from the count date and RE-STAGING CANNOT CLEAR IT. The badge must say
   *  that instead of offering a re-count that will not work. */
  backdated?: boolean;
}

interface PreviewSummary {
  counted_lines?: number;
  variance_lines?: Nullable;
  zero_counts?: number;
  net_variance_value?: Nullable;
  shortage_value?: Nullable;
  excess_value?: Nullable;
  uncounted_materials?: number;
  blocked_lines?: number;
  no_rate_lines?: Nullable;
}

interface Preview {
  batch: Batch;
  lines: PreviewLine[];
  summary: PreviewSummary;
  /** Is the BATCH ready to apply? */
  can_commit: boolean;
  /** May THIS viewer press the button? null when the payload predates the field. */
  viewer_can_commit: boolean | null;
  blockers: string[];
}

/** A batch's frozen line — the durable per-variance record. */
interface RecordLine {
  material_id: string;
  material_name: string;
  counted_qty: number;
  counted_unit: string;
  counted_qty_recipe: number;
  pack_factor?: number;
  /** Snapshot of the figure actually overwritten, taken inside the commit txn. */
  book_qty_recipe?: Nullable;
  variance_recipe?: Nullable;
  unit?: string;
  recipe_unit?: string;
  purchase_unit?: string;
  unit_value?: Nullable;
  rate_source?: string;
  variance_value?: Nullable;
  alert?: Nullable;
  note?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_note?: string;
}

interface Notice { id: string; text: string }

interface Status {
  /** The boundary as stored: the count date at MIDNIGHT. A business date, not a
   *  clock reading — never format it as a time. See cutover_committed_at. */
  cutover_at: string | null;
  cutover_date: string | null;
  /** The real instant the book was re-based. Null on a hand-stamped install. */
  cutover_committed_at: string | null;
  today: string | null;
  draft: Batch | null;
  draft_staged_lines: number;
  draft_remaining: number | null;
  sheet_summary: SheetSummary;
  recent_batches: Batch[];
  unreviewed_alert_lines: number | null;
  notices: Notice[];
  can_stage: boolean;
  can_commit: boolean;
  blind: boolean;
}

const EMPTY_STATUS: Status = {
  cutover_at: null, cutover_date: null, cutover_committed_at: null, today: null, draft: null,
  draft_staged_lines: 0, draft_remaining: null, sheet_summary: {},
  recent_batches: [], unreviewed_alert_lines: null, notices: [],
  // Fail CLOSED until the server says otherwise: a page that renders its
  // buttons live before it knows the viewer's rights invites a click that only
  // fails at the server, on the one screen where that reads as "did it work?".
  can_stage: false, can_commit: false, blind: true,
};

/* ──────────────────────────────────────────────────────────────────────────
 * Formatting. Money formatters carry the ₹ themselves so the purchase-unit lock
 * (scripts/check-purchase-units.js) can tell them from quantity formatters.
 * ────────────────────────────────────────────────────────────────────────── */

/** Is this a real number, as opposed to a blind-stripped null or a gap? */
const has = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const inr = (v: Nullable) => '₹' + Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-IN');
/** Signed rupees, minus rendered as a true minus sign. */
const inrSigned = (v: Nullable) => {
  const n = Number(v) || 0;
  return (n < 0 ? '−₹' : '+₹') + Math.abs(Math.round(n)).toLocaleString('en-IN');
};
/** Rupees, or an em dash when the figure was withheld. Never a coerced 0. */
const inrOrDash = (v: Nullable) => (has(v) ? inr(v) : '—');
const num = (v: Nullable) => (Number(v) || 0).toLocaleString('en-IN');
const numOrDash = (v: Nullable) => (has(v) ? num(v) : '—');

/** Pack meta for the shared display layer. pack_factor is the frozen wire field
 *  (see pack-units.ts) — this never re-derives the pack rule by hand. */
const metaOf = (r: { unit?: string; purchase_unit?: string; pack_factor?: number }): PackMeta =>
  ({ unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_factor });

/** The PURCHASE unit label — what every quantity on this page is printed in. */
const puOf = (r: { unit?: string; purchase_unit?: string }) =>
  (r.purchase_unit || r.unit || '').trim();

/** The two units a count may legitimately be typed in, in the order the entry
 *  dropdown offers them. Purchase first: the owner rule is that the human counts
 *  in the purchase unit. */
const unitsOf = (r: { unit?: string; purchase_unit?: string }) =>
  Array.from(new Set([puOf(r), (r.unit || '').trim()].filter(Boolean)));

/**
 * WHICH UNIT THIS ROW'S COUNT IS IN — ONE definition, read by the dropdown that
 * displays it AND the save handler that sends it.
 *
 * They were two different expressions. The dropdown showed
 * `entryUnit[id] ?? (staged_unit || purchase unit)` while the save sent
 * `entryUnit[id] || purchase unit`, so a row already staged in the RECIPE unit
 * redisplayed as 'g' and submitted as 'kg' unless the operator happened to touch
 * the dropdown. On a 1,000 g/kg pack that is a silent 1,000x error written
 * straight into a cutover, which SETS the book. Two expressions for one value is
 * the whole bug; there is now one.
 *
 * A stored unit that is no longer one of the material's own two (its pack meta
 * changed after staging) falls back to the purchase unit — which is also what
 * the <select> would render, since a value matching no <option> shows blank.
 */
const countUnitOf = (
  r: { unit?: string; purchase_unit?: string; staged_unit?: string },
  chosen?: string,
): string => {
  const units = unitsOf(r);
  const pick = String(chosen ?? '').trim();
  if (pick && units.includes(pick)) return pick;
  const staged = String(r.staged_unit ?? '').trim();
  if (staged && units.includes(staged)) return staged;
  return puOf(r);
};

/**
 * A recipe quantity rendered in PURCHASE units (owner rule: every store or
 * inventory figure a human reads leads with kg / L / BTL, never g / ml).
 * Prefers the server's own purchase figure; falls back to the shared converter
 * when the payload predates that field. Returns an em dash when BOTH are absent
 * — which is what a blind-stripped book figure looks like, and printing 0 there
 * would be a fabricated stock reading.
 */
const inPU = (
  r: { unit?: string; purchase_unit?: string; pack_factor?: number },
  recipeQty: Nullable,
  serverPurchaseQty?: Nullable,
) => {
  if (has(serverPurchaseQty)) return fmtQtyNum(serverPurchaseQty);
  if (has(recipeQty)) return fmtQtyNum(toPurchaseQty(recipeQty, metaOf(r)));
  return '—';
};

/** The small "= 3,000 g" recipe hint, or null when the material never converts
 *  (or when the figure itself was withheld). */
const recipeHint = (
  r: { unit?: string; purchase_unit?: string; pack_factor?: number },
  recipeQty: Nullable,
) => ((Number(r.pack_factor) || 1) > 1 && has(recipeQty)
  ? `= ${fmtQtyNum(recipeQty)} ${r.unit || ''}`
  : null);

function istWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function saveCsvRows(rows: string[][], filename: string) {
  // Leading BOM: Excel on Windows reads a bare UTF-8 CSV as Latin-1 and mangles
  // every accented material name. The server sheet does the same.
  const body = '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  saveBlob(new Blob([body], { type: 'text/csv;charset=utf-8' }), filename);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** IST calendar day. Only a fallback — the server sends `today`. */
function istTodayStr(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  return ist.toISOString().slice(0, 10);
}

/**
 * The uncounted follow-up CSV. Column names and order are the server sheet's
 * (see _lib/count-sheet.ts SHEET_COLUMNS_BASE) so the filled file re-uploads
 * through the same header-keyed parser. NO BOOK QUANTITY — this sheet goes back
 * out to the floor and the count stays blind.
 */
const UNCOUNTED_COLUMNS = ['category', 'code', 'item', 'count_unit', 'counted_qty', 'note', 'material_id'];

/** How many table rows render before the "show more" step. 800+ <tr> each with
 *  an input is a visibly slow page on the counting desk's tablet. */
const PAGE_STEP = 200;

type Tab = 'run' | 'history';
type ReviewFilter = 'all' | 'variance' | 'match' | 'blocked' | 'zero';

export default function CentralCutoverPage() {
  const [tab, setTab] = useState<Tab>('run');
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 6000); };

  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [sheetRowsRaw, setSheetRowsRaw] = useState<SheetRow[] | null>(null);
  const [sheetSummary, setSheetSummary] = useState<SheetSummary>({});
  const [sheetTruncated, setSheetTruncated] = useState(false);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [includeInert, setIncludeInert] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // Prepare
  const [newDate, setNewDate] = useState(istTodayStr());
  const [newNote, setNewNote] = useState('');
  const [starting, setStarting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Enter
  const [entry, setEntry] = useState<Record<string, string>>({});
  const [entryUnit, setEntryUnit] = useState<Record<string, string>>({});
  const [savingCounts, setSavingCounts] = useState(false);
  const [stageResult, setStageResult] = useState<{
    accepted: number; updated: number; rejected: StageRejection[];
    store_blocked: StageBlocked[]; skipped_blank: number; source: string;
    /** Operator-facing sentences composed by the upload route (duplicate counts,
     *  ignored columns, a file longer than the whole store). Rendered verbatim. */
    warnings: string[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sheetSearch, setSheetSearch] = useState('');
  const [sheetOnly, setSheetOnly] = useState<'all' | 'uncounted' | 'counted'>('all');
  const [sheetLimit, setSheetLimit] = useState(PAGE_STEP);

  // Review
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('variance');
  const [reviewSearch, setReviewSearch] = useState('');
  const [reviewLimit, setReviewLimit] = useState(PAGE_STEP);

  // Commit
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmWord, setConfirmWord] = useState('');
  const [committing, setCommitting] = useState(false);

  // History / record
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [record, setRecord] = useState<
    { batch: Batch; lines: RecordLine[]; bookRecorded: boolean; truncated: boolean } | null
  >(null);
  const [recordErr, setRecordErr] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState<'alerts' | 'all' | 'unreviewed'>('alerts');
  const [recordLimit, setRecordLimit] = useState(PAGE_STEP);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  const draft = status.draft;
  const blind = status.blind;
  const today = status.today || istTodayStr();
  const BASE = '/api/inventory/central-cutover';

  /**
   * One place that turns a failed fetch into a sentence. A 404 means the route
   * has not shipped yet, and saying so beats a blank panel. A CutoverError body
   * carries `code` and `details`; the message is already written as an operator
   * instruction, so it is surfaced verbatim.
   */
  const readJson = useCallback(async (res: Response, what: string) => {
    if (res.status === 401 || res.status === 403) { setForbidden(true); throw new Error('forbidden'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error(res.status === 404
        ? `${what} is not available yet — ${BASE} answered 404.`
        : `${what} failed — the server answered ${res.status} without JSON.`);
    }
    const j = await res.json();
    if (!res.ok) throw new Error(String(j?.error || `${what} failed (HTTP ${res.status})`));
    return j;
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const j = await readJson(await fetch(BASE, { credentials: 'same-origin' }), 'Cutover status');
      setStatus({
        cutover_at: j?.cutover_at ?? null,
        cutover_date: j?.cutover_date ?? null,
        cutover_committed_at: j?.cutover_committed_at ?? null,
        today: j?.today ?? null,
        draft: j?.draft?.id ? (j.draft as Batch) : null,
        draft_staged_lines: Number(j?.draft_staged_lines) || 0,
        draft_remaining: has(j?.draft_remaining) ? j.draft_remaining : null,
        sheet_summary: j?.sheet_summary || {},
        recent_batches: Array.isArray(j?.recent_batches) ? j.recent_batches : [],
        unreviewed_alert_lines: has(j?.unreviewed_alert_lines) ? j.unreviewed_alert_lines : null,
        notices: Array.isArray(j?.notices) ? j.notices : [],
        can_stage: !!j?.can_stage,
        can_commit: !!j?.can_commit,
        blind: !!j?.blind,
      });
      if (j?.today && !j?.draft) setNewDate(String(j.today));
    } catch (e) {
      if ((e as Error).message !== 'forbidden') setErr((e as Error).message);
    } finally { setLoading(false); }
  }, [readJson]);

  const loadSheet = useCallback(async () => {
    setSheetErr(null);
    try {
      const qs = new URLSearchParams();
      if (includeInert) qs.set('include_inert', '1');
      const j = await readJson(await fetch(`${BASE}/sheet?${qs.toString()}`, { credentials: 'same-origin' }), 'The count sheet');
      setSheetRowsRaw(Array.isArray(j?.rows) ? j.rows : []);
      setSheetSummary(j?.summary || {});
      setSheetTruncated(!!j?.truncated);
    } catch (e) {
      if ((e as Error).message !== 'forbidden') setSheetErr((e as Error).message);
      setSheetRowsRaw(null);
    }
  }, [includeInert, readJson]);

  const loadPreview = useCallback(async (batchId: string) => {
    setPreviewErr(null);
    try {
      const j = await readJson(
        await fetch(`${BASE}/preview?batch_id=${encodeURIComponent(batchId)}`, { credentials: 'same-origin' }),
        'The review list',
      );
      setPreview({
        batch: (j?.batch as Batch) || ({ id: batchId } as Batch),
        lines: Array.isArray(j?.lines) ? j.lines : [],
        summary: j?.summary || {},
        // TWO DIFFERENT QUESTIONS, and the route names them apart on purpose:
        // `can_commit` is whether the BATCH is ready, `viewer_can_commit` is
        // whether this person may press the button. Conflating them would either
        // offer a click the server refuses or hide a legitimate blocker behind a
        // permission message.
        can_commit: !!j?.can_commit,
        viewer_can_commit: typeof j?.viewer_can_commit === 'boolean' ? j.viewer_can_commit : null,
        blockers: Array.isArray(j?.blockers) ? j.blockers : [],
      });
    } catch (e) {
      if ((e as Error).message !== 'forbidden') setPreviewErr((e as Error).message);
      setPreview(null);
    }
  }, [readJson]);

  const loadRecord = useCallback(async (batchId: string) => {
    setRecordErr(null); setRecord(null);
    try {
      const j = await readJson(
        await fetch(`${BASE}/batches/${encodeURIComponent(batchId)}`, { credentials: 'same-origin' }),
        'The cutover record',
      );
      setRecord({
        batch: (j?.batch as Batch) || ({ id: batchId } as Batch),
        lines: Array.isArray(j?.lines) ? j.lines : [],
        // book_qty_recipe is the figure the commit OVERWROTE, snapshotted inside
        // that transaction. On a draft or cancelled batch it is still 0 — not a
        // stock reading of zero, just "not recorded yet". The server says which
        // it is, and this column prints a dash rather than a fabricated 0.
        bookRecorded: !!j?.book_qty_recorded,
        truncated: !!j?.truncated,
      });
    } catch (e) {
      if ((e as Error).message !== 'forbidden') setRecordErr((e as Error).message);
    }
  }, [readJson]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { if (tab === 'run') loadSheet(); }, [tab, loadSheet]);
  useEffect(() => {
    if (tab !== 'run') return;
    if (draft?.id) loadPreview(draft.id); else setPreview(null);
  }, [tab, draft?.id, loadPreview]);
  useEffect(() => { if (openBatchId) loadRecord(openBatchId); }, [openBatchId, loadRecord]);

  /* ── actions ─────────────────────────────────────────────────────────── */

  const refreshDraft = async (batchId: string) => {
    await Promise.all([loadSheet(), loadPreview(batchId), loadStatus()]);
  };

  const startBatch = async () => {
    setStarting(true);
    try {
      const j = await readJson(await api(BASE, {
        method: 'POST', body: { cutover_date: newDate, note: newNote },
      }), 'Starting the cutover');
      setStageResult(null); setEntry({}); setEntryUnit({});
      await loadStatus();
      // POST is idempotent-ish: an already-open draft is RETURNED with created:
      // false and a message explaining that the date asked for was not used.
      // Showing the server's sentence rather than a generic success is the whole
      // point — otherwise the operator believes they opened the date they typed.
      flash(String(j?.message || `Draft opened for ${newDate}. Nothing has changed yet.`));
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
    finally { setStarting(false); }
  };

  const cancelDraft = async () => {
    if (!draft) return;
    if (!window.confirm(
      'Abandon this draft? The counts entered so far are discarded. No stock has been changed, '
      + 'so nothing is lost except the typing.')) return;
    try {
      const j = await readJson(await api(`${BASE}/batches/${encodeURIComponent(draft.id)}`, { method: 'DELETE' }), 'Cancelling the draft');
      setStageResult(null); setEntry({}); setEntryUnit({}); setPreview(null);
      await Promise.all([loadStatus(), loadSheet()]);
      flash(String(j?.message || 'Draft abandoned. No stock was changed.'));
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
  };

  const postLines = async (
    lines: Array<{ material_id?: string; sku?: string; name?: string; counted_qty?: unknown; counted_unit?: string; note?: string }>,
    source: string,
    skippedBlank = 0,
  ) => {
    if (!draft) return;
    const j = await readJson(await api(`${BASE}/lines`, {
      method: 'POST', body: { batch_id: draft.id, lines },
    }), 'Saving the counts');
    applyStageResult(j, source, skippedBlank);
    await refreshDraft(draft.id);
  };

  const applyStageResult = (j: any, source: string, skippedBlank: number) => {
    setStageResult({
      accepted: Number(j?.accepted) || 0,
      updated: Number(j?.updated) || 0,
      rejected: Array.isArray(j?.rejected) ? j.rejected : [],
      store_blocked: Array.isArray(j?.store_blocked) ? j.store_blocked : [],
      skipped_blank: skippedBlank,
      source,
      warnings: Array.isArray(j?.warnings) ? j.warnings.map(String) : [],
    });
  };

  const saveTypedCounts = async () => {
    if (!draft || !sheetRowsRaw) return;
    const byId = new Map(sheetRowsRaw.map(r => [r.material_id, r]));
    const lines = Object.entries(entry)
      .filter(([, v]) => String(v ?? '').trim() !== '')
      .map(([material_id, v]) => ({
        material_id,
        // Sent UNPARSED. parseCountedQty in the engine is the one place a blank
        // is told apart from a zero; parsing here would be a second, quieter
        // answer to that question.
        counted_qty: String(v).trim(),
        // THE SAME expression the dropdown renders — see countUnitOf. Do not
        // inline a second one here.
        counted_unit: countUnitOf(byId.get(material_id) || {}, entryUnit[material_id]),
      }));
    if (lines.length === 0) { flash('Nothing typed in — a blank cell is not a zero, so nothing was sent.'); return; }
    setSavingCounts(true);
    try {
      await postLines(lines, `${lines.length} typed on screen`);
      setEntry({}); setEntryUnit({});
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
    finally { setSavingCounts(false); }
  };

  const unstage = async (materialId: string) => {
    if (!draft) return;
    try {
      const j = await readJson(await api(
        `${BASE}/lines?batch_id=${encodeURIComponent(draft.id)}&material_id=${encodeURIComponent(materialId)}`,
        { method: 'DELETE' },
      ), 'Removing the count');
      setEntry(p => { const n = { ...p }; delete n[materialId]; return n; });
      await refreshDraft(draft.id);
      if (j?.message) flash(String(j.message));
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
  };

  /** The BLIND walking sheet — generated by the server, never by this page. */
  const downloadCountSheet = async () => {
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ format: 'csv' });
      if (includeInert) qs.set('include_inert', '1');
      const res = await fetch(`${BASE}/sheet?${qs.toString()}`, { credentials: 'same-origin' });
      const ct = res.headers.get('content-type') || '';
      // A 403 saved as "count-sheet.csv" containing {"error":…} is worse than no
      // download at all — the counter only finds out at the shelf.
      if (!res.ok || ct.includes('application/json')) {
        let msg = res.ok ? 'The server did not return a CSV.' : `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = String(j.error); } catch { /* keep the status line */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('The server returned an empty file.');
      saveBlob(blob, `central-cutover-count-sheet-${draft?.cutover_date || today}.csv`);
      flash('Blind count sheet downloaded — it carries no book quantity, on purpose.');
    } catch (e) { flash(`Count sheet download failed — ${(e as Error).message}`); }
    finally { setDownloading(false); }
  };

  /** The uncounted follow-up list. Same blind columns, same headers. */
  const downloadUncounted = () => {
    const out: string[][] = [UNCOUNTED_COLUMNS.slice()];
    for (const r of uncounted) {
      out.push([
        r.category || '', r.sku || '', r.name || '',
        // OWNER RULE: the human counts and types in the PURCHASE unit, and the
        // engine refuses to guess a unit when a pack factor exists — a wrong
        // guess on a 1,000 g/kg pack is an invisible 1,000x error.
        puOf(r),
        '', '', r.material_id,
      ]);
    }
    saveCsvRows(out, `central-cutover-uncounted-${draft?.cutover_date || today}.csv`);
  };

  const uploadCsv = async (file: File) => {
    if (!draft) return;
    setUploading(true);
    try {
      // Preferred path: the server's own importer, which shares its header-keyed
      // parser with the sheet it emitted. If that route has not shipped, fall
      // back to parsing here and posting the same lines to .../lines — the two
      // produce the same staging call, so the feature never dead-ends.
      const fd = new FormData();
      fd.append('file', file);
      fd.append('batch_id', draft.id);
      const res = await api(`${BASE}/upload`, { method: 'POST', body: fd });
      if (res.status === 404) { await uploadViaLines(file); return; }
      const j = await readJson(res, 'Reading the filled sheet');
      applyStageResult(j, file.name, Number(j?.skipped_blank) || 0);
      await refreshDraft(draft.id);
      flash(String(j?.message || `${file.name} read.`));
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
    finally { setUploading(false); }
  };

  /** Client-side fallback importer. Header-keyed with the server sheet's own
   *  aliases (code = sku, item = name), so the emitted template round-trips. */
  const uploadViaLines = async (file: File) => {
    const text = await file.text();
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const pick = (row: Record<string, string>, ...keys: string[]) => {
      for (const k of Object.keys(row)) {
        const norm = String(k ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (keys.includes(norm)) return String(row[k] ?? '').trim();
      }
      return '';
    };
    let skippedBlank = 0;
    const lines: Array<{ material_id?: string; sku?: string; name?: string; counted_qty?: unknown; counted_unit?: string; note?: string }> = [];
    for (const row of parsed.data || []) {
      const qtyCell = pick(row, 'counted_qty', 'counted', 'count', 'physical', 'physical_qty');
      const id = pick(row, 'material_id', 'id');
      const sku = pick(row, 'code', 'sku');
      const nm = pick(row, 'item', 'name', 'material', 'material_name');
      // A TEMPLATE ROW LEFT ALONE IS NOT A COUNT. Every row carries an id, so
      // forwarding blanks would return one "blank" rejection per uncounted
      // material and bury the real errors. They are counted and named instead —
      // and those materials stay in the uncounted list, where they belong.
      if (qtyCell === '') { if (id || sku || nm) skippedBlank++; continue; }
      lines.push({
        material_id: id || undefined,
        sku: sku || undefined,
        name: nm || undefined,
        counted_qty: qtyCell,
        counted_unit: pick(row, 'count_unit', 'counted_unit', 'unit', 'uom') || undefined,
        note: pick(row, 'note', 'remarks', 'remark') || undefined,
      });
    }
    if (lines.length === 0) {
      applyStageResult({}, file.name, skippedBlank);
      flash(`No counts found in ${file.name} — ${skippedBlank} row(s) had an item but an empty count cell.`);
      return;
    }
    await postLines(lines, file.name, skippedBlank);
    flash(`${file.name} read — ${lines.length} count(s) sent.`);
  };

  const commit = async () => {
    if (!draft) return;
    setCommitting(true);
    const batchId = draft.id;
    try {
      const j = await readJson(await api(`${BASE}/commit`, {
        method: 'POST', body: { batch_id: batchId, confirm: 'CUTOVER' },
      }), 'Committing the cutover');
      // COMMIT IS ARM-THEN-APPLY, AND THE ARM ANSWERS 200. Sent without the
      // confirm word the route replies { armed: true, committed: false, … } with
      // a quote of what WOULD happen — a perfectly successful HTTP call in which
      // nothing was applied. Treating any 200 as done would print "Cutover
      // committed" over a store that never moved, on the one screen where a
      // false success is unrecoverable: the operator would stop, believing the
      // book is now true. `committed` is the only field that says it happened.
      if (j?.committed !== true) {
        flash(String(j?.message || 'Nothing was committed — the server did not accept the confirmation.'));
        await loadPreview(batchId);
        return;
      }
      setConfirmOpen(false); setConfirmWord('');
      setPreview(null); setEntry({}); setEntryUnit({}); setStageResult(null);
      await Promise.all([loadStatus(), loadSheet()]);
      setTab('history'); setOpenBatchId(batchId);
      flash(
        `Cutover committed — ${num(j?.applied)} material(s) re-based`
        + (j?.stamp_written ? `. The central store now starts from ${j?.cutover_date || draft.cutover_date}.` : '.'),
      );
    } catch (e) {
      // A refused commit (typically MOVED_SINCE_COUNT — something was purchased
      // or issued between the count and the click) changes nothing. Close the
      // dialog and reload the preview: the offending materials come back marked
      // `blocked` with the reason on the row, which is where the operator can
      // act on them. Leaving the modal open over a stale list invites a second
      // identical click.
      setConfirmOpen(false); setConfirmWord('');
      if ((e as Error).message !== 'forbidden') flash((e as Error).message);
      loadPreview(batchId);
    } finally { setCommitting(false); }
  };

  const markReviewed = async (materialIds: string[]) => {
    if (!openBatchId || materialIds.length === 0) return;
    setReviewBusy(true);
    try {
      const j = await readJson(await api(`${BASE}/alerts`, {
        method: 'POST', body: { batch_id: openBatchId, material_ids: materialIds, note: reviewNote },
      }), 'Marking reviewed');
      // The server's sentence distinguishes "marked reviewed" from "already
      // reviewed", which differ on a re-submit and would otherwise read as a
      // partial failure.
      flash(String(j?.message
        || `${num(has(j?.reviewed) ? j.reviewed : materialIds.length)} variance record(s) marked reviewed.`));
      setReviewNote('');
      await Promise.all([loadRecord(openBatchId), loadStatus()]);
    } catch (e) { if ((e as Error).message !== 'forbidden') flash((e as Error).message); }
    finally { setReviewBusy(false); }
  };

  /* ── derived ─────────────────────────────────────────────────────────── */

  const allRows = useMemo(() => sheetRowsRaw || [], [sheetRowsRaw]);

  const visibleRows = useMemo(() => {
    const q = sheetSearch.trim().toLowerCase();
    return allRows.filter(r => {
      if (sheetOnly === 'uncounted' && r.staged) return false;
      if (sheetOnly === 'counted' && !r.staged) return false;
      if (!q) return true;
      return (r.name || '').toLowerCase().includes(q)
        || (r.sku || '').toLowerCase().includes(q)
        || (r.category || '').toLowerCase().includes(q);
    });
  }, [allRows, sheetSearch, sheetOnly]);

  /** Uncounted rows FROM THE LOADED SHEET. Deliberately kept apart from the
   *  server's own figures: the sheet hides dormant masters unless the toggle is
   *  on, so this list can be shorter, and the panel says so rather than quietly
   *  disagreeing with the number beside it. */
  const uncounted = useMemo(() => allRows.filter(r => !r.staged), [allRows]);
  const stagedCount = useMemo(() => allRows.filter(r => r.staged).length, [allRows]);
  const typedCount = useMemo(
    () => Object.values(entry).filter(v => String(v ?? '').trim() !== '').length,
    [entry],
  );

  /** The authoritative uncounted figure: the server counts every central
   *  material, including the dormant ones this sheet hides. */
  const remaining = has(status.draft_remaining) ? status.draft_remaining
    : has(preview?.summary?.uncounted_materials) ? preview!.summary.uncounted_materials!
    : uncounted.length;

  const reviewRows = useMemo(() => {
    if (!preview) return [];
    const q = reviewSearch.trim().toLowerCase();
    // A blind viewer gets variance_recipe: null, so "varies" is unknowable and
    // every line reads as a match. The variance/match filters are hidden for
    // them rather than silently lying.
    const varies = (l: PreviewLine) => has(l.variance_recipe) && Math.abs(l.variance_recipe) > 1e-6;
    return preview.lines
      .filter(l => {
        if (reviewFilter === 'variance' && !varies(l)) return false;
        if (reviewFilter === 'match' && varies(l)) return false;
        if (reviewFilter === 'blocked' && !l.blocked) return false;
        if (reviewFilter === 'zero' && Math.abs(Number(l.counted_qty_recipe) || 0) > 1e-6) return false;
        if (!q) return true;
        return (l.name || '').toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => {
        // Blocked lines first — they are the only thing standing between the
        // operator and a commit, so burying them under 600 variance rows would
        // make the blocker list unactionable.
        if (!!a.blocked !== !!b.blocked) return a.blocked ? -1 : 1;
        return Math.abs(Number(b.variance_value) || 0) - Math.abs(Number(a.variance_value) || 0);
      });
  }, [preview, reviewFilter, reviewSearch]);

  const recordRows = useMemo(() => {
    if (!record) return [];
    return record.lines
      .filter(l => {
        if (recordFilter === 'alerts') return !!Number(l.alert);
        if (recordFilter === 'unreviewed') return !!Number(l.alert) && !String(l.reviewed_at || '').trim();
        return true;
      })
      .slice()
      .sort((a, b) => Math.abs(Number(b.variance_value) || 0) - Math.abs(Number(a.variance_value) || 0));
  }, [record, recordFilter]);

  const unreviewedIds = useMemo(
    () => (record ? record.lines.filter(l => Number(l.alert) && !String(l.reviewed_at || '').trim()).map(l => l.material_id) : []),
    [record],
  );

  useEffect(() => { setSheetLimit(PAGE_STEP); }, [sheetSearch, sheetOnly, includeInert]);
  useEffect(() => { setReviewLimit(PAGE_STEP); }, [reviewFilter, reviewSearch]);
  useEffect(() => { setRecordLimit(PAGE_STEP); }, [recordFilter, openBatchId]);
  /* The review list opens on "Only differences" — biggest rupee impact first is
     what makes 600 lines usable. A BLIND viewer has no variance figure, so that
     filter would hand them an empty list reading as "nothing differs"; they open
     on All instead. Applied ONCE, after the first load, so a later Refresh never
     yanks the filter out from under someone mid-review. */
  const [filterInit, setFilterInit] = useState(false);
  useEffect(() => {
    if (loading || filterInit) return;
    setReviewFilter(blind ? 'all' : 'variance');
    setFilterInit(true);
  }, [loading, blind, filterInit]);

  /* ── gates ───────────────────────────────────────────────────────────── */

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Admins only</h1>
          <p className="text-sm text-[#8B7355]">
            A cutover overwrites the stock figure of every counted material at once and cannot be
            undone, so only admins can open it.
          </p>
        </div>
      </div>
    );
  }

  const stamped = !!(status.cutover_date && status.cutover_date.trim());
  /** The preview answers this per viewer; the status payload is the fallback for
   *  a payload that predates the field. Both mean "may press Commit". */
  const viewerCanCommit = preview?.viewer_can_commit ?? status.can_commit;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-6 space-y-5">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <ShieldAlert className="w-7 h-7" /> Central Store Cutover
            </h1>
            <p className="text-[#8B7355] text-sm mt-1 max-w-3xl">
              Count the central store once, record it as the opening figure, and every variance
              report from that date measures real loss instead of months of missing paperwork.
            </p>
          </div>
          <button onClick={loadStatus} disabled={loading}
                  className="self-start inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {/* ── THE STAMP. The single most useful fact on this page, and the only
             answer anywhere in the app to "are the variance reports meaningful
             yet?". Rendered first, before anything else, in both states. ── */}
        <div className={`rounded-xl border p-4 ${stamped ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex gap-3">
            {stamped
              ? <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
              : <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              {stamped ? (
                <>
                  <div className="font-semibold text-[15px] text-emerald-900">
                    The central store was cut over on {status.cutover_date}.
                  </div>
                  <p className="text-[12px] text-emerald-900/85 mt-1 leading-relaxed">
                    Stock figures start from a physical count taken that day, so a central variance
                    dated on or after {status.cutover_date} is a real difference and worth chasing.
                    Anything measured before it still includes accumulated paperwork drift.
                    {/* THE BOUNDARY IS A BUSINESS DATE; THE COMMIT IS A CLOCK READING.
                        These are two different facts and only one of them is a time.
                        cutover_at is the count date at midnight, so running it through
                        istWhen() printed "05:30 AM IST" — an instant at which nothing
                        whatsoever happened. The applied-at sentence therefore reads
                        cutover_committed_at, and disappears entirely when that key is
                        absent (a settings row stamped by hand), rather than formatting
                        a null into a confident wrong time. */}
                    {status.cutover_committed_at
                      ? <> Applied {istWhen(status.cutover_committed_at)} IST.</>
                      : null} This date is written once and can never be moved.
                  </p>
                </>
              ) : (
                <>
                  <div className="font-semibold text-[15px] text-amber-900">
                    No cutover has ever run. The central store has no opening count.
                  </div>
                  <p className="text-[12px] text-amber-900/85 mt-1 leading-relaxed">
                    Stock on hand is a running balance — opening, plus everything that was typed in,
                    minus everything recorded going out. Purchases that never got entered (a
                    cash-market run, a crate left at the kitchen door) are missing from it, so the
                    book has drifted from the shelf. Until a cutover runs, every central variance
                    figure in this app is measuring that drift and not a loss, and nobody can tell a
                    real 2 kg shortage from six months of missing paperwork.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{err}</span>
          </div>
        )}

        {/* Blind viewers: say the figures are withheld rather than showing
            dashes with no explanation. Unreachable while the page catalog keeps
            this route adminOnly — kept because the API is deliberately wider. */}
        {!loading && blind && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] flex gap-2">
            <Info className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
            <span>
              Book stock, differences and rupee values are hidden for you — a cutover count is
              <b> blind</b>, so that the shelf is counted rather than the system confirmed. Only an
              admin sees those figures, and only an admin can commit a cutover.
            </span>
          </div>
        )}

        {/* ── Tabs ───────────────────────────────────────────────────── */}
        <div className="flex gap-2">
          {([['run', 'Run a cutover'], ['history', 'Past cutovers & variance records']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k as Tab)}
                    className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      tab === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {label}
              {k === 'history' && has(status.unreviewed_alert_lines) && status.unreviewed_alert_lines > 0 && (
                <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[11px] font-bold ${tab === k ? 'bg-white/25' : 'bg-amber-100 text-amber-800'}`}>
                  {status.unreviewed_alert_lines}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-[#8B7355] text-sm py-10 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {/* ══════════════════════ RUN ══════════════════════ */}
        {!loading && tab === 'run' && (
          <>
            {/* ── What a cutover does and does not do. The bulleted consequences
                 come from the API (`notices`) and are rendered VERBATIM, so this
                 page cannot drift from what the commit actually promises. The two
                 sentences above them are the page's own framing of the mechanic
                 and are not in that list. Open before the first cutover; still
                 available after, because the second one has the same
                 consequences. ── */}
            <details open={!stamped} className="bg-white border border-[#E8D5C4] rounded-xl">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                <Info className="w-4 h-4 text-[#af4408]" /> Before you count — what a cutover does, and what it does not
              </summary>
              <div className="px-4 pb-4 text-[12px] text-[#6B5744] leading-relaxed space-y-2 border-t border-[#F0E4D6] pt-3">
                <p>
                  <b>It SETS stock, it does not add to it.</b> Each counted material&apos;s central
                  stock becomes exactly what you counted.
                </p>
                <p>
                  <b>Materials you do not count are left completely alone.</b> A cutover never zeroes
                  an uncounted shelf, and a blank cell is never read as a count of zero. Write 0 only
                  when you looked and the shelf was empty.
                </p>
                {status.notices.length > 0 ? (
                  <ul className="list-disc pl-5 space-y-1.5 pt-1">
                    {status.notices.map(n => <li key={n.id}>{n.text}</li>)}
                  </ul>
                ) : (
                  <p className="text-[#8B7355] italic">
                    The server did not send the consequence list with this payload, so it is not shown
                    rather than guessed at. Refresh before committing.
                  </p>
                )}
              </div>
            </details>

            {/* THE LIQUOR CARVE-OUT, ALWAYS VISIBLE — not folded into the
                collapsible list above. It decides what the counters walk with,
                and a silent omission would read as a bug. Rendered verbatim from
                the API's own notice so this page and the sheet's CSV banner say
                the same thing; the rule is CATEGORY-based, so a mis-filed bottle
                stays on this sheet and the text says so. */}
            {status.notices.filter(n => n.id === 'liquor').map(n => (
              <div key={n.id} className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] flex gap-2">
                <Wine className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
                <span>{n.text}</span>
              </div>
            ))}

            {/* ── 1 PREPARE ─────────────────────────────────────────── */}
            {!draft ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
                <h2 className="text-[15px] font-semibold flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-[#af4408]" /> Step 1 — Start a cutover
                </h2>
                <p className="text-[12px] text-[#8B7355] mt-1">
                  Opening a draft changes nothing. You can download the sheet, enter counts, review
                  them and abandon the whole thing without touching a single stock figure.
                </p>
                <p className="text-[12px] text-[#6B5744] mt-2">
                  The walk is <b>{num(sheetSummary.with_activity ?? allRows.length)} active material(s)</b>
                  {has(sheetSummary.inert) && sheetSummary.inert > 0 && (
                    <> (plus {num(sheetSummary.inert)} dormant ones, hidden by default)</>
                  )}
                  {has(sheetSummary.book_value) && <> carrying {inr(sheetSummary.book_value)} of book value</>}
                  {has(sheetSummary.store_excluded) && (
                    <>, out of {num(sheetSummary.total_materials)} materials in total —{' '}
                      {num(sheetSummary.store_excluded)} are counted on the liquor store ledger instead</>
                  )}.
                </p>
                {sheetErr && (
                  <p className="text-[12px] text-red-700 mt-2 flex items-start gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {sheetErr}
                  </p>
                )}
                <div className="mt-3 flex flex-col sm:flex-row sm:items-end gap-3">
                  <label className="text-[12px] text-[#6B5744]">
                    <span className="block mb-1 font-medium">Date the shelf was counted</span>
                    <input type="date" value={newDate} max={today}
                           min={status.cutover_date || undefined}
                           onChange={e => setNewDate(e.target.value)}
                           className="px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                  </label>
                  <label className="text-[12px] text-[#6B5744] flex-1">
                    <span className="block mb-1 font-medium">Note (who counted, which areas — optional)</span>
                    <input value={newNote} onChange={e => setNewNote(e.target.value)}
                           placeholder="e.g. Full store count, Ramesh + store team, dry store and cold room"
                           className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                  </label>
                  <button onClick={startBatch} disabled={starting || !newDate || !status.can_stage}
                          title={status.can_stage ? undefined : 'Only an admin, store manager or management can open a cutover draft'}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />} Start cutover draft
                  </button>
                </div>
                {stamped && (
                  <p className="text-[11px] text-[#8B7355] mt-2">
                    A cutover already ran on {status.cutover_date}. A new one re-bases stock again but
                    does <b>not</b> move that date — the boundary the reports use is written once.
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Draft header */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold flex items-center flex-wrap gap-2">
                      Draft cutover — counted {draft.cutover_date}
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-900">
                        Nothing applied yet
                      </span>
                    </div>
                    <div className="text-[12px] text-[#8B7355] mt-0.5">
                      Opened by {draft.created_by || '—'} · {istWhen(draft.created_at)}
                      {draft.note && <> · <span className="italic">{draft.note}</span></>}
                    </div>
                  </div>
                  <button onClick={cancelDraft} disabled={!status.can_stage}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50">
                    <X className="w-4 h-4" /> Abandon draft
                  </button>
                </div>

                {/* ── 2 ENTER ──────────────────────────────────────── */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-[15px] font-semibold flex items-center gap-2">
                      <ArrowDownToLine className="w-4 h-4 text-[#af4408]" /> Step 2 — Enter the counts
                    </h2>
                    <div className="text-[12px] text-[#8B7355]">
                      {num(status.draft_staged_lines || stagedCount)} counted ·{' '}
                      <b className="text-[#af4408]">{num(remaining)} still uncounted</b>
                    </div>
                  </div>
                  <p className="text-[12px] text-[#8B7355]">
                    Counts are typed in <b>purchase units</b> — kg, L, BTL — the way the shelf is
                    counted. Leave a row blank if it was not counted: a blank is never read as zero,
                    and an uncounted material keeps the stock it already has.
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <button onClick={downloadCountSheet} disabled={downloading}
                            className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                      {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpFromLine className="w-4 h-4" />}
                      Download blind count sheet
                    </button>
                    <button onClick={downloadUncounted} disabled={uncounted.length === 0}
                            className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                      <ArrowUpFromLine className="w-4 h-4" /> Download only the uncounted ({num(uncounted.length)})
                    </button>
                    <label className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${
                      uploading || !status.can_stage
                        ? 'bg-[#E8D5C4] text-[#8B7355] cursor-not-allowed'
                        : 'bg-[#af4408] text-white hover:bg-[#8a3506] cursor-pointer'}`}>
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      Upload filled sheet
                      <input type="file" accept=".csv,text/csv" className="sr-only"
                             disabled={uploading || !status.can_stage}
                             aria-label="Upload the filled cutover count sheet"
                             onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadCsv(f); }} />
                    </label>
                  </div>
                  <p className="text-[11px] text-[#8B7355]">
                    The walking sheet carries <b>no book quantity</b>, deliberately — a counter who can
                    see the expected number stops counting and starts confirming, and on a cutover that
                    would bake the drift in for good.
                  </p>

                  {/* What the last upload / save actually did. */}
                  {stageResult && (
                    <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                      <div className="bg-[#FFF8F0] px-3 py-2 text-[12px] font-medium text-[#2D1B0E] flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>Read from {stageResult.source}:</span>
                        <span className="text-emerald-700">{num(stageResult.accepted)} new</span>
                        <span className="text-[#6B5744]">{num(stageResult.updated)} updated</span>
                        {stageResult.skipped_blank > 0 && (
                          <span className="text-[#8B7355]">{num(stageResult.skipped_blank)} left blank (not sent)</span>
                        )}
                        {stageResult.rejected.length > 0 && (
                          <span className="text-red-700">{num(stageResult.rejected.length)} rejected</span>
                        )}
                        {stageResult.store_blocked.length > 0 && (
                          <span className="text-amber-800">{num(stageResult.store_blocked.length)} liquor rows skipped</span>
                        )}
                      </div>
                      {stageResult.skipped_blank > 0 && (
                        <div className="px-3 py-2 text-[11px] text-[#6B5744] border-t border-[#F0E4D6]">
                          The {num(stageResult.skipped_blank)} blank row(s) were <b>not</b> staged — a blank cell is
                          not a count of zero. Those materials are still uncounted and will keep their current stock.
                        </div>
                      )}
                      {/* The importer's own warnings — duplicate counts on one
                          shelf, columns it ignored, a file longer than the whole
                          store. Written as operator sentences; rendered verbatim. */}
                      {stageResult.warnings.length > 0 && (
                        <ul className="px-3 py-2 text-[11px] text-amber-900 bg-amber-50 border-t border-[#F0E4D6] list-disc pl-7 space-y-0.5">
                          {stageResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                      )}
                      {stageResult.rejected.length > 0 && (
                        <div className="max-h-56 overflow-y-auto border-t border-[#F0E4D6]">
                          <table className="w-full text-[11px]">
                            <tbody>
                              {stageResult.rejected.map((r, i) => (
                                <tr key={`${r.material_id}-${r.row}-${i}`} className="border-b border-[#F7EFE6] last:border-0">
                                  <td className="px-3 py-1.5 text-[#8B7355] whitespace-nowrap">Row {r.row}</td>
                                  <td className="px-3 py-1.5 font-medium">{r.name || r.material_id || '—'}</td>
                                  <td className="px-3 py-1.5">
                                    <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                                      {String(r.reason).replace(/_/g, ' ')}
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5 text-[#6B5744]">{r.detail}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {stageResult.store_blocked.length > 0 && (
                        <div className="max-h-40 overflow-y-auto border-t border-[#F0E4D6]">
                          {stageResult.store_blocked.map((b, i) => (
                            <div key={`${b.material_id}-${i}`} className="px-3 py-1.5 text-[11px] border-b border-[#F7EFE6] last:border-0">
                              <b>{b.name || b.material_id}</b> — {b.error}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {sheetErr && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-[12px] text-red-700 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{sheetErr}</span>
                    </div>
                  )}

                  {/* Sheet + inline entry */}
                  {sheetRowsRaw && (
                    <>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <div className="relative flex-1 min-w-[180px]">
                          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#B0987F]" />
                          <input value={sheetSearch} onChange={e => setSheetSearch(e.target.value)}
                                 placeholder="Find a material, SKU or category…"
                                 className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                        </div>
                        {(['all', 'uncounted', 'counted'] as const).map(k => (
                          <button key={k} onClick={() => setSheetOnly(k)}
                                  className={`px-2.5 py-2 rounded-lg text-[12px] border ${
                                    sheetOnly === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                            {k === 'all' ? 'All' : k === 'uncounted' ? 'Uncounted' : 'Counted'}
                          </button>
                        ))}
                        <label className="inline-flex items-center gap-1.5 text-[12px] text-[#6B5744] px-2">
                          <input type="checkbox" checked={includeInert} onChange={e => setIncludeInert(e.target.checked)} />
                          Show dormant items{has(sheetSummary.inert) ? ` (${num(sheetSummary.inert)})` : ''}
                        </label>
                      </div>
                      {includeInert && (
                        <p className="text-[11px] text-[#8B7355]">
                          Dormant = no purchase, no requisition, no movement and no stock, ever. They are
                          hidden by default because typing a figure into an obsolete duplicate gives it a
                          balance for the first time.
                        </p>
                      )}
                      {sheetTruncated && (
                        <p className="text-[11px] text-amber-800">
                          The server truncated this list. Narrow it with the search box, or work from the
                          downloaded sheet — do not treat what is on screen as the whole store.
                        </p>
                      )}

                      <div className="overflow-x-auto border border-[#E8D5C4] rounded-lg">
                        <table className="w-full text-[12px] min-w-[720px]">
                          <thead className="bg-[#FFF8F0] text-[#8B7355]">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium">Material</th>
                              <th className="text-right px-3 py-2 font-medium">Book stock</th>
                              <th className="text-right px-3 py-2 font-medium">Counted</th>
                              <th className="text-left px-3 py-2 font-medium">Unit</th>
                              <th className="text-right px-3 py-2 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.slice(0, sheetLimit).map(r => {
                              const pu = puOf(r);
                              const hint = recipeHint(r, r.book_qty);
                              const units = unitsOf(r);
                              const stagedText = has(r.staged_qty) ? String(r.staged_qty) : '';
                              return (
                                <tr key={r.material_id} className="border-t border-[#F0E4D6]">
                                  <td className="px-3 py-1.5">
                                    <div className="font-medium text-[#2D1B0E]">{r.name}</div>
                                    <div className="text-[10px] text-[#B0987F]">
                                      {r.sku ? `#${r.sku} · ` : ''}{r.category || 'uncategorised'}
                                      {r.has_activity === false && ' · dormant'}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                    {inPU(r, r.book_qty, r.book_qty_purchase)} <span className="text-[#8B7355]">{pu}</span>
                                    {hint && <div className="text-[10px] text-[#B0987F]">{hint}</div>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    <input
                                      inputMode="decimal"
                                      disabled={!status.can_stage}
                                      value={entry[r.material_id] ?? stagedText}
                                      onChange={e => setEntry(p => ({ ...p, [r.material_id]: e.target.value }))}
                                      placeholder="—"
                                      className={`w-24 px-2 py-1 text-right border rounded-md bg-white focus:outline-none focus:border-[#af4408] disabled:bg-[#FFF8F0] ${
                                        r.staged ? 'border-emerald-300' : 'border-[#E8D5C4]'}`} />
                                  </td>
                                  <td className="px-3 py-1.5">
                                    {units.length > 1 ? (
                                      <select
                                        disabled={!status.can_stage}
                                        value={countUnitOf(r, entryUnit[r.material_id])}
                                        onChange={e => setEntryUnit(p => ({ ...p, [r.material_id]: e.target.value }))}
                                        className="px-1.5 py-1 border border-[#E8D5C4] rounded-md bg-white text-[11px]">
                                        {units.map(u => <option key={u} value={u}>{u}</option>)}
                                      </select>
                                    ) : (
                                      // One basis only — countUnitOf can return
                                      // nothing else here, and going through it
                                      // keeps ONE definition of the sent unit.
                                      <span className="text-[#8B7355]">{countUnitOf(r, entryUnit[r.material_id])}</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                    {r.staged ? (
                                      <span className="inline-flex items-center gap-1">
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-800">counted</span>
                                        <button onClick={() => unstage(r.material_id)} disabled={!status.can_stage}
                                                title="Remove this count — the material goes back to uncounted and its stock is left alone"
                                                className="text-[#B0987F] hover:text-red-600 disabled:opacity-40">
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-[#B0987F]">not counted</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                            {visibleRows.length === 0 && (
                              <tr><td colSpan={5} className="px-3 py-6 text-center text-[#8B7355]">No materials match that filter.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {visibleRows.length > sheetLimit && (
                        <button onClick={() => setSheetLimit(n => n + PAGE_STEP)}
                                className="w-full py-2 border border-[#E8D5C4] rounded-lg text-[12px] text-[#6B5744] hover:bg-[#FFF1E3]">
                          Showing {num(sheetLimit)} of {num(visibleRows.length)} — show {PAGE_STEP} more
                        </button>
                      )}

                      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                        {typedCount > 0 && (
                          <span className="text-[12px] text-[#8B7355]">{num(typedCount)} count(s) typed and not yet saved</span>
                        )}
                        <button onClick={saveTypedCounts} disabled={savingCounts || typedCount === 0 || !status.can_stage}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50">
                          {savingCounts ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownToLine className="w-4 h-4" />}
                          Save typed counts
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* ── THE UNCOUNTED PANEL — the most important thing on this
                     screen before a commit. An uncounted material is not a
                     problem in itself (its stock is left alone); a counter who
                     believes the sheet is finished when 300 rows are still empty
                     IS the problem. ── */}
                <div className={`rounded-xl border p-4 ${remaining === 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex gap-3">
                    {remaining === 0
                      ? <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
                      : <PackageX className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />}
                    <div className="min-w-0 w-full">
                      {remaining === 0 ? (
                        <div className="font-semibold text-[14px] text-emerald-900">
                          Every central material has a count.
                        </div>
                      ) : (
                        <>
                          <div className="font-semibold text-[14px] text-amber-900">
                            {num(remaining)} central material(s) have no count.
                          </div>
                          <p className="text-[12px] text-amber-900/85 mt-0.5 leading-relaxed">
                            Their stock will be left exactly as it is — a cutover never zeroes what
                            nobody counted. That is safe, but it also means those figures keep
                            whatever drift they already carry, and a variance report will go on
                            measuring paperwork for them.
                            {remaining !== uncounted.length && (
                              <> This list shows the <b>{num(uncounted.length)}</b> on the current sheet;
                                the rest are dormant masters hidden from it — switch on “Show dormant
                                items” to list them.</>
                            )}
                          </p>
                          <div className="mt-2 max-h-40 overflow-y-auto bg-white/60 border border-amber-200 rounded-lg">
                            <ul className="text-[11px] divide-y divide-amber-100">
                              {uncounted.slice(0, 400).map(r => (
                                <li key={r.material_id} className="px-2.5 py-1 flex justify-between gap-3">
                                  <span className="truncate">{r.name}</span>
                                  <span className="text-amber-900/70 whitespace-nowrap">
                                    book {inPU(r, r.book_qty, r.book_qty_purchase)} {puOf(r)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {uncounted.length > 400 && (
                              <div className="px-2.5 py-1 text-[11px] text-amber-900/70">
                                +{num(uncounted.length - 400)} more — download the uncounted list above.
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── 3 REVIEW ─────────────────────────────────────── */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
                  <h2 className="text-[15px] font-semibold flex items-center gap-2">
                    <Boxes className="w-4 h-4 text-[#af4408]" /> Step 3 — Review every line
                  </h2>

                  {previewErr && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-[12px] text-red-700 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{previewErr}</span>
                    </div>
                  )}

                  {!preview || preview.lines.length === 0 ? (
                    <p className="text-[12px] text-[#8B7355] py-4 text-center">
                      No counts entered yet. Nothing to review, and nothing to commit.
                    </p>
                  ) : (
                    <>
                      {/* Summary tiles */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Counted</div>
                          <div className="font-semibold">{num(preview.summary.counted_lines ?? preview.lines.length)}</div>
                        </div>
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">With a variance</div>
                          <div className="font-semibold text-[#af4408]">{numOrDash(preview.summary.variance_lines)}</div>
                        </div>
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Left untouched</div>
                          <div className="font-semibold">{num(preview.summary.uncounted_materials ?? remaining)}</div>
                        </div>
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Net correction</div>
                          <div className="font-semibold">
                            {has(preview.summary.net_variance_value) ? inrSigned(preview.summary.net_variance_value) : '—'}
                          </div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">information only</div>
                        </div>
                      </div>
                      <p className="text-[11px] text-[#8B7355]">
                        Shortage {inrOrDash(preview.summary.shortage_value)} · Excess {inrOrDash(preview.summary.excess_value)} ·
                        Counted as empty {num(preview.summary.zero_counts)}
                        {has(preview.summary.no_rate_lines) && preview.summary.no_rate_lines > 0 && (
                          <> · {num(preview.summary.no_rate_lines)} line(s) have no rate, so their rupee value reads 0</>
                        )}
                      </p>

                      {/* Filters */}
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative flex-1 min-w-[180px]">
                          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#B0987F]" />
                          <input value={reviewSearch} onChange={e => setReviewSearch(e.target.value)}
                                 placeholder="Find a material…"
                                 className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                        </div>
                        {([
                          ['variance', 'Only differences'],
                          ['all', 'All counted'],
                          ['match', 'Matches the book'],
                          ['zero', 'Counted as empty'],
                          ['blocked', 'Blocked'],
                        ] as const)
                          // A blind viewer has no variance figure, so a filter
                          // keyed on it would silently answer "nothing differs".
                          .filter(([k]) => !blind || (k !== 'variance' && k !== 'match'))
                          .map(([k, label]) => (
                            <button key={k} onClick={() => setReviewFilter(k as ReviewFilter)}
                                    className={`px-2.5 py-2 rounded-lg text-[12px] border ${
                                      reviewFilter === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                              {label}
                            </button>
                          ))}
                      </div>

                      <div className="overflow-x-auto border border-[#E8D5C4] rounded-lg">
                        <table className="w-full text-[12px] min-w-[760px]">
                          <thead className="bg-[#FFF8F0] text-[#8B7355]">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium">Material</th>
                              <th className="text-right px-3 py-2 font-medium">Book</th>
                              <th className="text-right px-3 py-2 font-medium">Counted</th>
                              <th className="text-right px-3 py-2 font-medium">Difference</th>
                              <th className="text-right px-3 py-2 font-medium">Value (info)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewRows.slice(0, reviewLimit).map(l => {
                              const pu = puOf(l);
                              const known = has(l.variance_recipe);
                              const diff = known ? l.variance_recipe! : 0;
                              const varies = known && Math.abs(diff) > 1e-6;
                              return (
                                <tr key={l.material_id} className={`border-t border-[#F0E4D6] ${l.blocked ? 'bg-red-50/60' : ''}`}>
                                  <td className="px-3 py-1.5">
                                    <div className="font-medium text-[#2D1B0E]">{l.name}</div>
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                      {l.blocked && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-red-100 border-red-200 text-red-800">
                                          blocked — {(l.moved_since_stage || 0) > 0
                                            ? `${num(l.moved_since_stage)} movement(s) recorded since the count`
                                            : l.stock_changed ? 'stock changed since the count'
                                            : l.pack_factor_changed ? 'pack size changed since the count'
                                            : l.now_store_mapped ? 'now a liquor-store item'
                                            : 'recount this one'}
                                        </span>
                                      )}
                                      {/* A BACKDATED fence cannot be cleared by
                                          re-staging — the window runs from the
                                          count date, not from when the line was
                                          typed. Saying "re-count this one" and
                                          nothing else sends the operator round a
                                          loop that cannot terminate. */}
                                      {l.blocked && l.backdated && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-red-50 border-red-200 text-red-800"
                                              title={l.counted_as_of ? `Movement measured from ${l.counted_as_of} (UTC)` : undefined}>
                                          re-staging will NOT clear this — remove the line, or start a draft dated today
                                        </span>
                                      )}
                                      {l.record_edited && !l.blocked && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]">
                                          item record edited since the count (not blocking)
                                        </span>
                                      )}
                                      {known && !varies && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-800">matches</span>
                                      )}
                                      {varies && l.will_alert !== false && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-900">
                                          raises a variance record
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                    {inPU(l, l.book_qty_recipe, l.book_qty_purchase)} <span className="text-[#8B7355]">{pu}</span>
                                  </td>
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                    {inPU(l, l.counted_qty_recipe, l.counted_qty_purchase)} <span className="text-[#8B7355]">{pu}</span>
                                    {recipeHint(l, l.counted_qty_recipe) && (
                                      <div className="text-[10px] text-[#B0987F]">{recipeHint(l, l.counted_qty_recipe)}</div>
                                    )}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right whitespace-nowrap font-medium ${
                                    !varies ? 'text-[#8B7355]' : diff < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                    {!known ? '—' : (
                                      <>
                                        {diff > 0 ? '+' : diff < 0 ? '−' : ''}
                                        {inPU(l, Math.abs(diff), has(l.variance_purchase) ? Math.abs(l.variance_purchase) : undefined)}{' '}
                                        <span className="text-[#8B7355] font-normal">{pu}</span>
                                      </>
                                    )}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right whitespace-nowrap ${
                                    !varies ? 'text-[#8B7355]' : (Number(l.variance_value) || 0) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                    {!known ? '—' : varies ? inrSigned(l.variance_value) : '—'}
                                    {varies && l.rate_source && (
                                      <div className="text-[9px] text-[#B8A590]">{l.rate_source}</div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                            {reviewRows.length === 0 && (
                              <tr><td colSpan={5} className="px-3 py-6 text-center text-[#8B7355]">
                                {reviewFilter === 'variance'
                                  ? 'Every counted material matches the book exactly.'
                                  : 'Nothing matches that filter.'}
                              </td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      {reviewRows.length > reviewLimit && (
                        <button onClick={() => setReviewLimit(n => n + PAGE_STEP)}
                                className="w-full py-2 border border-[#E8D5C4] rounded-lg text-[12px] text-[#6B5744] hover:bg-[#FFF1E3]">
                          Showing {num(reviewLimit)} of {num(reviewRows.length)} — show {PAGE_STEP} more
                        </button>
                      )}
                    </>
                  )}
                </div>

                {/* ── 4 COMMIT ─────────────────────────────────────── */}
                {preview && preview.lines.length > 0 && (
                  <div className="bg-white border-2 border-[#af4408] rounded-xl p-4 sm:p-5 space-y-3">
                    <h2 className="text-[15px] font-semibold flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-[#af4408]" /> Step 4 — Commit
                    </h2>
                    {preview.blockers.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-[12px] text-red-800">
                        <div className="font-semibold flex items-center gap-1.5 mb-1">
                          <FileWarning className="w-4 h-4" /> This cutover cannot be committed yet
                        </div>
                        {/* Verbatim from the server — written as instructions to
                            the operator, not as error codes. */}
                        <ul className="list-disc pl-5 space-y-0.5">
                          {preview.blockers.map((b, i) => <li key={i}>{b}</li>)}
                        </ul>
                      </div>
                    )}
                    <p className="text-[12px] text-[#6B5744]">
                      Committing overwrites the central stock of{' '}
                      <b>{num(preview.summary.counted_lines ?? preview.lines.length)}</b> material(s) and leaves{' '}
                      <b>{num(preview.summary.uncounted_materials ?? remaining)}</b> untouched. It cannot be undone.
                    </p>
                    {!viewerCanCommit && (
                      <p className="text-[12px] text-[#8B7355]">
                        Only an admin can commit a cutover. The counts stay staged until one does — nothing
                        you have entered is lost.
                      </p>
                    )}
                    <button onClick={() => { setConfirmWord(''); setConfirmOpen(true); }}
                            disabled={!preview.can_commit || !viewerCanCommit}
                            title={preview.can_commit ? undefined : 'Clear the blockers listed above first'}
                            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                      {preview.can_commit && viewerCanCommit ? <ShieldAlert className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      {!viewerCanCommit ? 'Commit — admins only'
                        : preview.can_commit ? 'Commit the cutover…' : 'Commit blocked'}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ══════════════════════ HISTORY ══════════════════════ */}
        {!loading && tab === 'history' && (
          <div className="space-y-4">
            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="px-4 py-3 text-[15px] font-semibold flex items-center gap-2 border-b border-[#F0E4D6]">
                <History className="w-4 h-4 text-[#af4408]" /> Cutovers
              </div>
              {status.recent_batches.length === 0 ? (
                <div className="px-4 py-8 text-center text-[#8B7355] text-sm">
                  No cutover has ever been run on this system.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] min-w-[680px]">
                    <thead className="bg-[#FFF8F0] text-[#8B7355]">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Count date</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-right px-3 py-2 font-medium">Counted</th>
                        <th className="text-right px-3 py-2 font-medium">Variances</th>
                        <th className="text-right px-3 py-2 font-medium">Net (info)</th>
                        <th className="text-left px-3 py-2 font-medium">Committed</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {status.recent_batches.map(b => (
                        <tr key={b.id} className={`border-t border-[#F0E4D6] ${openBatchId === b.id ? 'bg-[#FFF1E3]' : ''}`}>
                          <td className="px-3 py-2 font-medium">
                            {b.cutover_date}
                            {!!b.stamped && (
                              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-800">
                                set the cutover date
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${
                              b.status === 'committed' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                : b.status === 'draft' ? 'bg-amber-50 border-amber-200 text-amber-900'
                                : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#8B7355]'}`}>
                              {b.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">{num(b.counted_lines)}</td>
                          <td className="px-3 py-2 text-right">{numOrDash(b.variance_lines)}</td>
                          <td className="px-3 py-2 text-right">
                            {has(b.net_variance_value) ? inrSigned(b.net_variance_value) : '—'}
                          </td>
                          <td className="px-3 py-2 text-[#8B7355]">
                            {b.status === 'committed' ? <>{b.committed_by || '—'} · {istWhen(b.committed_at)}</> : '—'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => setOpenBatchId(openBatchId === b.id ? null : b.id)}
                                    className="px-2.5 py-1 border border-[#E8D5C4] rounded-md text-[11px] text-[#6B5744] hover:bg-[#FFF1E3]">
                              {openBatchId === b.id ? 'Hide' : 'Open record'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── THE PERMANENT RECORD + "an alert for every single variance".
                 One durable row per varying material, nothing aggregated away. ── */}
            {openBatchId && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
                {recordErr && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-[12px] text-red-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{recordErr}</span>
                  </div>
                )}
                {!record ? (
                  !recordErr && (
                    <div className="flex items-center gap-2 text-[#8B7355] text-sm py-6 justify-center">
                      <Loader2 className="w-5 h-5 animate-spin" /> Loading the record…
                    </div>
                  )
                ) : (
                  <>
                    <div>
                      <h2 className="text-[15px] font-semibold">
                        Cutover of {record.batch.cutover_date} — permanent record
                      </h2>
                      <p className="text-[12px] text-[#8B7355] mt-0.5">
                        {record.batch.status === 'committed'
                          ? <>Committed by {record.batch.committed_by || '—'} on {istWhen(record.batch.committed_at)} IST.{' '}
                              {num(record.batch.counted_lines)} material(s) were re-based;{' '}
                              {numOrDash(record.batch.variance_lines)} differed from the book.</>
                          : <>This batch is {record.batch.status} — no stock was changed by it.</>}
                      </p>
                      {record.batch.note && <p className="text-[12px] text-[#6B5744] italic mt-0.5">{record.batch.note}</p>}
                      {record.truncated && (
                        <p className="text-[11px] text-amber-800 mt-1">
                          The server truncated this line list — it is not the whole batch. The batch totals above
                          are still complete.
                        </p>
                      )}
                    </div>

                    <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-[11px] text-[#6B5744] flex gap-2">
                      <Info className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
                      <span>
                        Every line below is a separate, permanent variance record — nothing is rolled up.
                        The rupee figures are <b>information only</b>: this correction created no purchase,
                        changed no rate and never reached consumption, P&amp;L or any variance report.
                        Marking a line reviewed records that someone looked at it; it changes no number.
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {([['alerts', 'Variances'], ['unreviewed', 'Not yet reviewed'], ['all', 'Every counted line']] as const).map(([k, label]) => (
                        <button key={k} onClick={() => setRecordFilter(k)}
                                className={`px-2.5 py-2 rounded-lg text-[12px] border ${
                                  recordFilter === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                          {label}
                        </button>
                      ))}
                      <span className="text-[12px] text-[#8B7355] ml-auto">
                        {num(recordRows.length)} line(s) shown · {num(unreviewedIds.length)} unreviewed
                      </span>
                    </div>

                    {unreviewedIds.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <input value={reviewNote} onChange={e => setReviewNote(e.target.value)}
                               placeholder="Note for the review (optional) — e.g. checked against the count sheets, all accounted for"
                               className="flex-1 min-w-[220px] px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
                        <button onClick={() => markReviewed(unreviewedIds)} disabled={reviewBusy}
                                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                          {reviewBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                          Mark all {num(unreviewedIds.length)} reviewed
                        </button>
                      </div>
                    )}

                    <div className="overflow-x-auto border border-[#E8D5C4] rounded-lg">
                      <table className="w-full text-[12px] min-w-[820px]">
                        <thead className="bg-[#FFF8F0] text-[#8B7355]">
                          <tr>
                            <th className="text-left px-3 py-2 font-medium">Material</th>
                            <th className="text-right px-3 py-2 font-medium">Book (overwritten)</th>
                            <th className="text-right px-3 py-2 font-medium">Counted</th>
                            <th className="text-right px-3 py-2 font-medium">Difference</th>
                            <th className="text-right px-3 py-2 font-medium">Value (info)</th>
                            <th className="text-left px-3 py-2 font-medium">Reviewed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recordRows.slice(0, recordLimit).map(l => {
                            const meta = { unit: l.unit || l.recipe_unit, purchase_unit: l.purchase_unit, pack_factor: l.pack_factor };
                            const pu = puOf(meta);
                            // A draft's book snapshot has not been taken yet, so
                            // its 0 means "not recorded", not "the shelf was
                            // empty" — and its difference is meaningless too.
                            const known = record.bookRecorded && has(l.variance_recipe);
                            const diff = known ? l.variance_recipe! : 0;
                            const varies = known && Math.abs(diff) > 1e-6;
                            const done = !!String(l.reviewed_at || '').trim();
                            return (
                              <tr key={l.material_id} className="border-t border-[#F0E4D6]">
                                <td className="px-3 py-1.5">
                                  <div className="font-medium text-[#2D1B0E]">{l.material_name}</div>
                                  {l.note && <div className="text-[10px] text-[#B0987F] italic">{l.note}</div>}
                                </td>
                                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                  {record.bookRecorded
                                    ? <>{inPU(meta, l.book_qty_recipe)} <span className="text-[#8B7355]">{pu}</span></>
                                    : <span className="text-[#B0987F]">not recorded</span>}
                                </td>
                                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                  {inPU(meta, l.counted_qty_recipe)} <span className="text-[#8B7355]">{pu}</span>
                                </td>
                                <td className={`px-3 py-1.5 text-right whitespace-nowrap font-medium ${
                                  !varies ? 'text-[#8B7355]' : diff < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                  {!known ? '—' : (
                                    <>
                                      {diff > 0 ? '+' : diff < 0 ? '−' : ''}{inPU(meta, Math.abs(diff))}{' '}
                                      <span className="text-[#8B7355] font-normal">{pu}</span>
                                    </>
                                  )}
                                </td>
                                <td className={`px-3 py-1.5 text-right whitespace-nowrap ${
                                  !varies ? 'text-[#8B7355]' : (Number(l.variance_value) || 0) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                  {!known ? '—' : varies ? inrSigned(l.variance_value) : '—'}
                                </td>
                                <td className="px-3 py-1.5">
                                  {!Number(l.alert) ? (
                                    <span className="text-[10px] text-[#B0987F]">{has(l.alert) ? 'no variance' : '—'}</span>
                                  ) : done ? (
                                    <span className="text-[11px] text-emerald-700">
                                      {l.reviewed_by || '—'} · {istWhen(l.reviewed_at)}
                                      {l.review_note && <span className="block text-[10px] text-[#8B7355] italic">{l.review_note}</span>}
                                    </span>
                                  ) : (
                                    <button onClick={() => markReviewed([l.material_id])} disabled={reviewBusy}
                                            className="text-[11px] px-2 py-0.5 border border-[#E8D5C4] rounded text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                                      Mark reviewed
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {recordRows.length === 0 && (
                            <tr><td colSpan={6} className="px-3 py-6 text-center text-[#8B7355]">
                              {recordFilter === 'alerts'
                                ? 'Not one counted material differed from the book in this cutover.'
                                : recordFilter === 'unreviewed'
                                  ? 'Every variance in this cutover has been reviewed.'
                                  : 'This batch has no lines.'}
                            </td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {recordRows.length > recordLimit && (
                      <button onClick={() => setRecordLimit(n => n + PAGE_STEP)}
                              className="w-full py-2 border border-[#E8D5C4] rounded-lg text-[12px] text-[#6B5744] hover:bg-[#FFF1E3]">
                        Showing {num(recordLimit)} of {num(recordRows.length)} — show {PAGE_STEP} more
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════ CONFIRM ══════════════════════ */}
      {confirmOpen && preview && draft && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-end sm:items-center justify-center p-0 sm:p-4"
             role="dialog" aria-modal="true" aria-labelledby="cutover-confirm-title">
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
            <div className="px-5 py-4 border-b border-[#F0E4D6] flex items-start justify-between gap-3">
              <h3 id="cutover-confirm-title" className="text-[16px] font-bold text-[#af4408] flex items-center gap-2">
                <ShieldAlert className="w-5 h-5" /> Commit the cutover — this cannot be undone
              </h3>
              <button onClick={() => setConfirmOpen(false)} className="text-[#B0987F] hover:text-[#2D1B0E]" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-3 text-[13px] text-[#2D1B0E] leading-relaxed">
              <p>
                The central stock figure of{' '}
                <b>{num(preview.summary.counted_lines ?? preview.lines.length)} material(s)</b> will be
                <b> replaced</b> with the counts taken on <b>{draft.cutover_date}</b>. Not added to — replaced.
              </p>
              <p>
                <b>{num(preview.summary.uncounted_materials ?? remaining)} material(s)</b> have no count in
                this batch and are <b>left exactly as they are</b>. A cutover never zeroes an uncounted shelf.
              </p>
              <p>
                <b>{numOrDash(preview.summary.variance_lines)}</b> of the counted materials differ from the
                book — a net {has(preview.summary.net_variance_value) ? inrSigned(preview.summary.net_variance_value) : '—'} (
                {inrOrDash(preview.summary.shortage_value)} short, {inrOrDash(preview.summary.excess_value)} extra).
                Each one becomes its own permanent variance record on this page. Those rupee figures are{' '}
                <b>information only</b>: no purchase is created, no rate changes, and none of it reaches
                consumption, P&amp;L or any variance report. It is not a gain or a loss — it is months of
                missing paperwork written off in one stroke.
              </p>
              {(preview.summary.zero_counts || 0) > 0 && (
                <p>
                  <b>{num(preview.summary.zero_counts)}</b> material(s) were counted as <b>empty</b> and will be
                  set to zero. That is a real count of nothing on the shelf, not a blank cell.
                </p>
              )}
              <p>
                Central stock will jump with <b>no stock transaction behind it</b>, on purpose — this
                page&apos;s record is the only ledger of what changed. Stock keeps no history of its own and
                cannot be reconstructed, so if you have not taken a database backup, stop and take one now.
              </p>
              {/* Only state the liquor figure when it is actually known. A "0"
                  printed because the sheet failed to load would read as "no
                  liquor was carved out", which is the opposite of the truth. */}
              <p>
                Liquor is not affected
                {has(sheetSummary.store_excluded)
                  ? <>: {num(sheetSummary.store_excluded)} store-mapped material(s) are counted on the
                      TGBCL store ledger instead</>
                  : <> — store-mapped materials are counted on the TGBCL store ledger instead</>}.
                This re-bases the <b>single central pool, building-wide</b> — central stock is not held
                per outlet.
              </p>
              {!stamped && (
                <p className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
                  This also sets the central-store cutover date to <b>{draft.cutover_date}</b>. From that date
                  the variance reports measure real loss instead of accumulated paperwork drift. The date is
                  written <b>once</b> and can never be moved — a later cutover re-bases stock again but leaves
                  this boundary where it is.
                </p>
              )}

              <label className="block pt-1">
                <span className="block text-[12px] font-medium text-[#6B5744] mb-1">
                  Type <b>CUTOVER</b> to confirm you have read the above.
                </span>
                <input value={confirmWord} onChange={e => setConfirmWord(e.target.value)}
                       placeholder="CUTOVER" autoComplete="off" spellCheck={false}
                       className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
              </label>
            </div>

            <div className="px-5 py-4 border-t border-[#F0E4D6] flex flex-wrap justify-end gap-2">
              <button onClick={() => setConfirmOpen(false)} disabled={committing}
                      className="px-4 py-2 rounded-lg text-sm font-medium border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                Cancel — change nothing
              </button>
              <button onClick={commit}
                      disabled={committing || confirmWord.trim().toUpperCase() !== 'CUTOVER' || !preview.can_commit}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
                Overwrite {num(preview.summary.counted_lines ?? preview.lines.length)} material(s) now
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[92vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
