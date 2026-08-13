'use client';

/**
 * VENDOR ITEMS — the master list of "which vendor supplies which item".
 *
 * This screen is no longer a report. Since the PO composer went STRICT, this is
 * where purchasing is decided: a PO line is only accepted for a pair declared
 * here (server-side, in @/lib/vendor-mapping), so a vendor with an empty list
 * cannot be ordered from at all. Everything on this page is arranged around
 * that one job — see what is mapped, see what is missing, and fix it fast.
 *
 * Per vendor: every material they have supplied (purchase history) or been
 * mapped to, with stats, plus assign / bulk-assign / remove, and where each
 * mapped pair came from (the one-time history seed vs a person).
 *
 * Deep link: /vendors/materials?vendor=<id> opens straight onto that vendor —
 * this is the link every "not mapped" message in the PO composer points at.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Loader2, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Link2, Plus, Trash2, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const fmtNum = (v: number, d = 2) => (v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: d });

/** The unit this row's numbers are actually in. Both quantities (purchases.quantity)
 *  and rates (purchases.unit_price) on this screen are per the material's own
 *  PURCHASE unit, so Total Qty and Last ₹ must name the same thing — one spelling,
 *  used by both cells, so the two captions cannot drift apart. */
const unitOf = (m: MaterialStat) => m.purchase_unit || m.recipe_unit || 'unit';

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
  /** Where the mapping came from: the one-shot history seed, the contracts
   *  backfill, or a person. Null when the row is not mapped at all. */
  mapped_source?: 'history' | 'contracts' | 'person' | null;
  mapped_by?: string | null;
  mapped_at?: string | null;
}
interface VendorBlock {
  vendor_id: string;
  vendor_name: string;
  materials: MaterialStat[];
  total_spend: number;
  material_count: number;
  with_mapping: number;
  with_contract: number;
  /** Items this vendor can actually be ordered — 0 means purchasing is blocked. */
  mapped_count: number;
  seeded_count: number;
  human_count: number;
}
interface OrphanVendor { vendor_name: string; material_count: number; total_spend: number }

/** Small provenance chip. An admin pruning this list has to be able to tell a
 *  pair the seed GUESSED from real history apart from one a person vouched for. */
function SourceBadge({ m }: { m: MaterialStat }) {
  if (!m.is_mapped) return null;
  const when = m.mapped_at ? ` on ${String(m.mapped_at).slice(0, 10)}` : '';
  if (m.mapped_source === 'person') {
    return (
      <span title={`Mapped by ${m.mapped_by || 'a user'}${when}`}
            className="text-[9px] px-1 py-0.5 rounded-full bg-[#FFF1E3] text-[#af4408] border border-[#E8D5C4]">
        by {String(m.mapped_by || 'user').split('@')[0]}
      </span>
    );
  }
  if (m.mapped_source === 'contracts') {
    return (
      <span title={`Backfilled from an active contract${when}`}
            className="text-[9px] px-1 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
        from contract
      </span>
    );
  }
  return (
    <span title={`Seeded once from purchase history${when} — confirm or remove it`}
          className="text-[9px] px-1 py-0.5 rounded-full bg-[#F0E4D6] text-[#8B7355] border border-[#E8D5C4]">
      from history
    </span>
  );
}

export default function VendorMaterialsPage() {
  const [vendors, setVendors] = useState<VendorBlock[]>([]);
  const [orphans, setOrphans] = useState<OrphanVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  /** "Show only the vendors nothing can be ordered from." The whole reason a
   *  buyer gets sent to this page. */
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  // Full catalog for the per-vendor "add material" picker
  const [allMaterials, setAllMaterials] = useState<any[]>([]);
  // Per-vendor draft pick for the add-material control: vendorId → material_id
  const [addPick, setAddPick] = useState<Record<string, string>>({});
  // Bulk-add panel: vendorId → open?, its search text, and the ticked ids
  const [bulkOpen, setBulkOpen] = useState<Record<string, boolean>>({});
  const [bulkQuery, setBulkQuery] = useState<Record<string, string>>({});
  const [bulkPicked, setBulkPicked] = useState<Record<string, Set<string>>>({});
  // Item-level filter inside an expanded vendor
  const [itemFilter, setItemFilter] = useState<Record<string, string>>({});
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const deepLinkDone = useRef(false);

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

  /* Deep link from the PO composer: /vendors/materials?vendor=<id>.
     Read off window.location rather than useSearchParams so this client page
     needs no Suspense boundary. Runs once, after the vendors have loaded. */
  useEffect(() => {
    if (deepLinkDone.current || vendors.length === 0) return;
    const want = new URLSearchParams(window.location.search).get('vendor');
    if (!want) { deepLinkDone.current = true; return; }
    if (!vendors.some(v => v.vendor_id === want)) return;
    deepLinkDone.current = true;
    setExpanded(p => new Set(p).add(want));
    /* Keep asking until it sticks. A single scrollIntoView() loses the race
       against the router's own scroll restoration on a fresh load, which drops
       the buyer at the top of a 55-vendor page wondering where the link went.
       Stops as soon as the block is on screen, or after ~1.5s. */
    let tries = 0;
    const settle = () => {
      const el = rowRefs.current[want];
      if (!el) { if (++tries < 30) requestAnimationFrame(settle); return; }
      const top = el.getBoundingClientRect().top;
      if (top >= 0 && top < window.innerHeight * 0.8) return;   // visible — done
      el.scrollIntoView({ block: 'center' });
      if (++tries < 30) setTimeout(settle, 50);
    };
    requestAnimationFrame(settle);
  }, [vendors]);

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

  /** BULK ADD from the whole catalogue — the control that makes a brand-new
   *  vendor usable in one pass instead of one typeahead pick at a time.
   *  ("Map all unmapped" above can only offer what purchase history already
   *  knows, which is exactly nothing for the vendors that need this most.) */
  const bulkAdd = async (block: VendorBlock) => {
    const picked = [...(bulkPicked[block.vendor_id] || new Set<string>())];
    if (picked.length === 0) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api('/api/vendor-materials', {
        method: 'POST',
        body: { vendor_id: block.vendor_id, material_ids: picked },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(`Mapped ${j.added} item${j.added === 1 ? '' : 's'} to ${block.vendor_name}${j.skipped_existing ? ` (${j.skipped_existing} already mapped)` : ''}. They can be ordered now.`);
      setBulkPicked(p => ({ ...p, [block.vendor_id]: new Set() }));
      setBulkQuery(p => ({ ...p, [block.vendor_id]: '' }));
      await load();
    } finally { setBusy(false); }
  };

  const removeMaterialFromVendor = async (vendorId: string, materialId: string, materialName: string) => {
    if (!window.confirm(`Remove "${materialName}" from this vendor's mapping?\n\nAfter this, a PO line pairing them is refused (purchasing reads this mapping).\n(Any existing contract / price on /contracts is NOT affected.)`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api(`/api/vendor-materials?vendor_id=${vendorId}&material_id=${materialId}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      // Unmapping something that is on a LIVE PO is legal but consequential —
      // that PO can no longer be edited or re-saved until the pair is restored.
      if (Number(j.open_po_lines) > 0) {
        setNotice(`Removed. Note: ${j.open_po_lines} open PO line(s) still pair this vendor with "${materialName}" — those POs cannot be edited or re-saved until the pair is mapped again.`);
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

  const needAttention = useMemo(() => vendors.filter(v => (v.mapped_count || 0) === 0), [vendors]);

  const visible = useMemo(() => {
    let list = vendors;
    if (onlyUnmapped) list = list.filter(v => (v.mapped_count || 0) === 0);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(v => v.vendor_name.toLowerCase().includes(q)
        || v.materials.some(m => m.material_name.toLowerCase().includes(q) || (m.material_sku || '').toLowerCase().includes(q)));
    }
    return list;
  }, [vendors, search, onlyUnmapped]);

  const totals = visible.reduce((acc, v) => ({
    spend: acc.spend + v.total_spend,
    mats: acc.mats + v.material_count,
    mapped: acc.mapped + (v.mapped_count || 0),
    contracts: acc.contracts + v.with_contract,
  }), { spend: 0, mats: 0, mapped: 0, contracts: 0 });

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Building2 className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Vendor Items</h1>
          <p className="text-xs text-[#8B7355]">
            Which vendor supplies which item. <strong>Purchase Orders read this list</strong>: a PO line is only
            accepted for a mapped pair, so a vendor with no items here cannot be ordered from.
            One vendor has a limited list; one item can have several vendors.
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
      {notice && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-2 text-xs flex items-start gap-2">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-700"><X size={12} /></button>
        </div>
      )}

      {/* NOTHING CAN BE ORDERED FROM THESE — the headline, not a footnote. */}
      {!loading && needAttention.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-800">
          <div className="flex items-center gap-2 flex-wrap">
            <AlertTriangle size={14} />
            <span className="font-semibold">
              {needAttention.length} of {vendors.length} vendors have no items mapped — no PO can be raised for them.
            </span>
            <button onClick={() => { setOnlyUnmapped(true); setSearch(''); }}
                    className="ml-auto text-[11px] px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700">
              Show only these
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {needAttention.slice(0, 12).map(v => (
              <button key={v.vendor_id}
                      onClick={() => { setExpanded(p => new Set(p).add(v.vendor_id)); setTimeout(() => rowRefs.current[v.vendor_id]?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-red-300 bg-white hover:bg-red-100">
                {v.vendor_name}
              </button>
            ))}
            {needAttention.length > 12 && <span className="text-[10px] self-center">+{needAttention.length - 12} more</span>}
          </div>
        </div>
      )}

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Vendors" value={String(visible.length)} />
        <Stat label="Mapped items (orderable)" value={fmtNum(totals.mapped, 0)} accent />
        <Stat label="Seen in purchases" value={fmtNum(totals.mats, 0)} />
        <Stat label="Total spend (lifetime)" value={fmt(totals.spend)} />
      </div>

      {/* Controls */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#B8A590]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search vendor, item name or SKU…"
                 className="w-full pl-6 pr-2 py-1.5 border border-[#E8D5C4] rounded text-sm" />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[#6B5744]">
          <input type="checkbox" checked={onlyUnmapped} onChange={e => setOnlyUnmapped(e.target.checked)} />
          Only vendors with no items
        </label>
        <button onClick={expandAll} className="text-xs text-[#af4408] hover:underline">Expand all</button>
        <span className="text-[#E8D5C4]">·</span>
        <button onClick={collapseAll} className="text-xs text-[#af4408] hover:underline">Collapse all</button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14}/>Loading…</div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
          {onlyUnmapped ? 'Every vendor has at least one mapped item.' : 'No vendors match.'}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(v => {
            const isOpen = expanded.has(v.vendor_id);
            const blocked = (v.mapped_count || 0) === 0;
            const filterQ = (itemFilter[v.vendor_id] || '').trim().toLowerCase();
            const rows = filterQ
              ? v.materials.filter(m => m.material_name.toLowerCase().includes(filterQ) || (m.material_sku || '').toLowerCase().includes(filterQ))
              : v.materials;
            const mappedIds = new Set(v.materials.filter(m => m.is_mapped).map(m => m.material_id));
            const bulkQ = (bulkQuery[v.vendor_id] || '').trim().toLowerCase();
            const bulkCandidates = bulkQ
              ? allMaterials.filter((m: any) => !mappedIds.has(m.id)
                  && (String(m.name || '').toLowerCase().includes(bulkQ) || String(m.sku || '').toLowerCase().includes(bulkQ))).slice(0, 60)
              : [];
            const picked = bulkPicked[v.vendor_id] || new Set<string>();
            /* Every rate below is ₹ per that item's OWN purchase unit, and 15 of the
               59 active vendors supply in several units at once (HYPERPURE: kg, BTL,
               CAN, l, pcs across 155 items — 35 of them not kg). The header used to
               print the unit of whichever row the sort surfaced first and stamp it
               over all of them, so ₹182.76 per BTL of sunflower oil read as ₹182.76
               per kg. Name a unit here only when every row on screen really is in it;
               each rate cell carries its own either way, as Total Qty already does. */
            const rateUnits = new Set(rows.map(unitOf));
            const rateUnit = rateUnits.size === 1 ? [...rateUnits][0] : null;
            return (
              <div key={v.vendor_id}
                   ref={el => { rowRefs.current[v.vendor_id] = el; }}
                   className={`bg-white border rounded-xl overflow-hidden ${blocked ? 'border-red-300' : 'border-[#E8D5C4]'}`}>
                <div className={`px-4 py-3 flex items-center gap-3 flex-wrap cursor-pointer ${blocked ? 'bg-red-50 hover:bg-red-100' : 'bg-[#FFF1E3] hover:bg-[#FFE8D0]'}`}
                     onClick={() => toggle(v.vendor_id)}>
                  {isOpen ? <ChevronDown size={14} className="text-[#6B5744]" /> : <ChevronRight size={14} className="text-[#6B5744]" />}
                  <span className="text-sm font-semibold text-[#2D1B0E] flex-1">{v.vendor_name}</span>
                  {blocked ? (
                    <span className="text-[11px] font-semibold text-red-700 inline-flex items-center gap-1">
                      <AlertTriangle size={11} /> no items mapped — cannot be ordered from
                    </span>
                  ) : (
                    <span className="text-xs text-[#6B5744]">
                      <strong>{v.mapped_count}</strong> mapped item{v.mapped_count === 1 ? '' : 's'}
                      {v.human_count > 0 && <span className="text-[#8B7355]"> ({v.human_count} confirmed by a person)</span>}
                    </span>
                  )}
                  <span className="text-xs text-[#8B7355]">·</span>
                  <span className="text-xs text-[#6B5744]">{v.material_count} seen in purchases</span>
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
                    <span className="text-[11px] text-[#6B5744] font-medium">+ Map an item to {v.vendor_name}:</span>
                    <div className="flex-1 min-w-[240px] max-w-md">
                      <MaterialTypeahead
                        materials={allMaterials as any} purchaseBasis
                        value={addPick[v.vendor_id] || ''}
                        onPick={(id: string) => setAddPick(p => ({ ...p, [v.vendor_id]: id }))}
                        excludeIds={[...mappedIds]}
                        placeholder="Search SKU or name…"
                        compact
                      />
                    </div>
                    <button onClick={() => addMaterialToVendor(v.vendor_id)}
                            disabled={!addPick[v.vendor_id] || busy}
                            className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-[#af4408] hover:bg-[#933807] text-white rounded disabled:opacity-50">
                      <Plus size={11} /> Add
                    </button>
                    <button onClick={() => setBulkOpen(p => ({ ...p, [v.vendor_id]: !p[v.vendor_id] }))}
                            className="text-xs px-2.5 py-1 border border-[#D4B896] text-[#6B5744] rounded hover:bg-[#FFF1E3]">
                      {bulkOpen[v.vendor_id] ? 'Close bulk add' : 'Bulk add…'}
                    </button>
                    <span className="text-[10px] text-[#8B7355] italic">Mapping only — no price/contract. The same item can be mapped to several vendors.</span>
                  </div>

                  {/* BULK ADD — search the catalogue, tick, add in one call. */}
                  {bulkOpen[v.vendor_id] && (
                    <div className="px-4 py-3 bg-white border-b border-[#E8D5C4] space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="relative flex-1 min-w-[220px]">
                          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#B8A590]" />
                          <input autoFocus value={bulkQuery[v.vendor_id] || ''}
                                 onChange={e => setBulkQuery(p => ({ ...p, [v.vendor_id]: e.target.value }))}
                                 placeholder={`Search the item catalogue to add to ${v.vendor_name}…`}
                                 className="w-full pl-6 pr-2 py-1.5 border border-[#E8D5C4] rounded text-xs" />
                        </div>
                        <span className="text-[11px] text-[#6B5744]">{picked.size} selected</span>
                        <button onClick={() => bulkAdd(v)} disabled={picked.size === 0 || busy}
                                className="text-xs px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white rounded disabled:opacity-50">
                          {busy ? <Loader2 size={11} className="animate-spin inline" /> : <Plus size={11} className="inline" />} Map {picked.size || ''} to {v.vendor_name}
                        </button>
                        {picked.size > 0 && (
                          <button onClick={() => setBulkPicked(p => ({ ...p, [v.vendor_id]: new Set() }))}
                                  className="text-[11px] text-[#8B7355] hover:underline">clear</button>
                        )}
                      </div>
                      {!bulkQ ? (
                        <div className="text-[11px] text-[#8B7355]">Type at least part of an item name or SKU. Already-mapped items are hidden.</div>
                      ) : bulkCandidates.length === 0 ? (
                        <div className="text-[11px] text-[#8B7355]">No unmapped item matches &quot;{bulkQuery[v.vendor_id]}&quot;.</div>
                      ) : (
                        <div className="max-h-56 overflow-y-auto border border-[#E8D5C4] rounded divide-y divide-[#F0E4D6]">
                          {bulkCandidates.map((m: any) => {
                            const on = picked.has(m.id);
                            return (
                              <label key={m.id} className={`flex items-center gap-2 px-2 py-1 text-xs cursor-pointer ${on ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}>
                                <input type="checkbox" checked={on}
                                       onChange={() => setBulkPicked(p => {
                                         const next = new Set(p[v.vendor_id] || []);
                                         if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                                         return { ...p, [v.vendor_id]: next };
                                       })} />
                                <span className="font-mono text-[10px] text-[#8B7355] w-20 shrink-0">{m.sku || '—'}</span>
                                <span className="flex-1 truncate text-[#2D1B0E]">{m.name}</span>
                                <span className="text-[10px] text-[#8B7355]">{m.purchase_unit || m.unit}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Per-vendor item filter — a 155-item vendor is unreadable without it. */}
                  {v.materials.length > 8 && (
                    <div className="px-4 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4]">
                      <div className="relative max-w-xs">
                        <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#B8A590]" />
                        <input value={itemFilter[v.vendor_id] || ''}
                               onChange={e => setItemFilter(p => ({ ...p, [v.vendor_id]: e.target.value }))}
                               placeholder={`Filter ${v.materials.length} items…`}
                               className="w-full pl-6 pr-2 py-1 border border-[#E8D5C4] rounded text-[11px]" />
                      </div>
                    </div>
                  )}

                  {blocked && (
                    <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-[11px] text-red-800">
                      Nothing is mapped to {v.vendor_name}, and no purchase history exists to seed from.
                      Add the items they supply above — the PO screen will offer exactly this list.
                    </div>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-white text-[#6B5744] border-b border-[#E8D5C4]">
                        <tr>
                          <th className="text-left  py-2 px-3 font-medium">SKU</th>
                          <th className="text-left  py-2 px-3 font-medium">Item</th>
                          <th className="text-center py-2 px-3 font-medium" title="Is this item mapped to this vendor? Purchase Orders only accept mapped pairs.">Mapped?</th>
                          <th className="text-right py-2 px-3 font-medium" title="Negotiated contract price (separate from mapping). Edit on /contracts.">Contract ₹</th>
                          <th className="text-right py-2 px-3 font-medium">Total Qty</th>
                          <th className="text-right py-2 px-3 font-medium"
                              /* Scoped to "shown here", not "this vendor": the item filter
                                 above can narrow 155 mixed rows down to one BTL row, and a
                                 tooltip claiming the vendor buys only in BTL would be the
                                 same over-claim in a smaller box. */
                              title={rateUnit
                                ? `Last purchase price — ₹ per ${rateUnit}. Every item shown here is bought in ${rateUnit}.`
                                : 'Last purchase price, in ₹ per the purchase unit named on each row. The items shown here are bought in several different units, so the column has no single rate basis.'}>
                            Last ₹{rateUnit ? `/${rateUnit}` : ''}
                          </th>
                          <th className="text-right py-2 px-3 font-medium">90d Avg</th>
                          <th className="text-left  py-2 px-3 font-medium">Last Buy</th>
                          <th className="text-center py-2 px-3 font-medium"># Buys</th>
                          <th className="w-6"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 && (
                          <tr><td colSpan={10} className="py-3 px-3 text-[11px] text-[#8B7355]">
                            {v.materials.length === 0 ? 'No items yet.' : `No item matches "${itemFilter[v.vendor_id]}".`}
                          </td></tr>
                        )}
                        {rows.map(m => (
                          <tr key={m.material_id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                            <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{m.material_sku || '—'}</td>
                            <td className="py-1.5 px-3 text-[#2D1B0E]">{m.material_name}</td>
                            <td className="py-1.5 px-3 text-center">
                              {m.is_mapped ? (
                                <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                                  <CheckCircle2 size={11} /> mapped <SourceBadge m={m} />
                                </span>
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
                            <td className="py-1.5 px-3 text-right font-mono">{fmtNum(m.total_qty)} {unitOf(m)}</td>
                            <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                              {fmt(m.last_unit_price)}<span className="text-[10px] text-[#8B7355]">/{unitOf(m)}</span>
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{m.avg_unit_price_90d ? fmt(m.avg_unit_price_90d) : '—'}</td>
                            <td className="py-1.5 px-3 text-[10px] font-mono text-[#8B7355]">{m.last_purchase_date}</td>
                            <td className="py-1.5 px-3 text-center text-[10px] text-[#6B5744]">{m.purchase_count}</td>
                            <td className="py-1.5 px-1 text-right">
                              {m.is_mapped && (
                                <button onClick={() => removeMaterialFromVendor(v.vendor_id, m.material_id, m.material_name)}
                                        title="Unmap (does not delete contract). PO lines pairing them will be refused after this."
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
            These purchases used vendor names that don&apos;t match any active vendor record.
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
