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
 *   excludeIds — material ids to grey out (e.g. already added on other rows)
 *   placeholder — input placeholder when no selection
 *   compact    — render at xs size (for embedded grids); else sm
 *
 * Keyboard:
 *   ↑/↓ navigate · Enter pick · Esc close · click outside closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export interface MaterialLite {
  id: string;
  name: string;
  sku?: string;
  unit?: string;
  category?: string;
  current_stock?: number;
  reorder_level?: number;
}

export default function MaterialTypeahead({
  materials,
  value,
  onPick,
  excludeIds = [],
  placeholder = 'Type material name, SKU or category…',
  compact = true,
  showStock = true,
}: {
  materials: MaterialLite[];
  value: string;
  onPick: (id: string) => void;
  excludeIds?: string[];
  placeholder?: string;
  compact?: boolean;
  showStock?: boolean;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const picked = useMemo(() => materials.find(m => m.id === value) || null, [materials, value]);

  const results = useMemo(() => {
    const raw = query.trim().toLowerCase();
    const excluded = new Set(excludeIds);
    let list = materials.filter(m => !excluded.has(m.id));
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
      list = list.filter(m => {
        const hay = [
          m.name, m.sku, m.category, m.unit,
        ].filter(Boolean).join(' ').toLowerCase();
        return tokens.every(t => hay.includes(t));
      });
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
    // Larger cap when a query is active — substring matches across 900+
    // materials can blow past 80 easily and the user's target shouldn't get
    // truncated. Empty-query view keeps the cap small for snappy first paint.
    return list.slice(0, raw ? 200 : 80);
  }, [materials, query, excludeIds]);

  useEffect(() => { setActive(0); }, [query]);

  const choose = (m: MaterialLite) => {
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
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter')     { if (results[active]) { e.preventDefault(); choose(results[active]); } }
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
                title={`${picked.sku ? picked.sku + ' — ' : ''}${picked.name}${picked.unit ? ' (' + picked.unit + ')' : ''}`}
                className={`w-full text-left px-2 ${buttonSize} border border-[#E8D5C4] rounded bg-[#FFF8F0] flex items-start justify-between gap-1 hover:border-[#af4408]`}>
          {/* Wrap the full name across lines instead of truncating with an
              ellipsis. Long names like "EXTRA VIRGIN OLIVE OIL POMACE 1 LTR"
              were getting cut at the end — now the whole string is visible. */}
          <span className="break-words leading-snug min-w-0 flex-1">
            {picked.sku && <span className="text-[#8B7355] font-mono">{picked.sku} — </span>}
            <span className="text-[#2D1B0E]">{picked.name}</span>
            {picked.unit && <span className="text-[#8B7355]"> ({picked.unit})</span>}
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

      {open && results.length > 0 && (
        // Dropdown can overflow the parent column up to 480px wide so long
        // material names fit on a single line wherever possible.
        <ul className="absolute z-30 left-0 mt-1 max-h-72 overflow-y-auto bg-white border border-[#D4B896] rounded shadow-lg
                       w-full min-w-full sm:min-w-[360px] max-w-[480px]">
          {results.map((m, i) => {
            const isActive = i === active;
            const lowStock = !!(m.reorder_level && m.current_stock != null && m.current_stock < m.reorder_level);
            return (
              <li key={m.id}
                  onMouseDown={(e) => { e.preventDefault(); choose(m); }}
                  onMouseEnter={() => setActive(i)}
                  title={`${m.sku ? m.sku + ' — ' : ''}${m.name}`}
                  className={`px-2 ${itemSize} cursor-pointer flex items-start justify-between gap-2 ${
                    isActive ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
                    {m.sku && <span className="text-[10px] font-mono text-[#8B7355]">{m.sku}</span>}
                    {/* break-words = the full name is always visible, wrapping if needed */}
                    <span className="text-[#2D1B0E] break-words leading-snug">{m.name}</span>
                  </div>
                  <div className="text-[9px] text-[#8B7355] flex gap-2 flex-wrap mt-0.5">
                    {m.category && <span>{m.category}</span>}
                    {showStock && m.current_stock != null && (
                      <span className={lowStock ? 'text-red-700 font-semibold' : ''}>
                        on hand: {m.current_stock} {m.unit}{lowStock ? ' ⚠' : ''}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open && query.trim() && results.length === 0 && (
        <div className="absolute z-30 left-0 mt-1 w-full max-w-[480px] bg-white border border-[#D4B896] rounded shadow-lg p-2 text-[11px] text-[#8B7355]">
          No materials match &quot;{query}&quot;.
        </div>
      )}
    </div>
  );
}
