'use client';

/**
 * Search-as-you-type material picker. Drop-in replacement for native
 * <select> dropdowns when the materials list is too long for scrolling
 * (this app has 900+ rows). Filters by name + SKU + category.
 *
 * Props:
 *   materials  — full list (no pagination needed; we cap displayed results)
 *   value      — current material_id, or '' for unselected
 *   onPick     — called with the chosen id (or '' when cleared)
 *   excludeIds — material ids already used elsewhere (e.g. on other rows)
 *   excludeMode — what excludeIds DOES. 'hide' (default) drops them from the
 *                 list entirely, which is what every existing caller has always
 *                 got. 'disable' keeps them visible but greyed and unpickable,
 *                 tagged "Already added" — chosen for Enter Full Bill, where a
 *                 vanishing row read as "the dropdown lost my item" rather than
 *                 "you already added it". Opt-in so no other screen shifts.
 *   onExcludedPick — called when the user tries to pick a greyed row, so the
 *                 caller can say WHERE it was already added. 'disable' only.
 *   placeholder — input placeholder when no selection
 *   compact    — render at xs size (for embedded grids); else sm
 *   inactive   — what a SWITCHED-OFF material (raw_materials.is_active = 0,
 *                Raw Materials → Active, owner ruling #78) does in the list:
 *                'show' (DEFAULT — every existing caller, reports included)
 *                lists it like any other row; 'hide' leaves it out (new-entry
 *                screens: PO, bill, GRN, requisition, recipe pickers);
 *                'with-stock' lists it only while it still holds stock
 *                (counting / wastage / transfer screens). It filters the
 *                SEARCH RESULTS only — never the line's current value, so an
 *                open document whose line is now switched off still shows it.
 *                A row that is listed while switched off carries an "Inactive"
 *                tag, and the list says how many it is not offering.
 *
 * Keyboard:
 *   ↑/↓ navigate · Enter pick · Esc close · click outside closes.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { toPurchaseQty, fmtQtyNum } from '@/lib/pack-units';

export interface MaterialLite {
  id: string;
  name: string;
  sku?: string;
  unit?: string;
  category?: string;
  current_stock?: number;
  reorder_level?: number;
  /** Optional pack meta — only read when `purchaseBasis` is on. Optional so the
   *  many existing callers (incl. /recipes) compile and behave unchanged. */
  purchase_unit?: string | null;
  pack_size?: number | null;
  /** raw_materials.is_active (1 on / 0 off). Absent or null = ON — the same
   *  COALESCE(is_active, 1) every server reader applies. GET /api/inventory
   *  rows carry it (SELECT rm.*). */
  is_active?: number | boolean | null;
}

/** What a picker does with a switched-off material — see the `inactive` prop. */
export type InactivePickerMode = 'show' | 'hide' | 'with-stock';

/** Below this a recipe-unit balance is float residue, not stock on a shelf. */
const STOCK_EPSILON = 1e-6;

/**
 * Is this material switched OFF (raw_materials.is_active = 0)? Missing, null or
 * blank reads as ON, exactly like COALESCE(is_active, 1) on the server, so a
 * caller whose rows never carried the column behaves as it always did.
 * Typed `unknown` so every screen's own Material shape can be passed as is.
 */
export function isSwitchedOff(m: unknown): boolean {
  const v = (m as { is_active?: unknown } | null | undefined)?.is_active;
  if (v === undefined || v === null || v === '') return false;
  if (v === false) return true;
  return Number(v) === 0;
}

/**
 * Does a picker OFFER this material under `mode`? The one rule every picker on
 * a new-entry / counting screen shares — MaterialTypeahead below and the screens
 * with their own lists (purchase orders, recipes, the staff catalog, staff
 * meals). Apply it to the list a user picks FROM, never to a line's current
 * value. 'with-stock' reads current_stock: the caller supplies the balance of
 * the place the stock is leaving (central for /api/inventory rows).
 */
export function offeredInPicker(m: unknown, mode: InactivePickerMode = 'show'): boolean {
  if (mode === 'show' || !isSwitchedOff(m)) return true;
  if (mode === 'hide') return false;
  return (Number((m as { current_stock?: unknown })?.current_stock) || 0) > STOCK_EPSILON;
}

/** The sentence a picker prints about the switched-off rows it is not offering. */
export function notOfferedNote(count: number, mode: InactivePickerMode): string {
  if (count <= 0 || mode === 'show') return '';
  const what = count === 1 ? 'inactive item' : 'inactive items';
  return mode === 'with-stock'
    ? `${count} ${what} with no stock not offered here`
    : `${count} ${what} not offered here`;
}

export default function MaterialTypeahead({
  materials,
  value,
  onPick,
  excludeIds = [],
  excludeMode = 'hide',
  onExcludedPick,
  placeholder = 'Type material name, SKU or category…',
  compact = true,
  showStock = true,
  purchaseBasis = false,
  inactive = 'show',
}: {
  materials: MaterialLite[];
  value: string;
  onPick: (id: string) => void;
  excludeIds?: string[];
  /** DEFAULT 'hide' — the behaviour every existing caller was written against
   *  (excluded rows are filtered out of the list). 'disable' is opt-in: the row
   *  stays visible, greyed, tagged and unpickable. */
  excludeMode?: 'hide' | 'disable';
  /** 'disable' only: the user clicked a greyed row. Lets the caller name the
   *  line it is already on, instead of the click just doing nothing. */
  onExcludedPick?: (m: MaterialLite) => void;
  placeholder?: string;
  compact?: boolean;
  showStock?: boolean;
  /** OPT-IN: render the on-hand figure and the picked chip's unit in PURCHASE
   *  units (owner rule for Inventory/Store/Purchase surfaces). Strictly opt-in
   *  because this component is ALSO mounted by /recipes, which must stay in
   *  recipe units — the default render path must never convert. Callers that
   *  turn it on must supply purchase_unit + pack_size on their MaterialLite
   *  rows (the /api/inventory payload already carries both). */
  purchaseBasis?: boolean;
  /** DEFAULT 'show' — what every existing caller was written against. 'hide'
   *  for new-entry screens, 'with-stock' for counting / wastage / transfers.
   *  Filters the dropdown only; the picked value is always resolved from the
   *  full `materials` list. 'with-stock' needs current_stock on the rows. */
  inactive?: InactivePickerMode;
}) {
  // Display-only conversion for the opt-in purchase basis. Falls back to the
  // recipe figure when the caller did not supply pack meta — an honest recipe
  // number beats a silently under-converted one.
  const displayStock = (m: MaterialLite): { qty: number; unit: string } => {
    if (!purchaseBasis || m.purchase_unit == null) {
      return { qty: Number(m.current_stock) || 0, unit: String(m.unit || '') };
    }
    return {
      qty: toPurchaseQty(Number(m.current_stock) || 0, m),
      unit: String(m.purchase_unit || m.unit || ''),
    };
  };
  // Every unit label on this component must come from here, including the picked
  // chip's title tooltip. Reading m.unit directly anywhere makes that label
  // contradict its own chip the moment purchaseBasis is on — "SALTED BUTTER
  // 500 GM (PKT)" on screen, "(g)" on hover.
  const displayUnit = (m: MaterialLite): string =>
    purchaseBasis && m.purchase_unit != null
      ? String(m.purchase_unit || m.unit || '')
      : String(m.unit || '');

  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // Portal-positioned dropdown: rendered to document.body with `position:fixed`
  // so it can NEVER be clipped by an ancestor's overflow (modals, scroll panes,
  // and overflow-x-auto tables all clip an in-flow absolute dropdown — which
  // made the list render but stay invisible inside the GRN/PO modals).
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const computePos = () => {
    const el = wrapRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    // Keep it within the viewport horizontally.
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
  };

  // Recompute position whenever the dropdown opens, and keep it pinned to the
  // anchor while the user scrolls/resizes (capture=true catches scroll on any
  // ancestor scroll container, e.g. the modal body).
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    computePos();
    const onMove = () => computePos();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  // Close on click outside — must treat the portaled dropdown as "inside" too,
  // since it lives in document.body, not within wrapRef.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const picked = useMemo(() => materials.find(m => m.id === value) || null, [materials, value]);

  /** Ids that are present-but-unpickable. Empty unless excludeMode='disable',
   *  so the 'hide' path below is byte-for-byte what it always was. */
  const blockedIds = useMemo(
    () => (excludeMode === 'disable' ? new Set(excludeIds) : new Set<string>()),
    [excludeIds, excludeMode],
  );
  const isBlocked = (m: MaterialLite) => blockedIds.has(m.id);

  const { results, notOffered } = useMemo(() => {
    const raw = query.trim().toLowerCase();
    const excluded = new Set(excludeIds);
    // 'disable' keeps excluded rows IN the list (greyed at render); 'hide'
    // drops them, which is the long-standing default.
    let list = excludeMode === 'disable' ? materials.slice() : materials.filter(m => !excluded.has(m.id));
    // Switched-off materials this screen does not offer (prop `inactive`). Kept
    // aside, not discarded: the dropdown names how many — and, for a search,
    // which — so "No materials match" is never printed about an item that
    // exists but is switched off (that is how duplicates get created). With
    // the default 'show' nothing is set aside and the list is what it was.
    let off: MaterialLite[] = [];
    if (inactive !== 'show') {
      const kept: MaterialLite[] = [];
      for (const m of list) (offeredInPicker(m, inactive) ? kept : off).push(m);
      list = kept;
    }
    if (raw) {
      // Tokenized substring match — split query on whitespace, every token
      // must appear somewhere in the searchable haystack. So:
      //   "ee"         matches "Beer", "Cheese", "Chicken Breast"
      //   "olive oil"  matches "Extra Virgin Olive Oil"
      //   "oil 1l"     matches "Sunflower Oil 1L" (order-independent)
      //   "btl"        matches anything with a BTL unit/SKU/category
      // The haystack pulls in every text field we know about so the user
      // can search by any visible attribute.
      const tokens = raw.split(/\s+/).filter(Boolean);
      const hit = (m: MaterialLite) => {
        const hay = [
          m.name, m.sku, m.category, m.unit, (m as any).brand,
        ].filter(Boolean).join(' ').toLowerCase();
        return tokens.every(t => hay.includes(t));
      };
      list = list.filter(hit);
      off = off.filter(hit);
      // Sort by relevance buckets, then alphabetic:
      //   0  exact name prefix match for the raw query
      //   1  any token appears at a word boundary in the name
      //   2  any token appears at a word boundary in the SKU
      //   3  fall-through (substring only)
      list.sort((a, b) => {
        const score = (m: MaterialLite) => {
          const an = (m.name || '').toLowerCase();
          if (an.startsWith(raw)) return 0;
          const words = an.split(/[^a-z0-9]+/);
          if (tokens.some(t => words.some(w => w.startsWith(t)))) return 1;
          const skuWords = (m.sku || '').toLowerCase().split(/[^a-z0-9]+/);
          if (tokens.some(t => skuWords.some(w => w.startsWith(t)))) return 2;
          return 3;
        };
        const sa = score(a), sb = score(b);
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      });
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    // Render the WHOLE list — the dropdown is scrollable (max-h + overflow-y-auto),
    // so the user can scroll through every material even with no search query.
    // (A tiny empty-query cap of 80 used to stop the list at ~"B" alphabetically,
    // which read as "the dropdown won't load past B".) A high safety ceiling keeps
    // pathological catalogues from mounting tens of thousands of nodes at once;
    // beyond it, typing to filter is the intended path.
    return {
      results: list.slice(0, 1000),
      notOffered: off.slice().sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [materials, query, excludeIds, excludeMode, inactive]);
  const offNote = notOfferedNote(notOffered.length, inactive);
  /** The names, for a SEARCH only — an unsearched list just gets the count. */
  const offNames = query.trim() && notOffered.length > 0
    ? notOffered.slice(0, 3).map(m => m.name).join(', ') + (notOffered.length > 3 ? ` +${notOffered.length - 3} more` : '')
    : '';
  /**
   * The user typed the exact name (or SKU) of an item this picker does NOT
   * offer — and no offered row carries that exact name/SKU. Then the top row
   * is merely the nearest OTHER match ("Vodka" → D'YAVOL VODKA (700ML)), so
   * Enter must not quietly put it on the line: nothing is highlighted, Enter
   * picks nothing, and the header says in plain text that the typed item is
   * switched off. ↑/↓ (or a click) still chooses any listed row on purpose.
   * Always null with the default 'show' (nothing is set aside).
   */
  const exactOff = useMemo(() => {
    const raw = query.trim().toLowerCase();
    if (!raw || notOffered.length === 0) return null;
    const same = (m: MaterialLite) =>
      (m.name || '').trim().toLowerCase() === raw || (m.sku || '').trim().toLowerCase() === raw;
    if (results.some(same)) return null;
    return notOffered.find(same) || null;
  }, [query, results, notOffered]);

  // Keyed on the id STRING, not the row object: a caller that rebuilds its
  // materials array on every render must not reset the highlight each time.
  const exactOffId = exactOff?.id ?? '';
  /** Did the user move the highlight with ↑/↓ since the query last changed?
   *  Only then may Enter take a row while the typed item is not offered. */
  const kbNav = useRef(false);
  useEffect(() => { kbNav.current = false; setActive(exactOffId ? -1 : 0); }, [query, exactOffId]);

  const choose = (m: MaterialLite) => {
    // A greyed row is not a selection. Tell the caller so it can say WHERE the
    // material already sits, and leave the dropdown open so the user can pick
    // something else without reopening it.
    if (isBlocked(m)) { onExcludedPick?.(m); return; }
    onPick(m.id);
    setOpen(false);
    setQuery('');
  };
  const clear = () => { onPick(''); setQuery(''); setOpen(true); };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); e.preventDefault(); return;
    }
    if (!open) return;
    // Arrows step OVER greyed rows, so the highlight never rests on something
    // Enter cannot take. With excludeMode='hide' nothing is blocked and this
    // walks exactly one row, as before.
    const step = (dir: 1 | -1) => setActive(i => {
      for (let n = i + dir; n >= 0 && n < results.length; n += dir) {
        if (!isBlocked(results[n])) return n;
      }
      return i;
    });
    if (e.key === 'ArrowDown') { e.preventDefault(); kbNav.current = true; step(1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); kbNav.current = true; step(-1); }
    else if (e.key === 'Enter') {
      // The typed name is a switched-off item this screen does not offer: Enter
      // never swaps in a different item (see exactOff). It still does not submit
      // a surrounding form — the header already says why nothing was picked.
      if (exactOff && !kbNav.current) { e.preventDefault(); return; }
      if (results[active]) { e.preventDefault(); choose(results[active]); }
    }
    else if (e.key === 'Escape')    { setOpen(false); }
  };

  // Tailwind size variants
  const inputSize  = compact ? 'text-xs py-1' : 'text-sm py-2';
  const buttonSize = compact ? 'text-xs py-1' : 'text-sm py-2';
  const itemSize   = compact ? 'text-xs py-1.5' : 'text-sm py-2';

  return (
    <div ref={wrapRef} className="relative">
      {picked && !open ? (
        <button type="button"
                onClick={() => { setOpen(true); setQuery(''); }}
                title={`${picked.sku ? picked.sku + ' — ' : ''}${picked.name}${displayUnit(picked) ? ' (' + displayUnit(picked) + ')' : ''}`}
                className={`w-full text-left px-2 ${buttonSize} border border-[#E8D5C4] rounded bg-[#FFF8F0] flex items-start justify-between gap-1 hover:border-[#af4408]`}>
          {/* Wrap the full name across lines instead of truncating with an
              ellipsis. Long names like "EXTRA VIRGIN OLIVE OIL POMACE 1 LTR"
              were getting cut at the end — now the whole string is visible. */}
          <span className="break-words leading-snug min-w-0 flex-1">
            {picked.sku && <span className="text-[#8B7355] font-mono">{picked.sku} — </span>}
            <span className="text-[#2D1B0E]">{picked.name}</span>
            {displayUnit(picked) && <span className="text-[#8B7355]"> ({displayUnit(picked)})</span>}
            {/* The picked value is NEVER filtered away (an open document keeps
                its line), so a switched-off one says so where it is shown. */}
            {isSwitchedOff(picked) && (
              <span title={inactive === 'hide'
                      ? 'Switched off in Raw Materials — kept on this line, but not offered here for new lines'
                      : inactive === 'with-stock'
                        ? 'Switched off in Raw Materials — offered here only while it still has stock'
                        : 'Switched off in Raw Materials'}
                    className="ml-1 text-[9px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 border border-gray-300 rounded px-1 py-px">
                Inactive
              </span>
            )}
          </span>
          <X size={11} className="text-[#8B7355] hover:text-red-700 mt-0.5 shrink-0"
             onClick={(e) => { e.stopPropagation(); clear(); }} />
        </button>
      ) : (
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            type="text" value={query} autoFocus={open}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            placeholder={placeholder}
            className={`w-full pl-6 pr-2 ${inputSize} border border-[#D4B896] rounded bg-white focus:outline-none focus:border-[#af4408]`}
          />
        </div>
      )}

      {/* Dropdown is PORTALED to <body> with fixed positioning so no ancestor
          overflow (modal, scroll pane, overflow-x-auto table) can clip it. */}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={dropRef}
             style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
             className="z-[100] max-w-[calc(100vw-1rem)]">
          {results.length > 0 ? (
            <ul className="max-h-[55vh] overflow-y-auto overscroll-contain bg-white border border-[#D4B896] rounded shadow-lg">
              <li className="sticky top-0 z-10 bg-[#FFF8F0] border-b border-[#E8D5C4] px-2 py-1 text-[10px] text-[#8B7355]">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    {results.length}{results.length >= 1000 ? '+' : ''} material{results.length === 1 ? '' : 's'}{query.trim() ? ' matched' : ''}
                    {offNote && (
                      <span className="text-gray-500"
                            title="Switched off in Raw Materials. An admin can switch an item back on there.">
                        {' · '}{offNote}
                        {/* A search NAMES them on screen — a hover-only name is
                            how the nearest other match got picked by mistake. */}
                        {offNames && <>: <b className="text-[#6B5744]">{offNames}</b></>}
                      </span>
                    )}
                  </span>
                  <span className="text-[#B99] hidden sm:inline">type to filter · scroll for more</span>
                </div>
                {exactOff && (
                  <div className="mt-0.5 text-[10px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                    <b>{exactOff.name}</b> is switched off in Raw Materials{inactive === 'with-stock' ? ' and has no stock here' : ''} — not offered on this screen, so Enter picks nothing.
                    {' '}The rows below are other items: use ↑/↓ or click to choose one. An admin can switch it back on in Raw Materials.
                  </div>
                )}
              </li>
              {results.map((m, i) => {
                const isActive = i === active;
                const blocked = isBlocked(m);
                const lowStock = !!(m.reorder_level && m.current_stock != null && m.current_stock < m.reorder_level);
                return (
                  <li key={m.id}
                      onMouseDown={(e) => { e.preventDefault(); choose(m); }}
                      onMouseEnter={() => { if (!blocked) setActive(i); }}
                      title={blocked
                        ? `${m.name} is already on this bill — one material, one line`
                        : `${m.sku ? m.sku + ' — ' : ''}${m.name}`}
                      className={`px-2 ${itemSize} flex items-start justify-between gap-2 ${
                        blocked
                          ? 'cursor-not-allowed bg-[#F5F2EE] opacity-60'
                          : `cursor-pointer ${isActive ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
                        {m.sku && <span className={`text-[10px] font-mono ${blocked ? 'text-[#A9A29B]' : 'text-[#8B7355]'}`}>{m.sku}</span>}
                        {/* break-words = the full name is always visible, wrapping if needed */}
                        <span className={`break-words leading-snug ${blocked ? 'text-[#8A8178] line-through' : 'text-[#2D1B0E]'}`}>{m.name}</span>
                        {blocked && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-800 bg-amber-100 border border-amber-300 rounded px-1 py-px">
                            Already added
                          </span>
                        )}
                        {isSwitchedOff(m) && (
                          <span title={inactive === 'with-stock'
                                  ? 'Switched off in Raw Materials — listed here only while it still has stock'
                                  : 'Switched off in Raw Materials'}
                                className="text-[9px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 border border-gray-300 rounded px-1 py-px">
                            Inactive
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] text-[#8B7355] flex gap-2 flex-wrap mt-0.5">
                        {m.category && <span>{m.category}</span>}
                        {showStock && m.current_stock != null && (() => {
                          const d = displayStock(m);
                          return (
                            <span className={lowStock ? 'text-red-700 font-semibold' : ''}>
                              on hand: {fmtQtyNum(d.qty)} {d.unit}{lowStock ? ' ⚠' : ''}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            // Never render an invisible/empty dropdown (reads as "broken").
            // Distinguish "search matched nothing" from "no materials loaded".
            <div className="bg-white border border-[#D4B896] rounded shadow-lg p-2 text-[11px] text-[#8B7355]">
              {notOffered.length > 0 ? (
                // Something DID match — it is switched off. Say which, so nobody
                // concludes the item is missing and creates a second one.
                query.trim()
                  ? <>No active material matches &quot;{query}&quot;. Switched off in Raw Materials (not offered here): <b className="text-[#6B5744]">{offNames}</b>. An admin can switch it back on there.</>
                  : <>No active material left to pick — {offNote}.</>
              ) : query.trim()
                ? <>No materials match &quot;{query}&quot;.</>
                : <>No materials loaded yet — if this list stays empty, refresh the page.</>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
