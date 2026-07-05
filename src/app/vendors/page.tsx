'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Plus, Search, Edit, Trash2, Save, X, Loader2, Upload, Download } from 'lucide-react';
import { api, apiJson } from '@/lib/api';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

interface Vendor {
  id: string; name: string; contact_person: string; phone: string; email: string;
  gstin: string; address: string; payment_terms: string; lead_time_days: number;
  is_active: number; notes: string;
  po_count?: number; lifetime_spend?: number; last_received?: string;
}

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

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/vendors?stats=1').then(r => r.json());
      setList(r.vendors || []);
    } finally { setLoading(false); }
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

        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl my-8 shadow-xl">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Vendor' : 'New Vendor'}</h2>
                <button onClick={() => setEditing(null)} className="text-[#8B7355]"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
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
