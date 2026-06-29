'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { Utensils, Plus, Trash2, Loader2, X } from 'lucide-react';

interface TableRow {
  id: string;
  table_number: string;
  zone: string;
  seats: number;
  is_active: number;
  open_order_id: string | null;
  open_order_number: number | null;
}

export default function TablesPage() {
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ table_number: '', zone: '', seats: 2 });
  const [edit, setEdit] = useState<TableRow | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/tables');
      const j = await r.json();
      setTables(j.items || []);
    } catch (_) {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addTable() {
    if (!form.table_number.trim()) return;
    setSaving(true);
    try {
      const r = await api('/api/dine-in/tables', { method: 'POST', body: form });
      const j = await r.json();
      if (j.error) alert(j.error);
      else { setForm({ table_number: '', zone: '', seats: 2 }); await load(); }
    } finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!edit) return;
    setSaving(true);
    try {
      const r = await api('/api/dine-in/tables', { method: 'PUT', body: edit });
      const j = await r.json();
      if (j.error) alert(j.error);
      else { setEdit(null); await load(); }
    } finally { setSaving(false); }
  }

  async function remove(t: TableRow) {
    if (!confirm(`Deactivate table ${t.table_number}?`)) return;
    const r = await api(`/api/dine-in/tables?id=${t.id}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.error) alert(j.error); else load();
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-[#af4408]/10 rounded-lg"><Utensils className="w-6 h-6 text-[#af4408]" /></div>
        <div>
          <h1 className="text-2xl font-bold text-[#af4408]">Tables</h1>
          <p className="text-sm text-[#8B7355]">Set up your floor — tables, zones, and seats</p>
        </div>
      </div>

      <div className="card mb-6 p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Table number</label>
          <input value={form.table_number} onChange={(e) => setForm({ ...form, table_number: e.target.value })}
            placeholder="e.g. 12" className="w-28 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Zone</label>
          <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}
            placeholder="Main / Terrace / Bar" className="w-40 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Seats</label>
          <input type="number" min={1} value={form.seats} onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })}
            className="w-20 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <button onClick={addTable} disabled={saving || !form.table_number.trim()}
          className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add table
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-[#8B7355]">Loading…</div>
      ) : tables.length === 0 ? (
        <div className="card text-center py-12 text-[#8B7355]">No tables yet — add your first above.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tables.map((t) => (
            <div key={t.id} className="card p-4 flex items-center justify-between">
              <div>
                <p className="font-bold text-[#2D1B0E]">Table {t.table_number}</p>
                <p className="text-xs text-[#8B7355]">{t.zone || 'No zone'} · {t.seats} seats
                  {t.open_order_id && <span className="ml-2 text-amber-700">· occupied (#{t.open_order_number})</span>}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEdit(t)} className="text-xs text-[#af4408] hover:underline">Edit</button>
                <button onClick={() => remove(t)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEdit(null)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-[#2D1B0E]">Edit table</h2>
              <button onClick={() => setEdit(null)}><X size={18} className="text-[#8B7355]" /></button>
            </div>
            <div className="space-y-3">
              <div><label className="block text-xs text-[#8B7355] mb-1">Table number</label>
                <input value={edit.table_number} onChange={(e) => setEdit({ ...edit, table_number: e.target.value })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-[#8B7355] mb-1">Zone</label>
                <input value={edit.zone} onChange={(e) => setEdit({ ...edit, zone: e.target.value })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-[#8B7355] mb-1">Seats</label>
                <input type="number" min={1} value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: Number(e.target.value) })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEdit(null)} className="px-4 py-2 text-sm text-[#8B7355]">Cancel</button>
              <button onClick={saveEdit} disabled={saving}
                className="bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
