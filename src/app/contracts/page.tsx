'use client';

/**
 * Vendor Contracts page — manages negotiated unit prices per (vendor, material).
 * The PO line picker auto-fills the contract price; off-contract entries get flagged.
 *
 * UX:
 * - Top: list of all contracts (active highlighted, expired/inactive dimmed)
 * - Right rail / modal: form to create or edit a contract
 * - "End contract" sets is_active=0 + valid_to=today (preserves history)
 */

import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Edit, Save, X, Loader2, Search, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { usePurchaseUnitOptions } from '@/lib/use-units';
import { packFactor, type PackMeta } from '@/lib/pack-units';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

interface Contract {
  id: string;
  vendor_id: string; vendor_name: string;
  material_id: string; material_name: string; material_sku?: string; material_unit?: string;
  // Pack basis of the material — optional: the list API may not select them yet,
  // in which case they resolve off the locally loaded catalog (packMetaOf).
  material_purchase_unit?: string; material_pack_size?: number;
  material_avg_price?: number; material_last_price?: number;
  unit_price: number; currency: string;
  valid_from: string; valid_to: string | null;
  notes: string;
  is_active: number;
  currently_active: number;
  created_at: string; updated_at: string;
}
interface Vendor   { id: string; name: string; }
interface Material { id: string; name: string; sku?: string; unit: string; purchase_unit?: string; pack_size?: number; average_price: number; last_purchase_price?: number; }

/* ── CONTRACT PRICE BASIS ─────────────────────────────────────────────────────
 * vendor_contracts.unit_price is ₹ per PURCHASE unit (kg, L, BTL): the PO
 * composer seeds a PO line straight from it and ContractFlag compares it with
 * purchases.unit_price, which is also ₹/purchase-unit. raw_materials.average_price
 * is ₹ per RECIPE unit (₹0.90/g), so it must be multiplied by the pack factor
 * before it can be seeded into, compared with, or shown beside a contract rate.
 * packFactor() is the one shared rule (pack_size > 1 AND recipe unit ≠ purchase
 * unit) so this can never drift from the stock-credit conversion.
 * Same basis rule as poUnitOf/poRateOf in purchase-orders/page.tsx, but NOT
 * identical code: rateOf() below rounds to paise even when there is no pack
 * conversion, where poRateOf returns the raw average. Consolidate the two only
 * with that difference in hand. */
const packMetaOf = (c: Partial<Contract>, m?: Material): PackMeta => ({
  unit:          c.material_unit          || m?.unit,
  purchase_unit: c.material_purchase_unit || m?.purchase_unit,
  pack_size:     c.material_pack_size     || m?.pack_size,
});
/** The unit a contract rate is quoted in — purchase unit, recipe unit as fallback. */
const puOf = (m?: PackMeta | null): string =>
  String(m?.purchase_unit || '').trim() || String(m?.unit || '').trim();
/** Seed rate for a contract: ₹ per PURCHASE unit. Prefers the last actual
 *  purchase price (already ₹/purchase-unit); otherwise converts the recipe-unit
 *  average by pack size. 0 when we genuinely have no price. */
const rateOf = (m?: Partial<Material> | null): number => {
  // ALIAS TRAP — the field read below IS NOT the mixed-basis stored column.
  // Every `m` reaching this function is a row from GET /api/inventory (the only
  // loader on this page: reload() and QuickCreateMaterial both fetch
  // /api/inventory?scope=all). That SELECT lists `rm.*` FIRST and then re-aliases
  //   COALESCE((SELECT unit_price FROM purchases … LIMIT 1), 0) AS last_purchase_price
  // (api/inventory/route.ts:40). The later duplicate key wins in better-sqlite3,
  // so what arrives is purchases.unit_price = ₹ per PURCHASE unit, never the
  // stored raw_materials value. Proved against the live DB:
  //   CURD                       stored 86      → arrives 80      (₹/kg)
  //   SUNFLOWER OIL 1LTR         stored 0.1779  → arrives 182.76  (₹/BTL)
  //   MALA STRAWBERRY CRUSH 1LTR stored 0.2016  → arrives 0       (no purchases)
  // /api/vendor-contracts serves material_last_price the same way and says so at
  // route.ts:49-68. A material created in this session has no purchase history,
  // so it arrives 0 and falls through to the average branch.
  // The ladder here is closing-valuation.ts's ladder expressed client-side:
  // latest purchases.unit_price → average_price × packFactor → 0.
  const last = Number(m?.last_purchase_price) || 0;   // rate-basis: purchase — this is purchases.unit_price under an alias, see above
  if (last > 0) return last;
  const avg = Number(m?.average_price) || 0;
  return Math.round(avg * packFactor(m || {}) * 100) / 100;
};

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [vendors,   setVendors]   = useState<Vendor[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [editing, setEditing] = useState<Partial<Contract> | null>(null);
  const [saving, setSaving] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);

  const reload = async () => {
    setLoading(true);
    const [c, v, m] = await Promise.all([
      fetch('/api/vendor-contracts').then(r => r.json()),
      fetch('/api/vendors').then(r => r.json()),
      // scope=all — Contracts cover materials across all depts.
      fetch('/api/inventory?scope=all').then(r => r.json()).catch(() => ({ materials: [] })),
    ]);
    setContracts(c.contracts || []);
    setVendors((v.vendors || []).filter((x: any) => x.is_active));
    setMaterials(m.materials || []);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return contracts.filter(c => {
      if (filter === 'active'   && !c.currently_active) return false;
      if (filter === 'inactive' &&  c.currently_active) return false;
      if (!q) return true;
      return c.vendor_name.toLowerCase().includes(q)
          || c.material_name.toLowerCase().includes(q)
          || (c.material_sku || '').toLowerCase().includes(q);
    });
  }, [contracts, search, filter]);

  // Catalog lookup — supplies the pack basis (purchase_unit / pack_size) the
  // contracts API doesn't select, for both the table rows and the form.
  const materialById = useMemo(() => new Map(materials.map(m => [m.id, m])), [materials]);

  const editMaterial = editing ? materialById.get(editing.material_id || '') : undefined;
  const editMeta     = editing ? packMetaOf(editing, editMaterial) : null;
  // Only name a basis unit when we actually know it — labelling the rate
  // "₹ / g" because the catalog didn't load would assert the wrong basis.
  const editKnown    = !!(editing?.material_purchase_unit || editMaterial);
  const editUnit     = editKnown && editMeta ? puOf(editMeta) : '';
  const editPack     = editMeta ? packFactor(editMeta) : 1;

  const startNew = () => setEditing({ valid_from: today(), valid_to: null, currency: 'INR', unit_price: 0, notes: '' });
  const startEdit = (c: Contract) => setEditing({ ...c });

  const save = async () => {
    if (!editing) return;
    if (!editing.vendor_id || !editing.material_id || !editing.unit_price) {
      alert('Vendor, material and unit price are required');
      return;
    }
    setSaving(true);
    try {
      const isUpdate = !!editing.id;
      const r = await api('/api/vendor-contracts', {
        method: isUpdate ? 'PUT' : 'POST',
        body: editing,
      });
      if (!r.ok) { alert((await r.json()).error || 'Save failed'); return; }
      setEditing(null);
      await reload();
    } finally { setSaving(false); }
  };

  const endContract = async (c: Contract) => {
    if (!confirm(`End contract with ${c.vendor_name} for ${c.material_name}?\n\nThe contract row stays for audit; future POs will no longer auto-fill this price.`)) return;
    const r = await api('/api/vendor-contracts', {
      method: 'PUT',
      body: { id: c.id, is_active: false, valid_to: today() },
    });
    if (!r.ok) { alert('Failed'); return; }
    reload();
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FileText className="w-7 h-7 text-[#af4408]" />
          <div>
            <h1 className="text-2xl font-bold text-[#2D1B0E]">Vendor Contracts</h1>
            <p className="text-xs text-[#6B5744]">Negotiated unit prices auto-fill on PO. Deviations are flagged. Rates are ₹ per <strong>purchase unit</strong> (kg, L, BTL) — the basis POs are raised in.</p>
          </div>
        </div>
        <button onClick={startNew} className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Contract
        </button>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl">
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-2 top-2.5 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)}
                   placeholder="Search vendor, material, SKU…"
                   className="w-full pl-8 pr-2 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0]" />
          </div>
          <div className="flex border border-[#E8D5C4] rounded-lg overflow-hidden text-xs">
            {(['active', 'inactive', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                      className={`px-3 py-1.5 capitalize ${filter === f ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                {f}
              </button>
            ))}
          </div>
          <span className="text-xs text-[#8B7355] ml-auto">{filtered.length} of {contracts.length}</span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-[#8B7355]">
            <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No contracts {filter === 'active' ? 'currently active' : ''}.
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[#8B7355] bg-[#FFF8F0] text-xs">
              <tr>
                <th className="text-left  py-2 px-3 font-medium">Vendor</th>
                <th className="text-left  py-2 px-3 font-medium">Material</th>
                <th className="text-right py-2 px-3 font-medium" title="₹ per PURCHASE unit — same basis as PO rates">Contract ₹</th>
                <th className="text-right py-2 px-3 font-medium" title="Both ₹ per PURCHASE unit (avg is converted from ₹/recipe-unit by pack size)">Avg ₹ / Last ₹</th>
                <th className="text-right py-2 px-3 font-medium">Δ vs avg</th>
                <th className="text-left  py-2 px-3 font-medium">Validity</th>
                <th className="text-left  py-2 px-3 font-medium">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const meta = packMetaOf(c, materialById.get(c.material_id));
                // average_price is ₹/recipe-unit and unit_price is ₹/purchase-unit —
                // convert before comparing, else a pack-1000 material reads +99,900%
                // and a genuinely bad contract is indistinguishable from a correct one.
                const knownBasis = !!(c.material_purchase_unit || materialById.has(c.material_id));
                const avg = knownBasis ? (c.material_avg_price || 0) * packFactor(meta) : 0;
                const delta = avg ? ((c.unit_price - avg) / avg) * 100 : 0;
                // Same guard as the form (editKnown): without the pack basis, puOf()
                // falls back to the RECIPE unit, which would label a ₹/kg rate "per g".
                // '' = basis unknown → say nothing rather than say the wrong thing.
                const basisUnit = knownBasis ? (puOf(meta) || c.material_unit || '') : '';
                const isActive = !!c.currently_active;
                return (
                  <tr key={c.id} className={`border-t border-[#E8D5C4]/50 ${isActive ? '' : 'opacity-60'}`}>
                    <td className="py-2 px-3 font-medium text-[#2D1B0E]">{c.vendor_name}</td>
                    <td className="py-2 px-3">
                      <div className="text-[#2D1B0E]">{c.material_name}</div>
                      {/* Basis label = PURCHASE unit: the rate in the next column is
                          ₹/purchase-unit. Dropped entirely when the basis is unknown. */}
                      <div className="text-[10px] font-mono text-[#8B7355]">{c.material_sku}{basisUnit ? ` · per ${basisUnit}` : ''}</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">{fmt(c.unit_price)}</td>
                    <td className="py-2 px-3 text-right font-mono text-xs text-[#6B5744]"
                        title={basisUnit ? `₹ per ${basisUnit} — same basis as the contract rate` : undefined}>
                      {knownBasis ? fmt(avg) : '—'} / {fmt(c.material_last_price || 0)}
                    </td>
                    <td className={`py-2 px-3 text-right font-mono text-xs ${
                      Math.abs(delta) < 1 ? 'text-[#6B5744]' : delta < 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}>
                      {avg ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-2 px-3 text-xs text-[#6B5744]">
                      {c.valid_from} → {c.valid_to || <span className="italic">open</span>}
                    </td>
                    <td className="py-2 px-3">
                      {isActive ? (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">Active</span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744]">Ended</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => startEdit(c)} className="text-[#6B5744] hover:text-[#af4408]" title="Edit">
                          <Edit className="w-4 h-4" />
                        </button>
                        {isActive && (
                          <button onClick={() => endContract(c)} className="text-red-600 hover:text-red-800 text-xs underline">end</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl my-12 shadow-xl">
            <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
              <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Contract' : 'New Contract'}</h2>
              <button onClick={() => setEditing(null)} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Vendor
                <select disabled={!!editing.id}
                        value={editing.vendor_id || ''}
                        onChange={e => setEditing(p => ({ ...p, vendor_id: e.target.value }))}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm disabled:opacity-60">
                  <option value="">Select vendor…</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <div className="text-xs text-[#6B5744] flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span>Material</span>
                  {!editing.id && (
                    <button type="button"
                            onClick={() => setShowQuickCreate(true)}
                            className="text-[10px] text-[#af4408] hover:underline inline-flex items-center gap-1">
                      <Plus size={10} /> New Material
                    </button>
                  )}
                </div>
                {editing.id ? (
                  // Edit mode — show locked label (material can't change on existing contract)
                  <div className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF1E3] text-sm text-[#6B5744]">
                    {(() => {
                      const m = editMaterial;
                      // Show the PURCHASE unit — the rate below is quoted per that unit.
                      return m ? `${m.sku ? m.sku + ' — ' : ''}${m.name} (per ${editUnit || m.unit})` : editing.material_id;
                    })()}
                  </div>
                ) : (
                  <MaterialTypeahead
                    materials={materials as any} purchaseBasis
                    value={editing.material_id || ''}
                    onPick={(id) => {
                      const m = materialById.get(id);
                      setEditing(p => ({
                        ...p,
                        material_id: id,
                        // rateOf = ₹/purchase-unit (see CONTRACT PRICE BASIS): a raw
                        // average_price here would seed ₹/g into a ₹/kg field.
                        // Re-seed when the material CHANGES (same guard as the PO
                        // composer) — the old material's rate is a different basis.
                        unit_price: (id !== p?.material_id || !p?.unit_price) ? rateOf(m) : p?.unit_price,
                      }));
                    }}
                    placeholder="Search SKU or name…"
                    compact={false}
                  />
                )}
              </div>
              {editing.material_id && (() => {
                const m = editMaterial;
                if (!m) return null;
                // Both references in ₹/purchase-unit — the basis of unit_price.
                const avgPu = (Number(m.average_price) || 0) * packFactor(m);
                const ref = rateOf(m);
                const delta = ref ? (((Number(editing.unit_price) || 0) - ref) / ref) * 100 : 0;
                return (
                  <div className="text-[10px] text-[#6B5744] bg-[#FFF1E3] px-2 py-1 rounded">
                    {/* Both references are ₹ per PURCHASE unit, the basis of unit_price:
                        avgPu = average_price (₹/recipe-unit) × packFactor, and `last` is
                        the /api/inventory alias over purchases.unit_price — NOT the
                        mixed-basis stored column (see the ALIAS TRAP note on rateOf). */}
                    {/* rate-basis: purchase */}
                    Reference (per {editUnit || m.unit}): avg {fmt(avgPu)} · last {fmt(m.last_purchase_price || 0)}
                    {ref > 0 && Number(editing.unit_price) > 0 && (
                      <span className={`ml-2 font-medium ${
                        Math.abs(delta) < 5 ? 'text-emerald-700' : delta < 0 ? 'text-emerald-700' : 'text-red-700'
                      }`}>
                        {/* Names WHICH rung of rateOf's ladder `ref` came from. Same alias
                            as above, so "last" means purchases.unit_price (₹/purchase-unit)
                            and the % is purchase-basis ÷ purchase-basis. */}
                        {/* rate-basis: purchase */}
                        contract is {delta > 0 ? '+' : ''}{delta.toFixed(1)}% vs {m.last_purchase_price ? 'last' : 'avg'}
                      </span>
                    )}
                  </div>
                );
              })()}
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                  Unit Price (₹{editUnit ? ` / ${editUnit}` : ''})
                  <input type="number" step="any" value={editing.unit_price || ''}
                         onChange={e => setEditing(p => ({ ...p, unit_price: parseFloat(e.target.value) || 0 }))}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                  {/* Pack materials: spell out the basis — typing ₹/g here would be
                      read by every PO as ₹/kg (1000× off). */}
                  {editPack > 1 && (
                    <span className="text-[10px] text-[#8B7355]">
                      Vendor rate per <strong>{editUnit}</strong> (1 {editUnit} = {editPack} {editMeta?.unit}) — not per {editMeta?.unit}.
                    </span>
                  )}
                </label>
                <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                  Valid From
                  <input type="date" value={editing.valid_from || today()}
                         onChange={e => setEditing(p => ({ ...p, valid_from: e.target.value }))}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>
                <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                  Valid To <span className="text-[10px] text-[#8B7355]">(blank = open)</span>
                  <input type="date" value={editing.valid_to || ''}
                         onChange={e => setEditing(p => ({ ...p, valid_to: e.target.value || null }))}
                         className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </label>
              </div>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Notes
                <textarea value={editing.notes || ''}
                          onChange={e => setEditing(p => ({ ...p, notes: e.target.value }))}
                          rows={2}
                          placeholder="PO ref, terms agreed, etc."
                          className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>

              {!editing.id && editing.vendor_id && editing.material_id && (
                <ExistingContractWarning vendorId={editing.vendor_id} materialId={editing.material_id} />
              )}
            </div>
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={save} disabled={saving}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save Contract'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showQuickCreate && (
        <QuickCreateMaterial
          existingMaterials={materials}
          onClose={() => setShowQuickCreate(false)}
          onCreated={async (newMaterial: Material) => {
            // Refresh the materials list so the new one is selectable
            const inv = await fetch('/api/inventory?scope=all').then(r => r.json()).catch(() => ({ materials: [] }));
            setMaterials(inv.materials || []);
            // Auto-pick the newly created material in the contract form
            setEditing(p => ({
              ...p,
              material_id: newMaterial.id,
              // ₹/purchase-unit basis (see CONTRACT PRICE BASIS) — same seed as the picker.
              unit_price: p?.unit_price || rateOf(newMaterial),
            }));
            setShowQuickCreate(false);
          }}
          onPickedExisting={(m: Material) => {
            // User found an existing match — no need to create. Select it.
            setEditing(p => ({
              ...p,
              material_id: m.id,
              // ₹/purchase-unit basis (see CONTRACT PRICE BASIS), not raw average_price.
              unit_price: p?.unit_price || rateOf(m),
            }));
            setShowQuickCreate(false);
          }}
        />
      )}
    </div>
  );
}

/** Search existing OR create new. Modal opens with a search picker at top:
 *  - If user finds the material in the catalog, picking it skips creation
 *    and selects it for the contract (onPickedExisting).
 *  - If no match exists, the form below lets them create a new one
 *    (onCreated). */
function QuickCreateMaterial({ existingMaterials, onClose, onCreated, onPickedExisting }: {
  existingMaterials: Material[];
  onClose: () => void;
  onCreated: (m: Material) => void;
  onPickedExisting: (m: Material) => void;
}) {
  // Registry-driven purchase units (built-ins + custom ones from /units)
  const purchaseUnitOptions = usePurchaseUnitOptions();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('other');
  const [unit, setUnit] = useState('kg');                  // recipe unit
  const [purchaseUnit, setPurchaseUnit] = useState('kg');  // how vendor invoices
  const [packSize, setPackSize] = useState<string>('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-default purchase_unit to recipe unit on first change (clean UX)
  useEffect(() => {
    if (purchaseUnit === 'kg' && unit !== 'kg') setPurchaseUnit(unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  // Look for near-duplicates while user types so they don't double-create.
  const nameLower = name.trim().toLowerCase();
  const possibleDup = nameLower.length >= 3
    ? existingMaterials.find(m => m.name.toLowerCase() === nameLower)
    : null;

  const save = async () => {
    if (!name.trim()) { setError('Name required'); return; }
    if (Number(packSize) <= 0) { setError('Pack size must be > 0'); return; }
    if (possibleDup) {
      // Hard stop: don't create duplicates. User must pick the existing one.
      setError(`A material named "${possibleDup.name}" already exists. Use the picker above to select it instead.`);
      return;
    }
    setSaving(true); setError(null);
    try {
      const r = await api('/api/inventory', {
        method: 'POST',
        body: {
          name: name.trim(),
          category,
          unit,
          purchase_unit: purchaseUnit,
          pack_size: Number(packSize),
          reorder_level: 0,
          costing_method: 'average',
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onCreated(j.material);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-md my-12" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E8D5C4]">
          <h3 className="text-base font-semibold text-[#2D1B0E]">Add Material to Contract</h3>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
        </div>

        {/* STEP 1: Search existing first — don't create duplicates */}
        <div className="px-5 py-3 bg-blue-50/60 border-b border-blue-200 space-y-2">
          <label className="block text-xs text-[#6B5744] font-semibold">
            1. Already in the catalog? Search & select it
          </label>
          <MaterialTypeahead
            materials={existingMaterials as any} purchaseBasis
            value=""
            onPick={(id: string) => {
              const m = existingMaterials.find(x => x.id === id);
              if (m) onPickedExisting(m);
            }}
            placeholder="Type material name or SKU…"
            compact={false}
          />
          <div className="text-[10px] text-[#8B7355]">
            Catalog has <strong>{existingMaterials.length}</strong> materials. If found, picking it skips the create-new form.
          </div>
        </div>

        {/* STEP 2: Create new if not found */}
        <div className="px-5 py-4 space-y-3 text-sm">
          <label className="block text-xs text-[#6B5744] font-semibold">
            2. Not in catalog? Create it new
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#6B5744]">Material Name *
            <input value={name} onChange={e => setName(e.target.value)}
                   placeholder="e.g. AASHIRVAAD ATTA 5KG"
                   className={`px-2 py-1.5 border rounded ${possibleDup ? 'border-red-400 bg-red-50' : 'border-[#D4B896] bg-[#FFF1E3]'}`} />
            {possibleDup && (
              <span className="text-[10px] text-red-700">
                ⚠ "{possibleDup.name}" already exists — pick it from the search above instead.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#6B5744]">Category
            <select value={category} onChange={e => setCategory(e.target.value)}
                    className="px-2 py-1.5 border border-[#D4B896] rounded bg-[#FFF1E3]">
              {['other','grocery','meat','dairy','vegetables','fruits','beverage','liquor','spices','bakery','cleaning','consumables'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-[#6B5744]">Recipe Unit
              <select value={unit} onChange={e => setUnit(e.target.value)}
                      className="px-2 py-1.5 border border-[#D4B896] rounded bg-[#FFF1E3]">
                {['g','ml','kg','L','pcs'].map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[#6B5744]">Purchase Unit
              <select value={purchaseUnit} onChange={e => setPurchaseUnit(e.target.value)}
                      className="px-2 py-1.5 border border-[#D4B896] rounded bg-[#FFF1E3]">
                {purchaseUnitOptions.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-[#6B5744]">
            Pack Size <span className="font-normal text-[#8B7355]">(in {unit}, per 1 {purchaseUnit})</span>
            <input type="number" step="any" min="0.001" value={packSize} onChange={e => setPackSize(e.target.value)}
                   placeholder={`e.g. 1000 if 1 ${purchaseUnit} = 1000 ${unit}`}
                   className="px-2 py-1.5 border border-[#D4B896] rounded bg-[#FFF1E3] font-mono" />
            <span className="text-[10px] text-[#8B7355]">
              Set to <span className="font-mono">1</span> when Recipe Unit = Purchase Unit.
            </span>
          </label>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Cancel</button>
          <button onClick={save} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Creating…' : 'Create & Select'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Warns if an active contract already exists for this vendor+material — POST will end it. */
function ExistingContractWarning({ vendorId, materialId }: { vendorId: string; materialId: string }) {
  const [existing, setExisting] = useState<any>(null);
  useEffect(() => {
    fetch(`/api/vendor-contracts?vendor_id=${vendorId}&material_id=${materialId}&active=1`)
      .then(r => r.json())
      .then(d => setExisting((d.contracts || [])[0] || null));
  }, [vendorId, materialId]);
  if (!existing) return null;
  return (
    <div className="text-xs px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex gap-2 items-start">
      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
      <div>
        Existing active contract: <span className="font-mono font-semibold">{fmt(existing.unit_price)}</span> from {existing.valid_from}.
        Saving will end it (valid_to = day before this one's start) and replace.
      </div>
    </div>
  );
}
