'use client';

/**
 * Requisitions — internal department workflow.
 *
 *   draft → submitted → chef_approved → store_processed → fulfilled
 *                    ↘  chef_rejected
 *
 * The page renders a single list with status filters and inline expansion.
 * Action buttons appear contextually based on (status, viewer permissions).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList, Plus, Trash2, Send, CheckCircle2, XCircle, Package,
  AlertTriangle, ChevronDown, ChevronRight, Loader2, Upload, Search, X, Eye, Pencil,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import MaterialTypeahead from '@/components/MaterialTypeahead';

const fmt = (v: number) => '₹' + (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

interface Material {
  id: string; name: string; sku?: string; unit: string;
  current_stock: number; average_price: number;
  last_purchase_price?: number; last_purchase_date?: string;
  reorder_level?: number;        // a.k.a. buffer stock per Phase 1 §2
  purchase_unit?: string; pack_size?: number;
  category?: string;
}
interface Department { id: string; name: string; code?: string; }
interface ReqItem {
  id: string; req_id: string; material_id: string;
  material_name: string; material_sku?: string; material_unit: string;
  /** Unit the department REQUESTED in (recipe unit or purchase unit, e.g. 'BTL').
   *  quantity_requested / chef_approved_qty / quantity_issued are all in THIS unit. */
  unit?: string;
  material_purchase_unit?: string; material_pack_size?: number;
  quantity_requested: number; quantity_issued: number; quantity_to_purchase: number;
  current_stock: number; average_price: number; last_purchase_price?: number; notes: string;
  /** Chef-edited approval qty (overrides quantity_requested if set). NULL = no edit. */
  chef_approved_qty?: number | null;
  /** Chef explicitly rejected this line — store will skip it during issue. */
  is_rejected?: number | boolean;
  /** Chef's per-line note ("over budget", "out of season", etc.). */
  chef_note?: string;
}
interface Requisition {
  id: string; req_number: string;
  department_id: string; department_name: string; department_code?: string;
  date: string; status: string; notes: string;
  /** 'internal' (kitchen restock) or 'party' (for a specific event). Drives whether
   *  the "For Party" column shows host + company + event date or just a dash. */
  purpose?: 'internal' | 'party' | string;
  /** Host name (guest_name on the FP), populated only for party reqs. */
  event_name?: string;
  /** Company name (guest_company on the FP), populated only for party reqs. */
  customer?: string;
  /** Event date (ISO) — when the party is happening. Useful to spot last-minute reqs. */
  event_date?: string;
  /** Headcount the party is being cooked for. */
  guest_count?: number;
  drafted_by: string; submitted_at?: string; submitted_by?: string;
  chef_approved_at?: string; chef_approved_by?: string; chef_note?: string;
  mgmt_approved_at?: string; mgmt_approved_by?: string; mgmt_note?: string;
  dept_acknowledged_at?: string; dept_acknowledged_by?: string; dept_ack_note?: string;
  rejected_at?: string; rejected_by?: string; rejected_reason?: string;
  store_processed_at?: string; store_processed_by?: string; store_note?: string;
  linked_po_id?: string | null; linked_po_number?: string | null; linked_po_status?: string | null;
  fulfilled_at?: string;
  item_count?: number; estimated_value?: number;
  items?: ReqItem[];
}

/** Unit a line was REQUESTED in (legacy rows without ri.unit fall back to the
 *  material's recipe unit — identical behaviour to before the UOM selector). */
function reqUnit(it: ReqItem): string {
  return it.unit || it.material_unit;
}
/** Recipe-units per 1 requested-unit: pack_size when the request was made in the
 *  material's PURCHASE unit (e.g. 1 BTL = 750 ml), else 1. Multiply a requested
 *  qty by this to compare it against current_stock (always in recipe units). */
function reqPackFactor(it: ReqItem): number {
  const pack = Number(it.material_pack_size) || 1;
  return (it.unit && it.material_purchase_unit && it.unit === it.material_purchase_unit && it.unit !== it.material_unit && pack > 1)
    ? pack : 1;
}

const STATUS_BADGE: Record<string, string> = {
  draft:           'bg-[#E8D5C4] text-[#6B5744]',
  submitted:       'bg-amber-100 text-amber-800',
  chef_approved:   'bg-blue-100 text-blue-800',
  mgmt_approved:   'bg-indigo-100 text-indigo-800',
  chef_rejected:   'bg-red-100 text-red-700',
  store_processed: 'bg-purple-100 text-purple-800',
  fulfilled:       'bg-emerald-100 text-emerald-700',
  cancelled:       'bg-[#E8D5C4] text-[#6B5744]',
};
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', submitted: 'With HOD',
  chef_approved: 'With Mgmt', mgmt_approved: 'With Store',
  chef_rejected: 'Rejected', store_processed: 'Issued (partial)', fulfilled: 'Fulfilled', cancelled: 'Cancelled',
};

/**
 * Render children at the end of document.body via a React portal.
 *
 * The Mgmt/Chef/Store modals on this page live inside an expanded requisition
 * row (`<tr><td colSpan>...</td></tr>`). Putting a `position: fixed` overlay
 * inside a `<td>` triggers HTML-parser fix-ups and layout thrash in some
 * browsers — the modal would flicker open/close as the table re-laid out.
 * Portaling to body lifts the modal out of the table context entirely, so
 * `position: fixed` resolves against the viewport as intended.
 */
function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

export default function RequisitionsPage() {
  const [reqs, setReqs] = useState<Requisition[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // Draft being edited — when set, the create modal opens in edit mode (PUT).
  const [editDraft, setEditDraft] = useState<Requisition | null>(null);
  // Full user record — viewer (from list endpoint) only carries permission
  // flags; we need department_id + is_head_chef + is_store_manager to decide
  // whether the dept selector in the create modal should be locked.
  const [me, setMe] = useState<{
    role?: string; email?: string; department_id?: string | null;
    is_head_chef?: boolean; is_store_manager?: boolean;
    visible_department_ids?: string | null;
  } | null>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);
  // Mgmt-approval setting — when OFF, the Mgmt inbox banner and tab on this
  // page should disappear entirely (chef approval is the only gate). When ON,
  // legacy Chef → Mgmt → Store flow applies and the indigo banner reappears.
  const [requireMgmt, setRequireMgmt] = useState(false);
  useEffect(() => {
    fetch('/api/admin/party-rules').then(r => r.json()).then(d => {
      setRequireMgmt(d?.require_mgmt_approval === true);
    }).catch(() => {});
  }, []);
  const [importing, setImporting] = useState(false);
  const [viewer, setViewer] = useState<{ email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean }>({
    email: '', role: '', can_chef: false, can_mgmt: false, can_store: false, can_issue: false,
  });

  const reload = async () => {
    setLoading(true);
    const [r, d, m] = await Promise.all([
      fetch('/api/requisitions').then(r => r.json()),
      fetch('/api/departments').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()).catch(() => ({ materials: [] })),
    ]);
    setReqs(r.requisitions || []);
    setDepartments((d.departments || []).filter((x: any) => x.is_active));
    setMaterials(m.materials || []);
    setViewer({
      email: r.viewer_email || '', role: r.viewer_role || '',
      can_chef: !!r.viewer_can_approve_chef, can_mgmt: !!r.viewer_can_approve_mgmt, can_store: !!r.viewer_can_process_store,
      can_issue: !!r.viewer_can_issue_store,
    });
    setLoading(false);
  };
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return reqs;
    // "Open" = awaiting an approval / decision. store_processed (partially
    // issued) is NOT open — the store has already acted on it; it's mid-flight.
    // It has its own dedicated tab below ("Partially Issued").
    if (statusFilter === 'open') return reqs.filter(r => !['fulfilled', 'cancelled', 'chef_rejected', 'store_processed'].includes(r.status));
    if (statusFilter === 'inbox-chef')  return reqs.filter(r => r.status === 'submitted');
    if (statusFilter === 'inbox-mgmt')  return reqs.filter(r => r.status === 'chef_approved');
    // Store inbox includes partially-issued so the store can find a req they
    // started but didn't finish — otherwise it would vanish after first issue.
    if (statusFilter === 'inbox-store') return reqs.filter(r => ['mgmt_approved', 'chef_approved', 'store_processed'].includes(r.status));
    if (statusFilter === 'partially-issued') return reqs.filter(r => r.status === 'store_processed');
    return reqs.filter(r => r.status === statusFilter);
  }, [reqs, statusFilter]);

  const counts = useMemo(() => ({
    inbox_chef:  reqs.filter(r => r.status === 'submitted').length,
    inbox_mgmt:  reqs.filter(r => r.status === 'chef_approved').length,
    inbox_store: reqs.filter(r => ['mgmt_approved', 'chef_approved', 'store_processed'].includes(r.status)).length,
    // partially-issued is its own bucket — keep it out of `open`.
    partially_issued: reqs.filter(r => r.status === 'store_processed').length,
    open:        reqs.filter(r => !['fulfilled', 'cancelled', 'chef_rejected', 'store_processed'].includes(r.status)).length,
  }), [reqs]);

  const toggleExpand = (id: string) => setExpanded(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ClipboardList className="w-7 h-7 text-[#af4408]" />
          <div>
            <h1 className="text-2xl font-bold text-[#2D1B0E]">Department Requisitions</h1>
            <p className="text-xs text-[#6B5744]">Internal stock requests → HOD (Head of Department) → Store Manager → Vendor PO (admin approves) → Fulfilled.</p>
          </div>
        </div>
        <div className="flex gap-2">
          {viewer.role === 'admin' && (
            <button onClick={() => setImporting(true)}
                    className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
              <Upload className="w-4 h-4" /> Import Recaho Transfers
            </button>
          )}
          <button onClick={() => setCreating(true)}
                  className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> Raise Requisition
          </button>
        </div>
      </div>

      {/* Inbox call-outs */}
      {(viewer.can_chef && counts.inbox_chef > 0) && (
        <div className="mb-3 px-4 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {counts.inbox_chef} requisition(s) waiting for your chef approval.
          <button onClick={() => setStatusFilter('inbox-chef')} className="ml-auto underline">Review</button>
        </div>
      )}
      {/* Mgmt callout only when the gate is ON. When OFF, chef approval is the
          final gate and there's no Mgmt action to take here. */}
      {(requireMgmt && viewer.can_mgmt && counts.inbox_mgmt > 0) && (
        <div className="mb-3 px-4 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {counts.inbox_mgmt} HOD-approved requisition(s) waiting for Management approval.
          <button onClick={() => setStatusFilter('inbox-mgmt')} className="ml-auto underline">Approve</button>
        </div>
      )}
      {(viewer.can_store && counts.inbox_store > 0) && (
        <div className="mb-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 flex items-center gap-2">
          <Package className="w-4 h-4" />
          {counts.inbox_store} {requireMgmt ? 'mgmt-approved' : 'HOD-approved'} requisition(s) for store to process.
          <button onClick={() => setStatusFilter('inbox-store')} className="ml-auto underline">Process</button>
        </div>
      )}

      {/* View-only context banner — fires when a user without approval rights
          (typically the Store Manager) lands on the Chef or Mgmt inbox. Lets
          them see what's in the queue without confusing them about why the
          Approve / Reject buttons don't appear. */}
      {((statusFilter === 'inbox-chef' && !viewer.can_chef) ||
        (statusFilter === 'inbox-mgmt' && !viewer.can_mgmt)) && (
        <div className="mb-3 px-3 py-1.5 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-[11px] text-[#6B5744] flex items-center gap-2">
          <Eye className="w-3.5 h-3.5" />
          <span>
            <b>View only.</b> This is the {statusFilter === 'inbox-chef' ? 'HOD\'s' : 'Management\'s'} approval queue —
            you can see what's pending but the action buttons (Approve / Reject) are gated to that role.
          </span>
        </div>
      )}

      {/* Filters. The Mgmt Inbox tab only appears when the Mgmt-approval gate
          is enabled on Settings → Integrations — otherwise it's noise. */}
      <div className="flex flex-wrap gap-1 mb-3 text-xs">
        {[
          { k: 'all', l: 'All' }, { k: 'open', l: `Open (${counts.open})` },
          { k: 'inbox-chef', l: `HOD Inbox (${counts.inbox_chef})` },
          ...(requireMgmt ? [{ k: 'inbox-mgmt', l: `Mgmt Inbox (${counts.inbox_mgmt})` }] : []),
          { k: 'inbox-store', l: `Store Inbox (${counts.inbox_store})` },
          // "Partially issued" only appears when there's at least one — saves
          // tab-row noise when everything is either pending or fully issued.
          ...(counts.partially_issued > 0
            ? [{ k: 'partially-issued', l: `Partially Issued (${counts.partially_issued})` }]
            : []),
          { k: 'draft', l: 'Drafts' }, { k: 'fulfilled', l: 'Fulfilled' },
          { k: 'chef_rejected', l: 'Rejected' },
        ].map(o => (
          <button key={o.k} onClick={() => setStatusFilter(o.k)}
                  className={`px-2.5 py-1 rounded ${statusFilter === o.k ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
            {o.l}
          </button>
        ))}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-[#8B7355]">
            <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No requisitions{statusFilter !== 'all' ? ' matching that filter' : ''}.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left py-2 px-3 font-medium">Requisition #</th>
                <th className="text-left py-2 px-3 font-medium">Department</th>
                <th className="text-left py-2 px-3 font-medium" title="For party requisitions: host name + company. Internal kitchen reqs show '—'.">For Party</th>
                <th className="text-left py-2 px-3 font-medium">Date</th>
                <th className="text-right py-2 px-3 font-medium">Items</th>
                <th className="text-right py-2 px-3 font-medium">Est. Value</th>
                <th className="text-left py-2 px-3 font-medium">Status</th>
                <th className="text-left py-2 px-3 font-medium">Linked PO</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <RequisitionRow key={r.id} r={r}
                                expanded={expanded.has(r.id)}
                                onToggle={() => toggleExpand(r.id)}
                                materials={materials}
                                viewer={viewer}
                                requireMgmt={requireMgmt}
                                reload={reload}
                                onEdit={(draft) => { setEditDraft(draft); setCreating(true); }} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateRequisitionModal departments={departments} materials={materials}
                                me={me}
                                editDraft={editDraft}
                                onClose={() => { setCreating(false); setEditDraft(null); }}
                                onCreated={reload} />
      )}
      {importing && (
        <RecahoImportModal onClose={() => setImporting(false)} onCommitted={reload} />
      )}
    </div>
  );
}

/* ============================================================ */
/* Import past transfers from a Recaho "Transfer sales report"   */
/* ============================================================ */
function RecahoImportModal({ onClose, onCommitted }: { onClose: () => void; onCommitted: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [committedSummary, setCommittedSummary] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (mode: 'preview' | 'commit' | 'departments' | 'materials') => {
    if (!file) { alert('Pick a Recaho .xlsx first'); return; }
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      if (mode === 'commit')      fd.set('commit', 'true');
      if (mode === 'departments') fd.set('departments_only', 'true');
      if (mode === 'materials')   fd.set('materials_only', 'true');
      const r = await api('/api/requisitions-import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (mode === 'commit') { setCommittedSummary(j); onCommitted(); }
      else if (mode === 'departments' || mode === 'materials') {
        // Re-run the preview so badges/counts refresh in place.
        const fd2 = new FormData(); fd2.set('file', file);
        const r2 = await api('/api/requisitions-import', { method: 'POST', body: fd2 });
        if (r2.ok) setPreview(await r2.json());
        onCommitted();
        if (mode === 'departments') {
          alert(`Created ${j.created_departments.length} department(s):\n` + (j.created_departments.join('\n') || '(none)'));
        } else {
          const head = j.created_materials.slice(0, 8).map((m: any) => `· ${m.name} (${m.unit}) ₹${m.price}`).join('\n');
          alert(`Created ${j.created_count} material(s) — flagged "auto-discovered" for review.\n\n${head}${j.created_count > 8 ? `\n…and ${j.created_count - 8} more` : ''}`);
        }
      } else { setPreview(j); }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2"><Upload className="w-5 h-5" /> Import Recaho Transfer Report</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <p className="text-[#6B5744] text-xs">
            Upload the <code className="px-1 py-0.5 bg-[#FFF1E3] rounded">Transfer sales report-detail</code> .xlsx
            from Recaho POS. Each <span className="font-mono">TRANSFER/SALE ID</span> becomes one Requisition (status:
            <span className="ml-1 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-medium">Fulfilled</span>).
            Departments not in our master will be auto-created. Items not in raw_materials will be skipped (and listed below).
          </p>

          <div className="flex items-center gap-2">
            <input type="file" accept=".xlsx,.xls"
                   onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setCommittedSummary(null); setError(null); }}
                   className="text-xs flex-1" />
            <button onClick={() => send('preview')} disabled={!file || busy || !!committedSummary}
                    className="px-3 py-1.5 text-xs bg-white border border-[#E8D5C4] rounded hover:bg-[#FFF1E3] disabled:opacity-50">
              {busy && !preview ? 'Parsing…' : 'Preview'}
            </button>
          </div>

          {/* Departments-only fast path — useful when masters aren't ready yet */}
          {preview && preview.missing_departments?.length > 0 && !committedSummary && (
            <div className="border border-amber-200 rounded-lg p-3 bg-amber-50/60 text-xs flex items-start gap-3">
              <div className="flex-1">
                <div className="font-semibold text-amber-900">
                  Just create departments? ({preview.missing_departments.length} new)
                </div>
                <div className="text-amber-800 mt-0.5">
                  Skip the transfer import for now and only seed the Departments page so you can assign HODs (Heads of Department) and Store Managers right away.
                </div>
              </div>
              <button onClick={() => send('departments')} disabled={busy}
                      className="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50">
                Create {preview.missing_departments.length} departments
              </button>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              {error}
            </div>
          )}

          {preview && !committedSummary && (
            <div className="border border-[#E8D5C4] rounded-lg p-3 space-y-2 bg-[#FFF8F0] text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[#6B5744]">
                <span><b>Sheet:</b> {preview.sheet}</span>
                <span><b>Date range:</b> {preview.date_min} → {preview.date_max}</span>
                <span><b>Transfers:</b> <span className="font-mono">{preview.group_count}</span> ({preview.line_count} item lines)</span>
                <span><b>New to import:</b> <span className="font-mono text-emerald-700">{preview.new_transfer_count}</span></span>
                {preview.skipped_existing_count > 0 && (
                  <span><b>Already imported:</b> <span className="font-mono text-[#8B7355]">{preview.skipped_existing_count}</span></span>
                )}
              </div>

              <div>
                <b>Departments found ({preview.departments.length}):</b>
                <div className="mt-1 flex flex-wrap gap-1">
                  {preview.departments.map((d: string) => {
                    const isNew = preview.missing_departments.includes(d);
                    return (
                      <span key={d} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        isNew
                          ? 'bg-amber-50 text-amber-800 border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}>
                        {isNew && '+ '}{d}
                      </span>
                    );
                  })}
                </div>
                {preview.missing_departments.length > 0 && (
                  <div className="text-[10px] text-amber-800 mt-1">
                    {preview.missing_departments.length} department(s) marked with <b>+</b> will be auto-created.
                  </div>
                )}
              </div>

              {preview.unmatched_item_count > 0 && (
                <div className="border border-amber-200 rounded-lg p-3 bg-amber-50/60">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="font-semibold text-amber-900">
                        ⚠ {preview.unmatched_item_count} unmatched item(s)
                      </div>
                      <div className="text-amber-800 mt-0.5">
                        These items appear in the file but aren't in your Materials master. Auto-create them now —
                        unit + category + price will be inferred from the file and each row gets flagged
                        <span className="font-mono mx-1 px-1 py-0.5 bg-amber-100 rounded text-[10px]">auto-discovered</span>
                        so you can review/correct them in <a href="/inventory" className="underline">Raw Materials</a>. The import is idempotent — re-uploading later picks up the now-matched lines.
                      </div>
                    </div>
                    <button onClick={() => send('materials')} disabled={busy}
                            className="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50">
                      Create {preview.unmatched_item_count} materials
                    </button>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] text-amber-800 hover:underline">Show item names</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto bg-white border border-[#E8D5C4] rounded p-2 text-[10px] text-[#6B5744] font-mono">
                      {preview.unmatched_items.map((n: string, i: number) => <div key={i}>· {n}</div>)}
                      {preview.unmatched_item_count > preview.unmatched_items.length && (
                        <div className="italic text-[#8B7355]">…and {preview.unmatched_item_count - preview.unmatched_items.length} more</div>
                      )}
                    </div>
                  </details>
                </div>
              )}

              {preview.sample_groups?.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-[#6B5744] font-medium">Sample of new transfers</summary>
                  <table className="w-full mt-1 text-[10px] font-mono">
                    <thead className="text-[#8B7355]"><tr>
                      <th className="text-left">Transfer ID</th><th className="text-left">Department</th>
                      <th className="text-left">Date</th><th className="text-right">Lines</th><th className="text-right">Total ₹</th>
                    </tr></thead>
                    <tbody>
                      {preview.sample_groups.map((s: any) => (
                        <tr key={s.transfer_id} className="border-t border-[#E8D5C4]/50">
                          <td>{s.transfer_id}</td><td>{s.department}</td><td>{s.date}</td>
                          <td className="text-right">{s.line_count}</td><td className="text-right">{s.total_amount.toLocaleString('en-IN')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}

              {/* Hard rule: imported transfers do not affect stock or recipe calculations. */}
              <div className="text-[11px] px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded text-[#6B5744]">
                <b>Internal transfers ≠ recipe consumption.</b> Imported transfers create requisitions for audit / department analytics only — they do <b>not</b> deduct stock and are <b>not</b> counted as consumption. Real consumption comes from recipe-deduction on sales, parties, staff meals, and closing-stock variance.
              </div>
            </div>
          )}

          {committedSummary && (
            <div className="border border-emerald-200 rounded-lg p-3 bg-emerald-50 text-xs space-y-1">
              <div className="font-semibold text-emerald-800">✓ Import committed</div>
              <ul className="text-emerald-900 space-y-0.5">
                <li>Created {committedSummary.summary.created_departments} departments</li>
                <li>Created {committedSummary.summary.created_requisitions} fulfilled requisitions</li>
                <li>Created {committedSummary.summary.created_lines} line items</li>
                {committedSummary.summary.skipped_existing > 0 && <li>Skipped {committedSummary.summary.skipped_existing} already-imported transfers</li>}
                {committedSummary.summary.skipped_unmatched_lines > 0 && <li>Skipped {committedSummary.summary.skipped_unmatched_lines} lines without a matching material</li>}
              </ul>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">{committedSummary ? 'Close' : 'Cancel'}</button>
          {preview && !committedSummary && (
            <button onClick={() => send('commit')} disabled={busy || preview.new_transfer_count === 0}
                    className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
              {busy ? 'Committing…' : <><CheckCircle2 className="w-4 h-4" /> Commit {preview.new_transfer_count} transfers</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
function RequisitionRow({ r, expanded, onToggle, materials, viewer, requireMgmt, reload, onEdit }: {
  r: Requisition; expanded: boolean; onToggle: () => void;
  materials: Material[];
  viewer: { email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean };
  requireMgmt: boolean;
  reload: () => void;
  onEdit: (draft: Requisition) => void;
}) {
  return (
    <>
      <tr className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/50">
        <td className="py-2 px-2 align-top">
          <button onClick={onToggle} className="text-[#6B5744]">
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </td>
        <td className="py-2 px-3 font-mono font-semibold text-[#2D1B0E]">{r.req_number}</td>
        <td className="py-2 px-3">
          <div className="text-[#2D1B0E]">{r.department_name}</div>
          {r.department_code && <div className="text-[10px] font-mono text-[#8B7355]">{r.department_code}</div>}
        </td>
        {/* For Party — host name + company + event date for party reqs.
            Internal kitchen reqs show a dash so the column stays scannable. */}
        <td className="py-2 px-3">
          {r.purpose === 'party' ? (
            <div>
              <div className="text-[#2D1B0E] font-medium">{r.event_name || <span className="text-[#C0A98F] italic">(no host name)</span>}</div>
              {r.customer && <div className="text-[10px] text-[#6B5744]">{r.customer}</div>}
              {r.event_date && (
                <div className="text-[10px] text-[#8B7355]">
                  Event: {r.event_date}{r.guest_count ? ` · ${r.guest_count} pax` : ''}
                </div>
              )}
            </div>
          ) : (
            <span className="text-[10px] text-[#8B7355]" title="Internal kitchen requisition — not tied to a specific party">— internal —</span>
          )}
        </td>
        <td className="py-2 px-3 text-[#6B5744]">{r.date}</td>
        <td className="py-2 px-3 text-right font-mono">{r.item_count || 0}</td>
        <td className="py-2 px-3 text-right font-mono text-[#6B5744]">{fmt(r.estimated_value || 0)}</td>
        <td className="py-2 px-3">
          <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${STATUS_BADGE[r.status]}`}>
            {STATUS_LABEL[r.status] || r.status}
          </span>
        </td>
        <td className="py-2 px-3 font-mono text-xs">
          {r.linked_po_number ? (
            <a href={`/purchase-orders?id=${r.linked_po_id}`} className="text-[#af4408] hover:underline">
              {r.linked_po_number} <span className="text-[#8B7355]">({r.linked_po_status})</span>
            </a>
          ) : <span className="text-[#8B7355]">—</span>}
        </td>
        <td className="py-2 px-3 text-[10px] text-[#8B7355]">
          {r.drafted_by}
        </td>
      </tr>
      {expanded && <RequisitionDetail r={r} materials={materials} viewer={viewer} requireMgmt={requireMgmt} reload={reload} onEdit={onEdit} />}
    </>
  );
}

function RequisitionDetail({ r, materials, viewer, requireMgmt, reload, onEdit }: {
  r: Requisition; materials: Material[];
  viewer: { email: string; role: string; can_chef: boolean; can_mgmt: boolean; can_store: boolean; can_issue: boolean };
  requireMgmt: boolean;
  reload: () => void;
  onEdit: (draft: Requisition) => void;
}) {
  const [detail, setDetail] = useState<Requisition | null>(null);
  const [busy, setBusy] = useState(false);
  const [showProcess, setShowProcess] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showMgmtApprove, setShowMgmtApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  useEffect(() => {
    fetch(`/api/requisitions?id=${r.id}`).then(x => x.json()).then(d => setDetail(d.requisition));
  }, [r.id]);

  if (!detail) {
    return <tr><td colSpan={10} className="bg-[#FFF8F0] py-3 px-4 text-xs text-[#8B7355]">Loading detail…</td></tr>;
  }

  const isAuthor = detail.drafted_by === viewer.email;
  const isAdmin  = viewer.role === 'admin';
  const canEdit  = (isAuthor || isAdmin) && detail.status === 'draft';
  const canSubmit = (isAuthor || isAdmin) && detail.status === 'draft' && (detail.items?.length || 0) > 0;
  // Per-requisition: only the head of THIS req's main department (or admin) sees
  // Approve/Reject. detail.can_approve_chef comes from the API (isMainDeptHead);
  // fall back to the global hint only if the field is absent (older payload).
  const canChefAct = ((detail as any).can_approve_chef ?? viewer.can_chef) && detail.status === 'submitted';
  // Only show Mgmt Approve when the global gate is ON. When OFF, chef approval
  // is the final gate — the requisition is already in the store inbox and
  // there's no Mgmt action to take.
  const canMgmtAct = requireMgmt && viewer.can_mgmt && detail.status === 'chef_approved';
  // Store may act on mgmt-approved (current SOP) or chef_approved (legacy in-flight)
  const canStoreAct = viewer.can_issue && (detail.status === 'mgmt_approved' || detail.status === 'chef_approved');  // STRICT: store person only, no admin bypass (mirrors canIssueAsStore)
  const canCancel = (isAuthor || isAdmin) && !['fulfilled', 'cancelled', 'chef_rejected'].includes(detail.status);
  // Phase 1 §2: dept staff confirms goods physically arrived. One-shot — only on fulfilled, not yet acked.
  const canAck   = detail.status === 'fulfilled' && !detail.dept_acknowledged_at && (isAuthor || isAdmin);

  const submit = async () => {
    if (!confirm('Submit this requisition for head-chef approval?')) return;
    setBusy(true);
    let res = await api(`/api/requisitions/${r.id}/submit`, { method: 'POST', body: {} });
    if (!res.ok) {
      const j = await res.json();
      // Phase 1 §2 — submission window enforcement. Admin can override.
      if (j.outside_window && viewer.role === 'admin') {
        const ok = confirm(`${j.error}\n\nOverride as admin and submit anyway?`);
        if (ok) {
          res = await api(`/api/requisitions/${r.id}/submit`, { method: 'POST', body: { force_outside_window: true } });
          if (!res.ok) { alert((await res.json()).error || 'Failed'); setBusy(false); return; }
        } else { setBusy(false); return; }
      } else {
        alert(j.error || 'Failed'); setBusy(false); return;
      }
    }
    reload();
    setBusy(false);
  };
  const cancel = async () => {
    if (!confirm('Cancel this requisition?')) return;
    setBusy(true);
    const res = await api(`/api/requisitions/${r.id}/cancel`, { method: 'POST', body: {} });
    if (!res.ok) alert((await res.json()).error || 'Failed');
    else reload();
    setBusy(false);
  };
  const ack = async () => {
    const note = prompt('Confirm receipt of all issued items at the department.\n\nOptional note (e.g. condition, time received):') ?? '';
    if (note === null) return;
    setBusy(true);
    const res = await api(`/api/requisitions/${r.id}/acknowledge`, { method: 'POST', body: { note } });
    if (!res.ok) alert((await res.json()).error || 'Failed');
    else reload();
    setBusy(false);
  };

  return (
    <tr><td colSpan={10} className="bg-[#FFF8F0] py-3 px-4">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-3">
        <div className="lg:col-span-3">
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]">
              <tr>
                <th className="text-left py-1 px-2 font-medium">SKU</th>
                <th className="text-left py-1 px-2 font-medium">Material</th>
                <th className="text-right py-1 px-2 font-medium">Requested</th>
                <th className="text-right py-1 px-2 font-medium" title="HOD-approved quantity (overrides Requested when set)">HOD OK</th>
                <th className="text-right py-1 px-2 font-medium">On Hand</th>
                {(detail.status === 'store_processed' || detail.status === 'fulfilled') && (
                  <>
                    <th className="text-right py-1 px-2 font-medium">Issued</th>
                    <th className="text-right py-1 px-2 font-medium">To Purchase</th>
                  </>
                )}
                <th className="text-right py-1 px-2 font-medium" title="Average price per purchase/ordering unit">Avg ₹ / unit</th>
                <th className="text-left  py-1 px-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(detail.items || []).map(it => {
                const rejected = !!it.is_rejected;
                // Stock is in recipe units; the request may be in the purchase
                // unit (e.g. BTL) — convert before comparing.
                const short = (it.current_stock < it.quantity_requested * reqPackFactor(it));
                // Purchase-unit context for display: stock is stored in recipe
                // units (g/ml) and average_price is ₹/recipe-unit — both are
                // unreadable raw (18,000 / ₹0). Convert to the ordering unit.
                const packN = Number(it.material_pack_size) || 1;
                const hasPU = !!(it.material_purchase_unit && it.material_purchase_unit !== it.material_unit && packN > 1);
                const puLbl = it.material_purchase_unit || it.material_unit || '';
                const avgPerPU = (it.average_price || 0) * (hasPU ? packN : 1);
                // Rejected lines get strikethrough + faded; rest render normal.
                const rowCls = `border-t border-[#E8D5C4]/50 ${rejected ? 'opacity-50 line-through bg-red-50/30' : ''}`;
                return (
                  <tr key={it.id} className={rowCls}>
                    <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{it.material_sku || '·'}</td>
                    <td className="py-1 px-2">
                      {it.material_name}
                      {it.chef_note && <div className="text-[9px] text-amber-700 no-underline">Chef: {it.chef_note}</div>}
                    </td>
                    <td className="py-1 px-2 text-right font-mono" title={reqPackFactor(it) > 1 ? `= ${(it.quantity_requested * reqPackFactor(it)).toLocaleString('en-IN')} ${it.material_unit}` : undefined}>
                      {it.quantity_requested.toLocaleString('en-IN')} {reqUnit(it)}
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {rejected
                        ? <span className="text-red-700 no-underline">—</span>
                        : it.chef_approved_qty != null
                          ? <span className="text-amber-700">{Number(it.chef_approved_qty).toLocaleString('en-IN')}</span>
                          : <span className="text-[#C0A98F]">—</span>}
                    </td>
                    <td className={`py-1 px-2 text-right font-mono ${short ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                      {it.current_stock.toLocaleString('en-IN')} {it.material_unit}{short && ' ⚠'}
                      {hasPU && (
                        <div className="text-[9px] text-[#8B7355] font-normal no-underline">
                          = {(it.current_stock / packN).toLocaleString('en-IN', { maximumFractionDigits: 1 })} {puLbl}
                        </div>
                      )}
                    </td>
                    {(detail.status === 'store_processed' || detail.status === 'fulfilled') && (
                      <>
                        <td className="py-1 px-2 text-right font-mono text-emerald-700">{rejected ? '—' : (it.quantity_issued || 0)}</td>
                        <td className="py-1 px-2 text-right font-mono text-blue-700">{rejected ? '—' : (it.quantity_to_purchase || 0)}</td>
                      </>
                    )}
                    <td className="py-1 px-2 text-right font-mono text-[#6B5744]"
                        title={`avg ₹${(it.average_price || 0).toFixed(4)}/${it.material_unit}`}>
                      {avgPerPU >= 1 ? fmt(avgPerPU) : `₹${avgPerPU.toFixed(2)}`}
                      <span className="text-[#8B7355]">/{puLbl}</span>
                    </td>
                    <td className="py-1 px-2 no-underline">
                      {rejected
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200 font-medium">Rejected by HOD</span>
                        : it.chef_approved_qty != null
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Qty edited</span>
                          : <span className="text-[10px] text-[#C0A98F]">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-[#6B5744] space-y-1.5">
          <div><b>Drafted by:</b> {detail.drafted_by}</div>
          {detail.notes && <div><b>Notes:</b> {detail.notes}</div>}
          {detail.submitted_at  && <div><b>Submitted:</b> {fmtIST(detail.submitted_at)} by {detail.submitted_by}</div>}
          {detail.chef_approved_at && <div className="text-blue-700"><b>HOD approved:</b> {fmtIST(detail.chef_approved_at)} by {detail.chef_approved_by}{detail.chef_note && ` — "${detail.chef_note}"`}</div>}
          {detail.mgmt_approved_at && <div className="text-indigo-700"><b>Mgmt approved:</b> {fmtIST(detail.mgmt_approved_at)} by {detail.mgmt_approved_by}{detail.mgmt_note && ` — "${detail.mgmt_note}"`}</div>}
          {detail.rejected_at && <div className="text-red-700"><b>Rejected:</b> {detail.rejected_reason} ({detail.rejected_by} · {fmtIST(detail.rejected_at)})</div>}
          {detail.store_processed_at && <div className="text-purple-700"><b>Store processed:</b> {fmtIST(detail.store_processed_at)} by {detail.store_processed_by}{detail.store_note && ` — "${detail.store_note}"`}</div>}
          {detail.fulfilled_at && <div className="text-emerald-700"><b>Fulfilled:</b> {fmtIST(detail.fulfilled_at)}</div>}
          {detail.dept_acknowledged_at && (
            <div className="text-emerald-700"><b>Dept acknowledged:</b> {fmtIST(detail.dept_acknowledged_at)} by {detail.dept_acknowledged_by}{detail.dept_ack_note && ` — "${detail.dept_ack_note}"`}</div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 mt-2">
        {canEdit    && <button disabled={busy} onClick={() => onEdit(detail)} className="px-3 py-1.5 text-xs bg-[#af4408] hover:bg-[#8a3506] text-white rounded inline-flex items-center gap-1"><Pencil className="w-3 h-3" /> Edit</button>}
        {canSubmit  && <button disabled={busy} onClick={submit}     className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded inline-flex items-center gap-1"><Send className="w-3 h-3" /> Submit to HOD</button>}
        {canChefAct && <button onClick={() => setShowApprove(true)} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> HOD Approve</button>}
        {canChefAct && <button onClick={() => setShowReject(true)}  className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> Reject</button>}
        {canMgmtAct && <button onClick={() => setShowMgmtApprove(true)} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Mgmt Approve</button>}
        {canStoreAct && <button onClick={() => setShowProcess(true)} className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded inline-flex items-center gap-1"><Package className="w-3 h-3" /> Issue to Department</button>}
        {canAck     && <button disabled={busy} onClick={ack} className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Confirm Received at Dept</button>}
        {canCancel  && <button disabled={busy} onClick={cancel}     className="px-3 py-1.5 text-xs text-red-600 hover:underline">Cancel</button>}
      </div>

      {/* All modals portaled to body — see ModalPortal docstring. Rendering
          fixed overlays inside a <tr><td> caused open/close flicker because
          the browser kept re-laying out the table when the modal mounted. */}
      {showApprove && <ModalPortal><ChefApproveModal req={detail} onClose={() => setShowApprove(false)} onDone={() => { setShowApprove(false); reload(); }} /></ModalPortal>}
      {showMgmtApprove && <ModalPortal><MgmtApproveModal req={detail} onClose={() => setShowMgmtApprove(false)} onDone={() => { setShowMgmtApprove(false); reload(); }} /></ModalPortal>}
      {showReject  && <ModalPortal><ChefRejectModal  req={detail} onClose={() => setShowReject(false)}  onDone={() => { setShowReject(false);  reload(); }} /></ModalPortal>}
      {showProcess && <ModalPortal><StoreProcessModal req={detail} onClose={() => setShowProcess(false)} onDone={() => { setShowProcess(false); reload(); }} /></ModalPortal>}
    </td></tr>
  );
}

/* ============================================================ */
/* Create new requisition                                        */
/* ============================================================ */
function CreateRequisitionModal({ departments, materials, me, editDraft, onClose, onCreated }: {
  departments: Department[]; materials: Material[];
  me: { role?: string; department_id?: string | null; is_head_chef?: boolean; is_store_manager?: boolean } | null;
  editDraft?: Requisition | null;
  onClose: () => void; onCreated: () => void;
}) {
  // When editing a draft, we PUT instead of POST and pre-fill the form from it.
  const isEditing = !!editDraft;
  // Department locking — internal requisitions belong to the user's home dept.
  // Only privileged roles can pick a different dept (e.g. an admin raising on
  // behalf of a team that doesn't have its own dispatcher yet):
  //   - admin            → free choice
  //   - head chef        → free choice (multi-dept oversight)
  //   - store manager    → free choice (cross-dept inventory ops)
  //   - everyone else    → locked to their own department_id
  const canChangeDept = me?.role === 'admin'
    || !!me?.is_head_chef
    || !!me?.is_store_manager
    || me?.role === 'manager';
  const lockedDeptId = !canChangeDept ? (me?.department_id || '') : '';

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(editDraft?.date || today);
  // Default the department to the user's OWN department automatically for everyone
  // who has one (a staff user is locked to it; admin/manager/head see it pre-selected
  // but can still switch). Only fall back to the first dept when the user has no home
  // department (e.g. a pure admin). When editing, honour the draft's own department.
  const [departmentId, setDepartmentId] = useState(editDraft?.department_id || me?.department_id || lockedDeptId || departments[0]?.id || '');
  // Safety net: if `me` resolves after this modal mounts, adopt the user's home
  // department — but never override a choice already made. Skip entirely when
  // editing so we don't clobber the draft's department.
  useEffect(() => {
    if (isEditing) return;
    if (me?.department_id) setDepartmentId((cur) => cur || me.department_id!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.department_id]);
  const [notes, setNotes] = useState(editDraft?.notes || '');
  const [items, setItems] = useState<Array<{ material_id: string; quantity_requested: number; unit: string; notes: string }>>(
    editDraft && (editDraft.items?.length || 0) > 0
      ? editDraft.items!.map(it => ({
          material_id: it.material_id,
          quantity_requested: it.quantity_requested,
          unit: it.unit || '',
          notes: it.notes || '',
        }))
      : [{ material_id: '', quantity_requested: 1, unit: '', notes: '' }],
  );
  const [saving, setSaving] = useState(false);

  const addLine = () => setItems(p => [...p, { material_id: '', quantity_requested: 1, unit: '', notes: '' }]);
  const update = (i: number, patch: any) => setItems(p => p.map((it, j) => j === i ? { ...it, ...patch } : it));
  const remove = (i: number) => setItems(p => p.filter((_, j) => j !== i));

  // submitAfter=false → just save as draft. submitAfter=true → create then
  // immediately POST /submit so it lands in the Head Chef's inbox in one click.
  const save = async (submitAfter: boolean) => {
    if (!departmentId) {
      alert(canChangeDept
        ? 'Pick a department.'
        : 'Your user has no home department set. Ask an admin to assign one on /users.');
      return;
    }
    const cleaned = items.filter(i => i.material_id && i.quantity_requested > 0);
    if (cleaned.length === 0) { alert('Add at least one item'); return; }
    setSaving(true);
    try {
      // Editing a draft → PUT (replaces items on the existing requisition).
      // Creating → POST (unchanged behaviour). The submitted-to-chef id is the
      // draft's own id when editing, or the newly-created id when creating.
      const r = isEditing
        ? await api('/api/requisitions', {
            method: 'PUT',
            body: { id: editDraft!.id, date, department_id: departmentId, notes, items: cleaned },
          })
        : await api('/api/requisitions', {
            method: 'POST',
            body: { date, department_id: departmentId, notes, items: cleaned },
          });
      if (!r.ok) { alert((await r.json()).error || 'Failed'); return; }
      if (submitAfter) {
        const j = await r.json().catch(() => ({}));
        const targetId = isEditing ? editDraft!.id : j?.requisition?.id;
        if (targetId) {
          const s = await api(`/api/requisitions/${targetId}/submit`, { method: 'POST', body: {} });
          if (!s.ok) {
            const sj = await s.json().catch(() => ({}));
            alert('Saved as draft, but submit to HOD failed: ' + (sj.error || 'unknown') +
                  '\nYou can submit it from the requisition’s detail view.');
          }
        } else {
          alert('Saved as draft. Open it to submit to HOD.');
        }
      }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      {/* maxHeight:none overrides the global mobile modal cap (globals.css §5,
          `max-height: calc(100vh-1rem)`). That cap has no overflow, so with many
          item lines the content spilled OUT of the white card. Letting the card
          grow keeps every line inside it — the overlay above (overflow-y-auto)
          scrolls the tall card — and, unlike an internal scroll, never clips the
          absolutely-positioned material dropdown. */}
      <div style={{ maxHeight: 'none' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">{isEditing ? 'Edit Draft Requisition' : 'New Department Requisition'}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1 sm:col-span-2">
              Department {!canChangeDept && <span className="text-[10px] text-blue-700">🔒 locked to your role</span>}
              {canChangeDept ? (
                <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                  <option value="">Select…</option>
                  {departments.map(d => <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>)}
                </select>
              ) : (
                // Read-only display — the staff/dept user can't request on behalf
                // of another department. Server also enforces this on POST.
                <input value={(() => {
                  const d = departments.find(x => x.id === departmentId);
                  return d ? `${d.code ? `[${d.code}] ` : ''}${d.name}` : '(no department assigned to your user)';
                })()}
                       readOnly
                       title="Internal requisitions are scoped to your home department. Admins / HODs / Store Managers can pick any."
                       className="px-2 py-1.5 border border-blue-200 rounded-lg bg-blue-50/40 text-sm text-[#6B5744] cursor-not-allowed" />
              )}
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Items needed</h3>
              {/* Desktop keeps a quick top button; the primary one lives at the
                  bottom of the list so on mobile you always see it right after the
                  material you just added (rather than scrolled off the top). */}
              <button onClick={addLine} className="hidden md:flex text-xs text-[#af4408] hover:underline items-center gap-1">
                <Plus className="w-3 h-3" /> Add line
              </button>
            </div>
            <div className="space-y-2">
              {/* Column header — desktop only; on mobile each field carries its own
                  inline label so a cramped 12-col grid never hides the material name. */}
              <div className="hidden md:grid md:grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
                <div className="col-span-3">Material · Category</div>
                <div className="col-span-2 text-right">On hand · Buffer</div>
                <div className="col-span-2 text-right">Qty · Unit</div>
                <div className="col-span-2 text-right">PUoM · Last ₹</div>
                <div className="col-span-2">Notes</div>
                <div className="col-span-1"></div>
              </div>
              {items.map((it, i) => {
                const mat = materials.find(m => m.id === it.material_id);
                // Units the requester can pick: the recipe (base) unit + the
                // purchase unit if different. When they choose the purchase unit,
                // 1 of it = pack_size recipe units — so convert for the on-hand /
                // buffer warnings (which are shown in recipe units).
                const packSize = Number(mat?.pack_size || 1);
                const inPurchaseUnit = !!mat && !!mat.purchase_unit && it.unit === mat.purchase_unit && packSize > 1;
                const reqRecipe = it.quantity_requested * (inPurchaseUnit ? packSize : 1);
                const short    = mat ? mat.current_stock < reqRecipe : false;
                const buffer   = Number(mat?.reorder_level || 0);
                const postReq  = mat ? (mat.current_stock - reqRecipe) : 0;
                const belowBuffer = mat && buffer > 0 && postReq < buffer;
                const pu = mat?.purchase_unit || mat?.unit || '';
                // Tiny inline field label — mobile only (desktop uses the header row).
                const Lbl = ({ children }: { children: React.ReactNode }) => (
                  <div className="md:hidden text-[9px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</div>
                );
                return (
                  // Mobile: a stacked card (material name on its own full-width line,
                  // then On-hand / Qty / Last-₹ side by side, then Notes). Desktop
                  // (md+): the original single-line 12-col grid, unchanged.
                  <div key={i} className="rounded-lg border border-[#E8D5C4] bg-white p-3 space-y-2.5 text-xs
                                          md:rounded-none md:border-0 md:bg-transparent md:p-0 md:space-y-0
                                          md:grid md:grid-cols-12 md:gap-2 md:items-start">
                    {/* Material — full width on mobile (name never truncated), col-3 desktop */}
                    <div className="md:col-span-3">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <MaterialTypeahead
                            materials={materials}
                            value={it.material_id}
                            excludeIds={items.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                            onPick={(id) => { const m = materials.find(x => x.id === id); update(i, { material_id: id, unit: (m?.purchase_unit || m?.unit || '') }); }}
                          />
                          {mat?.category && <div className="text-[9px] text-[#8B7355] mt-0.5">{mat.category}</div>}
                        </div>
                        {/* delete — inline on mobile (top-right of the card) */}
                        <button onClick={() => remove(i)} className="md:hidden text-red-500 shrink-0 pt-2" aria-label="Remove line"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                    {/* Numeric group: 3-up on mobile; on desktop `contents` lets each
                        block flow straight into the parent 12-col grid. */}
                    <div className="grid grid-cols-3 gap-2 md:contents">
                      <div className="md:col-span-2 md:text-right text-[10px] leading-snug">
                        <Lbl>On hand · Buf</Lbl>
                        {mat ? (
                          <>
                            <div className={`font-mono ${short ? 'text-red-700 font-semibold' : 'text-[#2D1B0E]'}`}>
                              {mat.current_stock.toLocaleString('en-IN')} {mat.unit}
                            </div>
                            <div className={`font-mono ${belowBuffer ? 'text-red-700 font-semibold' : 'text-[#8B7355]'}`}
                                 title={belowBuffer ? `Will drop to ${postReq.toFixed(2)} ${mat.unit}, below buffer ${buffer}` : `Buffer / reorder level`}>
                              buf: {buffer || '—'}{belowBuffer && <span className="ml-1">⚠</span>}
                            </div>
                          </>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </div>
                      <div className="md:col-span-2">
                        <Lbl>Qty · Unit</Lbl>
                        <input type="number" step="any" min={0} value={it.quantity_requested || ''}
                               onChange={e => update(i, { quantity_requested: Math.max(0, parseFloat(e.target.value) || 0) })}
                               placeholder="Qty"
                               className="w-full min-w-0 px-2 md:px-3 py-2 border border-[#E8D5C4] rounded text-right text-sm tabular-nums" />
                        {mat ? (
                          <div className="text-[10px] text-[#8B7355] mt-0.5 text-right whitespace-nowrap" title="Ordering unit (purchase unit)">
                            {mat.purchase_unit || mat.unit}{mat.purchase_unit && mat.purchase_unit !== mat.unit && packSize > 1 ? <span className="text-[#B99]"> = {packSize.toLocaleString('en-IN')} {mat.unit}</span> : ''}
                          </div>
                        ) : null}
                      </div>
                      <div className="md:col-span-2 md:text-right text-[10px] leading-snug">
                        <Lbl>PUoM · Last ₹</Lbl>
                        {mat ? (
                          <>
                            <div className="text-[#6B5744]">{pu}</div>
                            <div className="font-mono text-[#6B5744]"
                                 title={`avg ₹${(mat.average_price || 0).toFixed(4)}/${mat.unit}${mat.last_purchase_date ? ' · last bought ' + mat.last_purchase_date : ''}`}>
                              ₹{(Number(mat.last_purchase_price) > 0
                                  ? Number(mat.last_purchase_price)
                                  : (mat.average_price || 0) * (mat.purchase_unit && mat.purchase_unit !== mat.unit && packSize > 1 ? packSize : 1)
                                ).toFixed(2)}
                              <span className="text-[#8B7355]">/{pu}</span>
                            </div>
                          </>
                        ) : <span className="text-[#8B7355]">—</span>}
                      </div>
                    </div>
                    {/* Notes — full width on mobile, col-2 desktop */}
                    <div className="md:col-span-2">
                      <Lbl>Notes</Lbl>
                      <input value={it.notes} onChange={e => update(i, { notes: e.target.value })}
                             placeholder="Notes (optional)"
                             className="w-full px-2 py-2 md:py-1 border border-[#E8D5C4] rounded" />
                    </div>
                    {/* delete — desktop only (mobile has the inline one above) */}
                    <button onClick={() => remove(i)} className="hidden md:block md:col-span-1 text-red-500 pt-1" aria-label="Remove line"><Trash2 className="w-3 h-3" /></button>
                  </div>
                );
              })}
            </div>
            {/* Primary Add-line — full width at the BOTTOM so after entering a
                material the button sits right below it (mobile-friendly). */}
            <button onClick={addLine} type="button"
                    className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 border-2 border-dashed border-[#E8D5C4] rounded-lg text-sm font-medium text-[#af4408] hover:border-[#af4408] hover:bg-[#FFF1E3] active:bg-[#FFE8D5]">
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>

          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Notes / Justification
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                      placeholder="Why is this needed?"
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={() => save(false)} disabled={saving}
                  className="px-3 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] text-sm rounded-lg disabled:opacity-50">
            {saving ? 'Saving…' : (isEditing ? 'Save Changes' : 'Save as Draft')}
          </button>
          <button onClick={() => save(true)} disabled={saving}
                  className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1">
            <Send className="w-3.5 h-3.5" /> {saving ? 'Working…' : 'Submit to HOD'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
function ChefApproveModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  // Per-line qty + reject toggle. Initial values reflect any pre-existing
  // chef edits (chef_approved_qty / is_rejected) from earlier approval passes.
  const [overrides, setOverrides] = useState<Record<string, number>>(
    Object.fromEntries((req.items || []).map(it => [it.id, (it.chef_approved_qty ?? it.quantity_requested)]))
  );
  const [rejected, setRejected] = useState<Record<string, boolean>>(
    Object.fromEntries((req.items || []).map(it => [it.id, !!it.is_rejected]))
  );
  const [busy, setBusy] = useState(false);

  const allRejected = (req.items || []).length > 0 && (req.items || []).every(it => rejected[it.id]);

  const submit = async () => {
    if (allRejected) {
      alert('You\'ve rejected every line. Use the Reject button instead to reject the whole requisition.');
      return;
    }
    setBusy(true);
    // Two-phase: first push per-line is_rejected via the items PUT endpoint,
    // then call chef-approve to seal the qty overrides + flip the req status.
    // chef-approve treats qty=0 as "delete line", so rejected lines pass qty=1
    // (any positive number) on that call — the PUT already marked them rejected
    // so they're skipped downstream regardless.
    const itemsPutPromises = (req.items || []).map(it => {
      const isRej = !!rejected[it.id];
      const wasRej = !!it.is_rejected;
      // Only PUT lines whose reject state actually changed (avoids needless audit noise)
      if (isRej === wasRej) return Promise.resolve({ ok: true });
      return api(`/api/requisitions/${req.id}/items/${it.id}`, {
        method: 'PUT', body: { is_rejected: isRej },
      });
    });
    try {
      await Promise.all(itemsPutPromises);
    } catch (e: any) {
      alert(`Failed to apply line rejections: ${e?.message || 'unknown'}`);
      setBusy(false);
      return;
    }

    const item_overrides = (req.items || []).map(it => ({
      id: it.id,
      // For rejected lines: send qty 1 placeholder (chef-approve interprets
      // qty=0 as delete, which we don't want — we want the line preserved
      // with is_rejected=1 so the audit trail stays intact).
      quantity_requested: rejected[it.id] ? 1 : (overrides[it.id] || 0),
    }));
    const r = await api(`/api/requisitions/${req.id}/chef-approve`, { method: 'POST', body: { note, item_overrides } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">HOD Approve — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            Adjust quantities or reject individual lines. Rejected lines are kept on the requisition
            (with a "Rejected by Chef" badge) so the audit trail is preserved — they're skipped
            during store issue.
          </p>
          <table className="w-full text-xs">
            <thead className="text-[#8B7355]"><tr>
              <th className="text-left py-1 px-2 font-medium">Material</th>
              <th className="text-right py-1 px-2 font-medium">Requested</th>
              <th className="text-right py-1 px-2 font-medium">Approve Qty</th>
              <th className="text-center py-1 px-2 font-medium" title="Reject this line entirely">Reject</th>
            </tr></thead>
            <tbody>
              {(req.items || []).map(it => {
                const isRej = !!rejected[it.id];
                return (
                  <tr key={it.id} className={`border-t border-[#E8D5C4]/50 ${isRej ? 'opacity-50 line-through bg-red-50/30' : ''}`}>
                    <td className="py-1 px-2">{it.material_name}</td>
                    <td className="py-1 px-2 text-right font-mono text-[#6B5744]">{it.quantity_requested} {reqUnit(it)}</td>
                    <td className="py-1 px-2">
                      <input type="number" step="any" value={overrides[it.id] ?? ''}
                             disabled={isRej}
                             onChange={e => setOverrides(p => ({ ...p, [it.id]: parseFloat(e.target.value) || 0 }))}
                             className="w-24 px-1.5 py-1 border border-[#E8D5C4] rounded text-right disabled:opacity-50" />
                    </td>
                    <td className="py-1 px-2 text-center no-underline">
                      <input type="checkbox" checked={isRej}
                             onChange={e => setRejected(p => ({ ...p, [it.id]: e.target.checked }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Approval note (optional)
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Approving…' : 'Approve & forward to Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Phase 1 §2 — Management approves a chef-approved requisition */
/* ============================================================ */
function MgmtApproveModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await api(`/api/requisitions/${req.id}/mgmt-approve`, { method: 'POST', body: { note } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] bg-indigo-50 flex items-center justify-between">
          <h2 className="font-bold text-indigo-900">Management Approve — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            2nd-stage approval. Chef has already signed off on the items + quantities.
            On approval, the requisition moves to the Store Manager's queue for processing.
          </p>
          <div className="text-xs text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
            <div><b>Department:</b> {req.department_name}</div>
            <div><b>Items:</b> {(req.items || []).length}</div>
            {req.chef_note && <div className="mt-1"><b>Chef note:</b> "{req.chef_note}"</div>}
          </div>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Mgmt note (optional)
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Approving…' : 'Approve & forward to Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChefRejectModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!reason.trim()) { alert('Reason required'); return; }
    setBusy(true);
    const r = await api(`/api/requisitions/${req.id}/chef-reject`, { method: 'POST', body: { reason } });
    if (!r.ok) { alert((await r.json()).error || 'Failed'); setBusy(false); return; }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4">
      <div className="bg-white rounded-xl border border-red-200 w-full max-w-md my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-red-200 bg-red-50 flex items-center justify-between">
          <h2 className="font-bold text-red-800">Reject — {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Reason for rejection (required)
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3}
                      placeholder="e.g. Already have enough on hand; over-ordering."
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
          </label>
          <div className="flex gap-1 flex-wrap">
            {['Already have on hand', 'Over-ordering', 'Use existing stock first', 'Wrong item'].map(t => (
              <button key={t} onClick={() => setReason(t)} className="text-[10px] px-2 py-0.5 bg-[#FFF1E3] border border-[#E8D5C4] rounded hover:bg-[#E8D5C4]">{t}</button>
            ))}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-red-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
          <button onClick={submit} disabled={busy}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg disabled:opacity-50">
            {busy ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ */
/* Store Process — heart of the workflow                         */
/* ============================================================ */
function StoreProcessModal({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  // Issue + (optional) PO workflow.
  //
  // Default: pure issuance — record what was handed to the department, no
  // vendor side-effect. Store managers raise POs on /purchase-orders.
  //
  // Opt-in: store manager ticks "Also raise vendor PO for the shortfall" →
  // backend `auto_create_po: true` flag is sent → for any line with
  // quantity_to_purchase > 0, a single vendor PO is auto-created in `pending`
  // and goes to the admin's PO approval queue. Vendor + unit price fields
  // appear per-line ONLY when this checkbox is on.
  // Reject-aware line list:
  //   1) Drop chef-rejected lines entirely — the store should never see them
  //      here, and they're tagged "Rejected by Chef" in the read-only detail
  //      table for audit. Issuing or buying a rejected item would defeat the
  //      whole point of the chef's rejection.
  //   2) Use chef_approved_qty (when set) as the effective demand instead of
  //      quantity_requested. The store works off what the chef approved, not
  //      what the dept originally asked for.
  const visibleItems = (req.items || []).filter(it => !it.is_rejected);
  const rejectedCount = (req.items || []).length - visibleItems.length;
  const [lines, setLines] = useState(() =>
    visibleItems.map(it => {
      // effective demand is in the REQUESTED unit (ri.unit — may be the purchase
      // unit like BTL); chef_approved_qty is edited in that same unit.
      const effective = (it.chef_approved_qty != null && it.chef_approved_qty > 0)
        ? Number(it.chef_approved_qty)
        : it.quantity_requested;
      // requested-unit → recipe-unit factor (1 BTL = pack_size recipe units).
      const reqFactor = reqPackFactor(it);
      // Clamp current_stock to 0 for "issuable" math — a negative stock means
      // the books are already over-consumed (a prior recipe-deduction outran
      // purchases). We must NOT propose issuing a negative qty as if the
      // material were on the shelf; default issue stays 0 and the entire
      // requested amount becomes a shortfall the store must source via PO.
      // Stock is in RECIPE units — convert to requested units before comparing
      // (floor when packs: you can't hand over 0.4 of a bottle against a BTL ask).
      const safeStock = Math.max(0, Number(it.current_stock) || 0);
      const stockInReqUnits = reqFactor > 1 ? Math.floor(safeStock / reqFactor) : safeStock;
      const issuable  = Math.min(effective, stockInReqUnits);
      const shortfall = Math.max(0, effective - issuable);
      // Purchase-unit metadata so the PO math can switch between recipe-unit
      // (kg / ml / pcs) and purchase-unit (BTL / PKT / CASE) entry. pack_size
      // is recipe-units per purchase-unit (e.g. 750 ml in 1 BTL).
      const purchaseUnit = (it as any).material_purchase_unit || it.material_unit || '';
      const packSize     = Number((it as any).material_pack_size) || 1;
      // Vendors quote per purchase-unit. Default the PO line to that unit when
      // pack_size > 1; otherwise the recipe-unit IS the purchase-unit and the
      // distinction doesn't matter.
      const buyInPurchaseUnit = packSize > 1;
      // Convert shortfall to purchase-unit qty for the PO line. If the request
      // was ALREADY in the purchase unit (reqFactor>1) the shortfall is in
      // purchase units — use it as-is; else it's recipe units → divide by pack.
      // Ceil so the order covers the demand — vendors don't sell fractional bottles.
      const buyQty = buyInPurchaseUnit
        ? (reqFactor > 1 ? Math.ceil(shortfall) : Math.ceil(shortfall / packSize))
        : shortfall;
      // Convert recipe-unit-based last price to per-purchase-unit price.
      // last_purchase_price on raw_materials is per recipe unit (the canonical),
      // so for purchase-unit entry we multiply by pack_size.
      const recipeUnitPrice = (it as any).last_purchase_price || it.average_price || 0;
      const buyUnitPrice = buyInPurchaseUnit ? recipeUnitPrice * packSize : recipeUnitPrice;
      return {
        id: it.id,
        material_id: it.material_id,         // needed to look up mapped vendors
        material_name: it.material_name,
        material_unit: it.material_unit,     // recipe unit (canonical)
        req_unit: reqUnit(it),               // unit the dept requested in — requested/issued qtys are in THIS unit
        purchase_unit: purchaseUnit,         // vendor-facing unit
        pack_size: packSize,                 // recipe-units per purchase-unit
        current_stock: it.current_stock,     // keep raw value for the warning render
        requested: effective,                // chef-approved demand, not raw request
        quantity_issued: issuable,
        // PO-only fields, hidden until raisePo is ticked.
        quantity_to_purchase: buyQty,
        unit_price: buyUnitPrice,
        /** Unit the user is entering qty + price in. Drives both the column
         *  labels and the on-submit conversion back to recipe units. */
        po_entry_unit: buyInPurchaseUnit ? purchaseUnit : (it.material_unit || ''),
        vendor: '',
        vendor_id: '',
      };
    })
  );
  // Lines whose system stock is negative — surfaced in a red banner so the
  // store user knows to raise a vendor PO immediately for those materials.
  const negativeStockLines = lines.filter(ln => Number(ln.current_stock) < 0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [raisePo, setRaisePo] = useState(false);
  const [poDate, setPoDate] = useState(new Date().toISOString().slice(0, 10));

  // Vendor lookup state — only fetched when the PO checkbox is ticked, so the
  // modal stays light when the store user is just issuing items.
  //   allVendors             : every active vendor (fallback dropdown options)
  //   vendorsByMaterial[mid] : vendors mapped to that specific material via
  //                            /api/vendor-materials (the curated list)
  const [allVendors, setAllVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendorsByMaterial, setVendorsByMaterial] = useState<Record<string, { id: string; name: string }[]>>({});
  useEffect(() => {
    if (!raisePo) return;
    // Active vendors — always fetched once when the box is ticked.
    if (allVendors.length === 0) {
      fetch('/api/vendors').then(r => r.json()).then(j => {
        setAllVendors((j.vendors || []).filter((v: any) => v.is_active).map((v: any) => ({ id: v.id, name: v.name })));
      }).catch(() => {});
    }
    // Per-material mappings — fetched in parallel for each line that has a
    // purchase qty > 0 and isn't yet cached.
    const toFetch = lines
      .filter(ln => ln.quantity_to_purchase > 0 && ln.material_id && !vendorsByMaterial[ln.material_id])
      .map(ln => ln.material_id);
    if (toFetch.length === 0) return;
    const unique = Array.from(new Set(toFetch));
    Promise.all(unique.map(mid =>
      fetch(`/api/vendor-materials?material_id=${encodeURIComponent(mid)}`)
        .then(r => r.json())
        .then(j => ({ mid, vendors: (j.mappings || []).map((m: any) => ({ id: m.vendor_id, name: m.vendor_name })) }))
        .catch(() => ({ mid, vendors: [] }))
    )).then(results => {
      setVendorsByMaterial(prev => {
        const next = { ...prev };
        for (const r of results) next[r.mid] = r.vendors;
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raisePo]);

  const update = (i: number, patch: any) => setLines(p => p.map((ln, j) => j === i ? { ...ln, ...patch } : ln));

  const totalShortfall = lines.reduce((s, ln) => s + Math.max(0, ln.requested - ln.quantity_issued), 0);
  const poTotal = lines.reduce((s, ln) => s + (ln.quantity_to_purchase * ln.unit_price), 0);

  const submit = async () => {
    if (raisePo) {
      // PO-mode validations — fire before any DB write so the store user gets
      // a clear, line-specific error instead of a half-created PO.
      //
      // 1. At least one line must actually contribute to the PO (qty > 0).
      const buyLines = lines.filter(ln => Number(ln.quantity_to_purchase) > 0);
      if (buyLines.length === 0) {
        alert('You ticked "Also raise vendor PO" but no line has a Buy quantity. Enter a positive Buy qty on at least one line, or untick the box to issue without a PO.');
        return;
      }
      // 2. Every Buy-qty line must have a positive unit price.
      const noPrice = buyLines.find(ln => !(Number(ln.unit_price) > 0));
      if (noPrice) {
        alert(`Enter a unit price (> 0) for "${noPrice.material_name}" before raising the PO. POs cannot be raised at ₹0.`);
        return;
      }
      // 3. Every Buy-qty line must have a vendor picked.
      const noVendor = buyLines.find(ln => !ln.vendor_id && !ln.vendor.trim());
      if (noVendor) {
        alert(`Pick a vendor for "${noVendor.material_name}" before raising the PO.`);
        return;
      }
    }
    setBusy(true);
    const body: any = {
      note,
      lines: lines.map(ln => {
        // Convert qty + price back to RECIPE units before sending — the PO
        // items table + stock-on-receive both work in recipe units (the
        // canonical store). The line total (qty × price) stays identical
        // regardless of which unit basis we use, so vendor totals on the
        // PO print match exactly what the store user entered.
        const goingInPurchaseUnit = raisePo && ln.po_entry_unit === ln.purchase_unit && ln.pack_size > 1;
        const recipeQty   = goingInPurchaseUnit
          ? (Number(ln.quantity_to_purchase) || 0) * ln.pack_size
          : Number(ln.quantity_to_purchase) || 0;
        const recipePrice = goingInPurchaseUnit
          ? (Number(ln.unit_price) || 0) / ln.pack_size
          : Number(ln.unit_price) || 0;
        return {
          id: ln.id,
          quantity_issued: ln.quantity_issued,
          // Only send the purchase qty when raisePo is ticked. Backend's default
          // (auto_create_po=false) makes it ignore this field anyway, but keep
          // the payload honest.
          quantity_to_purchase: raisePo ? recipeQty : 0,
          unit_price:           raisePo ? recipePrice : undefined,
          // Send BOTH the vendor display name and vendor_id when we have it —
          // server prefers vendor_id (proper FK), falls back to name lookup.
          vendor:    raisePo ? ln.vendor    : undefined,
          vendor_id: raisePo ? ln.vendor_id : undefined,
        };
      }),
    };
    if (raisePo) {
      body.auto_create_po = true;
      body.po_date = poDate;
    }
    const r = await api(`/api/requisitions/${req.id}/store-process`, { method: 'POST', body });
    const j = await r.json();
    if (!r.ok) { alert(j.error || 'Failed'); setBusy(false); return; }
    alert('Issuance recorded. If any items still need to be purchased, raise a vendor PO on the Purchase Orders page.');
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E]">Store — Issue {req.req_number}</h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-xs">
          <p className="text-[#6B5744]">
            Enter the quantity <span className="text-emerald-700 font-semibold">handed to the department</span> per line.
            Tick "Also raise vendor PO" below to bundle the shortfall lines into a single vendor PO in one go.
          </p>
          <p className="text-[10px] text-[#8B7355] italic">
            Issuing is recorded for department audit only — it does NOT deduct stock. Recipe-deduction on sales is the only thing that subtracts from inventory; vendor purchases are the only thing that adds to it.
          </p>

          {rejectedCount > 0 && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border border-red-200 rounded text-red-800">
              🚫 <b>{rejectedCount}</b> chef-rejected line{rejectedCount === 1 ? '' : 's'} hidden from this view — they will <b>not</b> be issued or purchased.
              Open the requisition details (collapse this modal and expand the row) to see them.
            </div>
          )}

          {lines.length === 0 && (
            <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-200 rounded text-amber-900">
              ⚠ Every line on this requisition was rejected by the chef. Nothing to issue — Cancel out and reject the whole requisition if appropriate.
            </div>
          )}

          {/* Negative-stock warning. When system stock is below 0, the books say
              we've already over-consumed — recipe-deduction outran purchases.
              Issuing more would deepen the deficit. We force these lines to 0
              issue, count the whole demand as shortfall, and push the store to
              raise a PO immediately. */}
          {negativeStockLines.length > 0 && (
            <div className="text-[11px] px-3 py-2 bg-red-50 border-2 border-red-300 rounded text-red-900 space-y-1">
              <div className="font-semibold">
                🚨 {negativeStockLines.length} line{negativeStockLines.length === 1 ? '' : 's'} have <b>negative system stock</b> — raise a vendor PO ASAP.
              </div>
              <ul className="ml-5 list-disc">
                {negativeStockLines.map(ln => (
                  <li key={ln.id}>
                    <b>{ln.material_name}</b> — system shows {Number(ln.current_stock).toLocaleString('en-IN')} {ln.material_unit}.
                    Issuing 0 here; raise a PO on <a href="/purchase-orders" className="underline">Purchase Orders</a> immediately.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Opt-in: store manager decides whether to also raise a vendor PO. */}
          <label className="flex items-start gap-2 text-xs cursor-pointer bg-blue-50 border border-blue-200 rounded p-2">
            <input type="checkbox" checked={raisePo} onChange={e => setRaisePo(e.target.checked)}
                   className="mt-0.5" />
            <div>
              <div className="font-medium text-blue-900">Also raise vendor PO for the shortfall</div>
              <div className="text-[10px] text-blue-800 mt-0.5">
                {raisePo
                  ? 'Vendor + unit-price fields appear on each line. On submit, lines with a positive "Buy" qty are bundled into a single PO (pending admin approval).'
                  : 'Default OFF. Issuance only — store manager raises POs separately on /purchase-orders.'}
              </div>
            </div>
          </label>

          <div className="bg-[#FFF8F0] rounded border border-[#E8D5C4] overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[#8B7355]">
                <tr>
                  <th className="text-left  py-1.5 px-2 font-medium">Material</th>
                  <th className="text-right py-1.5 px-2 font-medium">Requested</th>
                  <th className="text-right py-1.5 px-2 font-medium" title="Purchased − recipe-consumed (informational only — issuing does not change this)">In Stock*</th>
                  <th className="text-right py-1.5 px-2 font-medium">Issue Now</th>
                  <th className="text-right py-1.5 px-2 font-medium">Shortfall</th>
                  {raisePo && <>
                    <th className="text-right py-1.5 px-2 font-medium">Buy</th>
                    <th className="text-right py-1.5 px-2 font-medium">Unit ₹</th>
                    <th className="text-left  py-1.5 px-2 font-medium">Vendor</th>
                    <th className="text-right py-1.5 px-2 font-medium">PO Line ₹</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {lines.map((ln, i) => {
                  const short = Math.max(0, ln.requested - ln.quantity_issued);
                  // Negative-stock guard — disable the input and force qty to 0.
                  // The accompanying red banner above tells the user to raise a PO.
                  const negStock = Number(ln.current_stock) < 0;
                  return (
                    <tr key={ln.id} className={`border-t border-[#E8D5C4]/50 ${negStock ? 'bg-red-50/50' : ''}`}>
                      <td className="py-1.5 px-2 font-medium">
                        {ln.material_name}
                        {negStock && (
                          <div className="text-[9px] text-red-700 font-semibold">⚠ Negative stock — raise PO ASAP</div>
                        )}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono">{ln.requested} {ln.req_unit}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${negStock ? 'text-red-700 font-bold' : 'text-[#6B5744]'}`}>
                        {ln.current_stock}{negStock && ' ⚠'}
                      </td>
                      <td className="py-1.5 px-2">
                        <input type="number" step="any" min={0}
                               value={negStock ? '' : (ln.quantity_issued || '')}
                               disabled={negStock}
                               onChange={e => update(i, { quantity_issued: Math.max(0, Number(e.target.value) || 0) })}
                               title={negStock
                                 ? 'System stock is negative — cannot issue. Raise a vendor PO immediately.'
                                 : 'Quantity to hand over now.'}
                               className={`w-20 px-1.5 py-1 border rounded text-right text-xs ${negStock ? 'border-red-200 bg-red-50/40 cursor-not-allowed' : 'border-[#E8D5C4]'}`} />
                        <span className="ml-1 text-[10px] text-[#8B7355]">{ln.material_unit}</span>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono">
                        {short > 0
                          ? <span className="text-amber-700">{short} {ln.material_unit}</span>
                          : <span className="text-emerald-700">0</span>}
                      </td>
                      {raisePo && <>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1">
                            <input type="number" step="any" min={0}
                                   value={ln.quantity_to_purchase || ''}
                                   onChange={e => update(i, { quantity_to_purchase: Number(e.target.value) || 0 })}
                                   className="w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs" />
                            {/* Unit selector when the material has both a purchase
                                unit and a recipe unit (pack_size > 1). User picks
                                which one they're entering qty / price in; the
                                math + submit conversion both follow. */}
                            {ln.pack_size > 1 ? (
                              <select value={ln.po_entry_unit}
                                      onChange={e => {
                                        const newUnit = e.target.value;
                                        const oldUnit = ln.po_entry_unit;
                                        if (newUnit === oldUnit) return;
                                        // Convert the existing qty + price between
                                        // recipe and purchase units so the line
                                        // total stays the same after the switch.
                                        const goingToPurchase = newUnit === ln.purchase_unit;
                                        const newQty   = goingToPurchase
                                          ? Math.ceil((Number(ln.quantity_to_purchase) || 0) / ln.pack_size)
                                          : (Number(ln.quantity_to_purchase) || 0) * ln.pack_size;
                                        const newPrice = goingToPurchase
                                          ? (Number(ln.unit_price) || 0) * ln.pack_size
                                          : (Number(ln.unit_price) || 0) / ln.pack_size;
                                        update(i, { po_entry_unit: newUnit, quantity_to_purchase: newQty, unit_price: Math.round(newPrice * 100) / 100 });
                                      }}
                                      title="Switch between vendor's purchase unit and recipe unit. Math stays consistent."
                                      className="px-1 py-1 border border-[#E8D5C4] rounded text-xs bg-white">
                                <option value={ln.purchase_unit}>{ln.purchase_unit}</option>
                                <option value={ln.material_unit}>{ln.material_unit}</option>
                              </select>
                            ) : (
                              <span className="text-[10px] text-[#8B7355]">{ln.po_entry_unit}</span>
                            )}
                          </div>
                          {ln.pack_size > 1 && (
                            <div className="text-[9px] text-[#8B7355] mt-0.5">
                              1 {ln.purchase_unit} = {ln.pack_size} {ln.material_unit}
                            </div>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          <input type="number" step="any" value={ln.unit_price || ''}
                                 disabled={ln.quantity_to_purchase <= 0}
                                 onChange={e => update(i, { unit_price: Number(e.target.value) || 0 })}
                                 title={`Price per ${ln.po_entry_unit}`}
                                 className="w-20 px-1.5 py-1 border border-[#E8D5C4] rounded text-right text-xs disabled:opacity-50" />
                          <span className="ml-1 text-[10px] text-[#8B7355]">/{ln.po_entry_unit}</span>
                        </td>
                        <td className="py-1.5 px-2">
                          {/* Vendor dropdown — mapped vendors for this material
                              first (curated via /vendors/materials), then the
                              full active-vendor catalog. If the material has
                              zero mappings yet, the dropdown still shows every
                              active vendor so the PO never gets blocked. */}
                          {(() => {
                            const mapped  = vendorsByMaterial[ln.material_id] || [];
                            const mappedIds = new Set(mapped.map(v => v.id));
                            const others  = allVendors.filter(v => !mappedIds.has(v.id));
                            const disabled = ln.quantity_to_purchase <= 0;
                            return (
                              <select value={ln.vendor_id}
                                      disabled={disabled}
                                      onChange={e => {
                                        const vid = e.target.value;
                                        const v = [...mapped, ...others].find(x => x.id === vid);
                                        update(i, { vendor_id: vid, vendor: v?.name || '' });
                                      }}
                                      title={disabled
                                        ? 'Enter a Buy qty to enable vendor selection.'
                                        : mapped.length > 0
                                          ? `${mapped.length} vendor(s) mapped to this material on /vendors/materials.`
                                          : 'No mapped vendors yet — showing all active vendors.'}
                                      className="w-36 px-1.5 py-1 border border-[#E8D5C4] rounded text-xs bg-white disabled:opacity-50">
                                <option value="">— pick vendor —</option>
                                {mapped.length > 0 && (
                                  <optgroup label={`Mapped to ${ln.material_name}`}>
                                    {mapped.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                                  </optgroup>
                                )}
                                {others.length > 0 && (
                                  <optgroup label={mapped.length > 0 ? 'Other active vendors' : 'All active vendors'}>
                                    {others.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                                  </optgroup>
                                )}
                              </select>
                            );
                          })()}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">
                          {ln.quantity_to_purchase > 0
                            ? '₹' + (ln.quantity_to_purchase * ln.unit_price).toFixed(0)
                            : <span className="text-[#8B7355]">—</span>}
                        </td>
                      </>}
                    </tr>
                  );
                })}
              </tbody>
              {raisePo && (
                <tfoot>
                  <tr className="border-t border-[#E8D5C4] font-semibold bg-white">
                    <td colSpan={8} className="py-1.5 px-2 text-right">Vendor PO total</td>
                    <td className="py-1.5 px-2 text-right font-mono">₹{poTotal.toFixed(0)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className={`grid grid-cols-1 ${raisePo ? 'sm:grid-cols-2' : ''} gap-3`}>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              Store note (optional)
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                        placeholder="e.g. Issued at 11:30 to Hot Kitchen; rest pending Tuesday delivery"
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
            </label>
            {raisePo && (
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                Vendor PO date
                <input type="date" value={poDate} onChange={e => setPoDate(e.target.value)}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0]" />
              </label>
            )}
          </div>

          {raisePo ? (
            <div className="text-[11px] px-3 py-2 bg-blue-50 border border-blue-200 rounded">
              On submit: issuance recorded against the requisition (no stock change) + new vendor PO created in <b>pending</b> status. When that PO is received via GRN, stock increases and the requisition is fulfilled.
            </div>
          ) : totalShortfall > 0 ? (
            <div className="text-[11px] px-3 py-2 bg-amber-50 border border-amber-200 rounded">
              ⚠ Total shortfall: <b>{totalShortfall}</b> across the lines above. To buy the rest, either tick "Also raise vendor PO" above, or raise POs separately on the <a href="/purchase-orders" className="underline">Purchase Orders</a> page.
            </div>
          ) : (
            <div className="text-[11px] px-3 py-2 bg-emerald-50 border border-emerald-200 rounded">
              ✓ Every line fully issued — requisition will move to <b>Fulfilled</b> on submit.
            </div>
          )}
        </div>
        {/* Submit gate — when PO mode is on, the button is also disabled if no
            Buy line has qty + price + vendor yet (visual feedback before click). */}
        {(() => {
          const buyLines = lines.filter(ln => Number(ln.quantity_to_purchase) > 0);
          const poReady  = !raisePo || (
            buyLines.length > 0
            && buyLines.every(ln =>
              Number(ln.unit_price) > 0 && (ln.vendor_id || (ln.vendor || '').trim()))
          );
          const blockedReason = !raisePo ? ''
            : buyLines.length === 0
              ? 'Enter a Buy qty on at least one line, or untick "Also raise vendor PO".'
              : buyLines.some(ln => !(Number(ln.unit_price) > 0))
                ? 'Every Buy line needs a unit price > 0 before raising the PO.'
                : 'Every Buy line needs a vendor picked before raising the PO.';
          return (
            <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
              {raisePo && !poReady && (
                <span className="mr-auto text-[10px] text-amber-700">{blockedReason}</span>
              )}
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">Cancel</button>
              <button onClick={submit} disabled={busy || !poReady}
                      title={!poReady ? blockedReason : ''}
                      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">
                {busy ? 'Recording…' : (raisePo ? 'Issue + Raise PO' : 'Issue to Department')}
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
