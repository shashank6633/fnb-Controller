'use client';

/**
 * Receiving Variance Report — Phase 1 §4.
 * Shows GRN lines where physical receipt did not match the PO ordered qty,
 * or where some quantity was rejected at QC. Helps spot vendor short-supply,
 * over-supply, and chronic quality issues.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp, XCircle, Loader2 } from 'lucide-react';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

interface Row {
  grn_id: string; grn_number: string; date: string; vendor: string; po_number?: string;
  material_id: string; material_name: string; material_sku?: string; material_unit: string;
  pack_size?: number; purchase_unit?: string;
  quantity_ordered: number; quantity_received: number; quantity_accepted: number;
  quantity_rejected: number; rejection_reason?: string;
  unit_price: number; average_price: number;
  receive_delta: number; accept_delta: number; accept_delta_value: number;
}

interface Resp {
  range: { from: string | null; to: string | null };
  summary: {
    lines: number; net_value_short: number; net_value_excess: number; total_rejected_value: number;
    reason_stats: Record<string, { count: number; qty: number; value: number }>;
  };
  rows: Row[];
}

const REASON_TONE: Record<string, string> = {
  damage:        'bg-orange-100 text-orange-700',
  short_weight:  'bg-amber-100 text-amber-800',
  expired:       'bg-red-100 text-red-700',
  quality:       'bg-red-50 text-red-700',
  rate_mismatch: 'bg-purple-100 text-purple-700',
};

export default function ReceivingVariancePage() {
  const [from, setFrom]   = useState(minusDays(30));
  const [to,   setTo]     = useState(today());
  const [vendor, setVendor] = useState('');
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [data, setData]   = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/vendors').then(r => r.json()).then(d => setVendors(d.vendors || d || [])).catch(() => {});
  }, []);

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    if (vendor) qs.set('vendor_id', vendor);
    const d = await fetch(`/api/receiving-variance?${qs}`).then(r => r.json());
    setData(d); setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, vendor]);

  // Group by vendor for the secondary view
  const vendorRoll = useMemo(() => {
    const m: Record<string, { vendor: string; lines: number; short: number; excess: number; rejected: number }> = {};
    for (const r of data?.rows || []) {
      const k = r.vendor || '—';
      const slot = m[k] || (m[k] = { vendor: k, lines: 0, short: 0, excess: 0, rejected: 0 });
      slot.lines += 1;
      if (r.accept_delta < 0) slot.short += -(r.accept_delta_value || 0);
      else if (r.accept_delta > 0) slot.excess += (r.accept_delta_value || 0);
      if (r.quantity_rejected > 0) slot.rejected += (r.quantity_rejected * (r.unit_price || 0));
    }
    return Object.values(m).sort((a, b) => (b.short + b.rejected) - (a.short + a.rejected));
  }, [data]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <AlertTriangle className="text-[#af4408]" size={24} />
        <div>
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Receiving Variance</h1>
          <p className="text-xs text-[#8B7355]">PO ordered vs GRN received vs QC accepted — spot vendor short-supply, over-supply &amp; quality issues.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Vendor
          <select value={vendor} onChange={e => setVendor(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm min-w-[200px]">
            <option value="">All vendors</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <div className="ml-auto text-xs text-[#6B5744]">
          {loading ? <Loader2 className="animate-spin" size={16} /> : `${data?.rows.length || 0} variance lines`}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Lines flagged</div>
          <div className="text-2xl font-semibold text-[#2D1B0E] mt-1">{data?.summary.lines || 0}</div>
        </div>
        <div className="bg-white border border-amber-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-amber-700 flex items-center gap-1"><TrendingDown size={11} /> Net short-supply value</div>
          <div className="text-2xl font-semibold text-amber-800 mt-1">{fmt(data?.summary.net_value_short || 0)}</div>
        </div>
        <div className="bg-white border border-blue-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-blue-700 flex items-center gap-1"><TrendingUp size={11} /> Net excess-supply value</div>
          <div className="text-2xl font-semibold text-blue-800 mt-1">{fmt(data?.summary.net_value_excess || 0)}</div>
        </div>
        <div className="bg-white border border-red-200 rounded-xl p-4">
          <div className="text-[10px] uppercase tracking-wide text-red-700 flex items-center gap-1"><XCircle size={11} /> Rejected at QC</div>
          <div className="text-2xl font-semibold text-red-800 mt-1">{fmt(data?.summary.total_rejected_value || 0)}</div>
        </div>
      </div>

      {/* Rejection reasons */}
      {data && Object.keys(data.summary.reason_stats).length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-[#2D1B0E] mb-3">Rejection reasons</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.summary.reason_stats).map(([reason, s]) => (
              <div key={reason} className={`px-3 py-2 rounded-lg ${REASON_TONE[reason] || 'bg-[#F5EDE2] text-[#6B5744]'}`}>
                <div className="text-xs font-semibold capitalize">{reason.replace(/_/g, ' ')}</div>
                <div className="text-[10px] mt-0.5">{s.count} {s.count === 1 ? 'line' : 'lines'} · {fmt(s.value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Vendor roll-up */}
      {vendorRoll.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
            <h2 className="text-sm font-semibold text-[#2D1B0E]">By vendor</h2>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-[#FFF8F0] text-[#8B7355]">
              <tr>
                <th className="text-left  py-2 px-4 font-medium">Vendor</th>
                <th className="text-right py-2 px-4 font-medium">Lines</th>
                <th className="text-right py-2 px-4 font-medium">Short ₹</th>
                <th className="text-right py-2 px-4 font-medium">Excess ₹</th>
                <th className="text-right py-2 px-4 font-medium">Rejected ₹</th>
              </tr>
            </thead>
            <tbody>
              {vendorRoll.map(v => (
                <tr key={v.vendor} className="border-t border-[#E8D5C4]/50">
                  <td className="py-1.5 px-4 font-medium text-[#2D1B0E]">{v.vendor}</td>
                  <td className="py-1.5 px-4 text-right font-mono">{v.lines}</td>
                  <td className="py-1.5 px-4 text-right font-mono text-amber-800">{v.short ? fmt(v.short) : '—'}</td>
                  <td className="py-1.5 px-4 text-right font-mono text-blue-800">{v.excess ? fmt(v.excess) : '—'}</td>
                  <td className="py-1.5 px-4 text-right font-mono text-red-700">{v.rejected ? fmt(v.rejected) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Line detail */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Line detail</h2>
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
        ) : (data?.rows.length || 0) === 0 ? (
          <div className="p-6 text-center text-sm text-emerald-700">
            ✓ No variance — every PO line in this range was received and accepted in full.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF8F0] text-[#8B7355]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">GRN · PO</th>
                  <th className="text-left  py-2 px-3 font-medium">Vendor</th>
                  <th className="text-left  py-2 px-3 font-medium">Material</th>
                  <th className="text-right py-2 px-3 font-medium">Ordered</th>
                  <th className="text-right py-2 px-3 font-medium">Received</th>
                  <th className="text-right py-2 px-3 font-medium">Accepted</th>
                  <th className="text-right py-2 px-3 font-medium">Δ</th>
                  <th className="text-right py-2 px-3 font-medium">Δ ₹</th>
                  <th className="text-left  py-2 px-3 font-medium">Reject reason</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const u = r.material_unit;
                  const dShort = r.accept_delta < 0;
                  const dExcess = r.accept_delta > 0;
                  return (
                    <tr key={r.grn_id + '-' + r.material_id + '-' + idx} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                      <td className="py-1.5 px-3 whitespace-nowrap text-[#6B5744]">{r.date}</td>
                      <td className="py-1.5 px-3 whitespace-nowrap">
                        <a href={`/grn/print/${r.grn_id}`} target="_blank" className="text-[#af4408] font-mono hover:underline">{r.grn_number}</a>
                        {r.po_number && <div className="text-[10px] font-mono text-[#8B7355]">{r.po_number}</div>}
                      </td>
                      <td className="py-1.5 px-3 text-[#6B5744]">{r.vendor}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium text-[#2D1B0E]">{r.material_name}</div>
                        <div className="text-[10px] font-mono text-[#8B7355]">{r.material_sku || '·'}</div>
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_ordered} {u}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_received} {u}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{r.quantity_accepted} {u}</td>
                      <td className={`py-1.5 px-3 text-right font-mono ${dShort ? 'text-amber-800' : dExcess ? 'text-blue-800' : 'text-[#6B5744]'}`}>
                        {r.accept_delta > 0 ? '+' : ''}{r.accept_delta} {u}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-mono ${dShort ? 'text-amber-800' : dExcess ? 'text-blue-800' : 'text-[#6B5744]'}`}>
                        {r.accept_delta_value ? (r.accept_delta_value > 0 ? '+' : '') + fmt(Math.abs(r.accept_delta_value)).replace('₹', dShort ? '-₹' : '+₹') : '—'}
                      </td>
                      <td className="py-1.5 px-3">
                        {r.rejection_reason ? (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${REASON_TONE[r.rejection_reason] || 'bg-[#F5EDE2] text-[#6B5744]'}`}>
                            {r.rejection_reason.replace(/_/g, ' ')} · {r.quantity_rejected} {u}
                          </span>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
