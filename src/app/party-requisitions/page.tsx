'use client';

/**
 * Party Requisitions — banquet/event-mode requisitions.
 * Same workflow + schema as /requisitions, just tagged with purpose='party'
 * and carrying event metadata (event_name, event_date, guest_count, customer).
 *
 * The cost of issued items × material avg_price is the food cost for the event.
 * Aggregated per-event P&L lives at /party-events.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  PartyPopper, Plus, Loader2, Calendar, Users as UsersIcon, Trash2, Save, X,
  ChevronDown, ChevronRight,
  Search, Upload, Lock, ChefHat,
} from 'lucide-react';
import { api } from '@/lib/api';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const today = () => new Date().toISOString().slice(0, 10);

interface Material {
  id: string; name: string; sku?: string; category?: string;
  /** Recipe unit (kg / g / L / ml / pcs) — canonical consume unit on raw_materials. */
  unit?: string;
  /** Purchase unit (kg / BTL / PKT / TIN / CASE / etc.) — how vendor invoices it. */
  purchase_unit?: string;
  /** Recipe-units in one purchase-unit (e.g. 750 ml in 1 BTL). */
  pack_size?: number;
  current_stock?: number; reorder_level?: number; average_price?: number;
}
interface Department { id: string; name: string; code?: string; }
interface Requisition {
  id: string; req_number: string; date: string; status: string;
  department_name: string; department_code?: string;
  drafted_by?: string; notes?: string;
  estimated_value?: number; item_count?: number;
  event_name?: string; event_date?: string; guest_count?: number;
  customer?: string; event_notes?: string;
  /** Used to look up the live contact_person from the upcoming-parties cache
   *  so OLD requisitions (saved before the contact_person-first priority fix)
   *  still pick up Column P on display. */
  fp_id?: string; party_unique_id?: string;
}

interface ParsedFP {
  fp_number?: string;
  /** Sheet party id — carried so a raised requisition can be matched back to
   *  the live upcoming-parties cache (Customer Name / Column P refresh). */
  party_unique_id?: string;
  event_name?: string;
  event_date?: string;
  event_time?: string;
  guest_count: number;
  guest_name?: string;
  guest_phone?: string;
  guest_company?: string;
  package_name?: string;
  rate_per_head?: number;
  est_bill?: number;
  reference?: string;
  menu?: any;
  bar?: any;
}
interface MaterialEstimate {
  material_id: string;
  material_name: string;
  unit: string;
  quantity: number;
  reasoning: string;
  source: 'recipe' | 'per-head-default' | 'bar-standard';
  confidence: 'high' | 'medium' | 'low';
}
interface FpPrefill {
  parsed?: ParsedFP;
  materials?: MaterialEstimate[];
  warnings?: string[];
}

const STATUS_TONE: Record<string, string> = {
  draft:           'bg-[#FFF1E3] text-[#6B5744]',
  submitted:       'bg-blue-100 text-blue-800',
  chef_approved:   'bg-purple-100 text-purple-800',
  mgmt_approved:   'bg-amber-100 text-amber-800',
  store_processed: 'bg-emerald-100 text-emerald-800',
  fulfilled:       'bg-emerald-200 text-emerald-900',
  chef_rejected:   'bg-red-100 text-red-700',
};

export default function PartyRequisitionsPage() {
  const [list, setList]     = useState<Requisition[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  const [fpParsing, setFpParsing] = useState(false);
  const [fpError, setFpError] = useState<string | null>(null);
  const [fpPrefill, setFpPrefill] = useState<FpPrefill | null>(null);
  // Live sheet cache — keyed by (event_date + lowercased company) → contact_person.
  // Lets the table pull the current Column P value for OLD requisitions that
  // were saved before the contact_person-first priority fix (their event_name
  // still equals the company name). Refreshed once on mount.
  const [contactByKey, setContactByKey] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetch('/api/upcoming-parties').then(r => r.json()).then(d => {
      const map = new Map<string, string>();
      for (const p of (d?.parties || [])) {
        const cp = (p.contact_person || '').trim();
        if (!cp) continue;
        const co = (p.company || '').trim().toLowerCase();
        const dt = (p.date_of_event || '').trim();
        // Key by date+company AND by fp_id AND by party_unique_id so any lookup hits.
        if (co && dt) map.set(`co:${co}|${dt}`, cp);
        if (p.fp_id) map.set(`fp:${p.fp_id}`, cp);
        if (p.party_unique_id) map.set(`uid:${p.party_unique_id}`, cp);
      }
      setContactByKey(map);
    }).catch(() => {});
  }, []);
  // EDIT mode — when the user clicks ✏️ on a draft row, we fetch the full
  // req (with items) and hand it to the modal as `editingReq`.
  const [editingReq, setEditingReq] = useState<any>(null);
  const [loadingEdit, setLoadingEdit] = useState<string | null>(null);
  // Inline expand state — clicking a Req # toggles a detail row underneath
  // showing items (instead of navigating away to /requisitions). One-time
  // fetch per req; results cached so re-expand is instant.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detailsById, setDetailsById] = useState<Record<string, any>>({});
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());

  const toggleExpand = async (reqId: string) => {
    const isOpen = expanded.has(reqId);
    setExpanded(prev => { const n = new Set(prev); isOpen ? n.delete(reqId) : n.add(reqId); return n; });
    if (!isOpen && !detailsById[reqId]) {
      setDetailLoading(prev => new Set(prev).add(reqId));
      try {
        const r = await fetch(`/api/requisitions?id=${encodeURIComponent(reqId)}`);
        const j = await r.json();
        if (j.requisition) setDetailsById(prev => ({ ...prev, [reqId]: j.requisition }));
      } finally {
        setDetailLoading(prev => { const n = new Set(prev); n.delete(reqId); return n; });
      }
    }
  };

  /** Strip phone numbers AND any orphaned separators from a legacy `customer`
   *  value. Older reqs saved the field as "Name · Phone · Company" or variants
   *  ("9866158003 · Synchrony", " · Synchrony", "Synchrony / 9866158003", etc.).
   *  New reqs only carry the company name. Runs the cleanup in a loop until the
   *  string is stable — that guarantees no stray "· " or " ·" sneaks through
   *  even when the input has unusual whitespace + separator combinations. */
  const cleanCustomer = (s?: string) => {
    if (!s) return '';
    let prev = '';
    let cur = s;
    // Iterate until idempotent. Each pass: strip phones, then prune leading /
    // trailing separator+whitespace combos, then collapse internal duplicates.
    while (cur !== prev) {
      prev = cur;
      cur = cur
        // 1. Phone-shaped digit runs (with optional country code)
        .replace(/\+?\d[\d\s-]{6,}/g, '')
        // 2. Any number of leading separators + whitespace
        .replace(/^[\s·•∙,/|\\-]+/, '')
        // 3. Any number of trailing separators + whitespace
        .replace(/[\s·•∙,/|\\-]+$/, '')
        // 4. Collapse consecutive separators internally to one
        .replace(/(\s*[·•∙,/|]\s*){2,}/g, ' · ')
        // 5. Collapse multi-whitespace
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    return cur;
  };
  const [me, setMe] = useState<{ role?: string; email?: string } | null>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);

  const startEditDraft = async (reqId: string) => {
    setLoadingEdit(reqId);
    try {
      const r = await fetch(`/api/requisitions?id=${encodeURIComponent(reqId)}`);
      const j = await r.json();
      if (!r.ok || !j.requisition) { alert(j.error || 'Failed to load draft'); return; }
      setEditingReq(j.requisition);
      setShowNew(true);
    } finally { setLoadingEdit(null); }
  };

  const deleteDraft = async (reqId: string, reqNumber: string) => {
    if (!confirm(`Delete draft ${reqNumber}? This cannot be undone.`)) return;
    const r = await api(`/api/requisitions?id=${encodeURIComponent(reqId)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || 'Delete failed'); return; }
    reload();
  };

  const handleFpUpload = async (file?: File) => {
    if (!file) return;
    setFpParsing(true); setFpError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      const r = await api('/api/party-requisitions/parse-fp', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setFpError(j.error || `Parse failed (HTTP ${r.status})`); return; }
      setFpPrefill(j);
      setShowNew(true);
    } catch (err: any) {
      setFpError(err?.message || 'Failed to parse FP');
    } finally { setFpParsing(false); }
  };

  const reload = async () => {
    setLoading(true);
    const d = await fetch('/api/requisitions?purpose=party').then(r => r.json());
    setList(d.requisitions || []);
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(d => setMaterials((d.materials || d || [])));
    fetch('/api/departments').then(r => r.json()).then(d => setDepartments((d.departments || d || [])));
  }, []);

  // Pre-fill the modal from /party-events "Raise Req". Reads payload from
  // sessionStorage (set by stashAndRaiseReq) — switched from URL-only because
  // the full menu / customer / bar-notes payload exceeded URL-length limits
  // and caused "This page couldn't load" navigation errors in Safari.
  //
  // Legacy URL params still honored as a fallback for bookmarked links.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const qs = new URLSearchParams(window.location.search);
    let payload: Record<string, string> | null = null;

    // Primary path: sessionStorage with marker ?prefill=1
    if (qs.get('prefill') === '1') {
      try {
        const raw = sessionStorage.getItem('__party_req_prefill__');
        if (raw) {
          payload = JSON.parse(raw);
          sessionStorage.removeItem('__party_req_prefill__'); // one-shot
        }
      } catch { /* malformed — fall through */ }
    }
    // Legacy URL-params fallback
    if (!payload && qs.get('from') === 'fp-records') {
      payload = Object.fromEntries(qs.entries());
    }
    if (!payload) return;

    const get = (k: string) => (payload as any)[k] || '';
    const guestCount = Number(get('guest_count') || '0') || 0;
    setFpPrefill({
      parsed: {
        fp_number:        get('fp_id') || undefined,
        party_unique_id:  get('party_unique_id') || undefined,
        event_name:  get('event_name') || undefined,
        event_date:  get('event_date') || undefined,
        guest_count: guestCount,
        // Prefer the explicit keys from the new stash payload. Fall back to the
        // legacy `customer` string (positional `name · company`) only if those
        // are missing — handles already-stashed payloads from before the change.
        // Phone is intentionally not carried at any point.
        guest_name:    get('guest_name')    || get('customer').split(' · ')[0] || undefined,
        guest_company: get('guest_company') || get('customer').split(' · ')[1] || undefined,
        menu: {
          veg_starters:    get('veg_starters').split(',').map((s: string) => s.trim()).filter(Boolean),
          nonveg_starters: get('nonveg_starters').split(',').map((s: string) => s.trim()).filter(Boolean),
          veg_mains:       get('veg_mains').split(',').map((s: string) => s.trim()).filter(Boolean),
          nonveg_mains:    get('nonveg_mains').split(',').map((s: string) => s.trim()).filter(Boolean),
          rice:            get('rice').split(',').map((s: string) => s.trim()).filter(Boolean),
          dal:             get('dal').split(',').map((s: string) => s.trim()).filter(Boolean),
          salad:           get('salad').split(',').map((s: string) => s.trim()).filter(Boolean),
          desserts:        get('desserts').split(',').map((s: string) => s.trim()).filter(Boolean),
          accompaniments:  get('accompaniments').split(',').map((s: string) => s.trim()).filter(Boolean),
          bar_notes_raw:   get('bar_notes'),
        },
        bar: { brands: [], cocktail_count: 0, mocktail_count: 0, has_aerated: false, serving_hours: 2.5 },
      },
      materials: [],
      warnings: ['Pre-filled from AKAN Party Manager sheet. Review menu above and add materials manually (no recipe-based estimate available for sheet data).'],
    });
    setShowNew(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(r =>
      (r.event_name || '').toLowerCase().includes(q) ||
      (r.customer || '').toLowerCase().includes(q) ||
      (r.req_number || '').toLowerCase().includes(q)
    );
  }, [list, search]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <PartyPopper className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party Requisitions</h1>
          <p className="text-xs text-[#8B7355]">
            Bulk material requests for banquet events. Cost = (issued qty × material price). Per-event P&amp;L on{' '}
            <a href="/party-events" className="text-[#af4408] underline">Party Events</a>.
          </p>
        </div>
        {/* "Upload FP (PDF)" and "+ New Party Requisition" buttons removed —
            parties are pulled live from the AKAN Party Manager Google sheet
            and a per-row "Raise Req" button on /party-events stashes the
            prefill and opens the modal here. No manual entry point needed. */}
        <a href="/party-events"
           className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-sm">
          <PartyPopper size={14} /> Go to Party Events
        </a>
      </div>

      {fpError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs flex items-center justify-between">
          <span>{fpError}</span>
          <button onClick={() => setFpError(null)} className="text-red-700 hover:text-red-900"><X size={12} /></button>
        </div>
      )}

      {/* Search */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex items-center gap-2">
        <Search size={14} className="text-[#8B7355]" />
        <input value={search} onChange={e => setSearch(e.target.value)}
               placeholder="Search by event name, customer or req #…"
               className="flex-1 px-2 py-1 text-sm bg-transparent focus:outline-none" />
        <span className="text-xs text-[#8B7355]">{filtered.length} of {list.length}</span>
      </div>

      {/* List */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            {list.length === 0
              ? 'No party requisitions yet. Open the Party Events page and click "Raise Req" on a party to create one.'
              : `No requisitions match "${search}".`}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left  py-2 px-3 font-medium w-6"></th>
                <th className="text-left  py-2 px-3 font-medium">Req #</th>
                <th className="text-left  py-2 px-3 font-medium" title="Customer / host name for the party (from AKAN Party Manager > Host Name)">Customer Name</th>
                <th className="text-left  py-2 px-3 font-medium" title="Sponsoring company (from AKAN Party Manager > Company). Phone numbers are stripped from display.">Company Name</th>
                <th className="text-left  py-2 px-3 font-medium">Date</th>
                <th className="text-right py-2 px-3 font-medium">Guests</th>
                <th className="text-left  py-2 px-3 font-medium">Department</th>
                <th className="text-right py-2 px-3 font-medium">Items</th>
                <th className="text-right py-2 px-3 font-medium">Est. cost</th>
                <th className="text-left  py-2 px-3 font-medium">Status</th>
                <th className="text-right py-2 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                // Draft edit/delete: drafter OR admin. Server enforces too;
                // we just hide the buttons for users who would get 403.
                const canEditDraft = r.status === 'draft'
                  && (me?.role === 'admin' || (me?.email && r.drafted_by === me.email));
                const isOpen = expanded.has(r.id);
                const detail = detailsById[r.id];
                const isLoadingDetail = detailLoading.has(r.id);
                return (
                <Fragment key={r.id}>
                <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                  <td className="py-1.5 px-2 align-middle">
                    <button onClick={() => toggleExpand(r.id)}
                            title={isOpen ? 'Hide items' : 'View items inline'}
                            className="text-[#8B7355] hover:text-[#af4408]">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="py-1.5 px-3 font-mono text-[#af4408]">
                    {/* Click the Req # to expand inline — no navigation away.
                        Use a button so it never feels like a link. */}
                    <button onClick={() => toggleExpand(r.id)}
                            className="hover:underline">
                      {r.req_number}
                    </button>
                  </td>
                  {/* Customer Name resolution priority:
                      1. Live Column P from upcoming_parties cache (looked up by
                         fp_id, party_unique_id, or event_date+company) — this
                         picks up Column P for OLD requisitions saved before the
                         contact_person-first fix.
                      2. Stored event_name on the requisition (newer reqs).
                      3. "(same as company)" placeholder when both equal the company.
                      4. "—" when nothing is available. */}
                  {(() => {
                    const company  = cleanCustomer(r.customer);
                    const stored   = (r.event_name || '').trim();
                    const lookups  = [
                      r.fp_id            ? `fp:${r.fp_id}`                                : '',
                      r.party_unique_id  ? `uid:${r.party_unique_id}`                     : '',
                      (company && r.event_date) ? `co:${company.toLowerCase()}|${r.event_date}` : '',
                    ].filter(Boolean);
                    const liveContact = lookups.map(k => contactByKey.get(k)).find(v => v && v.trim()) || '';
                    const customer = liveContact || stored;
                    const sameAsCo = customer && company && customer.toLowerCase() === company.toLowerCase();
                    return (
                      <>
                        <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">
                          {sameAsCo
                            ? <span className="text-[#C0A98F] italic" title={`No separate contact person on the AKAN Party Manager sheet — Column P (Contact Person) is blank or equals the Company in Column N (${company}).`}>— (same as company)</span>
                            : (customer || '—')}
                          {liveContact && liveContact !== stored && (
                            <span title="Pulled live from the sheet's Column P (Contact Person). The saved value on this requisition was different." className="ml-1 text-[9px] text-[#8B7355]">↻</span>
                          )}
                        </td>
                        <td className="py-1.5 px-3 text-[#6B5744]">{company || '—'}</td>
                      </>
                    );
                  })()}
                  <td className="py-1.5 px-3 text-[#6B5744]">{r.event_date || r.date}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{r.guest_count || '—'}</td>
                  <td className="py-1.5 px-3 text-[#6B5744]">{r.department_name}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{r.item_count || 0}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(r.estimated_value || 0)}</td>
                  <td className="py-1.5 px-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_TONE[r.status] || 'bg-gray-100 text-gray-700'}`}>
                      {r.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    {canEditDraft ? (
                      <div className="inline-flex items-center gap-2">
                        <button onClick={() => startEditDraft(r.id)} disabled={loadingEdit === r.id}
                                title="Resume editing this draft"
                                className="text-[11px] text-[#af4408] hover:underline disabled:opacity-50">
                          {loadingEdit === r.id ? 'loading…' : '✏️ Edit'}
                        </button>
                        <button onClick={() => deleteDraft(r.id, r.req_number)}
                                title="Delete this draft permanently"
                                className="text-[11px] text-red-600 hover:underline">
                          🗑 Delete
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-[#C0A98F]">—</span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-[#FFF8F0] border-t border-[#E8D5C4]/30">
                    <td colSpan={11} className="py-3 px-6">
                      {isLoadingDetail || !detail ? (
                        <div className="text-[11px] text-[#8B7355]">
                          <Loader2 size={11} className="inline animate-spin mr-1" /> Loading items…
                        </div>
                      ) : (detail.items || []).length === 0 ? (
                        <div className="text-[11px] text-[#8B7355] italic">No items on this requisition.</div>
                      ) : (
                        <div className="space-y-2">
                          {detail.event_notes && (
                            <div className="text-[10px] text-[#6B5744] italic">Notes: {detail.event_notes}</div>
                          )}
                          <table className="w-full text-[11px]">
                            <thead className="text-[#8B7355]">
                              <tr>
                                <th className="text-left  py-1 px-2 font-medium">SKU</th>
                                <th className="text-left  py-1 px-2 font-medium">Material</th>
                                <th className="text-right py-1 px-2 font-medium">Requested</th>
                                <th className="text-right py-1 px-2 font-medium">Chef OK</th>
                                <th className="text-right py-1 px-2 font-medium">Issued</th>
                                <th className="text-left  py-1 px-2 font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(detail.items || []).map((it: any) => {
                                const rejected = !!it.is_rejected;
                                const rowCls = rejected ? 'opacity-50 line-through bg-red-50/30' : '';
                                return (
                                  <tr key={it.id} className={`border-t border-[#E8D5C4]/40 ${rowCls}`}>
                                    <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                                    <td className="py-1 px-2 font-medium text-[#2D1B0E]">
                                      {it.material_name}
                                      {it.chef_note && <div className="text-[9px] text-amber-700 no-underline">Chef: {it.chef_note}</div>}
                                    </td>
                                    <td className="py-1 px-2 text-right font-mono">{Number(it.quantity_requested).toLocaleString('en-IN')} {it.material_unit || it.unit}</td>
                                    <td className="py-1 px-2 text-right font-mono">
                                      {rejected
                                        ? <span className="text-red-700 no-underline">—</span>
                                        : it.chef_approved_qty != null
                                          ? <span className="text-amber-700">{Number(it.chef_approved_qty).toLocaleString('en-IN')}</span>
                                          : <span className="text-[#C0A98F]">—</span>}
                                    </td>
                                    <td className="py-1 px-2 text-right font-mono text-emerald-700">
                                      {rejected ? '—' : (Number(it.quantity_issued) || 0).toLocaleString('en-IN')}
                                    </td>
                                    <td className="py-1 px-2 no-underline">
                                      {rejected
                                        ? <span className="text-[10px] px-1 rounded bg-red-100 text-red-700">Rejected</span>
                                        : it.chef_approved_qty != null
                                          ? <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-800">Qty edited</span>
                                          : <span className="text-[10px] text-[#C0A98F]">—</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewPartyReqModal
          editingReq={editingReq}
          materials={materials}
          departments={departments}
          prefill={fpPrefill}
          onClose={() => { setShowNew(false); setFpPrefill(null); setEditingReq(null); }}
          onSaved={() => { setShowNew(false); setFpPrefill(null); setEditingReq(null); reload(); }}
        />
      )}
    </div>
  );
}

type LineItem = {
  material_id: string;
  qty: string;
  /** Unit the staff entered the qty in. Must be one of the material's registered
   *  units (recipe_unit or purchase_unit). Defaults to recipe_unit on pick. */
  unit?: string;
  notes: string;
  department_id: string;
  confidence?: 'high' | 'medium' | 'low';
};

/** The set of units a material allows for requisition entry — purchase_unit
 *  and recipe_unit (deduped). e.g. for "Mutton" with recipe_unit=kg, purchase_unit=kg
 *  → ['kg']. For "100 Pipers (750ml)" with recipe_unit=ml, purchase_unit=BTL → ['ml','BTL'].
 *  Anything outside this list is intentionally rejected so staff can't request in
 *  units the material isn't configured for (no "5 PKT of mutton" mistakes). */
function allowedUnitsForMaterial(m: Material | undefined): string[] {
  if (!m) return [];
  const u = (m.unit || '').trim();
  const pu = (m.purchase_unit || '').trim();
  const out: string[] = [];
  if (pu) out.push(pu);
  if (u && u !== pu) out.push(u);
  return out;
}

function NewPartyReqModal({ materials, departments, prefill, editingReq, onClose, onSaved }: {
  materials: Material[];
  departments: Department[];
  prefill?: FpPrefill | null;
  /** When set, the modal opens in EDIT mode — fields are pre-loaded from this
   *  existing draft requisition and the save uses PUT instead of POST. */
  editingReq?: {
    id: string; req_number: string;
    event_name?: string; event_date?: string; guest_count?: number;
    customer?: string; notes?: string; department_id?: string;
    items: Array<{ id?: string; material_id: string; quantity_requested: number;
                   unit?: string; notes?: string; department_id?: string }>;
  } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEditMode = !!editingReq;
  // Compute prefill-driven initial state once at mount.
  const initial = useMemo(() => {
    // EDIT mode wins over FP prefill — we're resuming an existing draft.
    if (editingReq) {
      const items: LineItem[] = (editingReq.items || []).map(it => {
        const mat = materials.find(x => x.id === it.material_id);
        return {
          material_id: it.material_id,
          qty: String(it.quantity_requested ?? ''),
          unit: (it.unit || mat?.unit || '').trim() || undefined,
          notes: it.notes || '',
          department_id: it.department_id || '',
        };
      });
      // Always append one empty line so the user can add more without clicking.
      const lastDept = [...items].reverse().find(it => it.department_id)?.department_id || '';
      items.push({ material_id: '', qty: '', unit: '', notes: '', department_id: lastDept });
      return {
        eventName:   editingReq.event_name || '',
        eventDate:   editingReq.event_date || today(),
        guestCount:  editingReq.guest_count ? String(editingReq.guest_count) : '',
        customer:    editingReq.customer || '',
        eventNotes:  editingReq.notes || '',
        items,
        warnings: [] as string[],
      };
    }

    const p = prefill?.parsed;
    const mats = prefill?.materials || [];
    const warnings: string[] = [...(prefill?.warnings || [])];

    if (!p && mats.length === 0) {
      return {
        eventName: '', eventDate: today(), guestCount: '', customer: '',
        eventNotes: '', items: [{ material_id: '', qty: '', unit: '', notes: '', department_id: '' }] as LineItem[],
        warnings,
      };
    }

    // "Event Host Name" — strictly the host (guest_name on the FP). We
    // intentionally do NOT fall back to event_name here, because for some FPs
    // the sheet-level event_name field is actually the company string, which
    // would land in the wrong field. FP-number is the only acceptable fallback
    // when the host name is genuinely missing.
    const eventName = (p?.guest_name || (p?.fp_number ? `FP ${p.fp_number}` : '')) ?? '';
    const eventDate = p?.event_date || today();
    const guestCount = p?.guest_count ? String(p.guest_count) : '';
    // "Company Name" — just the company; phone moves to the event notes if present.
    const customer = (p?.guest_company || '').trim();
    // Host mobile number is intentionally NOT pushed into notes — we don't
    // carry phone numbers into requisitions at all.
    const notesParts: string[] = [];
    if (p?.package_name) notesParts.push(p.package_name);
    if (p?.rate_per_head) notesParts.push(`@ ₹${p.rate_per_head}/head`);
    if (p?.event_time) notesParts.push(p.event_time);
    if (p?.reference) notesParts.push(`Ref: ${p.reference}`);
    const eventNotes = notesParts.join(' · ');

    // Defensive: filter materials not in the catalog.
    const catalogIds = new Set(materials.map(m => m.id));
    const known = mats.filter(m => catalogIds.has(m.material_id));
    const unknown = mats.length - known.length;
    if (unknown > 0) warnings.push(`${unknown} material${unknown === 1 ? '' : 's'} from FP not found in catalog (skipped)`);

    const items: LineItem[] = known.length > 0
      ? known.map(m => {
          // Default each line's unit to the material's recipe_unit (canonical).
          const mat = materials.find(x => x.id === m.material_id);
          return {
            material_id: m.material_id,
            qty: String(m.quantity),
            unit: (mat?.unit || '').trim() || undefined,
            notes: m.reasoning || '',
            department_id: '',
            confidence: m.confidence,
          };
        })
      : [{ material_id: '', qty: '', unit: '', notes: '', department_id: '' }];

    return { eventName, eventDate, guestCount, customer, eventNotes, items, warnings };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [eventName, setEventName] = useState(initial.eventName);
  const [eventDate, setEventDate] = useState(initial.eventDate);
  const [guestCount, setGuestCount] = useState<string>(initial.guestCount);
  const [customer, setCustomer] = useState(initial.customer);
  const [eventNotes, setEventNotes] = useState(initial.eventNotes);
  const [items, setItems] = useState<LineItem[]>(initial.items);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const isPrefilled = !!(prefill && (prefill.parsed || (prefill.materials && prefill.materials.length > 0)));
  const effectiveWarnings = initial.warnings;

  // Role check — captures the fields needed for two gates:
  //   1. Sheet-locked name/date/phone (admin can edit; others can't)
  //   2. Dept-change ability (only manager / admin / head_chef can switch
  //      depts on a party req; staff are locked to their own dept)
  const [isAdmin, setIsAdmin] = useState(false);
  const [myRole, setMyRole] = useState<string>('');
  const [isHeadChef, setIsHeadChef] = useState(false);
  const [isStoreManager, setIsStoreManager] = useState(false);
  const [myDeptId, setMyDeptId] = useState<string>('');
  const [myUserLoaded, setMyUserLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      setIsAdmin(d?.user?.role === 'admin');
      setMyRole(d?.user?.role || '');
      setIsHeadChef(!!d?.user?.is_head_chef);
      setIsStoreManager(!!d?.user?.is_store_manager);
      setMyDeptId(d?.user?.department_id || '');
      setMyUserLoaded(true);
    }).catch(() => setMyUserLoaded(true));
  }, []);
  const sheetLocked = isPrefilled && !isAdmin;

  // Who can switch departments / use mixed mode?
  //   - admin                        : yes (cross-cutting)
  //   - manager (any flavour)        : yes (department head decides their own)
  //   - is_head_chef (any role)      : yes (oversees multiple kitchens)
  //   - is_store_manager (any role)  : yes (cross-cutting)
  //   - staff                        : NO — locked to their own dept, no mixed mode
  const canChangeDept = isAdmin || isHeadChef || isStoreManager || myRole === 'manager';

  // Single-dept (default) vs Mixed-dept mode. New primary workflow is
  // "one req per dept" — each dept manager raises their own. The mixed mode
  // is kept as an escape hatch for admin / head chef who occasionally need
  // to fire off a cross-dept req from one screen.
  //
  // IMPORTANT: declared BEFORE the belt-and-suspenders useEffect below so
  // the dependency array doesn't hit a Temporal Dead Zone (TDZ) on render.
  // Putting the useEffect first triggered "Cannot access 'mixedMode' before
  // initialization" because the dep array is evaluated synchronously during
  // render — before the useState call.
  const [reqDeptId, setReqDeptId] = useState<string>('');
  const [mixedMode, setMixedMode] = useState(false);
  const [autoSelectedDept, setAutoSelectedDept] = useState(false);   // for the UI hint

  // Belt-and-suspenders: if a staff user previously had mixed mode enabled
  // (e.g. before a role demotion), force it off so the locked-dept flow takes over.
  useEffect(() => {
    if (myUserLoaded && !canChangeDept && mixedMode) setMixedMode(false);
  }, [myUserLoaded, canChangeDept, mixedMode]);

  // Auto-select the requesting dept once /me AND /departments have both loaded.
  // Skip for admins (they're cross-cutting and may pick any dept). Validate
  // the user's dept exists in the active list — if not, leave blank + show hint.
  useEffect(() => {
    if (reqDeptId) return;                                  // already picked (manual or auto)
    if (!myUserLoaded || departments.length === 0) return;  // wait for both
    if (isAdmin) return;                                    // admin picks per req
    if (!myDeptId) return;                                  // user has no dept configured
    const exists = departments.some(d => d.id === myDeptId);
    if (!exists) {
      // User's dept was deactivated/deleted — don't auto-pick a stale id
      console.warn('[party-req] user dept not in active list; manual pick required', myDeptId);
      return;
    }
    setReqDeptId(myDeptId);
    setAutoSelectedDept(true);
  }, [myUserLoaded, myDeptId, departments, isAdmin, reqDeptId]);

  // When user manually changes the dept, clear the "auto-selected" badge
  const setReqDept = (id: string) => { setReqDeptId(id); setAutoSelectedDept(false); };

  // Hint for users with no dept configured
  const noDeptHint = myUserLoaded && !isAdmin && !myDeptId
    ? 'Your user has no department configured. Ask admin to set it on /users.'
    : null;

  // When adding a new line, default its dept to the most recently picked dept
  // so the user doesn't repeat the dept selection if all lines go to the same one.
  const addLine = () => setItems(p => {
    const lastDept = [...p].reverse().find(it => it.department_id)?.department_id || '';
    return [...p, { material_id: '', qty: '', unit: '', notes: '', department_id: lastDept }];
  });
  /** Auto-add a fresh empty line when staff fills in qty on the LAST line. Saves
   *  the "click Add Line" tap on every item — a big deal for parties with 30+ lines. */
  const ensureTrailingEmpty = (changedIndex: number, patch: Partial<LineItem>) => {
    setItems(prev => {
      // Apply the patch in-place first
      const next = prev.map((it, idx) => idx === changedIndex ? { ...it, ...patch } : it);
      const isLast = changedIndex === next.length - 1;
      if (!isLast) return next;
      const last = next[changedIndex];
      const hasContent = !!last.material_id || (Number(last.qty) > 0);
      if (!hasContent) return next;
      // Don't add if there's already a trailing empty (defensive)
      const lastDept = [...next].reverse().find(it => it.department_id)?.department_id || '';
      next.push({ material_id: '', qty: '', unit: '', notes: '', department_id: lastDept });
      return next;
    });
  };
  const removeLine = (i: number) => setItems(p => p.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<typeof items[0]>) =>
    setItems(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  // Live cost estimate so the user sees per-head before saving
  const totalCost = useMemo(() => {
    let t = 0;
    for (const it of items) {
      const m = materials.find(x => x.id === it.material_id);
      if (!m) continue;
      const q = Number(it.qty) || 0;
      if (q === 0) continue;
      // Same conversion as the per-line cost: a qty entered in the purchase
      // unit (BTL/BAG) is pack_size recipe-units each. Without this the footer
      // total disagrees with the line costs whenever a purchase unit is used.
      const recipeU = (m.unit || '').trim();
      const lineU = (it.unit || allowedUnitsForMaterial(m)[0] || recipeU).trim();
      const effQty = (lineU && lineU !== recipeU) ? q * (Number(m.pack_size) || 1) : q;
      t += effQty * (m.average_price || 0);
    }
    return t;
  }, [items, materials]);
  const guests = Number(guestCount) || 0;
  const perHead = guests > 0 ? totalCost / guests : 0;

  // submitToChef=true → after creating the draft, immediately submit it so
  // the head chef sees it in /party-approvals (no extra click).
  const submit = async (submitToChef: boolean = true) => {
    if (!eventName.trim()) { setError('Event Host Name required'); return; }
    if (!eventDate)        { setError('Event date required'); return; }
    if (!mixedMode && !reqDeptId) { setError('Pick a Requesting Department'); return; }
    // Validate units before sending: every line's unit MUST be one of the
    // material's registered units. Catches typo/import edge cases.
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      if (!it.material_id || !(Number(it.qty) > 0)) continue;
      const m = materials.find(x => x.id === it.material_id);
      const allowed = allowedUnitsForMaterial(m);
      // Fallback matches what the dropdown DISPLAYS when unit is unset
      // (allowedUnits[0] = ordering unit) — never silently reinterpret as recipe unit.
      const u = (it.unit || allowed[0] || m?.unit || '').trim();
      if (allowed.length > 0 && u && !allowed.includes(u)) {
        setError(`Line ${idx + 1}: unit "${u}" is not registered for ${m?.name}. Allowed: ${allowed.join(', ')}.`);
        return;
      }
    }
    const cleaned = items
      .filter(i => i.material_id && Number(i.qty) > 0)
      .map(i => {
        const m = materials.find(x => x.id === i.material_id);
        const recipeU = (m?.unit || '').trim();
        // Same fallback as the dropdown display (ordering unit first) — an unset
        // unit must be interpreted as what the user SAW, not the recipe unit.
        const lineU = (i.unit || allowedUnitsForMaterial(m)[0] || recipeU).trim();
        const q = Number(i.qty) || 0;
        // Persist quantity in RECIPE units so downstream code (recipe cost,
        // chef approval, store issue) keeps working uniformly. When the staff
        // entered in the purchase unit, multiply by pack_size to convert.
        const recipeQty = (lineU && lineU !== recipeU)
          ? q * (Number(m?.pack_size) || 1)
          : q;
        return {
          material_id: i.material_id,
          quantity_requested: recipeQty,
          unit: recipeU,                    // canonical unit on the record
          entered_qty: q,                   // what staff typed
          entered_unit: lineU,              // what unit staff picked
          notes: i.notes,
          // Single-mode: every line inherits the top-level dept.
          // Mixed-mode: each line keeps its own.
          department_id: mixedMode ? i.department_id : reqDeptId,
        };
      });
    if (cleaned.length === 0) { setError('Add at least one material with a non-zero qty'); return; }
    if (mixedMode) {
      const lineWithoutDept = cleaned.findIndex(i => !i.department_id);
      if (lineWithoutDept >= 0) {
        setError(`Pick a department for line ${lineWithoutDept + 1}`);
        return;
      }
    }

    setSaving(true); setError(null);
    try {
      // EDIT mode → PUT to update the existing draft. NEW mode → POST to create.
      const body: any = {
        purpose: 'party',
        event_name: eventName.trim(),
        event_date: eventDate,
        guest_count: guests || null,
        customer: customer.trim(),
        event_notes: eventNotes.trim(),
        // Single-mode: department_id sent explicitly. Mixed-mode: server
        // derives it from the first item's dept.
        department_id: mixedMode ? undefined : reqDeptId,
        date: today(),
        items: cleaned,
        // Sheet-sync signal: when this req came from the AKAN Party Manager
        // sheet, the server re-asserts name/date/customer/pax from the cached
        // sheet row (for non-admins) so those fields stay in sync.
        from_sheet: isPrefilled,
        party_unique_id: prefill?.parsed?.party_unique_id,
        fp_id: prefill?.parsed?.fp_number,
      };
      if (isEditMode && editingReq?.id) body.id = editingReq.id;
      const r = await api('/api/requisitions', {
        method: isEditMode ? 'PUT' : 'POST',
        body,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }

      // If user clicked "Save & Submit", immediately flip the draft to
      // 'submitted' so it lands in the head chef's approval inbox.
      const savedId = j.requisition?.id || editingReq?.id;
      if (submitToChef && savedId) {
        const sub = await api(`/api/requisitions/${savedId}/submit`, {
          method: 'POST', body: {},
        });
        if (!sub.ok) {
          const sj = await sub.json().catch(() => ({}));
          // Don't fail the whole save — the draft was created. Just warn.
          setError(`Saved as draft, but auto-submit failed: ${sj.error || `HTTP ${sub.status}`}. Submit it manually from /requisitions.`);
          return;
        }
      }
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-3xl my-4 flex flex-col max-h-[calc(100vh-2rem)]"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
            <PartyPopper size={20} className="text-[#af4408]" />
            {isEditMode ? `Edit Draft — ${editingReq?.req_number || ''}` : 'New Party Requisition'}
          </h2>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {isPrefilled && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
              📄 Pre-filled from FP {prefill?.parsed?.fp_number || '(unknown)'} · {(prefill?.materials?.length || 0)} materials estimated.
              Review and adjust before saving.
              {effectiveWarnings.length > 0 && (
                <ul className="mt-2 list-disc pl-4">
                  {effectiveWarnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Menu checklist — surfaces food items from FP / sheet so the team
              knows what they need to request materials for. Read-only. */}
          {isPrefilled && prefill?.parsed?.menu && (() => {
            const menu: any = prefill.parsed.menu;
            const cats: { label: string; items?: string[] }[] = [
              { label: '🥗 Veg Starters',     items: menu.veg_starters },
              { label: '🍗 Non-Veg Starters', items: menu.nonveg_starters },
              { label: '🥘 Veg Mains',        items: menu.veg_mains },
              { label: '🍖 Non-Veg Mains',    items: menu.nonveg_mains },
              { label: '🍚 Rice',             items: menu.rice },
              { label: '🥣 Dal',              items: menu.dal },
              { label: '🥬 Salad',            items: menu.salad },
              { label: '🍮 Desserts',         items: menu.desserts },
              { label: '🫓 Accompaniments',   items: menu.accompaniments },
            ].filter(c => Array.isArray(c.items) && c.items!.length > 0);
            if (cats.length === 0) return null;
            return (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                <div className="font-semibold text-amber-900 mb-2">
                  🍽️ Menu from FP — use as checklist for material lines below
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
                  {cats.map((c, i) => (
                    <div key={i} className="text-amber-900">
                      <span className="font-medium">{c.label}:</span>{' '}
                      <span className="text-amber-800">{c.items!.join(', ')}</span>
                    </div>
                  ))}
                </div>
                {menu.bar_notes_raw && String(menu.bar_notes_raw).trim() && (
                  <div className="mt-2 pt-2 border-t border-amber-200 bg-amber-100/50 rounded px-2 py-1.5">
                    <div className="font-semibold text-amber-900 mb-0.5">🍸 Cocktails / Mocktails / Bar Notes</div>
                    <div className="text-amber-900 whitespace-pre-wrap">{menu.bar_notes_raw}</div>
                  </div>
                )}
              </div>
            );
          })()}
          {/* Event metadata. When sheetLocked = true, name/date/customer/pax
              are read-only (source of truth is the AKAN Party Manager sheet).
              Admins can still edit as an escape hatch. */}
          {sheetLocked && (
            <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-2 text-[11px] text-blue-900 flex items-start gap-2">
              <Lock size={12} className="mt-0.5 shrink-0" />
              <div>
                <strong>Host name, date, guest count and company are locked</strong> — these come from the AKAN
                Party Manager sheet. To change them, edit the sheet row and click Refresh on Party Events.
                (Admin can override.)
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1 flex items-center gap-1">
                Event Host Name * {sheetLocked && <Lock size={10} className="text-blue-700" />}
              </label>
              <input value={eventName} onChange={e => setEventName(e.target.value)} autoFocus={!sheetLocked}
                     readOnly={sheetLocked}
                     placeholder="e.g. Mr. Sharma"
                     title="The person hosting this party (from the AKAN Party Manager sheet's Host Name column)."
                     className={`w-full px-3 py-2 border rounded-lg text-sm ${sheetLocked ? 'border-blue-200 bg-blue-50/40 text-[#6B5744] cursor-not-allowed' : 'border-[#D4B896] bg-[#FFF1E3]'}`} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1 flex items-center gap-1">
                <Calendar size={12} /> Event Date * {sheetLocked && <Lock size={10} className="text-blue-700" />}
              </label>
              <input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)}
                     readOnly={sheetLocked}
                     className={`w-full px-3 py-2 border rounded-lg text-sm ${sheetLocked ? 'border-blue-200 bg-blue-50/40 text-[#6B5744] cursor-not-allowed' : 'border-[#D4B896] bg-[#FFF1E3]'}`} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1 flex items-center gap-1">
                <UsersIcon size={12} /> Guest Count {sheetLocked && <Lock size={10} className="text-blue-700" />}
              </label>
              <input type="number" min={0} value={guestCount} onChange={e => setGuestCount(e.target.value)}
                     readOnly={sheetLocked}
                     placeholder="e.g. 80"
                     className={`w-full px-3 py-2 border rounded-lg text-sm font-mono ${sheetLocked ? 'border-blue-200 bg-blue-50/40 text-[#6B5744] cursor-not-allowed' : 'border-[#D4B896] bg-[#FFF1E3]'}`} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1 flex items-center gap-1">
                Company Name {sheetLocked && <Lock size={10} className="text-blue-700" />}
              </label>
              <input value={customer} onChange={e => setCustomer(e.target.value)}
                     readOnly={sheetLocked}
                     placeholder="e.g. IBM India Pvt Ltd"
                     title="Company sponsoring this party (from the AKAN Party Manager sheet's Company column). Phone is preserved in Event Notes."
                     className={`w-full px-3 py-2 border rounded-lg text-sm ${sheetLocked ? 'border-blue-200 bg-blue-50/40 text-[#6B5744] cursor-not-allowed' : 'border-[#D4B896] bg-[#FFF1E3]'}`} />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Event Notes</label>
              <input value={eventNotes} onChange={e => setEventNotes(e.target.value)}
                     placeholder="Menu, special requests…"
                     className="w-full px-3 py-2 border border-[#D4B896] rounded-lg bg-[#FFF1E3] text-sm" />
            </div>
          </div>

          {/* Department selector. STAFF role is locked to their own dept (no
              dropdown, no mixed-mode toggle). Manager / Admin / Head Chef /
              Store Manager can switch depts and use mixed mode. */}
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <label className="text-xs font-medium text-[#6B5744] mb-1 block flex items-center gap-1">
                  Requesting Department *
                  {!canChangeDept && (
                    <Lock size={10} className="text-blue-700" />
                  )}
                  {autoSelectedDept && canChangeDept && (
                    <span className="ml-1 text-[10px] font-normal text-emerald-700 italic">
                      ✓ auto-selected from your profile
                    </span>
                  )}
                </label>

                {/* STAFF: locked label, no dropdown */}
                {!canChangeDept ? (
                  (() => {
                    const myDept = departments.find(d => d.id === myDeptId);
                    if (myDept) {
                      return (
                        <div className="w-full max-w-md px-3 py-2 border border-blue-200 bg-blue-50/40 rounded-lg text-sm text-[#2D1B0E] flex items-center gap-2"
                             title="Your role can only raise requisitions for your own department. Ask admin if you need to raise for another dept.">
                          <Lock size={11} className="text-blue-700 shrink-0" />
                          <span>{myDept.code ? `[${myDept.code}] ` : ''}{myDept.name}</span>
                        </div>
                      );
                    }
                    // Staff with NO dept configured — block + hint
                    return (
                      <div className="w-full max-w-md px-3 py-2 border border-amber-400 bg-amber-50 rounded-lg text-sm text-amber-900">
                        ⚠ Your user has no department assigned. Ask admin to set one on{' '}
                        <a href="/users" className="underline">/users</a> before raising requisitions.
                      </div>
                    );
                  })()
                ) : !mixedMode ? (
                  <>
                    <select value={reqDeptId} onChange={e => setReqDept(e.target.value)}
                            className={`w-full max-w-md px-3 py-2 border rounded-lg text-sm ${reqDeptId ? 'border-[#D4B896] bg-white' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
                      <option value="">— pick department (Continental / Bakery / Bar…) —</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>
                      ))}
                    </select>
                    {noDeptHint && (
                      <div className="text-[10px] text-amber-700 mt-1">⚠ {noDeptHint}</div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-[#8B7355] italic">Multiple departments — each line below picks its own.</div>
                )}
              </div>

              {/* Mixed-mode toggle ONLY visible to manager / admin / head chef / store mgr.
                  Staff don't see it (they can't even use it since dept is locked). */}
              {canChangeDept && (
                <label className="text-[11px] text-[#6B5744] flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={mixedMode} onChange={e => setMixedMode(e.target.checked)} />
                  Multiple departments
                </label>
              )}
            </div>
            {!mixedMode && (
              <div className="text-[10px] text-[#8B7355]">
                Each dept raises its own party req. Head Chef sees them all together on the <strong>Party Approvals</strong> screen.
              </div>
            )}
          </div>

          {/* Items table — per-line dept only shows in mixed mode */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[#2D1B0E]">Items needed</label>
              <button type="button" onClick={addLine}
                      className="text-xs text-[#af4408] hover:underline inline-flex items-center gap-1">
                <Plus size={12} /> Add line
              </button>
            </div>
            {/* Column headers */}
            <div className="grid grid-cols-12 gap-2 mb-1 text-[10px] font-medium text-[#8B7355] uppercase tracking-wide px-1">
              <div className="col-span-4">Material</div>
              <div className="col-span-2 text-right">Qty</div>
              <div className="col-span-1">Unit</div>
              {mixedMode
                ? <div className="col-span-3">Department</div>
                : <div className="col-span-3">Notes (optional)</div>}
              <div className="col-span-2 text-right">Cost</div>
            </div>
            <div className="space-y-2">
              {items.map((it, i) => {
                const m = materials.find(x => x.id === it.material_id);
                const allowedUnits = allowedUnitsForMaterial(m);
                // Live cost — convert qty to recipe-units first when the line's
                // unit is the purchase_unit (so we don't double-count pack size).
                const effectiveQty = (() => {
                  const q = Number(it.qty) || 0;
                  if (!m || q === 0) return 0;
                  const recipeU = (m.unit || '').trim();
                  // Match the dropdown's display fallback (ordering unit first).
                  const lineU = (it.unit || allowedUnits[0] || recipeU).trim();
                  if (lineU === recipeU) return q;
                  // line unit == purchase_unit → convert to recipe units via pack_size
                  const pack = Number(m.pack_size) || 1;
                  return q * pack;
                })();
                const lineCost = m && effectiveQty > 0 ? effectiveQty * (m.average_price || 0) : 0;
                return (
                  <div key={i} className="grid grid-cols-12 gap-2 items-start">
                    <div className="col-span-4">
                      <MaterialTypeahead
                        materials={materials as any}
                        value={it.material_id}
                        onPick={(id) => {
                          // When a material is picked FRESH, default the unit to the
                          // ORDERING unit (purchase_unit — how humans think in bulk:
                          // BTL / bag), NOT the recipe unit (g/ml). This is the fix for
                          // "chef typed 12 meaning litres, got 12 ml". ONLY when
                          // pack_size > 1 — the purchase-unit conversion multiplies by
                          // pack_size, so a mis-configured pack_size=1 material must
                          // keep its recipe unit or "12 BTL" would store as 12 ml.
                          // Prefilled/edited lines keep recipe units because their
                          // quantities are already stored canonically.
                          const mat = materials.find(x => x.id === id);
                          const pu = (mat?.purchase_unit || '').trim();
                          const ru = (mat?.unit || '').trim();
                          const ordering = (pu && pu !== ru && (Number(mat?.pack_size) || 1) > 1) ? pu : ru;
                          ensureTrailingEmpty(i, {
                            material_id: id,
                            unit: ordering || '',
                          });
                        }}
                        excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                      />
                    </div>
                    <input type="number" step="any" value={it.qty}
                           onChange={e => ensureTrailingEmpty(i, { qty: e.target.value })}
                           placeholder="Qty"
                           className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
                    {/* Unit dropdown — only the material's registered units
                        (recipe_unit + purchase_unit). For materials with a single
                        unit registered, this becomes a label, not a dropdown. */}
                    {allowedUnits.length > 1 ? (
                      <select value={it.unit || allowedUnits[0]}
                              onChange={e => update(i, { unit: e.target.value })}
                              title="Pick one of this material's registered units"
                              className="col-span-1 px-1 py-1.5 border border-[#D4B896] rounded text-xs bg-white">
                        {allowedUnits.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    ) : (
                      <span className="col-span-1 text-xs text-[#8B7355] py-2">{allowedUnits[0] || m?.unit || ''}</span>
                    )}
                    {mixedMode ? (
                      <select value={it.department_id}
                              onChange={e => update(i, { department_id: e.target.value })}
                              className={`col-span-3 px-2 py-1.5 border rounded text-xs ${it.department_id ? 'border-[#D4B896] bg-white' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
                        <option value="">— pick dept —</option>
                        {departments.map(d => (
                          <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={it.notes} onChange={e => update(i, { notes: e.target.value })}
                             placeholder="Notes (optional)"
                             className="col-span-3 px-2 py-1.5 border border-[#D4B896] rounded text-xs" />
                    )}
                    <div className="col-span-2 flex items-center justify-end gap-1">
                      {it.confidence && (
                        <span title={`Confidence: ${it.confidence}`}
                              className={`text-[9px] px-1 py-0.5 rounded uppercase font-semibold ${
                                it.confidence === 'high'   ? 'bg-emerald-100 text-emerald-800' :
                                it.confidence === 'medium' ? 'bg-amber-100 text-amber-800' :
                                                             'bg-gray-100 text-gray-600'
                              }`}>
                          {it.confidence[0]}
                        </span>
                      )}
                      <span className="text-xs font-mono text-[#6B5744]" title={`${m?.average_price ? '₹'+m.average_price+'/'+m.unit : ''}`}>
                        {fmt(lineCost)}
                      </span>
                      <button type="button" onClick={() => removeLine(i)}
                              className="text-red-600 hover:text-red-700"><Trash2 size={12} /></button>
                    </div>
                    {/* In mixed mode, dept takes the col-span-3 slot so notes
                        get an extra row. In single mode the col-span-3 already
                        holds notes — no extra row needed. */}
                    {mixedMode && (
                      <input value={it.notes} onChange={e => update(i, { notes: e.target.value })}
                             placeholder="Line notes (optional)"
                             className="col-span-12 px-2 py-1 border border-[#E8D5C4] rounded text-[11px] text-[#6B5744] -mt-1" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Live cost estimate */}
          <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-3 flex items-center justify-between">
            <div>
              <div className="text-xs text-[#8B7355]">Estimated cost</div>
              <div className="text-xl font-bold text-[#2D1B0E]">{fmt(totalCost)}</div>
            </div>
            {guests > 0 && (
              <div className="text-right">
                <div className="text-xs text-[#8B7355]">Per head ({guests} guests)</div>
                <div className="text-lg font-semibold text-[#af4408]">{fmt(perHead)}</div>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Cancel</button>
          {/* Save Draft → stays in 'draft' status, dept can edit later */}
          <button onClick={() => submit(false)} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded text-sm disabled:opacity-50"
                  title="Keep as draft; you can edit later before submitting.">
            <Save size={14} />
            Save as Draft
          </button>
          {/* Save & Submit → primary action, lands on Head Chef's approval inbox */}
          <button onClick={() => submit(true)} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50"
                  title="Save and immediately send to Head Chef for approval.">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <ChefHat size={14} />}
            {saving ? 'Saving…' : 'Save & Submit to Chef'}
          </button>
        </div>
      </div>
    </div>
  );
}
