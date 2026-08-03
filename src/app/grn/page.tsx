'use client';

/**
 * Goods Receipt Notes (GRN) — Phase 1 §5 page.
 * Listing + drill-down detail. GRNs are auto-created on PO receive.
 */

import { useEffect, useMemo, useState, Fragment } from 'react';
import { FileCheck, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X, Save, Download, Percent } from 'lucide-react';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import Combobox from '@/components/Combobox';
import { packFactor, fmtQtyNum } from '@/lib/pack-units';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
/** ₹ with 2 decimals — for the inward register (taxes/charges carry paise). */
const m2 = (v: any) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Bare 2-dp number for charge cells (0 shown muted). */
const q2 = (v: any) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0,10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };
/** Subtract n days from a YYYY-MM-DD string (UTC math avoids DST/local drift). */
const isoMinusDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
};

/**
 * The GST rates this kitchen's bills actually carry. A fixed list, not a free
 * number box: a typo'd "1.8" on a ₹40,000 bill is a tax figure nobody catches
 * until the return is filed. Transcribed from purchases/page.tsx:60 — the two
 * manual purchase-entry surfaces must offer the SAME rate card.
 */
const GST_RATES = ['0', '5', '12', '18', '28'] as const;

/**
 * Client-side mirror of store-engine's SQL catNorm(): lower-case, then strip
 * spaces / hyphens / underscores, so 'Single-Malt Whiskey', 'single malt
 * whiskey' and 'singlemaltwhiskey' all compare equal. Both sides of every
 * store_category_map ↔ raw_materials.category comparison must use it, or a
 * liquor category spelled with a hyphen goes unrecognised and gets taxed.
 */
const catKey = (s: unknown) => String(s || '').trim().toLowerCase().replace(/[\s\-_]/g, '');

/** Round to paisa. Every derived money figure on this form goes through here. */
const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

/* GRN Inward line (entry form). The seven ₹ charge fields mirror the sheet:
   Discount, CGST, SGST, Special Excise Cess, TCS, Delivery Charges, MRP Round Off.
   SUBTOTAL = received × rate; TOTAL INWARD = subtotal − discount + cgst + sgst
   + cess + tcs + delivery + round-off.
   gst_rate is a WIRE/UI field only — like /api/purchases, the purchases table
   stores the derived rupees, never the rate. Kept as a raw STRING so a decimal
   stays typeable and '' can mean "Manual (type the ₹ yourself)". */
interface GrnLine {
  material_id: string; quantity_received: string; quantity_accepted: string;
  rejection_reason: string; unit_price: string; notes: string;
  gst_rate: string;
  discount: string; cgst: string; sgst: string; special_excise_cess: string;
  tcs: string; delivery_charges: string; mrp_round_off: string;
}
const blankLine = (): GrnLine => ({
  material_id: '', quantity_received: '', quantity_accepted: '', rejection_reason: '', unit_price: '', notes: '',
  gst_rate: '',
  discount: '', cgst: '', sgst: '', special_excise_cess: '', tcs: '', delivery_charges: '', mrp_round_off: '',
});
const n0 = (s?: string) => { const v = Number(s); return Number.isFinite(v) ? v : 0; };
/** SUBTOTAL = inward qty × rate. */
const lineSubtotal = (l: GrnLine) => n0(l.quantity_received) * n0(l.unit_price);
/** TOTAL INWARD AMOUNT for a line (same formula the server + register use).
 *  `tax` overrides the two hand-typed ₹ boxes with the figures derived from the
 *  line's GST% — pass it wherever a rate is in play, or the screen total lags
 *  the rate the clerk just picked. Every other term is untouched. */
const lineTotal = (l: GrnLine, tax?: { cgst: number; sgst: number }) =>
  lineSubtotal(l) - n0(l.discount) + (tax ? tax.cgst : n0(l.cgst)) + (tax ? tax.sgst : n0(l.sgst))
  + n0(l.special_excise_cess)
  + n0(l.tcs) + n0(l.delivery_charges) + n0(l.mrp_round_off);
/** Same TOTAL formula for a saved GRN item row (server fields). */
const itemInwardTotal = (it: any) =>
  (Number(it.quantity_received) || 0) * (Number(it.unit_price) || 0)
  - (Number(it.discount) || 0) + (Number(it.cgst) || 0) + (Number(it.sgst) || 0)
  + (Number(it.special_excise_cess) || 0) + (Number(it.tcs) || 0)
  + (Number(it.delivery_charges) || 0) + (Number(it.mrp_round_off) || 0);

interface GRN {
  id: string; grn_number: string; date: string; time?: string;
  po_id?: string; po_number?: string;
  vendor_id?: string; vendor?: string;
  invoice_number?: string; invoice_date?: string;
  received_by?: string; qc_by?: string;
  status: 'received' | 'partial' | 'rejected';
  notes?: string;
  line_count: number;
  total_rejected: number;
  /** How many DISTINCT purchase units the rejected lines span (0 = none rejected).
   *  total_rejected is only a printable quantity when this is exactly 1. */
  rejected_unit_count?: number;
  rejected_unit?: string | null;
  rejected_lines?: number;
  accepted_value: number;
  inward_value: number;
}

const STATUS_TONE: Record<string, string> = {
  received: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  partial:  'bg-amber-100 text-amber-800 border-amber-200',
  rejected: 'bg-red-100 text-red-700 border-red-200',
};

export default function GrnPage() {
  const [list, setList] = useState<GRN[]>([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(minusDays(30));
  const [to, setTo] = useState(today());
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to }); if (statusFilter) qs.set('status', statusFilter);
    const d = await fetch(`/api/grn?${qs}`).then(r => r.json());
    setList(d.grns || []); setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [from, to, statusFilter]);

  // Download the flat inward register (one row per LINE) in the sheet's column
  // order + our extras, for the current date range + status filter.
  const [exporting, setExporting] = useState(false);
  const downloadRegister = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams({ register: '1', from, to }); if (statusFilter) qs.set('status', statusFilter);
      const d = await fetch(`/api/grn?${qs}`).then(r => r.json());
      const rows: any[] = d.rows || [];
      if (!rows.length) { alert('No inward lines in this date range.'); return; }
      // Formula-injection guard — but only for genuinely non-numeric cells, so
      // signed numbers (negative MRP round-off, back-correction qtys/totals)
      // stay as real numbers Excel can sum (not text). Number('') is 0 → fine.
      const clean = (v: any) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const header = ['GRN No.', 'INVOICE ID', 'INWARD DATE', 'SUPPLIER NAME', 'CATEGORY NAME', 'ITEM NAME',
        'PO QTY', 'INWARD QTY', 'PURCHASE UNIT', 'RATE', 'SUBTOTAL', 'DISCOUNT', 'CGST', 'SGST',
        'SPECIAL EXCISE CESS', 'TCS', 'DELIVERY CHARGES', 'MRP ROUND OFF', 'TOTAL INWARD AMOUNT',
        'ACCEPTED QTY', 'REJECTED QTY', 'REJECT REASON', 'STATUS', 'RECEIVED BY', 'INVOICE DATE'];
      const lines = [header.join(',')];
      for (const r of rows) lines.push([
        r.grn_number, r.invoice_number, r.inward_date, r.supplier, r.category_name, r.item_name,
        r.po_qty, r.inward_qty, r.purchase_unit, r.rate, r.subtotal, r.discount, r.cgst, r.sgst,
        r.special_excise_cess, r.tcs, r.delivery_charges, r.mrp_round_off, r.total_inward_amount,
        r.quantity_accepted, r.quantity_rejected, r.rejection_reason, r.status, r.received_by, r.invoice_date,
      ].map(clean).join(','));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `GRN-inward-register-${from}_to_${to}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  const counts = useMemo(() => {
    // No cross-GRN quantity total here on purpose: rejected qtys are PURCHASE
    // units of different materials (kg + BTL + pcs) and summing them produces a
    // number that means nothing. Only the ₹ roll-up is addable. (An unrendered
    // total_rejected_qty accumulator used to sit here — removed so nobody
    // "helpfully" prints it later.)
    const c = { received: 0, partial: 0, rejected: 0, accepted_value: 0 };
    for (const g of list) {
      c[g.status] = (c[g.status] || 0) + 1;
      c.accepted_value += g.accepted_value || 0;
    }
    return c;
  }, [list]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <FileCheck className="w-6 h-6 text-[#af4408]" /> Goods Receipt Notes
          </h1>
          <p className="text-xs text-[#6B5744] mt-1">
            Every PO receive creates a GRN. Each line records ordered / received / accepted / rejected with a reason. Use <em>Ad-hoc GRN</em> for receipts without a parent PO (cash buy, sample, donation).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadRegister} disabled={exporting}
                  title="Download the inward register (one row per line, sheet column order) as CSV/Excel"
                  className="px-3 py-2 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Inward Register
          </button>
          <button onClick={() => setCreating(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Ad-hoc GRN
          </button>
        </div>
      </div>
      {creating && <AdHocGrnModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex flex-col text-[#6B5744]">From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <div className="flex gap-1 ml-2">
          {(['', 'received', 'partial', 'rejected'] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
                    className={`px-2 py-0.5 rounded border ${statusFilter === s ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
        <div className="ml-auto text-[#6B5744] flex gap-3">
          <span>✓ {counts.received}</span>
          <span className="text-amber-700">⚠ {counts.partial}</span>
          <span className="text-red-700">✗ {counts.rejected}</span>
          <span>Σ accepted: <b className="font-mono">{fmt(counts.accepted_value)}</b></span>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : list.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">No GRNs in this range. They're created automatically when you receive a PO.</div>
        ) : (
          <div className="overflow-x-auto">
          {/* min-w grows with the column count — the wrapper scrolls horizontally
              rather than letting a 13th column squeeze the others into wrapping. */}
          <table className="w-full text-xs min-w-[980px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-1.5 px-3 font-medium">GRN #</th>
                <th className="text-left py-1.5 px-3 font-medium">Date</th>
                <th className="text-left py-1.5 px-3 font-medium">Vendor</th>
                <th className="text-left py-1.5 px-3 font-medium">Bill No.</th>
                <th className="text-left py-1.5 px-3 font-medium">Linked PO</th>
                <th className="text-right py-1.5 px-3 font-medium">Lines</th>
                <th className="text-right py-1.5 px-3 font-medium">Rejected qty</th>
                <th className="text-right py-1.5 px-3 font-medium">Accepted ₹</th>
                <th className="text-right py-1.5 px-3 font-medium">Inward ₹</th>
                <th className="text-left py-1.5 px-3 font-medium">Status</th>
                <th className="text-left py-1.5 px-3 font-medium">Received by</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {list.map(g => (
                <GrnRow key={g.id} g={g} expanded={expanded === g.id} onToggle={() => setExpanded(expanded === g.id ? null : g.id)} />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

function GrnRow({ g, expanded, onToggle }: { g: GRN; expanded: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => {
    if (expanded && !detail) {
      fetch(`/api/grn?id=${g.id}`).then(r => r.json()).then(d => setDetail(d.grn));
    }
  }, [expanded, g.id, detail]);
  return (
    <>
      <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/40">
        <td className="px-2 py-2"><button onClick={onToggle} className="text-[#6B5744]">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
        <td className="py-2 px-3 font-mono font-semibold text-[#2D1B0E]">{g.grn_number}</td>
        <td className="py-2 px-3">{g.date}</td>
        <td className="py-2 px-3 text-[#6B5744]">{g.vendor || '—'}</td>
        {/* The VENDOR's bill/invoice number — what the store clerk matches the
            paper against. Our own GRN # is two columns left; these are different
            numbers and mixing them up is how a bill gets paid twice. */}
        <td className="py-2 px-3 font-mono text-[#6B5744]">{g.invoice_number || '—'}</td>
        <td className="py-2 px-3 font-mono">{g.po_number ? <a href="/purchase-orders" className="text-[#af4408] hover:underline">{g.po_number}</a> : <span className="text-[#8B7355]">—</span>}</td>
        <td className="py-2 px-3 text-right font-mono">{g.line_count}</td>
        {/* Rejected qty is a SUM ACROSS MATERIALS and GRN qtys are PURCHASE units,
            so it can only be printed as a quantity when every rejected line shares
            one purchase unit (kg + kg). A mixed GRN (2 kg + 3 BTL) has no honest
            total — show the rejected LINE COUNT and send the reader to the rows.
            Same precedent as the stock-overview tfoot. */}
        <td className="py-2 px-3 text-right font-mono text-red-700">
          {(() => {
            const rej = Number(g.total_rejected) || 0;
            if (rej <= 0) return <span className="text-[#8B7355]">—</span>;
            // undefined (a payload from before these fields existed) ≠ "mixed" —
            // say we don't know the unit rather than invent either answer.
            if (g.rejected_unit_count == null) {
              return <span title="Expand the row for the per-line quantities and their purchase units.">{rej.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</span>;
            }
            const uc = Number(g.rejected_unit_count) || 0;
            if (uc === 1 && g.rejected_unit) {
              return <>{rej.toLocaleString('en-IN', { maximumFractionDigits: 3 })} <span className="text-[9px] text-[#B8A590]">{g.rejected_unit}</span></>;
            }
            const n = Number(g.rejected_lines ?? 0) || 0;
            return (
              <span title="Rejected across materials with different purchase units — a single total would mix units. Expand the row for the per-line quantities.">
                {n > 0 ? `${n} line${n === 1 ? '' : 's'}` : '—'} <span className="text-[9px] text-[#B8A590]">mixed units</span>
              </span>
            );
          })()}
        </td>
        <td className="py-2 px-3 text-right font-mono font-semibold">{fmt(g.accepted_value || 0)}</td>
        <td className="py-2 px-3 text-right font-mono font-semibold text-[#af4408]">{g.inward_value ? fmt(g.inward_value) : '—'}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[g.status]}`}>{g.status}</span>
        </td>
        <td className="py-2 px-3 text-[10px] text-[#8B7355]">{g.received_by || '—'}</td>
        <td className="py-2 px-3"><a href={`/grn/print/${g.id}`} target="_blank" className="text-[10px] text-[#af4408] hover:underline">Print</a></td>
      </tr>
      {/* colSpan tracks the header column count (13 since Bill No. was added) —
          if it under-counts, the detail panel stops short of the table width. */}
      {expanded && (
        <tr><td colSpan={13} className="bg-[#FFF8F0] py-3 px-4">
          {!detail ? (
            <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading line items…</div>
          ) : (
            <>
              <div className="text-xs text-[#6B5744] mb-2 flex flex-wrap gap-x-3 gap-y-1">
                <span><b>GRN #:</b> {detail.grn_number}</span>
                {detail.invoice_number && <span><b>Invoice ID:</b> {detail.invoice_number}</span>}
                <span><b>Inward date:</b> {detail.date}</span>
                <span><b>Supplier:</b> {detail.vendor || '—'}</span>
                {detail.invoice_date && <span><b>Invoice date:</b> {detail.invoice_date}</span>}
                {detail.qc_by && <span><b>QC by:</b> {detail.qc_by}</span>}
                {detail.notes && <span><b>Notes:</b> {detail.notes}</span>}
              </div>
              {(() => {
                const checklist = [
                  ['qc_quality',       'Quality'],
                  ['qc_temperature',   'Temperature'],
                  ['qc_expiry',        'Expiry'],
                  ['qc_damage',        'No damage'],
                  ['qc_weight',        'Weight'],
                  ['qc_invoice_match', 'Invoice match'],
                ] as const;
                const tickedCount = checklist.filter(([k]) => detail[k]).length;
                return (
                  <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[10px]">
                    <span className="text-[#8B7355]">QC checklist {tickedCount}/{checklist.length}:</span>
                    {checklist.map(([k, label]) => (
                      <span key={k} className={`px-1.5 py-0.5 rounded border ${
                        detail[k] ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'
                      }`}>
                        {detail[k] ? '✓' : '○'} {label}
                      </span>
                    ))}
                  </div>
                );
              })()}
              {/* Inward register — sheet column order (line-level), then our
                  extra QC columns (Accepted / Rejected / Reason). Header fields
                  (GRN #, Invoice, Date, Supplier) show in the summary line above. */}
              <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[1180px]">
                <thead className="text-[#8B7355] bg-[#FFF1E3]/50">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Category</th>
                    <th className="text-left  py-1 px-2 font-medium">Item</th>
                    <th className="text-right py-1 px-2 font-medium">PO Qty</th>
                    <th className="text-right py-1 px-2 font-medium">Inward Qty</th>
                    <th className="text-left  py-1 px-2 font-medium">Purchase Unit</th>
                    <th className="text-right py-1 px-2 font-medium">Rate</th>
                    <th className="text-right py-1 px-2 font-medium">Subtotal</th>
                    <th className="text-right py-1 px-2 font-medium">Discount</th>
                    <th className="text-right py-1 px-2 font-medium">CGST</th>
                    <th className="text-right py-1 px-2 font-medium">SGST</th>
                    <th className="text-right py-1 px-2 font-medium">Sp. Excise Cess</th>
                    <th className="text-right py-1 px-2 font-medium">TCS</th>
                    <th className="text-right py-1 px-2 font-medium">Delivery</th>
                    <th className="text-right py-1 px-2 font-medium">MRP Round Off</th>
                    <th className="text-right py-1 px-2 font-medium text-[#af4408]">Total Inward</th>
                    <th className="text-right py-1 px-2 font-medium border-l border-[#E8D5C4]">Accepted</th>
                    <th className="text-right py-1 px-2 font-medium">Rejected</th>
                    <th className="text-left  py-1 px-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it: any) => {
                    const muted = 'text-[#B8A590]';
                    const chargeCell = (v: any) => <td className={`py-1 px-2 text-right font-mono ${Number(v) ? 'text-[#2D1B0E]' : muted}`}>{q2(v)}</td>;
                    // Accepted / Rejected sit twelve ₹ columns to the RIGHT of the
                    // Purchase Unit column, far enough that the unit no longer reads
                    // as theirs. They are the same PURCHASE units as Inward Qty —
                    // repeat the label so nobody reads them as recipe grams.
                    const pu = it.purchase_unit || it.material_unit || '';
                    return (
                    <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 px-2 text-[#6B5744]">{it.material_category || '—'}</td>
                      <td className="py-1 px-2 text-[#2D1B0E]">{it.material_name}</td>
                      <td className="py-1 px-2 text-right font-mono">{Number(it.quantity_ordered) || 0}</td>
                      <td className="py-1 px-2 text-right font-mono">{it.quantity_received}</td>
                      <td className="py-1 px-2 text-[#6B5744]">{it.purchase_unit || it.material_unit || '—'}</td>
                      <td className="py-1 px-2 text-right font-mono">{m2(it.unit_price)}</td>
                      <td className="py-1 px-2 text-right font-mono">{m2(it.subtotal)}</td>
                      {chargeCell(it.discount)}
                      {chargeCell(it.cgst)}
                      {chargeCell(it.sgst)}
                      {chargeCell(it.special_excise_cess)}
                      {chargeCell(it.tcs)}
                      {chargeCell(it.delivery_charges)}
                      {chargeCell(it.mrp_round_off)}
                      <td className="py-1 px-2 text-right font-mono font-semibold text-[#af4408]">{m2(it.total_inward_amount)}</td>
                      <td className="py-1 px-2 text-right font-mono text-emerald-700 border-l border-[#E8D5C4]">{it.quantity_accepted} <span className="text-[9px] text-[#B8A590]">{pu}</span></td>
                      <td className="py-1 px-2 text-right font-mono text-red-700">{it.quantity_rejected || 0} <span className="text-[9px] text-[#B8A590]">{pu}</span></td>
                      <td className="py-1 px-2 text-[#6B5744]">{it.rejection_reason || ''}</td>
                    </tr>
                  ); })}
                </tbody>
                <tfoot className="bg-[#FFF1E3]/60 font-semibold text-[#2D1B0E] border-t border-[#E8D5C4]">
                  <tr>
                    <td className="py-1.5 px-2" colSpan={6}>{detail.items.length} line(s)</td>
                    <td className="py-1.5 px-2 text-right font-mono">{m2(detail.items.reduce((s: number, it: any) => s + (Number(it.subtotal) || 0), 0))}</td>
                    <td className="py-1.5 px-2 text-right font-mono" colSpan={7}></td>
                    <td className="py-1.5 px-2 text-right font-mono text-[#af4408]">{m2(detail.items.reduce((s: number, it: any) => s + (Number(it.total_inward_amount) || 0), 0))}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </>
          )}
        </td></tr>
      )}
    </>
  );
}

/* ============================================================ */
/* Ad-hoc GRN modal — creates a GRN + purchases for a non-PO   */
/* receipt (cash buy, sample, donation, return).                */
/* ============================================================ */
function AdHocGrnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [vendor, setVendor] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [qcBy, setQcBy] = useState('');
  const [notes, setNotes] = useState('');
  // Phase 1 §4 — receiving QC checklist (each item gets ticked at the receiving bay)
  const [qc, setQc] = useState({
    qc_quality: false, qc_temperature: false, qc_expiry: false,
    qc_damage: false, qc_weight: false, qc_invoice_match: false,
  });
  const toggleQc = (k: keyof typeof qc) => setQc(p => ({ ...p, [k]: !p[k] }));
  const [items, setItems] = useState<GrnLine[]>([blankLine()]);
  // Per-line collapsible charges panel (Discount / CGST / SGST / Cess / TCS /
  // Delivery / MRP round-off). Default collapsed — most lines carry no charges.
  const [openCharges, setOpenCharges] = useState<Set<number>>(new Set());
  const toggleCharges = (i: number) => setOpenCharges(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const [vendors, setVendors] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  // Configurable backdate limit + admin exemption. Server is the real guard;
  // these only set the receipt-date input's min/max (UX). Default: 3 days, non-admin.
  const [backdateLimit, setBackdateLimit] = useState(3);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const [sRes, mRes] = await Promise.all([
          fetch('/api/settings?key=purchase_backdate_limit_days'),
          fetch('/api/auth/me'),
        ]);
        const sJson = await sRes.json().catch(() => null);
        const raw = sJson?.value;
        const n = Math.max(0, Math.floor(Number(raw)));
        setBackdateLimit(Number.isFinite(n) && raw != null && raw !== '' ? n : 3);
        const mJson = await mRes.json().catch(() => null);
        setIsAdmin(mJson?.user?.role === 'admin');
      } catch { /* keep defaults; server still enforces */ }
    })();
  }, []);
  const dateMin = isAdmin ? undefined : isoMinusDays(todayIST(), backdateLimit);
  const dateMax = isAdmin ? undefined : todayIST();

  // Back-correction mode — when ON, negative qtys are allowed for fixing a
  // prior GRN where the store forgot to subtract something. Default OFF so
  // the day-to-day flow can't accidentally book "-5 kg received" as if that
  // were stock IN. The flag is sent to the server in the notes for audit.
  const [isAdjustment, setIsAdjustment] = useState(false);
  const [adjustmentRef, setAdjustmentRef] = useState('');  // free-text: which prior GRN/PO this corrects

  // When showAllMaterials = true, the dropdown bypasses the vendor-contract
  // filter — used for ad-hoc cash buys / new-vendor situations where no
  // contracts exist yet.
  const [showAllMaterials, setShowAllMaterials] = useState(false);

  // Always load the full catalog up-front so the picker has data immediately.
  // The vendor-contract filter is applied client-side once the user picks a
  // vendor (see filteredMaterials below). This avoids any "empty picker" race
  // and lets the user type before / after picking a vendor in any order.
  useEffect(() => {
    fetch('/api/vendors').then(r => r.json()).then(d => setVendors((d.vendors || []).filter((v: any) => v.is_active)));
    fetch('/api/inventory?scope=all').then(r => r.json()).then(d => setMaterials(d.materials || []));
  }, []);

  /**
   * Which categories belong to an ACTIVE store location. Any signed-in user may
   * GET /api/stores, and it already returns each store's mapped categories, so
   * the client can recognise a TGBCL/liquor line without a new endpoint. Same
   * source purchases/page.tsx uses (fetchStoreCategories).
   */
  const [storeCats, setStoreCats] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/stores');
        if (!res.ok) return;                     // leave the set empty = "unknown"
        const json = await res.json();
        const next = new Set<string>();
        for (const st of json.stores || []) {
          // A deactivated store releases its categories back to Central behaviour —
          // same rule materialStoreId() applies server-side.
          if (!st?.is_active) continue;
          for (const c of st.categories || []) { const k = catKey(c?.category); if (k) next.add(k); }
        }
        setStoreCats(next);
      } catch {
        // Leave empty. Rates then behave normally, and the server still refuses a
        // store-mapped line outright (centralFlowBlock in /api/grn POST).
      }
    })();
  }, []);

  /** Is this line a store-mapped (TGBCL liquor) material — i.e. zero-rated here? */
  const storeMappedLine = (materialId: string) => {
    if (storeCats.size === 0 || !materialId) return false;
    const m = materials.find(x => x.id === materialId) as any;
    return !!m && storeCats.has(catKey(m.category));
  };

  /**
   * The GST% a line should START at when this material is picked — the master's
   * raw_materials.tax_percent, which the ad-hoc GRN never read (the reported bug:
   * the rate is keyed on the master and the clerk still hand-types the rupees).
   *
   * It SEEDS, it does not FORCE: a bill is a fact, and the printed vendor invoice
   * wins over a possibly-stale master. Both refusals are transcribed verbatim from
   * purchases/page.tsx (seedGstForMaterial) — do not "simplify" either away:
   *   · store-mapped (TGBCL liquor) is zero-rated here and returns '' so no rate
   *     can ever be seeded onto it. tax_percent is a free field on the master with
   *     no liquor guard, so a manager CAN type 18 on a TGBCL item.
   *   · a rate that is not in GST_RATES (say 7) returns '' rather than a value
   *     matching no <option> — React renders the select blank, the clerk reads
   *     0%, and the calc books 7%.
   * '' here means MANUAL (type the ₹ yourself), not "inherit" — this form has no
   * bill-level rate, so an unseeded line behaves exactly as it does today.
   */
  const seedGstForMaterial = (materialId: string): string => {
    if (!materialId) return '';
    if (storeMappedLine(materialId)) return '';
    const m = materials.find(x => x.id === materialId) as any;
    const t = Number(m?.tax_percent) || 0;
    if (t <= 0) return '';
    const s = String(t);
    return (GST_RATES as readonly string[]).includes(s) ? s : '';
  };

  /**
   * Per-line tax, derived. Pure — reads the line, writes nothing, so the display
   * can never drift from what submit() sends.
   *
   * BASE = ACCEPTED qty × rate − discount, not received. This is deliberate and
   * is the one place the panel departs from lineSubtotal (received-based): PO
   * Receive already books its GRN rows' cgst/sgst off the accepted gross
   * (api/purchase-orders/[id]/receive/route.ts:852, `effAcc > 0 ? effAcc : 0`).
   * If ad-hoc taxed the received qty, the same bill would carry different tax
   * depending on which screen booked it and the inward register — which mixes
   * rows from both sources — would stop being homogeneous. Copying the
   * `> 0 ? … : 0` clamp also settles back-corrections for free: a negative line
   * derives 0 tax, which is what the server's chg() (api/grn/route.ts:195, floors
   * negatives to 0) would have stored anyway, so screen and stored row agree.
   *
   * SPLIT canon: api/purchases/route.ts:363-367. Whole-paise arithmetic (the ÷100
   * for percent and the ×100 for paise cancel), SGST takes the floored half and
   * CGST absorbs the odd paisa, so the house invariant tax_value === cgst + sgst
   * holds EXACTLY. Do not re-derive either half with a float divide.
   */
  const lineTax = (l: GrnLine) => {
    const derived = l.gst_rate !== '' && !storeMappedLine(l.material_id);
    const qa = l.quantity_accepted !== '' ? n0(l.quantity_accepted) : n0(l.quantity_received);
    const q = qa > 0 ? qa : 0;
    const taxable = r2(q * n0(l.unit_price) - n0(l.discount));
    if (!derived) return { rate: 0, taxable, tax: 0, cgst: n0(l.cgst), sgst: n0(l.sgst), derived };
    const rate = parseFloat(l.gst_rate) || 0;
    const taxPaise = rate > 0 ? Math.max(0, Math.round(taxable * rate)) : 0;
    const tax = taxPaise / 100;
    const sgst = Math.floor(taxPaise / 2) / 100;
    const cgst = r2(tax - sgst);
    return { rate, taxable, tax, cgst, sgst, derived };
  };

  // When a vendor is picked, fetch their MAPPED materials (vendor_materials
  // table — not contracts). User manages mappings on /vendors/materials.
  // Empty mapping → fall back to all materials.
  const [vendorMaterialIds, setVendorMaterialIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!vendorId) { setVendorMaterialIds(null); return; }
    fetch(`/api/vendor-materials?vendor_id=${encodeURIComponent(vendorId)}`)
      .then(r => r.json())
      .then(d => {
        const ids = new Set<string>((d.mappings || []).map((m: any) => m.material_id));
        setVendorMaterialIds(ids.size > 0 ? ids : null);
      })
      .catch(() => setVendorMaterialIds(null));
  }, [vendorId]);

  // Materials shown in the picker: full catalog filtered by vendor contracts
  // (unless the user opted to show all, or the vendor has no contracts).
  const filteredMaterials = (vendorMaterialIds && !showAllMaterials)
    ? materials.filter(m => vendorMaterialIds.has(m.id))
    : materials;

  /**
   * PURCHASE-unit basis for every quantity on this form. /api/grn POST reads
   * quantity_received / quantity_accepted as PURCHASE units and applies the
   * ×pack_size step itself (see its "Unit-basis boundary" comment), and
   * unit_price is ₹ per purchase unit — so this is a LABEL resolver only:
   * nothing here converts, and nothing is converted on the way to the API.
   * Resolved off the FULL catalog, not filteredMaterials, so a line picked
   * before the vendor filter narrowed the list still shows its unit.
   */
  const lineUnits = (materialId: string) => {
    const m = materials.find(x => x.id === materialId) as any;
    if (!m) return { pu: '', ru: '', pf: 1 };
    const ru = String(m.unit || '');
    const pu = String(m.purchase_unit || ru || '');
    return { pu, ru, pf: packFactor({ unit: ru, purchase_unit: m.purchase_unit, pack_size: m.pack_size }) };
  };

  const addLine = () => setItems(p => [...p, blankLine()]);
  const removeLine = (i: number) => setItems(p => p.filter((_, j) => j !== i));
  const updateLine = (i: number, patch: any) => setItems(p => p.map((it, j) => j === i ? { ...it, ...patch } : it));

  /**
   * Picking/swapping the material re-seeds the line's GST% from the new material's
   * master rate — but ONLY when the current rate is still MACHINE-set: either
   * untouched ('') or exactly what the PREVIOUS material would have seeded.
   * Anything else is a rate the clerk deliberately picked off the printed bill,
   * and silently resetting it is a tax error nobody notices until the return is
   * filed. The test must stay "equals the previous seed" — a hardcoded '' would
   * clobber every seeded line on a material swap. (purchases/page.tsx:646-648.)
   *
   * One guard this form needs and the bill form does not: it still has the two
   * hand-typed ₹ boxes. Never seed a rate on top of rupees a human already
   * entered — that would take the boxes read-only and silently overwrite them.
   */
  const pickMaterial = (i: number, id: string) => {
    const cur = items[i];
    const prevSeed = seedGstForMaterial(cur.material_id);
    const keep = !(cur.gst_rate === '' || cur.gst_rate === prevSeed)
      || n0(cur.cgst) !== 0 || n0(cur.sgst) !== 0;
    updateLine(i, { material_id: id, gst_rate: keep ? cur.gst_rate : seedGstForMaterial(id) });
  };

  const submit = async () => {
    // Validate qtys BEFORE filtering so the user sees errors instead of silent drops.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.material_id) continue;     // skip blank lines
      const qr = parseFloat(it.quantity_received);
      const qa = it.quantity_accepted ? parseFloat(it.quantity_accepted) : qr;
      if (Number.isNaN(qr)) { alert(`Line ${i + 1}: enter a quantity received`); return; }
      // Negatives only allowed in adjustment mode (admin-flagged back-correction).
      if (!isAdjustment && (qr < 0 || qa < 0)) {
        alert(`Line ${i + 1}: negative quantities are not allowed in normal GRN. Tick "This is a back-correction" at the top if you're fixing a prior receipt.`);
        return;
      }
      // Even in adjustment mode, received and accepted must move in the same
      // direction (both negative for a back-out, or both positive). A mixed
      // sign is almost always a typo.
      if (isAdjustment && qr !== 0 && qa !== 0 && Math.sign(qr) !== Math.sign(qa)) {
        alert(`Line ${i + 1}: received and accepted must have the same sign (both positive or both negative).`);
        return;
      }
    }
    // In normal mode keep the "positive qty" filter (drops blank lines).
    // In adjustment mode allow any non-zero qty (positive or negative).
    const cleaned = items.filter(i => {
      if (!i.material_id) return false;
      const qr = parseFloat(i.quantity_received);
      if (Number.isNaN(qr) || qr === 0) return false;
      return isAdjustment ? true : qr > 0;
    });
    if (cleaned.length === 0) { alert('Add at least one line with a material and qty'); return; }
    if (!vendor.trim()) { alert('Vendor name required'); return; }
    if (isAdjustment && !adjustmentRef.trim()) {
      alert('Back-correction mode: enter the prior GRN# / PO# / invoice# you\'re correcting (for audit).');
      return;
    }
    setBusy(true);
    try {
      const r = await api('/api/grn', {
        method: 'POST',
        body: {
          date, vendor_id: vendorId || null, vendor, invoice_number: invoice, invoice_date: invoiceDate,
          qc_by: qcBy,
          // Mark back-corrections clearly in the audit trail. Prepend a tag to
          // the free-text notes so /audit and the GRN list both surface it.
          notes: isAdjustment
            ? `[BACK-CORRECTION → corrects ${adjustmentRef}] ${notes}`.trim()
            : notes,
          ...qc,
          items: cleaned.map(i => ({
            material_id: i.material_id,
            quantity_received: parseFloat(i.quantity_received),
            quantity_accepted: i.quantity_accepted ? parseFloat(i.quantity_accepted) : parseFloat(i.quantity_received),
            rejection_reason:  i.rejection_reason,
            unit_price:        parseFloat(i.unit_price) || 0,
            notes:             i.notes,
            // The RATE rides along so the server can re-derive the split and be
            // the authority (as /api/purchases and PO Receive already are).
            // undefined on a Manual line → the server keeps the hand-typed ₹.
            gst_rate:            i.gst_rate === '' ? undefined : Number(i.gst_rate),
            // GRN Inward per-line charges (₹). Blank → 0 on the server.
            // cgst/sgst come from lineTax so what was on screen is what is sent —
            // on a rated line these are DERIVED, never the stale box contents.
            discount:            n0(i.discount),
            cgst:                lineTax(i).cgst,
            sgst:                lineTax(i).sgst,
            special_excise_cess: n0(i.special_excise_cess),
            tcs:                 n0(i.tcs),
            delivery_charges:    n0(i.delivery_charges),
            mrp_round_off:       n0(i.mrp_round_off),
          })),
        },
      });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Failed'); return; }
      alert(`✓ Created ${j.grn_number} — ${j.materials_touched} material(s) updated`);
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* House safe-modal shell: the card is capped to the viewport and the BODY
          scrolls internally, so the header + Save/Cancel footer are always on
          screen (previously the card grew to ~1400px and Save sat far below the
          fold on phones). The MaterialTypeahead dropdown lives inside the
          scrollable body — its absolute panel extends the body's scroll area,
          so it stays reachable. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-4xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E]">New Ad-hoc Goods Receipt Note</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-xs">
          <p className="text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            Use this when goods arrive WITHOUT a PO — cash purchase, sample, donation, vendor return.
            On save: creates a GRN, writes <code>purchases</code> rows, bumps stock + recipe-cost cascade.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-[#6B5744]">Receipt Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)} min={dateMin} max={dateMax} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
              {!isAdmin && (
                <span className="text-[10px] text-[#8B7355]">Backdating limited to {backdateLimit} day(s) (admins exempt)</span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Vendor
              <Combobox
                options={vendors.map(v => ({ value: v.name, label: v.name }))}
                value={vendor}
                allowCustom
                placeholder="Type or pick"
                onChange={(typed) => {
                  setVendor(typed);
                  const v = vendors.find(x => x.name.toLowerCase().trim() === typed.toLowerCase().trim());
                  setVendorId(v ? v.id : '');
                  setShowAllMaterials(false); // re-enable vendor-filtered picker when vendor changes
                }}
                className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
              />
              <datalist id="adhoc-vendors">{vendors.map(v => <option key={v.id} value={v.name} />)}</datalist>
              {vendorId && (
                <div className="flex items-center gap-1.5 text-[10px] text-[#8B7355] mt-0.5">
                  <input type="checkbox" id="show-all-mats" checked={showAllMaterials}
                         onChange={e => setShowAllMaterials(e.target.checked)} />
                  <label htmlFor="show-all-mats" className="cursor-pointer">
                    Show all materials (ignore vendor contracts)
                  </label>
                </div>
              )}
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">QC Done By <span className="text-[10px] text-[#8B7355]">(kitchen / bar staff)</span>
              <input value={qcBy} onChange={e => setQcBy(e.target.value)} placeholder="name or email"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Invoice #
              <input value={invoice} onChange={e => setInvoice(e.target.value)} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Invoice Date
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
          </div>

          {/* Back-correction toggle. Default OFF. Lets the store manager book
              negative-qty lines to fix a prior GRN where they forgot to subtract.
              When ON, qty inputs lose the min=0 constraint and a clear amber
              banner shows on the modal. */}
          <div className={`border rounded-lg p-3 ${isAdjustment ? 'border-amber-300 bg-amber-50/60' : 'border-[#E8D5C4] bg-[#FFF8F0]/40'}`}>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={isAdjustment} onChange={e => { setIsAdjustment(e.target.checked); if (!e.target.checked) setAdjustmentRef(''); }}
                     className="mt-0.5 accent-amber-700" />
              <div className="flex-1">
                <div className={`font-semibold ${isAdjustment ? 'text-amber-900' : 'text-[#6B5744]'}`}>
                  This is a back-correction (allow negative quantities)
                </div>
                <div className="text-[10px] text-[#6B5744] mt-0.5">
                  {isAdjustment
                    ? '🔶 Negatives allowed on this GRN. Use ONLY to correct a prior GRN where stock was over-booked. Tag the prior reference below for audit.'
                    : 'Default OFF. Receiving qty must be ≥ 0. Tick this only when fixing a prior receipt the store forgot to deduct.'}
                </div>
                {isAdjustment && (
                  <input value={adjustmentRef} onChange={e => setAdjustmentRef(e.target.value)}
                         placeholder="Prior GRN # / PO # / Invoice # being corrected *"
                         onClick={e => e.stopPropagation()}
                         onMouseDown={e => e.stopPropagation()}
                         className="mt-2 w-full px-2 py-1 border border-amber-300 rounded text-xs bg-white" />
                )}
              </div>
            </label>
          </div>

          {/* Phase 1 §4 — Receiving QC Checklist */}
          <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40">
            <div className="text-xs font-semibold text-blue-900 mb-2 flex items-center gap-2">
              ✓ Receiving Checklist
              <span className="text-[10px] font-normal text-blue-700">
                ({Object.values(qc).filter(Boolean).length} of 6 ticked)
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_quality} onChange={() => toggleQc('qc_quality')} className="accent-blue-600" />
                <span>Quality / Freshness</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_temperature} onChange={() => toggleQc('qc_temperature')} className="accent-blue-600" />
                <span>Temperature OK</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_expiry} onChange={() => toggleQc('qc_expiry')} className="accent-blue-600" />
                <span>Expiry date checked</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_damage} onChange={() => toggleQc('qc_damage')} className="accent-blue-600" />
                <span>No damage</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_weight} onChange={() => toggleQc('qc_weight')} className="accent-blue-600" />
                <span>Weight verified</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={qc.qc_invoice_match} onChange={() => toggleQc('qc_invoice_match')} className="accent-blue-600" />
                <span>Invoice matches</span>
              </label>
            </div>
            <div className="text-[10px] text-blue-700 mt-1.5">
              Kitchen / bar staff signs off on quality + temperature + expiry. Store manager confirms quantity + invoice match.
            </div>
          </div>

          {/* NOTE: no overflow-hidden on the wrapper — that clips the
              MaterialTypeahead dropdown when it opens below the input.
              Same applies to the inner div; we let absolute children escape. */}
          <div className="border border-[#E8D5C4] rounded-lg">
            {/* Sticky within the modal BODY's scroll region (the body is the
                nearest scrolling ancestor; no ancestor here clips it). By the time
                the clerk is typing materials the Vendor combobox — five fields up —
                has scrolled off screen, so the name is echoed here and follows the
                rows down. z-10 is safe: the MaterialTypeahead dropdown is portaled
                to <body> at z-[100], so it still opens OVER this bar. */}
            <div className="sticky top-0 z-10 bg-[#FFF1E3] px-3 py-1.5 text-[#6B5744] flex items-center gap-2 rounded-t-lg">
              <span className="font-semibold shrink-0">Line Items</span>
              <span className="flex-1 min-w-0 truncate text-right" title={vendor.trim() || 'No vendor selected yet'}>
                <span className="text-[9px] uppercase tracking-wide text-[#8B7355] mr-1">Vendor</span>
                {vendor.trim()
                  ? <b className="text-[#2D1B0E]">{vendor.trim()}</b>
                  : <span className="text-[#B8A590]">no vendor selected</span>}
              </span>
              <button onClick={addLine} className="hidden md:flex shrink-0 text-xs text-[#af4408] hover:underline items-center gap-1"><Plus className="w-3 h-3" /> Add line</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs block md:table md:min-w-[600px]">
                <thead className="text-[#8B7355] hidden md:table-header-group">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Material</th>
                    <th className="text-right py-1 px-2 font-medium" title="In the material's PURCHASE unit (kg, L, BTL, CASE) — the unit shows under each box">Received <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-right py-1 px-2 font-medium" title="In the material's PURCHASE unit — blank means the same as Received">Accepted <span className="font-normal text-[9px] text-[#B8A590]">(purchase units)</span></th>
                    <th className="text-left  py-1 px-2 font-medium">Reject reason</th>
                    <th className="text-right py-1 px-2 font-medium" title="₹ per PURCHASE unit (per kg / per BTL) — never per gram">Unit ₹ <span className="font-normal text-[9px] text-[#B8A590]">/ purchase unit</span></th>
                    <th className="text-right py-1 px-2 font-medium">Charges / Total ₹</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="block md:table-row-group">
                  {items.map((it, i) => {
                    const lu = lineUnits(it.material_id);
                    // Display-only hint: the raw input string is never touched here
                    // (running it through Number() on every keystroke is what made
                    // "2." untypeable), we only read it to render "= N g".
                    const hint = (raw: string) => {
                      if (lu.pf <= 1) return null;
                      const q = parseFloat(raw);
                      if (!Number.isFinite(q) || q === 0) return null;
                      return `= ${fmtQtyNum(q * lu.pf)} ${lu.ru}`;
                    };
                    return (
                    <Fragment key={i}>
                    <tr className="border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0">
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        <MaterialTypeahead
                          materials={filteredMaterials as any} purchaseBasis
                          value={it.material_id}
                          onPick={(id) => pickMaterial(i, id)}
                          excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                        />
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Received</span>
                        <input type="number" step="any"
                               // Browser-level guard: min=0 unless this is a back-correction GRN.
                               {...(isAdjustment ? {} : { min: 0 })}
                               value={it.quantity_received}
                               onChange={e => updateLine(i, { quantity_received: e.target.value })}
                               className={`w-full md:w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                 parseFloat(it.quantity_received) < 0
                                   ? 'border-amber-400 bg-amber-50 text-amber-900 font-semibold'
                                   : 'border-[#E8D5C4]'
                               }`} />
                        {lu.pu && (
                          <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">
                            {lu.pu}{hint(it.quantity_received) ? <> · {hint(it.quantity_received)}</> : null}
                          </div>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Accepted</span>
                        <input type="number" step="any"
                               {...(isAdjustment ? {} : { min: 0 })}
                               value={it.quantity_accepted}
                               onChange={e => updateLine(i, { quantity_accepted: e.target.value })}
                               placeholder="(=received)"
                               className={`w-full md:w-20 px-1.5 py-1 border rounded text-right text-xs ${
                                 parseFloat(it.quantity_accepted) < 0
                                   ? 'border-amber-400 bg-amber-50 text-amber-900 font-semibold'
                                   : 'border-[#E8D5C4]'
                               }`} />
                        {lu.pu && (
                          <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">
                            {lu.pu}{hint(it.quantity_accepted) ? <> · {hint(it.quantity_accepted)}</> : null}
                          </div>
                        )}
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Reject reason</span>
                        <select value={it.rejection_reason} onChange={e => updateLine(i, { rejection_reason: e.target.value })}
                                className="w-full px-1.5 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
                          <option value="">—</option>
                          <option value="damage">damage</option>
                          <option value="short_weight">short weight</option>
                          <option value="expired">expired</option>
                          <option value="quality">quality</option>
                          <option value="rate_mismatch">rate mismatch</option>
                          <option value="other">other</option>
                        </select>
                      </td>
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Unit ₹</span>
                        <input type="number" step="any" value={it.unit_price}
                                                       onChange={e => updateLine(i, { unit_price: e.target.value })}
                                                       className="w-full md:w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                        {/* ₹ per PURCHASE unit — the rate the vendor bills. The
                            weighted average is stored per RECIPE unit, but that
                            division happens server-side; never type ₹/g here. */}
                        {lu.pu && <div className="text-[9px] text-[#B8A590] text-right mt-0.5 md:w-20">₹ / {lu.pu}</div>}</td>
                      <td className="py-1 px-2 text-right block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Charges / Total</span>
                        <div className="flex items-center justify-end gap-1.5">
                          {/* The charges panel is collapsed by default, so a rate
                              seeded from the master would otherwise change the row
                              total with nothing on screen explaining it. */}
                          {it.gst_rate !== '' && !storeMappedLine(it.material_id) && (
                            <span className="px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-[10px] font-semibold"
                                  title="GST% on this line — from the material master, editable in the charges panel">
                              GST {it.gst_rate}%
                            </span>
                          )}
                          <button type="button" onClick={() => toggleCharges(i)}
                                  className={`px-1.5 py-0.5 rounded border text-[10px] flex items-center gap-1 ${
                                    openCharges.has(i) ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}>
                            <Percent className="w-2.5 h-2.5" /> {openCharges.has(i) ? 'hide' : 'charges'}
                          </button>
                          <span className="font-mono font-semibold text-[#2D1B0E] min-w-[64px] text-right">
                            {(n0(it.quantity_received) && n0(it.unit_price)) ? `₹${lineTotal(it, lineTax(it)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="py-1 px-2 text-right block md:table-cell"><button onClick={() => removeLine(i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                    </tr>
                    {openCharges.has(i) && (
                      <tr className="block md:table-row">
                        <td colSpan={7} className="block md:table-cell px-2 pb-3 md:pb-2">
                          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5">
                            <div className="text-[10px] font-semibold text-[#6B5744] mb-1.5">Line charges (₹) — leave 0 if not applicable</div>
                            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                              {([
                                ['discount', 'Discount'], ['cgst', 'CGST'], ['sgst', 'SGST'],
                                ['special_excise_cess', 'Special Excise Cess'], ['tcs', 'TCS'],
                                ['delivery_charges', 'Delivery Charges'], ['mrp_round_off', 'MRP Round Off'],
                              ] as const).map(([k, label]) => {
                                const tx = lineTax(it);
                                const isTaxBox = k === 'cgst' || k === 'sgst';
                                return (
                                <Fragment key={k}>
                                {/* GST % sits immediately BEFORE the two boxes it drives. */}
                                {k === 'cgst' && (
                                  <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                    GST %
                                    {storeMappedLine(it.material_id) ? (
                                      // The rate is not the clerk's to set here: this material
                                      // belongs to a store location, where excise / cess / TCS
                                      // are charged on the store's own bill. A GST% on it would
                                      // be tax that was never paid.
                                      <div className="text-[10px] text-blue-700 leading-tight normal-case px-1.5 py-1">
                                        0%
                                        <span className="block text-[9px] text-[#8B7355]">store item — taxed on the TGBCL bill</span>
                                      </div>
                                    ) : (
                                      <select value={it.gst_rate}
                                              onChange={e => {
                                                const v = e.target.value;
                                                // Dropping back to Manual freezes the last derived
                                                // figures into the boxes ONCE, so they don't blank
                                                // out under the clerk mid-edit.
                                                if (v === '' && tx.derived) updateLine(i, { gst_rate: '', cgst: String(tx.cgst), sgst: String(tx.sgst) });
                                                else updateLine(i, { gst_rate: v });
                                              }}
                                              title="Seeded from the material master (raw_materials.tax_percent). Change it for a line the vendor billed at a different rate; Manual lets you type the ₹ yourself."
                                              className="px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs bg-white text-[#2D1B0E] normal-case">
                                        <option value="">Manual (enter ₹)</option>
                                        {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                                      </select>
                                    )}
                                  </label>
                                )}
                                <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-wide text-[#8B7355]">
                                  {label}
                                  <input type="number" step="any"
                                         readOnly={isTaxBox && tx.derived}
                                         value={isTaxBox && tx.derived
                                           ? (k === 'cgst' ? tx.cgst : tx.sgst).toFixed(2)
                                           : (it as any)[k]}
                                         onChange={e => updateLine(i, { [k]: e.target.value })}
                                         placeholder="0"
                                         className={`px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs text-[#2D1B0E] normal-case ${
                                           isTaxBox && tx.derived ? 'bg-[#F3EEE7] cursor-not-allowed' : 'bg-white'}`} />
                                  {isTaxBox && tx.derived && (
                                    <span className="text-[8px] text-[#8B7355] normal-case">derived from GST %</span>
                                  )}
                                </label>
                                </Fragment>
                              ); })}
                            </div>
                            <div className="flex flex-wrap justify-end gap-4 mt-2 text-[11px] text-[#6B5744]">
                              <span>Subtotal <b className="text-[#2D1B0E] font-mono">₹{lineSubtotal(it).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b></span>
                              {lineTax(it).derived && (
                                // Named explicitly because it is NOT the Subtotal beside it:
                                // tax rides on the ACCEPTED qty (what PO Receive books), so on a
                                // partially-rejected line the two figures legitimately differ.
                                <span title="GST is charged on the accepted quantity, after discount — the same base the PO → Receive path uses.">
                                  Taxable (accepted, after discount) <b className="text-[#2D1B0E] font-mono">₹{lineTax(it).taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
                                </span>
                              )}
                              <span>Total Inward <b className="text-[#af4408] font-mono">₹{lineTotal(it, lineTax(it)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</b></span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ); })}
                </tbody>
                {/* Live totals footer — recomputes on every line edit/remove
                    so the staff always sees the up-to-date GRN value. Counts
                    negative back-correction lines in the totals the same way
                    the server + print do, so the three numbers match end-to-end. */}
                {(() => {
                  const filled = items.filter(ln => ln.material_id && (parseFloat(ln.quantity_received) || 0) !== 0);
                  const totRec = items.reduce((s, ln) => s + (parseFloat(ln.quantity_received) || 0), 0);
                  const totAcc = items.reduce((s, ln) => s + (parseFloat(ln.quantity_accepted) || parseFloat(ln.quantity_received) || 0), 0);
                  const totInward = items.reduce((s, ln) => s + (ln.material_id ? lineTotal(ln, lineTax(ln)) : 0), 0);
                  const lineCount = filled.length;
                  if (lineCount === 0) return null;
                  // A qty total only exists when every filled line is in the SAME
                  // purchase unit. 12 BTL + 3 kg is not 15 of anything — print an
                  // em-dash and keep the ₹ total, which is always addable.
                  const units = new Set(filled.map(ln => lineUnits(ln.material_id).pu.toLowerCase().trim()).filter(Boolean));
                  const oneUnit = units.size === 1 ? lineUnits(filled[0].material_id).pu : null;
                  const qtyCell = (v: number) => oneUnit
                    ? <>{v.toLocaleString('en-IN', { maximumFractionDigits: 3 })} <span className="text-[9px] font-normal text-[#B8A590]">{oneUnit}</span></>
                    : <span className="text-[#B8A590]" title="Lines are in different purchase units (e.g. kg and BTL) — a single quantity total would mix units. The ₹ total is unaffected.">—</span>;
                  return (
                    <tfoot className="bg-[#FFF1E3]/60 font-semibold text-[#2D1B0E] block md:table-footer-group">
                      <tr className="block md:table-row">
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">{lineCount} line{lineCount === 1 ? '' : 's'}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{qtyCell(totRec)}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{qtyCell(totAcc)}</td>
                        <td className="py-1.5 px-2 block md:table-cell"></td>
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">Total Inward ₹</td>
                        <td className="py-1.5 px-2 text-right font-mono text-emerald-800 block md:table-cell">
                          ₹{totInward.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-1.5 px-2 block md:table-cell"></td>
                      </tr>
                    </tfoot>
                  );
                })()}
              </table>
            </div>
          </div>
          {/* Primary Add-line — full width at the BOTTOM so on mobile the button
              sits right below the material you just added (rather than off-screen
              at the top of the box). Desktop keeps the compact top button. */}
          <button type="button" onClick={addLine} className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]"><Plus className="w-4 h-4" /> Add line</button>

          <label className="flex flex-col gap-1 text-[#6B5744]">Notes
            <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
                      placeholder="Optional context — why this is ad-hoc, who approved verbally, etc."
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            <Save className="w-4 h-4" /> {busy ? 'Creating…' : 'Create GRN'}
          </button>
        </div>
      </div>
    </div>
  );
}
