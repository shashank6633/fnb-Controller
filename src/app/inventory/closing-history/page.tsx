'use client';

/**
 * CLOSING STOCK HISTORY — "a detailed closing stock where I can see the PREVIOUS
 * closing stocks also, with download option." (owner, 2026-08-02)
 *
 * ── WHY A SEPARATE PAGE FROM /inventory/closing-sheet ──────────────────────
 * closing-sheet is an ENTRY surface: one date, every department, boxes you type
 * into. It already hands out a flat history CSV, but nothing on screen answers
 * the question the owner actually asks — "is this month's figure sane?" — which
 * is only ever answered by last month's figure for the SAME item. That needs a
 * MATRIX (rows = items, columns = count dates), which is the opposite shape to
 * an entry sheet and cannot be bolted onto it without giving one page two axes
 * and two verbs. So: sheet writes one date, this page reads many.
 *
 * ── THE POINT OF THE DEFAULT VIEW ──────────────────────────────────────────
 * "Compare dates" puts the newest count in the FIRST date column and the same
 * item's earlier counts to its right, with a Change column pinned next to the
 * item name so it survives horizontal scrolling. A date on which an item was
 * NOT counted renders as an em-dash on a shaded cell; a date on which it WAS
 * counted and the count was zero renders as "0 <unit>" in full-strength text.
 * Those two are different facts — "nobody looked" vs "we looked and there is
 * none" — and conflating them is the exact error this view exists to prevent.
 * There is a legend above the table saying so, because a colour difference
 * nobody has been told about is not information.
 *
 * ── UNITS: DISPLAY ONLY, NEVER RE-DERIVED HERE ─────────────────────────────
 * unit-lock: every quantity on the wire is ALREADY in PURCHASE units — the
 * history route converts closing_stock.physical_stock (stored in RECIPE units)
 * through toPurchaseQty() before it ever reaches this file, and ships the
 * matching purchase_unit string alongside. This page therefore formats and
 * prints; it must NEVER call toPurchaseQty / packFactor on these numbers again,
 * because a second division would silently show a 6 kg stock as 4 kg for every
 * material whose pack_size > 1. A SUB (sub-recipe) row has no purchase unit and
 * no pack factor at all — it is counted in its own yield unit, which the route
 * puts in the very same purchase_unit field, so it prints unchanged and no
 * conversion is implied anywhere on this page.
 *
 * ── MONEY vs QUANTITY TOTALS ───────────────────────────────────────────────
 * Rupees total, per date, in the footer. Quantities NEVER do: 2 BTL + 3 kg is
 * not a number in any basis, so every quantity subtotal prints an em-dash. The
 * "latest value" column is likewise NOT totalled — each row's latest count can
 * be on a different date, so a column sum would be a valuation of no day.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * There is no system-stock and no variance column here for ANYONE, admin
 * included. That is not an omission: /api/closing-stock/history deliberately
 * carries neither field for any caller (variance lives on /variance-approvals),
 * so this page cannot leak a blind count even to a user whose role would allow
 * it — there is nothing in the payload to leak. Nothing on this page keys off a
 * client-side role guess.
 *
 * ── FILTERS AND THE DOWNLOAD MUST AGREE ────────────────────────────────────
 * Every filter (dates, department, item search) is applied SERVER-SIDE, and the
 * CSV is the very same request with format=csv (Store vs Departments goes one
 * step further: its file is built in the browser from the sheet ON SCREEN, by
 * the same builder the route uses — see download()). There is deliberately no
 * client-side row filtering anywhere in this file: the moment the page narrows
 * rows the server did not, "Download CSV" stops being what is on screen, and a
 * download that quietly differs from the report above it is worse than no
 * download at all. The one thing the file can hold that the screen cannot is
 * the truncation warning line — and truncation is shouted about on screen too.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * The route is the authority (canSeeAllDeptStock / allowedDeptSetExpanded) and
 * answers 403 with wording this page matches on to render a lock panel rather
 * than a red crash. A department the caller may not read is a 403 — never an
 * empty table, which would read as "nobody counted anything there".
 *
 * ── STORE vs DEPARTMENTS (owner ruling 99, 2026-11-01) ─────────────────────
 * The third tab answers a different question on ONE date: "what did the store
 * count, and what did each department count, of the same item?" Rows = items,
 * columns = Store / Overall, then every department that counted that day under
 * its main department, then Total. The route builds it (view=bydept) from the
 * same rows, the same purchase-unit conversion and the same stored values as
 * the other two tabs; this file prints it. It has its own date control instead
 * of From/To and no Department filter — the departments ARE the columns. Its
 * reader is STRICT: anything short of the whole sheet (raw block, semi block,
 * every column's totals) is a failed read, shown as an error with no table,
 * because a sheet missing a half once read as a day of zero stock (31 Oct).
 */

import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  History, Loader2, AlertCircle, Download, Search, X, CalendarDays,
  IndianRupee, Layers, PackageX, ArrowUpRight, ArrowDownRight, Minus,
  ClipboardCheck, LayoutGrid, List, Building2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { fmtQtyNum } from '@/lib/pack-units';
import { todayIST, fmtISTDate } from '@/lib/format-date';
import {
  CLOSING_GST_PCT_LABEL, CLOSING_GST_PCT_SUB, CLOSING_GST_PCT_TITLE,
  CLOSING_INCL_LABEL, CLOSING_INCL_TITLE, CLOSING_TAX_LABEL, CLOSING_TAX_TITLE,
  closingTaxNotes, fmtClosingGstPct, sumClosingTax, type ClosingTaxTotals,
} from '@/lib/closing-tax';
import { bydeptCsv, bydeptCsvFilename } from '@/lib/closing-bydept-csv';

/* ── Wire types — /api/closing-stock/history ─────────────────────────────── */

/** One item's count on one date. `null` in `counts` means NOT COUNTED. */
interface CountCell {
  /** unit-lock: PURCHASE units already (SUB rows: the yield unit). */
  qty: number;
  value: number | null;
  rate: number | null;
}

interface MatrixRow {
  material_id: string | null;
  sub_recipe_id: string | null;
  type: 'RAW' | 'SUB';
  material: string;
  sku: string;
  category: string;
  department: string;
  department_id: string;
  purchase_unit: string;
  /** date → cell, or null for "no count taken on that date". */
  counts: Record<string, CountCell | null>;
  latest_qty: number | null;
  previous_qty: number | null;
  change_qty: number | null;
  change_pct: number | null;
  latest_value: number | null;
}

interface MatrixResp {
  mode: 'matrix';
  /** Count dates, NEWEST FIRST. */
  dates: string[];
  rows: MatrixRow[];
  totals_by_date: Record<string, { lines: number; value: number }>;
  truncated: boolean;
  from: string;
  to: string;
  /** Present on the flat mode today; read defensively so either mode may send it. */
  scope?: string;
  note?: string | null;
}

/** The existing flat row (kept byte-compatible with the deployed route). */
interface FlatRow {
  date: string;
  department: string;
  material: string;
  sku: string;
  category: string;
  purchase_unit: string;
  /** unit-lock: already converted server-side; NULL only on a malformed row. */
  counted_purchase: number | null;
  rate: number | null;
  rate_source: string;
  value: number | null;
  recorded_by: string;
  type: 'RAW' | 'SUB';
  /* Estimated GST (owner #4, rulings #77/#78/#81) — resolved by the route
   * (src/lib/closing-tax.ts). null = BLANK, never 0. */
  gst_pct: number | null;
  gst_note: string;
  gst_title: string;
  tax: number | null;
  total_incl_tax: number | null;
}

interface FlatResp {
  mode: 'flat';
  rows: FlatRow[];
  totals: { count: number; value: number; tax: ClosingTaxTotals };
  truncated: boolean;
  from: string;
  to: string;
  scope?: string;
  note?: string | null;
}

/* Store vs Departments — /api/closing-stock/history?view=bydept */

interface BydeptColumn {
  /** STORE_KEY for Store / Overall, otherwise the department id. */
  key: string;
  name: string;
  /** The main department this column files under (or itself). */
  group_key: string;
  group: string;
  is_store: boolean;
  is_main: boolean;
  is_active: boolean;
  /** False only for the Store column on a day the store did not count. */
  counted: boolean;
}

interface BydeptCell extends CountCell {
  /** unit-lock: the unit `qty` is ALREADY in (purchase unit; SUB = yield unit). */
  unit: string;
}

interface BydeptRow {
  key: string;
  type: 'RAW' | 'SUB';
  material: string;
  sku: string;
  category: string;
  purchase_unit: string;
  /** column key → cell, or null for "not counted there on that date". */
  cells: Record<string, BydeptCell | null>;
  total_qty: number | null;
  total_value: number | null;
  counted_in: number;
  unpriced: number;
  mixed_units: boolean;
}

interface BydeptTotal { lines: number; value: number; unpriced: number }
interface BydeptBlock { by_column: Record<string, BydeptTotal>; total: BydeptTotal & { items: number } }

interface BydeptResp {
  mode: 'bydept';
  /** The ONE count date this sheet is for. */
  date: string;
  latest_date: string | null;
  /** Dates with a count in the caller's scope, newest first. */
  count_dates: string[];
  columns: BydeptColumn[];
  rows: BydeptRow[];
  semi_rows: BydeptRow[];
  totals: { raw: BydeptBlock; semi: BydeptBlock; all: BydeptBlock };
  /** Estimated GST on the RAW block, per column and in total (ruling 107);
   *  null from a server that does not send it — then no tax lines show. */
  tax: { by_column: Record<string, ClosingTaxTotals>; total: ClosingTaxTotals } | null;
  truncated: boolean;
  scope?: string;
  note?: string | null;
  /** PAGE-SIDE, not on the wire: the item search this sheet is the answer to.
   *  The Download and the "filtered view" labels read it, so they describe
   *  the sheet ON SCREEN — never a search still being typed or fetched. */
  asked_q: string;
}

interface DeptOption { id: string; name: string; is_active: boolean; parent_name?: string }

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const EM = '—';
const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const inr2 = (v: number) => inr(v, 2);

/** The Store / Overall bucket — counts that belong to no department. Same key
 *  the API uses; a department-scoped user gets a 403 for it, by design. */
const STORE_KEY = '__store__';

const RATE_LABEL: Record<string, string> = {
  last_purchase: 'last purchase',
  average_cost: 'average cost',
  sub_recipe_cost: 'sub-recipe cost',
  not_recorded: 'not recorded at count time',
  none: 'no basis',
};

/**
 * Calendar arithmetic on an IST date-only string. Built from UTC PARTS on
 * purpose: `new Date('2026-08-01')` read back with local getters lands on 31 Jul
 * for anyone west of Greenwich, which would shift the default window by a day.
 */
const shiftDays = (isoDate: string, days: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return isoDate;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000);
  if (isNaN(d.getTime())) return isoDate;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Default window: the last 90 days inclusive (today counts as day 1). */
const defaultFrom = () => shiftDays(todayIST(), -89);

/** Content-Disposition → filename, so the saved file keeps the server's name. */
const filenameFrom = (cd: string | null, fallback: string): string => {
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : fallback;
};

/* Defensive readers — the payload is shaped by a route written in parallel, so
 * a missing key must degrade to a blank cell, never blow the whole report up. */
const rec = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : String(v));
/** Numbers that are allowed to be absent. `0` must survive; only null/''/NaN don't. */
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};
const num = (v: unknown): number => numOrNull(v) ?? 0;

const normaliseCell = (v: unknown): CountCell | null => {
  if (v == null) return null;                       // the "not counted" signal
  const o = rec(v);
  const qty = numOrNull(o.qty);
  if (qty == null) return null;                     // a cell with no qty is not a count
  return { qty, value: numOrNull(o.value), rate: numOrNull(o.rate) };
};

const normaliseMatrix = (payload: unknown, from: string, to: string): MatrixResp => {
  const j = rec(payload);
  const dates = arr(j.dates).map(str).filter(Boolean);
  const totals: MatrixResp['totals_by_date'] = {};
  const tb = rec(j.totals_by_date);
  for (const d of dates) {
    const t = rec(tb[d]);
    totals[d] = { lines: num(t.lines), value: num(t.value) };
  }
  return {
    mode: 'matrix',
    dates,
    rows: arr(j.rows).map((r): MatrixRow => {
      const o = rec(r);
      const counts: Record<string, CountCell | null> = {};
      const c = rec(o.counts);
      for (const d of dates) counts[d] = normaliseCell(c[d]);
      return {
        material_id: o.material_id == null ? null : str(o.material_id),
        sub_recipe_id: o.sub_recipe_id == null ? null : str(o.sub_recipe_id),
        type: str(o.type) === 'SUB' ? 'SUB' : 'RAW',
        material: str(o.material),
        sku: str(o.sku),
        category: str(o.category),
        department: str(o.department),
        department_id: str(o.department_id),
        purchase_unit: str(o.purchase_unit),
        counts,
        latest_qty: numOrNull(o.latest_qty),
        previous_qty: numOrNull(o.previous_qty),
        change_qty: numOrNull(o.change_qty),
        change_pct: numOrNull(o.change_pct),
        latest_value: numOrNull(o.latest_value),
      };
    }),
    totals_by_date: totals,
    truncated: !!j.truncated,
    from: str(j.from) || from,
    to: str(j.to) || to,
    scope: j.scope == null ? undefined : str(j.scope),
    note: j.note == null ? null : str(j.note),
  };
};

const normaliseFlat = (payload: unknown, from: string, to: string): FlatResp => {
  const j = rec(payload);
  const rows = arr(j.rows).map((r): FlatRow => {
    const o = rec(r);
    return {
      date: str(o.date),
      department: str(o.department),
      material: str(o.material),
      sku: str(o.sku),
      category: str(o.category),
      purchase_unit: str(o.purchase_unit),
      counted_purchase: numOrNull(o.counted_purchase),
      rate: numOrNull(o.rate),
      rate_source: str(o.rate_source),
      value: numOrNull(o.value),
      recorded_by: str(o.recorded_by),
      type: str(o.type) === 'SUB' ? 'SUB' : 'RAW',
      gst_pct: numOrNull(o.gst_pct),
      gst_note: str(o.gst_note),
      gst_title: str(o.gst_title),
      tax: numOrNull(o.tax),
      total_incl_tax: numOrNull(o.total_incl_tax),
    };
  });
  const t = rec(j.totals);
  return {
    mode: 'flat',
    rows,
    // Re-summed here from the very rows the table prints (the route sends the
    // same figure), so the footer can never disagree with its own column.
    totals: { count: numOrNull(t.count) ?? rows.length, value: num(t.value), tax: sumClosingTax(rows) },
    truncated: !!j.truncated,
    from: str(j.from) || from,
    to: str(j.to) || to,
    scope: j.scope == null ? undefined : str(j.scope),
    note: j.note == null ? null : str(j.note),
  };
};

/**
 * Store vs Departments is read STRICTLY — the opposite of the two forgiving
 * readers above. There a missing key is one blank cell; here a missing key is
 * a missing department, block or total, i.e. half a sheet, and a half sheet
 * renders as zeros that look exactly like a real count. So the whole shape is
 * checked and anything short of it THROWS: load() then clears every table and
 * says the read failed. Never a partial or zero table on a failed read.
 */
const BYDEPT_BAD =
  'The server sent an incomplete Store vs Departments sheet, so nothing is shown rather than a partial table. Retry.';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const readBydeptTotal = (v: unknown): BydeptTotal => {
  const o = rec(v);
  const lines = numOrNull(o.lines);
  const value = numOrNull(o.value);
  const unpriced = numOrNull(o.unpriced);
  if (lines == null || value == null || unpriced == null) throw new Error(BYDEPT_BAD);
  return { lines, value, unpriced };
};

const readBydeptBlock = (v: unknown, keys: string[]): BydeptBlock => {
  if (!v || typeof v !== 'object') throw new Error(BYDEPT_BAD);
  const o = rec(v);
  const bc = rec(o.by_column);
  const by_column: Record<string, BydeptTotal> = {};
  for (const k of keys) by_column[k] = readBydeptTotal(bc[k]);
  const t = rec(o.total);
  const items = numOrNull(t.items);
  if (items == null) throw new Error(BYDEPT_BAD);
  return { by_column, total: { ...readBydeptTotal(t), items } };
};

const normaliseBydept = (payload: unknown): Omit<BydeptResp, 'asked_q'> => {
  const j = rec(payload);
  if (str(j.mode) !== 'bydept' || !ISO_DAY.test(str(j.date)) ||
      !Array.isArray(j.columns) || !Array.isArray(j.rows) || !Array.isArray(j.semi_rows)) {
    throw new Error(BYDEPT_BAD);
  }
  const columns = j.columns.map((c): BydeptColumn => {
    const o = rec(c);
    const key = str(o.key);
    if (!key) throw new Error(BYDEPT_BAD);
    return {
      key,
      name: str(o.name) || key,
      group_key: str(o.group_key) || key,
      group: str(o.group) || str(o.name) || key,
      is_store: !!o.is_store,
      is_main: !!o.is_main,
      is_active: o.is_active == null ? true : !!o.is_active,
      counted: o.counted == null ? true : !!o.counted,
    };
  });
  const keys = columns.map(c => c.key);
  const readRow = (r: unknown): BydeptRow => {
    const o = rec(r);
    if (!o.cells || typeof o.cells !== 'object') throw new Error(BYDEPT_BAD);
    const c = rec(o.cells);
    const unit = str(o.purchase_unit);
    const cells: Record<string, BydeptCell | null> = {};
    for (const k of keys) {
      // The route writes EVERY column key on every row. An absent key, or a
      // present cell with no quantity, is a broken row — not "not counted".
      if (!(k in c)) throw new Error(BYDEPT_BAD);
      const cell = normaliseCell(c[k]);
      if (c[k] != null && !cell) throw new Error(BYDEPT_BAD);
      // The unit the route says THIS cell was counted in, as sent (the
      // Download prints it in a mixed-unit row); the row's unit only if absent.
      const cu = rec(c[k]).unit;
      cells[k] = cell ? { ...cell, unit: cu == null ? unit : str(cu) } : null;
    }
    return {
      key: str(o.key),
      type: str(o.type) === 'SUB' ? 'SUB' : 'RAW',
      material: str(o.material),
      sku: str(o.sku),
      category: str(o.category),
      purchase_unit: unit,
      cells,
      total_qty: numOrNull(o.total_qty),
      total_value: numOrNull(o.total_value),
      counted_in: num(o.counted_in),
      unpriced: num(o.unpriced),
      mixed_units: !!o.mixed_units,
    };
  };
  const t = rec(j.totals);
  const readTax = (v: unknown): ClosingTaxTotals => {
    const o = rec(v);
    return {
      tax: num(o.tax), total_incl_tax: num(o.total_incl_tax), value_taxed: num(o.value_taxed),
      rated: num(o.rated), taxed: num(o.taxed), items: num(o.items),
    };
  };
  const tx = j.tax == null ? null : rec(j.tax);
  return {
    mode: 'bydept',
    date: str(j.date),
    latest_date: ISO_DAY.test(str(j.latest_date)) ? str(j.latest_date) : null,
    count_dates: arr(j.count_dates).map(str).filter(d => ISO_DAY.test(d)),
    columns,
    rows: j.rows.map(readRow),
    semi_rows: j.semi_rows.map(readRow),
    totals: {
      raw: readBydeptBlock(t.raw, keys),
      semi: readBydeptBlock(t.semi, keys),
      all: readBydeptBlock(t.all, keys),
    },
    tax: tx ? {
      by_column: Object.fromEntries(keys.map(k => [k, readTax(rec(tx.by_column)[k])])),
      total: readTax(tx.total),
    } : null,
    truncated: !!j.truncated,
    scope: j.scope == null ? undefined : str(j.scope),
    note: j.note == null ? null : str(j.note),
  };
};

/* ── Page ────────────────────────────────────────────────────────────────── */

type ViewMode = 'matrix' | 'flat' | 'bydept';

export default function ClosingHistoryPage() {
  const [view, setView] = useState<ViewMode>('matrix');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(todayIST);
  const [deptId, setDeptId] = useState('');
  /** What the user is typing. `qSent` is what actually went to the server — the
   *  table and the CSV are both answers to `qSent`, never to the live keystroke. */
  const [q, setQ] = useState('');
  const [qSent, setQSent] = useState('');

  const [matrix, setMatrix] = useState<MatrixResp | null>(null);
  const [flat, setFlat] = useState<FlatResp | null>(null);
  /** Store vs Departments. `bdDate` '' = "the latest count" — the route picks
   *  it, and the answer's `date` is what the screen and the download use. */
  const [bydept, setBydept] = useState<BydeptResp | null>(null);
  const [bdDate, setBdDate] = useState('');
  /** The count-date list from the last sheet that loaded, kept through a
   *  failed reload so the picker never empties under an error banner. */
  const [bdDates, setBdDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [depts, setDepts] = useState<DeptOption[]>([]);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState('');

  /** Only the newest request may write state. Without this a slow response to an
   *  earlier search can land after a newer one and put stale rows under a filter
   *  that no longer matches them — a wrong report that looks perfectly fine. */
  const reqId = useRef(0);

  const rangeInverted = !!from && !!to && from > to;

  /* Debounce the search box. 350 ms is a typed word, not a keystroke. */
  useEffect(() => {
    const t = setTimeout(() => setQSent(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  /* Department options for the filter. The route re-checks scope on every call,
   * so this list is a convenience only — picking a department out of scope gets
   * an explicit 403 message rather than a misleading empty table. */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/departments', { credentials: 'same-origin' });
        if (!res.ok) return;                       // the filter is optional; the page still works
        const json = await res.json();
        if (!alive) return;
        setDepts(arr(json?.departments).map((d): DeptOption => {
          const o = rec(d);
          return {
            id: str(o.id),
            name: str(o.name),
            is_active: o.is_active == null ? true : !!Number(o.is_active),
            parent_name: str(o.parent_name) || undefined,
          };
        }).filter(d => d.id && d.name));
      } catch { /* filter stays as "All departments" — not worth an error banner */ }
    })();
    return () => { alive = false; };
  }, []);

  /**
   * Store vs Departments: pick a count date. A DIFFERENT date drops the sheet
   * at once, so the old date's rows never sit under the new date while its
   * reply is on the way (the loading panel shows instead), and nothing of the
   * old day is left on screen to be read — or downloaded — as the new one.
   * Stable (no deps), so the memoised table is not re-rendered by it.
   */
  const pickBdDate = useCallback((d: string) => {
    setBdDate(d); setDlErr('');
    // A blank pick asks for the latest count; with no count in scope at all
    // (latest_date null) that is the sheet already on screen — same query, so
    // no load would follow and a dropped sheet would never come back.
    setBydept(cur => (cur && cur.date !== (d || cur.latest_date || cur.date) ? null : cur));
  }, []);

  /** The exact query the table AND the download are both built from. */
  const params = useMemo(() => {
    if (view === 'bydept') {
      // ONE date and the item search — no range, no department filter (the
      // departments ARE the columns), no GST. A blank date asks for the latest.
      const p = new URLSearchParams({ view });
      if (bdDate) p.set('date', bdDate);
      if (qSent) p.set('q', qSent);
      return p;
    }
    const p = new URLSearchParams({ view, from, to });
    if (deptId) p.set('department_id', deptId);
    if (qSent) p.set('q', qSent);
    // Estimated GST (rulings #77/#81) on the "All entries" table AND its CSV.
    // Opt-in on the route, so the Dept Closing Sheet's history file (same
    // route, no gst=1) stays unchanged. The matrix never carries it.
    if (view !== 'matrix') p.set('gst', '1');
    return p;
  }, [view, from, to, deptId, qSent, bdDate]);

  const load = useCallback(async () => {
    // An inverted range is never fetched — but the old table must go with it.
    // Leaving last query's rows under a "swap the dates" banner invites reading
    // them as the answer to a range that was never asked. (Store vs Departments
    // reads one date, not the range, so the range cannot block it.)
    if (rangeInverted && view !== 'bydept') {
      reqId.current++;                             // orphan any request still in flight
      setMatrix(null); setFlat(null); setBydept(null); setError(''); setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true); setError('');
    if (view === 'bydept') {
      // Store vs Departments: a sheet that answers a DIFFERENT search or date
      // leaves now, so the loading panel — never the old, e.g. filtered, table
      // — stands while the new sheet is fetched and drawn. (A cleared search on
      // a 1,000-item day once sat frozen on the old 18-row table for a second.)
      const askQ = params.get('q') || '';
      const askDate = params.get('date') || '';
      setBydept(cur => (cur && (cur.asked_q !== askQ || cur.date !== (askDate || cur.latest_date)) ? null : cur));
    }
    /** True once a Store vs Departments sheet is handed to React as a
     *  transition, which then clears `loading` itself, in the same commit. */
    let handedOff = false;
    try {
      const res = await fetch(`/api/closing-stock/history?${params.toString()}`,
                              { credentials: 'same-origin' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      if (id !== reqId.current) return;            // a newer request already won
      if (view === 'matrix') { setMatrix(normaliseMatrix(json, from, to)); setFlat(null); setBydept(null); }
      else if (view === 'flat') { setFlat(normaliseFlat(json, from, to)); setMatrix(null); setBydept(null); }
      else {
        // STRICT reader: anything short of the whole sheet throws into the
        // catch below, which clears every table — never a partial one.
        const sheet: BydeptResp = { ...normaliseBydept(json), asked_q: params.get('q') || '' };
        // Drawn as a TRANSITION: React builds the (up to ~13k-cell) sheet in
        // short slices, so the page keeps answering — spinner, search box,
        // tabs — instead of freezing while it draws. The loading panel stays
        // up until the WHOLE sheet commits in one go (never a part of it), and
        // `loading` goes false in that same commit, never before it.
        handedOff = true;
        startTransition(() => {
          setBydept(sheet); setBdDates(sheet.count_dates); setMatrix(null); setFlat(null);
          setLoading(false);
        });
      }
    } catch (e: unknown) {
      if (id !== reqId.current) return;
      // Drop the stale table with the error. Leaving last minute's rows under a
      // banner invites reading them as the answer to the filter that just failed.
      setMatrix(null); setFlat(null); setBydept(null);
      setError((e as Error)?.message || 'Failed to load closing stock history');
    } finally {
      if (id === reqId.current && !handedOff) setLoading(false);
    }
  }, [params, view, from, to, rangeInverted]);

  useEffect(() => { load(); }, [load]);

  const resp: MatrixResp | FlatResp | BydeptResp | null =
    view === 'matrix' ? matrix : view === 'flat' ? flat : bydept;
  const truncated = !!resp?.truncated;
  const limitedScope = resp?.scope === 'limited';
  // Store vs Departments never sends the Department filter, so only the item
  // search can narrow it — and "filtered" describes the sheet ON SCREEN (the
  // search it answers), not a search still being typed.
  const filtered = view === 'bydept' ? !!bydept?.asked_q : !!deptId || !!qSent;
  /** The date the Store vs Departments sheet on screen is FOR. While "latest"
   *  is loading with no sheet up, the last known latest date stands in. */
  const bdShown = bdDate || bydept?.date || bdDates[0] || '';
  const rangeBlocks = rangeInverted && view !== 'bydept';
  /** Store vs Departments: nothing to download until the asked-for sheet is on
   *  screen — the file is always the sheet the reader is looking at. Nor while
   *  the search box says something the sheet does not answer yet (the 350 ms
   *  before a typed word is sent): a file of the old search saved under the
   *  new text in the box would read as the answer to it. */
  const bdNoSheet = view === 'bydept' && (loading || !bydept || q.trim() !== bydept.asked_q);
  /** Store vs Departments with no sheet, no error and no load running yet —
   *  the moment between dropping a sheet (a new date, the tab just opened)
   *  and the load starting. It is a load; it shows as one, never as a blank. */
  const bdWaiting = view === 'bydept' && !bydept && !error;

  /**
   * Download. Deliberately the SAME URL as the table, plus format=csv — so the
   * file cannot disagree with the screen. Every failure path throws so the page
   * can SAY so: a 403 saved as "closing-stock-matrix-….csv" containing
   * {"error":…} is worse than no download, because the user only finds out when
   * they open it. A JSON body counts as a failure even on a 200 — this endpoint
   * only ever answers JSON to complain.
   */
  const download = async () => {
    if (rangeBlocks) { setDlErr('“From” is after “To” — swap the dates.'); return; }
    if (bdNoSheet) return;                                   // the button is disabled too
    setDlBusy(true); setDlErr('');
    try {
      if (view === 'bydept' && bydept) {
        // Store vs Departments: the file is BUILT HERE from the sheet ON
        // SCREEN — its date, the search it answers, every count and ₹ exactly
        // as shown — by the same builder the route's format=csv uses. It does
        // not ask the server again: a count saved after this sheet loaded
        // (another department closing that evening) would otherwise make the
        // file silently differ from the table above it. Nothing is fetched,
        // so a date picked mid-download cannot swap the file either.
        const text = bydeptCsv({ ...bydept, note: bydept.note ?? null, q: bydept.asked_q });
        const href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = href;
        a.download = bydeptCsvFilename(bydept.date, bydept.asked_q);
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(href);
        return;
      }
      const p = new URLSearchParams(params);
      p.set('format', 'csv');
      const res = await fetch(`/api/closing-stock/history?${p.toString()}`,
                              { credentials: 'same-origin' });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || ct.includes('application/json')) {
        let msg = res.ok ? 'The server did not return a CSV.' : `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          // A Next error page answers in HTML — pasting that into the banner
          // tells the user nothing, so keep the status line instead.
          const t = (await res.text().catch(() => '')).trim();
          if (t && !t.startsWith('<') && t.length <= 300) msg = t;
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('The server returned an empty file.');
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filenameFrom(
        res.headers.get('content-disposition'),
        view === 'matrix'
          ? `closing-stock-matrix-${from}_${to}.csv`
          : `closing-stock-history-${from}_${to}.csv`,
      );
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(href);
    } catch (e: unknown) {
      setDlErr((e as Error)?.message || 'Download failed');
    } finally {
      setDlBusy(false);
    }
  };

  const resetFilters = () => {
    setFrom(defaultFrom()); setTo(todayIST()); setDeptId(''); setQ(''); setDlErr(''); pickBdDate('');
  };

  /* ── Access lock ───────────────────────────────────────────────────────── */

  // Same wording contract the entry sheet uses: the history route answers 403
  // with "…limited to admins, managers, HODs and store managers…", which is a
  // permission state, not a fault. A red crash banner would send the user
  // hunting for a bug that does not exist.
  const denied = !!error && /limited|authoriz/i.test(error);
  /** Store vs Departments failed to load: its own panel says so in plain words
   *  IN PLACE OF the table, so the red banner (raw "Failed to fetch" /
   *  "HTTP 500") does not stand above it. The other tabs keep their banner. */
  const bdFailed = view === 'bydept' && !!error && !denied && !bydept;
  if (denied && !resp) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <History className="w-6 h-6 text-[#af4408]" /> Closing Stock History
        </h1>
        <div className="rounded-lg p-4 text-sm flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>🔒 {error}</span>
        </div>
      </div>
    );
  }

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <History className="w-6 h-6 text-[#af4408]" /> Closing Stock History
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {/* The Store vs Departments tab is one date, and its semi-finished
                block is in yield units — so it gets its own TRUE line. The
                other two tabs keep theirs word for word. */}
            {view === 'bydept' ? (
              <>Every closing count already recorded — on one count date, each item&apos;s
              Store / Overall count beside every department&apos;s count of it. Raw materials
              in purchase units; semi-finished items in their own unit.</>
            ) : (
              <>Every closing count already recorded — each item beside what the same item
              counted last time. All quantities in purchase units.</>
            )}
          </p>
        </div>
        <Link href="/inventory/closing-sheet"
              className="px-3 py-2 bg-white border border-[#8B7355] text-[#6B5744] hover:bg-[#FFF8F0] rounded-lg text-sm font-medium flex items-center gap-1.5">
          <ClipboardCheck className="w-4 h-4" /> Closing sheet <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
        <button onClick={download} disabled={dlBusy || rangeBlocks || bdNoSheet}
                title={bdNoSheet
                  ? 'Available once the sheet is on screen — the file is always the sheet you are looking at.'
                  : view === 'bydept'
                    ? 'Saves the sheet on screen as a CSV — this count date and its item search, exactly as shown (counts saved since it loaded are not in it).'
                    : 'Downloads exactly what is on screen — the same view, dates, department and search.'}
                className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          {dlBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Download CSV
        </button>
      </div>

      {/* View toggle — one page, two shapes of the same filtered data. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[#E8D5C4] bg-white overflow-hidden">
          <ViewTab active={view === 'matrix'} onClick={() => setView('matrix')}
                   icon={<LayoutGrid className="w-3.5 h-3.5" />} label="Compare dates"
                   title="One row per item, one column per count date — newest first." />
          <ViewTab active={view === 'flat'} onClick={() => setView('flat')}
                   icon={<List className="w-3.5 h-3.5" />} label="All entries"
                   title="Every recorded count as its own line: date, department, item, quantity, rate, value." />
          <ViewTab active={view === 'bydept'} onClick={() => setView('bydept')}
                   icon={<Building2 className="w-3.5 h-3.5" />} label="Store vs Departments"
                   title="One count date: each item's Store / Overall count beside every department that counted it, grouped under its main department." />
        </div>
        <span className="text-[11px] text-[#8B7355] leading-tight max-w-[560px]">
          {view === 'matrix'
            ? 'Newest count on the left. The Change column compares the latest count with the one before it.'
            : view === 'flat'
              ? 'One line per recorded count, newest first.'
              : 'One count date. Store / Overall first, then every department that counted that day under its main department, then the Total.'}
        </span>
        {(loading || bdWaiting) && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
      </div>

      {/* Filters — every one of them is applied by the server, so the download
          below can never be a different set of rows to the table above. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 flex flex-wrap items-end gap-2">
        {view === 'bydept' ? (
          <BydeptDatePicker shown={bdShown} dates={bdDates} onPick={pickBdDate} />
        ) : (<>
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5 flex items-center gap-1"><CalendarDays className="w-3 h-3" /> From</div>
          <input type="date" value={from} max={to || undefined}
                 onChange={e => { setFrom(e.target.value); setDlErr(''); }}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
        </label>
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5">To</div>
          <input type="date" value={to} min={from || undefined}
                 onChange={e => { setTo(e.target.value); setDlErr(''); }}
                 className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
        </label>
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5 flex items-center gap-1"><Building2 className="w-3 h-3" /> Department</div>
          <select value={deptId} onChange={e => { setDeptId(e.target.value); setDlErr(''); }}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E] max-w-[220px]">
            <option value="">All departments in your scope</option>
            <option value={STORE_KEY}>Store / Overall (no department)</option>
            {depts.map(d => (
              <option key={d.id} value={d.id}>
                {d.name}{d.parent_name ? ` · ${d.parent_name}` : ''}{d.is_active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </label>
        </>)}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <div className="text-[10px] text-[#8B7355] mb-0.5">Item</div>
          <Search className="w-4 h-4 absolute left-2.5 top-[26px] text-[#8B7355]" />
          <input value={q} onChange={e => { setQ(e.target.value); setDlErr(''); }}
                 placeholder="Search item, SKU or category…"
                 className="w-full pl-8 pr-8 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear item search"
                    className="absolute right-2 top-[26px] text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          {view === 'bydept' ? (
            <button type="button" onClick={() => pickBdDate('')}
                    className="text-[11px] text-[#af4408] hover:underline">Latest count</button>
          ) : (<>
          <button type="button" onClick={() => { setFrom(shiftDays(todayIST(), -29)); setTo(todayIST()); setDlErr(''); }}
                  className="text-[11px] text-[#af4408] hover:underline">Last 30 days</button>
          <button type="button" onClick={() => { setFrom(shiftDays(todayIST(), -364)); setTo(todayIST()); setDlErr(''); }}
                  className="text-[11px] text-[#af4408] hover:underline">Last 12 months</button>
          </>)}
          <button type="button" onClick={resetFilters}
                  className="text-[11px] text-[#8B7355] hover:underline">Reset</button>
        </div>
      </div>

      {rangeBlocks && (
        <div className="rounded-lg p-3 text-sm flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0" />
          “From” ({from}) is after “To” ({to}) — swap the dates. Nothing is being loaded until you do,
          because an empty table here would read as “no counts were taken”.
        </div>
      )}

      {error && !denied && !bdFailed && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}
      {denied && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>🔒 {error}</span>
        </div>
      )}
      {dlErr && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>Download failed — {dlErr}</span>
        </div>
      )}

      {/* A silently shortened history is a WRONG history: the reader cannot tell
          a missing month from a month nobody counted. Shout, above the table. */}
      {truncated && (
        <div className="rounded-lg p-3 text-sm flex items-start gap-2 bg-amber-100 border-2 border-amber-400 text-amber-900">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          {resp?.mode === 'bydept' ? (
            // One date, so it is a SHEET that was cut, and its date reads the
            // way the rest of the tab writes dates (built here, not the route's
            // ISO-dated note).
            <div>
              <div className="font-semibold">This sheet is INCOMPLETE — it was cut short.</div>
              <div className="text-xs mt-0.5">
                Showing the first {(resp.rows.length + resp.semi_rows.length).toLocaleString('en-IN')} items
                (A–Z) counted on {fmtISTDate(resp.date)} — the day holds more. Search for an item to see the rest.
                {' '}The CSV download is cut at the same point.
              </div>
            </div>
          ) : (
          <div>
            <div className="font-semibold">This history is INCOMPLETE — it was cut short.</div>
            <div className="text-xs mt-0.5">
              {resp?.note
                || 'The range holds more counts than can be sent at once. Narrow the dates, pick one department, or search for an item to see the rest.'}
              {' '}The CSV download is cut at the same point.
            </div>
          </div>
          )}
        </div>
      )}

      {limitedScope && (
        <div className="rounded-lg p-3 text-xs flex items-center gap-2 bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
          Showing only the departments you are assigned to or have been granted.
        </div>
      )}

      {/* Summary */}
      {resp && (
        <div className={`grid grid-cols-2 ${resp.mode === 'bydept' && resp.tax ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-4'} gap-2.5`}>
          {resp.mode === 'matrix' ? (
            <>
              <SummaryCard icon={<CalendarDays className="w-4 h-4" />} label="Count dates"
                           value={resp.dates.length.toLocaleString('en-IN')}
                           note={`${fmtISTDate(resp.from)} → ${fmtISTDate(resp.to)}`} />
              <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items tracked"
                           value={resp.rows.length.toLocaleString('en-IN')}
                           note={filtered ? 'filtered view' : undefined} />
              <SummaryCard icon={<ClipboardCheck className="w-4 h-4" />} label="Latest count"
                           value={resp.dates[0] ? fmtISTDate(resp.dates[0]) : EM}
                           note={resp.dates[0]
                             ? `${(resp.totals_by_date[resp.dates[0]]?.lines ?? 0).toLocaleString('en-IN')} lines`
                             : undefined} />
              <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Latest count value"
                           value={resp.dates[0] ? inr(resp.totals_by_date[resp.dates[0]]?.value ?? 0) : EM}
                           note="valued at the rate stored when it was counted" />
            </>
          ) : resp.mode === 'bydept' ? (
            <BydeptSummary data={resp} filtered={filtered} />
          ) : (
            <>
              <SummaryCard icon={<CalendarDays className="w-4 h-4" />} label="Range"
                           value={`${fmtISTDate(resp.from)}`} note={`to ${fmtISTDate(resp.to)}`} />
              <SummaryCard icon={<List className="w-4 h-4" />} label="Entries"
                           value={resp.totals.count.toLocaleString('en-IN')}
                           note={filtered ? 'filtered view' : undefined} />
              <SummaryCard icon={<Layers className="w-4 h-4" />} label="Count dates"
                           value={new Set(resp.rows.map(r => r.date)).size.toLocaleString('en-IN')} />
              <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Value in range"
                           value={inr(resp.totals.value)}
                           note="every count in the range added together" />
            </>
          )}
        </div>
      )}

      {/* Table */}
      {(loading || bdWaiting) && !resp ? (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#6B5744]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading closing stock history…
        </div>
      ) : !resp
        // Store vs Departments says IN PLACE OF THE TABLE that the read failed
        // and nothing is shown — an empty space under a banner can still be
        // read as "a sheet with no counts".
        ? (view === 'bydept' && error && !denied && !loading
            ? <BydeptFailed date={bdShown} error={error} onRetry={load} />
            : null)
        : resp.mode === 'matrix'
          ? <MatrixTable data={resp} filtered={filtered} />
          : resp.mode === 'flat'
            ? <FlatTable data={resp} filtered={filtered} />
            : <BydeptTable data={resp} filtered={filtered} onPickDate={pickBdDate} />}
    </div>
  );
}

/* ── Compare dates (the matrix) ──────────────────────────────────────────── */

function MatrixTable({ data, filtered }: { data: MatrixResp; filtered: boolean }) {
  const { dates, rows, totals_by_date } = data;

  if (rows.length === 0 || dates.length === 0) {
    return <EmptyState filtered={filtered} from={data.from} to={data.to} />;
  }

  return (
    <div className="space-y-2">
      {/* A colour difference nobody has been told about is not information. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-[#F7F1EA] text-[#B9A896] border border-[#EFE3D6]">{EM}</span>
          not counted on that date
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-white border border-[#E8D5C4] text-[#2D1B0E] font-medium tabular-nums">0 kg</span>
          counted, and the count was zero
        </span>
        {dates.length > 8 && (
          <span className="text-[#8B7355]">
            {dates.length.toLocaleString('en-IN')} count dates — scroll the table sideways for older ones.
          </span>
        )}
      </div>

      {/* Wide by nature: the table scrolls inside this box, the page never does. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-x-auto">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr className="bg-[#FFF1E3] text-[#6B5744]">
              <th className="sticky left-0 z-20 bg-[#FFF1E3] text-left font-semibold px-3 py-2 min-w-[220px] border-r border-[#E8D5C4]">
                Item
              </th>
              <th className="text-right font-semibold px-3 py-2 min-w-[130px]"
                  title="Latest count compared with the count before it.">
                Change
              </th>
              <th className="text-right font-semibold px-3 py-2 min-w-[100px]"
                  title="Value of the latest count, at the rate stored when it was counted.">
                Latest value
              </th>
              {dates.map((d, i) => (
                <th key={d}
                    className={`text-right font-semibold px-3 py-2 min-w-[110px] ${
                      i === 0 ? 'bg-[#FBE7D3] text-[#2D1B0E]' : ''}`}>
                  {fmtISTDate(d)}
                  <div className="text-[9px] font-normal text-[#8B7355]">
                    {i === 0 ? 'latest' : i === 1 ? 'previous' : `${i} counts ago`}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const rowKey = `${r.type}:${r.material_id || r.sub_recipe_id || ri}:${r.department_id}`;
              return (
                <tr key={rowKey} className="border-t border-[#F0E4D6] group hover:bg-[#FFF8F0]">
                  {/* The sticky cell carries its own background — a transparent
                      one lets the scrolled date columns show through it. */}
                  <td className="sticky left-0 z-10 bg-white group-hover:bg-[#FFF8F0] px-3 py-1.5 border-r border-[#E8D5C4]">
                    <div className="font-medium text-[#2D1B0E] leading-tight">
                      {r.material || EM}
                      {r.type === 'SUB' && (
                        <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-[#FFF1E3] text-[#8B7355] align-middle"
                              title="Sub-recipe — counted in its own yield unit, not a purchase unit.">sub</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#8B7355] leading-tight">
                      {r.department || EM}
                      {r.category && <span className="text-[#B9A896]"> · {r.category}</span>}
                    </div>
                    {r.sku && <div className="text-[9px] font-mono text-[#B9A896]">{r.sku}</div>}
                  </td>

                  <td className="px-3 py-1.5 text-right">
                    <ChangeCell row={r} />
                  </td>

                  <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                    {r.latest_value == null
                      ? <span className="text-[#B9A896]" title="This count has no rate basis, so it carries no value.">{EM}</span>
                      : inr2(r.latest_value)}
                  </td>

                  {dates.map((d, i) => {
                    const c = r.counts[d];
                    // NOT COUNTED and COUNTED-ZERO are different facts. The
                    // shaded cell + pale em-dash says "nobody looked here";
                    // "0 <unit>" in full-strength text says "we looked, there
                    // is none". Never let one render as the other.
                    if (!c) {
                      return (
                        <td key={d}
                            className="px-3 py-1.5 text-right bg-[#F7F1EA] text-[#B9A896]"
                            title={`Not counted on ${fmtISTDate(d)}`}>
                          {EM}
                        </td>
                      );
                    }
                    const money = c.value == null ? 'no value (no rate basis)' : inr2(c.value);
                    const rateTxt = c.rate == null ? 'no rate recorded' : `${inr2(c.rate)} / ${r.purchase_unit || 'unit'}`;
                    return (
                      <td key={d}
                          title={`${fmtISTDate(d)} · ${fmtQtyNum(c.qty)} ${r.purchase_unit} · ${money} · ${rateTxt}`}
                          className={`px-3 py-1.5 text-right tabular-nums ${
                            i === 0 ? 'bg-[#FEF6EE] font-medium text-[#2D1B0E]' : 'text-[#2D1B0E]'}`}>
                        {/* unit-lock: qty arrives in purchase units from the
                            route; printing r.purchase_unit beside it is the
                            whole conversion — nothing is divided here. */}
                        {fmtQtyNum(c.qty)} <span className="text-[9px] text-[#B9A896]">{r.purchase_unit}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
              <td className="sticky left-0 z-10 bg-[#FFF1E3] px-3 py-2 border-r border-[#E8D5C4]">
                Total value per count date
                <div className="text-[9px] font-normal text-[#8B7355]">
                  {rows.length.toLocaleString('en-IN')} item{rows.length === 1 ? '' : 's'}
                  {filtered && ' · filtered view'}
                </div>
              </td>
              {/* Quantities are never added across materials, in any column. */}
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Quantities cannot be added across different materials.">{EM}</td>
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Not totalled: each row's latest count can be on a different date, so the sum would be the valuation of no single day. Use the per-date totals.">
                {EM}
              </td>
              {dates.map((d, i) => {
                const t = totals_by_date[d] || { lines: 0, value: 0 };
                return (
                  <td key={d}
                      className={`px-3 py-2 text-right tabular-nums ${i === 0 ? 'bg-[#FBE7D3]' : ''}`}>
                    {inr(t.value)}
                    <div className="text-[9px] font-normal text-[#8B7355]">
                      {t.lines.toLocaleString('en-IN')} line{t.lines === 1 ? '' : 's'}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-[#8B7355]">
        Every count is valued at the rate stored when it was taken, so a past total never
        changes when a purchase price moves today.
      </p>
    </div>
  );
}

/**
 * Latest vs previous. A null change is an em-dash and NEVER "0%": an item
 * counted only once in this range has no previous figure, and printing 0%
 * claims it held perfectly steady — a statement nobody made.
 */
function ChangeCell({ row }: { row: MatrixRow }) {
  const dq = row.change_qty;
  if (dq == null) {
    return (
      <span className="text-[#B9A896]"
            title="Counted only once in this range — there is no earlier count to compare against.">
        {EM}
      </span>
    );
  }
  const up = dq > 0;
  const down = dq < 0;
  const tone = up ? 'text-emerald-700' : down ? 'text-red-700' : 'text-[#6B5744]';
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  const pct = row.change_pct;
  const prev = row.previous_qty;
  const now = row.latest_qty;
  // unit-lock: latest/previous are the route's purchase-basis figures.
  const title = prev == null || now == null
    ? 'Change since the previous count.'
    : `Previous ${fmtQtyNum(prev)} ${row.purchase_unit} → latest ${fmtQtyNum(now)} ${row.purchase_unit}`;
  return (
    <span className={`inline-flex items-center justify-end gap-1 tabular-nums ${tone}`} title={title}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>
        {up ? '+' : down ? '−' : ''}{fmtQtyNum(Math.abs(dq))} <span className="text-[9px] text-[#B9A896]">{row.purchase_unit}</span>
      </span>
      <span className="text-[10px] opacity-80">
        {/* A percentage off a zero previous count is not a number — dash it. */}
        {pct == null ? EM : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`}
      </span>
    </span>
  );
}

/* ── All entries (the existing flat list) ────────────────────────────────── */

function FlatTable({ data, filtered }: { data: FlatResp; filtered: boolean }) {
  const { rows } = data;
  if (rows.length === 0) return <EmptyState filtered={filtered} from={data.from} to={data.to} />;
  // Every note printed with the GST totals comes from the ONE helper, so it
  // states the true case: no rate / rates but no value saved at count / taxed.
  const taxNotes = closingTaxNotes(data.totals.tax, 'entries', inr2);

  return (
    <div className="space-y-2">
      <div className="bg-white border border-[#E8D5C4] rounded-lg overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-[#FFF1E3] text-[#6B5744]">
              <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Date</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[130px]">Department</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[200px]">Item</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[110px]">Counted</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[120px]">Rate</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[100px] bg-[#FBE7D3]">Value</th>
              {/* Estimated GST beside Value — derived only from it, so it is
                  shown to exactly the same readers. */}
              <th className="text-right font-semibold px-3 py-2 min-w-[110px]" title={CLOSING_GST_PCT_TITLE}>
                {CLOSING_GST_PCT_LABEL}
                <div className="text-[9px] font-normal text-[#8B7355]">{CLOSING_GST_PCT_SUB}</div>
              </th>
              <th className="text-right font-semibold px-3 py-2 min-w-[100px]" title={CLOSING_TAX_TITLE}>{CLOSING_TAX_LABEL}</th>
              <th className="text-right font-semibold px-3 py-2 min-w-[110px]" title={CLOSING_INCL_TITLE}>{CLOSING_INCL_LABEL}</th>
              <th className="text-left font-semibold px-3 py-2 min-w-[110px]">Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.date}-${r.department}-${r.material}-${i}`}
                  className="border-t border-[#F0E4D6] hover:bg-[#FFF8F0]">
                <td className="px-3 py-1.5 text-[#2D1B0E] whitespace-nowrap">{fmtISTDate(r.date)}</td>
                <td className="px-3 py-1.5 text-[#6B5744]">{r.department || EM}</td>
                <td className="px-3 py-1.5">
                  <div className="font-medium text-[#2D1B0E] leading-tight">
                    {r.material || EM}
                    {r.type === 'SUB' && (
                      <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-[#FFF1E3] text-[#8B7355] align-middle"
                            title="Sub-recipe — counted in its own yield unit.">sub</span>
                    )}
                  </div>
                  <div className="text-[9px] text-[#B9A896]">
                    <span className="font-mono">{r.sku || '·'}</span>
                    {r.category && <span> · {r.category}</span>}
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                  {/* unit-lock: counted_purchase is already in purchase units. */}
                  {r.counted_purchase == null
                    ? <span className="text-[#B9A896]">{EM}</span>
                    : <>{fmtQtyNum(r.counted_purchase)} <span className="text-[9px] text-[#B9A896]">{r.purchase_unit}</span></>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.rate == null ? (
                    <span className="text-[#B9A896]"
                          title="No rate was recorded for this count, so it carries no value.">{EM}</span>
                  ) : (
                    <>
                      <span className="text-[#2D1B0E]">{inr2(r.rate)}</span>
                      <span className="text-[9px] text-[#B9A896]"> / {r.purchase_unit}</span>
                      <div className="text-[9px] text-[#B8A590]">{RATE_LABEL[r.rate_source] || r.rate_source}</div>
                    </>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums bg-[#FEF6EE] text-[#2D1B0E]">
                  {r.value == null ? <span className="text-[#B9A896]">{EM}</span> : inr2(r.value)}
                </td>
                {/* Every rate says where it came from; blank is an em-dash,
                    never 0% / ₹0. */}
                <td className="px-3 py-1.5 text-right tabular-nums" title={r.gst_title || undefined}>
                  {r.gst_pct == null
                    ? <span className="text-[#B9A896]">{EM}</span>
                    : <span className="text-[#2D1B0E]">{fmtClosingGstPct(r.gst_pct)}</span>}
                  {r.gst_note && <div className="text-[9px] text-[#B8A590]">{r.gst_note}</div>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                  {r.tax == null
                    ? <span className="text-[#B9A896]" title={r.gst_pct == null ? r.gst_title : 'No value basis for this count — nothing to apply the rate to.'}>{EM}</span>
                    : inr2(r.tax)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#2D1B0E]">
                  {r.total_incl_tax == null
                    ? <span className="text-[#B9A896]" title={r.gst_pct == null ? r.gst_title : 'No value basis for this count — nothing to apply the rate to.'}>{EM}</span>
                    : inr2(r.total_incl_tax)}
                </td>
                <td className="px-3 py-1.5 text-[10px] text-[#6B5744]">{r.recorded_by || EM}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
              <td className="px-3 py-2" colSpan={3}>
                Total
                <span className="ml-1.5 text-[10px] font-normal text-[#8B7355]">
                  {data.totals.count.toLocaleString('en-IN')} entr{data.totals.count === 1 ? 'y' : 'ies'}
                  {filtered && ' · filtered view'}
                </span>
              </td>
              {/* 2 BTL + 3 kg is not a number in any basis. */}
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="Quantities cannot be added across different materials.">{EM}</td>
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
              <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">{inr2(data.totals.value)}</td>
              {/* A GST % does not add up across materials. Tax and Total incl.
                  sum ONLY the rows with a rate, and say how many. */}
              <td className="px-3 py-2 text-right text-[#B9A896] font-normal"
                  title="A GST % cannot be added across materials.">{EM}</td>
              <td className="px-3 py-2 text-right tabular-nums" title={`${CLOSING_TAX_TITLE} ${taxNotes.title}`}>
                {data.totals.tax.taxed > 0 ? inr2(data.totals.tax.tax) : <span className="text-[#B9A896] font-normal">{EM}</span>}
                <div className="text-[9px] font-normal text-[#8B7355]">{taxNotes.rate}</div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums" title={taxNotes.title}>
                {data.totals.tax.taxed > 0 ? inr2(data.totals.tax.total_incl_tax) : <span className="text-[#B9A896] font-normal">{EM}</span>}
                <div className="text-[9px] font-normal text-[#8B7355]">{taxNotes.incl}</div>
              </td>
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-[#8B7355]">
        Every count is valued at the rate stored when it was taken, so a past total never
        changes when a purchase price moves today.
      </p>
      <p className="text-[11px] text-[#8B7355]">
        GST is an estimate: Value × the GST % charged on the item&apos;s latest bill that recorded
        GST, dated on or before that count (else the item master&apos;s GST %). Bills with no GST
        recorded are skipped, and a later bill never changes it. Liquor / store items and
        semi-finished items carry no GST here; a blank is never 0%.
      </p>
    </div>
  );
}

/* ── Store vs Departments ────────────────────────────────────────────────── */

/**
 * ONE date in place of From / To. The free date box covers any day; the list
 * beside it holds only the dates something was actually counted on, so the
 * owner can step between real counts without guessing which days had one.
 */
function BydeptDatePicker({ shown, dates, onPick }: {
  shown: string; dates: string[]; onPick: (d: string) => void;
}) {
  return (
    <>
      <label className="text-[10px] text-[#8B7355]">
        <div className="mb-0.5 flex items-center gap-1"><CalendarDays className="w-3 h-3" /> Count date</div>
        <input type="date" value={shown} max={todayIST()}
               onChange={e => onPick(e.target.value)}
               className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
      </label>
      {dates.length > 0 && (
        <label className="text-[10px] text-[#8B7355]">
          <div className="mb-0.5">Dates with a count</div>
          <select value={dates.includes(shown) ? shown : ''}
                  onChange={e => { if (e.target.value) onPick(e.target.value); }}
                  className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E] max-w-[220px]">
            {!dates.includes(shown) && (
              <option value="">{shown ? '— no count on this date —' : '— pick a count date —'}</option>
            )}
            {dates.map((d, i) => (
              <option key={d} value={d}>{fmtISTDate(d)}{i === 0 ? ' · latest' : ''}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function BydeptSummary({ data, filtered }: { data: BydeptResp; filtered: boolean }) {
  const deptCols = data.columns.filter(c => !c.is_store);
  const store = data.columns.find(c => c.is_store);
  const items = data.rows.length + data.semi_rows.length;
  return (
    <>
      <SummaryCard icon={<CalendarDays className="w-4 h-4" />} label="Count date"
                   value={fmtISTDate(data.date)}
                   note={!data.latest_date ? 'no count recorded yet'
                     : data.latest_date === data.date ? 'the latest count'
                     : `latest count: ${fmtISTDate(data.latest_date)}`} />
      <SummaryCard icon={<Building2 className="w-4 h-4" />} label="Departments counted"
                   value={deptCols.length.toLocaleString('en-IN')}
                   note={store
                     ? (!store.counted ? 'Store / Overall did not count'
                       : deptCols.length ? 'plus Store / Overall' : 'only Store / Overall counted')
                     : undefined} />
      <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items"
                   value={items.toLocaleString('en-IN')}
                   note={`${data.rows.length.toLocaleString('en-IN')} raw · ${data.semi_rows.length.toLocaleString('en-IN')} semi-finished${filtered ? ' · filtered view' : ''}`} />
      {/* A day nobody counted has no value — an em-dash, never ₹0. Nor has a
          day whose every count carries no rate: that is "no rate", not ₹0. */}
      <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Value at count"
                   value={data.totals.all.total.lines && data.totals.all.total.unpriced < data.totals.all.total.lines
                     ? inr(data.totals.all.total.value) : EM}
                   note={!data.totals.all.total.lines
                     ? (filtered ? 'no count matches the item search' : 'nothing was counted on this date')
                     : data.totals.all.total.unpriced === data.totals.all.total.lines
                       ? 'counted, but no item has a rate — so no value'
                       : 'valued at the rate stored when it was counted'} />
      {/* Ruling 107: the raw block's estimated GST, as on the footer. It covers
          only the counts with a GST rate and a value at count — the note says
          which, so it is never read as "the Value card + tax". */}
      {data.tax && (() => {
        const tt = data.tax.total;
        const n = closingTaxNotes(tt, 'counts', inr);
        return (
          <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label={CLOSING_INCL_LABEL}
                       value={tt.taxed > 0 ? inr(tt.total_incl_tax) : EM}
                       note={tt.taxed > 0
                         ? `raw materials: value at count + ${inr(tt.tax)} GST · ${n.covers}`
                         : `raw materials: ${n.rate}`} />
        );
      })()}
    </>
  );
}

/** One plain sentence for why the sheet did not load. The raw text ("Failed
 *  to fetch", "HTTP 500", a server message) is kept only as a small detail
 *  line for whoever has to look into it. */
const bydeptFailReason = (error: string): string => {
  if (error === BYDEPT_BAD) return 'The server sent back an incomplete sheet.';
  if (/failed to fetch|networkerror|load failed|network/i.test(error)) {
    return 'The server could not be reached — check the internet connection, then retry.';
  }
  if (/^date must be/i.test(error)) return 'That date could not be read — pick a date from the list.';
  return 'The server ran into a problem while building the sheet — retry in a moment.';
};

function BydeptFailed({ date, error, onRetry }: { date: string; error: string; onRetry: () => void }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center text-sm text-red-700">
      <AlertCircle className="w-6 h-6 mx-auto mb-2" />
      The Store vs Departments sheet{date ? ` for ${fmtISTDate(date)}` : ''} could not be loaded.
      <div className="text-xs mt-1 text-red-700">{bydeptFailReason(error)}</div>
      <div className="text-xs mt-1 text-red-600">
        Nothing is shown rather than a partial sheet — a missing half would read as zero stock.
      </div>
      <button type="button" onClick={onRetry}
              className="mt-3 px-3 py-1.5 bg-white border border-red-300 text-red-700 hover:bg-red-100 rounded-lg text-xs font-medium inline-flex items-center gap-1.5">
        <RefreshCw className="w-3.5 h-3.5" /> Retry
      </button>
      {error !== BYDEPT_BAD && (
        <div className="mt-2 text-[10px] text-red-400 break-words">Technical detail: {error}</div>
      )}
    </div>
  );
}

/* Number formatters for the big sheet, built ONCE. toLocaleString(locale,
 * opts) is defined as new Intl.NumberFormat(locale, opts).format, so these
 * print the very same text as fmtQtyNum / inr2 — they are just not rebuilt
 * for every one of the ~13k figures on a 1,300-count day. */
const BD_QTY_FMT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
const BD_INR2_FMT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const bdQty = (v: number) => BD_QTY_FMT.format(Number(v) || 0);
const bdInr2 = (v: number) => '₹' + BD_INR2_FMT.format(Number(v) || 0);

/** Space kept under the table box, and the least it is ever drawn. */
const BD_GAP = 12;
const BD_FLOOR = 192;

/** Bottom edge of app chrome PINNED over the top of the window where it covers
 *  the box — the desktop's floating user pill, a top bar while it is stuck —
 *  so a docked box never tucks its column names under it. A sticky bar counts
 *  only while actually stuck (a bar that scrolls away with the page, as the
 *  phone's does today, is not chrome over the box). 0 when none. */
const bdTopChrome = (box: HTMLElement): number => {
  const main = box.closest('main');
  if (!main) return 0;
  const b = box.getBoundingClientRect();
  let bottom = 0;
  for (const el of Array.from(main.children)) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= 0 || r.top >= 24 || r.right <= b.left || r.left >= b.right) continue;
    if (cs.position === 'sticky') {
      // Stuck = sitting at its sticky offset while its parent has scrolled up past it.
      const at = parseFloat(cs.top);
      const parentTop = el.parentElement ? el.parentElement.getBoundingClientRect().top : r.top;
      if (!Number.isFinite(at) || Math.abs(r.top - at) > 1 || parentTop >= r.top - 1) continue;
    }
    bottom = Math.max(bottom, r.bottom);
  }
  return bottom;
};

/**
 * Rows = items, columns = Store / Overall, each department that counted that
 * day (under its main department), Total. Same NOT COUNTED vs COUNTED ZERO
 * rule and styling as the matrix. Only ₹ is totalled down a column; the Total
 * column adds ONE item's counts across places, which is valid because they are
 * the same material in the same unit.
 *
 * MEMOISED: a real day is 1,000+ rows × 15 columns. Its props (the sheet, a
 * flag derived from the sheet, a stable date callback) change only when a new
 * sheet arrives — so a keystroke in the search box or a loading flag never
 * re-renders 12k cells. Each row is its own memoised component, so React can
 * build a big sheet in short slices (it arrives as a transition — see load()).
 *
 * SCROLLING — the table sits in a box that scrolls both ways, both header rows
 * sticky to its top and the Item column sticky to its left. The box is fitted
 * to the window from JS (one layout effect, no React state, so the 12k cells
 * never re-render for it):
 *  • HEIGHT: never past the window's bottom — the box's bottom edge and its
 *    sideways scrollbar are always in view. At the top of the page it fills
 *    the room under its own top; as the page scrolls it grows to the window.
 *  • PAGE FIRST: until the box reaches the top of the window, an up/down wheel
 *    or swipe over it scrolls the PAGE (which grows the box); after that it
 *    scrolls the rows. So the sheet is never read through a 3-row slot.
 *  • SNAP: a sideways scroll always comes to rest with a column's left edge
 *    exactly on the Item column's right edge (and the far end is padded so the
 *    last resting place does too). A figure half under the sticky Item column
 *    showed only its right-hand end — 10 kg read "0 kg" (screen lens, 3 Nov).
 *  • CUT MASKS: a column still crossing an edge — mid-scroll, or at the box's
 *    right edge — has its figures covered, never shown in part.
 */
const BydeptTable = memo(function BydeptTable({ data, filtered, onPickDate }: {
  data: BydeptResp; filtered: boolean; onPickDate: (d: string) => void;
}) {
  const { columns, rows, semi_rows: semiRows, totals, date } = data;
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const head1Ref = useRef<HTMLTableRowElement>(null);
  const cutLRef = useRef<HTMLDivElement>(null);
  const cutRRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** Formatted once for the ~10k "not counted on …" cell titles. */
  const dayLabel = fmtISTDate(date);

  // Fitting the box to the window (see above). Written straight onto the DOM
  // — never React state, which would re-render every cell to move one edge.
  // A LAYOUT effect, so the first paint is already fitted.
  useLayoutEffect(() => {
    const box = boxRef.current, t = tableRef.current, tr = head1Ref.current;
    if (!box || !t || !tr) return;                 // the empty-day panel has no table
    const itemTh = tr.cells[0];
    /** Value columns in TABLE coordinates (they do not move with scrolling):
     *  left, right, and the padding a right-aligned figure stops short of. */
    let cols: { l: number; r: number; p: number }[] = [];
    let itemW = 0, headH = 0, bodyH = 0, below = 0, boxW = -1;
    let raf = 0, dirty = true;
    /** The group headings (Bar, Kitchen…) and the room their own padding
     *  leaves around the name; `shown` is the last visibility written. */
    let grps: { el: HTMLElement; pl: number; pr: number; shown: string }[] = [];
    const last: Record<string, string> = {};
    const put = (el: HTMLElement | null, prop: string, v: string) => {
      if (!el) return;
      const k = `${el === box ? 'b' : el === cutLRef.current ? 'l' : el === cutRRef.current ? 'r' : 'w'}:${prop}`;
      if (last[k] === v) return;
      last[k] = v;
      el.style.setProperty(prop, v);
    };

    const measure = () => {
      dirty = false;
      const tb = t.getBoundingClientRect();
      // The second header row sticks just under the first, whose height is
      // MEASURED (a long group name can wrap).
      t.style.setProperty('--bd-head1', `${Math.round(tr.getBoundingClientRect().height)}px`);
      // The Item heading is sticky: once the box is scrolled sideways its edge
      // reads scrollLeft further right of the table's, so take that back off
      // (else every re-measure pads for the wrong width and the snap flips).
      itemW = itemTh.getBoundingClientRect().right - tb.left - box.scrollLeft;
      t.style.setProperty('--bd-itemw', `${Math.round(itemW)}px`);
      headH = t.tHead ? t.tHead.getBoundingClientRect().height : 0;
      bodyH = tb.height - headH;
      cols = Array.from(t.querySelectorAll<HTMLElement>('th[data-bdcol]')).map((th) => {
        const r = th.getBoundingClientRect();
        return { l: r.left - tb.left, r: r.right - tb.left, p: parseFloat(getComputedStyle(th).paddingRight) || 0 };
      }).sort((a, b) => a.l - b.l);
      grps = Array.from(t.querySelectorAll<HTMLElement>('[data-bdgrp]')).map((el) => {
        const cs = getComputedStyle(el);
        const prev = grps.find((g) => g.el === el);
        // A new sheet keeps the same heading elements: start from what the
        // DOM holds now, so one hidden by the last sheet is shown again.
        return { el, pl: parseFloat(cs.paddingLeft) || 0, pr: parseFloat(cs.paddingRight) || 0, shown: prev ? prev.shown : el.style.visibility };
      });
      // What the page holds BELOW the box (the note under it, the page's own
      // bottom padding) — the docked box leaves exactly that much room, so the
      // page's last scroll position is the docked position, never past it.
      const shell = box.closest('main > div');
      const wrap = wrapRef.current;
      below = shell && wrap ? Math.max(0, shell.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom) : 0;
      put(box, 'scroll-padding-left', `${itemW}px`);
      // The far end: pad the scroll range so its LAST resting place also puts
      // a column's left edge on the Item column's edge (else the end of the
      // range cuts whichever column happens to sit there).
      const W = tb.width, C = box.clientWidth;
      let pad = 0;
      if (W > C + 1) {
        const want = W - C + itemW;
        const edge = cols.find((c) => c.l >= want - 0.5);
        if (edge) pad = Math.ceil(edge.l - want);
      }
      put(box, 'padding-right', pad > 0 ? `${pad}px` : '0px');
    };

    const mask = (el: HTMLDivElement | null, c: { l: number; r: number } | undefined) => {
      if (!c) { put(el, 'display', 'none'); return; }
      put(el, 'left', `${c.l}px`); put(el, 'width', `${c.r - c.l}px`);
      put(el, 'top', `${headH}px`); put(el, 'height', `${bodyH}px`);
      put(el, 'display', 'block');
    };

    const place = () => {
      raf = 0;
      if (dirty) measure();
      const ih = window.innerHeight;
      const br = box.getBoundingClientRect();
      const top = br.top;
      // A group heading rides inside its own heading cell (sticky both ways),
      // so it reads whole wherever that cell has room for it. Where it has not
      // — its cell mostly under the Item column, or mostly past the box's right
      // edge — the name would show in part ("ar" for Bar, "Kit" for Kitchen):
      // it is hidden there instead, the rule the cut masks apply to figures.
      // (Read before any write below, so this never forces a layout.)
      const inL = br.left + box.clientLeft, edgeL = inL + itemW, edgeR = inL + box.clientWidth;
      const vis = grps.map((g) => {
        const r = g.el.getBoundingClientRect();
        const a = r.left + g.pl, z = r.right - g.pr;     // the name itself, not its padding
        const part = z > edgeL + 0.5 && a < edgeR - 0.5 && (a < edgeL - 0.5 || z > edgeR + 0.5);
        return part ? 'hidden' : '';
      });
      const dockAt = bdTopChrome(box) + 8;
      // Docked height: the window less the top chrome and what sits below the
      // box, so docked box + the note under it exactly fill the window.
      const full = Math.max(BD_FLOOR, Math.floor(ih - dockAt - Math.max(below, BD_GAP)));
      const h = Math.floor(Math.max(BD_FLOOR, Math.min(full, ih - top - BD_GAP)));
      put(box, 'max-height', `${h}px`);
      put(box, 'overflow-y', top <= dockAt + 1 || box.scrollTop > 0 ? 'auto' : 'hidden');
      // ROOM TO DOCK: the box grows exactly as fast as the page scrolls, so
      // below it sits the growth still to come (none once docked, none for a
      // sheet that already fits). The page's length then stays constant: one
      // wheel or swipe carries the box all the way up (not 85 px a turn), and
      // the page's end is the docked position (the header never overshoots).
      const natural = headH + bodyH + (box.offsetHeight - box.clientHeight);
      put(wrapRef.current, 'padding-bottom', `${Math.max(0, Math.ceil(Math.min(full, natural) - h))}px`);
      // A column is masked when the edge falls INSIDE its figures' room (past
      // its padding) — a cut through padding alone hides no digit.
      const sl = box.scrollLeft, from = sl + itemW, to = sl + box.clientWidth;
      mask(cutLRef.current, cols.find((c) => c.l + c.p < from - 1 && from < c.r - c.p - 1));
      mask(cutRRef.current, cols.find((c) => c.l + c.p < to - 1 && to < c.r - c.p - 1));
      grps.forEach((g, i) => {
        if (g.shown === vis[i]) return;
        g.shown = vis[i];
        g.el.style.visibility = vis[i];               // keeps its room: the row never resizes for it
      });
    };

    const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
    const remeasure = () => { dirty = true; schedule(); };
    place();
    box.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', remeasure);
    // The table or its header changing size (fonts, a wrap) moves the column
    // edges; the box only matters when its WIDTH changes — its height is ours.
    // The page around it (`host`) changing size can MOVE the box (a hint line
    // appearing above it, a card wrapping), which changes the room under it.
    const host = box.closest('main') || document.body;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === host) continue;
        if (e.target !== box) { remeasure(); return; }
        // The box's CLIENT width (inside its borders and scrollbar, padding
        // included) is the only width measure() reads. Its content width also
        // moves when measure() writes the far-end padding-right — reacting to
        // THAT would re-arm measure() from its own write.
        const w = box.clientWidth;
        if (w !== boxW) { boxW = w; remeasure(); return; }
      }
      schedule();
    });
    ro?.observe(t); ro?.observe(tr); ro?.observe(box); ro?.observe(host);
    return () => {
      box.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', remeasure);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [data]);

  if (rows.length === 0 && semiRows.length === 0) {
    return (
      <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
        <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
        {filtered
          ? <>No closing count on {fmtISTDate(date)} matches the item search.</>
          : <>No closing stock was recorded on {fmtISTDate(date)}.</>}
        <div className="text-xs text-[#B9A896] mt-1">
          {filtered
            ? 'Clear the item search, or pick another count date.'
            : data.latest_date
              ? 'Pick a date that has a count.'
              : <>Counts recorded on the{' '}
                  <Link href="/inventory/closing-sheet" className="text-[#af4408] hover:underline">Department Closing Sheet</Link>{' '}
                  appear here from the moment they are saved.</>}
        </div>
        {data.latest_date && data.latest_date !== date && (
          <button type="button" onClick={() => onPickDate(data.latest_date!)}
                  className="mt-3 text-xs text-[#af4408] hover:underline">
            Show the latest count — {fmtISTDate(data.latest_date)}
          </button>
        )}
      </div>
    );
  }

  // Header groups: runs of adjacent columns under one main department (the
  // route sends them grouped and ordered). Store / Overall is its own heading.
  const groups: { key: string; name: string; span: number; store: boolean }[] = [];
  for (const c of columns) {
    const last = groups[groups.length - 1];
    if (last && !c.is_store && !last.store && last.key === c.group_key) last.span += 1;
    else groups.push({ key: c.group_key, name: c.group, span: 1, store: c.is_store });
  }
  const deptCols = columns.filter(c => !c.is_store);
  const two = deptCols.length > 0;              // a second header row only when there are departments
  const store = columns.find(c => c.is_store);
  // Sticky header cells carry their OWN background (a sticky cell on a
  // transparent background lets the rows scrolling under it show through)
  // and an inset bottom line (a collapsed table border stays behind when the
  // cell sticks). Header z 20, the Item header 30 (it sticks both ways), the
  // body's sticky Item cells 10, the cut masks 5 — so rows slide under the
  // header, the department columns (and the masks) under the Item column.
  const edge = 'shadow-[inset_0_-1px_0_#E8D5C4]';
  // Phone widths: the Item column, the value cells' padding and the heading /
  // ₹ text are a step smaller below sm, so two department columns sit beside
  // the item names once Store / Overall is scrolled past.
  const cutMask = 'pointer-events-none absolute z-[5] hidden bg-white shadow-[inset_6px_0_6px_-6px_rgba(45,27,14,0.18)]';

  return (
    <div className="space-y-2">
      {/* A colour difference nobody has been told about is not information. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#6B5744]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-[#F7F1EA] text-[#B9A896] border border-[#EFE3D6]">{EM}</span>
          not counted there on {dayLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block px-1.5 py-0.5 rounded bg-white border border-[#E8D5C4] text-[#2D1B0E] font-medium tabular-nums">0 kg</span>
          counted, and the count was zero
        </span>
        <span className="text-[#8B7355]">
          {store
            ? 'Store / Overall = counts saved with no department. Total = Store + every department, for that one item.'
            : 'Total = every department shown, for that one item.'}
        </span>
        <BydeptMoreColumns boxRef={boxRef} sheet={data} />
      </div>

      {/* Wide AND long by nature: the table scrolls inside this box both ways
          (fitted to the window from the layout effect above; the class is only
          the first-paint fallback), the page never sideways. */}
      <div ref={wrapRef}>
      <div ref={boxRef}
           className="relative bg-white border border-[#E8D5C4] rounded-lg overflow-auto overscroll-x-contain snap-x snap-mandatory scroll-pl-[120px] sm:scroll-pl-[220px] max-h-[max(12rem,calc(100dvh-8rem))]">
        <table ref={tableRef} className="text-xs border-collapse min-w-full">
          <thead>
            <tr ref={head1Ref} className="bg-[#FFF1E3] text-[#6B5744]">
              {/* Narrower on a phone (names wrap), and the value columns'
                  floor lower too, so two counts fit beside the names; the
                  full widths from the sm breakpoint up. */}
              <th rowSpan={two ? 2 : 1}
                  className={`sticky left-0 top-0 z-30 bg-[#FFF1E3] text-left font-semibold px-3 py-2 min-w-[120px] sm:min-w-[220px] border-r border-[#E8D5C4] ${edge}`}>
                Item
                <div className="text-[9px] font-normal text-[#8B7355]">raw in purchase units · semi-finished in their own unit</div>
                <BydeptMoreColumns boxRef={boxRef} sheet={data} compact />
              </th>
              {groups.map(g => g.store ? (
                <th key={g.key} rowSpan={two ? 2 : 1} data-bdcol=""
                    className={`sticky top-0 z-20 snap-start text-right font-semibold text-[11px] sm:text-xs px-2 sm:px-3 py-2 min-w-[96px] sm:min-w-[120px] bg-[#FBE7D3] text-[#2D1B0E] border-r border-[#E8D5C4] ${edge}`}>
                  {g.name}
                  <div className="text-[9px] font-normal text-[#8B7355]">
                    {store?.counted ? 'no department' : 'did not count on this date'}
                  </div>
                </th>
              ) : (
                <th key={g.key} colSpan={g.span}
                    className={`sticky top-0 z-20 bg-[#FFF1E3] text-center font-semibold px-3 py-1.5 border-l border-r border-[#E8D5C4] text-[#2D1B0E] ${two ? '' : edge}`}>
                  {/* Rides along beside the sticky Item column, and inside the
                      box's right edge, so a group half under the one or half
                      past the other still reads whole ("Bar", never "ar"); with
                      no room for the whole name the layout effect hides it. */}
                  <span data-bdgrp="" className="sticky inline-block px-1"
                        style={{ left: 'var(--bd-itemw, 0px)', right: 0 }}>{g.name}</span>
                </th>
              ))}
              <th rowSpan={two ? 2 : 1} data-bdcol=""
                  className={`sticky top-0 z-20 snap-start text-right font-semibold text-[11px] sm:text-xs px-2 sm:px-3 py-2 min-w-[96px] sm:min-w-[120px] bg-[#FBE7D3] text-[#2D1B0E] border-l border-[#E8D5C4] ${edge}`}>
                Total
                {/* A department-limited reader has no Store column to add. */}
                <div className="text-[9px] font-normal text-[#8B7355]">{store ? 'Store + departments' : 'departments shown'}</div>
              </th>
            </tr>
            {two && (
              <tr className="bg-[#FFF1E3] text-[#6B5744]">
                {deptCols.map(c => (
                  // The subtitle carries the main department, so a section
                  // still says where it belongs once the group heading above
                  // it has scrolled away sideways.
                  <th key={c.key} data-bdcol=""
                      title={c.is_main ? `${c.name} — its own count` : `${c.group} › ${c.name}`}
                      style={{ top: 'var(--bd-head1, 0px)' }}
                      className={`sticky z-20 snap-start bg-[#FFF1E3] text-right font-semibold text-[11px] sm:text-xs px-2 sm:px-3 py-1.5 min-w-[92px] sm:min-w-[110px] ${edge}`}>
                    {c.name}
                    <div className="text-[9px] font-normal text-[#8B7355]">
                      {c.is_main ? 'own count' : `${c.group} section`}{c.is_active ? '' : ' · inactive'}
                    </div>
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <BydeptBlockBody label="Raw materials" rows={rows} columns={columns} dayLabel={dayLabel}
                           totals={totals.raw} totalLabel="Value — raw materials" filtered={filtered} tax={data.tax}
                           emptyText={filtered ? 'No raw material matches the search on this date.' : 'No raw material was counted on this date.'} />
          <BydeptBlockBody label="Semi-finished (sub-recipes)" rows={semiRows} columns={columns} dayLabel={dayLabel}
                           totals={totals.semi} totalLabel="Value — semi-finished" filtered={filtered}
                           emptyText={filtered ? 'No semi-finished item matches the search on this date.' : 'No semi-finished item was counted on this date.'} />
          <tfoot>
            <BydeptTotalRow label="Total value — raw + semi-finished" t={totals.all} columns={columns}
                            filtered={filtered} strong />
          </tfoot>
        </table>
        {/* The two cut masks (placed by the layout effect, hidden at rest
            unless a column really is cut at the box's right edge). */}
        <div ref={cutLRef} aria-hidden="true" className={cutMask} />
        <div ref={cutRRef} aria-hidden="true" className={cutMask} />
      </div>
      </div>
      <p className="text-[11px] text-[#8B7355]">
        Every count is valued at the rate stored when it was taken, so a past total never
        changes when a purchase price moves today. Quantities are never added across
        different items — only rupees are totalled down a column.
      </p>
    </div>
  );
});

/**
 * "More to the right". On a phone only a couple of columns fit beside the
 * item names, and nothing else says a dozen more sit to the right. Counts the
 * column headings not (fully) in view, live as the box scrolls or resizes. It
 * owns its state, so tracking the scroll never re-renders the big table.
 * `compact`: the short repeat under the Item heading, which is sticky — so it
 * is still in view once the box has docked at the top of the window and the
 * line above the box has scrolled away (on a phone, at once).
 */
function BydeptMoreColumns({ boxRef, sheet, compact }: {
  boxRef: React.RefObject<HTMLDivElement | null>; sheet: BydeptResp; compact?: boolean;
}) {
  const [hidden, setHidden] = useState(0);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      // Scrolled to the end (or nothing to scroll): nothing is hidden.
      if (box.scrollLeft + box.clientWidth >= box.scrollWidth - 2) { setHidden(0); return; }
      // The visible right edge of the box's content: past its left border,
      // and short of its vertical scrollbar.
      const right = box.getBoundingClientRect().left + box.clientLeft + box.clientWidth;
      let n = 0;
      box.querySelectorAll<HTMLElement>('th[data-bdcol]').forEach(th => {
        if (th.getBoundingClientRect().right > right + 2) n += 1;
      });
      setHidden(n);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    box.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(box);
    return () => {
      box.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [boxRef, sheet]);
  if (compact) {
    // Its line is always kept (a blank when nothing is hidden), so the
    // heading never changes height as the count comes and goes.
    return (
      <div className="text-[9px] font-medium text-[#af4408]" aria-hidden={hidden ? undefined : true}>
        {hidden ? `${hidden.toLocaleString('en-IN')} more column${hidden === 1 ? '' : 's'} →` : '\u00a0'}
      </div>
    );
  }
  if (!hidden) return null;
  return (
    <span className="font-medium text-[#af4408]">
      {hidden.toLocaleString('en-IN')} more column{hidden === 1 ? '' : 's'} to the right — scroll the table sideways →
    </span>
  );
}

function BydeptBlockBody({ label, rows, columns, dayLabel, totals, totalLabel, filtered, emptyText, tax }: {
  label: string; rows: BydeptRow[]; columns: BydeptColumn[]; dayLabel: string;
  totals: BydeptBlock; totalLabel: string; filtered: boolean; emptyText: string;
  tax?: BydeptResp['tax'];
}) {
  return (
    <tbody>
      <tr className="border-t-2 border-[#E8D5C4] bg-[#FBF5EE]">
        <td className="sticky left-0 z-10 bg-[#FBF5EE] px-3 py-1.5 border-r border-[#E8D5C4] font-semibold text-[#6B5744] uppercase text-[10px] tracking-wide">
          {label} <span className="font-normal normal-case text-[#8B7355]">· {rows.length.toLocaleString('en-IN')} item{rows.length === 1 ? '' : 's'}</span>
        </td>
        <td colSpan={columns.length + 1} className="bg-[#FBF5EE]" />
      </tr>
      {rows.length === 0 ? (
        <tr className="border-t border-[#F0E4D6]">
          <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-[#E8D5C4] text-[#8B7355] italic">{emptyText}</td>
          <td colSpan={columns.length + 1} />
        </tr>
      ) : rows.map(r => <BydeptItemRow key={r.key} r={r} columns={columns} dayLabel={dayLabel} />)}
      <BydeptTotalRow label={totalLabel} t={totals} columns={columns} filtered={filtered} />
      {tax && <BydeptTaxRows tax={tax} columns={columns} />}
    </tbody>
  );
}

/**
 * Estimated GST under the raw-materials value (ruling 107): "Tax (GST, est.)"
 * and "Total incl. GST (est.)" for Store, every department and the Total.
 * Same labels, hover text and notes as the other GST surfaces (closing-tax.ts)
 * — only counts with a rate AND a value at count are in either figure, and the
 * line under each says how many. No such count in a column → an em-dash,
 * never ₹0.
 */
function BydeptTaxRows({ tax, columns }: { tax: NonNullable<BydeptResp['tax']>; columns: BydeptColumn[] }) {
  const cellFor = (x: ClosingTaxTotals | undefined, f: 'tax' | 'total_incl_tax', key: string, total?: boolean, isStore?: boolean) => {
    const n = x ? closingTaxNotes(x, 'counts', bdInr2) : null;
    return (
      <td key={key} title={n?.title}
          className={`px-2 sm:px-3 py-1.5 text-right tabular-nums text-[11px] sm:text-xs ${total ? 'bg-[#FBE7D3] border-l border-[#E8D5C4]' : isStore ? 'border-r border-[#E8D5C4]' : ''}`}>
        {x && x.taxed > 0 ? bdInr2(x[f]) : <span className="text-[#B9A896] font-normal">{EM}</span>}
        {n && x && x.items > 0 && (
          <div className="text-[9px] font-normal text-[#8B7355]">{f === 'tax' ? n.short : n.incl}</div>
        )}
      </td>
    );
  };
  const row = (f: 'tax' | 'total_incl_tax', label: string, title: string) => (
    <tr className="border-t border-[#E8D5C4] font-semibold text-[#2D1B0E] bg-[#FFF1E3]">
      <td className="sticky left-0 z-10 px-3 py-1.5 border-r border-[#E8D5C4] bg-[#FFF1E3]" title={title}>
        {label}
        <div className="text-[9px] font-normal text-[#8B7355]">raw materials · on the value at count</div>
      </td>
      {columns.map(c => cellFor(tax.by_column[c.key], f, c.key, false, c.is_store))}
      {cellFor(tax.total, f, '__total__', true)}
    </tr>
  );
  return (
    <>
      {row('tax', CLOSING_TAX_LABEL, CLOSING_TAX_TITLE)}
      {row('total_incl_tax', CLOSING_INCL_LABEL, CLOSING_INCL_TITLE)}
    </>
  );
}

/** One item's row — its own memoised component, so a big sheet is built in
 *  small pieces React can pause between (and never re-built for a keystroke). */
const BydeptItemRow = memo(function BydeptItemRow({ r, columns, dayLabel }: {
  r: BydeptRow; columns: BydeptColumn[]; dayLabel: string;
}) {
  return (
    <tr className="border-t border-[#F0E4D6] group hover:bg-[#FFF8F0]">
      {/* The sticky cell carries its own background — a transparent one
          lets the scrolled columns show through it. */}
      <td className="sticky left-0 z-10 bg-white group-hover:bg-[#FFF8F0] px-3 py-1.5 border-r border-[#E8D5C4] [overflow-wrap:anywhere] sm:[overflow-wrap:normal]">
        <div className="font-medium text-[#2D1B0E] leading-tight">
          {r.material || EM}
          {r.type === 'SUB' && (
            <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-[#FFF1E3] text-[#8B7355] align-middle"
                  title="Sub-recipe — counted in its own yield unit, not a purchase unit.">sub</span>
          )}
        </div>
        <div className="text-[10px] text-[#8B7355] leading-tight">
          {r.category || EM}
          {r.sku && <span className="font-mono text-[#B9A896]"> · {r.sku}</span>}
        </div>
      </td>
      {columns.map(c => {
        const cell = r.cells[c.key];
        // NOT COUNTED and COUNTED-ZERO are different facts — the matrix's
        // rule and styling exactly. Never let one render as the other.
        if (!cell) {
          return (
            <td key={c.key} className="px-2 sm:px-3 py-1.5 text-right bg-[#F7F1EA] text-[#B9A896]"
                title={`${c.name}: not counted on ${dayLabel}`}>
              {EM}
            </td>
          );
        }
        const money = cell.value == null ? 'no value (no rate basis)' : bdInr2(cell.value);
        const rateTxt = cell.rate == null ? 'no rate recorded' : `${bdInr2(cell.rate)} / ${cell.unit || 'unit'}`;
        const qty = bdQty(cell.qty);
        return (
          <td key={c.key}
              title={`${c.name} · ${qty} ${cell.unit} · ${money} · ${rateTxt}`}
              className={`px-2 sm:px-3 py-1.5 text-right tabular-nums text-[#2D1B0E] ${c.is_store ? 'bg-[#FEF6EE] border-r border-[#E8D5C4]' : ''}`}>
            {/* unit-lock: qty arrives in purchase units from the route;
                printing the unit beside it is the whole conversion. */}
            {qty} <span className="text-[9px] text-[#B9A896]">{cell.unit}</span>
          </td>
        );
      })}
      <td className="px-2 sm:px-3 py-1.5 text-right tabular-nums bg-[#FEF6EE] font-semibold text-[#2D1B0E] border-l border-[#E8D5C4]"
          title={`Counted in ${r.counted_in} place${r.counted_in === 1 ? '' : 's'}${r.unpriced ? ` · ${r.unpriced} with no rate (not in the value)` : ''}`}>
        {r.total_qty == null
          ? <span className="text-[#B9A896] font-normal" title="Counted in different units in different places — not added together.">{EM}</span>
          : <>{bdQty(r.total_qty)} <span className="text-[9px] text-[#B9A896] font-normal">{r.purchase_unit}</span></>}
        <div className="text-[9px] font-normal text-[#8B7355]">
          {r.total_value == null ? 'no value' : bdInr2(r.total_value)}
        </div>
      </td>
    </tr>
  );
});

/**
 * ₹ per column. A column with nothing counted in this block prints an em-dash,
 * NEVER ₹0 — "nobody counted here" is not "₹0 of stock here". Nor does a
 * column whose every count has no rate: that prints "— no rate", because ₹0
 * there would read as "worth nothing" when the truth is "never priced".
 */
function BydeptTotalRow({ label, t, columns, filtered, strong }: {
  label: string; t: BydeptBlock; columns: BydeptColumn[]; filtered: boolean; strong?: boolean;
}) {
  /** The line under each ₹: how many counts it covers, in plain words. A
   *  column's counts are items (one per item); the Total adds every column's. */
  const sub = (x: BydeptTotal, what: 'item' | 'count') => {
    const n = x.lines.toLocaleString('en-IN');
    const head = what === 'item' ? `${n} item${x.lines === 1 ? '' : 's'} counted` : `${n} count${x.lines === 1 ? '' : 's'}`;
    if (!x.unpriced) return head;
    if (x.unpriced === x.lines) return `${head} · none has a rate`;
    return `${head} · ${x.unpriced.toLocaleString('en-IN')} with no rate, not in the ₹`;
  };
  const money = (x: BydeptTotal, where: string) =>
    x.lines === 0
      ? <span className="text-[#B9A896] font-normal" title={`${where}: nothing counted here in this block.`}>{EM}</span>
      : x.unpriced === x.lines
        ? <span className="text-[#8B7355] font-normal"
                title={`${where}: counted, but none of these counts has a rate, so there is no value — not ₹0 of stock.`}>{EM} no rate</span>
        : bdInr2(x.value);
  return (
    <tr className={`border-t-2 border-[#E8D5C4] font-semibold text-[#2D1B0E] ${strong ? 'bg-[#FBE7D3]' : 'bg-[#FFF1E3]'}`}>
      <td className={`sticky left-0 z-10 px-3 py-2 border-r border-[#E8D5C4] ${strong ? 'bg-[#FBE7D3]' : 'bg-[#FFF1E3]'}`}>
        {label}
        <div className="text-[9px] font-normal text-[#8B7355]">
          {t.total.items.toLocaleString('en-IN')} item{t.total.items === 1 ? '' : 's'}
          {filtered && ' · filtered view'}
        </div>
      </td>
      {columns.map(c => {
        const x = t.by_column[c.key];
        return (
          <td key={c.key} className={`px-2 sm:px-3 py-2 text-right tabular-nums text-[11px] sm:text-xs ${c.is_store ? 'border-r border-[#E8D5C4]' : ''}`}>
            {money(x, c.name)}
            <div className="text-[9px] font-normal text-[#8B7355]">{sub(x, 'item')}</div>
          </td>
        );
      })}
      <td className="px-2 sm:px-3 py-2 text-right tabular-nums text-[11px] sm:text-xs bg-[#FBE7D3] border-l border-[#E8D5C4]">
        {money(t.total, 'Total')}
        <div className="text-[9px] font-normal text-[#8B7355]">{sub(t.total, 'count')}</div>
      </td>
    </tr>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function ViewTab({ active, onClick, icon, label, title }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; title: string;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active}
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors ${
              active ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
      {icon} {label}
    </button>
  );
}

/**
 * Two different nothings, and conflating them misleads: "your filter matched
 * nothing" is a filter problem, "nothing was counted in this range" is a
 * counting problem, and the fix for each is the opposite of the other.
 */
function EmptyState({ filtered, from, to }: { filtered: boolean; from: string; to: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
      <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
      {filtered ? (
        <>
          No closing count matches these filters between {fmtISTDate(from)} and {fmtISTDate(to)}.
          <div className="text-xs text-[#B9A896] mt-1">
            Clear the department or the item search, or widen the dates.
          </div>
        </>
      ) : (
        <>
          No closing stock was recorded between {fmtISTDate(from)} and {fmtISTDate(to)}.
          <div className="text-xs text-[#B9A896] mt-1">
            Counts recorded on the{' '}
            <Link href="/inventory/closing-sheet" className="text-[#af4408] hover:underline">
              Department Closing Sheet
            </Link>{' '}
            appear here from the moment they are saved.
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, note }: {
  icon: React.ReactNode; label: string; value: string; note?: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#8B7355]">
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums">{value}</div>
      {note && <div className="text-[9px] text-[#B9A896] leading-tight mt-0.5">{note}</div>}
    </div>
  );
}
