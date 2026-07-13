'use client';

/**
 * Vendor → Materials summary.
 *
 * For each active vendor: every material they've supplied, with stats.
 * Lets admin one-click "Backfill contracts from purchase history" to auto-
 * populate `vendor_contracts` for every (vendor, material) pair that's been
 * bought at least once.
 */

import { useEffect, useState } from 'react';
import { Building2, Loader2, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Link2, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const fmtNum = (v: number, d = 2) => (v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: d });

interface MaterialStat {
  material_id: string;
  material_name: string;
  material_sku?: string;
  recipe_unit?: string;
  purchase_unit?: string;
  pack_size?: number;
  total_qty: number;
  total_spend: number;
  last_purchase_date: string;
  purchase_count: number;
  last_unit_price: number;
  avg_unit_price_90d?: number;
  is_mapped: number;       // 1 if a vendor_materials row exists
  has_contract: number;    // 1 if an active vendor_contracts row exists
  contract_price?: number;
}
interface VendorBlock {
  vendor_id: string;
  vendor_name: string;
  materials: MaterialStat[];
  total_spend: number;
  material_count: number;
  with_mapping: number;
  with_contract: number;
}
interface OrphanVendor { vendor_name: string; material_count: number; total_spend: number }

export default function VendorMaterialsPage() {
  const [vendors, setVendors] = useState<VendorBlock[]>([]);
  const [orphans, setOrphans] = useState<OrphanVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  // Full catalog for the per-vendor "add material" picker
  const [allMaterials, setAllMaterials] = useState<any[]>([]);
  // Per-vendor draft pick for the add-material control: vendorId → material_id
  const [addPick, setAddPick] = useState<Record<string, string>>({});
  // contracts cache: vendorId → list of {id, material_id} (so we can DELETE by contract id)
  const [contractIdMap, setContractIdMap] = useState<Record<string, Record<string, string>>>({});

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/vendors/materials-summary');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setVendors(j.vendors || []);
      setOrphans(j.orphan_vendors || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Catalog for the add-material picker
  useEffect(() => {
    fetch('/api/inventory?scope=all').then(r => r.json()).then(d => setAllMaterials(d.materials || []));
  }, []);

  // contractIdMap kept around so the trash icon (delete) can look up the
  // *contract* row id if we ever delete a contract from here. For pure
  // mapping deletes we use vendor_id + material_id directly.
  useEffect(() => { /* contractIdMap no longer required for mapping ops */ }, [vendors.length]);

  const addMaterialToVendor = async (vendorId: string) => {
    const materialId = addPick[vendorId];
    if (!materialId) return;
    setBusy(true); setError(null);
    try {
      // Simple mapping — no price, no contract. Just "vendor sells material".
      const r = await api('/api/vendor-materials', {
        method: 'POST',
        body: { vendor_id: vendorId, material_id: materialId },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setAddPick(p => ({ ...p, [vendorId]: '' }));
      await load();
    } finally { setBusy(false); }
  };

  // One-click: map every "not mapped" material for this vendor at once.
  // Pure mapping — no contract, no price. Uses bulk API for speed.
  const mapAllForVendor = async (block: VendorBlock) => {
    const unmapped = block.materials.filter(m => !m.is_mapped);
    if (unmapped.length === 0) return;
    if (!window.confirm(`Map all ${unmapped.length} unmapped item${unmapped.length === 1 ? '' : 's'} to ${block.vendor_name}?\n\nThis is just a mapping ("vendor sells this item"). Prices/contracts are managed separately on /contracts.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api('/api/vendor-materials', {
        method: 'POST',
        body: {
          vendor_id: block.vendor_id,
          material_ids: unmapped.map(m => m.material_id),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      await load();
    } finally { setBusy(false); }
  };

  const removeMaterialFromVendor = async (vendorId: string, materialId: string, materialName: string) => {
    if (!window.confirm(`Remove "${materialName}" from this vendor's mapping?\n\n(Any existing contract / price on /contracts is NOT affected.)`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api(`/api/vendor-materials?vendor_id=${vendorId}&material_id=${materialId}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`); return;
      }
      await load();
    } finally { setBusy(false); }
  };

  const backfill = async () => {
    if (!window.confirm(
      'Auto-create vendor-material contracts from purchase history?\n\n' +
      'For every (vendor, material) pair you have ever bought, this creates a ' +
      'vendor_contracts row with the latest purchase price. Existing active ' +
      'contracts are NOT overwritten.\n\nSafe to re-run.'
    )) return;
    setBusy(true); setError(null);
    try {
      const r = await api('/api/admin/backfill-vendor-contracts', { method: 'POST', body: {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      const lines = [`✓ ${j.summary}`];
      if (j.skipped_no_vendor?.length) {
        lines.push('', 'Skipped — vendor not in master:');
        for (const s of j.skipped_no_vendor.slice(0, 8)) {
          lines.push(`  ${s.vendor_name} → ${s.material_name}`);
        }
        if (j.skipped_no_vendor.length > 8) lines.push(`  …+${j.skipped_no_vendor.length - 8} more`);
        lines.push('', 'Add these vendors on /vendors and re-run.');
      }
      alert(lines.join('\n'));
      await load();
    } finally { setBusy(false); }
  };

  const toggle = (id: string) => setExpanded(p => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const expandAll = () => setExpanded(new Set(vendors.map(v => v.vendor_id)));
  const collapseAll = () => setExpanded(new Set());

  const visible = search.trim()
    ? vendors.filter(v => v.vendor_name.toLowerCase().includes(search.toLowerCase())
        || v.materials.some(m => m.material_name.toLowerCase().includes(search.toLowerCase())))
    : vendors;

  const totals = visible.reduce((acc, v) => ({
    spend: acc.spend + v.total_spend,
    mats: acc.mats + v.material_count,
    contracts: acc.contracts + v.with_contract,
  }), { spend: 0, mats: 0, contracts: 0 });

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Building2 className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Vendor → Materials Summary</h1>
          <p className="text-xs text-[#8B7355]">
            Every material each vendor has supplied, from purchase history. Use the backfill button
            to auto-create vendor-material contracts.
          </p>
        </div>
        <button onClick={load} disabled={loading}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded disabled:opacity-50">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
        <button onClick={backfill} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50"
                title="One-click: create vendor_contracts rows for every (vendor, material) pair seen in purchase history.">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
          Backfill Contracts from Purchases
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>
      )}

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Vendors" value={String(visible.length)} />
        <Stat label="Total materials supplied" value={fmtNum(totals.mats, 0)} />
        <Stat label="With contract" value={`${totals.contracts} / ${totals.mats}`} />
        <Stat label="Total spend (lifetime)" value={fmt(totals.spend)} accent />
      </div>

      {/* Controls */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex items-center gap-2 flex-wrap">
        <input value={search} onChange={e => setSearch(e.target.value)}
               placeholder="Search vendor or material…"
               className="flex-1 min-w-[180px] px-2 py-1.5 border border-[#E8D5C4] rounded text-sm" />
        <button onClick={expandAll} className="text-xs text-[#af4408] hover:underline">Expand all</button>
        <span className="text-[#E8D5C4]">·</span>
        <button onClick={collapseAll} className="text-xs text-[#af4408] hover:underline">Collapse all</button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14}/>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
          No vendors with purchases yet.
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(v => {
            const isOpen = expanded.has(v.vendor_id);
            return (
              <div key={v.vendor_id} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-[#FFF1E3] flex items-center gap-3 flex-wrap cursor-pointer hover:bg-[#FFE8D0]"
                     onClick={() => toggle(v.vendor_id)}>
                  {isOpen ? <ChevronDown size={14} className="text-[#6B5744]" /> : <ChevronRight size={14} className="text-[#6B5744]" />}
                  <span className="text-sm font-semibold text-[#2D1B0E] flex-1">{v.vendor_name}</span>
                  <span className="text-xs text-[#6B5744]">{v.material_count} item{v.material_count === 1 ? '' : 's'}</span>
                  <span className="text-xs text-[#8B7355]">·</span>
                  <span className="text-xs text-[#6B5744]">
                    {v.with_mapping}/{v.material_count} mapped
                    {v.with_mapping < v.material_count && (
                      <span className="ml-1 text-amber-700">⚠</span>
                    )}
                  </span>
                  <span className="text-xs text-[#8B7355]">· {v.with_contract} contracted</span>
                  <span className="text-xs text-[#8B7355]">·</span>
                  <span className="text-sm font-mono font-semibold text-[#2D1B0E]">{fmt(v.total_spend)}</span>
                  {v.with_mapping < v.material_count && (
                    <button onClick={(e) => { e.stopPropagation(); mapAllForVendor(v); }}
                            disabled={busy}
                            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-50">
                      <Link2 size={11} /> Map all {v.material_count - v.with_mapping} unmapped
                    </button>
                  )}
                </div>
                {isOpen && (
                  <>
                  {/* Add material → vendor row. Exclude only the materials
                      already mapped to THIS vendor (others can still be mapped
                      — a material can belong to many vendors). */}
                  <div className="px-4 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-[#6B5744] font-medium">+ Map a material to {v.vendor_name}:</span>
                    <div className="flex-1 min-w-[240px] max-w-md">
                      <MaterialTypeahead
                        materials={allMaterials as any}
                        value={addPick[v.vendor_id] || ''}
                        onPick={(id: string) => setAddPick(p => ({ ...p, [v.vendor_id]: id }))}
                        excludeIds={v.materials.filter(m => m.is_mapped).map(m => m.material_id)}
                        placeholder="Search SKU or name…"
                        compact
                      />
                    </div>
                    <button onClick={() => addMaterialToVendor(v.vendor_id)}
                            disabled={!addPick[v.vendor_id] || busy}
                            className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-[#af4408] hover:bg-[#933807] text-white rounded disabled:opacity-50">
                      <Plus size={11} /> Add
                    </button>
                    <span className="text-[10px] text-[#8B7355] italic">Mapping only — no price/contract. The same material can be mapped to multiple vendors.</span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-white text-[#6B5744] border-b border-[#E8D5C4]">
                        <tr>
                          <th className="text-left  py-2 px-3 font-medium">SKU</th>
                          <th className="text-left  py-2 px-3 font-medium">Material</th>
                          <th className="text-center py-2 px-3 font-medium" title="Is this material mapped to this vendor in the simple mapping table (vendor_materials)?">Mapped?</th>
                          <th className="text-right py-2 px-3 font-medium" title="Negotiated contract price (separate from mapping). Edit on /contracts.">Contract ₹</th>
                          <th className="text-right py-2 px-3 font-medium">Total Qty</th>
                          <th className="text-right py-2 px-3 font-medium">Last ₹/{v.materials[0]?.purchase_unit || 'unit'}</th>
                          <th className="text-right py-2 px-3 font-medium">90d Avg</th>
                          <th className="text-left  py-2 px-3 font-medium">Last Buy</th>
                          <th className="text-center py-2 px-3 font-medium"># Buys</th>
                          <th className="w-6"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.materials.map(m => (
                          <tr key={m.material_id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                            <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{m.material_sku || '—'}</td>
                            <td className="py-1.5 px-3 text-[#2D1B0E]">{m.material_name}</td>
                            <td className="py-1.5 px-3 text-center">
                              {m.is_mapped ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700 text-xs"><CheckCircle2 size={11} /> mapped</span>
                              ) : (
                                <button onClick={async () => {
                                  setBusy(true);
                                  await api('/api/vendor-materials', { method: 'POST', body: { vendor_id: v.vendor_id, material_id: m.material_id } });
                                  await load();
                                  setBusy(false);
                                }}
                                        disabled={busy}
                                        className="text-[10px] text-[#af4408] hover:underline disabled:opacity-50">
                                  + map
                                </button>
                              )}
                            </td>
                            <td className="py-1.5 px-3 text-right">
                              {m.has_contract ? (
                                <a href="/contracts" title="Edit on /contracts"
                                   className="inline-flex items-center gap-1 text-emerald-700 font-mono hover:underline">
                                  {fmt(m.contract_price || 0)}
                                </a>
                              ) : (
                                <span className="text-[10px] text-[#8B7355]">—</span>
                              )}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono">{fmtNum(m.total_qty)} {m.purchase_unit || m.recipe_unit}</td>
                            <td className="py-1.5 px-3 text-right font-mono">{fmt(m.last_unit_price)}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{m.avg_unit_price_90d ? fmt(m.avg_unit_price_90d) : '—'}</td>
                            <td className="py-1.5 px-3 text-[10px] font-mono text-[#8B7355]">{m.last_purchase_date}</td>
                            <td className="py-1.5 px-3 text-center text-[10px] text-[#6B5744]">{m.purchase_count}</td>
                            <td className="py-1.5 px-1 text-right">
                              {m.is_mapped && (
                                <button onClick={() => removeMaterialFromVendor(v.vendor_id, m.material_id, m.material_name)}
                                        title="Unmap (does not delete contract)"
                                        className="text-red-600 hover:text-red-700">
                                  <Trash2 size={11} />
                                </button>
                              )}
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
          })}
        </div>
      )}

      {orphans.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-900">
          <div className="flex items-center gap-2 font-semibold mb-2">
            <AlertTriangle size={14} /> {orphans.length} vendor name{orphans.length === 1 ? '' : 's'} in purchases not in /vendors master
          </div>
          <div className="text-[11px] mb-2 opacity-80">
            These purchases used vendor names that don't match any active vendor record.
            Add them on <a href="/vendors" className="underline">/vendors</a> and re-run the backfill.
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left">
              <th className="py-1">Vendor name</th>
              <th className="text-right">Materials</th>
              <th className="text-right">Total spend</th>
            </tr></thead>
            <tbody>
              {orphans.map((o, i) => (
                <tr key={i} className="border-t border-amber-200">
                  <td className="py-1 font-mono">{o.vendor_name}</td>
                  <td className="py-1 text-right">{o.material_count}</td>
                  <td className="py-1 text-right font-mono">{fmt(o.total_spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold ${accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'} font-mono`}>{value}</div>
    </div>
  );
}
