'use client';

/**
 * Units page — editable registry.
 * Admins can add new units, edit toBase / aliases / label on existing ones,
 * and delete custom units. Built-ins are protected from deletion (force=1 override).
 * Server-side conversions immediately use the new values — no restart needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { Ruler, ArrowRight, Plus, Save, Trash2, X, Edit, Lock } from 'lucide-react';
// Trash2 etc all from lucide
import { api } from '@/lib/api';

type Dimension = 'volume' | 'weight' | 'count';
interface UnitRow {
  key: string;
  label: string;
  aliases: string[];
  dimension: Dimension;
  to_base: number;
  is_builtin: number;
  updated_at?: string;
}

const DIMENSION_TONE: Record<Dimension, { bg: string; text: string; label: string }> = {
  volume: { bg: 'bg-blue-50',    text: 'text-blue-700',    label: 'Volume (base: ml)' },
  weight: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Weight (base: g)' },
  count:  { bg: 'bg-amber-50',   text: 'text-amber-800',   label: 'Count (base: pcs)' },
};

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 6 });

export default function UnitsPage() {
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UnitRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [me, setMe] = useState<any>(null);

  const reload = async () => {
    setLoading(true);
    const [u, m] = await Promise.all([
      fetch('/api/units').then(r => r.json()),
      fetch('/api/auth/me').then(r => r.json()).catch(() => ({ user: null })),
    ]);
    setUnits(u.units || []);
    setMe(m.user);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const isAdmin = me?.role === 'admin';
  const grouped = useMemo(() => {
    const out: Record<Dimension, UnitRow[]> = { volume: [], weight: [], count: [] };
    for (const u of units) out[u.dimension].push(u);
    return out;
  }, [units]);

  // --- Live tester (same as before) ---
  const [qty, setQty]   = useState(1);
  const [from, setFrom] = useState('BTL');
  const [to, setTo]     = useState('ml');
  const [packSize, setPack]  = useState(750);
  const [recipeU, setRecipe] = useState('ml');
  const [materials, setMaterials] = useState<any[]>([]);
  const [matId, setMatId] = useState('');
  useEffect(() => {
    // scope=all — Unit Registry is admin-only and needs every material.
    fetch('/api/inventory?scope=all').then(r => r.json()).then(d => setMaterials(d.materials || []));
  }, []);
  useEffect(() => {
    if (!matId) return;
    const m = materials.find((x: any) => x.id === matId);
    if (!m) return;
    setFrom(m.purchase_unit || m.unit);
    setTo(m.unit);
    setPack(m.pack_size || 1);
    setRecipe(m.unit);
  }, [matId, materials]);
  const result = clientConvert(qty, from, to, units, recipeU, packSize);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Ruler className="w-6 h-6 text-[#af4408]" /> Unit Registry &amp; Conversions
          </h1>
          <p className="text-xs text-[#6B5744] mt-1">
            Three dimensions: <b>Volume</b> (base ml), <b>Weight</b> (base g), <b>Count</b> (base pcs).
            Admins can add new units or correct any factor — changes take effect immediately for new recipe conversions.
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setCreating(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Unit
          </button>
        )}
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}
      {!isAdmin && (
        <div className="text-xs text-[#6B5744] bg-[#FFF1E3] border border-[#D4B896] rounded p-2">
          Read-only view. Sign in as admin to add / edit units.
        </div>
      )}

      {/* Registry by dimension — editable */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(Object.keys(grouped) as Dimension[]).map(dim => {
          const tone = DIMENSION_TONE[dim];
          return (
            <div key={dim} className="border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className={`${tone.bg} ${tone.text} px-4 py-2 font-semibold text-sm`}>
                {tone.label} <span className="text-[10px] font-normal opacity-70">({grouped[dim].length})</span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">Unit</th>
                    <th className="text-right py-1.5 px-3 font-medium">→ Base</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Aliases</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[dim].map(u => (
                    <tr key={u.key} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1.5 px-3 font-mono font-semibold text-[#2D1B0E]">
                        {u.label}
                        {u.is_builtin ? <Lock className="w-3 h-3 inline ml-1 text-[#8B7355]" /> : null}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{fmt(u.to_base)}</td>
                      <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">
                        {u.aliases.filter(a => a.toLowerCase() !== u.key.toLowerCase()).join(', ') || '—'}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        {isAdmin && (
                          <button onClick={() => setEditing(u)} className="text-[#6B5744] hover:text-[#af4408]">
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          );
        })}
      </div>

      {/* Cross-dimension explanation */}
      <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 text-xs space-y-2">
        <div className="font-semibold text-amber-900 text-sm">Cross-Dimension Conversion (count ↔ volume/weight)</div>
        <p className="text-amber-900">
          Not derivable from the registry alone — it depends on each material's pack size. Define on every material:
          <code className="ml-1">recipe_unit</code>, <code>purchase_unit</code>, <code>pack_size</code> (e.g. 750 ml in 1 BTL).
        </p>
      </div>

      {/* Live tester */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
        <h3 className="text-sm font-semibold text-[#2D1B0E] mb-3">Try a Conversion</h3>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-2 text-xs items-end">
          <label className="flex flex-col gap-1 text-[#6B5744] md:col-span-2">
            <span>Material context</span>
            <select value={matId} onChange={e => setMatId(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]">
              <option value="">— manual —</option>
              {materials.slice(0, 200).map(m => (
                <option key={m.id} value={m.id}>{m.sku ? `${m.sku} — ` : ''}{m.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            <span>Qty</span>
            <input type="number" step="any" value={qty} onChange={e => setQty(Number(e.target.value) || 0)}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono" />
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            <span>From</span>
            <select value={from} onChange={e => setFrom(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono">
              {units.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            <span>To</span>
            <select value={to} onChange={e => setTo(e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono">
              {units.map(u => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            <span>Pack size</span>
            <input type="number" step="any" value={packSize} onChange={e => setPack(Number(e.target.value) || 1)}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono" />
          </label>
        </div>
        <div className="mt-3 text-sm">
          <div className="font-mono">
            {qty} <b>{from}</b> <ArrowRight className="w-3 h-3 inline mx-1" /> {' '}
            {result == null
              ? <span className="text-red-600">unconvertible</span>
              : <span className="text-emerald-700 font-semibold">{fmt(result)} <b>{to}</b></span>}
          </div>
        </div>
      </div>

      {/* Edit / create modal */}
      {(editing || creating) && (
        <UnitModal
          existing={editing}
          isNew={creating}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); }}
          onError={msg => setError(msg)}
        />
      )}
    </div>
  );
}

/* ---------- Edit modal ---------- */
function UnitModal({ existing, isNew, onClose, onSaved, onError }: {
  existing: UnitRow | null; isNew: boolean;
  onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState<UnitRow>(existing ?? {
    key: '', label: '', aliases: [], dimension: 'count', to_base: 1, is_builtin: 0,
  });
  const [aliasesText, setAliasesText] = useState((form.aliases || []).join(', '));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        key: form.key.trim(),
        label: form.label.trim() || form.key.trim(),
        aliases: aliasesText.split(',').map(s => s.trim()).filter(Boolean),
        dimension: form.dimension,
        to_base: Number(form.to_base),
      };
      if (!body.key) { onError('Key required'); setBusy(false); return; }
      const r = await api('/api/units', { method: isNew ? 'POST' : 'PUT', body });
      const j = await r.json();
      if (!r.ok) { onError(j.error || 'Save failed'); setBusy(false); return; }
      onSaved();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!existing) return;
    if (!confirm(`Delete unit "${existing.label}"?${existing.is_builtin ? '\n\nThis is a built-in — it will be re-seeded on next server restart.' : ''}`)) return;
    setBusy(true);
    try {
      const url = `/api/units?key=${encodeURIComponent(existing.key)}${existing.is_builtin ? '&force=1' : ''}`;
      const r = await api(url, { method: 'DELETE', body: {} });
      const j = await r.json();
      if (!r.ok) { onError(j.error || 'Delete failed'); setBusy(false); return; }
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md my-12 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">
            {isNew ? 'New Unit' : `Edit Unit — ${form.label}`}
            {!isNew && form.is_builtin ? <span className="ml-2 text-[10px] text-[#8B7355]"><Lock className="w-3 h-3 inline" /> built-in</span> : null}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Key (immutable, used as the canonical name)
            <input value={form.key} disabled={!isNew}
                   onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                   placeholder="e.g. CRATE / DRUM / oz"
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono disabled:bg-[#E8D5C4]/40 disabled:text-[#8B7355]" />
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Display label
            <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                   placeholder="how it shows in dropdowns"
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Dimension
            <select value={form.dimension} onChange={e => setForm(f => ({ ...f, dimension: e.target.value as Dimension }))}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]">
              <option value="volume">Volume (base: ml)</option>
              <option value="weight">Weight (base: g)</option>
              <option value="count">Count (base: pcs)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            → Base factor (1 {form.label || form.key || '?'} = ? base units)
            <input type="number" step="any" value={form.to_base}
                   onChange={e => setForm(f => ({ ...f, to_base: Number(e.target.value) || 0 }))}
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] font-mono" />
            <span className="text-[10px] text-[#8B7355]">
              Volume base = ml · Weight base = g · Count base = pcs.
              Example: 1 kg = 1000 g → to_base 1000.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Aliases <span className="text-[10px] text-[#8B7355]">(comma-separated; users typing these get resolved to the canonical key)</span>
            <input value={aliasesText} onChange={e => setAliasesText(e.target.value)}
                   placeholder="kg, kilo, kilogram"
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-between gap-2">
          {!isNew ? (
            <button onClick={remove} disabled={busy}
                    className="px-3 py-1.5 text-xs text-red-700 hover:text-red-900 inline-flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
            <button onClick={save} disabled={busy}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
              <Save className="w-4 h-4" /> {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Client-side converter (mirrors server logic for the live tester) ---------- */
function clientConvert(qty: number, fromKey: string, toKey: string,
                       units: UnitRow[], recipeUnit: string, packSize: number): number | null {
  if (!units || units.length === 0) return null;
  const idx: Record<string, UnitRow> = {};
  for (const u of units) {
    idx[u.key.toLowerCase()] = u;
    for (const a of u.aliases) idx[a.toLowerCase()] = u;
  }
  const f = idx[fromKey.toLowerCase()];
  const t = idx[toKey.toLowerCase()];
  if (!f || !t) return null;
  if (f.key === t.key) return qty;
  if (f.dimension === t.dimension) {
    return (qty * f.to_base) / t.to_base;
  }
  const ps = packSize && packSize > 1 ? packSize : 0;
  if (ps <= 0) return null;
  const bridge = idx[recipeUnit.toLowerCase()];
  if (!bridge) return null;
  let qtyInBridge: number;
  if (f.dimension === 'count') qtyInBridge = qty * ps;
  else if (f.dimension === bridge.dimension) qtyInBridge = (qty * f.to_base) / bridge.to_base;
  else return null;
  if (t.dimension === 'count') return qtyInBridge / ps;
  if (t.dimension === bridge.dimension) return (qtyInBridge * bridge.to_base) / t.to_base;
  return null;
}
