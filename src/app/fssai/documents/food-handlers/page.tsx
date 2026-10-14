'use client';

/**
 * FOOD HANDLERS — the register behind Hyderabad audit lines #55 #56 #106 #107.
 *
 *   "Every food handler should have: medical examination records available"
 *   "Every food handler should have: food-safety training records available"
 *   Audit file: "Food-handler medical certificates", "Food-safety training records"
 *
 * ── THE ONE THING THIS SCREEN IS FOR ────────────────────────────────────────
 * Naming the person who is NOT covered. Before this screen a certificate could
 * only be filed against an app login, and every list was built from the
 * certificates on file — so the cook with no login and no medical was the one
 * row nothing could print. Here the list is of PEOPLE (from HRMS, from the
 * logins, or typed by hand — no login needed), and each one's medical, training
 * and FoSTaC state is worked out by the server on every load: Valid, Expiring,
 * No copy, EXPIRED or MISSING.
 *
 * Certificates are still documents: "File a certificate" here files it in
 * Documents & Certificates against the person (handler_id). A mistaken scan is
 * VOIDED, never removed — it stays, marked void, with the reason.
 *
 * Management only — the API refuses anyone else and this page then shows the
 * house permission panel. House idiom as on the Documents page: `flex-nowrap` on
 * icon rows (globals.css force-wraps .flex.gap-*), `bg-black/NN` modal overlays.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Ban, Download, FileText, Info, Link2, Loader2,
  Plus, RefreshCw, Search, ShieldCheck, UserCheck, UserPlus, Users, UserX, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';

/* ── shapes (mirrors of the server's, kept local: the server lib is not client-safe) ── */

type Verdict = 'valid' | 'expiring' | 'no_expiry' | 'no_copy' | 'expired' | 'missing' | 'not_required';
type ReqKey = 'medical' | 'training' | 'fostac';
interface Evidence {
  source: 'document' | 'hrms'; id: string; doc_type: string; type_label: string; title: string;
  reference_no: string; issued_on: string; expiry_date: string; state: string;
  days_to_expiry: number | null; copies: number; matched_by: string;
}
interface ReqResult {
  key: ReqKey; label: string; required: boolean; verdict: Verdict; verdict_label: string; verdict_color: string;
  in_order: boolean; best: Evidence | null; evidence: Evidence[]; todo: string;
}
interface Handler {
  id: string; handler_no: string; full_name: string; employee_id: string; employee_code: string;
  person_email: string; phone10: string; designation: string; department_id: string; department_name: string;
  is_food_handler: boolean; is_fostac_supervisor: boolean; joined_on: string; left_on: string;
  source: string; note: string; status: string; status_label: string; status_color: string;
  voided_at: string; voided_by: string; void_reason: string; created_by: string; created_at: string;
  key_kind: 'hrms' | 'login' | 'name_only'; user_name: string; hr_status: string; hr_exit_date: string;
  hr_says_left: boolean;
  coverage: Record<ReqKey, ReqResult> | null; in_order: boolean; problems: string[];
}
interface NotInOrderRow { id: string; handler_no: string; full_name: string; verdict: Verdict; verdict_label: string; expiry_date: string }
interface Unassigned { id: string; doc_type: string; type_label: string; title: string; person_email: string; handler_id: string; expiry_date: string; state: string; why: string }
interface TrainingLink {
  id: string; hr_training_id: string; training_name: string; hr_name: string; hr_active: boolean; counts_as: string;
  counts_as_label: string; valid_months: number | null; is_active: boolean; note: string; completions: number;
}
interface RegisterResponse {
  available: boolean; today: string; handlers: Handler[];
  totals: { active: number; food_handlers: number; left: number; in_order: number; not_in_order: number };
  fostac: { supervisors: number; certified: number; required: number; ok: boolean; handlers_per_supervisor: number; names: { id: string; full_name: string; verdict: Verdict }[]; words: string };
  not_in_order: Record<ReqKey, NotInOrderRow[]>;
  unassigned_certificates: Unassigned[];
  hr: { populated: boolean; employees: number; linked_handlers: number; links_active: number };
  basis: string;
  training_links: TrainingLink[];
  hr_trainings: { id: string; name: string; is_active: boolean; linked: boolean }[];
  person_doc_types: { key: string; label: string }[];
  link_counts_as: { key: string; label: string }[];
  departments: { id: string; name: string }[];
  logins: { email: string; name: string }[];
  can_void: boolean;
}
interface Candidate {
  source: 'hrms' | 'users'; id: string; full_name: string; employee_code: string; email: string; designation: string;
  department_name: string; status: string; will_link_to: string; left_row: string;
}
interface DocFileRow {
  id: string; data_uri: string; has_image: boolean; filename: string; created_by: string; created_at: string;
  is_void: boolean; voided_at: string; voided_by: string; void_reason: string; image_dropped_at: string;
}
interface Certificate {
  id: string; doc_type: string; type_label: string; title: string; reference_no: string; issuer: string;
  issued_on: string; expiry_date: string; is_active: boolean; status: string; void_reason: string;
  matched_by: string; files: DocFileRow[];
}
interface OneResponse {
  handler: Handler; certificates: Certificate[];
  trail: { action: string; field: string; reason: string; actor_email: string; actor_name: string; created_at: string }[];
  can_void: boolean;
}

const INPUT = 'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const BTN_PRIMARY = 'inline-flex flex-nowrap items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2 disabled:opacity-50';
const BTN_PLAIN = 'inline-flex flex-nowrap items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50';
const BTN_SMALL = 'inline-flex flex-nowrap items-center gap-1 text-xs border border-[#E8D5C4] bg-white rounded-lg px-2 py-1 hover:bg-[#FFF1E3] disabled:opacity-50';
const CARD = 'bg-white rounded-xl border border-[#E8D5C4]';
const LABEL = 'text-xs text-[#6B5744]';
const REQ = <span className="text-[#af4408]">*</span>;
const REQS: { key: ReqKey; label: string }[] = [
  { key: 'medical', label: 'Medical fitness' },
  { key: 'training', label: 'Food-safety training' },
  { key: 'fostac', label: 'FoSTaC (supervisor)' },
];

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span title={title} className={`inline-flex flex-nowrap items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${color}`}>
      {label}
    </span>
  );
}

function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className={`bg-white border border-[#E8D5C4] w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'} shadow-xl flex flex-col overflow-hidden rounded-t-3xl sm:rounded-xl max-h-[90vh]`}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <h2 className="font-bold text-[#2D1B0E] min-w-0 truncate">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] shrink-0">
            <X size={16} className="mx-auto" />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

/** One requirement's chip, with the date it rests on. */
function ReqChip({ r }: { r: ReqResult | undefined }) {
  if (!r) return <span className="text-xs text-[#B8A08A]">—</span>;
  if (!r.required) return <span className="text-xs text-[#B8A08A]">Not needed</span>;
  const date = r.best?.expiry_date ? ` · ${fmtISTDate(r.best.expiry_date)}` : '';
  return <Badge label={`${r.verdict_label}${r.verdict === 'missing' ? '' : date}`} color={r.verdict_color} title={r.todo || r.best?.title || ''} />;
}

function keyWords(h: Handler): string {
  if (h.key_kind === 'hrms') return `HRMS ${h.employee_code || ''}`.trim();
  if (h.key_kind === 'login') return h.person_email;
  return 'Name only (no login)';
}

/* ══════════════════════════════════════════════════════════════════════════ */

export default function FoodHandlersPage() {
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [includeLeft, setIncludeLeft] = useState(false);
  const [filter, setFilter] = useState<'' | 'not_in_order' | 'medical' | 'training' | 'fostac' | 'expiring'>('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Handler | 'new' | null>(null);
  const [importing, setImporting] = useState<'hrms' | 'users' | null>(null);
  const [openId, setOpenId] = useState('');
  const [showLinks, setShowLinks] = useState(false);

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 6000); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<RegisterResponse>(`/api/fssai/documents/food-handlers${includeLeft ? '?include_left=1' : ''}`);
      setData(j);
    } catch (e: unknown) {
      const m = errMsg(e, '');
      if (m.includes('management only')) setForbidden(true);
      else setErr(m || 'Could not load the register');
    } finally { setLoading(false); }
  }, [includeLeft]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const list = data?.handlers || [];
    const needle = q.trim().toLowerCase();
    return list.filter((h) => {
      if (needle && ![h.full_name, h.handler_no, h.designation, h.department_name, h.employee_code, h.person_email]
        .some((x) => String(x || '').toLowerCase().includes(needle))) return false;
      const c = h.coverage;
      if (!c) return !filter;
      if (filter === 'not_in_order') return h.status === 'active' && !h.in_order;
      if (filter === 'medical' || filter === 'training' || filter === 'fostac') return c[filter].required && !c[filter].in_order;
      if (filter === 'expiring') return REQS.some((r) => c[r.key].verdict === 'expiring');
      return true;
    });
  }, [data, q, filter]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            🔒 The food-handler register is restricted to management. Ask an administrator for access.
          </div>
        </div>
      </div>
    );
  }

  const t = data?.totals;
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/fssai/documents" className={BTN_PLAIN} aria-label="Back to Documents & Certificates"><ArrowLeft size={15} /> Documents</Link>
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0"><Users size={20} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Food Handlers</h1>
            <p className="text-xs text-[#8B7355]">Everyone who handles food, login or not — and whose medical, training or FoSTaC is missing.</p>
          </div>
          <button onClick={load} disabled={loading} className={BTN_PLAIN}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
          <a href="/api/fssai/documents/food-handlers?format=csv" className={BTN_PLAIN}><Download size={15} /> CSV</a>
          <button onClick={() => setEditing('new')} className={BTN_PRIMARY}><UserPlus size={15} /> Add a person</button>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
        {data && !data.available && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
            The food-handler register has not been created in this copy of the database yet. Restart the application once.
          </div>
        )}

        {/* WHERE THE PEOPLE COME FROM — Q18: HRMS when it is populated, else the logins. */}
        {data && (
          <div className={`${CARD} p-3 text-sm flex flex-wrap items-center gap-3`}>
            <span className="flex flex-nowrap items-start gap-2 min-w-0 flex-1">
              <Info size={16} className="mt-0.5 shrink-0 text-[#af4408]" />
              <span>
                {data.hr.populated
                  ? <>HRMS has <strong>{data.hr.employees}</strong> employee{data.hr.employees === 1 ? '' : 's'}; {data.hr.linked_handlers} person{data.hr.linked_handlers === 1 ? ' on this register is' : 's on this register are'} linked to one. Add food handlers from HRMS so the register follows HR.</>
                  : <>HRMS has no employees yet, so people are added from the staff logins or by name (owner ruling Q18). A cook does not need a login to be covered.</>}
              </span>
            </span>
            {data.hr.populated && <button onClick={() => setImporting('hrms')} className={BTN_PLAIN}><Users size={15} /> Add from HRMS</button>}
            <button onClick={() => setImporting('users')} className={BTN_PLAIN}><Users size={15} /> Add from logins</button>
            <button onClick={() => setShowLinks(true)} className={BTN_PLAIN}><Link2 size={15} /> HRMS trainings{data.hr.links_active ? ` (${data.hr.links_active})` : ''}</button>
          </div>
        )}

        {/* THE FoSTaC SUPERVISOR (#107) — the premises-level line, loud when short. */}
        {data && data.available && (
          <div role={data.fostac.ok ? undefined : 'alert'}
            className={`rounded-lg p-3 text-sm flex flex-nowrap items-start gap-2 border ${data.fostac.ok ? 'bg-green-50 border-green-200 text-green-900' : 'bg-red-50 border-red-300 text-red-900'}`}>
            {data.fostac.ok ? <ShieldCheck size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span>
              <strong>FoSTaC supervisor.</strong> {data.fostac.words}
              {data.fostac.names.length > 0 && <> ({data.fostac.names.map((n) => n.full_name).join(', ')})</>}
              {' '}FSSAI asks for at least one trained and certified Food Safety Supervisor for every {data.fostac.handlers_per_supervisor} food handlers.
            </span>
          </div>
        )}

        {t && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <button onClick={() => setFilter('')} className={`${CARD} p-3 text-left ${filter === '' ? 'ring-2 ring-[#af4408]' : ''}`}>
              <p className="text-2xl font-bold">{t.active}</p><p className="text-[11px] text-[#8B7355]">Working here ({t.food_handlers} handle food)</p>
            </button>
            <button onClick={() => setFilter(filter === 'not_in_order' ? '' : 'not_in_order')} className={`${CARD} p-3 text-left ${filter === 'not_in_order' ? 'ring-2 ring-[#af4408]' : ''}`}>
              <p className={`text-2xl font-bold ${t.not_in_order ? 'text-red-700' : 'text-green-700'}`}>{t.not_in_order}</p><p className="text-[11px] text-[#8B7355]">Not in order</p>
            </button>
            <button onClick={() => setFilter(filter === 'medical' ? '' : 'medical')} className={`${CARD} p-3 text-left ${filter === 'medical' ? 'ring-2 ring-[#af4408]' : ''}`}>
              <p className={`text-2xl font-bold ${data?.not_in_order.medical.length ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{data?.not_in_order.medical.length || 0}</p><p className="text-[11px] text-[#8B7355]">Medical missing / lapsed</p>
            </button>
            <button onClick={() => setFilter(filter === 'training' ? '' : 'training')} className={`${CARD} p-3 text-left ${filter === 'training' ? 'ring-2 ring-[#af4408]' : ''}`}>
              <p className={`text-2xl font-bold ${data?.not_in_order.training.length ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{data?.not_in_order.training.length || 0}</p><p className="text-[11px] text-[#8B7355]">Training missing / lapsed</p>
            </button>
            <button onClick={() => setFilter(filter === 'expiring' ? '' : 'expiring')} className={`${CARD} p-3 text-left ${filter === 'expiring' ? 'ring-2 ring-[#af4408]' : ''}`}>
              <p className="text-2xl font-bold text-amber-700">{(data?.handlers || []).filter((h) => h.coverage && REQS.some((r) => h.coverage![r.key].verdict === 'expiring')).length}</p><p className="text-[11px] text-[#8B7355]">Expiring soon</p>
            </button>
          </div>
        )}

        {/* WHO IS NOT COVERED — the inspector's list, by requirement, in words. */}
        {data && data.available && (data.not_in_order.medical.length > 0 || data.not_in_order.training.length > 0 || data.not_in_order.fostac.length > 0) && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 space-y-1">
            <p className="font-semibold flex flex-nowrap items-center gap-2"><AlertTriangle size={15} /> Who does not have a valid certificate</p>
            {REQS.map((r) => data.not_in_order[r.key].length > 0 && (
              <p key={r.key}>
                <strong>{r.label}:</strong>{' '}
                {data.not_in_order[r.key].map((x, i) => (
                  <span key={x.id}>
                    {i > 0 ? ', ' : ''}
                    <button className="underline" onClick={() => setOpenId(x.id)}>{x.full_name}</button>
                    {' '}({x.verdict_label}{x.expiry_date ? ` ${fmtISTDate(x.expiry_date)}` : ''})
                  </span>
                ))}
              </p>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name, number, department…" className={`${INPUT} mt-0 pl-9`} />
          </label>
          <label className="text-sm flex flex-nowrap items-center gap-2">
            <input type="checkbox" checked={includeLeft} onChange={(e) => setIncludeLeft(e.target.checked)} /> Show people who have left
          </label>
        </div>

        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className="bg-[#FFF1E3] text-left text-xs text-[#6B5744]">
              <tr>
                <th className="px-3 py-2">No.</th><th className="px-3 py-2">Person</th><th className="px-3 py-2">Identified by</th>
                <th className="px-3 py-2">Medical</th><th className="px-3 py-2">Training</th><th className="px-3 py-2">FoSTaC</th><th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && <tr><td colSpan={7} className="px-3 py-6 text-center text-[#8B7355]"><Loader2 size={16} className="animate-spin inline" /> Loading…</td></tr>}
              {data && rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-[#8B7355]">
                  {data.handlers.length === 0 ? 'Nobody is on the register yet. Add the people who handle food — from HRMS, from the logins, or by name.' : 'Nobody matches this filter.'}
                </td></tr>
              )}
              {rows.map((h) => (
                <tr key={h.id} className={`border-t border-[#F0E2D2] ${h.status !== 'active' ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{h.handler_no}</td>
                  <td className="px-3 py-2 min-w-[180px]">
                    <button className="font-semibold text-left hover:underline" onClick={() => setOpenId(h.id)}>{h.full_name}</button>
                    <p className="text-xs text-[#8B7355]">{[h.designation, h.department_name].filter(Boolean).join(' · ') || '—'}</p>
                    {h.status !== 'active' && <Badge label={h.status === 'left' ? `Left ${h.left_on ? fmtISTDate(h.left_on) : ''}` : h.status_label} color={h.status_color} />}
                    {h.hr_says_left && <Badge label={`HRMS says ${h.hr_status}`} color="bg-amber-100 text-amber-800 border-amber-200" title="Mark them as left here if they no longer work here." />}
                    {h.is_fostac_supervisor && <Badge label="FoSTaC supervisor" color="bg-indigo-50 text-indigo-700 border-indigo-200" />}
                  </td>
                  <td className="px-3 py-2 text-xs text-[#6B5744]">{keyWords(h)}</td>
                  <td className="px-3 py-2"><ReqChip r={h.coverage?.medical} /></td>
                  <td className="px-3 py-2"><ReqChip r={h.coverage?.training} /></td>
                  <td className="px-3 py-2"><ReqChip r={h.coverage?.fostac} /></td>
                  <td className="px-3 py-2 text-right"><button onClick={() => setOpenId(h.id)} className={BTN_SMALL}><FileText size={13} /> Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* CERTIFICATES THAT MATCH NOBODY — filed against a login not on the register, or a voided row. */}
        {data && data.unassigned_certificates.length > 0 && (
          <UnassignedPanel rows={data.unassigned_certificates} handlers={data.handlers.filter((h) => h.status !== 'void')} onDone={(m) => { say(m); load(); }} />
        )}

        {data && <p className="text-[11px] text-[#8B7355] leading-relaxed">{data.basis}</p>}
      </div>

      {editing && data && (
        <HandlerForm handler={editing === 'new' ? null : editing} data={data} onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); say(m); load(); }} />
      )}
      {importing && (
        <ImportModal source={importing} onClose={() => setImporting(null)} onDone={(m) => { setImporting(null); say(m); load(); }} />
      )}
      {openId && data && (
        <HandlerDetail id={openId} data={data} onClose={() => setOpenId('')} onChanged={(m) => { say(m); load(); }}
          onEdit={(h) => { setOpenId(''); setEditing(h); }} />
      )}
      {showLinks && data && (
        <TrainingLinks data={data} onClose={() => setShowLinks(false)} onChanged={(m) => { say(m); load(); }} />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] bg-[#2D1B0E] text-white text-sm rounded-lg px-4 py-2 shadow-lg max-w-[90vw]">{toast}</div>
      )}
    </div>
  );
}

/* ── add / edit a person ─────────────────────────────────────────────────── */

function HandlerForm({ handler, data, onClose, onSaved }: {
  handler: Handler | null; data: RegisterResponse; onClose: () => void; onSaved: (m: string) => void;
}) {
  const [fullName, setFullName] = useState(handler?.full_name || '');
  const [designation, setDesignation] = useState(handler?.designation || '');
  const [departmentId, setDepartmentId] = useState(handler?.department_id || '');
  const [phone, setPhone] = useState(handler?.phone10 || '');
  const [email, setEmail] = useState(handler?.person_email || '');
  const [joinedOn, setJoinedOn] = useState(handler?.joined_on || '');
  const [isFH, setIsFH] = useState(handler ? handler.is_food_handler : true);
  const [isSup, setIsSup] = useState(handler ? handler.is_fostac_supervisor : false);
  const [note, setNote] = useState(handler?.note || '');
  const [employeeId, setEmployeeId] = useState(handler?.employee_id || '');
  const [hrPeople, setHrPeople] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Q18: once HRMS is populated, a person typed by name can be LINKED to their
  // HR record here (the HR record becomes the key) instead of being re-added.
  useEffect(() => {
    if (!data.hr.populated) return;
    apiJson<{ candidates: Candidate[] }>('/api/fssai/documents/food-handlers?candidates=hrms')
      .then((j) => setHrPeople((j.candidates || []).filter((c) => !c.left_row)))
      .catch(() => setHrPeople([]));
  }, [data.hr.populated]);

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<{ warnings?: string[] }>('/api/fssai/documents/food-handlers', {
        method: 'POST',
        body: {
          action: handler ? 'update' : 'create', id: handler?.id,
          full_name: fullName, designation, department_id: departmentId, phone10: phone, person_email: email,
          joined_on: joinedOn, is_food_handler: isFH ? 1 : 0, is_fostac_supervisor: isSup ? 1 : 0, note,
          ...(data.hr.populated ? { employee_id: employeeId } : {}),
        },
      });
      onSaved([handler ? 'Saved.' : 'Added to the register.', ...(j.warnings || [])].join(' '));
    } catch (e: unknown) { setErr(errMsg(e, 'Could not save')); } finally { setBusy(false); }
  }

  return (
    <Modal title={handler ? `Edit ${handler.full_name}` : 'Add a person to the register'} onClose={onClose}
      footer={<>
        <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
        <button onClick={save} disabled={busy || fullName.trim().length < 2 || (!isFH && !isSup)} className={BTN_PRIMARY}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />} Save
        </button>
      </>}>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-800">{err}</div>}
      <p className="text-xs text-[#6B5744]">A food handler does not need a login. {data.hr.populated ? 'If they are on the payroll, add them from HRMS instead so the register follows HR.' : ''}</p>
      <label className="block"><span className={LABEL}>Full name {REQ}</span><input value={fullName} onChange={(e) => setFullName(e.target.value)} className={INPUT} /></label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className={LABEL}>Designation</span><input value={designation} onChange={(e) => setDesignation(e.target.value)} className={INPUT} placeholder="Commis, tandoor cook, steward…" /></label>
        <label className="block"><span className={LABEL}>Department</span>
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={INPUT}>
            <option value="">—</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="block"><span className={LABEL}>Phone (10 digits)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} className={INPUT} inputMode="tel" /></label>
        <label className="block"><span className={LABEL}>Joined on</span><input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} className={INPUT} /></label>
      </div>
      {data.hr.populated && (
        <label className="block"><span className={LABEL}>Their HRMS record</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={INPUT}>
            <option value="">Not in HRMS</option>
            {handler?.employee_id && <option value={handler.employee_id}>{handler.full_name} — {handler.employee_code || 'linked'}</option>}
            {hrPeople.filter((c) => c.id !== handler?.employee_id).map((c) => (
              <option key={c.id} value={c.id}>{c.full_name}{c.employee_code ? ` — ${c.employee_code}` : ''}{c.designation ? ` · ${c.designation}` : ''}</option>
            ))}
          </select>
        </label>
      )}
      <label className="block"><span className={LABEL}>Their login, if they have one</span>
        <select value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT}>
          <option value="">No login</option>
          {data.logins.map((u) => <option key={u.email} value={u.email}>{u.name ? `${u.name} — ${u.email}` : u.email}</option>)}
        </select>
      </label>
      <div className="space-y-2 text-sm">
        <label className="flex flex-nowrap items-center gap-2"><input type="checkbox" checked={isFH} onChange={(e) => setIsFH(e.target.checked)} /> Handles food (needs a medical and food-safety training)</label>
        <label className="flex flex-nowrap items-center gap-2"><input type="checkbox" checked={isSup} onChange={(e) => setIsSup(e.target.checked)} /> The FoSTaC-trained Food Safety Supervisor (needs a FoSTaC certificate)</label>
      </div>
      <label className="block"><span className={LABEL}>Note</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} /></label>
    </Modal>
  );
}

/* ── import from HRMS or the logins ──────────────────────────────────────── */

function ImportModal({ source, onClose, onDone }: { source: 'hrms' | 'users'; onClose: () => void; onDone: (m: string) => void }) {
  const [list, setList] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [handlesFood, setHandlesFood] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    apiJson<{ candidates: Candidate[] }>(`/api/fssai/documents/food-handlers?candidates=${source}`)
      .then((j) => setList(j.candidates || []))
      .catch((e: unknown) => setErr(errMsg(e, 'Could not load the list')));
  }, [source]);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectable = (list || []).filter((c) => !c.left_row);
  async function go() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<{ created: unknown[]; linked: unknown[]; skipped: { name: string; why: string }[]; warnings?: string[] }>('/api/fssai/documents/food-handlers', {
        method: 'POST', body: { action: 'import', source, ids: [...picked], is_food_handler: handlesFood ? 1 : 0 },
      });
      const bits = [`${j.created.length} added`];
      if (j.linked.length) bits.push(`${j.linked.length} linked to their existing row`);
      if (j.skipped.length) bits.push(`${j.skipped.length} skipped (${j.skipped.map((s) => `${s.name}: ${s.why}`).join('; ')})`);
      onDone([bits.join(', ') + '.', ...(j.warnings || [])].join(' '));
    } catch (e: unknown) { setErr(errMsg(e, 'Could not add them')); } finally { setBusy(false); }
  }
  return (
    <Modal title={source === 'hrms' ? 'Add food handlers from HRMS' : 'Add food handlers from the staff logins'} onClose={onClose} wide
      footer={<>
        <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
        <button onClick={go} disabled={busy || picked.size === 0} className={BTN_PRIMARY}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Add {picked.size || ''}
        </button>
      </>}>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-800">{err}</div>}
      <p className="text-xs text-[#6B5744]">
        Only people not already on the register are listed. {source === 'hrms' ? 'Someone whose login is already on the register is linked to that row, never added twice. People HRMS shows as resigned or terminated are left out.' : ''}
      </p>
      <label className="text-sm flex flex-nowrap items-center gap-2"><input type="checkbox" checked={handlesFood} onChange={(e) => setHandlesFood(e.target.checked)} /> They handle food</label>
      {!list && !err && <p className="text-sm text-[#8B7355]"><Loader2 size={14} className="animate-spin inline" /> Loading…</p>}
      {list && list.length === 0 && <p className="text-sm text-[#8B7355]">Everybody {source === 'hrms' ? 'in HRMS' : 'with a login'} is already on the register.</p>}
      {list && list.length > 0 && (
        <>
          <button className={BTN_SMALL} onClick={() => setPicked(picked.size === selectable.length ? new Set() : new Set(selectable.map((c) => c.id)))}>
            {picked.size === selectable.length ? 'Clear all' : 'Select all'}
          </button>
          <div className="divide-y divide-[#F0E2D2] border border-[#E8D5C4] rounded-lg">
            {list.map((c) => (
              <label key={c.id} className={`flex flex-nowrap items-start gap-3 px-3 py-2 text-sm ${c.left_row ? 'opacity-60' : ''}`}>
                <input type="checkbox" disabled={!!c.left_row} checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="mt-1" />
                <span className="min-w-0">
                  <strong>{c.full_name}</strong>{c.employee_code ? ` · ${c.employee_code}` : ''}{c.email ? ` · ${c.email}` : ''}
                  <span className="block text-xs text-[#8B7355]">{[c.designation, c.department_name, c.status].filter(Boolean).join(' · ')}</span>
                  {c.will_link_to && <span className="block text-xs text-indigo-700">Will be linked to their existing row on the register.</span>}
                  {c.left_row && <span className="block text-xs text-amber-700">On the register as left — open them and use Rejoined.</span>}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/* ── one person: coverage, certificates, file a certificate, leave / rejoin / void ── */

function HandlerDetail({ id, data, onClose, onChanged, onEdit }: {
  id: string; data: RegisterResponse; onClose: () => void; onChanged: (m: string) => void; onEdit: (h: Handler) => void;
}) {
  const [one, setOne] = useState<OneResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [filing, setFiling] = useState<string>('');
  const reload = useCallback(async () => {
    try { setOne(await apiJson<OneResponse>(`/api/fssai/documents/food-handlers?id=${encodeURIComponent(id)}`)); }
    catch (e: unknown) { setErr(errMsg(e, 'Could not load this person')); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/documents/food-handlers', { method: 'POST', body: { id, ...body } });
      onChanged(done); await reload();
    } catch (e: unknown) { setErr(errMsg(e, 'Could not save')); } finally { setBusy(false); }
  }
  async function voidFile(docId: string, fileId: string) {
    const reason = window.prompt('Why is this scan being voided? It stays on the certificate, marked void, with your reason.') || '';
    if (reason.trim().length < 4) { setErr('A reason of at least four characters is needed.'); return; }
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/documents', { method: 'POST', body: { action: 'void_file', id: docId, attachment_id: fileId, reason } });
      onChanged('Scan voided. It stays on the certificate, marked void.'); await reload();
    } catch (e: unknown) { setErr(errMsg(e, 'Could not void the scan')); } finally { setBusy(false); }
  }
  async function addScan(docId: string, uri: string) {
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/documents', { method: 'POST', body: { action: 'attach', id: docId, data_uri: uri, kind: 'certificate' } });
      onChanged('Scan attached.'); await reload();
    } catch (e: unknown) { setErr(errMsg(e, 'Could not attach the scan')); } finally { setBusy(false); }
  }

  const h = one?.handler;
  return (
    <Modal title={h ? `${h.full_name} · ${h.handler_no}` : 'Loading…'} onClose={onClose} wide
      footer={h && h.status !== 'void' ? <>
        <button onClick={() => onEdit(h)} disabled={busy} className={BTN_PLAIN}>Edit details</button>
        {h.status === 'active' && (
          <button disabled={busy} className={BTN_PLAIN} onClick={() => {
            const d = window.prompt('Last working day (YYYY-MM-DD). Their row and certificates stay.', data.today) || '';
            if (d) act({ action: 'leave', left_on: d }, `${h.full_name} marked as left.`);
          }}><UserX size={15} /> Has left</button>
        )}
        {h.status === 'left' && (
          <button disabled={busy} className={BTN_PLAIN} onClick={() => act({ action: 'rejoin' }, `${h.full_name} is working here again.`)}><UserCheck size={15} /> Rejoined</button>
        )}
        {one?.can_void && (
          <button disabled={busy} className={BTN_PLAIN} onClick={() => {
            const reason = window.prompt('Void is for a row entered by MISTAKE (a duplicate, a wrong person). Someone who left is "Has left". Why void it?') || '';
            if (reason.trim().length < 4) { setErr('A reason of at least four characters is needed.'); return; }
            act({ action: 'void', reason }, 'Voided; the row stays with its reason.');
          }}><Ban size={15} /> Void</button>
        )}
      </> : undefined}>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-800">{err}</div>}
      {!one && !err && <p className="text-sm text-[#8B7355]"><Loader2 size={14} className="animate-spin inline" /> Loading…</p>}
      {h && (
        <>
          <div className="text-sm space-y-1">
            <p>{[h.designation, h.department_name].filter(Boolean).join(' · ') || 'No designation recorded'}{h.phone10 ? ` · ${h.phone10}` : ''}</p>
            <p className="text-xs text-[#6B5744]">Identified by: {keyWords(h)}{h.joined_on ? ` · joined ${fmtISTDate(h.joined_on)}` : ''}{h.left_on ? ` · left ${fmtISTDate(h.left_on)}` : ''}</p>
            {h.status === 'void' && <p className="text-xs text-red-700">Voided {fmtIST(h.voided_at)} by {h.voided_by}: {h.void_reason}</p>}
            {h.hr_says_left && <p className="text-xs text-amber-800">HRMS shows this person as {h.hr_status}{h.hr_exit_date ? ` from ${fmtISTDate(h.hr_exit_date)}` : ''}. Mark them as left here if they no longer work here.</p>}
          </div>
          {h.coverage && (
            <div className="grid sm:grid-cols-3 gap-2">
              {REQS.map((r) => {
                const c = h.coverage![r.key];
                return (
                  <div key={r.key} className={`${CARD} p-3 space-y-1`}>
                    <p className="text-xs text-[#6B5744]">{r.label}</p>
                    <ReqChip r={c} />
                    {c.best && <p className="text-xs">{c.best.title}{c.best.source === 'hrms' ? ' (HRMS)' : ''}</p>}
                    {c.todo && <p className="text-xs text-[#8B4513]">{c.todo}</p>}
                    {c.required && h.status === 'active' && (
                      <button className={BTN_SMALL} onClick={() => setFiling(r.key === 'medical' ? 'medical_fitness' : r.key === 'fostac' ? 'fostac_certificate' : 'food_handler_training')}>
                        <Plus size={12} /> File a certificate
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {filing && h.status !== 'void' && (
            <FileCertificate handler={h} docType={filing} data={data} onCancel={() => setFiling('')}
              onFiled={async (m) => { setFiling(''); onChanged(m); await reload(); }} />
          )}
          <div>
            <p className="text-sm font-semibold mb-1">Certificates on file</p>
            {one!.certificates.length === 0 && <p className="text-sm text-[#8B7355]">None yet.</p>}
            <div className="space-y-2">
              {one!.certificates.map((c) => (
                <div key={c.id} className={`border border-[#E8D5C4] rounded-lg p-2 text-sm ${!c.is_active || c.status === 'void' ? 'opacity-70' : ''}`}>
                  <p className="font-semibold">{c.type_label} — {c.title}</p>
                  <p className="text-xs text-[#6B5744]">
                    {c.reference_no ? `No. ${c.reference_no} · ` : ''}{c.issued_on ? `issued ${fmtISTDate(c.issued_on)} · ` : ''}
                    {c.expiry_date ? `expires ${fmtISTDate(c.expiry_date)}` : 'no expiry date'}
                    {c.status === 'void' ? ` · VOIDED: ${c.void_reason}` : !c.is_active ? ' · replaced by a renewal' : ''}
                    {c.matched_by === 'person_email' ? ' · filed against their login' : ''}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {c.files.map((f) => (
                      <div key={f.id} className={`text-xs ${f.is_void ? 'opacity-60' : ''}`}>
                        {f.has_image && f.data_uri ? <ImageThumb src={f.data_uri} size={64} /> : <span className="text-[#8B7355]">(no image)</span>}
                        {f.is_void
                          ? <p className="text-red-700 max-w-[140px]">VOID — {f.void_reason} ({f.voided_by})</p>
                          : c.status !== 'void' && <button className="underline" disabled={busy} onClick={() => voidFile(c.id, f.id)}>Void scan</button>}
                      </div>
                    ))}
                    {c.status !== 'void' && c.is_active && (
                      <ImageUpload value={[]} onAdd={(u) => addScan(c.id, u)} label="Add a scan" thumbSize={48} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {one!.trail.length > 0 && (
            <details className="text-xs text-[#6B5744]">
              <summary className="cursor-pointer">History ({one!.trail.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {one!.trail.map((t, i) => <li key={i}>{fmtIST(t.created_at)} · {t.action}{t.field ? ` (${t.field})` : ''} · {t.actor_name || t.actor_email}{t.reason ? ` — ${t.reason}` : ''}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

function FileCertificate({ handler, docType, data, onCancel, onFiled }: {
  handler: Handler; docType: string; data: RegisterResponse; onCancel: () => void; onFiled: (m: string) => void;
}) {
  const [type, setType] = useState(docType);
  const label = data.person_doc_types.find((t) => t.key === type)?.label || 'Certificate';
  const [title, setTitle] = useState(`${label} — ${handler.full_name}`);
  const [ref, setRef] = useState('');
  const [issuer, setIssuer] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiry, setExpiry] = useState('');
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function file() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<{ document: { id: string } }>('/api/fssai/documents', {
        method: 'POST',
        body: { action: 'create', doc_type: type, title, reference_no: ref, issuer, issued_on: issuedOn, expiry_date: expiry, handler_id: handler.id },
      });
      if (scan) {
        await apiJson('/api/fssai/documents', { method: 'POST', body: { action: 'attach', id: j.document.id, data_uri: scan, kind: 'certificate' } });
      }
      onFiled(scan ? 'Certificate filed with its scan.' : 'Certificate filed. Add a scan — without a copy it cannot be shown to an inspector.');
    } catch (e: unknown) { setErr(errMsg(e, 'Could not file the certificate')); } finally { setBusy(false); }
  }
  return (
    <div className="border-2 border-[#af4408]/30 rounded-lg p-3 space-y-3 bg-[#FFF8F0]">
      <p className="text-sm font-semibold">File a certificate for {handler.full_name}</p>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-800">{err}</div>}
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className={LABEL}>Kind {REQ}</span>
          <select value={type} onChange={(e) => { setType(e.target.value); setTitle(`${data.person_doc_types.find((t) => t.key === e.target.value)?.label || 'Certificate'} — ${handler.full_name}`); }} className={INPUT}>
            {data.person_doc_types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="block"><span className={LABEL}>Name {REQ}</span><input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} /></label>
        <label className="block"><span className={LABEL}>Certificate number</span><input value={ref} onChange={(e) => setRef(e.target.value)} className={INPUT} /></label>
        <label className="block"><span className={LABEL}>Issued by (doctor, clinic, trainer)</span><input value={issuer} onChange={(e) => setIssuer(e.target.value)} className={INPUT} /></label>
        <label className="block"><span className={LABEL}>Issued on</span><input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={INPUT} /></label>
        <label className="block"><span className={LABEL}>Expires on</span><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={INPUT} /></label>
      </div>
      {type === 'medical_fitness' && !expiry && <p className="text-xs text-amber-800">A medical certificate with no expiry date is not counted as in order — FSSAI asks for one at least every year.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {scan ? <ImageThumb src={scan} size={64} onRemove={() => setScan('')} /> : <ImageUpload value={[]} onAdd={(u) => setScan(u)} label="Add the scan" thumbSize={64} />}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className={BTN_PLAIN}>Cancel</button>
        <button onClick={file} disabled={busy || title.trim().length < 3} className={BTN_PRIMARY}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />} File it
        </button>
      </div>
    </div>
  );
}

/* ── certificates matched to nobody ──────────────────────────────────────── */

function UnassignedPanel({ rows, handlers, onDone }: { rows: Unassigned[]; handlers: Handler[]; onDone: (m: string) => void }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  async function link(docId: string) {
    const hid = pick[docId];
    if (!hid) return;
    setErr('');
    try {
      await apiJson('/api/fssai/documents', { method: 'POST', body: { action: 'update', id: docId, handler_id: hid, reason: 'Linked to the person on the food-handler register' } });
      onDone('Certificate linked to the person.');
    } catch (e: unknown) { setErr(errMsg(e, 'Could not link it')); }
  }
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 space-y-2">
      <p className="font-semibold flex flex-nowrap items-center gap-2"><Info size={15} /> Certificates that belong to nobody on the register ({rows.length})</p>
      {err && <p className="text-red-700">{err}</p>}
      {rows.map((u) => (
        <div key={u.id} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">{u.type_label} — {u.title}{u.expiry_date ? ` (expires ${fmtISTDate(u.expiry_date)})` : ''}. <span className="text-xs">{u.why}</span></span>
          <select value={pick[u.id] || ''} onChange={(e) => setPick({ ...pick, [u.id]: e.target.value })} className="border border-[#D4B896] rounded-lg px-2 py-1 text-sm bg-white">
            <option value="">Pick the person…</option>
            {handlers.map((h) => <option key={h.id} value={h.id}>{h.full_name} ({h.handler_no})</option>)}
          </select>
          <button className={BTN_SMALL} disabled={!pick[u.id]} onClick={() => link(u.id)}><Link2 size={12} /> Link</button>
        </div>
      ))}
    </div>
  );
}

/* ── which HRMS trainings count ──────────────────────────────────────────── */

function TrainingLinks({ data, onClose, onChanged }: { data: RegisterResponse; onClose: () => void; onChanged: (m: string) => void }) {
  const [trainingId, setTrainingId] = useState('');
  const [countsAs, setCountsAs] = useState('food_handler_training');
  const [months, setMonths] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true); setErr('');
    try { await apiJson('/api/fssai/documents/food-handlers', { method: 'POST', body }); onChanged(done); }
    catch (e: unknown) { setErr(errMsg(e, 'Could not save')); } finally { setBusy(false); }
  }
  const free = data.hr_trainings.filter((t) => !t.linked);
  return (
    <Modal title="Which HRMS trainings count" onClose={onClose} wide>
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-sm text-red-800">{err}</div>}
      <p className="text-xs text-[#6B5744]">
        HRMS records who completed which training. Say here which of its trainings an inspector would accept, and for how long a
        completion counts. A completion is then read from HRMS on every load — nothing is copied, and HRMS stays where it is recorded.
      </p>
      {data.training_links.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[#6B5744]"><tr><th className="py-1">HRMS training</th><th>Counts as</th><th>Valid for</th><th>Completions</th><th></th></tr></thead>
          <tbody>
            {data.training_links.map((l) => (
              <tr key={l.id} className={`border-t border-[#F0E2D2] ${l.is_active ? '' : 'opacity-60'}`}>
                <td className="py-1">{l.hr_name || l.training_name}</td>
                <td>{l.counts_as_label}</td>
                <td>{l.valid_months ? `${l.valid_months} months` : 'No expiry'}</td>
                <td>{l.completions}</td>
                <td className="text-right">
                  {l.is_active
                    ? <button className={BTN_SMALL} disabled={busy} onClick={() => {
                      const reason = window.prompt('Switching this off changes who counts as trained. Why?') || '';
                      if (reason.trim().length < 4) { setErr('A reason of at least four characters is needed.'); return; }
                      post({ action: 'update_link', id: l.id, is_active: 0, reason }, 'Mapping switched off.');
                    }}>Switch off</button>
                    : <button className={BTN_SMALL} disabled={busy} onClick={() => post({ action: 'update_link', id: l.id, is_active: 1 }, 'Mapping switched on.')}>Switch on</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.hr_trainings.length === 0
        ? <p className="text-sm text-[#8B7355]">HRMS has no trainings set up yet.</p>
        : free.length > 0 && (
          <div className="grid sm:grid-cols-4 gap-2 items-end">
            <label className="block sm:col-span-2"><span className={LABEL}>HRMS training</span>
              <select value={trainingId} onChange={(e) => setTrainingId(e.target.value)} className={INPUT}>
                <option value="">Pick one…</option>
                {free.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_active ? '' : ' (inactive in HRMS)'}</option>)}
              </select>
            </label>
            <label className="block"><span className={LABEL}>Counts as</span>
              <select value={countsAs} onChange={(e) => setCountsAs(e.target.value)} className={INPUT}>
                {data.link_counts_as.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label className="block"><span className={LABEL}>Valid for (months, blank = no expiry)</span>
              <input value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} className={INPUT} inputMode="numeric" />
            </label>
            <div className="sm:col-span-4 flex justify-end">
              <button className={BTN_PRIMARY} disabled={busy || !trainingId}
                onClick={() => post({ action: 'link_training', hr_training_id: trainingId, counts_as: countsAs, valid_months: months || null }, 'The training now counts.')}>
                <Plus size={15} /> Count it
              </button>
            </div>
          </div>
        )}
    </Modal>
  );
}
