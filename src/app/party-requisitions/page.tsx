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
  CalendarDays, Building2, Users, ListChecks, LayoutList, AlertTriangle,
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

/** Sentinel for the "(not filled in)" option in the Company / Customer pickers.
 *  A NUL char can never be a real company or contact name, so it can never
 *  collide with a value that came out of the sheet. */
const BLANK = '\u0000';

/** Trim, and collapse EVERY run of whitespace to one space.
 *  "Rao,  Venkat" and "Rao, Venkat" are one person; nothing upstream of this
 *  page collapses that second space (the sheet mapper and the event_name
 *  column both only trim), so two identical-looking picker entries used to
 *  return two different, incomplete answers. */
const foldSpace = (s: string | null | undefined) => String(s || '').replace(/\s+/g, ' ').trim();
/** Matching key for a PERSON's name: spacing + case only. Never touch the words
 *  themselves — people's names are not normalisable. */
const foldName = (s: string | null | undefined) => foldSpace(s).toLowerCase();

/** Legal form at the END of a company name, with the punctuation around it. */
const LEGAL_TAIL =
  /[\s.,&-]*\b(pvt|private|ltd|limited|llp|inc|incorporated|corp|corporation|company|plc)\b[\s.,]*$/;
/**
 * Matching key for a COMPANY. Case, spacing, and any trailing legal form are
 * dropped, so the one firm the owner has in mind is ONE entry in the picker:
 *   "Colruyt Group India Pvt"             ─┐
 *   "  colruyt group india pvt  "          ├─→ colruyt group india
 *   "Colruyt Group India Private Limited" ─┘
 * Only the TAIL is stripped, repeatedly ("… Private Limited" → "… Private" →
 * "…"), so nothing inside the name is touched: "Colruyt Group India" and
 * "Colruyt Group Belgium" stay two different firms. If a name is nothing but a
 * legal form, the fold falls back to the whole name rather than to "".
 *
 * Trade-off the owner should know about: two companies whose names differ ONLY
 * by legal form ("Acme Pvt Ltd" / "Acme LLP") become one entry. On his data
 * that is the same customer written two ways, which is the case this exists to
 * fix — but it IS a merge, not just a tidy-up.
 */
function foldCompany(s: string | null | undefined): string {
  const full = foldName(s);
  let v = full.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  let prev = '';
  while (v && v !== prev) { prev = v; v = v.replace(LEGAL_TAIL, '').trim(); }
  return v || full;
}

/** One entry in a picker: what it MATCHES on, and what it READS as. */
interface PickOption { key: string; label: string }

/**
 * Build a picker list from values that ALREADY EXIST in the loaded rows.
 *
 * Each row offers a matching KEY (which spellings are the same thing) and one
 * or more LABELS (how that thing is written). Every spelling with the same key
 * becomes ONE entry, shown with the fullest label seen, because "Colruyt Group
 * India Private Limited" tells the owner more than "Colruyt Group India Pvt"
 * and a customer whose name the sheet spells out in full ("Raghu Varma") should
 * not also appear as the short version saved on one requisition.
 *
 * Blank values are reported separately (`hasBlank`) and get their own option —
 * a requisition with no company must stay reachable, not vanish from the page.
 */
function pickOptions(rows: { key: string; labels: string[] }[]): { options: PickOption[]; hasBlank: boolean } {
  const seen = new Map<string, string>();
  let hasBlank = false;
  for (const r of rows) {
    if (!r.key) { hasBlank = true; continue; }
    const best = r.labels.map(foldSpace).filter(Boolean).sort((a, b) => b.length - a.length)[0] || r.key;
    const cur = seen.get(r.key);
    if (cur == null || best.length > cur.length) seen.set(r.key, best);
  }
  return {
    options: Array.from(seen.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    hasBlank,
  };
}

/** First day of the current month / today, as YYYY-MM-DD (the shape event_date
 *  is stored in, so plain string compare is a correct date compare). */
const monthStart = () => today().slice(0, 7) + '-01';
const daysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

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

/** A requisition plus the names + date AS THE PAGE ACTUALLY PRINTS THEM.
 *  Neither Customer nor Company is a plain column read (see resolveRow), so
 *  every consumer — table cell, pickers, filters, grouping — reads these
 *  resolved strings and never the raw columns. That is what stops a picker
 *  offering a name that matches no row. */
interface ResolvedRow {
  r: Requisition;
  /** Cleaned `customer` column — which holds the COMPANY. */
  company: string;
  /** Live Contact Person from the sheet, else the stored event_name. */
  customer: string;
  stored: string;
  liveContact: string;
  sameAsCo: boolean;
  /** event_date when set, else the date the requisition was raised — exactly
   *  what the Date column shows. */
  effDate: string;
}

/** One banquet, with every department's requisition for it underneath.
 *  Grouped on (customer name + event date) — the same pair /party-approvals and
 *  /api/party-events group on, so the three screens agree about what counts as
 *  one event. Two differences, both deliberate, both because this screen prints
 *  a ₹ total and those consequences are money:
 *    · the name is matched ignoring case and double spaces, so "Rao, Venkat"
 *      and "Rao,  Venkat" on one date are one party rather than two cards with
 *      half the cost each;
 *    · when there is NO name to match on, the company is used instead of
 *      matching blank-to-blank — see groupKeyFor(). */
interface EventGroup {
  event_key: string;
  event_name: string;
  event_date: string;
  company: string;
  customer: string;
  guest_count: number | null;
  /** true when two departments typed different head counts for one event */
  guest_count_varies: boolean;
  rows: ResolvedRow[];
  /** Sum of the per-department figures AS PRINTED (each rounded to the rupee),
   *  so the column on screen always adds up to the total on screen. */
  total_cost: number;
  total_items: number;
  /** The part of total_cost that is still in DRAFT — nobody has submitted it. */
  draft_cost: number;
  /** Departments on this party, each with how many requisitions it raised. */
  depts: { name: string; count: number }[];
  /** Approval state, counted exactly as /party-approvals counts it. */
  submitted_count: number;
  pending_mgmt_count: number;
  approved_count: number;
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

/**
 * THE ITEMS ON ONE REQUISITION — the block that drops down when a Req # is
 * clicked.
 *
 * It lives here, at module scope, because TWO screens open it: the flat list
 * and the event card. They are the same question asked from two directions
 * ("what is on this requisition?"), so they must answer it in the same words,
 * the same columns and the same colours. Rendering it twice from two copies is
 * how a screen becomes two takes on one idea and then drifts — a rejected line
 * struck through in one view and merely greyed in the other, and nobody able to
 * say which is the real state.
 *
 * It owns no state and fetches nothing. The caller holds the cache (one fetch
 * per requisition, kept), which is why re-opening a row is instant and why
 * expanding a requisition in the list leaves it already loaded in the card.
 */
function ReqItemsDetail({ detail, loading }: { detail: any; loading: boolean }) {
  if (loading || !detail) {
    return (
      <div className="text-[11px] text-[#8B7355]">
        <Loader2 size={11} className="inline animate-spin mr-1" /> Loading items…
      </div>
    );
  }
  if ((detail.items || []).length === 0) {
    return <div className="text-[11px] text-[#8B7355] italic">No items on this requisition.</div>;
  }
  return (
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
  );
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

  /* ── R1: Date / Company / Customer filters ───────────────────────────────
   * All three run on the browser over the rows already loaded. The server is
   * deliberately not involved: this page downloads every party requisition in
   * one go already, its /api/requisitions `from`/`to` params filter the WRONG
   * column (r.date, the day the requisition was raised — not event_date), and
   * neither name the owner filters by is a plain column read (see resolveRow).
   * Filtering here is both correct and instant.
   */
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [companyF, setCompanyF]   = useState('');   // '' = any · BLANK = not filled in
  const [customerF, setCustomerF] = useState('');
  /** How the chosen entries READ. Kept beside the matching keys purely so that
   *  switching views — where the other view may hold no row for that company —
   *  still shows the owner the name he picked, not the matching key. */
  const [companyFLabel, setCompanyFLabel]   = useState('');
  const [customerFLabel, setCustomerFLabel] = useState('');

  /* ── R2 / R3: the event-wise view ────────────────────────────────────────
   * The flat list stays the DEFAULT and stays open to everyone who can open
   * this page today. The staff who raise party requisitions read that list,
   * and the composer that creates one only exists on this page — taking the
   * page away from them was not asked for. Only the NEW event-wise view is
   * Admin/HOD-only, and its gate lives on the server (?view=events → 403).
   * The toggle below is a hint, not the control.
   */
  const [view, setView] = useState<'list' | 'events'>('list');
  /** null = not asked yet · true / false = what the SERVER answered. */
  const [eventViewOk, setEventViewOk]   = useState<boolean | null>(null);
  const [eventViewMsg, setEventViewMsg] = useState('');
  /** The requisitions behind the CARDS — every department's, straight from the
   *  gated endpoint. Deliberately a separate list from `list` (which the flat
   *  table renders and which is narrowed to what this user may normally see):
   *  the cards and their ₹ totals come from ONE payload, so a card's rows can
   *  never add up to something other than that card's total. */
  const [eventList, setEventList] = useState<Requisition[]>([]);
  /** Does this viewer see EVERY department of every event? The server decides;
   *  when false the cards must not call their sum an event total. */
  const [totalsComplete, setTotalsComplete] = useState(true);
  /** The cards show MORE requisitions than the flat list does for this viewer
   *  (a head of department scoped to his own drafts). Said out loud on screen,
   *  because two halves of one page showing different counts is alarming. */
  const [widerThanList, setWiderThanList] = useState(false);
  /** Is the second (Management) approval gate switched on? Decides what a
   *  chef-approved requisition is called, exactly as on /party-approvals. */
  const [requireMgmt, setRequireMgmt] = useState(false);
  /** Which event cards are open. Collapsed on load, like /party-approvals. */
  const [openEvents, setOpenEvents] = useState<Set<string>>(new Set());
  const toggleEvent = (key: string) =>
    setOpenEvents(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  /**
   * Resolve ONE row's Customer, Company and Date exactly as the table prints
   * them. The pickers are built from these strings and the filters compare
   * against these strings, so choosing a name from a dropdown always matches
   * at least one row.
   *
   * Customer Name priority (unchanged from the original table cell):
   *   1. Live Contact Person from the upcoming-parties sheet cache, looked up
   *      by fp_id, party_unique_id, or event_date + company.
   *   2. The event_name stored on the requisition.
   *   3. Blank.
   * Company Name is the `customer` DB column with phone numbers stripped —
   * that column really does hold the company; the two are NOT swapped by
   * mistake, the column names are just historic.
   */
  const resolveRow = useMemo(() => (r: Requisition): ResolvedRow => {
    const company = cleanCustomer(r.customer);
    const stored  = (r.event_name || '').trim();
    const lookups = [
      r.fp_id           ? `fp:${r.fp_id}`                                        : '',
      r.party_unique_id ? `uid:${r.party_unique_id}`                             : '',
      (company && r.event_date) ? `co:${company.toLowerCase()}|${r.event_date}`  : '',
    ].filter(Boolean);
    const liveContact = lookups.map(k => contactByKey.get(k)).find(v => v && v.trim()) || '';
    const customer = liveContact || stored;
    const sameAsCo = !!(customer && company && customer.toLowerCase() === company.toLowerCase());
    // Date shown = event_date, falling back to the raised date. Filtering on
    // the SAME fallback is what stops a row whose visible date is inside the
    // range from being hidden because event_date happens to be blank.
    return { r, company, customer, stored, liveContact, sameAsCo, effDate: (r.event_date || r.date || '') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactByKey]);

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
  /** Whether to OFFER the event-wise view. This is the app's "Admin and HOD"
   *  predicate (role==='admin' || is_head_chef) — deliberately not
   *  canApproveAsChef, which is wider. It only decides whether the button is
   *  drawn; /api/requisitions?view=events enforces the same rule with a 403. */
  const canSeeEventView = me?.role === 'admin' || !!me?.is_head_chef;

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

  /** Bumped by every successful reload. The cards listen to it — see below. */
  const [dataVersion, setDataVersion] = useState(0);
  const reload = async () => {
    setLoading(true);
    const d = await fetch('/api/requisitions?purpose=party').then(r => r.json());
    setList(d.requisitions || []);
    setLoading(false);
    setDataVersion(v => v + 1);
  };
  useEffect(() => { reload(); }, []);

  /* R3 — the actual permission check, AND the cards' only source of data.
   * Fired when the event view is opened (not on every page load, so the staff
   * who only ever use the flat list never generate a 403). The button that
   * switches views is a hint; THIS is the control. A refusal puts the page back
   * on the flat list and shows the server's own sentence, so nobody is left
   * staring at a blank panel.
   *
   * It re-runs on `dataVersion`, i.e. after every create, edit-save and delete.
   * That is not a nicety: this payload carries the ₹ the cards print, so a
   * version of it that was fetched before a deletion would keep printing the
   * deleted requisition's money over a list that no longer contains it. */
  useEffect(() => {
    if (view !== 'events') return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/requisitions?purpose=party&view=events');
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setEventViewOk(false);
          setEventViewMsg(j.error || `Could not open the event view (HTTP ${r.status}).`);
          setView('list');
          return;
        }
        setEventList(j.requisitions || []);
        setTotalsComplete(j.totals_complete !== false);
        setWiderThanList(j.wider_than_list === true);
        setRequireMgmt(j.require_mgmt_approval === true);
        setEventViewOk(true);
        setEventViewMsg('');
      } catch (e: any) {
        if (!alive) return;
        setEventViewOk(false);
        setEventViewMsg(e?.message || 'Could not reach the server.');
        setView('list');
      }
    })();
    return () => { alive = false; };
  }, [view, dataVersion]);

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

  /** Every loaded requisition, with its printed names + date attached once. */
  const rows = useMemo(() => list.map(resolveRow), [list, resolveRow]);
  /** The same treatment for the cards' own payload (every department's). */
  const evRows = useMemo(() => eventList.map(resolveRow), [eventList, resolveRow]);
  /** Whichever set the screen is currently showing — the pickers are built from
   *  THIS, so on the cards a company that only appears on another department's
   *  requisition is still offered. */
  const activeRows = view === 'events' ? evRows : rows;

  const dateOn = !!(fromDate || toDate);
  /** Three independent tests, so the pickers can ask "what would survive the
   *  OTHER filters?" without re-implementing any of them. */
  const passesDate = (x: ResolvedRow) => {
    if (!dateOn) return true;
    // No date anywhere on the requisition (no party date, not even a raised
    // date): it cannot be inside a date window. It is not silently dropped —
    // the screen counts these and says so under the filters.
    if (!x.effDate) return false;
    if (fromDate && x.effDate < fromDate) return false;
    if (toDate   && x.effDate > toDate)   return false;
    return true;
  };
  /** What each row matches a picker entry on. The picker VALUES are these keys,
   *  never the displayed spelling, so one entry can stand for every spelling of
   *  the same company or person.
   *
   *  A customer is keyed on the name SAVED on the requisition, falling back to
   *  the live Contact Person when nothing was saved — the same rule the event
   *  grouping uses, so "filter by this customer" and "this customer's card"
   *  always hold the same requisitions. Keying on the printed name instead
   *  would split a party the day one department leaves the company blank: that
   *  row misses the sheet lookup, keeps the saved spelling, and would drop out
   *  of its own party. */
  const companyKeyOf  = (x: ResolvedRow) => foldCompany(x.company);
  const customerKeyOf = (x: ResolvedRow) => foldName(x.r.event_name) || foldName(x.customer);
  const passesCompany = (x: ResolvedRow) => {
    if (!companyF) return true;
    if (companyF === BLANK) return !companyKeyOf(x);
    return companyKeyOf(x) === companyF;
  };
  const passesCustomer = (x: ResolvedRow) => {
    if (!customerF) return true;
    if (customerF === BLANK) return !customerKeyOf(x);
    return customerKeyOf(x) === customerF;
  };
  /** Does one row pass the three pickers? (Search is applied separately, because
   *  in the event view it has to match across a whole group.) */
  const passesFilters = (x: ResolvedRow) =>
    passesDate(x) && passesCompany(x) && passesCustomer(x);

  /** Requisitions carrying no date at all, held back by the date filter. Shown
   *  as a sentence rather than left to vanish. */
  const undatedHeldBack = useMemo(
    () => (dateOn ? activeRows.filter(x => !x.effDate && passesCompany(x) && passesCustomer(x)).length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRows, dateOn, companyF, customerF],
  );

  /** Picker contents — built from the values that EXIST in the rows on screen,
   *  so the owner never has to spell "Biopulse Solutions Private Limited", and
   *  narrowed by the OTHER filters so the list is not mostly dead ends: pick a
   *  date first and the Company list shrinks to the companies with a party on
   *  that date. The chosen value is always kept in its own list, otherwise
   *  choosing it would make it disappear. */
  const companyPick = useMemo(() => {
    const p = pickOptions(activeRows.filter(x => passesDate(x) && passesCustomer(x))
      .map(x => ({ key: companyKeyOf(x), labels: [x.company] })));
    if (companyF && companyF !== BLANK && !p.options.some(o => o.key === companyF)) {
      p.options = [...p.options, { key: companyF, label: companyFLabel || companyF }];
    }
    if (companyF === BLANK) p.hasBlank = true;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRows, fromDate, toDate, customerF, companyF, companyFLabel]);
  const customerPick = useMemo(() => {
    const p = pickOptions(activeRows.filter(x => passesDate(x) && passesCompany(x))
      // Both spellings offered as labels; the fullest wins, which is normally
      // the live Contact Person from the sheet.
      .map(x => ({ key: customerKeyOf(x), labels: [x.customer, x.stored] })));
    if (customerF && customerF !== BLANK && !p.options.some(o => o.key === customerF)) {
      p.options = [...p.options, { key: customerF, label: customerFLabel || customerF }];
    }
    if (customerF === BLANK) p.hasBlank = true;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRows, fromDate, toDate, companyF, customerF, customerFLabel]);

  /** "Anything narrowing the screen" — the search box included, because the one
   *  button that says it will show everything again has to mean it. */
  const filtersOn = !!(fromDate || toDate || companyF || customerF || search.trim());
  const clearFilters = () => {
    setFromDate(''); setToDate(''); setSearch('');
    setCompanyF('');  setCompanyFLabel('');
    setCustomerF(''); setCustomerFLabel('');
  };

  const q = search.trim().toLowerCase();
  /** Free-text search — the original three fields PLUS the two resolved names,
   *  so searching a contact person that only exists on the live sheet now works.
   *  Strictly additive: everything that matched before still matches. */
  const matchesSearch = (x: ResolvedRow) =>
    !q
    || (x.r.event_name || '').toLowerCase().includes(q)
    || (x.r.customer   || '').toLowerCase().includes(q)
    || (x.r.req_number || '').toLowerCase().includes(q)
    || x.company.toLowerCase().includes(q)
    || x.customer.toLowerCase().includes(q);

  /** Flat-list rows: filters + search, both row-by-row. */
  const filtered = useMemo(
    () => rows.filter(x => passesFilters(x) && matchesSearch(x)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fromDate, toDate, companyF, customerF, q],
  );
  /** What the rows on screen add up to. A date RANGE is only worth having if
   *  the screen does the adding — otherwise "this week" still means the owner
   *  running his finger down 35 figures. Rounded per row, then added, so it
   *  equals the column above it to the rupee. */
  const filteredTotals = useMemo(() => filtered.reduce(
    (a, x) => ({ cost: a.cost + Math.round(Number(x.r.estimated_value) || 0),
                 items: a.items + (Number(x.r.item_count) || 0) }),
    { cost: 0, items: 0 },
  ), [filtered]);

  /* ── R2: event-wise grouping ─────────────────────────────────────────────
   * One card per banquet, every department's requisition underneath it.
   *
   * Filters are applied at EVENT level, not row level: a date, a company and a
   * customer all belong to the event, not to one department's requisition. So
   * a matching event is always shown WHOLE — which means the ₹ total on the
   * card is always the real total for that event, never "the total of the rows
   * that survived a filter". That distinction is the whole reason the owner
   * wants this screen, so it must not be able to lie.
   */
  const groups = useMemo<EventGroup[]>(() => {
    /* What makes two requisitions the same party.
     *
     * Normally the contact name + the party date, matched ignoring case and
     * double spaces — /party-approvals and /api/party-events pair the same two
     * fields, this one is just not fooled by "Rao,  Venkat".
     *
     * When the name is BLANK there is nothing to match on, and matching blank
     * to blank is not a guess, it is a certainty of being wrong: every nameless
     * requisition on one date would become one card, adding up unrelated
     * parties under whichever company happened to come first. So a nameless
     * requisition is matched on its COMPANY instead, and a requisition with
     * neither name nor company stands alone as its own card. */
    const groupKeyFor = (x: ResolvedRow) => {
      const date = (x.r.event_date || '').trim();
      // The name SAVED ON THE REQUISITION, never the one resolved from the live
      // sheet. The sheet lookup succeeds per row (by fp id, or by company +
      // date) and a department that left the company blank would miss it — so
      // keying on the resolved name could split one banquet in two the day the
      // sheet answers for some of its departments and not the others. The card
      // still SHOWS the live name; only the matching is kept local.
      const name = foldName(x.r.event_name);
      if (name) return `n:${name}|${date}`;
      const co = foldCompany(x.company);
      if (co) return `c:${co}|${date}`;
      return `r:${x.r.id}`;
    };
    const map = new Map<string, EventGroup>();
    for (const x of evRows) {
      const key = groupKeyFor(x);
      let g = map.get(key);
      if (!g) {
        g = {
          event_key: key,
          event_name: (x.r.event_name || '').trim(),
          event_date: (x.r.event_date || '').trim(),
          company: '',
          customer: '',
          guest_count: null,
          guest_count_varies: false,
          rows: [],
          total_cost: 0,
          total_items: 0,
          draft_cost: 0,
          depts: [],
          submitted_count: 0,
          pending_mgmt_count: 0,
          approved_count: 0,
        };
        map.set(key, g);
      }
      g.rows.push(x);
      // Rounded PER ROW, then added — the same arithmetic the eye does down the
      // Est. cost column. Adding first and rounding once would print a total
      // the visible column does not reach, on more than half of his parties.
      const cost = Math.round(Number(x.r.estimated_value) || 0);
      g.total_cost  += cost;
      g.total_items += Number(x.r.item_count) || 0;
      if (x.r.status === 'draft') g.draft_cost += cost;
      // Approval state, counted exactly as /party-approvals counts it: with the
      // Management gate OFF, chef-approved is already with the store.
      if (x.r.status === 'submitted') g.submitted_count += 1;
      if (x.r.status === 'chef_approved') {
        if (requireMgmt) g.pending_mgmt_count += 1; else g.approved_count += 1;
      }
      if (x.r.status === 'mgmt_approved' || x.r.status === 'store_processed' || x.r.status === 'fulfilled') {
        g.approved_count += 1;
      }
      // One department can raise TWO requisitions for one party, so the header
      // line counts them instead of printing the name twice.
      const dn = x.r.department_name || '';
      if (dn) {
        const hit = g.depts.find(d => d.name === dn);
        if (hit) hit.count += 1; else g.depts.push({ name: dn, count: 1 });
      }
      // Take the first NON-BLANK value rather than blindly the first row's —
      // otherwise one department leaving the company blank would blank it for
      // the whole event.
      if (!g.company  && x.company)  g.company  = x.company;
      if (!g.customer && x.customer) g.customer = x.customer;
      const gc = Number(x.r.guest_count) || 0;
      if (gc > 0) {
        if (g.guest_count == null) g.guest_count = gc;
        else if (g.guest_count !== gc) g.guest_count_varies = true;
      }
    }
    // Most recent party first — the same direction as the flat list, so
    // switching between the two views does not turn the screen upside down and
    // open on a party from two months ago. Undated last rather than first: an
    // empty string sorts before every real date, which would push the rows we
    // know least about to the top.
    return Array.from(map.values()).sort((a, b) => {
      if (!a.event_date && !b.event_date) return a.customer.localeCompare(b.customer);
      if (!a.event_date) return 1;
      if (!b.event_date) return -1;
      return b.event_date.localeCompare(a.event_date);
    });
  }, [evRows, requireMgmt]);

  /** Events that survive the filters. An event matches the pickers when ANY of
   *  its requisitions does (they all share the event's date/company/customer),
   *  and matches the search when any requisition in it does — so typing a
   *  single Req # finds the event that requisition belongs to. */
  const filteredGroups = useMemo(
    () => groups.filter(g => g.rows.some(passesFilters) && g.rows.some(matchesSearch)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, fromDate, toDate, companyF, customerF, q],
  );

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
        {/* R2 view toggle. Two plain words, because the owner reads this at a
            tablet on the floor. The flat list is the default — it is what
            everyone uses today and nothing about it changes.
            The "By event" half only appears for Admins and HODs; that is a
            HINT so staff aren't shown a button that would refuse them. The
            real gate is the server's 403 on ?view=events. */}
        {canSeeEventView && (
          <div className="inline-flex rounded border border-[#D4B896] overflow-hidden" role="group"
               aria-label="Choose how to view party requisitions">
            <button onClick={() => setView('list')}
                    aria-pressed={view === 'list'}
                    title="One row per department requisition — the usual list"
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${
                      view === 'list' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              <LayoutList size={14} /> List
            </button>
            <button onClick={() => setView('events')}
                    aria-pressed={view === 'events'}
                    title="One card per party, with every department's requisition and the total cost of that party"
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-l border-[#D4B896] ${
                      view === 'events' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              <ListChecks size={14} /> By event
            </button>
          </div>
        )}
        <a href="/party-events"
           className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-sm">
          <PartyPopper size={14} /> Go to Party Events
        </a>
      </div>

      {/* Server refused the event view (or it could not be reached). Shown on
          the flat list, which is where we put the user back. */}
      {eventViewOk === false && eventViewMsg && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded p-2 text-xs flex items-center justify-between gap-2">
          <span><AlertTriangle size={12} className="inline mr-1" />{eventViewMsg}</span>
          <button onClick={() => setEventViewMsg('')} className="text-amber-800 hover:text-amber-950"><X size={12} /></button>
        </div>
      )}

      {fpError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs flex items-center justify-between">
          <span>{fpError}</span>
          <button onClick={() => setFpError(null)} className="text-red-700 hover:text-red-900"><X size={12} /></button>
        </div>
      )}

      {/* ── Search + the three filters ──────────────────────────────────────
          R1. Company and Customer are pickers built from the names that are
          actually on the loaded requisitions — nobody should have to spell
          "Biopulse Solutions Private Limited" to find it. Date is a RANGE,
          not one day: parties bunch onto a handful of dates, so "the 16th" is
          one question but "this week" is the one that needs costs added up,
          and a range answers both (set From and To to the same day for one
          date). Plain <select> on purpose — on a tablet it opens the device's
          own scrollable picker, which handles 40-character company names
          better than any dropdown we could draw. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-[#8B7355] shrink-0" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search by event name, customer, company or req #…"
                 className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent focus:outline-none" />
          <span className="text-xs text-[#8B7355] whitespace-nowrap">
            {view === 'events'
              ? `${filteredGroups.length} of ${groups.length} parties`
              : `${filtered.length} of ${list.length}`}
          </span>
        </div>

        <div className="border-t border-[#E8D5C4]/60 pt-2.5 flex items-start gap-x-5 gap-y-3 flex-wrap">
          {/* Date range */}
          <div className="min-w-0">
            <label className="block text-[10px] text-[#8B7355] mb-1 font-medium">
              <CalendarDays size={10} className="inline mr-1" />Party date
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                     title="Show parties on or after this date"
                     className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white" />
              <span className="text-[10px] text-[#8B7355]">to</span>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                     title="Show parties on or before this date"
                     className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white" />
            </div>
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {[
                { label: 'This month',   from: monthStart(), to: '' },
                { label: 'Next 30 days', from: today(),      to: daysFromNow(30) },
                { label: 'Any date',     from: '',           to: '' },
              ].map(c => (
                <button key={c.label}
                        onClick={() => { setFromDate(c.from); setToDate(c.to); }}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]">
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Company */}
          <div className="min-w-0">
            <label className="block text-[10px] text-[#8B7355] mb-1 font-medium">
              <Building2 size={10} className="inline mr-1" />Company name
            </label>
            <select value={companyF}
                    onChange={e => { setCompanyF(e.target.value); setCompanyFLabel(e.target.selectedOptions[0]?.text || ''); }}
                    title="Only the companies that appear on these requisitions"
                    className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white w-[220px] max-w-full">
              <option value="">All companies</option>
              {companyPick.hasBlank && <option value={BLANK}>(no company filled in)</option>}
              {companyPick.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>

          {/* Customer */}
          <div className="min-w-0">
            <label className="block text-[10px] text-[#8B7355] mb-1 font-medium">
              <Users size={10} className="inline mr-1" />Customer name
            </label>
            <select value={customerF}
                    onChange={e => { setCustomerF(e.target.value); setCustomerFLabel(e.target.selectedOptions[0]?.text || ''); }}
                    title="Only the customers that appear on these requisitions"
                    className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white w-[220px] max-w-full">
              <option value="">All customers</option>
              {customerPick.hasBlank && <option value={BLANK}>(no customer filled in)</option>}
              {customerPick.options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>

          {filtersOn && (
            <button onClick={clearFilters}
                    title="Empty the search box and all three filters, and show everything again"
                    className="self-end text-xs px-2.5 py-1 rounded border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3]">
              {search.trim() ? 'Clear search & filters' : 'Clear filters'}
            </button>
          )}
        </div>

        {/* Requisitions with no date anywhere on them cannot be inside a date
            window, so a date filter holds them back — said out loud, with a way
            straight to them, rather than letting them vanish. */}
        {undatedHeldBack > 0 && (
          <div className="text-[11px] text-[#8B7355] border-t border-[#E8D5C4]/60 pt-2">
            {undatedHeldBack} requisition{undatedHeldBack === 1 ? ' has' : 's have'} no date on
            {undatedHeldBack === 1 ? ' it' : ' them'} at all, so {undatedHeldBack === 1 ? 'it is' : 'they are'} not
            shown while a date is set.{' '}
            <button onClick={() => { setFromDate(''); setToDate(''); }} className="text-[#af4408] underline">
              Show any date
            </button>
          </div>
        )}
      </div>

      {/* ── Flat list — unchanged, and still the default view for everyone ── */}
      {view === 'list' && (
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            {list.length === 0
              ? 'No party requisitions yet. Open the Party Events page and click "Raise Req" on a party to create one.'
              : <>Nothing matches what you picked. <button onClick={clearFilters} className="text-[#af4408] underline">Show everything</button></>}
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
              {filtered.map(x => {
                const r = x.r;
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
                  {/* Resolved ONCE in resolveRow() so this cell and the
                      Customer / Company pickers can never disagree. */}
                  <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">
                    {x.sameAsCo
                      ? <span className="text-[#C0A98F] italic" title={`No separate contact person on the AKAN Party Manager sheet — Column P (Contact Person) is blank or equals the Company in Column N (${x.company}).`}>— (same as company)</span>
                      : (x.customer || '—')}
                    {x.liveContact && x.liveContact !== x.stored && (
                      <span title="Pulled live from the sheet's Column P (Contact Person). The saved value on this requisition was different." className="ml-1 text-[9px] text-[#8B7355]">↻</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-[#6B5744]">{x.company || '—'}</td>
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
                      <ReqItemsDetail detail={detail} loading={isLoadingDetail} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
            {/* What is on screen, added up — so a date range answers "what do
                this week's parties cost me" without hand-adding the column. */}
            <tfoot>
              <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0]">
                <td className="py-2 px-3 font-medium text-[#6B5744]" colSpan={7}>
                  Total of the {filtered.length} requisition{filtered.length === 1 ? '' : 's'} shown
                </td>
                <td className="py-2 px-3 text-right font-mono font-semibold">{filteredTotals.items}</td>
                <td className="py-2 px-3 text-right font-mono font-semibold text-[#2D1B0E]">{fmt(filteredTotals.cost)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
          </div>
        )}
      </div>
      )}

      {/* ── R2: event-wise view ─────────────────────────────────────────────
          One card per party, every department's requisition underneath it,
          and the cost of the whole party on the header line. Deliberately the
          same shape, the same colours and the same expand/collapse as
          /party-approvals — the owner asked for that screen by name, so this
          should read as the same app, not a second take on the idea. */}
      {view === 'events' && (
        loading || eventViewOk === null ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Loading…
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
            {groups.length === 0
              ? 'No party requisitions yet. Open the Party Events page and click "Raise Req" on a party to create one.'
              : <>No parties match what you picked. <button onClick={clearFilters} className="text-[#af4408] underline">Show everything</button></>}
          </div>
        ) : (
          <div className="space-y-3">
            {/* The server said this viewer only sees SOME of each party's
                requisitions. Summing those would print a party costing
                ₹80,000 across five kitchens as ₹12,000, so the cards below
                say "your requisitions" and never claim to be the party total. */}
            {!totalsComplete && (
              <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-2.5 text-xs">
                <AlertTriangle size={12} className="inline mr-1" />
                You can only see the requisitions you raised, so these totals are
                <strong> your requisitions only</strong> — not the full cost of each party.
                Ask an admin for access to every department if you need the real party totals.
              </div>
            )}
            {/* The cards deliberately carry MORE than this viewer's own list.
                Saying so is the difference between a helpful screen and a
                worrying one ("why does the list say 1 and this say 6?"). */}
            {totalsComplete && widerThanList && (
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] text-[#6B5744] rounded-lg p-2.5 text-xs">
                These cards show <strong>every department&apos;s</strong> requisition for each party, so the
                totals are the real cost of the party. The list view still shows only the requisitions
                you normally see.
              </div>
            )}
            {filteredGroups.map(g => {
              const isOpen = openEvents.has(g.event_key);
              // ONE number, added up from the rows printed on the card below —
              // there is no second source that could disagree with them, and
              // nothing here can be older than the rows it totals.
              const total = g.total_cost;
              const deptNames = g.depts.map(d => d.count > 1 ? `${d.name} ×${d.count}` : d.name).join(' · ');
              return (
                <div key={g.event_key} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                  {/* Header strip — whole strip is the click target, exactly as
                      on /party-approvals. */}
                  <div className="px-4 py-3 bg-[#FFF1E3] flex items-center gap-3 flex-wrap cursor-pointer hover:bg-[#FFE8D0]"
                       onClick={() => toggleEvent(g.event_key)}>
                    <button className="text-[#6B5744]" aria-label={isOpen ? 'Collapse' : 'Expand'}>
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <PartyPopper size={16} className="text-[#af4408]" />
                    {/* min-w-0 lets a 40-character company name truncate instead
                        of shoving the ₹ total off a tablet screen. */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[#2D1B0E] truncate">
                        {g.customer || <span className="text-[#C0A98F] italic">No customer name</span>}
                        <span className="text-[#8B7355] text-xs font-normal ml-2">
                          {g.event_date || 'no date on the requisition'}
                        </span>
                        {g.guest_count != null && (
                          <span className="text-[#8B7355] text-xs font-normal ml-2"
                                title={g.guest_count_varies
                                  ? 'Departments typed different guest counts for this party — showing the first one.'
                                  : undefined}>
                            · {g.guest_count} guests{g.guest_count_varies && ' ⚠'}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#8B7355] truncate">
                        {g.company || <span className="italic">No company name</span>}
                      </div>
                      {/* The departments, without having to expand — this is the
                          question the owner is actually asking the screen: what
                          did this one banquet cost across Operations + Indian +
                          Tandoor + Continental + Asian. One requisition is one
                          department, so the count is not repeated as a chip. */}
                      <div className="text-[10px] text-[#B8A590] truncate" title={deptNames}>
                        {deptNames}
                      </div>
                    </div>
                    {/* On a tablet this whole block drops onto its own line and
                        sits at the LEFT — the floating alert bell parks itself
                        against the right edge at half height, and the one number
                        on this screen that must always be readable is the ₹. On
                        a desktop it goes back to the right of the strip. */}
                    <div className="basis-full lg:basis-auto pr-14 lg:pr-0 flex items-center justify-start lg:justify-end gap-3 flex-wrap">
                      <div className="text-xs text-[#6B5744]">
                        {g.rows.length} requisition{g.rows.length === 1 ? '' : 's'}
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-[#FFF8F0] border border-[#E8D5C4]">
                          {g.total_items} item{g.total_items === 1 ? '' : 's'}
                        </span>
                        {/* Where the party has got to, without opening it —
                            the same three counts as /party-approvals. */}
                        {g.submitted_count > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                                title="Waiting for the Head of Department to approve">
                            {g.submitted_count} with HOD
                          </span>
                        )}
                        {g.pending_mgmt_count > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800"
                                title="HOD-approved — waiting for Management approval">
                            {g.pending_mgmt_count} with mgmt
                          </span>
                        )}
                        {g.approved_count > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800"
                                title="Approved — with the store, part-issued or fulfilled">
                            {g.approved_count} approved
                          </span>
                        )}
                        {g.draft_cost > 0 && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 text-gray-700"
                                title="Still a draft — nobody has submitted it yet, and it is included in the total">
                            {fmt(g.draft_cost)} still draft
                          </span>
                        )}
                      </div>
                      <div className="text-left lg:text-right">
                        <div className="text-sm font-mono font-semibold text-[#2D1B0E]">{fmt(total)}</div>
                        <div className="text-[9px] text-[#8B7355]">
                          {totalsComplete ? 'whole party' : 'your requisitions only'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs min-w-[640px]">
                        <thead className="bg-white border-b border-[#E8D5C4] text-[#6B5744]">
                          <tr>
                            <th className="text-left  py-2 px-3 font-medium">Req #</th>
                            <th className="text-left  py-2 px-3 font-medium">Department</th>
                            <th className="text-left  py-2 px-3 font-medium">Raised by</th>
                            <th className="text-right py-2 px-3 font-medium">Items</th>
                            <th className="text-right py-2 px-3 font-medium">Est. cost</th>
                            <th className="text-left  py-2 px-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* THE THIRD LEVEL. Party → its departments'
                              requisitions → what was actually asked for.
                              Clicking a Req # opens the SAME items block the
                              flat list opens (ReqItemsDetail), off the SAME
                              cache — so a requisition already opened in the
                              list is already loaded here, and the two views can
                              never show one requisition two ways. */}
                          {g.rows.map(x => {
                            const rowOpen = expanded.has(x.r.id);
                            return (
                            <Fragment key={x.r.id}>
                            <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                              <td className="py-1.5 px-3 font-mono text-[#af4408]">
                                <button onClick={() => toggleExpand(x.r.id)}
                                        title={rowOpen ? 'Hide the items on this requisition' : 'See the items on this requisition'}
                                        className="inline-flex items-center gap-1 hover:underline">
                                  {rowOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  {x.r.req_number}
                                </button>
                              </td>
                              <td className="py-1.5 px-3 text-[#2D1B0E]">
                                {x.r.department_code && (
                                  <span className="text-[10px] font-mono text-[#8B7355] mr-1">[{x.r.department_code}]</span>
                                )}
                                {x.r.department_name}
                              </td>
                              <td className="py-1.5 px-3 text-[10px] text-[#8B7355]">{x.r.drafted_by || '—'}</td>
                              <td className="py-1.5 px-3 text-right font-mono">{x.r.item_count || 0}</td>
                              <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(x.r.estimated_value || 0)}</td>
                              <td className="py-1.5 px-3">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_TONE[x.r.status] || 'bg-gray-100 text-gray-700'}`}>
                                  {x.r.status.replace(/_/g, ' ')}
                                </span>
                              </td>
                            </tr>
                            {rowOpen && (
                              <tr className="bg-[#FFF8F0] border-t border-[#E8D5C4]/30">
                                <td colSpan={6} className="py-3 px-6">
                                  <ReqItemsDetail detail={detailsById[x.r.id]} loading={detailLoading.has(x.r.id)} />
                                </td>
                              </tr>
                            )}
                            </Fragment>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0]">
                            <td className="py-2 px-3 font-medium text-[#6B5744]" colSpan={3}>
                              {totalsComplete ? 'Total for this party' : 'Total of your requisitions'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono font-semibold">{g.total_items}</td>
                            <td className="py-2 px-3 text-right font-mono font-semibold text-[#2D1B0E]">{fmt(total)}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

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
