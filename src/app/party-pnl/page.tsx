'use client';

/**
 * Party P&L page — one-stop view of per-party profit & loss.
 *
 * Revenue   = Party Bookings sheet (col U) matched by party_unique_id
 * Food Cost = party requisition items × material avg price (by event)
 * Liquor Cost = party_consumption × material avg price (snapshotted)
 * Profit    = Revenue − (Food + Liquor)
 *
 * Bar manager records bottle counts the night of / morning after the event
 * via the "Record liquor" button on each row.
 */

import { useEffect, useState } from 'react';
import { Wine, Loader2, RefreshCw, AlertTriangle, Plus, X } from 'lucide-react';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');

interface PnLRow {
  party_unique_id?: string;
  fp_id?: string;
  event_name: string;
  event_date: string;
  guest_name?: string;
  pax?: number;
  revenue: number;
  food_cost: number;
  food_items: number;
  liquor_cost: number;
  liquor_items: number;
  total_cost: number;
  profit: number;
  margin_pct: number;
  has_revenue: boolean;
  has_liquor_recorded: boolean;
}

export default function PartyPnLPage() {
  const [rows, setRows] = useState<PnLRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'past' | 'all'>('past');
  const [recordFor, setRecordFor] = useState<PnLRow | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/party-events/pnl');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setRows(j.pnl || []);
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true); setError(null);
    try {
      await fetch('/api/party-bookings', { method: 'POST' });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const visible = rows
    .filter(r => r.event_date && (filter === 'all' || new Date(r.event_date) < todayStart))
    .sort((a, b) => b.event_date.localeCompare(a.event_date));



  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Wine className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party Liquor Consumption</h1>
          <p className="text-xs text-[#8B7355]">
            Record bottle / unit counts consumed after each party. Bar manager updates the night-of or next morning.
            Cost auto-pulls from each material&apos;s average purchase price.
          </p>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8D5C4] bg-amber-50/40 flex items-center gap-3 flex-wrap">
          <Wine size={16} className="text-amber-700" />
          <div className="flex-1 min-w-0 text-[10px] text-[#8B7355]">
            Showing {filter === 'past' ? 'past' : 'all'} events from the AKAN Party Manager sheet.
            Refresh to re-pull the event list.
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white">
            <option value="past">Past events</option>
            <option value="all">All events</option>
          </select>
          <button onClick={refresh} disabled={refreshing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded disabled:opacity-50">
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Loading events…
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-sm text-red-700"><AlertTriangle size={14} className="inline mr-1" />{error}</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">No events to show. Past events appear here automatically.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">Event</th>
                  <th className="text-right py-2 px-3 font-medium">Pax</th>
                  <th className="text-left  py-2 px-3 font-medium">Liquor recorded</th>
                  <th className="text-right py-2 px-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={(r.party_unique_id || r.fp_id || r.event_name) + i}
                      className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                    <td className="py-1.5 px-3 font-mono whitespace-nowrap">{r.event_date}</td>
                    <td className="py-1.5 px-3">
                      <div className="font-medium text-[#2D1B0E]">{r.event_name}</div>
                      {r.fp_id && <div className="text-[9px] font-mono text-[#af4408]">{r.fp_id}</div>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">{r.pax || '—'}</td>
                    <td className="py-1.5 px-3">
                      {r.has_liquor_recorded
                        ? <span className="inline-flex items-center gap-1 text-emerald-700">
                            ✓ {r.liquor_items} item{r.liquor_items === 1 ? '' : 's'} recorded
                          </span>
                        : <span className="text-amber-700 text-[10px]">not recorded yet</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <button onClick={() => setRecordFor(r)}
                              className="inline-flex items-center gap-1 text-xs text-white bg-[#af4408] hover:bg-[#933807] px-2.5 py-1 rounded whitespace-nowrap">
                        <Plus size={11} /> {r.has_liquor_recorded ? 'Add more' : 'Record liquor'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {recordFor && (
        <RecordConsumptionModal
          target={recordFor}
          onClose={() => setRecordFor(null)}
          onSaved={() => { setRecordFor(null); load(); }}
        />
      )}
    </div>
  );
}

function RecordConsumptionModal({ target, onClose, onSaved }: {
  target: PnLRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [materials, setMaterials] = useState<any[]>([]);
  const [lines, setLines] = useState<{ material_id: string; qty: string; notes: string }[]>([
    { material_id: '', qty: '', notes: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(d => setMaterials(d.materials || d || []));
  }, []);

  const addLine = () => setLines(p => [...p, { material_id: '', qty: '', notes: '' }]);
  const removeLine = (i: number) => setLines(p => p.filter((_, idx) => idx !== i));
  const update = (i: number, patch: any) => setLines(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  const totalCost = lines.reduce((acc, l) => {
    const m = materials.find(x => x.id === l.material_id);
    const q = Number(l.qty) || 0;
    return acc + q * (m?.average_price || 0);
  }, 0);

  const submit = async () => {
    const cleaned = lines.filter(l => l.material_id && Number(l.qty) > 0);
    if (cleaned.length === 0) { setError('Add at least one item with qty > 0'); return; }
    setSaving(true); setError(null);
    try {
      const r = await fetch('/api/party-consumption', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          party_unique_id: target.party_unique_id,
          fp_id: target.fp_id,
          event_name: target.event_name,
          event_date: target.event_date,
          items: cleaned.map(l => ({ material_id: l.material_id, qty: Number(l.qty), notes: l.notes })),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-3xl my-4 flex flex-col max-h-[calc(100vh-2rem)]"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-[#2D1B0E]">Record Post-Party Consumption</h2>
            <div className="text-xs text-[#8B7355] mt-0.5">
              {target.event_name} · {target.event_date} {target.fp_id && <span className="font-mono text-[#af4408]">· {target.fp_id}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          <div className="text-xs text-[#6B5744] bg-amber-50 border border-amber-200 rounded p-2">
            Enter bottle / unit counts consumed at this event. Cost auto-pulls from each material's average purchase price.
            Save to lock in liquor cost on the P&amp;L.
          </div>

          <div className="grid grid-cols-12 gap-2 text-[10px] font-medium text-[#8B7355] uppercase tracking-wide px-1">
            <div className="col-span-6">Material</div>
            <div className="col-span-2 text-right">Qty</div>
            <div className="col-span-1">Unit</div>
            <div className="col-span-2 text-right">Cost</div>
          </div>

          {lines.map((l, i) => {
            const m = materials.find(x => x.id === l.material_id);
            const cost = (Number(l.qty) || 0) * (m?.average_price || 0);
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-6">
                  <MaterialTypeahead
                    materials={materials as any}
                    value={l.material_id}
                    onPick={(id: string) => update(i, { material_id: id })}
                    excludeIds={lines.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                  />
                </div>
                <input type="number" step="any" value={l.qty}
                       onChange={e => update(i, { qty: e.target.value })}
                       placeholder="Qty"
                       className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
                <span className="col-span-1 text-xs text-[#8B7355] py-2">{m?.unit || ''}</span>
                <div className="col-span-2 flex items-center justify-end gap-1">
                  <span className="text-xs font-mono text-[#6B5744]"
                        title={m?.average_price ? `₹${m.average_price}/${m.unit}` : ''}>
                    {fmt(cost)}
                  </span>
                  <button type="button" onClick={() => removeLine(i)}
                          className="text-red-600 hover:text-red-700"><X size={12} /></button>
                </div>
                <input value={l.notes} onChange={e => update(i, { notes: e.target.value })}
                       placeholder="Line notes (optional)"
                       className="col-span-12 px-2 py-1 border border-[#E8D5C4] rounded text-[11px] text-[#6B5744] -mt-1" />
              </div>
            );
          })}

          <button type="button" onClick={addLine}
                  className="text-xs text-[#af4408] hover:underline inline-flex items-center gap-1">
            <Plus size={12} /> Add line
          </button>

          <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-3 flex items-center justify-between">
            <div className="text-xs text-[#8B7355]">Total liquor cost being recorded</div>
            <div className="text-lg font-bold text-[#2D1B0E]">{fmt(totalCost)}</div>
          </div>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Cancel</button>
          <button onClick={submit} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            {saving ? 'Saving…' : 'Save Consumption'}
          </button>
        </div>
      </div>
    </div>
  );
}
