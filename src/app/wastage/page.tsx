'use client';

/**
 * Wastage entry — Phase 1 §6 Daily Closing SOP, "Entering Wastages".
 * Captures spoiled / expired / damaged / overcooked / spilled / other lost items.
 * Each entry decrements current_stock and writes inventory_transactions(type='wastage').
 */

import { useEffect, useMemo, useState } from 'react';
import { Trash2, Plus, Calendar, Save, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

interface Material { id: string; name: string; sku?: string; unit: string; average_price: number; pack_size?: number; purchase_unit?: string; }
interface Wastage {
  id: string; date: string; material_id: string;
  material_name: string; material_unit: string; material_sku?: string;
  quantity: number; reason: string; notes?: string;
  recipe_id?: string; recipe_name?: string;
  recorded_by?: string; value: number;
}

const REASONS = [
  { v: 'spoilage',   label: 'Spoilage (went bad)' },
  { v: 'expiry',     label: 'Expired (past shelf-life)' },
  { v: 'damage',     label: 'Damage (broken, leaked)' },
  { v: 'overcooked', label: 'Overcooked / Burnt' },
  { v: 'spillage',   label: 'Spillage' },
  { v: 'other',      label: 'Other' },
];
const REASON_TONE: Record<string, string> = {
  spoilage:   'bg-amber-100 text-amber-800',
  expiry:     'bg-red-100 text-red-700',
  damage:     'bg-orange-100 text-orange-700',
  overcooked: 'bg-red-50 text-red-700',
  spillage:   'bg-blue-50 text-blue-700',
  other:      'bg-[#E8D5C4] text-[#6B5744]',
};

export default function WastagePage() {
  const [list, setList] = useState<Wastage[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0,10); });
  const [to, setTo] = useState(today());
  const [reasonFilter, setReasonFilter] = useState('');

  // New entry form
  const [date, setDate] = useState(today());
  const [matId, setMatId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('spoilage');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    const [w, m] = await Promise.all([
      fetch(`/api/wastage?${qs}`).then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()).catch(() => ({ materials: [] })),
    ]);
    setList(w.wastages || []);
    setMaterials(m.materials || []);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to]);

  const filtered = useMemo(() =>
    reasonFilter ? list.filter(w => w.reason === reasonFilter) : list, [list, reasonFilter]);

  const totalValue = filtered.reduce((s, w) => s + (w.value || 0), 0);
  const byReason = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {};
    for (const w of filtered) {
      const slot = m[w.reason] || (m[w.reason] = { count: 0, value: 0 });
      slot.count += 1; slot.value += w.value || 0;
    }
    return m;
  }, [filtered]);

  const submit = async () => {
    if (!matId || !qty) { alert('Pick a material and qty'); return; }
    setSaving(true);
    try {
      const r = await api('/api/wastage', {
        method: 'POST',
        body: { date, material_id: matId, quantity: parseFloat(qty), reason, notes },
      });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      setMatId(''); setQty(''); setNotes('');
      reload();
    } finally { setSaving(false); }
  };

  const remove = async (w: Wastage) => {
    if (!confirm(`Delete wastage entry? Stock will be credited back (+${w.quantity} ${w.material_unit}).`)) return;
    const r = await api(`/api/wastage?id=${w.id}`, { method: 'DELETE', body: {} });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
    reload();
  };

  const selectedMat = materials.find(m => m.id === matId);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Trash2 className="w-6 h-6 text-red-600" /> Wastage Log
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Record spoilage / expiry / damage / spillage. Each entry deducts from stock and counts toward variance.
          </p>
        </div>
      </div>

      {/* New entry */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2"><Plus className="w-4 h-4" /> Record Wastage</h3>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 text-xs items-end">
          <label className="flex flex-col gap-1 text-[#6B5744] md:col-span-2">
            <span><Calendar className="w-3 h-3 inline" /> Date</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
          </label>
          <div className="flex flex-col gap-1 text-[#6B5744] md:col-span-4">
            <span>Material</span>
            <MaterialTypeahead
              materials={materials as any}
              value={matId}
              onPick={setMatId}
              compact={false}
            />
          </div>
          <label className="flex flex-col gap-1 text-[#6B5744] md:col-span-2">
            <span>Quantity</span>
            <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)}
                   placeholder={selectedMat ? `in ${selectedMat.unit}` : '0'}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono" />
            {selectedMat && (
              <span className="text-[10px] text-[#8B7355]">
                @ {fmt(selectedMat.average_price * (parseFloat(qty) || 0))} loss
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744] md:col-span-2">
            <span>Reason</span>
            <select value={reason} onChange={e => setReason(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]">
              {REASONS.map(r => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
          </label>
          <button onClick={submit} disabled={saving || !matId || !qty}
                  className="md:col-span-2 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm flex items-center justify-center gap-1.5 disabled:opacity-50">
            <Save className="w-4 h-4" /> {saving ? 'Recording…' : 'Record'}
          </button>
        </div>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional — e.g. who, where, batch ID)"
               className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
      </div>

      {/* Date filter + reason chips */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[#6B5744]">Range:</span>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        <span>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        <button onClick={() => setReasonFilter('')} className={`px-2 py-0.5 rounded border ${reasonFilter === '' ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white border-[#E8D5C4]'}`}>All</button>
        {REASONS.map(r => {
          const stats = byReason[r.v];
          if (!stats) return null;
          const active = reasonFilter === r.v;
          return (
            <button key={r.v} onClick={() => setReasonFilter(active ? '' : r.v)}
                    className={`px-2 py-0.5 rounded border text-[10px] ${active ? 'bg-[#af4408] text-white border-[#af4408]' : REASON_TONE[r.v]}`}>
              {r.label.split(' ')[0]} <span className="font-mono ml-1">{stats.count} · {fmt(stats.value)}</span>
            </button>
          );
        })}
        <span className="ml-auto text-[#6B5744]">Total loss: <b className="text-red-700 font-mono">{fmt(totalValue)}</b></span>
      </div>

      {/* List */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">No wastage entries in this range. Use the form above to record one.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[720px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left  py-1.5 px-3 font-medium">Date</th>
                <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                <th className="text-right py-1.5 px-3 font-medium">Qty</th>
                <th className="text-right py-1.5 px-3 font-medium">Loss ₹</th>
                <th className="text-left  py-1.5 px-3 font-medium">Reason</th>
                <th className="text-left  py-1.5 px-3 font-medium">Notes</th>
                <th className="text-left  py-1.5 px-3 font-medium">By</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(w => (
                <tr key={w.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                  <td className="py-1.5 px-3">{w.date}</td>
                  <td className="py-1.5 px-3">
                    <div className="font-medium">{w.material_name}</div>
                    {w.material_sku && <div className="text-[10px] font-mono text-[#8B7355]">{w.material_sku}</div>}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono">{w.quantity.toLocaleString('en-IN')} {w.material_unit}</td>
                  <td className="py-1.5 px-3 text-right font-mono text-red-700 font-semibold">{fmt(w.value)}</td>
                  <td className="py-1.5 px-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${REASON_TONE[w.reason] || ''}`}>
                      {w.reason}
                    </span>
                  </td>
                  <td className="py-1.5 px-3 text-[#6B5744]">{w.notes || ''}</td>
                  <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">{w.recorded_by || ''}</td>
                  <td className="py-1.5 px-3 text-right">
                    <button onClick={() => remove(w)} className="text-red-600 hover:text-red-800" title="Delete + credit stock back"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
