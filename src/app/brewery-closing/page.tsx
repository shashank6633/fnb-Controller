'use client';

/**
 * Brewery Closing Stock — owner rulings 118, 120, 121 (2026-11-07).
 *
 * One page for the Brewery's count day:
 *   · Beer        — litres found in each Brewery batch (per batch). A RECORD
 *                   only: it never changes a batch; an admin corrects a batch
 *                   with Waste / Dispose on Brewery Production. Expected litres
 *                   and the difference are shown to admin, manager and HOD only
 *                   (the server sends them to no one else).
 *                   API: /api/kitchen-production/brewery-closing.
 *   · Malts & hops — the Brewery DEPARTMENT's ordinary closing count, saved
 *                   through the same /api/closing-stock every closing screen
 *                   uses, so it shows on Closing Stock — One Department / All
 *                   Departments / Closing Overview exactly like any department's
 *                   count (department scope, blind count and the zero check are
 *                   that route's own). Counted in PURCHASE units, stored ×pack.
 *   · Beer in hand — admin / manager / HOD: what each batch held at the end of
 *                   any day, rebuilt from batch history, with Excel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import * as XLSX from 'xlsx';
import { Beer, ClipboardList, Download, Loader2, Plus, RefreshCw, Save, Search, Wheat } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';
import { packFactor } from '@/lib/pack-units';

interface Me {
  id: string; email: string; name?: string; role: string;
  is_head_chef?: boolean; is_store_manager?: boolean;
  department_id?: string | null; visible_department_ids?: string | null;
}
interface BeerRow {
  batch_id: string; batch_number: string; barcode: string; item_name: string;
  production_date: string; production_time: string; unit: string; status: string;
  storage_location: string; produced: number;
  counted: number | null; counted_by: string; counted_at: string;
  expected: number | null; difference: number | null;
}
interface OtherBatch { batch_id: string; batch_number: string; barcode: string; item_name: string; production_date: string; unit: string; status: string }
interface Material {
  id: string; name: string; category: string; unit: string; purchase_unit: string;
  pack_size: number; is_active?: number;
}
interface InHandRow {
  batch_id: string; batch_number: string; barcode: string; item_name: string; production_date: string;
  unit: string; status: string; storage_location: string; produced: number; out_by_date: number; in_hand: number;
  counted: number | null; counted_by: string; difference: number | null;
}
interface InHandTotal { item_name: string; unit: string; batches: number; produced: number; out_by_date: number; in_hand: number }

type Tab = 'beer' | 'materials' | 'in-hand';

const num = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const inputCls = 'w-full px-2.5 py-2 border border-[#D4B896] rounded-lg text-sm bg-white text-[#2D1B0E] focus:outline-none focus:ring-2 focus:ring-[#af4408]/30';

export default function BreweryClosingPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [date, setDate] = useState(todayIST());
  const [tab, setTab] = useState<Tab>('beer');
  const today = todayIST();

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => setMe(null));
  }, []);
  // Expected litres / Beer in hand: admin, manager, HOD (ruling 120) — the
  // server enforces it; this only decides which tabs to offer.
  const seesExpected = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef);

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-[#af4408]" /> Brewery Closing Stock
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">Count the beer in each batch and the Brewery’s malts, hops, yeast and salts for the day.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[#6B5744]">Date</label>
          <input type="date" value={date} max={today}
                 onChange={e => setDate(e.target.value && e.target.value <= today ? e.target.value : today)}
                 className="px-2.5 py-1.5 border border-[#D4B896] rounded-lg text-sm bg-white" />
          <Link href="/brewery-production"
                className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-1.5">
            <Beer className="w-4 h-4" /> <span className="hidden sm:inline">Brewery Production</span>
          </Link>
        </div>
      </div>

      <div className="flex gap-1 border-b border-[#E8D5C4] overflow-x-auto">
        {([['beer', 'Beer (per batch)'], ['materials', 'Malts & hops'], ...(seesExpected ? [['in-hand', 'Beer in hand']] : [])] as [Tab, string][])
          .map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
                    className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === k ? 'border-[#af4408] text-[#af4408] font-semibold' : 'border-transparent text-[#6B5744] hover:text-[#2D1B0E]'}`}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'beer' && <BeerCount date={date} />}
      {tab === 'materials' && me && <MaterialsCount date={date} me={me} />}
      {tab === 'in-hand' && seesExpected && <BeerInHand date={date} />}
    </div>
  );
}

// ─── Beer, per batch ────────────────────────────────────────────────────
function BeerCount({ date }: { date: string }) {
  const [rows, setRows] = useState<BeerRow[]>([]);
  const [others, setOthers] = useState<OtherBatch[]>([]);
  const [sees, setSees] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<OtherBatch[]>([]);
  const [addPick, setAddPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch(`/api/kitchen-production/brewery-closing?date=${encodeURIComponent(date)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRows(j.batches || []); setOthers(j.others || []); setSees(!!j.can_see_expected);
    } catch (e: any) {
      setRows([]); setOthers([]); setLoadError(e?.message || 'Could not load the beer count sheet');
    } finally { setLoading(false); }
  }, [date]);
  useEffect(() => { setEntries({}); setAdded([]); setResult(null); load(); }, [load]);

  const addable = others.filter(o => !added.some(a => a.batch_id === o.batch_id));
  const shown: (BeerRow | (OtherBatch & { extra: true }))[] = [...rows, ...added.map(a => ({ ...a, extra: true as const }))];

  const save = async () => {
    const counts = Object.entries(entries)
      .filter(([, v]) => v.trim() !== '')
      .map(([batch_id, counted]) => ({ batch_id, counted: counted.trim() }));
    if (counts.length === 0) { setResult({ kind: 'err', text: 'Type a count for at least one batch.' }); return; }
    setSaving(true); setResult(null);
    try {
      const r = await api('/api/kitchen-production/brewery-closing', { method: 'POST', body: { date, counts } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setResult({ kind: 'ok', text: `Saved ${j.saved} beer count${j.saved === 1 ? '' : 's'} for ${fmtISTDate(date)}.` });
      setEntries({}); setAdded([]);
      await load();
    } catch (e: any) {
      setResult({ kind: 'err', text: e?.message || 'Could not save' });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="text-[12px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
        Type the litres you find in each batch. A count is a record — it does not change the batch.
        {sees
          ? ' You see the expected litres and the difference; counters do not.'
          : ' Expected litres are not shown here (blind count).'}
      </div>
      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
      ) : loadError ? (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center justify-between gap-2">
          {loadError}
          <button onClick={load} className="px-2 py-1 bg-red-600 text-white rounded text-xs flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Retry</button>
        </div>
      ) : shown.length === 0 ? (
        <div className="p-6 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          No Brewery batch holds beer on {fmtISTDate(date)}.
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E2D2]">
          {shown.map(r => {
            const full = 'extra' in r ? null : r;
            return (
              <div key={r.batch_id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[#2D1B0E] text-sm truncate">{r.item_name}</div>
                  <div className="text-[11px] text-[#6B5744] break-all">
                    <span className="font-mono">{r.batch_number || r.barcode}</span>
                    {' · brewed '}{r.production_date ? fmtISTDate(r.production_date) : '—'}
                    {r.status && r.status !== 'active' ? <span className="capitalize"> · {r.status}</span> : null}
                    {'extra' in r ? <span className="text-amber-700"> · added by you</span> : null}
                  </div>
                  {full && full.counted != null && (
                    <div className="text-[11px] text-emerald-700">
                      Saved {num(full.counted)} {full.unit}{full.counted_by ? ` by ${full.counted_by}` : ''}{full.counted_at ? ` · ${fmtIST(full.counted_at)}` : ''}
                    </div>
                  )}
                </div>
                {sees && full && (
                  <div className="text-[11px] text-[#6B5744] sm:w-28 sm:text-right">
                    Expected <b className="text-[#2D1B0E]">{num(full.expected)} {full.unit}</b>
                    {full.difference != null && (
                      <div className={full.difference < 0 ? 'text-red-700' : full.difference > 0 ? 'text-emerald-700' : 'text-[#8B7355]'}>
                        Difference {full.difference > 0 ? '+' : ''}{num(full.difference)}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-1.5 sm:w-44">
                  <input type="number" inputMode="decimal" min={0} step="any"
                         value={entries[r.batch_id] ?? ''}
                         onChange={e => setEntries(p => ({ ...p, [r.batch_id]: e.target.value }))}
                         placeholder={full && full.counted != null ? 'new count' : 'count'}
                         className={inputCls} />
                  <span className="text-xs text-[#6B5744] shrink-0 w-8">{r.unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && !loadError && addable.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <select value={addPick} onChange={e => setAddPick(e.target.value)}
                  className="px-2.5 py-2 border border-[#D4B896] rounded-lg text-sm bg-white max-w-full">
            <option value="">Beer in a batch not listed? Pick it…</option>
            {addable.map(o => (
              <option key={o.batch_id} value={o.batch_id}>
                {o.item_name} · {o.batch_number || o.barcode} · {o.production_date ? fmtISTDate(o.production_date) : '—'}
              </option>
            ))}
          </select>
          <button disabled={!addPick}
                  onClick={() => { const o = others.find(x => x.batch_id === addPick); if (o) setAdded(p => [...p, o]); setAddPick(''); }}
                  className="px-3 py-2 border border-[#af4408] text-[#af4408] rounded-lg text-sm flex items-center gap-1 disabled:opacity-40">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      )}

      {result && (
        <div role={result.kind === 'err' ? 'alert' : undefined}
             className={`text-sm rounded-lg px-3 py-2 ${result.kind === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {result.text}
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={save} disabled={saving || loading}
                className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save beer counts
        </button>
      </div>
    </div>
  );
}

// ─── Malts & hops — the Brewery department's ordinary closing count ─────
function MaterialsCount({ date, me }: { date: string; me: Me }) {
  const [departments, setDepartments] = useState<{ id: string; name: string; is_active: number }[]>([]);
  const [deptId, setDeptId] = useState('');
  const [items, setItems] = useState<Material[]>([]);
  const [saved, setSaved] = useState<Record<string, { physical_stock: number; recorded_by?: string }>>({});
  const [extra, setExtra] = useState<Material[]>([]);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Material[]>([]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [zeroAsk, setZeroAsk] = useState<string | null>(null);

  // Same rule as Closing Stock — One Department: Admin / Manager / HOD / Store
  // Manager pick any department; everyone else their own + granted ones.
  const canSeeAll = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef || !!me.is_store_manager;
  const granted = useMemo(() => {
    try { const a = JSON.parse(me.visible_department_ids || '[]'); return Array.isArray(a) ? a.map(String) : []; }
    catch { return []; }
  }, [me]);
  useEffect(() => {
    fetch('/api/departments').then(r => r.json()).then(d => {
      const list = ((d?.departments || []) as any[]).filter(x => x.is_active);
      setDepartments(list);
      // A user who may pick any department starts on the one named like
      // "Brewery" (this is the Brewery page — a Kitchen manager must not land
      // on Kitchen's list), else their own; everyone else is on their own
      // department. Only a starting point: nothing is saved until Save, and the
      // Save button names the department it saves into.
      const brewery = list.find(x => /brew/i.test(x.name))?.id || '';
      setDeptId(prev => prev || (canSeeAll ? (brewery || me.department_id || '') : (me.department_id || '')));
    }).catch(() => {});
  }, [me, canSeeAll]);
  const pickable = canSeeAll ? departments : departments.filter(d => d.id === me.department_id || granted.includes(d.id));

  const load = useCallback(async () => {
    if (!deptId) { setItems([]); setSaved({}); return; }
    setLoading(true); setLoadError(null);
    try {
      const qs = new URLSearchParams({ dept_items: '1', department_id: deptId, date });
      const [a, b] = await Promise.all([
        fetch(`/api/closing-stock?${qs}`).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }),
        fetch(`/api/closing-stock?date=${encodeURIComponent(date)}&department_id=${encodeURIComponent(deptId)}`).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; }),
      ]);
      setItems(a.items || []);
      const map: Record<string, { physical_stock: number; recorded_by?: string }> = {};
      for (const row of (b.items || []) as any[]) map[String(row.material_id)] = { physical_stock: Number(row.physical_stock) || 0, recorded_by: row.recorded_by };
      setSaved(map);
    } catch (e: any) {
      setItems([]); setSaved({}); setLoadError(e?.message || 'Could not load the count list');
    } finally { setLoading(false); }
  }, [deptId, date]);
  useEffect(() => { setEntries({}); setExtra([]); setResult(null); load(); }, [load]);

  const runSearch = async () => {
    if (!deptId || !search.trim()) return;
    const qs = new URLSearchParams({ dept_items: '1', department_id: deptId, date, search: search.trim() });
    const j = await fetch(`/api/closing-stock?${qs}`).then(r => r.json()).catch(() => null);
    setCandidates((j?.candidates || []).filter((c: Material) => !extra.some(x => x.id === c.id)));
  };

  const list = [...items, ...extra.filter(x => !items.some(i => i.id === x.id))];

  const save = async (confirmZeros = false) => {
    const byId = new Map(list.map(m => [m.id, m]));
    const out = Object.entries(entries)
      .filter(([id, v]) => v.trim() !== '' && byId.has(id))
      .map(([id, v]) => {
        const q = Number(v.trim());
        // Counted in PURCHASE units; stored in recipe units (×pack) — the same
        // conversion as the Record Closing Stock sheet.
        return { material_id: id, physical_stock: Number.isFinite(q) ? Math.round(q * packFactor(byId.get(id)!) * 1e6) / 1e6 : v };
      });
    if (out.length === 0) { setResult({ kind: 'err', text: 'Type a count for at least one item.' }); return; }
    const bad = out.filter(o => typeof o.physical_stock !== 'number' || o.physical_stock < 0);
    if (bad.length) { setResult({ kind: 'err', text: 'Counts must be numbers, 0 or more.' }); return; }
    setSaving(true); setResult(null); setZeroAsk(null);
    try {
      const r = await api('/api/closing-stock', {
        method: 'POST',
        body: { date, department_id: deptId, items: out, confirm_zeros: confirmZeros },
      });
      const j = await r.json();
      if (r.status === 409 && j?.zero_guard) { setZeroAsk(j.error || 'Many of these counts are 0.'); return; }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const n = typeof j.success === 'number' ? j.success : out.length;
      const errs: string[] = Array.isArray(j.errors) ? j.errors : [];
      setResult({ kind: errs.length ? 'err' : 'ok', text: `Saved ${n} count${n === 1 ? '' : 's'} for ${fmtISTDate(date)}.${errs.length ? ' Not saved: ' + errs.join(' ') : ''}` });
      setEntries({}); setExtra([]);
      await load();
    } catch (e: any) {
      setResult({ kind: 'err', text: e?.message || 'Could not save' });
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-[#6B5744]">Department</label>
        <select value={deptId} onChange={e => setDeptId(e.target.value)} disabled={pickable.length <= 1 && !!deptId}
                className="px-2.5 py-1.5 border border-[#D4B896] rounded-lg text-sm bg-white">
          {!deptId && <option value="">Pick the Brewery department…</option>}
          {pickable.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <span className="text-[11px] text-[#8B7355]">Saved here = the same department count every closing screen shows.</span>
      </div>

      {!deptId ? (
        <div className="p-4 text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
          Your login has no department. Ask an admin to set your department to Brewery, or pick one above.
        </div>
      ) : loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>
      ) : loadError ? (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center justify-between gap-2">
          {loadError}
          <button onClick={load} className="px-2 py-1 bg-red-600 text-white rounded text-xs flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Retry</button>
        </div>
      ) : (
        <>
          {list.length === 0 ? (
            <div className="p-4 text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">
              Nothing on this department’s list yet — items appear once the department has requested them. Use the search below to add one.
            </div>
          ) : (
            <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E2D2]">
              {list.map(m => {
                const pf = packFactor(m);
                const s = saved[m.id];
                return (
                  <div key={m.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[#2D1B0E] text-sm truncate">{m.name}</div>
                      <div className="text-[11px] text-[#6B5744]">
                        {m.category || '—'}{pf > 1 ? ` · 1 ${m.purchase_unit} = ${num(pf)} ${m.unit}` : ''}
                        {m.is_active === 0 ? ' · switched off' : ''}
                      </div>
                      {s && (
                        <div className="text-[11px] text-emerald-700">
                          Saved {num(s.physical_stock / pf)} {m.purchase_unit}{s.recorded_by ? ` by ${s.recorded_by}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 sm:w-44">
                      <input type="number" inputMode="decimal" min={0} step="any"
                             value={entries[m.id] ?? ''}
                             onChange={e => setEntries(p => ({ ...p, [m.id]: e.target.value }))}
                             placeholder={s ? 'new count' : 'count'} className={inputCls} />
                      <span className="text-xs text-[#6B5744] shrink-0 w-10 truncate">{m.purchase_unit}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[12rem]">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#8B7355]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                     onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                     placeholder="Item not listed? Search by name…" className={`${inputCls} pl-8`} />
            </div>
            <button onClick={runSearch} className="px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744]">Search</button>
          </div>
          {candidates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {candidates.slice(0, 20).map(c => (
                <button key={c.id} onClick={() => { setExtra(p => [...p, c]); setCandidates(p => p.filter(x => x.id !== c.id)); }}
                        className="px-2 py-1 bg-[#FFF1E3] border border-[#E8D5C4] rounded-full text-xs text-[#2D1B0E] flex items-center gap-1">
                  <Plus className="w-3 h-3" /> {c.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {zeroAsk && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900 space-y-2">
          <div>{zeroAsk}</div>
          <div className="flex gap-2">
            <button onClick={() => save(true)} className="px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-semibold">Yes, they really are 0 — save</button>
            <button onClick={() => setZeroAsk(null)} className="px-3 py-1.5 border border-amber-400 rounded-lg text-xs">Go back</button>
          </div>
        </div>
      )}
      {result && (
        <div role={result.kind === 'err' ? 'alert' : undefined}
             className={`text-sm rounded-lg px-3 py-2 ${result.kind === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          {result.text}
        </div>
      )}
      {deptId && (
        <div className="flex justify-end">
          <button onClick={() => save(false)} disabled={saving || loading}
                  className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wheat className="w-4 h-4" />}
            Save counts for {departments.find(d => d.id === deptId)?.name || 'this department'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Beer in hand (admin / manager / HOD) ───────────────────────────────
function BeerInHand({ date }: { date: string }) {
  const [rows, setRows] = useState<InHandRow[]>([]);
  const [totals, setTotals] = useState<InHandTotal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/kitchen-production/brewery-closing/in-hand?date=${encodeURIComponent(date)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setRows(j.batches || []); setTotals(j.totals || []);
    } catch (e: any) {
      setRows([]); setTotals([]); setError(e?.message || 'Could not load beer in hand');
    } finally { setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const download = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totals.map(t => ({
      'Beer': t.item_name, 'Unit': t.unit, 'Batches': t.batches,
      'Brewed': t.produced, 'Used / wasted to date': t.out_by_date, 'In hand': t.in_hand,
    }))), 'By beer');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map(r => ({
      'Beer': r.item_name, 'Batch no.': r.batch_number, 'Barcode': r.barcode, 'Brewed on': r.production_date,
      'Status today': r.status, 'Unit': r.unit, 'Brewed': r.produced, 'Used / wasted to date': r.out_by_date,
      'In hand': r.in_hand, 'Counted': r.counted ?? '', 'Difference': r.difference ?? '', 'Counted by': r.counted_by,
      'Storage': r.storage_location,
    }))), 'By batch');
    XLSX.writeFile(wb, `beer-in-hand-${date}.xlsx`);
  };

  if (loading) return <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline" /> Loading…</div>;
  if (error) return <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[12px] text-[#6B5744]">
          Beer held at the end of {fmtISTDate(date)} — brewed minus what was used, wasted or disposed up to that day.
        </div>
        <button onClick={download} disabled={rows.length === 0}
                className="px-3 py-1.5 bg-white border border-[#af4408] text-[#af4408] rounded-lg text-sm font-medium flex items-center gap-1.5 disabled:opacity-40">
          <Download className="w-4 h-4" /> Excel
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-[#8B7355] bg-white border border-[#E8D5C4] rounded-xl">No beer in hand on {fmtISTDate(date)}.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {totals.map(t => (
              <div key={`${t.item_name}|${t.unit}`} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="text-sm font-semibold text-[#2D1B0E] truncate">{t.item_name}</div>
                <div className="text-2xl font-bold text-emerald-700 break-all">{num(t.in_hand)} <span className="text-sm font-medium">{t.unit}</span></div>
                <div className="text-[11px] text-[#8B7355]">{t.batches} batch{t.batches === 1 ? '' : 'es'} · brewed {num(t.produced)} · used/wasted {num(t.out_by_date)}</div>
              </div>
            ))}
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF8F0] text-[11px] text-[#6B5744] uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Beer / batch</th>
                  <th className="text-right px-3 py-2">Brewed</th>
                  <th className="text-right px-3 py-2">Used / wasted</th>
                  <th className="text-right px-3 py-2">In hand</th>
                  <th className="text-right px-3 py-2">Counted</th>
                  <th className="text-right px-3 py-2">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E2D2]">
                {rows.map(r => (
                  <tr key={r.batch_id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-[#2D1B0E]">{r.item_name}</div>
                      <div className="text-[11px] text-[#6B5744] font-mono break-all">{r.batch_number || r.barcode} · {r.production_date ? fmtISTDate(r.production_date) : '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{num(r.produced)} {r.unit}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{num(r.out_by_date)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-semibold text-emerald-700">{num(r.in_hand)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{num(r.counted)}</td>
                    <td className={`px-3 py-2 text-right whitespace-nowrap ${r.difference == null ? '' : r.difference < 0 ? 'text-red-700' : r.difference > 0 ? 'text-emerald-700' : ''}`}>
                      {r.difference == null ? '—' : `${r.difference > 0 ? '+' : ''}${num(r.difference)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
