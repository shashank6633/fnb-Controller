'use client';

/**
 * Department Materials (Party) — what each department is currently HOLDING after
 * party requisitions were fulfilled (store → dept transfer). Each card lists the
 * department's on-hand materials with a ₹ value estimate.
 *
 * "Reconcile after party" opens a modal listing that department's on-hand
 * materials. For each, the user records the LEFTOVER quantity (the rest is
 * treated as consumed) and can toggle "return to store" to push the leftover
 * back into the main store. POSTs /api/department-materials/reconcile then reloads.
 */

import { useEffect, useMemo, useState } from 'react';
import { Warehouse, Loader2, ClipboardCheck, X, RotateCcw, Package } from 'lucide-react';
import { api } from '@/lib/api';

const fmt  = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const fmt2 = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);

interface Item { material_id: string; name: string; unit: string; on_hand: number; avg_price: number; value: number; }
interface Dept { department_id: string; name: string; code: string; items: Item[]; }

export default function DepartmentMaterialsPage() {
  const [data, setData] = useState<{ by_department: Dept[]; summary: { total_value: number } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconcileDept, setReconcileDept] = useState<Dept | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const j = await fetch('/api/department-materials').then(r => r.json());
      setData(j);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const depts = data?.by_department || [];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Warehouse className="w-6 h-6 text-[#af4408]" /> Department Materials (Party)
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Materials each department is currently holding after party requisitions were fulfilled.
            <span className="block italic">Store issued → department on-hand. Reconcile after the party to record leftover / consumption.</span>
          </p>
        </div>
        {data?.summary && (
          <div className="bg-white border border-[#E8D5C4] rounded-lg p-3 text-right">
            <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">Total On-Hand Value</div>
            <div className="text-lg font-bold text-[#af4408] mt-0.5">{fmt(data.summary.total_value)}</div>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-[#8B7355]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {!loading && depts.length === 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          No department is currently holding party materials.
          <div className="text-xs mt-2">
            When a party requisition is fulfilled, the issued materials move here as the department's on-hand balance.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {depts.map(d => {
          const deptValue = d.items.reduce((s, it) => s + it.value, 0);
          return (
            <div key={d.department_id} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden flex flex-col">
              <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[#2D1B0E] truncate">
                    {d.name}
                    {d.code && <span className="ml-1 text-[10px] font-mono text-[#8B7355]">[{d.code}]</span>}
                  </h3>
                  <div className="text-[10px] text-[#8B7355]">{d.items.length} material(s) · {fmt(deptValue)}</div>
                </div>
                <button
                  onClick={() => setReconcileDept(d)}
                  className="shrink-0 px-3 py-1.5 bg-[#af4408] hover:bg-[#963a06] text-white rounded-lg text-xs flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5" /> Reconcile after party
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[#8B7355] bg-[#FFF8F0]">
                    <tr>
                      <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                      <th className="text-right py-1.5 px-3 font-medium">On-Hand</th>
                      <th className="text-right py-1.5 px-3 font-medium">Value ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map(it => (
                      <tr key={it.material_id} className="border-t border-[#E8D5C4]/50">
                        <td className="py-1.5 px-3 text-[#2D1B0E]">{it.name}</td>
                        <td className="py-1.5 px-3 text-right font-mono">
                          {fmt2(it.on_hand)} <span className="text-[#8B7355]">{it.unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(it.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      {reconcileDept && (
        <ReconcileModal
          dept={reconcileDept}
          onClose={() => setReconcileDept(null)}
          onDone={() => { setReconcileDept(null); reload(); }}
        />
      )}
    </div>
  );
}

function ReconcileModal({ dept, onClose, onDone }: { dept: Dept; onClose: () => void; onDone: () => void }) {
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState(todayIso());
  const [rows, setRows] = useState(() =>
    dept.items.map(it => ({ ...it, leftover: it.on_hand, return_to_store: false })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setLeftover = (id: string, v: string) => {
    const n = Math.max(0, Number(v) || 0);
    setRows(rs => rs.map(r => r.material_id === id ? { ...r, leftover: Math.min(n, r.on_hand) } : r));
  };
  const toggleReturn = (id: string) => {
    setRows(rs => rs.map(r => r.material_id === id ? { ...r, return_to_store: !r.return_to_store } : r));
  };

  const totalConsumed = useMemo(
    () => rows.reduce((s, r) => s + Math.max(0, r.on_hand - r.leftover) * r.avg_price, 0),
    [rows]);

  const submit = async () => {
    setSaving(true); setError('');
    try {
      const res = await api('/api/department-materials/reconcile', {
        method: 'POST',
        body: {
          department_id: dept.department_id,
          event_name: eventName,
          event_date: eventDate,
          items: rows.map(r => ({
            material_id: r.material_id,
            leftover_qty: r.leftover,
            return_to_store: r.return_to_store,
          })),
        },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Reconcile failed');
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Failed');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-2xl w-full max-w-2xl my-8 shadow-xl"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="text-base font-semibold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-[#af4408]" /> Reconcile — {dept.name}
          </h2>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-xs text-[#6B5744]">
              Event name
              <input value={eventName} onChange={e => setEventName(e.target.value)} placeholder="(optional)"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-white min-w-[220px]" />
            </label>
            <label className="flex flex-col text-xs text-[#6B5744]">
              Event date
              <input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-white" />
            </label>
          </div>

          <p className="text-[11px] text-[#8B7355]">
            Enter how much of each material is <b>left over</b>. The rest is recorded as consumed. Toggle
            <span className="inline-flex items-center gap-0.5 mx-1"><RotateCcw className="w-3 h-3" /> Return</span>
            to send the leftover back to the main store.
          </p>

          <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#8B7355] bg-[#FFF1E3]/60">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-right py-1.5 px-3 font-medium">On-Hand</th>
                    <th className="text-right py-1.5 px-3 font-medium">Leftover</th>
                    <th className="text-right py-1.5 px-3 font-medium">Consumed</th>
                    <th className="text-center py-1.5 px-3 font-medium">Return</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const consumed = Math.max(0, r.on_hand - r.leftover);
                    return (
                      <tr key={r.material_id} className="border-t border-[#E8D5C4]/50">
                        <td className="py-1.5 px-3 text-[#2D1B0E]">
                          {r.name} <span className="text-[10px] text-[#8B7355]">{r.unit}</span>
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{fmt2(r.on_hand)}</td>
                        <td className="py-1.5 px-3 text-right">
                          <input type="number" min={0} max={r.on_hand} step="any" value={r.leftover}
                                 onChange={e => setLeftover(r.material_id, e.target.value)}
                                 className="w-24 px-2 py-1 border border-[#E8D5C4] rounded bg-white text-right font-mono" />
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#af4408]">{fmt2(consumed)}</td>
                        <td className="py-1.5 px-3 text-center">
                          <button onClick={() => toggleReturn(r.material_id)}
                                  className={`px-2 py-1 rounded text-[11px] inline-flex items-center gap-1 border ${
                                    r.return_to_store
                                      ? 'bg-[#af4408] text-white border-[#af4408]'
                                      : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'}`}>
                            <RotateCcw className="w-3 h-3" /> {r.return_to_store ? 'Returning' : 'Return'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-[#6B5744]">
            <Package className="w-3.5 h-3.5 text-[#af4408]" />
            Estimated consumed value: <b className="text-[#af4408]">{fmt(totalConsumed)}</b>
          </div>

          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} disabled={saving}
                  className="px-4 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={saving}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#963a06] text-white rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save reconciliation
          </button>
        </div>
      </div>
    </div>
  );
}
