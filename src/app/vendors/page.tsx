'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, Search, Edit, Trash2, Save, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

interface Vendor {
  id: string; name: string; contact_person: string; phone: string; email: string;
  gstin: string; address: string; payment_terms: string; lead_time_days: number;
  is_active: number; notes: string;
  po_count?: number; lifetime_spend?: number; last_received?: string;
}

const empty = (): Partial<Vendor> => ({
  name: '', contact_person: '', phone: '', email: '', gstin: '', address: '',
  payment_terms: '', lead_time_days: 0, is_active: 1, notes: '',
});

export default function VendorsPage() {
  const [list, setList] = useState<Vendor[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partial<Vendor> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/vendors?stats=1').then(r => r.json());
      setList(r.vendors || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let l = list;
    if (!showInactive) l = l.filter(v => v.is_active);
    if (search) {
      const q = search.toLowerCase();
      l = l.filter(v => v.name.toLowerCase().includes(q) ||
                        (v.contact_person || '').toLowerCase().includes(q) ||
                        (v.gstin || '').toLowerCase().includes(q));
    }
    return l;
  }, [list, search, showInactive]);

  const save = async () => {
    if (!editing?.name) { alert('Name is required'); return; }
    setSaving(true);
    try {
      const isNew = !editing.id;
      const r = await api('/api/vendors', { method: isNew ? 'POST' : 'PUT', body: editing });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      setEditing(null); load();
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Deactivate vendor? (PO history preserved)')) return;
    await api(`/api/vendors?id=${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Building2 className="w-6 h-6" /> Vendors
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Suppliers — referenced by Purchase Orders. Lifetime spend reflects approved + received POs.</p>
          </div>
          <button onClick={() => setEditing(empty())}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New Vendor
          </button>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, contact, GSTIN…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          <label className="flex items-center gap-1 text-xs text-[#6B5744]">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <span className="text-xs text-[#8B7355]">{filtered.length} of {list.length}</span>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">No vendors match.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Name</th>
                    <th className="text-left  py-2 px-3 font-medium">Contact</th>
                    <th className="text-left  py-2 px-3 font-medium">GSTIN</th>
                    <th className="text-left  py-2 px-3 font-medium">Terms</th>
                    <th className="text-right py-2 px-3 font-medium">Lead</th>
                    <th className="text-right py-2 px-3 font-medium">POs</th>
                    <th className="text-right py-2 px-3 font-medium">Lifetime ₹</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(v => (
                    <tr key={v.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!v.is_active ? 'opacity-50' : ''}`}>
                      <td className="py-2 px-3 text-xs font-medium">{v.name}</td>
                      <td className="py-2 px-3 text-xs">
                        {v.contact_person || <span className="text-[#8B7355]">—</span>}
                        {v.phone && <div className="text-[10px] text-[#8B7355]">{v.phone}</div>}
                      </td>
                      <td className="py-2 px-3 text-xs font-mono">{v.gstin || <span className="text-[#8B7355]">—</span>}</td>
                      <td className="py-2 px-3 text-xs">{v.payment_terms || <span className="text-[#8B7355]">—</span>}</td>
                      <td className="py-2 px-3 text-xs text-right">{v.lead_time_days ? `${v.lead_time_days}d` : '—'}</td>
                      <td className="py-2 px-3 text-xs text-right font-mono">{v.po_count ?? 0}</td>
                      <td className="py-2 px-3 text-xs text-right font-mono">{fmt(v.lifetime_spend || 0)}</td>
                      <td className="py-2 px-3 text-right">
                        <button onClick={() => setEditing({ ...v })} className="p-1 text-[#6B5744] hover:text-[#af4408]" title="Edit">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        {v.is_active ? (
                          <button onClick={() => remove(v.id)} className="p-1 text-red-500 hover:text-red-700" title="Deactivate">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl my-8 shadow-xl">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Vendor' : 'New Vendor'}</h2>
                <button onClick={() => setEditing(null)} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name *" v={editing.name || ''} onChange={x => setEditing({ ...editing, name: x })} />
                <Field label="Contact person" v={editing.contact_person || ''} onChange={x => setEditing({ ...editing, contact_person: x })} />
                <Field label="Phone" v={editing.phone || ''} onChange={x => setEditing({ ...editing, phone: x })} />
                <Field label="Email" v={editing.email || ''} onChange={x => setEditing({ ...editing, email: x })} />
                <Field label="GSTIN" v={editing.gstin || ''} onChange={x => setEditing({ ...editing, gstin: x })} />
                <Field label="Payment terms" v={editing.payment_terms || ''} onChange={x => setEditing({ ...editing, payment_terms: x })} placeholder="e.g. Net 30" />
                <Field label="Lead time (days)" type="number" v={String(editing.lead_time_days ?? '')} onChange={x => setEditing({ ...editing, lead_time_days: Number(x) })} />
                <label className="flex items-center gap-2 text-xs text-[#6B5744] mt-5">
                  <input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
                  Active
                </label>
                <div className="sm:col-span-2">
                  <label className="text-xs text-[#6B5744]">Address</label>
                  <textarea value={editing.address || ''} onChange={e => setEditing({ ...editing, address: e.target.value })} rows={2}
                            className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs text-[#6B5744]">Notes</label>
                  <textarea value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} rows={2}
                            className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
                <button onClick={save} disabled={saving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, v, onChange, placeholder, type = 'text' }: { label: string; v: string; onChange: (s: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="text-xs text-[#6B5744]">{label}</label>
      <input type={type} value={v} onChange={e => onChange(e.target.value)} placeholder={placeholder}
             className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
    </div>
  );
}
