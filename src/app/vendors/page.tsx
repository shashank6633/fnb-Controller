'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Plus, Search, Edit, Trash2, Save, X, Loader2, Upload, Download, ShieldCheck } from 'lucide-react';
import { api, apiJson } from '@/lib/api';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

interface Vendor {
  id: string; name: string; contact_person: string; phone: string; email: string;
  gstin: string; address: string; payment_terms: string; lead_time_days: number;
  is_active: number; notes: string;
  po_count?: number; lifetime_spend?: number; last_received?: string;
}

/* ── FSSAI APPROVED-VENDOR REGISTER (Hyderabad checklist: "Approved vendor list
 * maintained") ─────────────────────────────────────────────────────────────
 * GET /api/vendors?register=1 gives each vendor's approval and the supplier
 * licence filed for it under FSSAI → Documents; PATCH /api/vendors marks the
 * approval. The licence is never typed onto the vendor: it is filed (or renewed)
 * as a 'supplier_licence' document, so there is one licence record, not two.
 * Receiving WARNS on an unapproved or expired-licence vendor and never blocks. */
interface RegLicence {
  document_id: string; reference_no: string; issuer: string; valid_from: string; expiry_date: string;
  version: number; state: 'no_expiry' | 'valid' | 'expiring' | 'expired'; state_label: string;
  days_to_expiry: number | null; other_current: number;
}
interface RegRow {
  id: string; name: string; is_active: number;
  approval: '' | 'approved' | 'not_approved'; approval_label: string;
  approval_by: string; approval_at: string; approval_note: string; supplies: string;
  licence: RegLicence | null; would_warn: boolean;
}
interface RegMeta {
  counts: Record<string, number>; can_manage: boolean; licence_source: string; today: string;
  approvals: { key: string; label: string }[];
}

const approvalCls = (a: string) =>
  a === 'approved' ? 'bg-green-100 text-green-800 border-green-200'
    : a === 'not_approved' ? 'bg-red-100 text-red-700 border-red-200'
      : 'bg-gray-100 text-gray-600 border-gray-200';
const licenceCls = (s?: string) =>
  s === 'expired' ? 'bg-red-100 text-red-700 border-red-200'
    : s === 'expiring' ? 'bg-amber-100 text-amber-800 border-amber-200'
      : s === 'valid' ? 'bg-green-100 text-green-700 border-green-200'
        : 'bg-gray-100 text-gray-600 border-gray-200';

/** The approval time is stored as UTC ISO; the day is shown in IST (+5:30), the
 *  restaurant's day, so a decision at 1 a.m. is not dated the day before. */
const istDay = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10) : '';
};

const empty = (): Partial<Vendor> => ({
  name: '', contact_person: '', phone: '', email: '', gstin: '', address: '',
  payment_terms: '', lead_time_days: 0, is_active: 1, notes: '',
});

export default function VendorsPage() {
  const [list, setList] = useState<Vendor[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partial<Vendor> | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'vendors' | 'register'>('vendors');
  const [reg, setReg] = useState<Map<string, RegRow>>(new Map());
  const [regMeta, setRegMeta] = useState<RegMeta | null>(null);
  const [regErr, setRegErr] = useState<string | null>(null);
  const [approving, setApproving] = useState<RegRow | null>(null);

  // The register is fetched beside the vendor list, never instead of it: if it
  // fails, the vendor master still loads exactly as before and the failure is said.
  const loadRegister = async () => {
    try {
      const r = await fetch('/api/vendors?register=1');
      const j = await r.json();
      if (!r.ok) { setRegErr(j.error || `Could not load the approved-vendor register (HTTP ${r.status})`); return; }
      setReg(new Map((j.vendors || []).map((v: RegRow) => [v.id, v])));
      setRegMeta({ counts: j.counts || {}, can_manage: !!j.can_manage, licence_source: j.licence_source || '', today: j.today || '', approvals: j.approvals || [] });
      setRegErr(null);
    } catch (e) {
      setRegErr(e instanceof Error ? e.message : 'Could not load the approved-vendor register');
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/vendors?stats=1').then(r => r.json());
      setList(r.vendors || []);
    } finally { setLoading(false); }
    void loadRegister();
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let l = list;
    if (!showInactive) l = l.filter(v => v.is_active);
    if (search) {
      const q = search.toLowerCase();
      l = l.filter(v => v.name.toLowerCase().includes(q) ||
                        (v.contact_person || '').toLowerCase().includes(q) ||
                        (v.gstin || '').toLowerCase().includes(q));
    }
    return l;
  }, [list, search, showInactive]);

  const save = async () => {
    if (!editing?.name) { alert('Name is required'); return; }
    setSaving(true);
    try {
      const isNew = !editing.id;
      const r = await api('/api/vendors', { method: isNew ? 'POST' : 'PUT', body: editing });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      setEditing(null); load();
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Deactivate vendor? (PO history preserved)')) return;
    await api(`/api/vendors?id=${id}`, { method: 'DELETE' });
    load();
  };

  // ---- Bulk upload (Recaho vendor export + optional material mapping) ----
  const bulkRef = useRef<HTMLInputElement>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<any>(null);

  const downloadTemplate = async () => {
   try {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();

    // Sheet 1 — Vendors. Headers mirror the Recaho export so that file uploads with zero editing.
    const vHeaders = ['Vendor Name', 'Contact Person', 'Phone', 'WhatsApp Number', 'Vendor Email',
      'GST Number', 'PAN Number', 'Terms of Payment and Delivery', 'Address(Area and Street)',
      'Locality', 'City', 'State', 'Zip Code', 'Country'];
    const vSample = [{
      'Vendor Name': 'AM Dairy Products', 'Contact Person': 'Vangal', 'Phone': '9848114596',
      'WhatsApp Number': '9848114596', 'Vendor Email': 'amdairy@example.com', 'GST Number': '36ABCDE1234F1Z5',
      'PAN Number': 'ABCDE1234F', 'Terms of Payment and Delivery': 'Net 15',
      'Address(Area and Street)': 'Plot 12, Main Road', 'Locality': 'Kompally', 'City': 'Hyderabad',
      'State': 'Telangana', 'Zip Code': '500100', 'Country': 'India',
    }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vSample, { header: vHeaders }), 'Vendors');

    // Sheet 2 — Vendor Materials (optional). Repeat a material on multiple rows (one per
    // vendor) to map many vendors to one material; leave price blank if not negotiated.
    const mHeaders = ['Vendor Name', 'Material SKU or Name', 'Contract Price (optional)'];
    const mSample = [
      { 'Vendor Name': 'AM Dairy Products', 'Material SKU or Name': 'Milk (Full Cream)', 'Contract Price (optional)': 58 },
      { 'Vendor Name': 'Heritage Foods', 'Material SKU or Name': 'Milk (Full Cream)', 'Contract Price (optional)': 60 },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mSample, { header: mHeaders }), 'Vendor Materials');

    XLSX.writeFile(wb, 'vendor-bulk-template.xlsx');
   } catch (e: any) {
     setBulkResult({ error: 'Could not generate template: ' + (e?.message || 'unknown error') });
   }
  };

  const handleBulkFile = async (file: File) => {
    setBulkBusy(true); setBulkResult(null);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });

      // Normalise a header: lowercase, strip the Recaho "* required" marker, collapse spaces.
      const norm = (k: string) => String(k).toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim();
      const rowMap = (r: any) => { const m: any = {}; for (const k in r) m[norm(k)] = r[k]; return m; };
      // Pick the first candidate that resolves to a non-empty cell: exact key match first, then substring.
      const val = (m: any, ...cands: string[]) => {
        for (const c of cands) { const v = m[c]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
        for (const c of cands) { for (const k in m) { if (k.includes(c)) { const v = m[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); } } }
        return '';
      };

      const vendors: any[] = [];
      const mappings: any[] = [];

      for (const sheetName of wb.SheetNames) {
        const raw = XLSX.utils.sheet_to_json<any>(wb.Sheets[sheetName], { defval: '' });
        if (!raw.length) continue;
        const keys = Object.keys(raw[0]).map(norm);
        const hasName = keys.some(k => k === 'vendor name' || k === 'name' || k === 'vendor');
        const hasVendorSignal = keys.some(k => /contact|phone|gst|email|address|payment|whatsapp|pan|locality|zip|terms/.test(k));
        const hasMaterial = keys.some(k => /material|sku|item|ingredient/.test(k));
        const hasVendorRef = keys.some(k => k.includes('vendor'));

        if (hasMaterial && hasVendorRef) {
          // Vendor↔material mapping sheet
          for (const r of raw) {
            const m = rowMap(r);
            const vendor = val(m, 'vendor name', 'vendor');
            const material = val(m, 'material sku or name', 'material sku', 'material name', 'material', 'sku', 'item', 'ingredient');
            const price = val(m, 'contract price', 'price', 'unit price', 'rate');
            if (vendor || material) mappings.push({ vendor, material, price });
          }
        } else if (hasName && hasVendorSignal) {
          // Vendor master sheet (also swallows the Recaho "Vendor Data" sheet as-is)
          for (const r of raw) {
            const m = rowMap(r);
            const name = val(m, 'vendor name', 'name', 'vendor');
            if (!name) continue;
            const phone = val(m, 'contact number', 'phone', 'mobile number', 'mobile');
            const whatsapp = val(m, 'whatsapp number', 'whatsapp');
            const pan = val(m, 'pan number', 'pan no');
            const addrParts = [
              val(m, 'address(area and street)', 'address area and street', 'address line', 'address', 'street'),
              val(m, 'locality', 'area'),
              val(m, 'city'),
              val(m, 'state'),
              val(m, 'zip code', 'zip', 'pincode', 'pin code', 'postal code'),
              val(m, 'country'),
            ].filter(Boolean);
            // Recaho's export often repeats locality/city ("HYDERABAD, Hyderabad") — drop case-insensitive dups.
            const seenAddr = new Set<string>();
            const addr = addrParts.filter(p => { const k = p.toLowerCase(); if (seenAddr.has(k)) return false; seenAddr.add(k); return true; }).join(', ');
            const noteParts: string[] = [];
            if (whatsapp && whatsapp !== phone) noteParts.push('WhatsApp: ' + whatsapp);
            if (pan) noteParts.push('PAN: ' + pan);
            const extra = val(m, 'notes', 'remarks');
            if (extra) noteParts.push(extra);
            vendors.push({
              name,
              contact_person: val(m, 'contact person', 'contact name'),
              phone,
              email: val(m, 'vendor email', 'email address', 'email id', 'email'),
              gstin: val(m, 'gst number', 'gstin', 'gst no', 'gst'),
              address: addr,
              payment_terms: val(m, 'terms of payment and delivery', 'terms of payment', 'payment terms', 'payment term'),
              notes: noteParts.join(' · '),
            });
          }
        }
        // Any other sheet (e.g. Recaho's "State Data" reference list) is ignored.
      }

      if (!vendors.length && !mappings.length) {
        setBulkResult({ error: 'No vendor rows found. The sheet needs a "Vendor Name" column.' });
        return;
      }

      // Collapse duplicate (vendor, material) rows within one upload — last row wins so a
      // corrected price overrides an earlier one; a blank corrected price falls back to the
      // earlier non-empty price rather than silently dropping it.
      const mkey = (m: any) => (m.vendor || '').toLowerCase().replace(/\s+/g, ' ').trim() + '||' + (m.material || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const mDedup = new Map<string, any>();
      for (const m of mappings) {
        const prev = mDedup.get(mkey(m));
        const price = (m.price !== '' && m.price != null) ? m.price : (prev?.price ?? m.price);
        mDedup.set(mkey(m), { ...m, price });
      }
      const mappingsFinal = [...mDedup.values()];

      const res = await apiJson('/api/vendors/bulk', { method: 'POST', body: { vendors, mappings: mappingsFinal } });
      setBulkResult(res);
      load();
    } catch (e: any) {
      setBulkResult({ error: e.message || 'Upload failed' });
    } finally {
      setBulkBusy(false);
      if (bulkRef.current) bulkRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Building2 className="w-6 h-6" /> Vendors
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Suppliers — referenced by Purchase Orders. Lifetime spend reflects approved + received POs.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setView(view === 'register' ? 'vendors' : 'register')}
                    className={`inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm font-medium ${view === 'register' ? 'border-[#af4408] bg-[#FFF1E3] text-[#af4408]' : 'border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744]'}`}
                    title="The FSSAI approved vendor list: approval, FSSAI licence number and expiry for every supplier, as one list.">
              <ShieldCheck className="w-4 h-4" /> {view === 'register' ? 'Back to vendors' : 'Approved vendor list'}
            </button>
            <button onClick={downloadTemplate}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium"
                    title="Download the 2-sheet template (Vendors + optional Vendor Materials). The Recaho export uploads with zero editing.">
              <Download className="w-4 h-4" /> Template
            </button>
            <button onClick={() => bulkRef.current?.click()} disabled={bulkBusy}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium disabled:opacity-50"
                    title="Upload the Recaho vendor export or the filled template — creates/updates vendors and (optionally) maps them to raw materials.">
              {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {bulkBusy ? 'Uploading…' : 'Bulk upload'}
            </button>
            <input ref={bulkRef} type="file" accept=".xlsx,.xls" className="hidden"
                   onChange={e => { const f = e.target.files?.[0]; if (f) handleBulkFile(f); }} />
            <button onClick={() => setEditing(empty())}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
              <Plus className="w-4 h-4" /> New Vendor
            </button>
          </div>
        </div>

        {bulkResult && (
          <div className={`rounded-xl border px-4 py-3 text-sm ${bulkResult.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-green-200 bg-green-50 text-green-800'}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                {bulkResult.error ? (
                  <span className="font-medium">{bulkResult.error}</span>
                ) : (
                  <span className="font-medium">{bulkResult.message}</span>
                )}
                {(() => {
                  const skips = [...(bulkResult?.vendors?.skipped_rows || []), ...(bulkResult?.mappings?.skipped_rows || [])];
                  return skips.length ? (
                    <ul className="mt-1.5 text-xs text-[#8B7355] list-disc pl-5 space-y-0.5">
                      {skips.slice(0, 8).map((s: any, i: number) => (
                        <li key={i}>Row {s.row}: {s.reason}</li>
                      ))}
                      {skips.length > 8 && <li>…and {skips.length - 8} more</li>}
                    </ul>
                  ) : null;
                })()}
              </div>
              <button onClick={() => setBulkResult(null)} className="text-[#8B7355] shrink-0"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, contact, GSTIN…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          <label className="flex items-center gap-1 text-xs text-[#6B5744]">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <span className="text-xs text-[#8B7355]">{filtered.length} of {list.length}</span>
        </div>

        {regErr && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{regErr}</div>
        )}

        {view === 'register' ? (
          <RegisterView rows={filtered.map(v => reg.get(v.id)).filter((r): r is RegRow => !!r)}
                        meta={regMeta} onOpen={setApproving} />
        ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">No vendors match.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Name</th>
                    <th className="text-left  py-2 px-3 font-medium">Contact</th>
                    <th className="text-left  py-2 px-3 font-medium">GSTIN</th>
                    <th className="text-left  py-2 px-3 font-medium">Terms</th>
                    <th className="text-left  py-2 px-3 font-medium">FSSAI</th>
                    <th className="text-right py-2 px-3 font-medium">Lead</th>
                    <th className="text-right py-2 px-3 font-medium">POs</th>
                    <th className="text-right py-2 px-3 font-medium">Lifetime ₹</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(v => (
                    <tr key={v.id} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!v.is_active ? 'opacity-50' : ''}`}>
                      <td className="py-2 px-3 text-xs font-medium">{v.name}</td>
                      <td className="py-2 px-3 text-xs">
                        {v.contact_person || <span className="text-[#8B7355]">—</span>}
                        {v.phone && <div className="text-[10px] text-[#8B7355]">{v.phone}</div>}
                      </td>
                      <td className="py-2 px-3 text-xs font-mono">{v.gstin || <span className="text-[#8B7355]">—</span>}</td>
                      <td className="py-2 px-3 text-xs">{v.payment_terms || <span className="text-[#8B7355]">—</span>}</td>
                      <td className="py-2 px-3 text-xs">
                        {(() => {
                          const r = reg.get(v.id);
                          if (!r) return <span className="text-[#8B7355]">—</span>;
                          return (
                            <button onClick={() => setApproving(r)} className="flex flex-wrap gap-1 text-left" title="Approval and FSSAI licence">
                              <span className={`px-1.5 py-0.5 rounded border text-[10px] ${approvalCls(r.approval)}`}>{r.approval_label}</span>
                              {r.licence
                                ? <span className={`px-1.5 py-0.5 rounded border text-[10px] ${licenceCls(r.licence.state)}`}>Licence {r.licence.state_label.toLowerCase()}</span>
                                : <span className="px-1.5 py-0.5 rounded border text-[10px] bg-gray-50 text-gray-500 border-gray-200">No licence filed</span>}
                            </button>
                          );
                        })()}
                      </td>
                      <td className="py-2 px-3 text-xs text-right">{v.lead_time_days ? `${v.lead_time_days}d` : '—'}</td>
                      <td className="py-2 px-3 text-xs text-right font-mono">{v.po_count ?? 0}</td>
                      <td className="py-2 px-3 text-xs text-right font-mono">{fmt(v.lifetime_spend || 0)}</td>
                      <td className="py-2 px-3 text-right">
                        <button onClick={() => setEditing({ ...v })} className="p-1 text-[#6B5744] hover:text-[#af4408]" title="Edit">
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        {v.is_active ? (
                          <button onClick={() => remove(v.id)} className="p-1 text-red-500 hover:text-red-700" title="Deactivate">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

        {approving && (
          <ApprovalModal row={reg.get(approving.id) || approving} meta={regMeta}
                         onClose={() => setApproving(null)}
                         onSaved={async () => { await loadRegister(); }} />
        )}

        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            {/* House safe-modal shell: card capped to viewport, body scrolls
                internally, so header + Save/Cancel stay on screen on phones. */}
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Vendor' : 'New Vendor'}</h2>
                <button onClick={() => setEditing(null)} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name *" v={editing.name || ''} onChange={x => setEditing({ ...editing, name: x })} />
                <Field label="Contact person" v={editing.contact_person || ''} onChange={x => setEditing({ ...editing, contact_person: x })} />
                <Field label="Phone" v={editing.phone || ''} onChange={x => setEditing({ ...editing, phone: x })} />
                <Field label="Email" v={editing.email || ''} onChange={x => setEditing({ ...editing, email: x })} />
                <Field label="GSTIN" v={editing.gstin || ''} onChange={x => setEditing({ ...editing, gstin: x })} />
                <Field label="Payment terms" v={editing.payment_terms || ''} onChange={x => setEditing({ ...editing, payment_terms: x })} placeholder="e.g. Net 30" />
                <Field label="Lead time (days)" type="number" v={String(editing.lead_time_days ?? '')} onChange={x => setEditing({ ...editing, lead_time_days: Number(x) })} />
                <label className="flex items-center gap-2 text-xs text-[#6B5744] mt-5">
                  <input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })} />
                  Active
                </label>
                <div className="sm:col-span-2">
                  <label className="text-xs text-[#6B5744]">Address</label>
                  <textarea value={editing.address || ''} onChange={e => setEditing({ ...editing, address: e.target.value })} rows={2}
                            className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs text-[#6B5744]">Notes</label>
                  <textarea value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} rows={2}
                            className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
                <button onClick={save} disabled={saving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, v, onChange, placeholder, type = 'text' }: { label: string; v: string; onChange: (s: string) => void; placeholder?: string; type?: string }) {
  return (
    <div>
      <label className="text-xs text-[#6B5744]">{label}</label>
      <input type={type} value={v} onChange={e => onChange(e.target.value)} placeholder={placeholder}
             className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
    </div>
  );
}

/* ══ THE APPROVED VENDOR LIST — one list, as an inspector asks for it ═════════ */
function RegisterView({ rows, meta, onOpen }: { rows: RegRow[]; meta: RegMeta | null; onOpen: (r: RegRow) => void }) {
  const c = meta?.counts || {};
  const download = async () => {
    try {
      const XLSX = await import('xlsx');
      const data = rows.map(r => ({
        'Vendor': r.name,
        'Approval': r.approval_label,
        'Approved to supply': r.supplies,
        'FSSAI licence no.': r.licence?.reference_no || '',
        'Licence expiry': r.licence?.expiry_date || '',
        'Licence state': r.licence ? r.licence.state_label : 'No licence filed',
        'Decided by': r.approval_by,
        'Decided on': istDay(r.approval_at),
        'Note': r.approval_note,
        'Active vendor': r.is_active ? 'Yes' : 'No',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Approved vendor list');
      XLSX.writeFile(wb, `approved-vendor-list-${meta?.today || 'today'}.xlsx`);
    } catch (e) {
      alert('Could not build the download: ' + (e instanceof Error ? e.message : 'unknown error'));
    }
  };
  return (
    <div className="space-y-3">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#af4408]" />
          <h2 className="text-sm font-bold text-[#2D1B0E]">Approved vendor list</h2>
          <button onClick={download} className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium">
            <Download className="w-3.5 h-3.5" /> Download list
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="px-2 py-0.5 rounded border bg-green-50 border-green-200 text-green-800">{c.approved ?? 0} approved</span>
          <span className="px-2 py-0.5 rounded border bg-red-50 border-red-200 text-red-700">{c.not_approved ?? 0} not approved</span>
          <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 text-gray-600">{c.not_reviewed ?? 0} not reviewed yet</span>
          <span className="px-2 py-0.5 rounded border bg-red-50 border-red-200 text-red-700">{c.licence_expired ?? 0} licence expired</span>
          <span className="px-2 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-800">{c.licence_expiring ?? 0} expiring soon</span>
          <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 text-gray-600">{c.no_licence ?? 0} no licence filed</span>
        </div>
        <p className="text-[11px] text-[#8B7355]">
          Counts are over active vendors. Receiving shows a warning — and still lets the delivery be recorded — when a
          supplier is marked not approved or its licence has expired. {meta?.licence_source}
        </p>
      </div>
      <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-x-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-[#8B7355] text-sm">No vendors match.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
              <tr>
                <th className="text-left py-2 px-3 font-medium">Vendor</th>
                <th className="text-left py-2 px-3 font-medium">Approval</th>
                <th className="text-left py-2 px-3 font-medium">Approved to supply</th>
                <th className="text-left py-2 px-3 font-medium">FSSAI licence no.</th>
                <th className="text-left py-2 px-3 font-medium">Expiry</th>
                <th className="text-left py-2 px-3 font-medium">Decided</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => onOpen(r)}
                    className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 cursor-pointer ${!r.is_active ? 'opacity-50' : ''}`}>
                  <td className="py-2 px-3 text-xs font-medium">
                    {r.name}
                    {r.would_warn && <div className="text-[10px] text-amber-800">Receiving will warn</div>}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${approvalCls(r.approval)}`}>{r.approval_label}</span>
                    {r.approval_note && <div className="text-[10px] text-[#8B7355] mt-0.5">{r.approval_note}</div>}
                  </td>
                  <td className="py-2 px-3 text-xs">{r.supplies || <span className="text-[#8B7355]">—</span>}</td>
                  <td className="py-2 px-3 text-xs font-mono">{r.licence?.reference_no || <span className="text-[#8B7355] font-sans">{r.licence ? '(number not recorded)' : 'No licence filed'}</span>}</td>
                  <td className="py-2 px-3 text-xs">
                    {r.licence ? (
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] ${licenceCls(r.licence.state)}`}>
                        {r.licence.expiry_date || 'no date'} · {r.licence.state_label}
                      </span>
                    ) : <span className="text-[#8B7355]">—</span>}
                  </td>
                  <td className="py-2 px-3 text-[10px] text-[#8B7355]">
                    {r.approval_by ? `${r.approval_by}${r.approval_at ? ` · ${istDay(r.approval_at)}` : ''}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ══ ONE VENDOR — approve, say what they supply, file or renew the licence ════ */
function ApprovalModal({ row, meta, onClose, onSaved }: {
  row: RegRow; meta: RegMeta | null; onClose: () => void; onSaved: () => Promise<void> | void;
}) {
  const canManage = !!meta?.can_manage;
  const [approval, setApproval] = useState<string>(row.approval);
  const [supplies, setSupplies] = useState(row.supplies);
  const [note, setNote] = useState(row.approval_note);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [licNo, setLicNo] = useState('');
  const [licExpiry, setLicExpiry] = useState('');
  const [licIssuer, setLicIssuer] = useState('');
  const lic = row.licence;

  const saveApproval = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/vendors', { method: 'PATCH', body: { id: row.id, approval, supplies, note } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: j.error || `Could not save (HTTP ${r.status})` }); return; }
      setMsg({ ok: true, text: j.unchanged ? 'Nothing changed.' : 'Saved.' });
      await onSaved();
    } finally { setBusy(false); }
  };

  // Files the licence where the FSSAI module keeps it: a 'supplier_licence'
  // document for this vendor. A renewal supersedes the current one (the old row
  // is kept, never deleted) — the documents route owns those rules.
  const saveLicence = async () => {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, string | undefined> = lic
        ? { action: 'renew', id: lic.document_id, reference_no: licNo.trim(), expiry_date: licExpiry, issuer: licIssuer.trim() || undefined }
        : { action: 'create', doc_type: 'supplier_licence', title: `FSSAI licence — ${row.name}`.slice(0, 300),
            vendor_id: row.id, reference_no: licNo.trim(), expiry_date: licExpiry, issuer: licIssuer.trim() };
      const r = await api('/api/fssai/documents', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: j.error || `Could not file the licence (HTTP ${r.status})` }); return; }
      setMsg({ ok: true, text: lic ? 'Renewal filed. The earlier licence is kept in the document history.' : 'Licence filed under FSSAI → Documents.' });
      setLicNo(''); setLicExpiry(''); setLicIssuer('');
      await onSaved();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-[#af4408]" /> {row.name}</h2>
          <button onClick={onClose} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {!canManage && (
            <p className="text-xs rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-[#6B5744]">
              Approving a vendor and filing its licence are management decisions. You can see the record here.
            </p>
          )}
          <div>
            <p className="text-xs font-semibold text-[#6B5744] mb-1">Approved vendor?</p>
            <div className="flex flex-wrap gap-2">
              {(meta?.approvals || []).map(a => (
                <label key={a.key || 'none'} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs ${approval === a.key ? approvalCls(a.key) : 'border-[#E8D5C4] text-[#6B5744]'}`}>
                  <input type="radio" disabled={!canManage} checked={approval === a.key} onChange={() => setApproval(a.key)} /> {a.label}
                </label>
              ))}
            </div>
            {row.approval_by && (
              <p className="text-[11px] text-[#8B7355] mt-1">Last decided by {row.approval_by}{row.approval_at ? ` on ${istDay(row.approval_at)}` : ''}.</p>
            )}
          </div>
          <Field label="Approved to supply" v={supplies} onChange={setSupplies} placeholder="e.g. Dairy, paneer, curd" />
          <div>
            <label className="text-xs text-[#6B5744]">Note {approval === 'not_approved' ? '(required — why not approved)' : ''}</label>
            <textarea disabled={!canManage} value={note} onChange={e => setNote(e.target.value)} rows={2}
                      className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          {canManage && (
            <div className="flex justify-end">
              <button onClick={saveApproval} disabled={busy}
                      className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save approval
              </button>
            </div>
          )}

          <div className="border-t border-[#E8D5C4] pt-4 space-y-2">
            <p className="text-xs font-semibold text-[#6B5744]">Vendor&apos;s FSSAI licence</p>
            {lic ? (
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-xs space-y-0.5">
                <div><span className="text-[#8B7355]">Number:</span> <span className="font-mono">{lic.reference_no || '(not recorded)'}</span></div>
                <div>
                  <span className="text-[#8B7355]">Expiry:</span> {lic.expiry_date || '(no date recorded)'}{' '}
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${licenceCls(lic.state)}`}>{lic.state_label}</span>
                </div>
                {lic.issuer && <div><span className="text-[#8B7355]">Issued by:</span> {lic.issuer}</div>}
                {lic.other_current > 0 && <div className="text-amber-800">{lic.other_current} more current supplier licence{lic.other_current === 1 ? '' : 's'} on file for this vendor — the latest expiry is shown.</div>}
              </div>
            ) : (
              <p className="text-xs text-[#8B7355]">No supplier licence is filed for this vendor.</p>
            )}
            {canManage && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Field label={lic ? 'New licence no.' : 'Licence no.'} v={licNo} onChange={setLicNo} placeholder="14-digit FSSAI no." />
                <Field label={lic ? 'New expiry' : 'Expiry'} type="date" v={licExpiry} onChange={setLicExpiry} />
                <Field label="Issued by (optional)" v={licIssuer} onChange={setLicIssuer} placeholder="FSSAI / state" />
                <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2">
                  <a href="/fssai/documents" className="text-[11px] text-[#af4408] underline">Correct a typo or add the scan in FSSAI → Documents</a>
                  <button onClick={saveLicence} disabled={busy || !licExpiry}
                          className="px-3 py-1.5 text-xs border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg disabled:opacity-50">
                    {lic ? 'File the renewal' : 'File the licence'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {msg && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{msg.text}</div>
          )}
        </div>
      </div>
    </div>
  );
}
