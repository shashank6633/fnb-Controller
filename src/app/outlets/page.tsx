'use client';
import { useEffect, useState } from 'react';
import { Store, Plus, Edit, X, Save, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

interface Outlet { id: string; name: string; address: string; gstin: string; is_active: number; is_default: number; created_at?: string; }

export default function OutletsPage() {
  const [list, setList] = useState<Outlet[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Outlet> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const me = await fetch('/api/auth/me').then(r => r.json());
      if (me.user?.role !== 'admin') { setError('Only Admin can manage outlets.'); return; }
      const d = await fetch('/api/outlets').then(r => r.json());
      setList(d.outlets || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing?.name) { alert('Name required'); return; }
    const isNew = !editing.id;
    const r = await api('/api/outlets', { method: isNew ? 'POST' : 'PUT', body: editing });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
    setEditing(null); load();
  };

  if (error) return <div className="max-w-2xl mx-auto p-8 text-center text-red-700 bg-red-50 border border-red-200 rounded-xl">{error}</div>;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Store className="w-6 h-6" /> Outlets
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Each outlet has its own POs, sales, purchases, closing counts, and variance.</p>
          </div>
          <button onClick={() => setEditing({ name: '', address: '', gstin: '', is_active: 1 })}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New Outlet
          </button>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? <div className="p-6 text-center text-sm text-[#8B7355]">Loading…</div> : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                <tr>
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-left py-2 px-3 font-medium">Address</th>
                  <th className="text-left py-2 px-3 font-medium">GSTIN</th>
                  <th className="text-left py-2 px-3 font-medium">Status</th>
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map(o => (
                  <tr key={o.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!o.is_active ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-3">
                      <div className="font-medium">{o.name}</div>
                      {o.is_default ? <span className="text-[10px] bg-[#af4408] text-white px-1.5 py-0.5 rounded">DEFAULT</span> : null}
                    </td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">{o.address || '—'}</td>
                    <td className="py-2 px-3 text-xs font-mono">{o.gstin || '—'}</td>
                    <td className="py-2 px-3 text-xs">{o.is_active ? <span className="text-green-700">Active</span> : <span className="text-gray-500">Disabled</span>}</td>
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => setEditing({ ...o })} className="p-1 text-[#6B5744] hover:text-[#af4408]"><Edit className="w-3.5 h-3.5" /></button>
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
            <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md my-8 shadow-xl">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
                <h2 className="font-bold">{editing.id ? 'Edit Outlet' : 'New Outlet'}</h2>
                <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-[#8B7355]" /></button>
              </div>
              <div className="p-5 space-y-3">
                <label className="block text-xs text-[#6B5744]">Name *
                  <input value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })}
                         className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>
                <label className="block text-xs text-[#6B5744]">Address
                  <textarea rows={2} value={editing.address || ''} onChange={e => setEditing({ ...editing, address: e.target.value })}
                            className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>
                <label className="block text-xs text-[#6B5744]">GSTIN
                  <input value={editing.gstin || ''} onChange={e => setEditing({ ...editing, gstin: e.target.value })}
                         className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono" />
                </label>
                {editing.id && !editing.is_default && (
                  <label className="flex items-center gap-2 text-xs text-[#6B5744]">
                    <input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
                    Active
                  </label>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
                <button onClick={save} className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1">
                  <Save className="w-4 h-4" /> Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
