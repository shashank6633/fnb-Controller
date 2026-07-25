'use client';

/**
 * Party Menu — a manager-enabled LIMITED à-la-carte menu locked to selected
 * tables. Flow: prepare the item list → assign the guest's table(s) (switchable)
 * → a MANAGER enables it → those tables' QR menu shows only these items (see
 * lib/party-menu.ts + /api/customer/menu + /api/customer/orders).
 */

import { useEffect, useMemo, useState } from 'react';
import { PartyPopper, Plus, Loader2, X, Save, Trash2, Search, Power, PowerOff, Check } from 'lucide-react';
import { api } from '@/lib/api';

const inr = (v: number) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');

interface PartyMenu {
  id: string; name: string; note: string; enabled: number; booking_id?: string | null;
  item_count: number; table_count: number; tables: string[];
}
interface MenuItem { id: string; name: string; category: string; item_type: string; selling_price: number; is_active: number; }
interface TableRow { id: string; table_number: string; zone: string; section: string; }
interface Booking { id: string; guest_name?: string | null; guest_phone?: string | null; booking_date: string; slot_time: string; party_size: number; }

export default function PartyMenusPage() {
  const [list, setList] = useState<PartyMenu[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isMgmt, setIsMgmt] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Editor state (null = closed)
  const [editing, setEditing] = useState<null | { id: string | null; name: string; note: string;
    items: Set<string>; tabs: Set<string>; bookingId: string }>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [itemCat, setItemCat] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10);
      const [pm, mi, tb, me, bk] = await Promise.all([
        fetch('/api/party-menus').then(r => r.json()),
        fetch('/api/menu-items?active_only=true').then(r => r.json()),
        fetch('/api/dine-in/tables').then(r => r.json()),
        fetch('/api/auth/me').then(r => r.json()).catch(() => null),
        fetch(`/api/crm-calls/bookings?from=${today}&to=${to}`).then(r => r.json()).catch(() => null),
      ]);
      setList(pm.party_menus || []);
      setMenuItems((mi.items || []).filter((x: MenuItem) => x.is_active && x.selling_price > 0));
      setTables(tb.items || []);
      setBookings((bk?.bookings || []) as Booking[]);
      const u = me?.user;
      setIsMgmt(!!u && (u.role === 'admin' || u.role === 'manager' || u.is_head_chef));
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const say = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 4000); };

  const openNew = () => { setEditing({ id: null, name: '', note: '', items: new Set(), tabs: new Set(), bookingId: '' }); setItemSearch(''); setItemCat(''); };
  const openEdit = async (pm: PartyMenu) => {
    try {
      const d = await fetch(`/api/party-menus?id=${pm.id}`).then(r => r.json());
      const det = d.party_menu;
      setEditing({ id: pm.id, name: det.name, note: det.note || '',
        items: new Set<string>(det.item_ids || []), tabs: new Set<string>(det.table_ids || []),
        bookingId: det.booking_id || '' });
      setItemSearch(''); setItemCat('');
    } catch (e: any) { setErr(e.message); }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setErr('Enter a name'); return; }
    setBusy(true); setErr(null);
    try {
      const body = { name: editing.name.trim(), note: editing.note.trim(),
        item_ids: [...editing.items], table_ids: [...editing.tabs],
        booking_id: editing.bookingId || null };
      const r = editing.id
        ? await api(`/api/party-menus?id=${editing.id}`, { method: 'PUT', body })
        : await api('/api/party-menus', { method: 'POST', body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setEditing(null); say('Party menu saved.'); load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const toggleEnable = async (pm: PartyMenu) => {
    setErr(null);
    try {
      const r = await api(`/api/party-menus?id=${pm.id}`, { method: 'PUT', body: { enabled: !pm.enabled } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      say(pm.enabled ? `"${pm.name}" turned OFF — tables back to full menu.` : `"${pm.name}" is now LIVE on ${pm.tables.join(', ') || 'its tables'}.`);
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async (pm: PartyMenu) => {
    if (!confirm(`Delete party menu "${pm.name}"? This can't be undone.`)) return;
    try {
      const r = await api(`/api/party-menus?id=${pm.id}`, { method: 'DELETE' });
      if (!r.ok) { const j = await r.json(); throw new Error(j.error || `HTTP ${r.status}`); }
      say('Deleted.'); load();
    } catch (e: any) { setErr(e.message); }
  };

  const cats = useMemo(() => Array.from(new Set(menuItems.map(m => m.category).filter(Boolean))).sort(), [menuItems]);
  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return menuItems.filter(m =>
      (!itemCat || m.category === itemCat) &&
      (!q || `${m.name} ${m.category}`.toLowerCase().includes(q)));
  }, [menuItems, itemSearch, itemCat]);

  // Tables grouped by zone → section for the picker.
  const tablesByGroup = useMemo(() => {
    const g = new Map<string, TableRow[]>();
    for (const t of tables) {
      const key = [t.zone, t.section].filter(Boolean).join(' · ') || 'Unzoned';
      if (!g.has(key)) g.set(key, []);
      g.get(key)!.push(t);
    }
    return [...g.entries()];
  }, [tables]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <PartyPopper className="w-6 h-6 text-[#af4408]" /> Party Menu
          </h1>
          <p className="text-xs text-[#6B5744] mt-1 max-w-2xl">
            A limited à-la-carte menu for a group. Pick the items, assign the guest&apos;s table(s) (switchable),
            then a <b>manager enables</b> it — only those tables&apos; QR menu shows just these items. Turn OFF (or on settle) to restore the full menu.
          </p>
        </div>
        <button onClick={openNew} className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Party Menu
        </button>
      </div>

      {flash && <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm">{flash}</div>}
      {err && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center justify-between gap-2"><span>{err}</span><button onClick={() => setErr(null)}><X className="w-4 h-4" /></button></div>}

      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      ) : list.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          No party menus yet. Click <b>New Party Menu</b> to prepare one.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map(pm => (
            <div key={pm.id} className={`bg-white border rounded-xl p-4 space-y-2 ${pm.enabled ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-[#E8D5C4]'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[#2D1B0E] flex items-center gap-2">
                    {pm.name}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${pm.enabled ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'}`}>
                      {pm.enabled ? 'LIVE' : 'off'}
                    </span>
                  </div>
                  {pm.note && <div className="text-[11px] text-[#6B5744] mt-0.5">{pm.note}</div>}
                </div>
              </div>
              <div className="text-xs text-[#6B5744] flex flex-wrap gap-x-4 gap-y-1">
                <span><b>{pm.item_count}</b> item{pm.item_count === 1 ? '' : 's'}</span>
                <span>Tables: <b className="text-[#2D1B0E]">{pm.tables.length ? pm.tables.join(', ') : '—'}</b></span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                {isMgmt ? (
                  <button onClick={() => toggleEnable(pm)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${pm.enabled
                            ? 'bg-white border border-red-300 text-red-700 hover:bg-red-50'
                            : 'bg-emerald-600 hover:bg-emerald-700 text-white'}`}>
                    {pm.enabled ? <><PowerOff className="w-3.5 h-3.5" /> Turn off</> : <><Power className="w-3.5 h-3.5" /> Enable</>}
                  </button>
                ) : (
                  <span className="text-[10px] text-[#8B7355] italic">{pm.enabled ? 'Live — ask a manager to turn off' : 'Ask a manager to enable'}</span>
                )}
                <button onClick={() => openEdit(pm)} className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs">Edit / switch tables</button>
                <button onClick={() => remove(pm)} className="ml-auto text-[#8B7355] hover:text-red-700" title="Delete"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
          <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }} className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl shadow-xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
              <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Party Menu' : 'New Party Menu'}</h2>
              <button onClick={() => setEditing(null)}><X className="w-5 h-5 text-[#8B7355]" /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-sm">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-[#6B5744] text-xs">Name
                  <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                         placeholder="e.g. Sharma party — no premium liquor"
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
                </label>
                <label className="flex flex-col gap-1 text-[#6B5744] text-xs">Note (staff)
                  <input value={editing.note} onChange={e => setEditing({ ...editing, note: e.target.value })}
                         placeholder="e.g. Limited menu — contact manager"
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm" />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-[#6B5744] text-xs">
                Link a reservation (optional) — shows a “limited menu — contact manager” badge on the Reservations board
                <select value={editing.bookingId} onChange={e => setEditing({ ...editing, bookingId: e.target.value })}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm">
                  <option value="">— No reservation —</option>
                  {bookings.map(bk => (
                    <option key={bk.id} value={bk.id}>
                      {(bk.guest_name || bk.guest_phone || 'Guest')} · {bk.booking_date}{bk.slot_time ? ' ' + bk.slot_time : ''} · party {bk.party_size}
                    </option>
                  ))}
                </select>
              </label>

              {/* Tables (switchable) */}
              <div className="border border-[#E8D5C4] rounded-lg">
                <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744] flex items-center justify-between">
                  <span>Tables ({editing.tabs.size} selected) — switch anytime if the guest moves</span>
                  {editing.tabs.size > 0 && <button onClick={() => setEditing({ ...editing, tabs: new Set() })} className="text-[10px] text-[#af4408] hover:underline">clear</button>}
                </div>
                <div className="max-h-40 overflow-auto p-2 space-y-2">
                  {tablesByGroup.length === 0 && <div className="text-xs text-[#8B7355] p-2">No tables configured.</div>}
                  {tablesByGroup.map(([grp, ts]) => (
                    <div key={grp}>
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">{grp}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {ts.map(t => {
                          const on = editing.tabs.has(t.id);
                          return (
                            <button key={t.id} type="button"
                                    onClick={() => { const n = new Set(editing.tabs); on ? n.delete(t.id) : n.add(t.id); setEditing({ ...editing, tabs: n }); }}
                                    className={`px-2 py-1 rounded border text-xs ${on ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                              {on && <Check className="w-3 h-3 inline mr-0.5" />}{t.table_number}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Items */}
              <div className="border border-[#E8D5C4] rounded-lg">
                <div className="bg-[#FFF1E3] px-3 py-1.5 text-xs font-semibold text-[#6B5744] flex items-center justify-between gap-2">
                  <span>Menu items ({editing.items.size} selected)</span>
                  {editing.items.size > 0 && <button onClick={() => setEditing({ ...editing, items: new Set() })} className="text-[10px] text-[#af4408] hover:underline">clear</button>}
                </div>
                <div className="p-2 flex flex-wrap gap-2 border-b border-[#F0E4D6]">
                  <div className="relative flex-1 min-w-[160px]">
                    <Search className="w-3.5 h-3.5 absolute left-2 top-2.5 text-[#8B7355]" />
                    <input value={itemSearch} onChange={e => setItemSearch(e.target.value)} placeholder="Search items…"
                           className="w-full pl-7 pr-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs" />
                  </div>
                  <select value={itemCat} onChange={e => setItemCat(e.target.value)} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-xs">
                    <option value="">All categories</option>
                    {cats.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {filteredItems.length > 0 && (
                    <button type="button" onClick={() => { const n = new Set(editing.items); filteredItems.forEach(m => n.add(m.id)); setEditing({ ...editing, items: n }); }}
                            className="px-2 py-1.5 text-xs text-[#af4408] border border-[#E8D5C4] rounded hover:bg-[#FFF1E3]">Add all shown</button>
                  )}
                </div>
                <div className="max-h-64 overflow-auto divide-y divide-[#F0E4D6]">
                  {filteredItems.length === 0 && <div className="text-xs text-[#8B7355] p-3">No items match.</div>}
                  {filteredItems.slice(0, 400).map(m => {
                    const on = editing.items.has(m.id);
                    return (
                      <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[#FFF8F0]">
                        <input type="checkbox" checked={on}
                               onChange={() => { const n = new Set(editing.items); on ? n.delete(m.id) : n.add(m.id); setEditing({ ...editing, items: n }); }} />
                        <span className="flex-1 text-[#2D1B0E]">{m.name}</span>
                        <span className="text-[#8B7355]">{m.category}</span>
                        {m.item_type === 'liquors' && <span className="text-[9px] px-1 rounded bg-blue-50 text-blue-700 border border-blue-200">liquor</span>}
                        <span className="font-mono text-[#6B5744] w-16 text-right">{inr(m.selling_price)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={save} disabled={busy}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
