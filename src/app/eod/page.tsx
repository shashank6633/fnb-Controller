'use client';

/**
 * Mobile-first EOD Stock Count.
 * One material at a time. Big number-pad. Thumb-friendly. Optimised for the
 * staff who walk around the kitchen at 11 PM with a phone.
 *
 * Flow:
 *   1. Pick a storage location (chip)
 *   2. See first un-counted item → tap a count on the keypad → Save → next
 *   3. Or tap "Skip" if you can't count this one right now
 *   4. Progress bar shows N of M counted in this location
 *
 * Falls back to a desktop-friendly version if the viewport is wide.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Check, Loader2, SkipForward, MapPin } from 'lucide-react';
import { api } from '@/lib/api';

interface LocSummary { location: string; items: number; counted_today: number; }
interface Item {
  id: string; sku?: string; name: string; unit: string; purchase_unit?: string;
  pack_size?: number; current_stock: number; reorder_level?: number;
  today_count: number | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function EODPage() {
  const [phase, setPhase] = useState<'pick-location' | 'counting' | 'done'>('pick-location');
  const [locations, setLocations] = useState<LocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLoc, setActiveLoc] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [keypad, setKeypad] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/closing-stock/locations?date=${today()}`)
      .then(r => r.json())
      .then(d => { setLocations(d.locations || []); setLoading(false); });
  }, []);

  const enterLocation = async (loc: string) => {
    setActiveLoc(loc); setLoading(true); setSkipped(new Set());
    const qs = new URLSearchParams({ date: today(), location: loc === '— Unassigned —' ? '__unassigned__' : loc });
    const d = await fetch(`/api/closing-stock/by-location?${qs}`).then(r => r.json());
    const pending = (d.items || []).filter((i: Item) => i.today_count == null);
    setItems(pending);
    setActiveIdx(0);
    setKeypad('');
    setPhase(pending.length === 0 ? 'done' : 'counting');
    setLoading(false);
  };

  const active = items[activeIdx];
  const remaining = items.filter(i => i.today_count == null && !skipped.has(i.id)).length;
  const counted = items.filter(i => i.today_count != null).length;

  const tap = (ch: string) => {
    setError('');
    if (ch === '⌫') { setKeypad(k => k.slice(0, -1)); return; }
    if (ch === '.' && keypad.includes('.')) return;
    if (keypad.length >= 8) return;
    setKeypad(k => k + ch);
  };

  const advance = () => {
    // Next un-counted, un-skipped
    let next = activeIdx + 1;
    while (next < items.length && (items[next].today_count != null || skipped.has(items[next].id))) next++;
    if (next >= items.length) setPhase('done');
    else { setActiveIdx(next); setKeypad(''); }
  };

  const saveCount = async () => {
    if (!active || !keypad || isNaN(Number(keypad))) { setError('Enter a number first'); return; }
    setSaving(true);
    try {
      const inPurchase = !!(active.pack_size && active.pack_size > 1);
      const physical = Number(keypad) * (inPurchase ? active.pack_size! : 1);
      const r = await api('/api/closing-stock', {
        method: 'POST',
        body: { date: today(), items: [{ material_id: active.id, physical_stock: physical }] },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || 'Save failed'); setSaving(false); return; }
      // Mark this item counted locally so we don't re-fetch the whole list
      setItems(prev => prev.map(i => i.id === active.id ? { ...i, today_count: physical } : i));
      advance();
    } finally { setSaving(false); }
  };

  const skipItem = () => {
    if (!active) return;
    setSkipped(s => new Set(s).add(active.id));
    advance();
  };

  // ── PHASE: pick location ──
  if (phase === 'pick-location') {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-4 space-y-4">
        <div className="text-center pt-2">
          <h1 className="text-2xl font-bold text-[#2D1B0E]">EOD Count</h1>
          <p className="text-xs text-[#8B7355] mt-1">Pick a storage area to start counting</p>
        </div>
        {loading ? (
          <div className="text-center py-20"><Loader2 className="animate-spin inline" size={28} /></div>
        ) : locations.length === 0 ? (
          <div className="bg-white rounded-2xl p-6 text-center text-sm text-[#8B7355]">
            No materials yet. Set <code>storage_location</code> on inventory items first.
          </div>
        ) : (
          <div className="space-y-2">
            {locations.map(l => {
              const pct = l.items > 0 ? Math.round((l.counted_today / l.items) * 100) : 0;
              const done = l.items > 0 && l.counted_today === l.items;
              return (
                <button key={l.location} onClick={() => enterLocation(l.location)}
                        className={`w-full text-left bg-white rounded-2xl p-4 active:scale-[0.98] transition border ${done ? 'border-emerald-300' : 'border-[#E8D5C4]'} shadow-sm`}>
                  <div className="flex items-start gap-3">
                    <MapPin className={`shrink-0 mt-0.5 ${done ? 'text-emerald-600' : 'text-[#af4408]'}`} size={20} />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[#2D1B0E] text-base">{l.location}</div>
                      <div className="text-xs text-[#6B5744] mt-1">
                        <strong className="text-[#2D1B0E]">{l.items}</strong> items · {l.counted_today} counted
                      </div>
                      <div className="mt-2 h-2 bg-[#FFF1E3] rounded-full overflow-hidden">
                        <div className={`h-full ${done ? 'bg-emerald-500' : 'bg-[#af4408]'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    {done && <Check size={20} className="text-emerald-600 shrink-0 mt-1" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── PHASE: done ──
  if (phase === 'done') {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-4 flex flex-col items-center justify-center">
        <div className="bg-white rounded-2xl p-6 text-center max-w-sm w-full shadow">
          <div className="text-5xl mb-2">✓</div>
          <h2 className="text-xl font-bold text-emerald-700">All done</h2>
          <p className="text-sm text-[#6B5744] mt-1">
            {counted} counted in <strong>{activeLoc}</strong>{skipped.size > 0 && ` · ${skipped.size} skipped`}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button onClick={() => { setPhase('pick-location'); setActiveLoc(null); setItems([]); }}
                    className="w-full py-3 bg-[#af4408] text-white rounded-xl text-sm font-medium">
              Count another location
            </button>
            <a href="/closing-stock" className="w-full py-3 bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium text-center">
              Open desktop view
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── PHASE: counting ──
  if (loading || !active) {
    return <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center"><Loader2 className="animate-spin" size={28} /></div>;
  }
  const inPurchase = !!(active.pack_size && active.pack_size > 1);
  const sysDisplay = inPurchase
    ? `${(active.current_stock / active.pack_size!).toFixed(2)} ${active.purchase_unit}`
    : `${active.current_stock} ${active.unit}`;
  const isLow = (active.current_stock || 0) < (active.reorder_level || 0);
  const pct = items.length > 0 ? Math.round((counted / items.length) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#FFF8F0] flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-[#E8D5C4] px-4 py-3 flex items-center gap-3">
        <button onClick={() => setPhase('pick-location')} className="text-[#6B5744]">
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{activeLoc}</div>
          <div className="text-xs text-[#6B5744]">
            <strong className="text-[#2D1B0E]">{counted}</strong> of {items.length} · {remaining} left
          </div>
        </div>
        <div className="w-12 h-12 relative">
          <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#FFF1E3" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#af4408" strokeWidth="3"
                    strokeDasharray="100 100" strokeDashoffset={100 - pct} pathLength={100} />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[#2D1B0E]">{pct}%</div>
        </div>
      </div>

      {/* Current item */}
      <div className="px-4 pt-6 pb-3">
        <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">{active.sku || 'No SKU'}</div>
        <div className="text-xl font-bold text-[#2D1B0E] mt-0.5">{active.name}</div>
        <div className="mt-2 flex items-center gap-2 flex-wrap text-xs">
          <span className="px-2 py-1 rounded bg-[#FFF1E3] text-[#6B5744]">
            System: <strong className="text-[#2D1B0E]">{sysDisplay}</strong>
          </span>
          {isLow && <span className="px-2 py-1 rounded bg-red-100 text-red-700 font-semibold">LOW</span>}
        </div>
      </div>

      {/* Display value */}
      <div className="px-4 py-3">
        <div className="bg-white border-2 border-[#D4B896] rounded-2xl p-5 text-center">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Physical count</div>
          <div className="text-4xl font-bold text-[#2D1B0E] mt-1 font-mono min-h-[3rem]">
            {keypad || <span className="text-[#D4B896]">0</span>}
          </div>
          <div className="text-xs text-[#6B5744] mt-1">{inPurchase ? active.purchase_unit : active.unit}</div>
          {error && <div className="text-[10px] text-red-700 mt-1">{error}</div>}
        </div>
      </div>

      {/* Number-pad */}
      <div className="px-3 pb-3 flex-1">
        <div className="grid grid-cols-3 gap-2">
          {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map(ch => (
            <button key={ch} onClick={() => tap(ch)}
                    className="bg-white border border-[#E8D5C4] rounded-xl text-2xl font-semibold text-[#2D1B0E] py-4 active:bg-[#FFF1E3] shadow-sm">
              {ch}
            </button>
          ))}
        </div>
      </div>

      {/* Action bar */}
      <div className="bg-white border-t border-[#E8D5C4] px-3 py-3 grid grid-cols-2 gap-2">
        <button onClick={skipItem}
                className="py-4 bg-[#FFF1E3] text-[#6B5744] rounded-xl font-semibold flex items-center justify-center gap-2">
          <SkipForward size={18} /> Skip
        </button>
        <button onClick={saveCount} disabled={saving || !keypad}
                className="py-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-xl font-semibold flex items-center justify-center gap-2">
          {saving ? <Loader2 className="animate-spin" size={18} /> : <Check size={18} />}
          Save &amp; next
        </button>
      </div>
    </div>
  );
}
