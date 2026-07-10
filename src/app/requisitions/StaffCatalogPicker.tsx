'use client';

/**
 * StaffCatalogPicker — mobile-first catalog-and-cart requisition flow for
 * plain department staff (Recaho-POS-style: category rail + item cards + cart).
 *
 * Replaces CreateRequisitionModal for staff (non-admin / non-HOD / non-store /
 * non-manager) for BOTH new requisitions and draft editing. Privileged roles
 * keep the classic form.
 *
 * Data conventions (see project F&B Unit Convention):
 *   - current_stock is in RECIPE units → shown here in PURCHASE units (÷ pack_size)
 *   - average_price is ₹/recipe-unit → line/cart totals = qty × packFactor × average_price
 *   - quantities entered here are in the line's requested unit: new adds use the
 *     PURCHASE unit (same as the classic staff form, where onPick sets
 *     unit = purchase_unit || unit); draft lines keep their existing unit.
 *   - POST body identical to CreateRequisitionModal:
 *       {date, department_id, notes, items:[{material_id, quantity_requested, unit, notes}]}
 *     Edit mode PUTs {id, date, department_id, notes, items} (mirrors the
 *     modal's isEditing branch). "Submit to HOD" then POSTs
 *     /api/requisitions/<id>/submit.
 */

import { useMemo, useState } from 'react';
import { Loader2, Minus, Plus, Search, Send, ShoppingCart, X } from 'lucide-react';
import { api } from '@/lib/api';

interface Material {
  id: string; name: string; sku?: string; unit: string;
  current_stock: number; average_price: number;
  last_purchase_price?: number; last_purchase_date?: string;
  reorder_level?: number;
  purchase_unit?: string; pack_size?: number;
  category?: string;
}
interface Department { id: string; name: string; code?: string; }
/** Minimal shape of a draft requisition being edited (subset of page.tsx's
 *  Requisition — structurally compatible, so the page can pass it straight in). */
interface DraftItem {
  material_id: string; quantity_requested: number; unit?: string;
  material_name: string; material_unit: string;
  material_purchase_unit?: string; material_pack_size?: number;
  current_stock: number; average_price: number; last_purchase_price?: number;
}
interface EditDraft {
  id: string; req_number: string; date: string;
  department_id: string; notes: string;
  items?: DraftItem[];
}

/** Recipe-units per 1 purchase-unit (pack factor). ×pack only when the
 *  purchase unit differs from the recipe unit and pack_size > 1 — the same
 *  convention as reqPackFactor / createTotal in page.tsx. */
function packFactor(m: Material): number {
  const pack = Number(m.pack_size) || 1;
  return (m.purchase_unit && m.purchase_unit !== m.unit && pack > 1) ? pack : 1;
}
/** Recipe-units per 1 of the unit a LINE was requested in — ×pack only when
 *  that unit is the material's purchase unit (createTotal / reqPackFactor). */
function lineFactor(m: Material, unit: string): number {
  const pack = Number(m.pack_size) || 1;
  return (unit && m.purchase_unit && unit === m.purchase_unit && unit !== m.unit && pack > 1) ? pack : 1;
}
/** ₹ per PURCHASE unit: prefer last_purchase_price (already ₹/PU), else
 *  average_price (₹/recipe-unit) × pack factor. Mirrors the classic form. */
function pricePerPU(m: Material): number {
  return Number(m.last_purchase_price) > 0
    ? Number(m.last_purchase_price)
    : (m.average_price || 0) * packFactor(m);
}
/** Ordering unit label. */
function pu(m: Material): string { return m.purchase_unit || m.unit || ''; }

const inr = (v: number, dp = 0) =>
  '₹' + (v || 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function StaffCatalogPicker({ materials, me, departments, editDraft, onClose, onCreated }: {
  materials: Material[];
  me: { role?: string; email?: string; department_id?: string | null } | null;
  departments: Department[];
  /** When set, the picker edits this draft (PUT) instead of creating (POST). */
  editDraft?: EditDraft | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const isEditing = !!editDraft;
  const today = new Date().toISOString().slice(0, 10);
  const date = editDraft?.date || today;
  // Edit mode keeps the draft's own department; otherwise staff are locked to
  // their home department (server enforces this on POST too).
  const deptId = editDraft?.department_id || me?.department_id || '';
  const dept = departments.find(d => d.id === deptId);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  /** material_id → qty, in the unit recorded in unitById. */
  const [cart, setCart] = useState<Record<string, number>>(() =>
    Object.fromEntries((editDraft?.items || [])
      .filter(it => it.material_id && it.quantity_requested > 0)
      .map(it => [it.material_id, it.quantity_requested])));
  /** material_id → unit the line is requested in. Draft lines keep their saved
   *  unit (may be the recipe unit on legacy rows); new adds use purchase unit. */
  const [unitById, setUnitById] = useState<Record<string, string>>(() =>
    Object.fromEntries((editDraft?.items || [])
      .filter(it => it.material_id)
      .map(it => [it.material_id, it.unit || it.material_unit])));
  const [cartOpen, setCartOpen] = useState(false);
  const [notes, setNotes] = useState(editDraft?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phantom materials for draft lines whose material is no longer in the
  // staff's catalog (deleted / re-scoped) — keeps the line visible in the cart
  // labeled from the draft's own data.
  const matById = useMemo(() => {
    const map = new Map<string, Material>(materials.map(m => [m.id, m]));
    for (const it of editDraft?.items || []) {
      if (!it.material_id || map.has(it.material_id)) continue;
      map.set(it.material_id, {
        id: it.material_id,
        name: it.material_name || '(material removed)',
        unit: it.material_unit || '',
        purchase_unit: it.material_purchase_unit,
        pack_size: it.material_pack_size,
        current_stock: it.current_stock || 0,
        average_price: it.average_price || 0,
        last_purchase_price: it.last_purchase_price,
      });
    }
    return map;
  }, [materials, editDraft]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of materials) if (m.category) set.add(m.category);
    return ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [materials]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return materials.filter(m => {
      if (category !== 'All' && (m.category || '') !== category) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || (m.sku || '').toLowerCase().includes(q);
    });
  }, [materials, category, search]);

  const unitOf = (m: Material) => unitById[m.id] || pu(m);

  const cartLines = useMemo(() =>
    Object.entries(cart)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ m: matById.get(id)!, qty }))
      .filter(l => !!l.m),
    [cart, matById]);

  const cartCount = cartLines.length;
  // Cart total = Σ qty × line pack-factor × avg ₹/recipe-unit (same as createTotal).
  const lineValue = (m: Material, qty: number) => qty * lineFactor(m, unitOf(m)) * (m.average_price || 0);
  const cartTotal = cartLines.reduce((s, l) => s + lineValue(l.m, l.qty), 0);

  const setQty = (m: Material, qty: number) => {
    setCart(prev => {
      const n = { ...prev };
      if (qty <= 0) delete n[m.id]; else n[m.id] = qty;
      return n;
    });
    setUnitById(prev => {
      if (qty <= 0) { const n = { ...prev }; delete n[m.id]; return n; }
      return prev[m.id] ? prev : { ...prev, [m.id]: pu(m) };
    });
  };

  // Same POST/PUT + submit flow as CreateRequisitionModal.save().
  const save = async (submitAfter: boolean) => {
    if (!deptId) {
      setError('Your user has no home department set. Ask an admin to assign one on /users.');
      return;
    }
    if (cartLines.length === 0) { setError('Add at least one item.'); return; }
    setSaving(true); setError(null);
    try {
      const items = cartLines.map(l => ({
        material_id: l.m.id,
        quantity_requested: l.qty,
        unit: unitOf(l.m),
        notes: '',
      }));
      const r = isEditing
        ? await api('/api/requisitions', {
            method: 'PUT',
            body: { id: editDraft!.id, date, department_id: deptId, notes, items },
          })
        : await api('/api/requisitions', {
            method: 'POST',
            body: { date, department_id: deptId, notes, items },
          });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'Failed to save requisition'); return; }
      if (submitAfter) {
        const j = await r.json().catch(() => ({}));
        const targetId = isEditing ? editDraft!.id : j?.requisition?.id;
        if (targetId) {
          const s = await api(`/api/requisitions/${targetId}/submit`, { method: 'POST', body: {} });
          if (!s.ok) {
            const sj = await s.json().catch(() => ({}));
            alert('Saved as draft, but submit to HOD failed: ' + (sj.error || 'unknown') +
                  '\nYou can submit it from the requisition’s detail view.');
          }
        } else {
          alert('Saved as draft. Open it to submit to HOD.');
        }
      }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-[#E8D5C4] bg-[#FFF8F0]">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="min-w-0">
            <div className="text-sm font-bold text-[#2D1B0E] truncate">
              {isEditing
                ? `Edit Draft ${editDraft!.req_number}`
                : dept ? `${dept.code ? `[${dept.code}] ` : ''}${dept.name}` : 'New Requisition'}
            </div>
            <div className="text-[11px] text-[#8B7355]">
              {isEditing && dept ? `${dept.name} · ` : ''}{date}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-2 text-[#8B7355]">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by Item Name"
            className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg bg-white text-sm"
          />
        </div>
      </div>

      {/* ── Body: category rail + item list ─────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left category rail */}
        <div className="w-28 shrink-0 overflow-y-auto bg-[#F5F5F5] border-r border-[#E8D5C4] p-1.5 space-y-1.5">
          {categories.map(c => (
            <button key={c} onClick={() => setCategory(c)}
                    className={`w-full px-2 py-2.5 rounded-lg text-[11px] font-semibold leading-tight text-center break-words ${
                      category === c
                        ? 'bg-blue-500 text-white shadow'
                        : 'bg-white text-[#2D1B0E] border border-[#E8D5C4]'
                    }`}>
              {c}
            </button>
          ))}
        </div>

        {/* Right item list */}
        <div className="flex-1 min-w-0 overflow-y-auto bg-[#FAFAFA] p-2 space-y-2 pb-4">
          {materials.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
              No materials available for your department yet.
            </div>
          ) : visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              No items match{search ? ` “${search}”` : ''}{category !== 'All' ? ` in ${category}` : ''}.
            </div>
          ) : visible.map(m => {
            const qty = cart[m.id] || 0;
            // Stock is stored in RECIPE units; show it in the purchase unit.
            const stockInPU = (m.current_stock || 0) / packFactor(m);
            return (
              <div key={m.id} className="bg-white rounded-lg border border-[#E8D5C4] p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold text-[#2D1B0E] uppercase leading-snug break-words">{m.name}</div>
                  {m.current_stock > 0 ? (
                    <div className="text-[11px] text-emerald-600 font-medium mt-0.5">
                      Stock : {stockInPU.toLocaleString('en-IN', { maximumFractionDigits: 1 })} / {pu(m)}
                    </div>
                  ) : (
                    <div className="text-[11px] text-red-500 font-medium mt-0.5">Stock : - / -</div>
                  )}
                  <div className="text-[11px] text-[#6B5744] mt-0.5">
                    {inr(pricePerPU(m), 2)} / {pu(m)}
                  </div>
                </div>
                {qty > 0 ? (
                  <div className="shrink-0 flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-lg">
                    <button onClick={() => setQty(m, qty - 1)} aria-label={`Decrease ${m.name}`}
                            className="px-2.5 py-2 text-blue-700"><Minus className="w-4 h-4" /></button>
                    <span className="min-w-[2ch] text-center text-sm font-bold text-[#2D1B0E] tabular-nums">{qty}</span>
                    <button onClick={() => setQty(m, qty + 1)} aria-label={`Increase ${m.name}`}
                            className="px-2.5 py-2 text-blue-700"><Plus className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <button onClick={() => setQty(m, 1)}
                          className="shrink-0 bg-gray-200 hover:bg-gray-300 rounded font-bold px-4 py-2 text-sm text-[#2D1B0E]">
                    ADD
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Sticky bottom bar ────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#E8D5C4] bg-white p-2 flex gap-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        <button onClick={onClose}
                className="shrink-0 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-bold">
          BACK
        </button>
        <button onClick={() => cartCount > 0 && setCartOpen(true)}
                disabled={cartCount === 0}
                className="flex-1 min-w-0 px-3 py-3 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2">
          <ShoppingCart className="w-4 h-4 shrink-0" />
          <span className="truncate">CART {cartCount} ITEM{cartCount === 1 ? '' : 'S'} · TOTAL {inr(cartTotal)}</span>
        </button>
      </div>

      {/* ── Cart sheet (slide-up) ────────────────────────────── */}
      {cartOpen && (
        <div className="absolute inset-0 z-10 bg-black/40 flex flex-col justify-end" onClick={() => !saving && setCartOpen(false)}>
          <div className="bg-white rounded-t-2xl max-h-[85%] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
              <div className="text-sm font-bold text-[#2D1B0E] flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" /> Cart · {cartCount} item{cartCount === 1 ? '' : 's'}
              </div>
              <button onClick={() => !saving && setCartOpen(false)} aria-label="Close cart" className="p-1 text-[#8B7355]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {cartLines.length === 0 ? (
                <div className="py-6 text-center text-sm text-[#8B7355]">Cart is empty.</div>
              ) : cartLines.map(({ m, qty }) => (
                <div key={m.id} className="flex items-center gap-2 border border-[#E8D5C4] rounded-lg p-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-[#2D1B0E] break-words">{m.name}</div>
                    <div className="text-[10px] text-[#8B7355]">
                      {qty} {unitOf(m)} · {inr(lineValue(m, qty))}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-lg">
                    <button onClick={() => setQty(m, qty - 1)} disabled={saving} aria-label={`Decrease ${m.name}`}
                            className="px-2 py-1.5 text-blue-700"><Minus className="w-3.5 h-3.5" /></button>
                    <span className="min-w-[2ch] text-center text-xs font-bold tabular-nums">{qty}</span>
                    <button onClick={() => setQty(m, qty + 1)} disabled={saving} aria-label={`Increase ${m.name}`}
                            className="px-2 py-1.5 text-blue-700"><Plus className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}

              <label className="block text-xs text-[#6B5744] pt-1">
                Notes / Justification (optional)
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} disabled={saving}
                          placeholder="Why is this needed?"
                          className="mt-1 w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>

              {error && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
              )}
            </div>

            <div className="shrink-0 px-4 py-3 border-t border-[#E8D5C4] space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-[#2D1B0E]">Requisition total</span>
                <span className="font-mono font-bold text-[#2D1B0E]">{inr(cartTotal)}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => save(false)} disabled={saving || cartCount === 0}
                        className="flex-1 px-3 py-2.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] text-sm font-semibold rounded-lg disabled:opacity-50">
                  {saving ? 'Saving…' : (isEditing ? 'Save Changes' : 'Save Draft')}
                </button>
                <button onClick={() => save(true)} disabled={saving || cartCount === 0}
                        className="flex-1 px-3 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-semibold rounded-lg disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                  <Send className="w-3.5 h-3.5" /> {saving ? 'Working…' : 'Submit to HOD'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
