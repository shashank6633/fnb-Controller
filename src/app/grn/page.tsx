'use client';

/**
 * Goods Receipt Notes (GRN) — Phase 1 §5 page.
 * Listing + drill-down detail. GRNs are auto-created on PO receive.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileCheck, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X, Save } from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0,10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };

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
  accepted_value: number;
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

  const counts = useMemo(() => {
    const c = { received: 0, partial: 0, rejected: 0, total_rejected_qty: 0, accepted_value: 0 };
    for (const g of list) {
      c[g.status] = (c[g.status] || 0) + 1;
      c.total_rejected_qty += g.total_rejected || 0;
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
        <button onClick={() => setCreating(true)}
                className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Ad-hoc GRN
        </button>
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
          <table className="w-full text-xs min-w-[880px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-1.5 px-3 font-medium">GRN #</th>
                <th className="text-left py-1.5 px-3 font-medium">Date</th>
                <th className="text-left py-1.5 px-3 font-medium">Vendor</th>
                <th className="text-left py-1.5 px-3 font-medium">Linked PO</th>
                <th className="text-right py-1.5 px-3 font-medium">Lines</th>
                <th className="text-right py-1.5 px-3 font-medium">Rejected qty</th>
                <th className="text-right py-1.5 px-3 font-medium">Accepted ₹</th>
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
        <td className="py-2 px-3 font-mono">{g.po_number ? <a href="/purchase-orders" className="text-[#af4408] hover:underline">{g.po_number}</a> : <span className="text-[#8B7355]">—</span>}</td>
        <td className="py-2 px-3 text-right font-mono">{g.line_count}</td>
        <td className="py-2 px-3 text-right font-mono text-red-700">{g.total_rejected > 0 ? Number(g.total_rejected).toLocaleString('en-IN') : <span className="text-[#8B7355]">—</span>}</td>
        <td className="py-2 px-3 text-right font-mono font-semibold">{fmt(g.accepted_value || 0)}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_TONE[g.status]}`}>{g.status}</span>
        </td>
        <td className="py-2 px-3 text-[10px] text-[#8B7355]">{g.received_by || '—'}</td>
        <td className="py-2 px-3"><a href={`/grn/print/${g.id}`} target="_blank" className="text-[10px] text-[#af4408] hover:underline">Print</a></td>
      </tr>
      {expanded && (
        <tr><td colSpan={11} className="bg-[#FFF8F0] py-3 px-4">
          {!detail ? (
            <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading line items…</div>
          ) : (
            <>
              <div className="text-xs text-[#6B5744] mb-2 space-x-3">
                {detail.invoice_number && <span><b>Invoice:</b> {detail.invoice_number}</span>}
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
              <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[640px]">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Material</th>
                    <th className="text-right py-1 px-2 font-medium">Ordered</th>
                    <th className="text-right py-1 px-2 font-medium">Received</th>
                    <th className="text-right py-1 px-2 font-medium">Accepted</th>
                    <th className="text-right py-1 px-2 font-medium">Rejected</th>
                    <th className="text-left  py-1 px-2 font-medium">Reason</th>
                    <th className="text-right py-1 px-2 font-medium">Unit ₹</th>
                    <th className="text-right py-1 px-2 font-medium">Line ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it: any) => (
                    <tr key={it.id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 px-2">{it.material_name}</td>
                      <td className="py-1 px-2 text-right font-mono">{it.quantity_ordered} {it.material_unit}</td>
                      <td className="py-1 px-2 text-right font-mono">{it.quantity_received}</td>
                      <td className="py-1 px-2 text-right font-mono text-emerald-700">{it.quantity_accepted}</td>
                      <td className="py-1 px-2 text-right font-mono text-red-700">{it.quantity_rejected || 0}</td>
                      <td className="py-1 px-2 text-[#6B5744]">{it.rejection_reason || ''}</td>
                      <td className="py-1 px-2 text-right font-mono">{fmt(it.unit_price)}</td>
                      <td className="py-1 px-2 text-right font-mono font-semibold">{fmt(it.quantity_accepted * it.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
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
  const [items, setItems] = useState<Array<{ material_id: string; quantity_received: string; quantity_accepted: string; rejection_reason: string; unit_price: string; notes: string }>>([
    { material_id: '', quantity_received: '', quantity_accepted: '', rejection_reason: '', unit_price: '', notes: '' },
  ]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

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

  const addLine = () => setItems(p => [...p, { material_id: '', quantity_received: '', quantity_accepted: '', rejection_reason: '', unit_price: '', notes: '' }]);
  const removeLine = (i: number) => setItems(p => p.filter((_, j) => j !== i));
  const updateLine = (i: number, patch: any) => setItems(p => p.map((it, j) => j === i ? { ...it, ...patch } : it));

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
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">Vendor
              <input list="adhoc-vendors" value={vendor}
                     onChange={e => {
                       const typed = e.target.value;
                       setVendor(typed);
                       const v = vendors.find(x => x.name.toLowerCase().trim() === typed.toLowerCase().trim());
                       setVendorId(v ? v.id : '');
                       // Re-enable vendor-filtered picker when vendor changes
                       setShowAllMaterials(false);
                     }}
                     placeholder="Type or pick"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
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
            <div className="bg-[#FFF1E3] px-3 py-1.5 text-[#6B5744] flex items-center justify-between rounded-t-lg">
              <span className="font-semibold">Line Items</span>
              <button onClick={addLine} className="hidden md:flex text-xs text-[#af4408] hover:underline items-center gap-1"><Plus className="w-3 h-3" /> Add line</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs block md:table md:min-w-[600px]">
                <thead className="text-[#8B7355] hidden md:table-header-group">
                  <tr>
                    <th className="text-left  py-1 px-2 font-medium">Material</th>
                    <th className="text-right py-1 px-2 font-medium">Received</th>
                    <th className="text-right py-1 px-2 font-medium">Accepted</th>
                    <th className="text-left  py-1 px-2 font-medium">Reject reason</th>
                    <th className="text-right py-1 px-2 font-medium">Unit ₹</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="block md:table-row-group">
                  {items.map((it, i) => (
                    <tr key={i} className="border-t border-[#E8D5C4]/50 align-top block md:table-row rounded-lg border border-[#E8D5C4] p-3 mb-2 space-y-2 md:p-0 md:mb-0 md:border-0 md:space-y-0">
                      <td className="py-1 px-2 block md:table-cell">
                        <span className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] block mb-0.5">Material</span>
                        <MaterialTypeahead
                          materials={filteredMaterials as any}
                          value={it.material_id}
                          onPick={(id) => updateLine(i, { material_id: id })}
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
                                                       className="w-full md:w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" /></td>
                      <td className="py-1 px-2 text-right block md:table-cell"><button onClick={() => removeLine(i)} className="text-red-500"><Trash2 className="w-3 h-3" /></button></td>
                    </tr>
                  ))}
                </tbody>
                {/* Live totals footer — recomputes on every line edit/remove
                    so the staff always sees the up-to-date GRN value. Counts
                    negative back-correction lines in the totals the same way
                    the server + print do, so the three numbers match end-to-end. */}
                {(() => {
                  const totRec = items.reduce((s, ln) => s + (parseFloat(ln.quantity_received) || 0), 0);
                  const totAcc = items.reduce((s, ln) => s + (parseFloat(ln.quantity_accepted) || parseFloat(ln.quantity_received) || 0), 0);
                  const totVal = items.reduce((s, ln) => {
                    const qa = parseFloat(ln.quantity_accepted) || parseFloat(ln.quantity_received) || 0;
                    return s + qa * (parseFloat(ln.unit_price) || 0);
                  }, 0);
                  const lineCount = items.filter(ln => ln.material_id && (parseFloat(ln.quantity_received) || 0) !== 0).length;
                  if (lineCount === 0) return null;
                  return (
                    <tfoot className="bg-[#FFF1E3]/60 font-semibold text-[#2D1B0E] block md:table-footer-group">
                      <tr className="block md:table-row">
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">{lineCount} line{lineCount === 1 ? '' : 's'}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{totRec.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                        <td className="py-1.5 px-2 text-right font-mono block md:table-cell">{totAcc.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                        <td className="py-1.5 px-2 block md:table-cell"></td>
                        <td className="py-1.5 px-2 text-right text-[10px] text-[#6B5744] block md:table-cell">Total ₹</td>
                        <td className="py-1.5 px-2 text-right font-mono text-emerald-800 block md:table-cell">
                          ₹{totVal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </td>
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
