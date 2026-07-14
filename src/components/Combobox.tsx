'use client';

/**
 * Portaled combobox — a click-to-open dropdown that lists all options, filters
 * as you type, and (optionally) accepts a free-typed custom value. The dropdown
 * is rendered to <body> with position:fixed so it is NEVER clipped by an
 * ancestor's overflow (modals, scroll panes, overflow-x tables) — the same
 * clipping bug that hid the material picker inside the GRN/PO modals.
 *
 * Used for the GRN/PO vendor field (allowCustom = ad-hoc vendors allowed).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface ComboOption { value: string; label: string; hint?: string }

export default function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Type or pick…',
  allowCustom = false,
  className = '',
}: {
  options: ComboOption[];
  /** current display text (label or free-typed value) */
  value: string;
  /** called with the chosen option (or the typed text when allowCustom) */
  onChange: (v: string, opt: ComboOption | null) => void;
  placeholder?: string;
  allowCustom?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null = show `value`
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const computePos = () => {
    const el = wrapRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
  };

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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !dropRef.current?.contains(t)) { setOpen(false); setQuery(null); }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const results = useMemo(() => {
    const raw = (query ?? '').trim().toLowerCase();
    if (!raw) return options;
    return options.filter(o => o.label.toLowerCase().includes(raw));
  }, [options, query]);

  const pick = (o: ComboOption) => { onChange(o.value, o); setOpen(false); setQuery(null); };

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <input
          type="text"
          value={query ?? value}
          onChange={e => {
            setQuery(e.target.value);
            setOpen(true);
            if (allowCustom) onChange(e.target.value, options.find(o => o.label.toLowerCase().trim() === e.target.value.toLowerCase().trim()) || null);
          }}
          onFocus={() => { setOpen(true); setQuery(''); }}
          placeholder={placeholder}
          className={className || 'w-full pr-6 px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm focus:outline-none focus:border-[#af4408]'}
        />
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
      </div>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div ref={dropRef}
             style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
             className="z-[100] max-w-[calc(100vw-1rem)]">
          {results.length > 0 ? (
            <ul className="max-h-[50vh] overflow-y-auto overscroll-contain bg-white border border-[#D4B896] rounded shadow-lg text-sm">
              <li className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-2 py-1 text-[10px] text-[#8B7355]">
                {results.length} option{results.length === 1 ? '' : 's'}{(query ?? '').trim() ? ' matched' : ''}
              </li>
              {results.map(o => (
                <li key={o.value}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                    className="px-2 py-1.5 cursor-pointer hover:bg-[#FFF8F0] text-[#2D1B0E] break-words leading-snug">
                  {o.label}{o.hint && <span className="text-[#8B7355] text-[11px]"> · {o.hint}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="bg-white border border-[#D4B896] rounded shadow-lg p-2 text-[11px] text-[#8B7355]">
              {options.length === 0
                ? <>No options loaded yet — refresh if this stays empty.</>
                : allowCustom
                  ? <>No match — &quot;{query}&quot; will be used as a new entry.</>
                  : <>No match for &quot;{query}&quot;.</>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
