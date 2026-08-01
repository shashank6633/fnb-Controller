'use client';

/**
 * DEPARTMENT CLOSING SHEET — every active department on ONE sheet, for physical
 * stock entry and reporting (owner requirement 5).
 *
 * ── WHY A SIBLING OF /inventory/closing-overview, NOT AN EXTENSION ─────────
 * closing-overview is a READ-ONLY board whose rows are STORAGE AREAS and whose
 * columns are MAIN departments, with sub-departments folded into their parent.
 * It states in its own header that it never writes, and the fold is what makes
 * it readable. This sheet is the opposite shape on all three counts: rows are
 * MATERIALS, sub-departments stay separate (a count belongs to exactly ONE
 * department — folding "Akan Tandoori" into "Kitchen" would make entry
 * ambiguous), and it WRITES. Bolting entry onto the pivot would have meant one
 * page with two axes and two verbs. They deep-link to each other instead.
 *
 * ── DEPARTMENTS ARE READ AT RUNTIME ────────────────────────────────────────
 * The department list comes from the `departments` table via the API — nothing
 * here is hardcoded. Create "Cold Room" on /departments and it appears on this
 * sheet at the next load, with an empty item set until something is issued to
 * it or counted in it.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * Every quantity LEADS in the PURCHASE unit (the unit the counter is holding),
 * with the recipe figure as the small declared hint. Entry is in purchase units
 * and converts through packFactor before posting; the wire and the DB stay in
 * RECIPE units, unchanged.
 *
 * ── MONEY vs QUANTITY TOTALS ───────────────────────────────────────────────
 * Rupees total. Quantities do NOT: 2 BTL + 3 kg + 400 pcs is not a number in
 * any basis, so every quantity subtotal on this page prints an em-dash.
 *
 * ── BLIND COUNTS ───────────────────────────────────────────────────────────
 * System stock and variance are ADMIN-ONLY and are stripped by the API — for a
 * non-admin those keys never arrive, so the columns are not rendered at all.
 * `data.is_admin` (server-decided) is the only switch; there is no client-side
 * role guess anywhere on this page.
 *
 * ── BULK FILE ROUND-TRIP (blank template → upload → history) ───────────────
 * Three additive controls sit in their own strip, deliberately NOT beside the
 * header's "Export CSV": that button hands back what has already been COUNTED,
 * while these hand out a BLANK sheet and take it back filled. A store manager
 * who confuses the two loses an afternoon, so they never share a row.
 *   • Download blank template  GET  …/dept-sheet/import?date=&template=1
 *   • Upload counts            POST …/dept-sheet/import  {date, csv, mode}
 *   • Download history         GET  /api/closing-stock/history?…&format=csv
 * The upload is ALWAYS preview-then-apply. A 1,025-row file that silently
 * writes into the wrong department is a day of recounting, so Apply is dead
 * until a preview for THIS exact file has come back, and picking a new file
 * throws the previous preview away.
 *
 * Units are the server's problem here on purpose: the CSV declares purchase
 * units, the import route converts through packFactor, and this page only
 * DISPLAYS the entered → stored sample the route returns. No conversion is
 * duplicated client-side, so the two can never drift apart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import {
  ClipboardCheck, Loader2, AlertCircle, Download, Save, Search, X,
  CalendarDays, IndianRupee, Layers, Building2, ChevronDown, ChevronRight,
  PackageX, ArrowUpRight, CheckCircle2, FileDown, Upload, History,
} from 'lucide-react';
import Toggle from '@/components/Toggle';
import Qty from '@/components/Qty';
// /api/closing-stock is a CSRF-required prefix in proxy.ts, and this route sits
// under it — a raw fetch POST is rejected 403. Always post through api().
import { api } from '@/lib/api';
import {
  csvQty, dualQty, fmtQtyNum, packFactor, toPurchaseQty, type PackMeta,
} from '@/lib/pack-units';
import { todayIST, fmtIST } from '@/lib/format-date';

/* ── Wire types (the /api/closing-stock/dept-sheet contract) ─────────────── */

interface SheetItem {
  material_id: string;
  name: string;
  sku: string;
  category: string;
  unit: string;
  purchase_unit: string;
  pack_size: number | null;
  case_size: number | null;
  pack_factor: number;
  is_active: boolean;
  counted: boolean;
  /** RECIPE units, as stored. */
  physical_stock: number | null;
  rate_per_purchase_unit: number | null;
  rate_source: string;
  rate_as_of: string | null;
  rate_at_count: boolean;
  value: number | null;
  notes: string;
  recorded_by: string;
  /** Admin-only — absent from the payload for everyone else. */
  system_stock?: number | null;
  variance?: number | null;
  variance_value?: number | null;
}

interface SheetDept {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string;
  group: string;
  area: string;
  is_active: boolean;
  items: SheetItem[];
  totals: {
    items: number; counted: number; uncounted: number;
    value: number; unpriced: number; variance_value?: number;
  };
}

interface Sheet {
  date: string;
  is_admin: boolean;
  scope: 'all' | 'limited';
  departments: SheetDept[];
  totals: {
    departments: number; items: number; counted: number; uncounted: number;
    value: number; unpriced: number; variance_value?: number;
  };
  generated_at?: string;
}

/* ── Wire types (the …/dept-sheet/import contract) ───────────────────────── */

interface ImportIssue { line: number; label: string; reason: string }

interface ImportPreview {
  date: string;
  /** One entry per "<DEPT> Physical count" column found in the file. */
  departments: { id: string; name: string; matched: boolean }[];
  total_rows: number;
  will_write: number;
  skipped: number;
  errors: ImportIssue[];
  /** What the counter typed vs what will actually be stored, per the route. */
  sample: { label: string; department: string; entered: string; unit: string; stored_purchase_qty: number; stored_unit: string }[];
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const inr = (v: number, dp = 0) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dp });
const inr2 = (v: number) => inr(v, 2);
const EM = '—';

const packMeta = (r: SheetItem): PackMeta => ({
  unit: r.unit, purchase_unit: r.purchase_unit,
  pack_size: r.pack_size, case_size: r.case_size,
});

/**
 * Purchase-unit entry → RECIPE units, the stored basis. Goes through the shared
 * packFactor guard (pack_size > 1 AND recipe unit ≠ purchase unit); never a
 * local `* pack_size`, which mis-converts kg/kg materials like PICKLED GINGER.
 */
const toRecipeQty = (purchaseQty: number, m: PackMeta) =>
  Math.round((Number(purchaseQty) || 0) * packFactor(m) * 1000) / 1000;

const key = (deptId: string, materialId: string) => `${deptId}|${materialId}`;

const RATE_LABEL: Record<string, string> = {
  last_purchase: 'last purchase',
  average_cost: 'average cost',
  none: 'no basis',
};

const BLIND_NOTE = 'System stock and variance are admin-only (blind count).';

/**
 * Calendar arithmetic on an IST date-only string ("YYYY-MM-DD"). Built from
 * UTC parts on purpose: `new Date('2026-08-01')` + local-time getters lands on
 * 31 Jul for anyone west of Greenwich, which would quietly shift the history
 * window by a day. Falls back to the input when it is not a plain date.
 */
const shiftDays = (isoDate: string, days: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return isoDate;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000);
  if (isNaN(d.getTime())) return isoDate;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Content-Disposition → filename, so the saved file keeps the server's name. */
const filenameFrom = (cd: string | null, fallback: string): string => {
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : fallback;
};

/** Errors may arrive as objects or bare strings — render both, drop neither. */
const asIssues = (v: unknown): ImportIssue[] => {
  if (!Array.isArray(v)) return [];
  return v.map((e): ImportIssue => (typeof e === 'string'
    ? { line: 0, label: '', reason: e }
    : {
        line: Number((e as ImportIssue)?.line) || 0,
        label: String((e as ImportIssue)?.label ?? ''),
        reason: String((e as ImportIssue)?.reason ?? ''),
      }));
};

/** Narrowing accessors — the preview payload is shaped by another route and is
 *  read defensively, never trusted into the render as-is. */
const rec = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object') ? v as Record<string, unknown> : {};
const str = (v: unknown): string => (v == null ? '' : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const normalisePreview = (payload: unknown, fallbackDate: string): ImportPreview => {
  const j = rec(payload);
  return {
    date: str(j.date) || fallbackDate,
    departments: arr(j.departments).map(d => {
      const o = rec(d);
      return { id: str(o.id), name: str(o.name), matched: !!o.matched };
    }),
    total_rows: Number(j.total_rows) || 0,
    will_write: Number(j.will_write) || 0,
    skipped: Number(j.skipped) || 0,
    errors: asIssues(j.errors),
    sample: arr(j.sample).map(s => {
      const o = rec(s);
      return {
        label: str(o.label),
        department: str(o.department),
        entered: str(o.entered),
        unit: str(o.unit),
        stored_purchase_qty: Number(o.stored_purchase_qty) || 0,
        stored_unit: str(o.stored_unit),
      };
    }),
  };
};

/* ── Page ────────────────────────────────────────────────────────────────── */

export default function ClosingSheetPage() {
  const [date, setDate] = useState(todayIST);
  const [data, setData] = useState<Sheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /** Keyed dept|material → the count as typed, in PURCHASE units. */
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [onlyUncounted, setOnlyUncounted] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  /* Bulk file round-trip. `preview` is the gate on Apply — see the header. */
  const [tplBusy, setTplBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState<'' | 'preview' | 'apply'>('');
  const [importErr, setImportErr] = useState('');

  /* History window — last 30 days inclusive, in IST. */
  const [histFrom, setHistFrom] = useState(() => shiftDays(todayIST(), -29));
  const [histTo, setHistTo] = useState(todayIST);
  const [histDept, setHistDept] = useState('');
  const [histBusy, setHistBusy] = useState(false);
  const [histErr, setHistErr] = useState('');

  /* Load. Seeds the entry boxes from whatever is already recorded for the date,
   * converted to purchase units so the box reads in the same basis it posts. */
  const load = useCallback(async (d: string) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/closing-stock/dept-sheet?date=${encodeURIComponent(d)}`,
                              { credentials: 'same-origin' });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const sheet: Sheet = {
        date: json?.date || d,
        is_admin: !!json?.is_admin,
        scope: json?.scope === 'limited' ? 'limited' : 'all',
        departments: Array.isArray(json?.departments) ? json.departments : [],
        totals: json?.totals || { departments: 0, items: 0, counted: 0, uncounted: 0, value: 0, unpriced: 0 },
        generated_at: json?.generated_at || '',
      };
      const seed: Record<string, string> = {};
      for (const dept of sheet.departments) {
        for (const it of dept.items) {
          if (it.counted && it.physical_stock != null) {
            seed[key(dept.id, it.material_id)] = String(toPurchaseQty(it.physical_stock, packMeta(it)));
          }
        }
      }
      setData(sheet);
      setEntries(seed);
    } catch (e: unknown) {
      // Keep the sheet that is already on screen: blanking it on a flaky refresh
      // would throw away typed-but-unsaved counts.
      setError((e as Error)?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const isAdmin = !!data?.is_admin;
  const departments = useMemo(() => data?.departments ?? [], [data]);

  /**
   * Who may pull closing-stock HISTORY. NOT a new permission concept: the API
   * already answers this question with `scope`. It is 'all' exactly when
   * canSeeAllDeptStock() passed server-side — admin, manager, HOD (head chef)
   * or store manager — and 'limited' for a counter scoped to their own
   * department. That is precisely "store manager / HOD / admin", so the page
   * reuses the server's verdict instead of guessing a role client-side. The
   * history route enforces the same thing again; this only hides the control.
   */
  const canSeeHistory = isAdmin || data?.scope === 'all';

  /* Filtered view — what the user is actually looking at. */
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return departments.map(d => {
      const items = d.items.filter(it => {
        if (onlyUncounted && it.counted) return false;
        if (!needle) return true;
        return it.name.toLowerCase().includes(needle)
          || (it.sku || '').toLowerCase().includes(needle)
          || (it.category || '').toLowerCase().includes(needle);
      });
      return { dept: d, items };
    }).filter(x => !(hideEmpty && x.items.length === 0));
  }, [departments, q, onlyUncounted, hideEmpty]);

  /**
   * LIVE per-department figures over the filtered rows, including counts typed
   * but not yet saved. Rupees only — quantities are never summed across
   * materials anywhere on this page.
   */
  const deptCalc = useMemo(() => {
    const out = new Map<string, { counted: number; value: number; unpriced: number; dirty: number }>();
    for (const { dept, items } of view) {
      let counted = 0, value = 0, unpriced = 0, dirty = 0;
      for (const it of items) {
        const meta = packMeta(it);
        const raw = entries[key(dept.id, it.material_id)];
        const typed = raw !== undefined && raw !== '' && isFinite(Number(raw));
        const recipeQty = typed ? toRecipeQty(Number(raw), meta) : null;
        const changed = typed && (!it.counted || Math.abs(recipeQty! - (it.physical_stock ?? 0)) > 1e-6);
        if (changed) dirty++;
        if (!typed && !it.counted) continue;
        counted++;
        // No rate basis at all → the row carries no rupee figure. Counting a
        // confident 0 into a department total is exactly the lie to avoid.
        if (it.rate_per_purchase_unit == null) { unpriced++; continue; }
        if (changed) value += toPurchaseQty(recipeQty!, meta) * it.rate_per_purchase_unit;
        else value += it.value ?? 0;
      }
      out.set(dept.id, { counted, value: Math.round(value * 100) / 100, unpriced, dirty });
    }
    return out;
  }, [view, entries]);

  const sheetCalc = useMemo(() => {
    let items = 0, counted = 0, value = 0, unpriced = 0, dirty = 0;
    for (const { dept, items: rows } of view) {
      const c = deptCalc.get(dept.id);
      items += rows.length;
      counted += c?.counted ?? 0;
      value += c?.value ?? 0;
      unpriced += c?.unpriced ?? 0;
      dirty += c?.dirty ?? 0;
    }
    return { items, counted, value: Math.round(value * 100) / 100, unpriced, dirty };
  }, [view, deptCalc]);

  /* ── Save ──────────────────────────────────────────────────────────────── */

  const saveAll = async () => {
    if (!data) return;
    const payload: { department_id: string; material_id: string; physical_stock: number }[] = [];
    for (const dept of departments) {
      for (const it of dept.items) {
        const raw = entries[key(dept.id, it.material_id)];
        if (raw === undefined || raw === '' || !isFinite(Number(raw))) continue;
        const n = Number(raw);
        if (n < 0) continue;
        const recipeQty = toRecipeQty(n, packMeta(it));
        if (it.counted && Math.abs(recipeQty - (it.physical_stock ?? 0)) <= 1e-6) continue;
        payload.push({ department_id: dept.id, material_id: it.material_id, physical_stock: recipeQty });
      }
    }
    if (payload.length === 0) { setFlash({ tone: 'warn', text: 'Nothing new to save.' }); return; }
    setSaving(true); setFlash(null);
    try {
      const res = await api('/api/closing-stock/dept-sheet', {
        method: 'POST',
        body: { date, entries: payload },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const errs: string[] = Array.isArray(json?.errors) ? json.errors : [];
      setFlash({
        tone: errs.length ? 'warn' : 'ok',
        text: `Saved ${json?.saved ?? 0} count${json?.saved === 1 ? '' : 's'}`
          + (json?.pending ? ` · ${json.pending} sent for variance approval` : '')
          + (errs.length ? ` · ${errs.length} skipped: ${errs.slice(0, 2).join(' | ')}` : ''),
      });
      await load(date);
    } catch (e: unknown) {
      setFlash({ tone: 'warn', text: (e as Error)?.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  /* ── CSV ───────────────────────────────────────────────────────────────── */

  const exportCsv = () => {
    // Purchase columns lead (what the store reads); the recipe figures follow as
    // the exact stored truth the rupee column is derived from.
    const header = [
      'Department', 'Material', 'SKU', 'Category', 'Counted',
      'Purchase Unit', 'Counted Qty', 'Recipe Unit', 'Counted Qty (recipe)',
      'Rate (₹/purchase unit)', 'Rate Source', 'Rate at count time', 'Value (₹)',
      ...(isAdmin ? ['System Qty', 'System Qty (recipe)', 'Variance Qty', 'Variance Qty (recipe)', 'Variance (₹)'] : []),
    ];
    const body: (string | number)[][] = [];
    for (const { dept, items } of view) {
      for (const it of items) {
        const meta = packMeta(it);
        const phys = it.physical_stock;
        const sys = it.system_stock ?? null;
        const varq = it.variance ?? null;
        body.push([
          dept.name, it.name, it.sku, it.category, it.counted ? 'yes' : 'no',
          it.purchase_unit,
          phys == null ? '' : csvQty(toPurchaseQty(phys, meta)),
          it.unit,
          phys == null ? '' : csvQty(phys),
          it.rate_per_purchase_unit ?? '',
          RATE_LABEL[it.rate_source] || it.rate_source,
          it.counted ? (it.rate_at_count ? 'yes' : 'no') : '',
          it.value ?? '',
          ...(isAdmin ? [
            sys == null ? '' : csvQty(toPurchaseQty(sys, meta)),
            sys == null ? '' : csvQty(sys),
            varq == null ? '' : csvQty(toPurchaseQty(varq, meta)),
            varq == null ? '' : csvQty(varq),
            it.variance_value ?? '',
          ] : []),
        ]);
      }
      // Quantity subtotals are deliberately blank — see the tfoot comment.
      body.push([
        `${dept.name} — TOTAL`, '', '', '', String(deptCalc.get(dept.id)?.counted ?? 0),
        '', '', '', '', '', '', '', deptCalc.get(dept.id)?.value ?? 0,
        ...(isAdmin ? ['', '', '', '', dept.totals.variance_value ?? ''] : []),
      ]);
    }
    const csv = Papa.unparse([header, ...body]);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `department-closing-sheet-${date}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Bulk file round-trip ──────────────────────────────────────────────── */

  /**
   * Save a server-generated CSV. Every failure path throws so the caller can
   * SAY so: a 403 rendered as a downloaded file called "history.csv" that
   * actually contains {"error":…} is worse than no download at all — the user
   * only finds out when they open it. A JSON body counts as a failure even on
   * a 200, because these endpoints only ever answer JSON to complain.
   */
  const downloadCsv = async (url: string, fallbackName: string) => {
    const res = await fetch(url, { credentials: 'same-origin' });
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
    a.download = filenameFrom(res.headers.get('content-disposition'), fallbackName);
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(href);
  };

  const downloadBlankTemplate = async () => {
    setTplBusy(true); setFlash(null);
    try {
      await downloadCsv(
        `/api/closing-stock/dept-sheet/import?date=${encodeURIComponent(date)}&template=1`,
        `closing-stock-all-departments-${date}.csv`,
      );
      setFlash({
        tone: 'ok',
        text: `Blank template for ${date} downloaded — one row per item, one column per department. Fill in the counts and upload the same file back.`,
      });
    } catch (e: unknown) {
      setFlash({ tone: 'warn', text: `Template download failed — ${(e as Error)?.message || 'unknown error'}` });
    } finally {
      setTplBusy(false);
    }
  };

  /** A new file invalidates any preview on screen — Apply must never be able
   *  to fire the previous file's verdict at this file's contents. */
  const pickFile = async (f: File | null) => {
    setFile(f); setPreview(null); setCsvText(''); setImportErr('');
    if (!f) return;
    try {
      setCsvText(await f.text());
    } catch (e: unknown) {
      setImportErr(`Could not read ${f.name} — ${(e as Error)?.message || 'unreadable file'}`);
    }
  };

  const closeUpload = () => {
    if (importBusy) return;                       // never abandon an in-flight apply
    setUploadOpen(false); setFile(null); setCsvText(''); setPreview(null); setImportErr('');
  };

  const runImport = async (mode: 'preview' | 'apply') => {
    if (!csvText.trim()) { setImportErr('Choose a filled-in CSV file first.'); return; }
    if (mode === 'apply' && !preview) { setImportErr('Check the file before applying.'); return; }
    setImportBusy(mode); setImportErr('');
    try {
      const res = await api('/api/closing-stock/dept-sheet/import', {
        method: 'POST',
        body: { date, csv: csvText, mode },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      if (mode === 'preview') { setPreview(normalisePreview(json, date)); return; }

      const errs = asIssues(json?.errors);
      const saved = Number(json?.saved) || 0;
      const pending = Number(json?.pending) || 0;

      // APPLY IS ALL-OR-NOTHING. The route refuses the whole file if ANY row has
      // an error and answers { refused:true, saved:0, errors }. Closing the modal
      // and calling that "N rows skipped" was the worst possible reading: it
      // implies the good rows landed when NOTHING was written, and it threw away
      // the very list that says which cells to fix. Keep the modal open, keep the
      // errors on screen, and say plainly that nothing was saved.
      if (json?.refused || (saved === 0 && errs.length)) {
        setPreview(prev => (prev ? { ...prev, errors: errs.length ? errs : prev.errors } : prev));
        setImportErr(
          `Nothing was saved. This file is applied all-or-nothing, and ${errs.length.toLocaleString('en-IN')} `
          + `row${errs.length === 1 ? '' : 's'} could not be read. Fix ${errs.length === 1 ? 'it' : 'them'} `
          + `in the sheet and upload again — the list below says which.`,
        );
        return;
      }

      setUploadOpen(false); setFile(null); setCsvText(''); setPreview(null);
      setFlash({
        tone: saved === 0 ? 'warn' : 'ok',
        text: `Uploaded for ${date} — saved ${saved.toLocaleString('en-IN')} count${saved === 1 ? '' : 's'}`
          + (pending ? ` · ${pending.toLocaleString('en-IN')} sent for variance approval` : ''),
      });
      await load(date);
    } catch (e: unknown) {
      setImportErr((e as Error)?.message
        || (mode === 'preview' ? 'Could not check the file' : 'Upload failed — nothing was saved'));
    } finally {
      setImportBusy('');
    }
  };

  const downloadHistory = async () => {
    if (!histFrom || !histTo) { setHistErr('Pick both a From and a To date.'); return; }
    if (histFrom > histTo) { setHistErr('“From” is after “To” — swap the dates.'); return; }
    setHistBusy(true); setHistErr('');
    try {
      const qs = new URLSearchParams({ from: histFrom, to: histTo, format: 'csv' });
      if (histDept) qs.set('department_id', histDept);
      await downloadCsv(`/api/closing-stock/history?${qs.toString()}`,
                        `closing-stock-history-${histFrom}_${histTo}.csv`);
    } catch (e: unknown) {
      setHistErr((e as Error)?.message || 'History download failed');
    } finally {
      setHistBusy(false);
    }
  };

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (loading && !data) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-sm text-[#6B5744]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading department closing sheet…
      </div>
    );
  }

  if (error && !data) {
    const denied = /limited|authoriz/i.test(error);
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Department Closing Sheet
        </h1>
        <div className={`rounded-lg p-4 text-sm flex items-center gap-2 ${
          denied ? 'bg-amber-50 border border-amber-200 text-amber-900'
                 : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <AlertCircle className="w-4 h-4 shrink-0" /> {denied ? `🔒 ${error}` : error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-4 pb-24">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[240px]">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-[#af4408]" /> Department Closing Sheet
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Every active department on one sheet — count each item where it sits.
            {data?.generated_at && <span className="text-[#B9A896]"> · as of {fmtIST(data.generated_at)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <CalendarDays className="w-4 h-4 text-[#8B7355]" />
          <input type="date" value={date} onChange={e => setDate(e.target.value || todayIST())}
                 className="px-2.5 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E]" />
        </div>
        {/* This exports what has been COUNTED. The blank sheet to fill in lives
            in the bulk strip below — the title spells the difference out. */}
        <button onClick={exportCsv} disabled={sheetCalc.items === 0}
                title="Export the sheet as it stands now, with the counts already recorded. For a BLANK sheet to fill in, use “Download blank template” below."
                className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          <Download className="w-4 h-4" /> Export CSV
        </button>
        <button onClick={saveAll} disabled={saving || sheetCalc.dirty === 0}
                className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save {sheetCalc.dirty > 0 ? `${sheetCalc.dirty} count${sheetCalc.dirty === 1 ? '' : 's'}` : 'counts'}
        </button>
      </div>

      {flash && (
        <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${
          flash.tone === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                              : 'bg-amber-50 border border-amber-200 text-amber-900'}`}>
          {flash.tone === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {flash.text}
        </div>
      )}
      {error && data && (
        <div className="rounded-lg p-3 text-sm flex items-center gap-2 bg-red-50 border border-red-200 text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}
      {data?.scope === 'limited' && (
        <div className="rounded-lg p-3 text-xs flex items-center gap-2 bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
          Showing only the departments you are assigned to or have been granted.
        </div>
      )}

      {/* ── Bulk strip: blank template → upload → history ──────────────────
          Its own card, never beside "Export CSV" — see the file header. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 space-y-2.5">
        <div className="text-[11px] font-medium text-[#8B7355]">
          Bulk closing stock — every kitchen department in ONE file
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={downloadBlankTemplate} disabled={tplBusy}
                  title="A BLANK sheet: one row per item, one column per department. Fill in the counts and upload it back."
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
            {tplBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
            Download blank template
          </button>
          <button onClick={() => { setUploadOpen(true); setImportErr(''); }}
                  title="Upload the filled-in template. You always see a preview before anything is written."
                  className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] rounded-lg text-sm font-medium flex items-center gap-1.5">
            <Upload className="w-4 h-4" /> Upload counts
          </button>
          <span className="text-[11px] text-[#8B7355] leading-tight max-w-[420px]">
            Counts land on <span className="font-semibold text-[#2D1B0E]">{date}</span> — change the date above first if that is wrong.
            The <span className="font-mono">TOTAL Physical count</span>{' '}
            column is ignored; each department&apos;s own column is what gets written.
          </span>
        </div>

        {canSeeHistory && (
          <div className="pt-2.5 border-t border-[#F0E4D6] flex flex-wrap items-end gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#8B7355] mr-1">
              <History className="w-3.5 h-3.5" /> Closing stock history
            </div>
            <label className="text-[10px] text-[#8B7355]">
              <div className="mb-0.5">From</div>
              <input type="date" value={histFrom} max={histTo || undefined}
                     onChange={e => { setHistFrom(e.target.value); setHistErr(''); }}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
            </label>
            <label className="text-[10px] text-[#8B7355]">
              <div className="mb-0.5">To</div>
              <input type="date" value={histTo} min={histFrom || undefined}
                     onChange={e => { setHistTo(e.target.value); setHistErr(''); }}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E]" />
            </label>
            <label className="text-[10px] text-[#8B7355]">
              <div className="mb-0.5">Department</div>
              <select value={histDept} onChange={e => { setHistDept(e.target.value); setHistErr(''); }}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white text-[#2D1B0E] max-w-[200px]">
                <option value="">All departments</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <button onClick={downloadHistory} disabled={histBusy}
                    className="px-3 py-1.5 bg-white border border-[#8B7355] text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 rounded-lg text-xs font-medium flex items-center gap-1.5">
              {histBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Download history (CSV)
            </button>
            <button type="button"
                    onClick={() => { setHistFrom(shiftDays(todayIST(), -29)); setHistTo(todayIST()); setHistDept(''); setHistErr(''); }}
                    className="text-[11px] text-[#af4408] hover:underline">Last 30 days</button>
            {histErr && (
              <span className="w-full text-[11px] text-red-700 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {histErr}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Sheet summary */}
      <div className={`grid grid-cols-2 md:grid-cols-3 gap-2.5 ${isAdmin ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        <SummaryCard icon={<Building2 className="w-4 h-4" />} label="Departments"
                     value={view.length.toLocaleString('en-IN')} />
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Items counted"
                     value={`${sheetCalc.counted.toLocaleString('en-IN')} / ${sheetCalc.items.toLocaleString('en-IN')}`} />
        <SummaryCard icon={<PackageX className="w-4 h-4" />} label="Uncounted"
                     value={Math.max(0, sheetCalc.items - sheetCalc.counted).toLocaleString('en-IN')}
                     tone={sheetCalc.items - sheetCalc.counted > 0 ? 'warn' : 'muted'} />
        <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Sheet value"
                     value={inr(sheetCalc.value)}
                     note={sheetCalc.unpriced > 0 ? `${sheetCalc.unpriced} item${sheetCalc.unpriced === 1 ? '' : 's'} have no rate basis — excluded` : undefined} />
        {isAdmin && (
          <SummaryCard icon={<IndianRupee className="w-4 h-4" />} label="Variance (admin)"
                       value={inr(data?.totals.variance_value ?? 0)}
                       tone={(data?.totals.variance_value ?? 0) < 0 ? 'warn' : 'muted'} />
        )}
      </div>

      {/* Department strip — EVERY department in scope, including empty ones. A
          department created later (e.g. Cold Room) shows up here on next load. */}
      <div className="bg-white border border-[#E8D5C4] rounded-lg p-2.5">
        <div className="text-[11px] font-medium text-[#8B7355] mb-1.5">
          Departments on this sheet ({departments.length}) — read live from the Departments list
        </div>
        <div className="flex flex-wrap gap-1.5">
          {departments.map(d => {
            const c = deptCalc.get(d.id);
            const total = d.totals.items;
            const done = total > 0 && (c?.counted ?? 0) >= total;
            return (
              <button key={d.id}
                      onClick={() => {
                        setCollapsed(p => ({ ...p, [d.id]: false }));
                        sectionRefs.current[d.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className={`px-2 py-1 rounded-full text-[11px] border transition-colors ${
                        total === 0 ? 'bg-[#FDFBF8] border-[#EFE3D6] text-[#B9A896]'
                        : done ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : (c?.counted ?? 0) > 0 ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0]'}`}>
                {d.name}
                <span className="opacity-70"> · {total === 0 ? 'no items yet' : `${c?.counted ?? 0}/${total}`}</span>
                {!d.is_active && <span className="ml-1 text-[9px] uppercase text-red-700">inactive</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter material, SKU or category…"
                 className="w-full pl-8 pr-8 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-white" />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#2D1B0E]">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <span className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <Toggle size="sm" checked={onlyUncounted} onChange={setOnlyUncounted} label="Only uncounted" />
          Only uncounted
        </span>
        <span className="flex items-center gap-1.5 text-xs text-[#6B5744]">
          <Toggle size="sm" checked={hideEmpty} onChange={setHideEmpty} label="Hide empty departments" />
          Hide empty departments
        </span>
        <button onClick={() => setCollapsed(Object.fromEntries(departments.map(d => [d.id, true])))}
                className="text-xs text-[#af4408] hover:underline">Collapse all</button>
        <button onClick={() => setCollapsed({})} className="text-xs text-[#af4408] hover:underline">Expand all</button>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[#8B7355]" />}
        {!isAdmin && <span className="text-[11px] text-[#B9A896]">{BLIND_NOTE}</span>}
      </div>

      {/* Sections — one per department */}
      {view.length === 0 ? (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          <PackageX className="w-6 h-6 mx-auto mb-2 text-[#B9A896]" />
          Nothing to show. {q ? 'No material matches your filter.' : 'No departments are in scope for you.'}
        </div>
      ) : view.map(({ dept, items }) => {
        const c = deptCalc.get(dept.id);
        const open = !collapsed[dept.id];
        return (
          <div key={dept.id}
               ref={el => { sectionRefs.current[dept.id] = el; }}
               className="border border-[#E8D5C4] rounded-lg bg-white scroll-mt-4">
            {/* Department header */}
            <button onClick={() => setCollapsed(p => ({ ...p, [dept.id]: !open }))}
                    className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 bg-[#FFF1E3] rounded-t-lg text-left">
              {open ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
              <div className="flex-1 min-w-[160px]">
                <div className="text-sm font-semibold text-[#2D1B0E]">
                  {dept.name}
                  {dept.parent_name && <span className="text-[#B9A896] font-normal"> · {dept.parent_name}</span>}
                  {!dept.is_active && <span className="ml-1.5 text-[9px] uppercase px-1 rounded bg-red-100 text-red-700">inactive</span>}
                </div>
                <div className="text-[11px] text-[#8B7355]">
                  {(c?.counted ?? 0).toLocaleString('en-IN')} / {items.length.toLocaleString('en-IN')} counted
                  {/* A filtered section must never read like an empty department:
                      "0 / 0 counted" on Akan Main Kitchen (249 items) is a lie. */}
                  {items.length !== dept.totals.items && (
                    <span className="text-[#B9A896]"> · filtered from {dept.totals.items.toLocaleString('en-IN')}</span>
                  )}
                  {(c?.dirty ?? 0) > 0 && <span className="text-amber-700"> · {c?.dirty} unsaved</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Department value</div>
                <div className="text-sm font-semibold text-[#af4408] tabular-nums">{inr2(c?.value ?? 0)}</div>
              </div>
            </button>

            {open && (items.length === 0 ? (
              // Two different nothings, and conflating them misleads: a department
              // filtered down to zero rows still has its full item set.
              dept.totals.items > 0 ? (
                <div className="p-5 text-center text-xs text-[#8B7355]">
                  {`No item here matches the current filter — ${dept.totals.items.toLocaleString('en-IN')} item${dept.totals.items === 1 ? '' : 's'} on this department's sheet.`}
                </div>
              ) : (
                <div className="p-5 text-center text-xs text-[#8B7355]">
                  No items on this department&apos;s sheet yet — nothing has been issued to it or counted in it.
                  <div className="mt-1 text-[#B9A896]">
                    Issue stock on{' '}
                    <Link href="/store-requisitions" className="text-[#af4408] hover:underline">Issue Requisitions</Link>
                    {' '}and it will appear here.
                  </div>
                </div>
              )
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#FFF8F0] text-[#6B5744]">
                      <th className="text-left font-semibold px-3 py-2 min-w-[190px]">Material</th>
                      <th className="text-left font-semibold px-3 py-2 min-w-[90px]">Category</th>
                      {/* Blind count: rendered only when the API says admin. For
                          everyone else these keys never arrive at all. */}
                      {isAdmin && <th className="text-right font-semibold px-3 py-2 min-w-[100px]">System <span className="font-normal text-[9px] text-[#B9A896]">(central)</span></th>}
                      <th className="text-left font-semibold px-3 py-2 min-w-[170px]">Physical count</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[110px]">Rate</th>
                      <th className="text-right font-semibold px-3 py-2 min-w-[90px] bg-[#FBE7D3]">Value</th>
                      {isAdmin && <th className="text-right font-semibold px-3 py-2 min-w-[100px]">Variance</th>}
                      <th className="text-left font-semibold px-3 py-2 min-w-[80px]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => {
                      const meta = packMeta(it);
                      const pf = packFactor(meta);
                      const k = key(dept.id, it.material_id);
                      const raw = entries[k] ?? '';
                      const typed = raw !== '' && isFinite(Number(raw));
                      const pv = typed ? Number(raw) : 0;
                      const recipeQty = typed ? toRecipeQty(pv, meta) : null;
                      const changed = typed && (!it.counted || Math.abs(recipeQty! - (it.physical_stock ?? 0)) > 1e-6);
                      const rate = it.rate_per_purchase_unit;
                      const liveValue = rate == null || !typed
                        ? null
                        : Math.round(toPurchaseQty(recipeQty!, meta) * rate * 100) / 100;
                      const shownValue = changed ? liveValue : (it.counted ? it.value : liveValue);
                      return (
                        <tr key={it.material_id}
                            className={`border-t border-[#F0E4D6] ${it.counted ? '' : 'bg-[#FDFBF8]'} hover:bg-[#FFF8F0]`}>
                          <td className="px-3 py-1.5">
                            <div className="font-medium text-[#2D1B0E] leading-tight">{it.name}</div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-mono text-[#B9A896]">{it.sku || '·'}</span>
                              {!it.is_active && <span className="text-[9px] px-1 rounded bg-red-100 text-red-700">inactive</span>}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-[10px] text-[#6B5744]">{it.category || EM}</td>

                          {isAdmin && (
                            <td className="px-3 py-1.5 text-right tabular-nums text-[#6B5744]">
                              {it.system_stock == null
                                ? <span className="text-[#B9A896]">{EM}</span>
                                : <Qty d={dualQty(it.system_stock, meta)} meta={meta} />}
                            </td>
                          )}

                          {/* Entry LEADS in the purchase unit — the unit the
                              counter is physically holding. The recipe figure
                              below is the number that is actually posted. */}
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1">
                              <input type="number" step="any" min={0} value={raw}
                                     onChange={e => setEntries(p => ({ ...p, [k]: e.target.value }))}
                                     placeholder="0"
                                     className="w-24 px-2 py-1 border border-[#D4B896] rounded text-xs text-right font-mono bg-white focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                              <span className="text-[10px] text-[#8B7355]">{it.purchase_unit}</span>
                            </div>
                            {pf > 1 && typed && (
                              <div className="text-[9px] text-[#B8A590]">= {fmtQtyNum(recipeQty ?? 0)} {it.unit}</div>
                            )}
                          </td>

                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {rate == null ? (
                              <span className="text-[#B9A896]" title="No purchase and no average cost — this item cannot be valued yet.">{EM}</span>
                            ) : (
                              <>
                                <span className="text-[#2D1B0E]">{inr2(rate)}</span>
                                <span className="text-[9px] text-[#B9A896]"> / {it.purchase_unit}</span>
                                <div className="text-[9px] text-[#B8A590]">
                                  {RATE_LABEL[it.rate_source] || it.rate_source}
                                  {it.counted && !it.rate_at_count && <span className="text-amber-700"> · today&apos;s rate</span>}
                                  {it.rate_as_of && <span> · {it.rate_as_of}</span>}
                                </div>
                              </>
                            )}
                          </td>

                          <td className="px-3 py-1.5 text-right tabular-nums bg-[#FEF6EE] text-[#2D1B0E]">
                            {shownValue == null ? <span className="text-[#B9A896]">{EM}</span> : inr2(shownValue)}
                          </td>

                          {isAdmin && (
                            <td className={`px-3 py-1.5 text-right tabular-nums ${
                              it.variance == null ? '' : it.variance < 0 ? 'text-red-700' : it.variance > 0 ? 'text-emerald-700' : 'text-[#6B5744]'}`}>
                              {it.variance == null
                                ? <span className="text-[#B9A896]" title="Recorded once the count is saved.">{EM}</span>
                                : <Qty d={dualQty(it.variance, meta)} meta={meta} />}
                            </td>
                          )}

                          <td className="px-3 py-1.5">
                            {changed ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">↻ unsaved</span>
                            ) : it.counted ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700"
                                    title={it.recorded_by ? `By ${it.recorded_by}` : undefined}>✓ counted</span>
                            ) : (
                              <span className="text-[10px] text-[#B9A896]">pending</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    {/* Quantity subtotals stay em-dashed on purpose: adding
                        BTL + kg + pcs across materials is not a number in any
                        basis. Rupees are the only valid cross-material total. */}
                    <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF1E3] font-semibold text-[#2D1B0E]">
                      <td className="px-3 py-2">{dept.name} — total</td>
                      <td className="px-3 py-2 text-[10px] font-normal text-[#8B7355]">
                        {(c?.counted ?? 0)} of {items.length} counted
                        {(c?.unpriced ?? 0) > 0 && <div className="text-[9px] text-amber-700">{c?.unpriced} unpriced</div>}
                      </td>
                      {isAdmin && <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>}
                      <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
                      <td className="px-3 py-2 text-right text-[#B9A896] font-normal">{EM}</td>
                      <td className="px-3 py-2 text-right tabular-nums bg-[#FBE7D3]">{inr2(c?.value ?? 0)}</td>
                      {isAdmin && (
                        <td className="px-3 py-2 text-right tabular-nums text-[#6B5744]">
                          {inr2(dept.totals.variance_value ?? 0)}
                        </td>
                      )}
                      <td className="px-3 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ))}
          </div>
        );
      })}

      {/* Whole-sheet total */}
      {view.length > 0 && (
        <div className="sticky bottom-3 z-20 border border-[#af4408]/40 rounded-lg bg-white shadow-lg px-3 py-2.5 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[180px]">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Whole sheet</div>
            <div className="text-sm font-semibold text-[#2D1B0E]">
              {view.length} department{view.length === 1 ? '' : 's'} ·{' '}
              {sheetCalc.counted.toLocaleString('en-IN')} / {sheetCalc.items.toLocaleString('en-IN')} counted
              {/* Say so when the figures describe a filtered subset, not the sheet. */}
              {(q.trim() !== '' || onlyUncounted) && (
                <span className="font-normal text-[#B9A896]"> · filtered view</span>
              )}
            </div>
          </div>
          {/* Quantities: em-dash, always. */}
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total quantity</div>
            <div className="text-sm text-[#B9A896]" title="Quantities cannot be added across different materials.">{EM}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total value</div>
            <div className="text-lg font-bold text-[#af4408] tabular-nums">{inr2(sheetCalc.value)}</div>
          </div>
          <Link href={`/inventory/closing-overview?date=${encodeURIComponent(date)}`}
                className="px-2.5 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-xs font-medium flex items-center gap-1">
            Overview board <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
          <button onClick={saveAll} disabled={saving || sheetCalc.dirty === 0}
                  className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      )}

      {/* ── Upload counts: preview, THEN apply ───────────────────────────── */}
      {uploadOpen && (
        <ModalShell
          wide
          title="Upload closing counts — all departments"
          icon={<Upload className="w-4 h-4 text-[#af4408]" />}
          onClose={closeUpload}
          footer={
            <>
              <span className="mr-auto text-[10px] text-[#8B7355]">
                Recording for <span className="font-semibold text-[#2D1B0E]">{date}</span>
              </span>
              <button onClick={closeUpload} disabled={!!importBusy}
                      className="px-3 py-2 border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-40 rounded-lg text-sm">
                Cancel
              </button>
              <button onClick={() => runImport('preview')} disabled={!csvText || !!importBusy}
                      className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
                {importBusy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                {preview ? 'Re-check file' : 'Check file'}
              </button>
              {/* Dead until a preview for THIS file exists — the whole point.
                  ALSO dead while the preview reports ANY error: the route applies
                  all-or-nothing, so offering Apply there is offering a button whose
                  only possible outcome is a refusal. Better to say why up front than
                  to let the manager click it and read a failure as a partial save. */}
              <button onClick={() => runImport('apply')}
                      disabled={!preview || preview.will_write === 0 || preview.date !== date
                                || preview.errors.length > 0 || !!importBusy}
                      title={!preview ? 'Check the file first'
                        : preview.errors.length > 0
                          ? `Fix the ${preview.errors.length} problem row${preview.errors.length === 1 ? '' : 's'} first — the file is applied all-or-nothing`
                        : preview.will_write === 0 ? 'This file has no counts to write'
                        : preview.date !== date ? `The preview was checked for ${preview.date}, not ${date}`
                        : undefined}
                      className="px-3 py-2 bg-[#af4408] text-white hover:bg-[#903905] disabled:opacity-40 rounded-lg text-sm font-medium flex items-center gap-1.5">
                {importBusy === 'apply' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Apply{preview && preview.will_write > 0 ? ` ${preview.will_write.toLocaleString('en-IN')} count${preview.will_write === 1 ? '' : 's'}` : ''}
              </button>
            </>
          }
        >
          <div className="rounded-lg bg-[#FFF8F0] border border-[#E8D5C4] p-2.5 text-[11px] text-[#6B5744] leading-relaxed">
            One row per item, one column per department — the same file the
            <span className="font-medium text-[#2D1B0E]"> Download blank template </span>
            button produces. Counts are read in the unit each row declares and converted
            by the server before storing. The <span className="font-mono">TOTAL Physical count</span>
            {' '}column is ignored. Nothing is written until you press <b>Apply</b>.
          </div>

          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Filled-in CSV</label>
            <input type="file" accept=".csv,text/csv" disabled={!!importBusy}
                   onChange={e => pickFile(e.target.files?.[0] ?? null)}
                   className="block w-full text-xs text-[#6B5744] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-[#af4408] file:bg-white file:text-[#af4408] file:text-xs file:font-medium hover:file:bg-[#af4408]/10" />
            {file && (
              <div className="mt-1 text-[11px] text-[#8B7355]">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
                {csvText ? '' : ' · reading…'}
              </div>
            )}
          </div>

          {importErr && (
            <div className="rounded-lg p-2.5 text-xs flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" /> <span>{importErr}</span>
            </div>
          )}

          {!preview ? (
            <div className="rounded-lg border border-dashed border-[#E8D5C4] p-4 text-center text-xs text-[#8B7355]">
              Press <span className="font-medium text-[#2D1B0E]">Check file</span>{' '}
              to see which department each column maps to and exactly what would be written.
              <div className="text-[11px] text-[#B9A896] mt-1">Apply stays disabled until then.</div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* The server echoes the date it read the file for. If that is not
                  the date on screen, the counts would land on the wrong day —
                  say so rather than let the footer's promise stand. */}
              {preview.date !== date && (
                <div className="rounded-lg p-2.5 text-xs flex items-start gap-2 bg-red-50 border border-red-200 text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                  This file was checked for <b>{preview.date}</b>, not <b>{date}</b>. Close this,
                  set the date at the top of the page, and check the file again.
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <PreviewStat label="Rows in file" value={preview.total_rows} />
                <PreviewStat label="Will be written" value={preview.will_write}
                             tone={preview.will_write > 0 ? 'ok' : 'warn'} />
                <PreviewStat label="Skipped" value={preview.skipped}
                             tone={preview.skipped > 0 ? 'warn' : 'muted'} />
              </div>

              {/* Column → department mapping. An unmatched column is the exact
                  failure that costs a recount, so it is called out in red. */}
              <div>
                <div className="text-[11px] font-medium text-[#8B7355] mb-1">
                  Department columns found ({preview.departments.length})
                </div>
                {preview.departments.length === 0 ? (
                  <div className="text-[11px] text-red-700 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    No “&lt;Department&gt; Physical count” column was found in this file.
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.departments.map((d, i) => (
                        <span key={`${d.id || d.name}-${i}`}
                              className={`px-2 py-1 rounded-full text-[11px] border ${
                                d.matched ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                          : 'bg-red-50 border-red-200 text-red-700'}`}>
                          {d.matched ? '✓' : '✕'} {d.name || '(unnamed column)'}
                        </span>
                      ))}
                    </div>
                    {preview.departments.some(d => !d.matched) && (
                      <div className="mt-1.5 text-[11px] text-red-700 flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                        <span>
                          {preview.departments.filter(d => !d.matched).length} column(s) do not match a department
                          you can write to — those counts will NOT be saved. Fix the column heading to match the
                          department name exactly, or download a fresh blank template.
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Entered → stored. The one place a unit mistake shows up before
                  it is a thousand rows of wrong stock. */}
              {preview.sample.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-[#8B7355] mb-1">
                    Sample — what will be stored ({preview.sample.length} of {preview.will_write.toLocaleString('en-IN')})
                  </div>
                  <div className="border border-[#E8D5C4] rounded-lg overflow-x-auto">
                    <table className="w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-[#FFF8F0] text-[#6B5744]">
                          <th className="text-left font-semibold px-2 py-1.5">Item</th>
                          <th className="text-left font-semibold px-2 py-1.5">Department</th>
                          <th className="text-right font-semibold px-2 py-1.5">Entered</th>
                          <th className="text-right font-semibold px-2 py-1.5">Stored (recipe units)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sample.map((s, i) => (
                          <tr key={`${s.label}-${s.department}-${i}`} className="border-t border-[#F0E4D6]">
                            <td className="px-2 py-1 text-[#2D1B0E]">{s.label || '·'}</td>
                            <td className="px-2 py-1 text-[#6B5744]">{s.department || '·'}</td>
                            <td className="px-2 py-1 text-right tabular-nums text-[#2D1B0E]">
                              {s.entered || '·'} <span className="text-[#B9A896]">{s.unit}</span>
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums text-[#af4408]">
                              {/* unit-lock: already PURCHASE units — the route converts the
                                  stored recipe figure back via toPurchaseQty before sending it,
                                  and stored_unit is the material's purchase_unit. The checker
                                  cannot see that through the API boundary. */}
                              {fmtQtyNum(s.stored_purchase_qty)} <span className="text-[#B9A896]">{s.stored_unit}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* EVERY error, with its line number. Scroll — never truncate:
                  a hidden bad row is a count nobody knows is missing. */}
              {preview.errors.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-amber-800 mb-1 flex items-center gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {preview.errors.length.toLocaleString('en-IN')} row{preview.errors.length === 1 ? '' : 's'} block this upload — nothing is saved until {preview.errors.length === 1 ? 'it is' : 'they are'} fixed
                  </div>
                  <div className="border border-amber-200 rounded-lg bg-amber-50 max-h-64 overflow-y-auto divide-y divide-amber-100">
                    {preview.errors.map((e, i) => (
                      <div key={`${e.line}-${i}`} className="px-2.5 py-1.5 text-[11px] text-amber-900 flex gap-2">
                        <span className="font-mono text-amber-700 shrink-0 w-16">
                          {e.line > 0 ? `line ${e.line}` : '—'}
                        </span>
                        <span>
                          {e.label && <span className="font-medium">{e.label}: </span>}
                          {e.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preview.will_write === 0 && (
                <div className="rounded-lg p-2.5 text-xs flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                  Nothing in this file would be written. Check the department column headings and that the
                  counts are filled in — a blank cell means “not counted”, which is skipped on purpose.
                </div>
              )}
            </div>
          )}
        </ModalShell>
      )}
    </div>
  );
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function ModalShell({ title, icon, onClose, children, footer, wide }: {
  title: string; icon: React.ReactNode; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto"
         onClick={onClose}>
      <div className={`bg-white rounded-xl border border-[#E8D5C4] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} shadow-xl flex flex-col overflow-hidden`}
           style={{ maxHeight: 'calc(100vh - 1.5rem)' }} onClick={e => e.stopPropagation()}>
        <div className="px-4 sm:px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <div className="font-semibold text-[#2D1B0E] flex items-center gap-2 text-sm">{icon} {title}</div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5 space-y-3">{children}</div>
        {footer && (
          <div className="px-4 sm:px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center justify-end gap-2 shrink-0 bg-white">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewStat({ label, value, tone = 'muted' }: {
  label: string; value: number; tone?: 'muted' | 'ok' | 'warn';
}) {
  const cls = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-[#2D1B0E]';
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{label}</div>
      <div className={`text-base font-bold tabular-nums ${cls}`}>{value.toLocaleString('en-IN')}</div>
    </div>
  );
}

function SummaryCard({ icon, label, value, tone = 'muted', note }: {
  icon: React.ReactNode; label: string; value: string; tone?: 'muted' | 'warn'; note?: string;
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${tone === 'warn' ? 'text-amber-700' : 'text-[#8B7355]'}`}>
        {icon} {label}
      </div>
      <div className="mt-1 text-lg font-bold text-[#2D1B0E] tabular-nums">{value}</div>
      {note && <div className="text-[9px] text-amber-700 leading-tight mt-0.5">{note}</div>}
    </div>
  );
}
