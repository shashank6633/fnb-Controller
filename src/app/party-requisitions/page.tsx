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
  PartyPopper, Loader2, X, ChevronDown, ChevronRight, Search,
} from 'lucide-react';
import { api } from '@/lib/api';
import { packFactor, toPurchaseQty, fmtQtyNum } from '@/lib/pack-units';
// ONE composer for both flows: /requisitions renders this picker with no `party`
// prop, we render it with one. Nothing about the cart, the pack-factor guard or
// the save path is duplicated here — that duplication is what used to drift.
import StaffCatalogPicker, { type PartyMode } from '../requisitions/StaffCatalogPicker';

/** Detail-table qty cell: resolve the stored number through the LINE's unit
 *  (party saves stamp the recipe unit; legacy lines may carry the purchase
 *  unit), then lead with the purchase basis per the owner rule. */
function PartyQty({ qty, it }: { qty: number | null | undefined; it: any }) {
  if (qty == null) return <>—</>;
  const meta = { unit: it.material_unit || it.unit, purchase_unit: it.material_purchase_unit, pack_size: it.material_pack_size };
  const pf = packFactor(meta);
  const lu = String(it.unit || '').toLowerCase().trim();
  const lineIsPU = pf > 1 && lu !== '' && lu === String(meta.purchase_unit || '').toLowerCase().trim();
  const recipeQty = lineIsPU ? Number(qty) * pf : Number(qty);
  const pu = toPurchaseQty(recipeQty, meta);
  return (
    <>
      {fmtQtyNum(pu)} <span className="text-[#8B7355]">{meta.purchase_unit || meta.unit}</span>
      {pf > 1 && <span className="block text-[9px] text-[#B8A590]">= {fmtQtyNum(recipeQty)} {meta.unit}</span>}
    </>
  );
}

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
  // Widened from {role,email}: the picker resolves canChangeDept / the sheet-lock
  // admin override from these. /api/auth/me already returns the whole user, so
  // this replaces the composer's own duplicate /me fetch.
  const [me, setMe] = useState<{
    role?: string; email?: string; department_id?: string | null;
    is_head_chef?: boolean; is_store_manager?: boolean;
  } | null>(null);
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

  /* ── Composer wiring ──────────────────────────────────────────────────────
   * Everything party-specific the shared picker needs. The event-field
   * resolution is the old modal's `initial` memo, moved out intact. */
  const isPrefilled = !!(fpPrefill && (fpPrefill.parsed || (fpPrefill.materials?.length || 0) > 0));

  // /api/inventory feeds both pages; fill in the fields the picker requires.
  const catalog = useMemo(() => materials.map(m => ({
    ...m,
    unit: m.unit || '',
    current_stock: Number(m.current_stock) || 0,
    average_price: Number(m.average_price) || 0,
  })), [materials]);

  const partyProps = useMemo<PartyMode>(() => {
    // EDIT wins over FP prefill — we're resuming an existing draft.
    if (editingReq) {
      return {
        initial: {
          event_name:  editingReq.event_name || '',
          event_date:  editingReq.event_date || today(),
          guest_count: editingReq.guest_count ? String(editingReq.guest_count) : '',
          customer:    editingReq.customer || '',
          // event_notes is the field the composer writes; `notes` is the legacy
          // fallback (it is now the cart's justification field).
          event_notes: editingReq.event_notes || '',
        },
      };
    }

    const p = fpPrefill?.parsed;
    const mats = fpPrefill?.materials || [];
    const warnings = [...(fpPrefill?.warnings || [])];

    // Defensive: drop FP materials that are not in the catalog.
    const catalogIds = new Set(materials.map(m => m.id));
    const known = mats.filter(m => catalogIds.has(m.material_id));
    const unknown = mats.length - known.length;
    if (unknown > 0) warnings.push(`${unknown} material${unknown === 1 ? '' : 's'} from FP not found in catalog (skipped)`);

    // "Event Host Name" is strictly the host. We deliberately do NOT fall back
    // to event_name — on some FPs that field actually holds the company string.
    const notesParts: string[] = [];
    if (p?.package_name)  notesParts.push(p.package_name);
    if (p?.rate_per_head) notesParts.push(`@ ₹${p.rate_per_head}/head`);
    if (p?.event_time)    notesParts.push(p.event_time);
    if (p?.reference)     notesParts.push(`Ref: ${p.reference}`);

    return {
      initial: {
        event_name:  (p?.guest_name || (p?.fp_number ? `FP ${p.fp_number}` : '')) ?? '',
        event_date:  p?.event_date || today(),
        guest_count: p?.guest_count ? String(p.guest_count) : '',
        customer:    (p?.guest_company || '').trim(),
        event_notes: notesParts.join(' · '),
      },
      sheetLocked: isPrefilled,
      sheet: { from_sheet: isPrefilled, party_unique_id: p?.party_unique_id, fp_id: p?.fp_number },
      // fp-estimator emits RECIPE units; the picker converts to its purchase basis.
      seed: known.map(m => ({ material_id: m.material_id, quantity: m.quantity })),
      banner: isPrefilled ? <FpBanner prefill={fpPrefill!} warnings={warnings} /> : null,
    };
  }, [editingReq, fpPrefill, materials, isPrefilled]);

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
          <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[880px]">
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
                          <div className="overflow-x-auto">
                          <table className="w-full text-[11px] min-w-[520px]">
                            <thead className="text-[#8B7355]">
                              <tr>
                                <th className="text-left  py-1 px-2 font-medium">SKU</th>
                                <th className="text-left  py-1 px-2 font-medium">Material</th>
                                <th className="text-right py-1 px-2 font-medium">Requested</th>
                                <th className="text-right py-1 px-2 font-medium">HOD OK</th>
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
                                    <td className="py-1 px-2 text-right font-mono"><PartyQty qty={it.quantity_requested} it={it} /></td>
                                    <td className="py-1 px-2 text-right font-mono">
                                      {rejected
                                        ? <span className="text-red-700 no-underline">—</span>
                                        : it.chef_approved_qty != null
                                          ? <span className="text-amber-700"><PartyQty qty={it.chef_approved_qty} it={it} /></span>
                                          : <span className="text-[#C0A98F]">—</span>}
                                    </td>
                                    <td className="py-1 px-2 text-right font-mono text-emerald-700">
                                      {rejected ? '—' : <PartyQty qty={Number(it.quantity_issued) || 0} it={it} />}
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
          </div>
        )}
      </div>

      {showNew && (
        <StaffCatalogPicker
          materials={catalog}
          me={me}
          departments={departments}
          editDraft={editingReq}
          party={partyProps}
          onClose={() => { setShowNew(false); setFpPrefill(null); setEditingReq(null); }}
          onCreated={() => { setShowNew(false); setFpPrefill(null); setEditingReq(null); reload(); }}
        />
      )}
    </div>
  );
}

/** FP / sheet prefill notice + the read-only menu checklist. Rendered inside the
 *  picker's event header through its `banner` slot, so the picker never needs to
 *  know anything about FP parsing. */
function FpBanner({ prefill, warnings }: { prefill: FpPrefill; warnings: string[] }) {
  const menu: any = prefill.parsed?.menu;
  const cats: { label: string; items?: string[] }[] = [
    { label: '🥗 Veg Starters',     items: menu?.veg_starters },
    { label: '🍗 Non-Veg Starters', items: menu?.nonveg_starters },
    { label: '🥘 Veg Mains',        items: menu?.veg_mains },
    { label: '🍖 Non-Veg Mains',    items: menu?.nonveg_mains },
    { label: '🍚 Rice',             items: menu?.rice },
    { label: '🥣 Dal',              items: menu?.dal },
    { label: '🥬 Salad',            items: menu?.salad },
    { label: '🍮 Desserts',         items: menu?.desserts },
    { label: '🫓 Accompaniments',   items: menu?.accompaniments },
  ].filter(c => Array.isArray(c.items) && c.items!.length > 0);
  const barNotes = menu?.bar_notes_raw && String(menu.bar_notes_raw).trim();

  return (
    <>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-[11px] text-blue-800">
        📄 Pre-filled from FP {prefill.parsed?.fp_number || '(unknown)'} ·{' '}
        {(prefill.materials?.length || 0)} materials estimated. Review and adjust before saving.
        {warnings.length > 0 && (
          <ul className="mt-1.5 list-disc pl-4">
            {warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
          </ul>
        )}
      </div>

      {(cats.length > 0 || barNotes) && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px]">
          <div className="font-semibold text-amber-900 mb-1.5">
            🍽️ Menu from FP — use as a checklist for the items below
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
            {cats.map(c => (
              <div key={c.label} className="text-amber-900">
                <span className="font-medium">{c.label}:</span>{' '}
                <span className="text-amber-800">{c.items!.join(', ')}</span>
              </div>
            ))}
          </div>
          {barNotes && (
            <div className="mt-1.5 pt-1.5 border-t border-amber-200 bg-amber-100/50 rounded px-2 py-1.5">
              <div className="font-semibold text-amber-900 mb-0.5">🍸 Cocktails / Mocktails / Bar Notes</div>
              <div className="text-amber-900 whitespace-pre-wrap">{String(menu.bar_notes_raw)}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
