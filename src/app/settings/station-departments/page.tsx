'use client';

/**
 * Settings → Station → Department map (ADMIN only).
 *
 * The owner-facing half of the department-inventory cutover. Recipe consumption
 * now leaves the DEPARTMENT, not central, so the consumption path has to answer
 * "which kitchen cooked this?" for every sold line. The only field that can
 * answer it is order_items.station — free text, 12 live values — and the
 * `departments` names do not string-match it ('Akan  Indian' carries TWO
 * spaces, 'Akan Tandoori' vs station 'tandoor', 'Akan - Bakery' is hyphenated).
 * So the map is DATA the owner edits, and this page is where he edits it.
 *
 *   GET /api/settings/station-departments → every station that exists IN DATA,
 *        mapped or not, each with what the mapping is worth and its resolved
 *        state, plus `departments`, `reserved`, `can_edit`, `schema_ready`.
 *   PUT /api/settings/station-departments → set / clear / switch off ONE row.
 *
 * ── THE THREE RULES A FUTURE ENGINEER WILL WANT TO "SIMPLIFY". DO NOT ──────
 *
 *  1. UNMAPPED IS AMBER, NEVER RED. An unmapped station is a SUPPORTED,
 *     DELIBERATE state — sushi and terracegrill ship unmapped because no
 *     department exists for them yet, liquor because it lives on the TGBCL
 *     store rail, and 'kitchen' because it is the blank-station sentinel. Red
 *     would read as "broken, go fix it", and the fix a hurried admin reaches
 *     for is to pick a plausible-looking department out of the dropdown — which
 *     is exactly the silent-wrong-kitchen outcome the whole skip rule exists to
 *     prevent. Red is reserved here for ONE thing: a mapping that points at a
 *     department row that no longer exists (`dangling`), which is an accident,
 *     not a choice, and which reads as "mapped" on the row while production
 *     skips it.
 *
 *  2. THE 'kitchen' SENTINEL IS UNMAPPABLE, and the block lives on the SERVER
 *     (409 SENTINEL_STATION). This page does not re-implement it — it renders
 *     the server's own refusal text and offers the informed second click that
 *     resends with force:true. kot-fire.ts coerces a station-less line to the
 *     literal string 'kitchen', and 'Kitchen' is also a real department (the
 *     main-kitchen roll-up, the busiest receiver in the building). Mapping the
 *     two together would quietly debit that one department for every mis-tagged
 *     item in the venue. The fix for a station-less item is to give the MENU
 *     ITEM a station, not to map the sentinel.
 *
 *  3. LIQUOR IS A DIFFERENT RAIL, and it is NOT blocked here. The carve-out
 *     that actually protects liquor is at the MATERIAL level (store-mapped
 *     materials are skipped by both the central debit and the department
 *     credit), where it belongs — not on a station name. So the dropdown stays
 *     enabled and the row carries a plain warning instead: mapping liquor moves
 *     nothing. Do not "tidy" that into a hard block; the block would be in the
 *     wrong layer and would drift from the material-level rule.
 *
 * ── NO CACHE, ON PURPOSE ──────────────────────────────────────────────────
 * Every read is `cache: 'no-store'`, and resolveStationDepartment() on the
 * server hits the DB on every consumption. An edit here is therefore live on
 * the very next sale, with no restart and no invalidation step to forget — that
 * is what makes the "skipped in the last 30 days" figure fall on its own once a
 * station is mapped. Do not add SWR/route caching for a 13-row table.
 *
 * ── WHY THE PAGE READS `can_edit` INSTEAD OF /api/auth/me ─────────────────
 * One fetch, no race. The route already resolves the session and answers
 * `can_edit: me.role === 'admin'`; taking it from there means the gate on
 * screen cannot disagree with the gate on the write, and there is no window
 * where the grid renders before auth answers. Read stays open to any signed-in
 * user server-side (managers may look at the map), but this PAGE is admin-only
 * per its adminOnly catalog entry, so a non-admin gets the lock screen and the
 * grid is never built. Fail closed: any load failure shows the error, never an
 * empty grid that looks like "no stations".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import {
  Network, RefreshCw, Loader2, Lock, AlertTriangle, Info, CheckCircle2,
  CircleSlash, Wine, ChefHat, XCircle,
} from 'lucide-react';

/* ── the server's row, verbatim ──────────────────────────────────────────── */
type StationRow = {
  station: string;
  department_id: string | null;
  department_name: string | null;
  is_active: boolean;
  note: string;
  updated_at: string | null;
  effective: 'mapped' | 'unmapped' | 'inactive';
  dangling: boolean;
  configured: boolean;
  menu_items: number;
  live_menu_items: number;
  live_recipe_items: number;
  sold_lines_30d: number;
  deducted_lines_30d: number;
  skips_30d: number;
  skip_qty_30d: number;
  in_menu: boolean;
  in_orders: boolean;
  in_kots: boolean;
};

type Dept = { id: string; name: string; is_active: boolean };

/**
 * The PUT answer. Every field is OPTIONAL on purpose: this is a parsed HTTP
 * body, not a value this file constructed, and the error paths (409 sentinel,
 * 400 bad station, a proxy returning HTML) carry only some of it. Typing it as
 * the happy shape is how `j.message` reaches a toast as the string "undefined".
 */
type SaveResponse = {
  station?: string;
  department_id?: string | null;
  department_name?: string | null;
  is_active?: boolean;
  note?: string;
  effective?: StationRow['effective'];
  message?: string;
  warnings?: string[];
  code?: string;
  error?: string;
};

type Payload = {
  stations: StationRow[];
  departments: Dept[];
  summary: {
    total: number; mapped: number; unmapped: number; inactive: number;
    dangling: number; skips_30d: number; needs_attention: string[];
  };
  reserved: { sentinel: string[]; other_rail: string[] };
  can_edit: boolean;
  schema_ready: boolean;
};

/**
 * Copy for the stations that ship deliberately unmapped.
 *
 * WHICH stations are reserved comes from the server (`reserved.sentinel` /
 * `reserved.other_rail`) — this map only supplies the on-screen wording, keyed
 * off that answer. Add a station to the server list and it still renders with a
 * sensible generic reason (see reservedReason() below) rather than silently
 * losing its explanation. Do NOT turn this into the source of truth for what is
 * reserved: two lists is how Settings ends up claiming a block the server does
 * not enforce, or hiding one it does.
 */
const RESERVED_COPY: Record<string, { title: string; body: string; Icon: typeof Info }> = {
  kitchen: {
    title: 'Intentionally unmappable — this is the blank-station fallback',
    body:
      'A sold line that carries no station of its own is recorded as “kitchen”. ' +
      '“Kitchen” is also a real department (the main-kitchen roll-up), so mapping the two together would ' +
      'debit that one department for every station-less item sold anywhere in the building. ' +
      'The fix is to give those menu items a real station — not to map this row.',
    Icon: ChefHat,
  },
  liquor: {
    title: 'Different rail — liquor is store-mapped',
    body:
      'Liquor lives on the TGBCL store ledger (store locations / store stock), not on the department ' +
      'raw-material rail. Store-mapped materials are skipped by the department ledger whatever this row says, ' +
      'so a mapping here would not deduct anything.',
    Icon: Wine,
  },
};

/** Deliberately-unmapped stations with no bespoke copy still get an honest reason. */
function reservedReason(station: string, p: Payload | null) {
  if (!p) return null;
  const isSentinel = p.reserved?.sentinel?.includes(station);
  const isOtherRail = p.reserved?.other_rail?.includes(station);
  if (!isSentinel && !isOtherRail) return null;
  return RESERVED_COPY[station] ?? {
    title: isSentinel ? 'Intentionally unmappable' : 'Different rail',
    body: isSentinel
      ? 'This station is a system placeholder, not a real kitchen. Mapping it would attribute stock to a department that did not cook the dish.'
      : 'This station belongs to a different stock rail, so a mapping here would not deduct anything.',
    Icon: Info,
  };
}

const nf = (n: number) => Number(n || 0).toLocaleString('en-IN');
const qf = (n: number) =>
  Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function istWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export default function StationDepartmentsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // ONE timer, cleared before each new toast. Two quick edits (map continental,
  // then switch it off) would otherwise leave the FIRST toast's timeout running,
  // and it fires against the SECOND toast — hiding a warning the owner has not
  // read yet. On this page the warnings are the point: "that department is
  // deactivated but still receives stock" is exactly the sentence that must not
  // vanish after 300ms. Do not "simplify" back to a bare setTimeout.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((ok: boolean, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ok, msg });
    // Warnings carry real reasoning (a deactivated department still receives
    // stock; a liquor mapping moves nothing) so they are held long enough to read.
    toastTimer.current = setTimeout(() => setToast(null), ok ? 3500 : 7000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settings/station-departments', { cache: 'no-store' });
      if (res.status === 401) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as Partial<Payload> & { error?: string };
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      // Fail closed on a body that parsed but carries no grid: an empty page
      // would read as "no stations exist", which is a different (and calmer)
      // statement than "the map did not load".
      if (!Array.isArray(j?.stations)) { setLoadError('The station map came back empty — reload, or check the server log'); return; }
      setData(j as Payload);
      // The page gate. The route answers READ to any signed-in user by design;
      // this screen is admin-only, so a non-admin gets the lock screen and the
      // grid below is never rendered.
      if (!j?.can_edit) setForbidden(true);
    } catch {
      setLoadError('Network error — could not load the station map');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Write ONE row.
   *
   * `department_id: ''` CLEARS the mapping — a supported action meaning "stop
   * deducting for this station", not a failure. `is_active` is a SEPARATE axis
   * and is only sent when the toggle moved: the server preserves it otherwise,
   * so "switched off" (keep the department, stop deducting) and "cleared"
   * (forget the department) stay distinguishable in the audit.
   *
   * Optimism is deliberately narrow. The row is marked busy, the PUT is sent,
   * and the row is then rebuilt from the SERVER's answer — which it produces by
   * re-reading through resolveStationDepartment(), the same function production
   * calls. Painting the row from the local dropdown value instead is how the
   * screen ends up showing "mapped" for a station that skips on the next sale.
   */
  const save = useCallback(async (
    station: string,
    patch: { department_id?: string | null; is_active?: boolean },
    force = false,
  ) => {
    setBusy(station);
    try {
      const res = await api('/api/settings/station-departments', {
        method: 'PUT',
        body: { station, ...patch, ...(force ? { force: true } : {}) },
      });
      const j = (await res.json().catch(() => ({}))) as SaveResponse;

      // The sentinel refusal. The wording is the SERVER's, not a second copy of
      // it here, so the two can never drift. force:true is an informed second
      // click, which is the entire point of the 409.
      if (res.status === 409 && j?.code === 'SENTINEL_STATION') {
        if (window.confirm(`${j.error}\n\nMap it anyway?`)) {
          await save(station, patch, true);
          return;
        }
        flash(false, 'Left unmapped.');
        return;
      }
      if (!res.ok) { flash(false, j?.error || `Could not save (HTTP ${res.status})`); return; }

      setData((prev) => prev && ({
        ...prev,
        stations: prev.stations.map((s) => s.station !== station ? s : {
          ...s,
          department_id: j.department_id ?? null,
          department_name: j.department_name ?? null,
          is_active: !!j.is_active,
          note: String(j.note ?? s.note),
          // The SERVER's resolved state, never the dropdown's. Falling back to
          // the row's previous state (rather than to 'mapped') keeps the screen
          // honest if the body ever arrives short.
          effective: j.effective ?? s.effective,
          // The server refuses a dangling pointer outright, so a successful
          // save can never leave one behind.
          dangling: false,
          configured: true,
          updated_at: new Date().toISOString(),
        }),
      }));

      const warnings: string[] = Array.isArray(j.warnings) ? j.warnings : [];
      const message = j.message || 'Saved.';
      flash(true, warnings.length ? `${message} ${warnings.join(' ')}` : message);
      // Counts (skips, sold-vs-deducted, the attention banner) are re-derived
      // server-side; pull them quietly so the page stops reporting the state the
      // owner just fixed.
      load(true);
    } catch {
      flash(false, 'Network error — nothing was saved');
    } finally { setBusy(null); }
  }, [load, flash]);

  /* Stations are rendered in the server's alphabetical order and are NOT
   * re-sorted by state. Attention-first sorting would move a row out from under
   * the cursor the instant it is mapped, which is how an admin edits the wrong
   * station next. The banner names the rows that need attention instead. */
  const rows = useMemo(() => {
    const all = data?.stations ?? [];
    if (!onlyAttention) return all;
    const flagged = new Set(data?.summary?.needs_attention ?? []);
    return all.filter((s) => flagged.has(s.station) || s.dangling);
  }, [data, onlyAttention]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admins only</h1>
          <p className="text-sm mt-1">
            The station → department map decides which kitchen&apos;s books a gram leaves, so it is
            restricted to admin accounts.
          </p>
        </div>
      </div>
    );
  }

  const s = data?.summary;
  const attention = s?.needs_attention ?? [];

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Settings</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <Network className="w-7 h-7 text-[#af4408] shrink-0" />
              <span className="min-w-0">Station → Department</span>
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              Recipe consumption deducts from the <b>department</b> that cooked the dish. This map is how a
              sold line&apos;s station is turned into that department. Changes are live on the next sale.
            </p>
          </div>
          <button
            onClick={() => load(true)}
            className="shrink-0 self-start sm:self-auto flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>

        {loadError && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{loadError}</span>
          </div>
        )}

        {data && !data.schema_ready && (
          <div className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              The station → department table has not been created on this server yet. Restart the app so the
              migration runs — until then nothing can be saved, and every station resolves as unmapped.
            </span>
          </div>
        )}

        {/* Summary */}
        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'Stations in data', value: nf(s.total), cls: 'text-[#2D1B0E]' },
              { label: 'Mapped', value: nf(s.mapped), cls: 'text-green-700' },
              { label: 'Unmapped', value: nf(s.unmapped + s.inactive), cls: 'text-amber-700' },
              { label: 'Skipped (30 days)', value: nf(s.skips_30d), cls: s.skips_30d > 0 ? 'text-amber-700' : 'text-[#2D1B0E]' },
            ].map((c) => (
              <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5 shadow-sm">
                <p className="text-[11px] text-[#8B7355] leading-tight">{c.label}</p>
                <p className={`text-xl font-bold mt-0.5 ${c.cls}`}>{c.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* AMBER, not red: unmapped is a valid choice. This banner reports the ONE
            combination that silently loses a deduction — a station with live
            recipe-linked items (or recorded skips) that nothing is mapped to. */}
        {attention.length > 0 && (
          <div className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <b>{attention.length} station{attention.length === 1 ? '' : 's'} not mapped but still cooking:</b>{' '}
              {attention.join(', ')}.
              <p className="mt-1 text-amber-800">
                Recipe consumption for these is <b>skipped and recorded</b> — no department is deducted, and
                nothing is deducted twice. That shows up on Department Variance as a gap, not as a loss.
                Map them below, or leave them unmapped on purpose.
              </p>
            </div>
          </div>
        )}

        {/* RED is reserved for this one case: the row says "mapped", production
            skips it. A choice is amber; a broken pointer is an error. */}
        {!!s?.dangling && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {nf(s.dangling)} mapping{s.dangling === 1 ? '' : 's'} point at a department that no longer
              exists. Those stations read as mapped here but are <b>skipped</b> on every sale. Re-pick a
              department, or clear them so the skip is deliberate.
            </span>
          </div>
        )}

        {/* Filter */}
        {!!data?.stations?.length && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[#6B5744]">
              {nf(rows.length)} of {nf(data.stations.length)} station{data.stations.length === 1 ? '' : 's'}
            </p>
            <label className="flex items-center gap-2 text-sm text-[#6B5744] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyAttention}
                onChange={(e) => setOnlyAttention(e.target.checked)}
                className="accent-[#af4408]"
              />
              Only ones needing attention
            </label>
          </div>
        )}

        {/* Grid.
            CARDS, not a table, and that is a layout decision with a reason: this
            row carries a station, five counts, a dropdown and a paragraph of
            reason text. As a table it cannot fit a phone without side-scrolling,
            and the storekeeper's tablet is where it gets read. Every element
            below wraps; nothing has a fixed width. */}
        {loading ? (
          <div className="space-y-2.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-white border border-[#E8D5C4] rounded-2xl h-28 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-14 text-center text-[#8B7355]">
            <Info className="w-9 h-9 mx-auto mb-3 text-[#C9B49C]" />
            <p className="font-medium text-[#2D1B0E]">
              {onlyAttention ? 'Nothing needs attention' : 'No stations found'}
            </p>
            <p className="text-xs mt-1">
              {onlyAttention
                ? 'Every station that cooks from a recipe is mapped.'
                : 'A station appears here as soon as a menu item, order line or KOT carries one.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {rows.map((r) => {
              const reserved = reservedReason(r.station, data);
              const mapped = r.effective === 'mapped';
              const isBusy = busy === r.station;
              // AMBER for every deliberate non-mapped state; RED only for a
              // pointer at a department that has been deleted. See rule 1.
              const tone = r.dangling
                ? { border: 'border-red-200', chip: 'bg-red-100 text-red-700 border-red-200' }
                : mapped
                  ? { border: 'border-[#E8D5C4]', chip: 'bg-green-100 text-green-700 border-green-200' }
                  : { border: 'border-amber-200', chip: 'bg-amber-100 text-amber-800 border-amber-200' };
              const stateLabel = r.dangling
                ? 'Department deleted — skipped'
                : mapped
                  ? `Deducts from ${r.department_name}`
                  : r.effective === 'inactive'
                    ? 'Switched off — skipped'
                    : 'Not mapped — skipped';

              return (
                <div
                  key={r.station}
                  className={`bg-white border ${tone.border} rounded-2xl shadow-sm p-3.5 ${!mapped && !r.dangling ? 'bg-amber-50/40' : ''}`}
                >
                  {/* Title + state */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-[15px] break-all">{r.station}</span>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${tone.chip}`}>
                      {r.dangling ? <XCircle className="w-3 h-3" />
                        : mapped ? <CheckCircle2 className="w-3 h-3" />
                        : <CircleSlash className="w-3 h-3" />}
                      {stateLabel}
                    </span>
                    {!r.in_menu && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not on the live menu
                      </span>
                    )}
                  </div>

                  {/* What the mapping is worth. live_recipe_items is the number
                      that decides whether a mapping does anything at all:
                      consumption fires only for a sold line whose menu item
                      carries an active recipe. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#8B7355] mt-1.5">
                    <span><b className="text-[#2D1B0E]">{nf(r.live_menu_items)}</b> live menu item{r.live_menu_items === 1 ? '' : 's'}{r.menu_items !== r.live_menu_items ? ` (${nf(r.menu_items)} total)` : ''}</span>
                    <span className={r.live_recipe_items === 0 ? 'text-amber-700' : ''}>
                      <b className={r.live_recipe_items === 0 ? '' : 'text-[#2D1B0E]'}>{nf(r.live_recipe_items)}</b> with a recipe
                    </span>
                    <span>Sold 30d: <b className="text-[#2D1B0E]">{nf(r.sold_lines_30d)}</b> line{r.sold_lines_30d === 1 ? '' : 's'}, {nf(r.deducted_lines_30d)} deducted</span>
                    <span className={r.skips_30d > 0 ? 'text-amber-700 font-medium' : ''}>
                      Skipped 30d: <b>{nf(r.skips_30d)}</b>
                      {r.skip_qty_30d > 0 ? ` (${qf(r.skip_qty_30d)} recipe units)` : ''}
                    </span>
                    {r.updated_at && <span>Changed {istWhen(r.updated_at)}</span>}
                  </div>

                  {/* A mapping with no recipes behind it is a no-op. Say so
                      before the owner concludes the map is broken. */}
                  {mapped && r.live_recipe_items === 0 && (
                    <p className="text-[11px] text-amber-800 mt-1.5">
                      Mapped, but no live menu item on this station carries a recipe yet — so nothing will be
                      deducted until one does. That is a recipe gap, not a mapping problem.
                    </p>
                  )}

                  {/* The deliberate-unmapped explanations (kitchen, liquor, …). */}
                  {reserved && (
                    <div className="flex items-start gap-2 mt-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                      <reserved.Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span><b>{reserved.title}.</b> {reserved.body}</span>
                    </div>
                  )}

                  {/* The seeded / owner note, when it says something the row does not.
                      An UNMAPPED row shows it in the amber panel, not as grey
                      small print: sushi and terracegrill ship unmapped by the
                      one-shot seed carrying "no department chosen yet", and that
                      sentence is the whole reason the row is not an error. Grey
                      italic reads as a leftover; amber reads as a decision. A
                      MAPPED row keeps the quiet treatment — there its note is
                      just the department's name, already said above. */}
                  {r.note && !reserved && (
                    mapped
                      ? <p className="text-[11px] text-[#8B7355] mt-1.5 italic break-words">{r.note}</p>
                      : (
                        <div className="flex items-start gap-2 mt-2 p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span className="break-words">{r.note}</span>
                        </div>
                      )
                  )}

                  {/* Controls. Stacked on a phone, inline from sm up — never a
                      row that needs sideways scrolling. */}
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-2.5">
                    <label htmlFor={`dept-${r.station}`} className="text-xs font-medium text-[#6B5744] sm:w-24 shrink-0">
                      Department
                    </label>
                    <select
                      id={`dept-${r.station}`}
                      value={r.department_id ?? ''}
                      disabled={isBusy || !data?.schema_ready}
                      onChange={(e) => save(r.station, { department_id: e.target.value })}
                      className="w-full sm:flex-1 min-w-0 px-3 py-2.5 bg-white border border-[#D4B896] rounded-xl text-sm text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 disabled:opacity-60"
                    >
                      {/* Clearing is a real action, not an empty state. */}
                      <option value="">Not mapped — skip and record</option>
                      {(data?.departments ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}{d.is_active ? '' : ' (deactivated)'}
                        </option>
                      ))}
                    </select>

                    {/* The SECOND axis, and it has to be here.
                        "Switched off" (keep the department, stop deducting) and
                        "cleared" (forget the department) are different owner
                        intentions and different resolver reasons. The server
                        PRESERVES is_active when it is not sent — so with a
                        dropdown alone, a row that is switched off could never be
                        switched back on from this screen. */}
                    {!!r.department_id && (
                      <div className="flex items-center gap-2 sm:shrink-0">
                        <Toggle
                          size="sm"
                          checked={r.is_active}
                          disabled={isBusy || !data?.schema_ready}
                          onChange={(next) => save(r.station, { is_active: next })}
                          label={r.is_active ? 'Deducting' : 'Paused'}
                          title="Pause deduction without losing the mapping"
                        />
                      </div>
                    )}
                    {isBusy && <Loader2 className="w-4 h-4 animate-spin text-[#af4408] sm:shrink-0" />}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* The footnote the variance report depends on. */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 text-[12px] text-[#6B5744] leading-relaxed">
          <p className="font-semibold text-[#2D1B0E] flex items-center gap-2">
            <Info className="w-4 h-4 text-[#af4408]" />What an unmapped station actually does
          </p>
          <p className="mt-1.5">
            It <b>skips</b> the department deduction and records the skip — it never guesses a department, never
            falls back to the main kitchen, and never falls back to the central store. Nothing is deducted
            twice and nothing is deducted from the wrong kitchen; the sale itself, and the Sales-vs-Purchase
            and Variance figures that read it, are unchanged.
          </p>
          <p className="mt-1.5">
            Leaving a station unmapped is a legitimate choice. Deducting from the wrong kitchen is not
            recoverable — it reads as a loss against a chef who never received the goods.
          </p>
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-6 inset-x-3 sm:inset-x-auto sm:right-6 z-50 flex items-start gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium border max-w-md sm:ml-auto ${
          toast.ok ? 'bg-white border-[#E8D5C4] text-[#2D1B0E]' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {toast.ok
            ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
            : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <span className="min-w-0">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
