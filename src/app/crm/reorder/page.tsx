'use client';

/**
 * Smart Reorder (/crm/reorder) — AI reorder suggestions → draft POs in one tap.
 *
 * Shows /api/crm/reorder suggestions (same math as the AI Analyst reorder view,
 * enriched with vendors + ₹/purchase-unit prices). Each row is editable (qty,
 * vendor, price) and tickable; the sticky footer creates one DRAFT purchase
 * order per vendor through the normal PO pipeline (submit → approve → receive).
 *
 * Client gate: admin, HOD (is_head_chef) or Store Manager (is_store_manager) —
 * the API enforces the same gate server-side. Mobile-first: cards under md,
 * table md+. Warm theme.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, Loader2, PackageCheck,
  RefreshCw, ShoppingCart, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';

/* ── types (mirror /api/crm/reorder GET) ──────────────────────────────── */

interface VendorOption {
  vendor_id: string;
  vendor_name: string;
  contract_price: number | null;
}

interface SuggestionRow {
  material_id: string;
  name: string;
  sku: string;
  category: string;
  /** Priority stars: 3 = critical, 2 = standard, 1 = low. */
  priority: number;
  current_stock: number;
  unit: string;
  purchase_unit: string;
  pack_size: number;
  current_stock_pu: number;
  avg_daily_use_14d: number;
  days_of_stock_left: number | null;
  suggested_order_qty: number;
  order_unit: string;
  unit_price: number;
  price_source: 'contract' | 'last_purchase' | 'average';
  preferred_vendor_id: string | null;
  preferred_vendor_name: string | null;
  vendors: VendorOption[];
}

/** Row + the user's editable buy decision. */
interface EditableRow extends SuggestionRow {
  selected: boolean;
  qty: number;
  vendor_id: string;   // '' = unassigned
  price: number;       // ₹/purchase-unit
}

interface CreatedOrder {
  id: string;
  po_number: string;
  vendor_name: string;
  total: number;
}

const inr = (n: number) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const PRICE_SOURCE_LABEL: Record<SuggestionRow['price_source'], string> = {
  contract: 'contract price',
  last_purchase: 'last purchase price',
  average: 'avg price × pack',
};

function daysBadge(d: number | null) {
  if (d == null) {
    return <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">no usage data</span>;
  }
  const cls = d <= 3
    ? 'bg-red-50 text-red-700 border-red-200'
    : d <= 7
      ? 'bg-amber-50 text-amber-800 border-amber-200'
      : 'bg-green-50 text-green-700 border-green-200';
  return <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${cls}`}>{d.toFixed(1)}d left</span>;
}

/** Priority stars badge — 3★ critical / 2★ standard / 1★ low. */
function starBadge(p: number) {
  const n = p === 3 ? 3 : p === 1 ? 1 : 2;
  const label = n === 3 ? 'Critical priority' : n === 1 ? 'Low priority' : 'Standard priority';
  const cls = n === 3 ? 'bg-red-50 border-red-200' : n === 1 ? 'bg-gray-50 border-gray-200' : 'bg-amber-50 border-amber-200';
  return (
    <span title={label}
          className={`inline-block text-[10px] px-1.5 py-0.5 rounded-full border ${cls}`}>
      {'⭐'.repeat(n)}
    </span>
  );
}

export default function CrmReorderPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [rows, setRows] = useState<EditableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedOrder[] | null>(null);

  const allowed = !!me && (me.role === 'admin' || me.is_head_chef || me.is_store_manager);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/crm/reorder')
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setRows([]); return; }
        const suggestions: SuggestionRow[] = j.rows || [];
        setRows(suggestions.map(s => ({
          ...s,
          // Pre-ticked: urgent rows (≤3 days of stock) AND 3★ critical materials.
          selected: (s.days_of_stock_left != null && s.days_of_stock_left <= 3)
            || Number(s.priority) === 3,
          qty: s.suggested_order_qty,
          vendor_id: s.preferred_vendor_id || '',
          price: s.unit_price,
        })));
      })
      .catch(e => { setError(e?.message || 'Failed to load suggestions'); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const update = (materialId: string, patch: Partial<EditableRow>) =>
    setRows(prev => prev.map(r => r.material_id === materialId ? { ...r, ...patch } : r));

  const onVendorChange = (row: EditableRow, vendorId: string) => {
    // Adopt the chosen vendor's contract price when it has one.
    const opt = row.vendors.find(v => v.vendor_id === vendorId);
    update(row.material_id, {
      vendor_id: vendorId,
      ...(opt && opt.contract_price != null ? { price: opt.contract_price } : {}),
    });
  };

  const selectedRows = rows.filter(r => r.selected && r.qty > 0);
  const estTotal = selectedRows.reduce((s, r) => s + r.qty * (r.price || 0), 0);

  // Priority-star filter chips: 0 = all tiers. Filtering only hides rows from
  // view — ticked rows stay selected (and counted in the footer) either way.
  const [starFilter, setStarFilter] = useState<0 | 1 | 2 | 3>(0);
  const visibleRows = starFilter === 0 ? rows : rows.filter(r => (r.priority || 2) === starFilter);
  const starCount = (p: number) => rows.filter(r => (r.priority || 2) === p).length;
  const allSelected = visibleRows.length > 0 && visibleRows.every(r => r.selected);

  const createPos = async () => {
    if (creating || selectedRows.length === 0) return;
    setCreating(true);
    setError(null);
    setCreated(null);
    try {
      const r = await api('/api/crm/reorder', {
        method: 'POST',
        body: {
          items: selectedRows.map(row => ({
            material_id: row.material_id,
            qty: row.qty,
            vendor_id: row.vendor_id || null,
            unit_price: row.price,
          })),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setCreated(j.orders || []);
      load();                             // stock didn't change, but reset selections
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      setError(e?.message || 'Failed to create purchase orders');
    } finally {
      setCreating(false);
    }
  };

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admins, department heads and store managers only. Smart Reorder raises
          purchase orders — ask an admin for access.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-28">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ShoppingCart size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Smart Reorder</h1>
            <p className="text-xs text-[#8B7355]">
              AI suggestions from 14-day usage — tick, tweak, and raise draft POs
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Success banner */}
      {created && created.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-green-800">
            <CheckCircle2 size={16} className="shrink-0" />
            Created {created.length} draft PO{created.length > 1 ? 's' : ''} — review & submit from Purchase Orders
          </div>
          <div className="flex flex-wrap gap-2">
            {created.map(o => (
              <a
                key={o.id}
                href={`/purchase-orders?id=${o.id}`}
                className="inline-flex items-center gap-1.5 bg-white border border-green-300 hover:border-green-500 text-sm text-green-900 rounded-lg px-3 py-1.5"
              >
                <PackageCheck size={14} />
                <span className="font-medium">{o.po_number}</span>
                <span className="text-green-700">· {o.vendor_name} · {inr(o.total)}</span>
                <ExternalLink size={12} className="text-green-600" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 p-0.5 hover:opacity-70" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 flex items-center justify-center text-[#8B7355] text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> Checking your stock…
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 flex flex-col items-center justify-center text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-green-50 border border-green-200 flex items-center justify-center">
            <CheckCircle2 size={26} className="text-green-600" />
          </div>
          <div className="text-sm font-semibold text-[#2D1B0E]">Nothing needs reordering</div>
          <p className="text-xs text-[#8B7355] max-w-xs">
            No material is below its reorder level or projected to run out within 7 days.
          </p>
        </div>
      ) : (
        <>
          {/* ── Priority-star chips ── */}
          <TabScroller className="gap-2 text-xs">
            {([
              { k: 0 as const, label: 'All stars',    n: rows.length },
              { k: 3 as const, label: '⭐⭐⭐ Critical', n: starCount(3) },
              { k: 2 as const, label: '⭐⭐ Standard',  n: starCount(2) },
              { k: 1 as const, label: '⭐ Low',        n: starCount(1) },
            ]).map(t => (
              <button key={t.k} onClick={() => setStarFilter(t.k)}
                      className={`px-3 py-1.5 rounded-full border ${
                        starFilter === t.k
                          ? 'bg-[#af4408] text-white border-[#af4408]'
                          : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                      }`}>
                {t.label} <span className="ml-1 font-mono">{t.n}</span>
              </button>
            ))}
          </TabScroller>

          {/* ── Mobile cards (< md) ── */}
          <div className="md:hidden space-y-2.5">
            {visibleRows.map(r => (
              <div
                key={r.material_id}
                className={`bg-white border rounded-xl p-3 space-y-2.5 ${r.selected ? 'border-[#af4408]' : 'border-[#E8D5C4]'}`}
              >
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={e => update(r.material_id, { selected: e.target.checked })}
                    className="mt-1 w-4 h-4 accent-[#af4408] shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[#2D1B0E] break-words">{r.name}</div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11px] text-[#8B7355]">
                      {starBadge(r.priority)}
                      {r.sku && <span>{r.sku}</span>}
                      <span>· stock {r.current_stock_pu.toLocaleString('en-IN')} {r.purchase_unit}</span>
                      {daysBadge(r.days_of_stock_left)}
                    </div>
                  </div>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px] text-[#6B5744] flex flex-col gap-0.5">
                    Qty ({r.order_unit})
                    <input
                      type="number" step="any" min={0}
                      value={r.qty || ''}
                      onChange={e => update(r.material_id, { qty: Math.max(0, parseFloat(e.target.value) || 0) })}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-right tabular-nums"
                    />
                  </label>
                  <label className="text-[10px] text-[#6B5744] flex flex-col gap-0.5">
                    ₹ / {r.purchase_unit}
                    <input
                      type="number" step="any" min={0}
                      value={r.price || ''}
                      onChange={e => update(r.material_id, { price: Math.max(0, parseFloat(e.target.value) || 0) })}
                      title={PRICE_SOURCE_LABEL[r.price_source]}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-right tabular-nums"
                    />
                  </label>
                </div>
                <label className="text-[10px] text-[#6B5744] flex flex-col gap-0.5">
                  Vendor
                  <select
                    value={r.vendor_id}
                    onChange={e => onVendorChange(r, e.target.value)}
                    className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                  >
                    <option value="">Unassigned — pick on the PO</option>
                    {r.vendors.map(v => (
                      <option key={v.vendor_id} value={v.vendor_id}>
                        {v.vendor_name}{v.contract_price != null ? ` · ₹${v.contract_price}/​${r.purchase_unit}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#8B7355]">Line total</span>
                  <span className="font-semibold text-[#2D1B0E] tabular-nums">{inr(r.qty * (r.price || 0))}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop table (md+) ── */}
          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#FFF8F0] text-[11px] uppercase tracking-wide text-[#8B7355] text-left">
                  <th className="px-3 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={e => setRows(prev => prev.map(r =>
                        (starFilter === 0 || (r.priority || 2) === starFilter)
                          ? { ...r, selected: e.target.checked }
                          : r,
                      ))}
                      className="w-4 h-4 accent-[#af4408]"
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5">Material</th>
                  <th className="px-3 py-2.5 text-right">Stock</th>
                  <th className="px-3 py-2.5">Days left</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5">Vendor</th>
                  <th className="px-3 py-2.5 text-right">₹ / PU</th>
                  <th className="px-3 py-2.5 text-right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(r => (
                  <tr key={r.material_id} className={`border-t border-[#F3E7DA] ${r.selected ? 'bg-[#FFF8F0]/60' : ''}`}>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={r.selected}
                        onChange={e => update(r.material_id, { selected: e.target.checked })}
                        className="w-4 h-4 accent-[#af4408]"
                        aria-label={`Select ${r.name}`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-[#2D1B0E]">{r.name}</div>
                      <div className="flex items-center gap-1.5 text-[10px] text-[#8B7355]">
                        {starBadge(r.priority)}
                        <span>{r.sku ? `${r.sku} · ` : ''}{r.category}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-right whitespace-nowrap tabular-nums">
                      {r.current_stock_pu.toLocaleString('en-IN')} <span className="text-[10px] text-[#8B7355]">{r.purchase_unit}</span>
                    </td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">{daysBadge(r.days_of_stock_left)}</td>
                    <td className="px-3 py-2 align-top text-right">
                      <input
                        type="number" step="any" min={0}
                        value={r.qty || ''}
                        onChange={e => update(r.material_id, { qty: Math.max(0, parseFloat(e.target.value) || 0) })}
                        className="w-20 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-right tabular-nums"
                      />
                      <div className="text-[10px] text-[#8B7355] mt-0.5">{r.order_unit}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        value={r.vendor_id}
                        onChange={e => onVendorChange(r, e.target.value)}
                        className="max-w-[180px] px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                      >
                        <option value="">Unassigned</option>
                        {r.vendors.map(v => (
                          <option key={v.vendor_id} value={v.vendor_id}>
                            {v.vendor_name}{v.contract_price != null ? ` · ₹${v.contract_price}` : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <input
                        type="number" step="any" min={0}
                        value={r.price || ''}
                        onChange={e => update(r.material_id, { price: Math.max(0, parseFloat(e.target.value) || 0) })}
                        title={PRICE_SOURCE_LABEL[r.price_source]}
                        className="w-24 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-right tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-2 align-top text-right font-semibold text-[#2D1B0E] whitespace-nowrap tabular-nums">
                      {inr(r.qty * (r.price || 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Sticky footer — selection summary + create */}
      {rows.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-[#E8D5C4] px-4 py-3">
          <div className="max-w-6xl mx-auto flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-semibold text-[#2D1B0E]">{selectedRows.length} selected</span>
              <span className="text-[#8B7355]"> · est. total </span>
              <span className="font-semibold text-[#2D1B0E] tabular-nums">{inr(estTotal)}</span>
            </div>
            <button
              onClick={createPos}
              disabled={creating || selectedRows.length === 0}
              className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2.5"
            >
              {creating
                ? <><Loader2 size={15} className="animate-spin" /> Creating…</>
                : <><ShoppingCart size={15} /> Create Draft PO{new Set(selectedRows.map(r => r.vendor_id || '')).size > 1 ? 's' : ''}</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
