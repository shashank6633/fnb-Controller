'use client';

/**
 * Admin → Database (READ-ONLY).
 *
 * The owner wanted to inspect his own data without dropping to sqlite3 or DB
 * Browser. So: browse first, SQL second. The left rail lists every table in the
 * live database grouped the way the business thinks about it; clicking one shows
 * its schema and a paginated, sortable grid. The SQL console is collapsed by
 * default because most of the time he wants to LOOK AT A TABLE, not write SQL.
 *
 * WHAT THIS FILE IS NOT: it is not a security boundary. Every control that
 * matters lives on the server —
 *   · a separate better-sqlite3 handle opened { readonly, fileMustExist } in a
 *     separate short-lived process (so SQLite itself refuses writes),
 *   · requireRole('admin') at the top of every handler,
 *   · guardSql() (one statement, SELECT/WITH/EXPLAIN only, no write verb at any
 *     depth, no PRAGMA/ATTACH/DDL),
 *   · a 1000-row cap and a SIGKILL deadline,
 *   · SECRET_KEY_RE masking, and an audit_events row per query.
 * If you are here to "tighten security", this is the wrong file — the client can
 * always be bypassed with curl. What this file MUST keep doing is (a) render the
 * forbidden panel instead of an empty grid when the server says 401/403, so the
 * page never depends on the nav link being hidden, and (b) never invent SQL for
 * browse/saved modes — the server composes those, the client sends identifiers
 * and ids only.
 *
 * API (all admin-gated, CSRF on POST via the /api/admin prefix):
 *   GET  /api/admin/database?view=catalog
 *   GET  /api/admin/database?view=schema&table=<name>
 *   GET  /api/admin/database?view=saved
 *   POST /api/admin/database   { mode: 'browse' | 'saved' | 'sql', format: 'json' | 'csv' }
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  Database, Table2, Search, Play, Download, ShieldAlert, KeyRound, Loader2,
  ChevronRight, ChevronDown, ChevronLeft, AlertTriangle, Lock, RefreshCw,
  ArrowUp, ArrowDown, Info,
} from 'lucide-react';

/* ─────────────────────────── wire types ─────────────────────────── */

interface CatalogTable {
  name: string; group: string; rows: number; columns: number;
  pk: string[]; fk_count: number;
}
interface Catalog {
  table_count: number; groups: string[]; tables: CatalogTable[]; generated_at: string;
}
interface SchemaColumn {
  cid: number; name: string; type: string; notnull: number;
  dflt_value: string | null; pk: number; unit_basis: string | null;
}
interface ForeignKey {
  // `to` is NULLABLE and that is SQLite, not sloppiness: a clause written
  // `REFERENCES vendors` with no column implicitly targets the parent's primary
  // key, and pragma_foreign_key_list reports `to` as NULL for it. No table in
  // this database declares one today (measured: 0 rows), so typing this `string`
  // was a lie that happened to be safe — until someone adds such an FK and the
  // schema strip renders "→ vendors." with a dangling dot on the one badge whose
  // job is to state a relationship precisely.
  from: string; table: string; to: string | null; on_update?: string; on_delete?: string;
}
interface TableSchema {
  name: string; row_count: number; columns: SchemaColumn[];
  foreign_keys: ForeignKey[];
  indexes: { name: string; unique: number; columns: string[] }[];
}
interface SavedQuery { id: string; title: string; explains: string; sql: string }
interface ResultColumn { name: string; type?: string }
interface QueryResult {
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  masked: { row: number; column: string }[];
  sql_executed: string;
  total_rows?: number;
  page?: number;
  page_size?: number;
}
interface ApiError { code: string; error: string }

type SortDir = 'asc' | 'desc';
type RequestBody =
  | { mode: 'browse'; table: string; sort_column?: string; sort_dir?: SortDir; page: number; page_size: number }
  | { mode: 'saved'; id: string }
  | { mode: 'sql'; sql: string };

const PAGE_SIZE = 100;

/**
 * Column names whose unit basis cannot be resolved from a free-form SQL result —
 * the same name means different things in different tables (purchases.quantity is
 * PURCHASE units, raw_materials.current_stock is RECIPE units). In browse mode the
 * server tells us the basis per column; in SQL mode we do not know the source
 * table, so we say so rather than guessing. Never silently print a bare number
 * that someone could mistake for the app's display value.
 */
const AMBIGUOUS_QTY_COLUMNS = new Set([
  'quantity', 'qty', 'current_stock', 'closing_stock', 'opening_stock', 'pack_size',
  'unit_price', 'rate', 'average_price', 'last_purchase_price',
  'quantity_requested', 'quantity_issued', 'chef_approved_qty',
]);

const GROUP_ORDER = ['Purchasing', 'Stock', 'Sales', 'CRM', 'Platform', 'Other'];

/* ─────────────────────────── small helpers ─────────────────────────── */

const nfmt = (n: number | undefined) => (typeof n === 'number' ? n.toLocaleString('en-IN') : '—');

function csvFilename(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : fallback;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  // Not a one-liner on purpose: the anchor has to be IN the document for the
  // click to register in Firefox, and the object URL has to outlive the click —
  // revoking it on the next line silently drops the file on Safari. The counter
  // PC runs whatever browser it runs, so do both.
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
}

/**
 * Headline for the red banner.
 *
 * The guard's refusals and the runtime's failures both land in the same box, but
 * they are not the same event and must not read as one. Calling a 5-second
 * SIGKILL or a SQLite syntax error a "refusal" is a small lie, and this is the
 * page whose entire value is that its numbers and its messages are honest — the
 * owner has to be able to tell "the console would not let me" from "the database
 * could not" from "it ran too long", because the fix is different each time.
 *
 * The WHY itself always comes from the server's own message. Never swap that for
 * a generic string here: the server is the only thing that knows which token at
 * which offset was the problem.
 */
const GUARD_CODES = new Set([
  'TOO_LONG', 'UNTERMINATED', 'MULTI_STATEMENT', 'BAD_START', 'WRITE_VERB',
]);
function errorHeadline(code: string): string {
  // BANNED_* is prefix-matched so a guard rule added later is classed correctly
  // rather than falling through to the vague catch-all.
  if (GUARD_CODES.has(code) || code.startsWith('BANNED_')) return 'Query refused — this console is read-only';
  if (code === 'TIMEOUT') return 'Query stopped to keep billing responsive';
  if (code === 'BUSY') return 'Another query is still running';
  if (code === 'RESULT_TOO_LARGE') return 'Result too large to return';
  if (code === 'SQLITE_ERROR') return 'SQLite could not run that statement';
  if (code === 'NETWORK') return 'Could not reach the server';
  return 'That query did not run';
}

/** Render one cell. Nulls are called out, not blanked — an empty string and a
 *  NULL are different facts and the whole point of this page is honest values. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ─────────────────────────── page ─────────────────────────── */

export default function AdminDatabasePage() {
  // access / catalog
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  // browsing
  const [search, setSearch] = useState('');
  const [table, setTable] = useState<string>('');
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [sortColumn, setSortColumn] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  // results
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [lastBody, setLastBody] = useState<RequestBody | null>(null);

  // SQL console
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlText, setSqlText] = useState('');

  // Only the newest request may paint. Sorting a big table twice quickly must not
  // let the slower first response overwrite the second.
  const seq = useRef(0);

  /* ── initial load: catalog + saved queries ── */
  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true); setLoadError(null);
    try {
      const res = await fetch('/api/admin/database?view=catalog', { cache: 'no-store' });
      // 401 (no session) and 403 (signed in, not admin) both land on the same
      // panel. The server is the gate; we just refuse to render a shell that
      // looks like it is one table-name away from working.
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      setCatalog(j as Catalog);
    } catch {
      setLoadError('Network error — could not reach the database service.');
    } finally { setLoadingCatalog(false); }
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/database?view=saved', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j && Array.isArray(j.saved)) setSaved(j.saved); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /* ── run a query (browse | saved | sql) ── */
  const run = useCallback(async (body: RequestBody) => {
    const mine = ++seq.current;
    setRunning(true); setQueryError(null);
    try {
      const res = await api('/api/admin/database', { method: 'POST', body: { ...body, format: 'json' } });
      if (res.status === 401 || res.status === 403) { if (mine === seq.current) setForbidden(true); return; }
      const j = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) {
        setQueryError({ code: j?.code || `HTTP_${res.status}`, error: j?.error || `HTTP ${res.status}` });
        return;
      }
      setResult(j as QueryResult);
      setLastBody(body);
    } catch {
      if (mine === seq.current) setQueryError({ code: 'NETWORK', error: 'Network error — the query did not reach the server.' });
    } finally {
      if (mine === seq.current) setRunning(false);
    }
  }, []);

  /* ── select a table: fetch schema, then page 1 ── */
  const openTable = useCallback(async (name: string) => {
    setTable(name); setSchema(null); setResult(null); setQueryError(null);
    setSortColumn(undefined); setSortDir('asc'); setPage(0);
    try {
      const res = await fetch(`/api/admin/database?view=schema&table=${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = await res.json().catch(() => ({}));
      if (res.ok) setSchema(j as TableSchema);
      else setQueryError({ code: j?.code || 'SCHEMA', error: j?.error || `Could not read the schema for ${name}.` });
    } catch {
      setQueryError({ code: 'NETWORK', error: 'Network error — could not read the table schema.' });
    }
    run({ mode: 'browse', table: name, page: 0, page_size: PAGE_SIZE });
  }, [run]);

  const browse = useCallback((opts: { column?: string; dir?: SortDir; page?: number }) => {
    if (!table) return;
    const col = 'column' in opts ? opts.column : sortColumn;
    const dir = opts.dir ?? sortDir;
    const pg = opts.page ?? page;
    setSortColumn(col); setSortDir(dir); setPage(pg);
    run({ mode: 'browse', table, sort_column: col, sort_dir: col ? dir : undefined, page: pg, page_size: PAGE_SIZE });
  }, [table, sortColumn, sortDir, page, run]);

  const toggleSort = (col: string) => {
    if (mode !== 'browse') return;
    const dir: SortDir = sortColumn === col && sortDir === 'asc' ? 'desc' : 'asc';
    browse({ column: col, dir, page: 0 });
  };

  const runSaved = (q: SavedQuery) => {
    // Load the SQL into the box AND run it. The box is editable on purpose:
    // nothing on this page is a black box he cannot open and change.
    setSqlOpen(true);
    setSqlText(q.sql);
    setTable(''); setSchema(null);
    run({ mode: 'saved', id: q.id });
  };

  const runSql = () => {
    const sql = sqlText.trim();
    if (!sql) return;
    setTable(''); setSchema(null);
    run({ mode: 'sql', sql });
  };

  /* ── CSV of the current view: same request, format:'csv'. Must be a POST
       (CSRF header), so we cannot use a plain <a download> and stream a blob. ── */
  const downloadCsv = async () => {
    if (!lastBody) return;
    setDownloading(true); setQueryError(null);
    try {
      const res = await api('/api/admin/database', { method: 'POST', body: { ...lastBody, format: 'csv' } });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setQueryError({ code: j?.code || `HTTP_${res.status}`, error: j?.error || 'The export was refused.' });
        return;
      }
      const stem = lastBody.mode === 'browse' ? lastBody.table : lastBody.mode === 'saved' ? lastBody.id : 'query';
      saveBlob(await res.blob(), csvFilename(res, `${stem}-${new Date().toISOString().slice(0, 10)}.csv`));
    } catch {
      setQueryError({ code: 'NETWORK', error: 'Network error — the export did not download.' });
    } finally { setDownloading(false); }
  };

  /* ── derived ── */
  const mode: 'browse' | 'query' = lastBody?.mode === 'browse' ? 'browse' : 'query';

  /**
   * What the grid is showing, named from the request that PRODUCED the rows —
   * never from the live `table` selection.
   *
   * These two drift apart on purpose: running SQL clears the table selection but
   * a refused statement leaves the previous rows on screen (deliberately — losing
   * his data because he typo'd a query would be worse). Titling that grid from
   * `table` printed "No table selected" above 100 visible rows of `purchases`.
   * Stale rows are fine and useful; stale rows wearing the wrong name are not,
   * on the one page whose entire value is that what it says is true. `mode`,
   * pagination and the row numbers are all already derived from `lastBody`, so
   * this makes the heading agree with the rest of the card instead of with a
   * selection the result may no longer have anything to do with.
   */
  const resultLabel = useMemo(() => {
    if (!lastBody) return 'No query yet';
    if (lastBody.mode === 'browse') return lastBody.table;
    if (lastBody.mode === 'saved') return saved.find(q => q.id === lastBody.id)?.title || 'Saved query';
    return 'Query result';
  }, [lastBody, saved]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = catalog?.tables ?? [];
    // Match the table name OR its group, so "purch" surfaces the whole
    // Purchasing group (vendors, po_*, grn_*) and not just names containing it.
    const hits = q ? all.filter(t => t.name.toLowerCase().includes(q) || t.group.toLowerCase().includes(q)) : all;
    const byGroup = new Map<string, CatalogTable[]>();
    for (const t of hits) {
      const arr = byGroup.get(t.group) || [];
      arr.push(t); byGroup.set(t.group, arr);
    }
    const order = [...GROUP_ORDER, ...(catalog?.groups ?? [])].filter((g, i, a) => a.indexOf(g) === i);
    return order
      .filter(g => byGroup.has(g))
      .map(g => ({ group: g, tables: byGroup.get(g)!.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [catalog, search]);

  const shownCount = grouped.reduce((n, g) => n + g.tables.length, 0);

  const basisFor = useCallback((column: string): string | null => {
    const declared = mode === 'browse' && schema
      ? (schema.columns.find(c => c.name === column)?.unit_basis ?? null)
      : null;
    if (declared) return declared;
    // HARD RULE: a raw quantity must never render as a bare number that could be
    // mistaken for the value the rest of the app displays. The server's
    // unit_basis map only covers the tables we actually audited — across 131
    // tables there are quantity columns it has never heard of, and in SQL mode
    // we do not even know which table a column came from. In BOTH cases say
    // "unknown" out loud instead of printing nothing: an absent caption reads as
    // "this is the normal number", which is precisely the mistake this page
    // exists to prevent. Do not "clean up" this fallback to return null.
    if (AMBIGUOUS_QTY_COLUMNS.has(column.toLowerCase())) {
      return mode === 'browse'
        ? 'unit basis not declared for this column — confirm before comparing'
        : 'unit basis depends on the source table — open it in the browser';
    }
    return null;
  }, [mode, schema]);

  /**
   * Fast lookup for "is this cell masked", keyed by row index + column name.
   *
   * The delimiter is spelled as the escape `\u0000`, NEVER as a literal NUL
   * byte pasted into the source. Two reasons, and the second is a credential leak:
   *   1. A raw NUL makes this file binary to grep, git diff and most editors.
   *      It was silently doing exactly that until it was caught.
   *   2. It is INVISIBLE. If a formatter, editor or git filter strips or
   *      normalises that byte on one of the two lines that build these keys and
   *      not the other, the keys stop matching, has() returns false for every
   *      cell, and the grid renders the TeleCMI app secret and the Meta access
   *      token in plaintext. It is a masking bug that fails OPEN and that looks,
   *      in every diff and every code review, like nothing changed at all.
   *
   * U+0000 is the correct delimiter here (a column name cannot contain it and the
   * row half is always digits, so the composite key is unambiguous). Keep the
   * delimiter; just keep it spelled out. The matching build site is in the grid.
   */
  const maskedSet = useMemo(() => {
    const s = new Set<string>();
    for (const m of result?.masked ?? []) s.add(`${m.row}\u0000${m.column}`);
    return s;
  }, [result]);

  const fkByColumn = useMemo(() => {
    const m = new Map<string, ForeignKey>();
    for (const fk of schema?.foreign_keys ?? []) m.set(fk.from, fk);
    return m;
  }, [schema]);

  const totalRows = result?.total_rows;
  const firstRowNo = (result?.page ?? 0) * (result?.page_size ?? PAGE_SIZE) + 1;
  const lastRowNo = firstRowNo + (result?.rows.length ?? 0) - 1;
  const hasNext = mode === 'browse' && typeof totalRows === 'number' && lastRowNo < totalRows;
  const hasPrev = mode === 'browse' && (result?.page ?? 0) > 0;

  /* ─────────────────── forbidden ─────────────────── */
  // Rendered INSTEAD of the shell: a non-admin must not see 131 table names, so
  // nothing table-related has been fetched by the time we get here.
  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admin access required</h1>
          <p className="text-sm mt-1">
            The Database console is restricted to admin accounts. If you need to look something up,
            ask an admin to run it for you — every query here is logged to the audit trail.
          </p>
        </div>
      </div>
    );
  }

  /* ─────────────────── page ─────────────────── */
  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-full overflow-x-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Database className="text-[#af4408] shrink-0" size={24} />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[#2D1B0E]">Database</h1>
            <p className="text-xs text-[#8B7355]">
              Read-only view of the live database.
              {catalog && <> · <strong className="text-[#2D1B0E]">{nfmt(catalog.table_count)}</strong> tables</>}
              {' '}· every query is written to the audit log.
            </p>
          </div>
        </div>
        <button onClick={loadCatalog}
                className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm">
          <RefreshCw className={`w-4 h-4 ${loadingCatalog ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      {/* Persistent unit-basis banner. Hard rule: this page shows raw stored
          values. A number here is NOT the number the rest of the app displays. */}
      <div className="flex items-start gap-2 bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl px-3 py-2.5 text-xs text-[#6B5744]">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#af4408]" />
        <p>
          <strong className="text-[#2D1B0E]">Raw table values, exactly as stored.</strong>{' '}
          This page converts nothing — check the unit basis on each quantity column before you compare
          a number here with anything the app displays.
        </p>
      </div>

      {/* The message here is whatever the server said, and server errors are often
          one long unbroken token (a webpack module path, a stack frame). `min-w-0`
          + `break-words` are load-bearing, not tidying: a flex child defaults to
          min-width:auto and will NOT shrink below its longest word, so without
          them the text runs past the card and the page shell's overflow-x-hidden
          silently CLIPS it. That produces an error banner you cannot read to the
          end — the one thing an error banner has to do. Verified at 375px. */}
      {loadError && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{loadError}</span>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4 items-stretch">
        {/* ───────── left rail: searchable table list ───────── */}
        <aside className="sm:w-64 sm:shrink-0 bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="p-3 border-b border-[#F0E4D6]">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search tables…"
                className="w-full pl-8 pr-2 py-2 border border-[#D4B896] rounded-lg text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
              />
            </div>
            <p className="text-[11px] text-[#8B7355] mt-1.5">
              {loadingCatalog ? 'Loading tables…' : `${nfmt(shownCount)} of ${nfmt(catalog?.table_count)} tables`}
            </p>
          </div>

          {/* Under sm the rail becomes a single dropdown so the phone shows the
              data, not a 131-row list you have to scroll past every time. */}
          <div className="sm:hidden p-3">
            <select
              value={table}
              onChange={e => e.target.value && openTable(e.target.value)}
              className="w-full px-2 py-2 border border-[#D4B896] rounded-lg text-sm bg-white text-[#2D1B0E]"
            >
              <option value="">Choose a table…</option>
              {grouped.map(g => (
                <optgroup key={g.group} label={g.group}>
                  {g.tables.map(t => <option key={t.name} value={t.name}>{t.name} ({nfmt(t.rows)})</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="hidden sm:block max-h-[70vh] overflow-y-auto">
            {/* Two different reasons the rail can be empty, and they must not share
                a message. "No table matches" is a statement about HIS search; if the
                catalog request failed we have no table list at all and saying it
                blames the search for a server fault — on the one page whose entire
                value is that what it tells him is true. When catalog is null the red
                banner above already carries the real reason, so say nothing here. */}
            {grouped.length === 0 && !loadingCatalog && catalog && (
              <p className="px-3 py-6 text-center text-xs text-[#8B7355]">
                {search.trim() ? <>No table matches “{search}”.</> : 'This database reports no tables.'}
              </p>
            )}
            {grouped.map(g => (
              <div key={g.group}>
                <div className="sticky top-0 z-10 bg-[#FFF1E3] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#6B5744] border-y border-[#F0E4D6]">
                  {g.group} <span className="font-normal text-[#8B7355]">· {g.tables.length}</span>
                </div>
                <ul>
                  {g.tables.map(t => {
                    const active = t.name === table;
                    return (
                      <li key={t.name}>
                        <button
                          onClick={() => openTable(t.name)}
                          title={`${t.columns} columns · ${nfmt(t.rows)} rows${t.pk.length ? ` · PK ${t.pk.join(', ')}` : ' · no primary key'}`}
                          className={`w-full text-left px-3 py-1.5 flex items-center gap-1.5 text-xs border-b border-[#F7EFE6] hover:bg-[#FFF8F0] ${active ? 'bg-[#FFF1E3] font-semibold text-[#af4408]' : 'text-[#2D1B0E]'}`}
                        >
                          <Table2 className="w-3.5 h-3.5 shrink-0 text-[#8B7355]" />
                          <span className="truncate flex-1 font-mono">{t.name}</span>
                          <span className="text-[10px] text-[#8B7355] tabular-nums">{nfmt(t.rows)}</span>
                          {active && <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        {/* ───────── right pane ───────── */}
        <section className="flex-1 min-w-0 space-y-4">
          {/* Schema strip */}
          {schema && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl">
              <button onClick={() => setSchemaOpen(o => !o)}
                      className="w-full flex items-center gap-2 px-4 py-3 text-left">
                {schemaOpen ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
                <span className="font-mono text-sm font-semibold text-[#2D1B0E]">{schema.name}</span>
                <span className="text-xs text-[#8B7355]">
                  {schema.columns.length} columns · {nfmt(schema.row_count)} rows · {schema.foreign_keys.length} foreign key{schema.foreign_keys.length === 1 ? '' : 's'}
                </span>
              </button>
              {schemaOpen && (
                <div className="px-4 pb-4 flex flex-wrap gap-1.5">
                  {schema.columns.map(c => {
                    const fk = fkByColumn.get(c.name);
                    return (
                      <div key={c.cid}
                           className="border border-[#E8D5C4] rounded-lg px-2 py-1.5 bg-[#FFF8F0] max-w-full">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-[11px] text-[#2D1B0E]">{c.name}</span>
                          <span className="text-[10px] text-[#8B7355] uppercase">{c.type || 'blob/any'}</span>
                          {c.pk > 0 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#af4408] text-white">PK</span>}
                          {c.notnull === 1 && <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[#F0E4D6] text-[#6B5744]">NOT NULL</span>}
                          {fk && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-mono">
                              → {fk.table}{fk.to ? `.${fk.to}` : ' (primary key)'}
                            </span>
                          )}
                        </div>
                        {c.unit_basis && (
                          <div className="text-[10px] text-[#af4408] mt-0.5 max-w-[260px]">{c.unit_basis}</div>
                        )}
                      </div>
                    );
                  })}
                  {schema.columns.every(c => c.pk === 0) && (
                    <p className="w-full text-[11px] text-[#8B7355] mt-1">This table declares no primary key.</p>
                  )}
                  {schema.foreign_keys.length === 0 && (
                    <p className="w-full text-[11px] text-[#8B7355] mt-1">This table declares no foreign keys.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Refusal / error banner — says WHY, with the guard's own code. */}
          {queryError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                {errorHeadline(queryError.code)}
                <code className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-100 border border-red-200">{queryError.code}</code>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap break-words">{queryError.error}</p>
            </div>
          )}

          {/* Result card */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[#F0E4D6]">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#2D1B0E] truncate">
                  {result || running ? resultLabel : 'No table selected'}
                </p>
                <p className="text-[11px] text-[#8B7355]">
                  {running ? 'Running…'
                    : result
                      ? <>
                          {nfmt(result.row_count)} row{result.row_count === 1 ? '' : 's'}
                          {mode === 'browse' && typeof totalRows === 'number' && result.row_count > 0 &&
                            <> · showing {nfmt(firstRowNo)}–{nfmt(lastRowNo)} of {nfmt(totalRows)}</>}
                          {' '}· {result.elapsed_ms} ms
                          {result.truncated && <span className="text-[#af4408] font-semibold"> · capped at the first {nfmt(result.row_count)} rows of a larger result</span>}
                        </>
                      : 'Pick a table on the left, or open the SQL console below.'}
                </p>
              </div>
              {mode === 'browse' && (
                <div className="flex items-center gap-1">
                  <button onClick={() => browse({ page: Math.max(0, (result?.page ?? 0) - 1) })}
                          disabled={!hasPrev || running}
                          className="p-2 border border-[#E0D0BE] rounded-lg text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button onClick={() => browse({ page: (result?.page ?? 0) + 1 })}
                          disabled={!hasNext || running}
                          className="p-2 border border-[#E0D0BE] rounded-lg text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
              {/* "The current view", literally: the CSV re-runs the SAME request
                  with format:'csv', so a browse exports the page on screen (100
                  rows), not the whole table. Said out loud in the tooltip because
                  a file called purchases_2026-08-05.csv looks like all 2,121
                  purchases, and he would reconcile against it. */}
              <button onClick={downloadCsv} disabled={!lastBody || !result || downloading || running}
                      title={mode === 'browse'
                        ? 'Downloads the rows on this page (not the whole table), with credentials masked.'
                        : 'Downloads this result, with credentials masked.'}
                      className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-semibold disabled:opacity-40">
                {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Download CSV
              </button>
            </div>

            {/* Masked-value notice. Shown, never silently blanked — he needs to
                know a credential was there, just not what it is. */}
            {result && result.masked.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800">
                <KeyRound className="w-3.5 h-3.5 shrink-0" />
                <span>
                  <strong>{result.masked.length}</strong> value{result.masked.length === 1 ? '' : 's'} masked —
                  stored credentials (API tokens, webhooks, service-account JSON) are hidden here and in the CSV.
                </span>
              </div>
            )}

            {/* The grid. overflow-x-auto + max-h keeps a 40-column table scrolling
                INSIDE this box; the document body must never scroll sideways on a
                phone, which is why the shell above is max-w-full overflow-x-hidden. */}
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              {running && !result ? (
                <div className="p-10 text-center text-sm text-[#8B7355]">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />Running…
                </div>
              ) : !result ? (
                <div className="p-10 text-center text-sm text-[#8B7355]">
                  <Table2 className="w-8 h-8 mx-auto mb-2 text-[#D4B896]" />
                  Choose a table to browse its rows.
                </div>
              ) : result.rows.length === 0 ? (
                <div className="p-10 text-center text-sm text-[#8B7355]">No rows.</div>
              ) : (
                <table className="text-xs border-collapse">
                  <thead className="bg-[#FFF1E3] text-[#6B5744] sticky top-0 z-10">
                    <tr>
                      <th className="text-right py-2 px-2 font-medium border-b border-[#E8D5C4] w-10">#</th>
                      {result.columns.map(c => {
                        const basis = basisFor(c.name);
                        const isSorted = mode === 'browse' && sortColumn === c.name;
                        return (
                          <th key={c.name}
                              onClick={() => toggleSort(c.name)}
                              // Sorting is a real control, so it is reachable without a mouse.
                              // Only in browse mode — a SQL result is not server-sortable.
                              tabIndex={mode === 'browse' ? 0 : undefined}
                              role={mode === 'browse' ? 'button' : undefined}
                              aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                              onKeyDown={e => {
                                if (mode !== 'browse') return;
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(c.name); }
                              }}
                              className={`text-left py-2 px-3 font-medium border-b border-[#E8D5C4] align-top whitespace-nowrap ${mode === 'browse' ? 'cursor-pointer hover:bg-[#F7E2CE]' : ''}`}>
                            <div className="flex items-center gap-1">
                              <span className="font-mono text-[#2D1B0E]">{c.name}</span>
                              {isSorted && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-[#af4408]" /> : <ArrowDown className="w-3 h-3 text-[#af4408]" />)}
                            </div>
                            <div className="text-[9px] uppercase text-[#8B7355] font-normal">{c.type || 'any'}</div>
                            {basis && (
                              <div className="text-[9px] text-[#af4408] font-normal normal-case max-w-[180px] whitespace-normal">{basis}</div>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/60 align-top">
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#B9A48C] tabular-nums">{firstRowNo + i}</td>
                        {result.columns.map(c => {
                          const masked = maskedSet.has(`${i}\u0000${c.name}`);
                          const v = row[c.name];
                          const isNull = v === null || v === undefined;
                          return (
                            <td key={c.name} className="py-1.5 px-3 max-w-[360px]">
                              {masked ? (
                                <span title="A stored credential. Masked so it cannot be read off the screen, a screenshot, or the CSV."
                                      className="font-mono text-[#6B5744]">
                                  {cellText(v)}{' '}
                                  <span className="text-[9px] uppercase tracking-wide text-amber-700">(masked)</span>
                                </span>
                              ) : isNull ? (
                                <span className="text-[10px] italic text-[#B9A48C]">NULL</span>
                              ) : (
                                <span className="block truncate font-mono text-[#2D1B0E]" title={cellText(v)}>{cellText(v)}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {result?.sql_executed && (
              <div className="px-4 py-2 border-t border-[#F0E4D6] bg-[#FFF8F0]">
                <p className="text-[10px] uppercase tracking-wider text-[#8B7355] mb-0.5">SQL that ran</p>
                <code className="block text-[11px] font-mono text-[#6B5744] whitespace-pre-wrap break-words">{result.sql_executed}</code>
              </div>
            )}
          </div>

          {/* ───────── advanced: SQL ───────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <button onClick={() => setSqlOpen(o => !o)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-left">
              {sqlOpen ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
              <span className="text-sm font-semibold text-[#2D1B0E]">Advanced — SQL</span>
              <span className="text-xs text-[#8B7355]">Saved questions and a read-only query box</span>
            </button>

            {sqlOpen && (
              <div className="px-4 pb-4 space-y-4">
                {/* Saved queries — the reason this page is useful on day one. */}
                {saved.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {saved.map(q => (
                      <button key={q.id} onClick={() => runSaved(q)} disabled={running}
                              className="text-left border border-[#E8D5C4] rounded-lg p-3 bg-[#FFF8F0] hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-50">
                        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2D1B0E]">
                          <Play className="w-3.5 h-3.5 text-[#af4408] shrink-0" />{q.title}
                        </div>
                        <p className="text-[11px] text-[#8B7355] mt-1">{q.explains}</p>
                      </button>
                    ))}
                  </div>
                )}

                <div>
                  <textarea
                    value={sqlText}
                    onChange={e => setSqlText(e.target.value)}
                    onKeyDown={e => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
                    }}
                    rows={6}
                    spellCheck={false}
                    placeholder="SELECT * FROM purchases ORDER BY date DESC LIMIT 50"
                    className="w-full px-3 py-2 border border-[#D4B896] rounded-lg font-mono text-xs text-[#2D1B0E] bg-white focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
                  />
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <button onClick={runSql} disabled={running || !sqlText.trim()}
                            className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold disabled:opacity-50">
                      {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}Run
                    </button>
                    <p className="text-[11px] text-[#8B7355]">
                      ⌘/Ctrl + Enter to run. One statement, read-only: SELECT, WITH or EXPLAIN.
                      Results are capped and the query is stopped if it runs long, so a heavy join
                      cannot slow down billing during service. Every run is audited.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
