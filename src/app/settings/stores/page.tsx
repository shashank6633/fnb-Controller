'use client';

/**
 * Store Locations — config surface for the multi-store inventory engine.
 *
 * A "store" (LIQUOR STORE first; Wine Cellar / Beer Store / Mini Bar later) is
 * pure data: a store_locations row + the categories it owns + per-user access
 * grants. This page manages all three. The Liquor Store INVENTORY page itself
 * (ledger, closing stock, procurement) is Phase B — not here.
 *
 * Admin-only (mirrors /settings/categories): non-admins get the 🔒 banner and
 * every write API 403s server-side regardless.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Warehouse, Loader2, Plus, X, Save, AlertCircle, CheckCircle2, Edit2,
  Users as UsersIcon, Tags, Power, MapPin, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';

interface CatMap { id: string; category: string; }

/** JS mirror of catNorm in src/lib/store-engine.ts — category matching is case-,
 *  space-, hyphen- and underscore-insensitive. Kept identical on purpose: this
 *  page decides what to offer and what to flag, and disagreeing with the server
 *  means suggesting an option the API will 409. */
const catNormJs = (s: string) => String(s || '').toLowerCase().trim().replace(/[ _-]/g, '');
/** A table zone that actually has tables — the only labels a floor bar can
 *  usefully be mapped to (floorStoreForZone matches floor_label to these). */
interface ZoneOpt { zone: string; tables: number; }
interface AccessRow {
  id: string; user_id: string; user_name: string; user_email: string;
  can_view: number; can_procure: number; can_adjust: number; can_close_stock: number;
}
interface StoreRow {
  id: string; name: string; code: string; description: string;
  is_active: number; requires_authorization: number; created_at: string;
  floor_label: string;
  categories: CatMap[];
  access?: AccessRow[];
}
interface UserOpt { id: string; name: string; email: string; role: string; }

const PERM_COLS: { key: 'can_view' | 'can_procure' | 'can_adjust' | 'can_close_stock'; label: string }[] = [
  { key: 'can_view',        label: 'View' },
  { key: 'can_procure',     label: 'Procure' },
  { key: 'can_adjust',      label: 'Adjust' },
  { key: 'can_close_stock', label: 'Close stock' },
];

export default function StoreLocationsPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [materialCats, setMaterialCats] = useState<string[]>([]);
  const [tableZones, setTableZones] = useState<ZoneOpt[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [meRole, setMeRole] = useState<string | null>(null);

  // New-store form
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMeRole(d?.user?.role || null)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch('/api/stores')
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j.error) { setError(j.error); return; }
        setStores(j.stores || []);
        setMaterialCats(j.material_categories || []);
        setTableZones(j.table_zones || []);
        setUsers(j.users || []);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [refreshKey]);

  const refresh = () => setRefreshKey(k => k + 1);

  /** Run one write call; surface errors; refresh on success. */
  const run = async (fn: () => Promise<Response>, okMsg: string) => {
    setBusy(true); setError(null); setFlash(null);
    try {
      const r = await fn();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return false; }
      setFlash(`✓ ${okMsg}`);
      refresh();
      return true;
    } catch (e: any) {
      setError(e.message); return false;
    } finally { setBusy(false); }
  };

  const createStore = () => run(
    () => api('/api/stores', { method: 'POST', body: { name: newName.trim(), code: newCode.trim() } }),
    `Added store "${newName.trim()}"`,
  ).then(ok => { if (ok) { setNewName(''); setNewCode(''); } });

  if (meRole !== null && meRole !== 'admin') {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admin only. Ask an admin to manage store locations.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Warehouse className="w-6 h-6 text-[#af4408]" /> Store Locations
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          Named stores (Liquor Store, Wine Cellar…) that hold their own stock, separate from the
          Central Store. Map each store's <strong>categories</strong> (which materials it owns) and its{' '}
          <strong>authorized users</strong>. Admins, HODs, Store Managers and "Bar Manager" titles always
          have full access; grants below are for everyone else.
        </p>
      </div>

      {/* Add store */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[180px]">
          <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">New store name</label>
          <input value={newName} onChange={e => setNewName(e.target.value)}
                 placeholder="e.g. WINE CELLAR"
                 className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <div className="w-24">
          <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Code</label>
          <input value={newCode} onChange={e => setNewCode(e.target.value)}
                 placeholder="WIN"
                 className="w-full mt-0.5 px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
        </div>
        <button onClick={createStore} disabled={!newName.trim() || busy}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-sm flex items-center gap-1 disabled:opacity-50">
          <Plus className="w-4 h-4" /> Add store
        </button>
      </div>

      {flash && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {flash}
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : stores.length === 0 ? (
        <div className="p-8 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          No store locations yet — add one above.
        </div>
      ) : (
        stores.map(s => (
          <StoreCard key={s.id} store={s} materialCats={materialCats} tableZones={tableZones} users={users}
                     busy={busy} run={run} />
        ))
      )}

      <p className="text-[10px] text-[#8B7355]">
        Phase A note: this page only configures stores. The per-store inventory screen (opening /
        purchases / issues / closing on the store ledger) ships in Phase B, along with the guard that
        keeps store-mapped categories out of Central Store purchase flows.
      </p>
    </div>
  );
}

// ─── One store card: header + category mapping + user access ───────────────

function StoreCard({ store, materialCats, tableZones, users, busy, run }: {
  store: StoreRow;
  materialCats: string[];
  tableZones: ZoneOpt[];
  users: UserOpt[];
  busy: boolean;
  run: (fn: () => Promise<Response>, okMsg: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(store.name);
  const [code, setCode] = useState(store.code);
  const [floorLabel, setFloorLabel] = useState(store.floor_label || '');
  const [catPick, setCatPick] = useState('');
  const [catFree, setCatFree] = useState('');
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [userPick, setUserPick] = useState('');

  useEffect(() => {
    setName(store.name); setCode(store.code); setFloorLabel(store.floor_label || ''); setRenames({});
  }, [store]);

  // The dropdown must hide anything already owned under catNorm, not just an exact
  // NOCASE match — otherwise it keeps offering 'RED WINE' while 'red-wine' is
  // mapped, and the server (now) 409s on the very option it suggested.
  const mappedNorm = useMemo(
    () => new Set(store.categories.map(c => catNormJs(c.category))),
    [store.categories],
  );
  const unmappedCats = useMemo(
    () => materialCats.filter(c => !mappedNorm.has(catNormJs(c))),
    [materialCats, mappedNorm],
  );
  // Chips that are the SAME category as an earlier chip once separators and case
  // are ignored ('RED WINE' vs 'red-wine'). Matching is catNorm everywhere, so the
  // later spelling adds nothing — flag it so it can be removed with the ✕.
  const redundant = useMemo(() => {
    const seen = new Map<string, string>();
    const dupes = new Map<string, string>();          // chip id -> the spelling it duplicates
    for (const c of store.categories) {
      const k = catNormJs(c.category);
      if (seen.has(k)) dupes.set(c.id, seen.get(k)!);
      else seen.set(k, c.category.trim());
    }
    return dupes;
  }, [store.categories]);
  const grantedIds = useMemo(() => new Set((store.access || []).map(a => a.user_id)), [store.access]);
  const pickableUsers = useMemo(
    () => users.filter(u => !grantedIds.has(u.id) && u.role !== 'admin'),
    [users, grantedIds],
  );

  const headerDirty = name.trim() !== store.name || code.trim() !== store.code;

  const saveHeader = () => run(
    () => api(`/api/stores/${store.id}`, { method: 'PUT', body: { name: name.trim(), code: code.trim() } }),
    `Saved "${name.trim()}"`,
  );
  const floorDirty = floorLabel.trim() !== (store.floor_label || '').trim();
  const saveFloorLabel = () => run(
    () => api(`/api/stores/${store.id}`, { method: 'PUT', body: { floor_label: floorLabel.trim() } }),
    floorLabel.trim() ? `Mapped ${store.name} to zone(s): ${floorLabel.trim()}` : `Cleared floor mapping for ${store.name}`,
  );
  const toggleActive = () => run(
    () => api(`/api/stores/${store.id}`, { method: 'PUT', body: { is_active: !store.is_active } }),
    store.is_active ? `Deactivated ${store.name}` : `Activated ${store.name}`,
  );
  const toggleAuth = () => run(
    () => api(`/api/stores/${store.id}`, { method: 'PUT', body: { requires_authorization: !store.requires_authorization } }),
    'Saved authorization mode',
  );

  const addCategory = () => {
    const cat = (catFree.trim() || catPick).trim();
    if (!cat) return;
    run(
      () => api(`/api/stores/${store.id}/categories`, { method: 'POST', body: { category: cat } }),
      `Mapped "${cat}" to ${store.name}`,
    ).then(ok => { if (ok) { setCatPick(''); setCatFree(''); } });
  };
  const removeCategory = (cat: string) => run(
    () => api(`/api/stores/${store.id}/categories`, { method: 'DELETE', body: { category: cat } }),
    `Removed "${cat}"`,
  );
  const renameCategory = (from: string) => {
    const to = (renames[from] || '').trim();
    if (!to || to === from) return;
    run(
      () => api(`/api/stores/${store.id}/categories`, { method: 'PUT', body: { from, to } }),
      `Renamed "${from}" → "${to}"`,
    );
  };

  const grantUser = () => {
    if (!userPick) return;
    run(
      () => api(`/api/stores/${store.id}/access`, { method: 'POST', body: { user_id: userPick } }),
      'User granted (view)',
    ).then(ok => { if (ok) setUserPick(''); });
  };
  const setPerm = (row: AccessRow, key: string, value: boolean) => run(
    () => api(`/api/stores/${store.id}/access`, {
      method: 'POST',
      body: {
        user_id: row.user_id,
        can_view: key === 'can_view' ? value : !!row.can_view,
        can_procure: key === 'can_procure' ? value : !!row.can_procure,
        can_adjust: key === 'can_adjust' ? value : !!row.can_adjust,
        can_close_stock: key === 'can_close_stock' ? value : !!row.can_close_stock,
      },
    }),
    'Permissions saved',
  );
  const revokeUser = (row: AccessRow) => run(
    () => api(`/api/stores/${store.id}/access`, { method: 'DELETE', body: { user_id: row.user_id } }),
    `Removed ${row.user_name || row.user_email}`,
  );

  return (
    <div className={`bg-white border rounded-xl overflow-hidden ${store.is_active ? 'border-[#E8D5C4]' : 'border-red-200 opacity-80'}`}>
      {/* Header: rename + code + toggles */}
      <div className="px-3 sm:px-4 py-3 bg-[#FFF1E3] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
        <Warehouse className="w-4 h-4 text-[#af4408] shrink-0" />
        <input value={name} onChange={e => setName(e.target.value)}
               className="font-semibold text-[#2D1B0E] bg-transparent border border-transparent focus:border-[#E8D5C4] focus:bg-white rounded px-1.5 py-0.5 text-sm min-w-[140px] flex-1 sm:flex-none sm:w-56" />
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="code"
               className="w-16 font-mono text-xs text-[#6B5744] bg-transparent border border-transparent focus:border-[#E8D5C4] focus:bg-white rounded px-1.5 py-1" />
        {headerDirty && (
          <button onClick={saveHeader} disabled={busy || !name.trim()}
                  className="px-2 py-1 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-xs flex items-center gap-1 disabled:opacity-50">
            <Save className="w-3 h-3" /> Save
          </button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={toggleAuth} disabled={busy}
                  title="When ON, only admins / HODs / store & bar managers / granted users may use this store"
                  className={`px-2 py-1 rounded text-[10px] font-medium border ${store.requires_authorization ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
            {store.requires_authorization ? 'Authorization ON' : 'Authorization OFF'}
          </button>
          <button onClick={toggleActive} disabled={busy}
                  className={`px-2 py-1 rounded text-[10px] font-medium border flex items-center gap-1 ${store.is_active ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-red-50 border-red-300 text-red-700'}`}>
            <Power className="w-3 h-3" /> {store.is_active ? 'Active' : 'Inactive'}
          </button>
        </div>
      </div>

      <div className="p-3 sm:p-4 space-y-4">
        {/* ── Floor / zone mapping (Multi-floor bar reconciliation) ── */}
        <div>
          <div className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5 mb-1.5">
            <MapPin className="w-3.5 h-3.5 text-[#af4408]" />
            Floor / zone mapping
            <span className="text-[10px] font-normal text-[#8B7355]">(for sales-vs-consumption reconciliation)</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={floorLabel} onChange={e => setFloorLabel(e.target.value)}
                   placeholder="e.g. Rooftop  (or: Ground Floor, Terrace)"
                   className="flex-1 min-w-[200px] px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
            {floorDirty && (
              <button onClick={saveFloorLabel} disabled={busy}
                      className="px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-xs flex items-center gap-1 disabled:opacity-50">
                <Save className="w-3.5 h-3.5" /> Save mapping
              </button>
            )}
          </div>
          {/* Click-to-add the REAL zones. A hand-typed label that matches no table
              zone is an "orphan label" — nothing can be sold there, so the bar
              silently never reconciles. Appends, because a bar may serve several. */}
          {tableZones.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              <span className="text-[10px] text-[#8B7355] mr-0.5">Zones with tables:</span>
              {tableZones.map(z => {
                const already = floorLabel.split(',').some(p => p.trim().toLowerCase() === z.zone.toLowerCase());
                return (
                  <button key={z.zone} type="button" disabled={busy || already}
                          onClick={() => setFloorLabel(prev => (prev.trim() ? `${prev.trim()}, ${z.zone}` : z.zone))}
                          title={already ? `${z.zone} is already mapped here` : `Add ${z.zone}`}
                          className={`px-1.5 py-0.5 rounded-full border text-[10px] ${already
                            ? 'border-[#E8D5C4] bg-[#F3E9DC] text-[#B8A590] cursor-default'
                            : 'border-[#E8D5C4] bg-white text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408]'}`}>
                    {z.zone} <span className="text-[#B8A590]">({z.tables})</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-[#8B7355] mt-1">
            Match this floor bar to the table <strong>zone</strong> its sales come from (comma-separated for
            several zones). Sales in a mapped zone are attributed to this store for leak reconciliation. Leave
            blank for a non-floor store like the central Liquor Store.
          </p>
          {/* A store that owns NO categories is a receiving location (a floor bar) —
              it can only be judged against what was sold in its zone. With no zone
              it is invisible to reconciliation, which reads as "no leak" rather
              than "not checked". The category-owning central store is exempt: it
              is procurement, not a floor, and is correctly blank. */}
          {store.is_active && store.categories.length === 0 && !floorLabel.trim() && (
            <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1 flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                No zone mapped, and this store owns no categories — so nothing attributes sales to it and its
                sales-vs-consumption check never runs. Pick the zone{tableZones.length > 0 ? ' above' : ''} that this bar serves.
              </span>
            </p>
          )}
        </div>

        {/* ── Category mapping ── */}
        <div>
          <div className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5 mb-1.5">
            <Tags className="w-3.5 h-3.5 text-[#af4408]" />
            Categories owned by this store
            <span className="text-[10px] font-normal text-[#8B7355]">({store.categories.length})</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {store.categories.length === 0 && (
              <span className="text-xs text-[#8B7355] italic">No categories mapped yet.</span>
            )}
            {store.categories.map(c => {
              const staged = renames[c.category];
              const dirty = staged !== undefined && staged.trim() !== '' && staged.trim() !== c.category;
              const dupOf = redundant.get(c.id);
              return (
                <span key={c.id}
                      title={dupOf ? `Same category as "${dupOf}" (case and - _ spaces are ignored when matching) — this row adds nothing, safe to remove` : undefined}
                      className={`inline-flex items-center gap-1 border rounded-full pl-2 pr-1 py-0.5 text-xs ${dirty ? 'bg-amber-50 border-amber-300' : dupOf ? 'bg-[#F3E9DC] border-dashed border-[#C4A98A] text-[#8B7355]' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
                  <input
                    value={staged ?? c.category}
                    onChange={e => setRenames(prev => ({ ...prev, [c.category]: e.target.value }))}
                    size={Math.max(4, (staged ?? c.category).length)}
                    className="bg-transparent outline-none text-[#2D1B0E] min-w-[3rem]"
                    aria-label={`Rename ${c.category}`}
                  />
                  {dirty && (
                    <button onClick={() => renameCategory(c.category)} disabled={busy}
                            title="Save rename" className="text-[#af4408] hover:text-[#8a3506]">
                      <Edit2 className="w-3 h-3" />
                    </button>
                  )}
                  {dupOf && <span className="text-[9px] uppercase tracking-wide text-[#A8907A]">dup</span>}
                  <button onClick={() => removeCategory(c.category)} disabled={busy}
                          title={`Remove "${c.category}"`} className="text-[#8B7355] hover:text-red-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={catPick} onChange={e => { setCatPick(e.target.value); setCatFree(''); }}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0] max-w-full">
              <option value="">Pick an existing category…</option>
              {unmappedCats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="text-[10px] text-[#8B7355]">or</span>
            <input value={catFree} onChange={e => { setCatFree(e.target.value); setCatPick(''); }}
                   placeholder="type a new category"
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0] w-44 max-w-full" />
            <button onClick={addCategory} disabled={busy || !(catFree.trim() || catPick)}
                    className="px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-xs flex items-center gap-1 disabled:opacity-50">
              <Plus className="w-3.5 h-3.5" /> Map
            </button>
          </div>
        </div>

        {/* ── User access ── */}
        <div>
          <div className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5 mb-1.5">
            <UsersIcon className="w-3.5 h-3.5 text-[#af4408]" />
            Authorized users
            <span className="text-[10px] font-normal text-[#8B7355]">
              (admins, HODs, store &amp; bar managers always have full access)
            </span>
          </div>
          {(store.access || []).length > 0 && (
            <div className="overflow-x-auto mb-2">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="text-[#6B5744]">
                  <tr>
                    <th className="text-left py-1.5 px-2 font-medium">User</th>
                    {PERM_COLS.map(p => (
                      <th key={p.key} className="text-center py-1.5 px-2 font-medium">{p.label}</th>
                    ))}
                    <th className="py-1.5 px-2" />
                  </tr>
                </thead>
                <tbody>
                  {(store.access || []).map(a => (
                    <tr key={a.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1.5 px-2">
                        <div className="font-medium text-[#2D1B0E]">{a.user_name || a.user_email}</div>
                        <div className="text-[10px] text-[#8B7355]">{a.user_email}</div>
                      </td>
                      {PERM_COLS.map(p => (
                        <td key={p.key} className="text-center py-1.5 px-2">
                          <input type="checkbox" checked={!!a[p.key]} disabled={busy}
                                 onChange={e => setPerm(a, p.key, e.target.checked)}
                                 className="accent-[#af4408] w-3.5 h-3.5"
                                 aria-label={`${p.label} for ${a.user_email}`} />
                        </td>
                      ))}
                      <td className="text-right py-1.5 px-2">
                        <button onClick={() => revokeUser(a)} disabled={busy}
                                title="Remove grant" className="text-[#8B7355] hover:text-red-600">
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select value={userPick} onChange={e => setUserPick(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0] max-w-full">
              <option value="">Grant a user…</option>
              {pickableUsers.map(u => (
                <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>
              ))}
            </select>
            <button onClick={grantUser} disabled={busy || !userPick}
                    className="px-2.5 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded text-xs flex items-center gap-1 disabled:opacity-50">
              <Plus className="w-3.5 h-3.5" /> Grant view
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
