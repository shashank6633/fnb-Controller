'use client';

/**
 * FSSAI CHECKLISTS — THE LIBRARY.
 *
 * The screen where a checklist stops being a developer's job. Every checklist the
 * restaurant runs is a ROW, not code (owner §24), and this is where those rows are
 * created, named, published, assigned, archived and brought back.
 *
 * WHAT THIS SCREEN IS NOT. It is not the builder — sections, questions and the eight
 * kinds of answer live at /fssai/settings/checklists/[id], and every "Build" button
 * here leads there. It is not the phone runner either: running a check is the next
 * piece of work, and this page says so in one line rather than showing a button that
 * does nothing.
 *
 * THE API IS ALREADY BUILT AND THIS PAGE ONLY DRIVES IT (the P2a contract):
 *   GET    /api/fssai/templates?q=&status=&module_key=&department_id=&include_archived=1
 *   POST   /api/fssai/templates                    create · { action:'duplicate' }
 *   PUT    /api/fssai/templates                    edit the header
 *   DELETE /api/fssai/templates?id=[&purge=1][&reason=]
 *   POST   /api/fssai/templates/[id]               publish · unpublish · archive · restore
 *   GET/POST/PUT/DELETE /api/fssai/assignments     who owes it, and how often
 *   GET    /api/fssai/masters                      every dropdown, admin only
 *   GET    /api/fssai/runs                         used ONLY for "last recorded"
 * Every mutation goes through api()/apiJson() so the fnb_csrf header is sent — a
 * bare fetch() would be refused, and that is deliberate.
 *
 * THREE THINGS THIS SCREEN HAS TO SAY OUT LOUD, because getting them wrong is how a
 * compliance file starts lying:
 *   1. VERSION. Only four header fields change what was ASKED or how it was JUDGED
 *      (FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS). Renaming is not one of them, so the
 *      edit modal states, before you save, whether this change bumps the version —
 *      and states that records already taken keep the wording they were taken under,
 *      because P2a freezes the sheet-as-asked into the record at submit.
 *   2. ARCHIVED IS NOT DELETED (owner §19). Archiving stops new checks and stands
 *      down the live assignments; the records stay readable and Restore brings the
 *      checklist back as a DRAFT so it is re-read before it goes live again. The
 *      hard delete is offered only while a checklist has never been run, and it
 *      demands a typed reason.
 *   3. WHOSE DATA IS WHOSE. Departments, roles and people are the owner's production
 *      configuration (HARD RULE 4). This screen reads them from /api/fssai/masters
 *      and can never create or change one.
 *
 * Styling is the house skeleton verbatim (docs/fssai/RECON.md §1.3-1.5): the #FFF8F0
 * page, the #af4408 brand heading with an icon tile, white cards bordered #E8D5C4,
 * cards under md and a table from md up, native <select> and <input type="date">,
 * a per-page toast, a bg-black/40 modal overlay (the class globals.css:295 needs to
 * lock the page behind it). Nothing new is invented and no shared component is added.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Copy,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import {
  FSSAI_FREQUENCIES,
  FSSAI_MODULE_KEYS,
  FSSAI_SHIFTS,
  FSSAI_TARGET_KINDS,
  FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS,
  fssaiConfigWarnings,
  fssaiTemplateStatusMeta,
  templateEditBumpsVersion,
} from '@/lib/fssai';
import { FSSAI_MODULES } from '../_components/modules';
import Toggle from '@/components/Toggle';
import { fmtISTDate } from '@/lib/format-date';

/* ──────────────────────────────────────────────────────────────────────────
 * Row shapes — exactly the columns the API returns. Nothing is computed here
 * that the server already counted.
 * ────────────────────────────────────────────────────────────────────────── */

interface TemplateRow {
  id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  module_key: string;
  frequency: string;
  department_id: string;
  responsible_role_id: string;
  target_kind: string;
  requires_signature: number;
  requires_verification: number;
  allow_backdate_days: number;
  pass_threshold_pct: number;
  version: number;
  status: string;
  is_active: number;
  is_seeded: number;
  sort_order: number;
  published_by: string;
  published_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Server-side counts (live rows only — retired questions are not counted). */
  section_count: number;
  question_count: number;
  run_count: number;
  open_run_count: number;
  assignment_count: number;
  department_name: string | null;
  responsible_role_name: string | null;
}

interface AssignmentRow {
  id: string;
  template_id: string;
  department_id: string;
  assignee_email: string;
  responsible_role_id: string;
  target_kind: string;
  target_id: string;
  target_label: string;
  shift: string;
  frequency: string;
  day_of_week: number;
  day_of_month: number;
  times_csv: string;
  grace_minutes: number;
  next_due_date: string;
  last_run_date: string;
  is_active: number;
  department_name?: string | null;
  responsible_role_name?: string | null;
  assignee_name?: string | null;
}

interface MasterDept { id: string; name: string; code: string; is_active: number }
interface MasterRole { id: string; name: string; base_role: string; is_active: number }
interface MasterUser { email: string; name: string; position: string; department_id: string }
interface Masters { departments: MasterDept[]; roles: MasterRole[]; users: MasterUser[] }

interface RunRow { id: string; template_id: string; business_date: string; status: string }

/** The header fields the PUT accepts — the draft the two modals edit. */
interface HeaderDraft {
  name: string;
  code: string;
  description: string;
  category: string;
  module_key: string;
  frequency: string;
  department_id: string;
  responsible_role_id: string;
  target_kind: string;
  requires_signature: number;
  requires_verification: number;
  allow_backdate_days: number;
  pass_threshold_pct: number;
}

const BLANK_DRAFT: HeaderDraft = {
  name: '',
  code: '',
  description: '',
  category: 'Compliance',
  module_key: '',
  frequency: 'daily',
  department_id: '',
  responsible_role_id: '',
  target_kind: 'none',
  requires_signature: 1,
  requires_verification: 1,
  allow_backdate_days: 1,
  pass_threshold_pct: 100,
};

function draftFrom(t: TemplateRow): HeaderDraft {
  return {
    name: t.name || '',
    code: t.code || '',
    description: t.description || '',
    category: t.category || 'Compliance',
    module_key: t.module_key || '',
    frequency: t.frequency || 'daily',
    department_id: t.department_id || '',
    responsible_role_id: t.responsible_role_id || '',
    target_kind: t.target_kind || 'none',
    requires_signature: Number(t.requires_signature) ? 1 : 0,
    requires_verification: Number(t.requires_verification) ? 1 : 0,
    allow_backdate_days: Number(t.allow_backdate_days) || 0,
    pass_threshold_pct: Number(t.pass_threshold_pct),
  };
}

/* ── label lookups. Every vocabulary comes from src/lib/fssai.ts so this screen
 *    and the server cannot drift; the food-safety-area labels come from
 *    modules.ts, which holds the same twenty strings as the sidebar. ── */

const MODULE_LABEL = new Map(
  FSSAI_MODULES.map((m) => [m.href.replace(/^\/fssai\/?/, ''), m.label] as const),
);
const freqLabel = (k: string) => FSSAI_FREQUENCIES.find((f) => f.key === k)?.label || k || '—';
const freqHint = (k: string) => FSSAI_FREQUENCIES.find((f) => f.key === k)?.hint || '';
const targetLabel = (k: string) => FSSAI_TARGET_KINDS.find((t) => t.key === k)?.label || k || '—';
const targetHint = (k: string) => FSSAI_TARGET_KINDS.find((t) => t.key === k)?.hint || '';
const shiftLabel = (k: string) => FSSAI_SHIFTS.find((s) => s.key === (k || ''))?.label || k;
const moduleLabel = (k: string) => (k ? MODULE_LABEL.get(k) || k : 'No area — your own checklist');

/** Does this frequency need a weekday / a day of the month / times of day? */
const needsWeekday = (f: string) => f === 'weekly';
const needsMonthday = (f: string) => f === 'monthly' || f === 'quarterly' || f === 'yearly';
const needsTimes = (f: string) => f === 'hourly';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ── small shared bits, open-coded per the house convention (there is no shared
 *    Table / Card / Modal / Badge component in this app, by design) ── */

function StatusBadge({ status }: { status: string }) {
  const m = fssaiTemplateStatusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${m.color}`}>
      {m.label}
    </span>
  );
}

function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-[#6B5744]">
        {label}{required && <span className="text-[#af4408]"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-[#8B7355] mt-1">{hint}</span>}
    </label>
  );
}

const INPUT =
  'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

/** The house safe-modal shell (RECON §1.4) + role="dialog" and Escape (§1.6). */
function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-2xl'} shadow-xl flex flex-col overflow-hidden max-h-[88vh] sm:max-h-[90vh]`}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold text-[#2D1B0E] min-w-0 truncate">{title}</h2>
          <button onClick={onClose} aria-label="Close"
            className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center shrink-0">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */

export default function FssaiChecklistsPage() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');

  /* filters */
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [deptId, setDeptId] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  /* masters (admin only — the route is admin-only and 403s otherwise) */
  const [masters, setMasters] = useState<Masters | null>(null);
  const [mastersErr, setMastersErr] = useState('');

  /* "last recorded", from the runs list. SCOPED: management sees every run,
   * everyone else sees their own and their department's, so this is the last
   * check THIS VIEWER can see — said in a footnote rather than implied. The
   * unscoped total is run_count, which the templates route counts server-side. */
  const [lastRun, setLastRun] = useState<Map<string, string>>(new Map());

  /* modals */
  const [editing, setEditing] = useState<{ mode: 'create' | 'edit'; id?: string; original?: TemplateRow; draft: HeaderDraft } | null>(null);
  const [saveErr, setSaveErr] = useState('');
  const [warnAfterSave, setWarnAfterSave] = useState<{ name: string; warnings: string[]; id: string; created: boolean } | null>(null);
  const [archiving, setArchiving] = useState<{ t: TemplateRow; reason: string } | null>(null);
  const [purging, setPurging] = useState<{ t: TemplateRow; reason: string } | null>(null);
  const [assignFor, setAssignFor] = useState<TemplateRow | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(''), 4000);
  }, []);

  /* ── loaders ─────────────────────────────────────────────────────────── */

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      if (moduleKey) params.set('module_key', moduleKey);
      if (deptId) params.set('department_id', deptId);
      if (showArchived) params.set('include_archived', '1');
      const j = await apiJson<{ templates: TemplateRow[]; can_author: boolean }>(
        `/api/fssai/templates${params.toString() ? `?${params}` : ''}`,
      );
      setTemplates(j.templates || []);
      setCanAuthor(!!j.can_author);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load the checklists';
      if (msg.includes('401') || /sign in/i.test(msg)) setForbidden(true);
      else setErr(msg);
    } finally {
      setLoading(false);
    }
  }, [q, status, moduleKey, deptId, showArchived]);

  useEffect(() => { void load(); }, [load]);

  /* Masters are fetched once, only if this viewer may author. A 403 is not an
   * error banner — it simply means the create/edit forms stay closed. */
  useEffect(() => {
    if (!canAuthor || masters) return;
    (async () => {
      try {
        setMasters(await apiJson<Masters>('/api/fssai/masters'));
        setMastersErr('');
      } catch (e: unknown) {
        setMastersErr(e instanceof Error ? e.message : 'The department and role lists could not be loaded.');
      }
    })();
  }, [canAuthor, masters]);

  /* Last recorded check per checklist. One call, newest first already. */
  useEffect(() => {
    (async () => {
      try {
        const j = await apiJson<{ runs: RunRow[] }>('/api/fssai/runs');
        const m = new Map<string, string>();
        for (const r of j.runs || []) {
          const prev = m.get(r.template_id);
          if (!prev || String(r.business_date) > prev) m.set(r.template_id, String(r.business_date));
        }
        setLastRun(m);
      } catch {
        /* Not fatal: the library is still fully usable without this column. */
      }
    })();
  }, []);

  /* ── derived ─────────────────────────────────────────────────────────── */

  const counts = useMemo(() => ({
    all: templates.length,
    published: templates.filter((t) => t.status === 'published').length,
    draft: templates.filter((t) => t.status === 'draft').length,
    archived: templates.filter((t) => t.status === 'archived').length,
    unassigned: templates.filter((t) => t.status === 'published' && !Number(t.assignment_count)).length,
    empty: templates.filter((t) => !Number(t.question_count)).length,
  }), [templates]);

  /** Departments present in the list — so the filter works for staff too, who
   *  may not read /api/fssai/masters. */
  const deptOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of templates) {
      if (t.department_id) m.set(t.department_id, t.department_name || t.department_id);
    }
    if (masters) for (const d of masters.departments) m.set(d.id, d.name);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [templates, masters]);

  /* ── actions ─────────────────────────────────────────────────────────── */

  /** publish · unpublish · archive · restore — all one route, all CSRF'd. */
  async function act(t: TemplateRow, action: 'publish' | 'unpublish' | 'archive' | 'restore', reason = '') {
    setBusy(`${t.id}:${action}`); setErr('');
    try {
      const j = await apiJson<{ config_warnings?: string[]; assignments_stood_down?: number }>(
        `/api/fssai/templates/${encodeURIComponent(t.id)}`,
        { method: 'POST', body: { action, reason } },
      );
      const said =
        action === 'publish' ? `"${t.name}" is published — staff can run it.`
          : action === 'unpublish' ? `"${t.name}" is back to a draft.`
            : action === 'archive'
              ? `"${t.name}" is archived. ${Number(j.assignments_stood_down) || 0} assignment(s) stood down; its records stay readable.`
              : `"${t.name}" is back, as a draft. Publish it when you have re-read it.`;
      flash(said);
      if (action === 'publish' && j.config_warnings?.length) {
        setWarnAfterSave({ name: t.name, warnings: j.config_warnings, id: t.id, created: false });
      }
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That action could not be completed');
    } finally {
      setBusy('');
    }
  }

  async function duplicate(t: TemplateRow) {
    setBusy(`${t.id}:copy`); setErr('');
    try {
      const j = await apiJson<{ template: TemplateRow; config_warnings?: string[] }>('/api/fssai/templates', {
        method: 'POST', body: { action: 'duplicate', template_id: t.id },
      });
      flash(`Copied to "${j.template?.name}" — a draft at version 1, with a blank code.`);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'The copy could not be made');
    } finally {
      setBusy('');
    }
  }

  async function archiveNow() {
    if (!archiving) return;
    const { t, reason } = archiving;
    setArchiving(null);
    await act(t, 'archive', reason);
  }

  /** The hard delete. Offered ONLY while a checklist has never been run, and the
   *  route refuses it anyway if a run appeared in between (owner §19). */
  async function purgeNow() {
    if (!purging) return;
    const { t, reason } = purging;
    if (!reason.trim()) return;
    setBusy(`${t.id}:purge`); setErr('');
    try {
      await apiJson(
        `/api/fssai/templates?id=${encodeURIComponent(t.id)}&purge=1&reason=${encodeURIComponent(reason.trim())}`,
        { method: 'DELETE' },
      );
      setPurging(null);
      flash(`"${t.name}" was deleted. It had never been used.`);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That checklist could not be deleted');
      setPurging(null);
    } finally {
      setBusy('');
    }
  }

  async function saveHeader(thenBuild: boolean) {
    if (!editing) return;
    setSaveErr('');
    const d = editing.draft;
    setBusy('save');
    try {
      if (editing.mode === 'create') {
        const j = await apiJson<{ template: TemplateRow; config_warnings?: string[] }>('/api/fssai/templates', {
          method: 'POST', body: d,
        });
        setEditing(null);
        flash(`"${j.template.name}" created as a draft. Add its questions, then publish it.`);
        if (j.config_warnings?.length) {
          setWarnAfterSave({ name: j.template.name, warnings: j.config_warnings, id: j.template.id, created: true });
        }
        await load();
        if (thenBuild) window.location.href = `/fssai/settings/checklists/${encodeURIComponent(j.template.id)}`;
      } else {
        const j = await apiJson<{ template: TemplateRow; version_bumped: boolean; version: number; changed: string[]; config_warnings?: string[] }>(
          '/api/fssai/templates', { method: 'PUT', body: { id: editing.id, ...d } },
        );
        setEditing(null);
        flash(
          !j.changed?.length ? 'Nothing was different, so nothing changed.'
            : j.version_bumped
              ? `Saved. This changed what is asked or how it is judged, so the checklist is now version ${j.version}. Records already taken keep the version they were taken under.`
              : 'Saved. This did not change the questions or the pass mark, so the version is unchanged and no record is re-labelled.',
        );
        if (j.config_warnings?.length) {
          setWarnAfterSave({ name: j.template.name, warnings: j.config_warnings, id: j.template.id, created: false });
        }
        await load();
        if (thenBuild) window.location.href = `/fssai/settings/checklists/${encodeURIComponent(String(editing.id))}`;
      }
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : 'That could not be saved');
    } finally {
      setBusy('');
    }
  }

  /* ── the permission-refused panel (house pattern) ─────────────────────── */

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            🔒 Please sign in to see the food-safety checklists.
          </div>
        </div>
      </div>
    );
  }

  /* ── page ────────────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ListChecks size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">FSSAI Compliance</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">FSSAI Checklists</h1>
            <p className="text-xs text-[#8B7355] mt-0.5">
              {canAuthor
                ? 'Every checklist the restaurant runs. Create one, say who runs it and how often, publish it — no developer involved.'
                : 'The checklists the restaurant runs, how often each one is due and which department owns it.'}
            </p>
          </div>
          <button onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
          {canAuthor && (
            <>
              <a href="/fssai/settings"
                className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3]">
                <Settings2 size={15} /> Settings
              </a>
              <button
                onClick={() => { setSaveErr(''); setEditing({ mode: 'create', draft: { ...BLANK_DRAFT } }); }}
                className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2">
                <Plus size={15} /> New checklist
              </button>
            </>
          )}
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" /> <span className="min-w-0">{err}</span>
          </div>
        )}
        {canAuthor && mastersErr && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
            The department and role lists could not be loaded, so a new checklist cannot be given an owner yet: {mastersErr}
          </div>
        )}

        {/* How a checklist behaves — the version law, stated once, for the person
            who can change one. Kept off a staff phone because it is about
            authoring, not about running a check. */}
        {canAuthor && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-4 text-sm text-[#3D2614] space-y-1.5">
            <p className="flex items-start gap-2">
              <Info size={15} className="text-[#af4408] shrink-0 mt-0.5" />
              <span>
                <b>A checklist lives here, not in the software.</b> Build it, publish it, and staff can run it. Change it
                whenever the rules change — you do not need a developer, and you never need to wait for a release.
              </span>
            </p>
            <p className="pl-[23px]">
              <b>Editing never rewrites the past.</b> A finished check keeps the questions, the pass mark and the name it
              was taken under. Renaming a checklist does not change its version and does not re-label a single record
              already filed. Only {FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS.length} settings — the pass mark, what the check
              is run against, and whether a signature or a second sign-off is required — plus any change to the questions
              themselves, move it to a new version.
            </p>
            <p className="pl-[23px]">
              <b>Nothing is ever deleted.</b> Retiring a checklist archives it: no new checks can be started, the records
              stay readable, and it can be brought back. A checklist that has never been used can be deleted outright.
            </p>
          </div>
        )}

        {/* Counts — admin only: they describe the state of the CONFIGURATION. */}
        {canAuthor && !loading && templates.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Stat label="Checklists" value={counts.all} />
            <Stat label="Published" value={counts.published} tone={counts.published ? 'green' : 'plain'} />
            <Stat label="Drafts" value={counts.draft} />
            {showArchived && <Stat label="Archived" value={counts.archived} />}
            <Stat label="Published, nobody assigned" value={counts.unassigned} tone={counts.unassigned ? 'amber' : 'plain'} />
            <Stat label="No questions yet" value={counts.empty} tone={counts.empty ? 'amber' : 'plain'} />
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-3 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block sm:col-span-2">
              <span className="text-xs font-semibold text-[#6B5744]">Search</span>
              <span className="relative block">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
                <input
                  value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="name, code, area or department"
                  className={`${INPUT} pl-9`}
                />
              </span>
            </label>
            {canAuthor && (
              <Field label="Stage">
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT}>
                  <option value="">Any stage{showArchived ? '' : ' except archived'}</option>
                  <option value="draft">Draft — still being written</option>
                  <option value="published">Published — staff can run it</option>
                  <option value="archived">Archived — retired, records kept</option>
                </select>
              </Field>
            )}
            <Field label="Food-safety area">
              <select value={moduleKey} onChange={(e) => setModuleKey(e.target.value)} className={INPUT}>
                <option value="">Every area</option>
                {FSSAI_MODULE_KEYS.map((k) => <option key={k} value={k}>{moduleLabel(k)}</option>)}
              </select>
            </Field>
            <Field label="Department">
              <select value={deptId} onChange={(e) => setDeptId(e.target.value)} className={INPUT}>
                <option value="">Every department</option>
                {deptOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          </div>
          {canAuthor && (
            <div className="flex items-center gap-2 mt-3">
              <Toggle checked={showArchived} onChange={setShowArchived} size="sm" label="Show archived checklists" />
              <span className="text-xs text-[#6B5744]">Show archived checklists</span>
            </div>
          )}
        </div>

        {/* The library */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
            </div>
          ) : templates.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-semibold text-[#2D1B0E]">
                {q || status || moduleKey || deptId ? 'Nothing matches those filters' : 'No checklists yet'}
              </p>
              <p className="text-xs text-[#8B7355] mt-1 max-w-md mx-auto">
                {q || status || moduleKey || deptId
                  ? 'Clear the search or the filters to see the whole library.'
                  : canAuthor
                    ? 'Start with one you do every day — the closing clean, or the cold-room round. Give it a name, add its questions, then publish it.'
                    : 'Nothing has been published for you to run yet. An administrator sets these up.'}
              </p>
              {canAuthor && !(q || status || moduleKey || deptId) && (
                <button
                  onClick={() => { setSaveErr(''); setEditing({ mode: 'create', draft: { ...BLANK_DRAFT } }); }}
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2">
                  <Plus size={15} /> New checklist
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Phone: cards */}
              <div className="md:hidden divide-y divide-[#E8D5C4]">
                {templates.map((t) => (
                  <div key={t.id} className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-[#2D1B0E]">{t.name}</p>
                        <p className="text-[11px] text-[#8B7355] mt-0.5">
                          {t.code ? <span className="font-mono">{t.code}</span> : <span className="italic">no code</span>}
                          {' · '}v{t.version}{Number(t.is_seeded) ? ' · ready-made' : ''}
                        </p>
                      </div>
                      <StatusBadge status={t.status} />
                    </div>
                    <p className="text-xs text-[#6B5744]">
                      {freqLabel(t.frequency)} · {targetLabel(t.target_kind)} ·{' '}
                      {t.department_name || 'Whole restaurant'}
                    </p>
                    <p className="text-xs text-[#6B5744]">
                      {t.section_count} section{t.section_count === 1 ? '' : 's'} ·{' '}
                      {t.question_count} question{t.question_count === 1 ? '' : 's'} ·{' '}
                      {t.assignment_count} assigned · {t.run_count} check{t.run_count === 1 ? '' : 's'} recorded
                    </p>
                    {canAuthor && <RowActions t={t} busy={busy} onAct={act} onCopy={duplicate}
                      onEdit={() => { setSaveErr(''); setEditing({ mode: 'edit', id: t.id, original: t, draft: draftFrom(t) }); }}
                      onArchive={() => setArchiving({ t, reason: '' })}
                      onPurge={() => setPurging({ t, reason: '' })}
                      onAssign={() => setAssignFor(t)} stacked />}
                  </div>
                ))}
              </div>

              {/* md+: the table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">Checklist</th>
                      <th className="text-left font-semibold px-3 py-2">Stage</th>
                      <th className="text-left font-semibold px-3 py-2">How often · against what</th>
                      <th className="text-left font-semibold px-3 py-2">Owned by</th>
                      <th className="text-right font-semibold px-3 py-2">Questions</th>
                      <th className="text-right font-semibold px-3 py-2">Assigned</th>
                      <th className="text-right font-semibold px-3 py-2">Records</th>
                      {canAuthor && <th className="text-right font-semibold px-3 py-2">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]">
                    {templates.map((t) => (
                      <tr key={t.id} className="hover:bg-[#FFF8F0] align-top">
                        <td className="px-3 py-2.5">
                          <div className="font-semibold text-[#2D1B0E]">{t.name}</div>
                          <div className="text-[11px] text-[#8B7355] mt-0.5">
                            {t.code ? <span className="font-mono">{t.code}</span> : <span className="italic">no code</span>}
                            {' · '}version {t.version}
                            {Number(t.is_seeded) ? ' · ready-made' : ''}
                            {t.module_key ? ` · ${moduleLabel(t.module_key)}` : ''}
                          </div>
                        </td>
                        <td className="px-3 py-2.5"><StatusBadge status={t.status} /></td>
                        <td className="px-3 py-2.5 text-[#3D2614]">
                          {freqLabel(t.frequency)}
                          <div className="text-[11px] text-[#8B7355]">{targetLabel(t.target_kind)}</div>
                        </td>
                        <td className="px-3 py-2.5 text-[#3D2614]">
                          {t.department_name || <span className="text-[#8B7355]">Whole restaurant</span>}
                          {t.responsible_role_name && (
                            <div className="text-[11px] text-[#8B7355]">{t.responsible_role_name}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {Number(t.question_count) === 0 ? (
                            <span className="text-amber-700 font-semibold">none yet</span>
                          ) : (
                            <>
                              {t.question_count}
                              <div className="text-[11px] text-[#8B7355]">
                                in {t.section_count} section{t.section_count === 1 ? '' : 's'}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {canAuthor ? (
                            <button onClick={() => setAssignFor(t)}
                              className={`underline decoration-dotted hover:text-[#af4408] ${Number(t.assignment_count) ? 'text-[#3D2614]' : 'text-amber-700 font-semibold'}`}>
                              {Number(t.assignment_count) || 'nobody'}
                            </button>
                          ) : (
                            <span className={Number(t.assignment_count) ? '' : 'text-[#8B7355]'}>
                              {Number(t.assignment_count) || '—'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-[#3D2614]">
                          {t.run_count}
                          <div className="text-[11px] text-[#8B7355]">
                            {lastRun.get(t.id) ? `last ${fmtISTDate(lastRun.get(t.id))}` : 'none you can see'}
                          </div>
                        </td>
                        {canAuthor && (
                          <td className="px-3 py-2.5">
                            <RowActions t={t} busy={busy} onAct={act} onCopy={duplicate}
                              onEdit={() => { setSaveErr(''); setEditing({ mode: 'edit', id: t.id, original: t, draft: draftFrom(t) }); }}
                              onArchive={() => setArchiving({ t, reason: '' })}
                              onPurge={() => setPurging({ t, reason: '' })}
                              onAssign={() => setAssignFor(t)} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footnotes — the two facts a reader would otherwise have to guess. */}
        {!loading && templates.length > 0 && (
          <div className="text-xs text-[#8B7355] space-y-1">
            <p>
              <b>Records</b> counts every check ever filed against a checklist, including ones filed by other
              departments. <b>Last</b> is the most recent check <i>you</i> are allowed to see — management sees every
              department, everyone else sees their own.
            </p>
            {!canAuthor && (
              <p>
                Only an administrator can create or change a checklist. Running one on a phone is the next piece of
                work, so there is nothing to tap here yet.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── create / edit ───────────────────────────────────────────────── */}
      {editing && (
        <HeaderModal
          mode={editing.mode}
          draft={editing.draft}
          original={editing.original}
          masters={masters}
          saving={busy === 'save'}
          error={saveErr}
          onChange={(patch) => setEditing((s) => (s ? { ...s, draft: { ...s.draft, ...patch } } : s))}
          onClose={() => setEditing(null)}
          onSave={saveHeader}
        />
      )}

      {/* ── what this setup will do once staff run it (config_warnings) ──── */}
      {warnAfterSave && (
        <Modal
          title={`How "${warnAfterSave.name}" will behave`}
          onClose={() => setWarnAfterSave(null)}
          footer={
            <>
              <button onClick={() => setWarnAfterSave(null)}
                className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">
                Leave it as it is
              </button>
              <a href={`/fssai/settings/checklists/${encodeURIComponent(warnAfterSave.id)}`}
                className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold inline-flex items-center gap-1.5">
                Open the builder <ArrowRight size={14} />
              </a>
            </>
          }
        >
          <p className="text-sm text-[#3D2614]">
            {warnAfterSave.created ? 'Created.' : 'Saved.'} Nothing is wrong — this is simply what these settings mean in
            practice, so it is not a surprise later.
          </p>
          <ul className="space-y-2">
            {warnAfterSave.warnings.map((w, i) => (
              <li key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">{w}</li>
            ))}
          </ul>
        </Modal>
      )}

      {/* ── archive (reversible, so a plain explainer + optional reason) ─── */}
      {archiving && (
        <Modal
          title={`Archive "${archiving.t.name}"?`}
          onClose={() => setArchiving(null)}
          footer={
            <>
              <button onClick={() => setArchiving(null)}
                className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">Cancel</button>
              <button onClick={() => void archiveNow()} disabled={busy.startsWith(archiving.t.id)}
                className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold disabled:opacity-50 inline-flex items-center gap-1.5">
                <Archive size={14} /> Archive it
              </button>
            </>
          }
        >
          <ul className="text-sm text-[#3D2614] space-y-2">
            <li className="flex gap-2"><CheckCircle2 size={15} className="text-green-600 shrink-0 mt-0.5" />
              <span>The {archiving.t.run_count} check{archiving.t.run_count === 1 ? '' : 's'} already recorded against
                it stay exactly as they are, and stay readable. Nothing is deleted.</span></li>
            <li className="flex gap-2"><X size={15} className="text-red-600 shrink-0 mt-0.5" />
              <span>No new check can be started against it.</span></li>
            <li className="flex gap-2"><X size={15} className="text-red-600 shrink-0 mt-0.5" />
              <span>Its {archiving.t.assignment_count} live assignment{archiving.t.assignment_count === 1 ? '' : 's'} are
                stood down, so it stops appearing in anyone&apos;s list of what is due. They are kept, not deleted, so
                restoring it shows what it used to owe.</span></li>
            <li className="flex gap-2"><Undo2 size={15} className="text-[#af4408] shrink-0 mt-0.5" />
              <span>You can bring it back at any time. It returns as a <b>draft</b>, so you re-read it and publish it
                on purpose.</span></li>
          </ul>
          <Field label="Why (optional — it goes on the audit trail)">
            <input value={archiving.reason} onChange={(e) => setArchiving({ ...archiving, reason: e.target.value })}
              className={INPUT} placeholder="e.g. replaced by the new closing round" />
          </Field>
        </Modal>
      )}

      {/* ── delete (irreversible → a written explainer AND a typed reason) ─ */}
      {purging && (
        <Modal
          title={`Delete "${purging.t.name}" for good?`}
          onClose={() => setPurging(null)}
          footer={
            <>
              <button onClick={() => setPurging(null)}
                className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">Cancel</button>
              <button onClick={() => void purgeNow()} disabled={!purging.reason.trim() || busy.startsWith(purging.t.id)}
                className="text-sm px-3 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-40 inline-flex items-center gap-1.5">
                <Trash2 size={14} /> Delete it
              </button>
            </>
          }
        >
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            This cannot be undone. The checklist, its sections and its questions go for good.
          </div>
          <p className="text-sm text-[#3D2614]">
            It is offered because <b>no check has ever been recorded</b> against this checklist. The moment one has, this
            option disappears and archiving is the only way to retire it — a food-safety record is never deleted.
          </p>
          <p className="text-sm text-[#6B5744]">
            If you are not sure, archive it instead: it stops being runnable, and you can bring it back.
          </p>
          <Field label="Why are you deleting it?" required
            hint="Recorded against your name. A refusal is recorded too.">
            <input value={purging.reason} onChange={(e) => setPurging({ ...purging, reason: e.target.value })}
              className={INPUT} placeholder="e.g. created by mistake while testing" autoFocus />
          </Field>
        </Modal>
      )}

      {/* ── assignments ─────────────────────────────────────────────────── */}
      {assignFor && (
        <AssignmentsModal
          template={assignFor}
          masters={masters}
          onClose={() => { setAssignFor(null); void load(); }}
          flash={flash}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * A counter tile.
 * ══════════════════════════════════════════════════════════════════════════ */

function Stat({ label, value, tone = 'plain' }: { label: string; value: number; tone?: 'plain' | 'green' | 'amber' }) {
  const ring =
    tone === 'green' ? 'border-green-200 bg-green-50' : tone === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-[#E8D5C4] bg-white';
  return (
    <div className={`rounded-xl border ${ring} px-3 py-2.5`}>
      <p className="text-xl font-bold text-[#2D1B0E]">{value}</p>
      <p className="text-[11px] text-[#6B5744] leading-tight mt-0.5">{label}</p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * The per-row action cluster. Which actions exist depends on the STAGE, and
 * the reasons are the route's own: a published checklist with records cannot go
 * back to a draft, and a checklist with records can never be deleted.
 * ══════════════════════════════════════════════════════════════════════════ */

function RowActions({ t, busy, onAct, onCopy, onEdit, onArchive, onPurge, onAssign, stacked }: {
  t: TemplateRow;
  busy: string;
  onAct: (t: TemplateRow, a: 'publish' | 'unpublish' | 'archive' | 'restore') => void | Promise<void>;
  onCopy: (t: TemplateRow) => void | Promise<void>;
  onEdit: () => void;
  onArchive: () => void;
  onPurge: () => void;
  onAssign: () => void;
  stacked?: boolean;
}) {
  const working = busy.startsWith(`${t.id}:`);
  const btn =
    'inline-flex items-center gap-1 text-xs font-medium border border-[#E8D5C4] bg-white rounded-lg px-2 py-1.5 hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-40';
  const archived = t.status === 'archived';
  return (
    <div className={`flex flex-wrap gap-1.5 ${stacked ? '' : 'justify-end'}`}>
      {!archived && (
        <a href={`/fssai/settings/checklists/${encodeURIComponent(t.id)}`} className={btn} title="Sections and questions">
          <ListChecks size={13} /> Build
        </a>
      )}
      {t.status === 'draft' && (
        <button onClick={() => void onAct(t, 'publish')} disabled={working || !Number(t.question_count)}
          title={Number(t.question_count) ? 'Let staff run it' : 'Add at least one question first'}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-2 py-1.5 disabled:opacity-40">
          <Send size={13} /> Publish
        </button>
      )}
      {t.status === 'published' && Number(t.run_count) === 0 && (
        <button onClick={() => void onAct(t, 'unpublish')} disabled={working} className={btn}
          title="Back to a draft — only while nothing has been recorded">
          <Undo2 size={13} /> Unpublish
        </button>
      )}
      {!archived && (
        <>
          <button onClick={onAssign} className={btn} title="Who runs it, and how often">
            <UserPlus size={13} /> Assign
          </button>
          <button onClick={onEdit} className={btn} title="Name, code, frequency, pass mark">
            <Pencil size={13} /> Edit
          </button>
        </>
      )}
      <button onClick={() => void onCopy(t)} disabled={working} className={btn} title="Copy as a new draft">
        <Copy size={13} /> Copy
      </button>
      {archived ? (
        <button onClick={() => void onAct(t, 'restore')} disabled={working} className={btn} title="Bring it back as a draft">
          <ArchiveRestore size={13} /> Restore
        </button>
      ) : (
        <button onClick={onArchive} disabled={working} className={btn} title="Retire it — records stay">
          <Archive size={13} /> Archive
        </button>
      )}
      {Number(t.run_count) === 0 && (
        <button onClick={onPurge} disabled={working}
          className="inline-flex items-center gap-1 text-xs font-medium border border-red-200 text-red-700 bg-white rounded-lg px-2 py-1.5 hover:bg-red-50 disabled:opacity-40"
          title="Never used, so it can be deleted outright">
          <Trash2 size={13} /> Delete
        </button>
      )}
      {working && <Loader2 size={14} className="animate-spin text-[#af4408] self-center" />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * CREATE / EDIT the header.
 *
 * The one screen where the version rule has to be visible BEFORE the save, not
 * explained after it. `templateEditBumpsVersion` is the same predicate the PUT
 * handler uses (src/lib/fssai.ts §7), so the sentence here and the behaviour
 * there cannot disagree — and `fssaiConfigWarnings` is the same function the
 * server returns, so the consequence of a setting is shown while it is being
 * chosen rather than after it is saved.
 * ══════════════════════════════════════════════════════════════════════════ */

function HeaderModal({ mode, draft, original, masters, saving, error, onChange, onClose, onSave }: {
  mode: 'create' | 'edit';
  draft: HeaderDraft;
  original?: TemplateRow;
  masters: Masters | null;
  saving: boolean;
  error: string;
  onChange: (patch: Partial<HeaderDraft>) => void;
  onClose: () => void;
  onSave: (thenBuild: boolean) => void | Promise<void>;
}) {
  /** Which header fields differ from the stored row, by the API's own names. */
  const changed = useMemo(() => {
    if (mode !== 'edit' || !original) return [];
    const before = draftFrom(original);
    return (Object.keys(draft) as (keyof HeaderDraft)[])
      .filter((k) => String(before[k] ?? '') !== String(draft[k] ?? ''));
  }, [mode, original, draft]);

  const bumps = templateEditBumpsVersion(changed as string[]);
  const warnings = fssaiConfigWarnings(draft);
  const liveAlready = mode === 'edit' && original?.status === 'published';
  const hasRecords = mode === 'edit' && Number(original?.run_count) > 0;

  return (
    <Modal
      wide
      title={mode === 'create' ? 'New checklist' : `Edit "${original?.name}"`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">
            Cancel
          </button>
          <button onClick={() => void onSave(false)} disabled={saving || !draft.name.trim()}
            className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-40 inline-flex items-center gap-1.5">
            {saving && <Loader2 size={14} className="animate-spin" />} Save
          </button>
          <button onClick={() => void onSave(true)} disabled={saving || !draft.name.trim()}
            className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold disabled:opacity-40 inline-flex items-center gap-1.5">
            Save and add questions <ArrowRight size={14} />
          </button>
        </>
      }
    >
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{error}</div>
      )}

      {mode === 'create' && (
        <p className="text-sm text-[#6B5744]">
          This is the cover of the checklist: what it is called, how often it is due and how it is judged. The questions
          come next, on the builder. A new checklist starts as a <b>draft</b> — nobody can run it until you publish it.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required hint="What staff will see. e.g. Cold Room Round — Closing">
          <input value={draft.name} onChange={(e) => onChange({ name: e.target.value })} className={INPUT}
            maxLength={160} autoFocus placeholder="e.g. Closing Kitchen Clean" />
        </Field>
        <Field label="Code" hint="Optional short key for reports and exports. Letters, numbers, dot, dash, underscore.">
          <input value={draft.code} onChange={(e) => onChange({ code: e.target.value })} className={`${INPUT} font-mono`}
            placeholder="e.g. CHK-CLOSING-CLEAN" />
        </Field>
      </div>

      <Field label="Description" hint="One line telling whoever runs it what it is for.">
        <input value={draft.description} onChange={(e) => onChange({ description: e.target.value })} className={INPUT}
          placeholder="e.g. The round the closing chef walks before locking up" />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Food-safety area" hint="Which part of the module this belongs to. Leave blank for your own checklist.">
          <select value={draft.module_key} onChange={(e) => onChange({ module_key: e.target.value })} className={INPUT}>
            <option value="">No area — my own checklist</option>
            {FSSAI_MODULE_KEYS.map((k) => <option key={k} value={k}>{moduleLabel(k)}</option>)}
          </select>
        </Field>
        <Field label="Category" hint="Used for grouping in reports.">
          <input value={draft.category} onChange={(e) => onChange({ category: e.target.value })} className={INPUT}
            maxLength={40} placeholder="Compliance" />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="How often is it due?" hint={freqHint(draft.frequency)}>
          <select value={draft.frequency} onChange={(e) => onChange({ frequency: e.target.value })} className={INPUT}>
            {FSSAI_FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="What is it run against?" hint={targetHint(draft.target_kind)}>
          <select value={draft.target_kind} onChange={(e) => onChange({ target_kind: e.target.value })} className={INPUT}>
            {FSSAI_TARGET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Department that owns it"
          hint="Blank means the whole restaurant, and any signed-in member of staff can see its records.">
          <select value={draft.department_id} onChange={(e) => onChange({ department_id: e.target.value })}
            className={INPUT} disabled={!masters}>
            <option value="">Whole restaurant</option>
            {(masters?.departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Role expected to run it" hint="Read from your own roles. This module never creates or changes one.">
          <select value={draft.responsible_role_id} onChange={(e) => onChange({ responsible_role_id: e.target.value })}
            className={INPUT} disabled={!masters}>
            <option value="">Anyone signed in</option>
            {(masters?.roles || []).map((r) => (
              <option key={r.id} value={r.id}>{r.name}{Number(r.is_active) ? '' : ' (inactive)'}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Pass mark (%)" hint="How much of the checklist must pass for the whole check to pass. 100 = everything.">
          <input type="number" min={0} max={100} step={1} value={draft.pass_threshold_pct}
            onChange={(e) => onChange({ pass_threshold_pct: Number(e.target.value) })} className={INPUT} />
        </Field>
        <Field label="Backdating allowed (days)" hint="0 = today only. A backdated check is flagged and needs a reason.">
          <input type="number" min={0} max={30} step={1} value={draft.allow_backdate_days}
            onChange={(e) => onChange({ allow_backdate_days: Number(e.target.value) })} className={INPUT} />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-start gap-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
          <Toggle checked={!!draft.requires_signature} size="sm" label="Requires a signature"
            onChange={(v) => onChange({ requires_signature: v ? 1 : 0 })} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#2D1B0E]">Signed by whoever ran it</p>
            <p className="text-[11px] text-[#6B5744]">The signed-in person and the time are recorded on the check.</p>
          </div>
        </div>
        <div className="flex items-start gap-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
          <Toggle checked={!!draft.requires_verification} size="sm" label="Requires a second sign-off"
            onChange={(v) => onChange({ requires_verification: v ? 1 : 0 })} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#2D1B0E]">Verified by a manager</p>
            <p className="text-[11px] text-[#6B5744]">A finished check waits for someone in management — never the
              person who ran it.</p>
          </div>
        </div>
      </div>

      {/* What these settings MEAN once staff run it — live, as he chooses. */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w, i) => (
            <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex gap-2">
              <Info size={15} className="shrink-0 mt-0.5" /> <span className="min-w-0">{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* The version sentence — the whole reason this modal is not a plain form. */}
      {mode === 'edit' && (
        <div className={`rounded-lg border p-3 text-sm ${bumps ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-[#FFF1E3] border-[#E8D5C4] text-[#3D2614]'}`}>
          {changed.length === 0 ? (
            <span>Nothing is different yet.</span>
          ) : bumps ? (
            <>
              <p className="font-semibold">
                This changes how the check is judged, so saving moves it to version {Number(original?.version || 1) + 1}.
              </p>
              <p className="mt-1">
                Every check already recorded keeps the version, the questions and the pass mark it was taken under —
                saving this cannot alter a single past record.
                {liveAlready && ' A check somebody is filling in right now keeps the version it started on.'}
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">This does not change what is asked or how it is judged, so the version stays at {original?.version}.</p>
              <p className="mt-1">
                Renaming is deliberately one of these: the {hasRecords ? `${original?.run_count} check${Number(original?.run_count) === 1 ? '' : 's'} already recorded keep` : 'records already recorded keep'} the
                name they were filed under, so a rename can never re-label your history.
              </p>
            </>
          )}
          {changed.length > 0 && (
            <p className="mt-1.5 text-[11px] opacity-80">Changing: {changed.join(', ')}.</p>
          )}
        </div>
      )}

      {mode === 'edit' && Number(original?.open_run_count) > 0 && (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-sm text-[#3D2614]">
          {original?.open_run_count} check{Number(original?.open_run_count) === 1 ? ' is' : 's are'} part-filled right
          now. Each one finishes on the version it started, so nobody has the paper swapped underneath them.
        </div>
      )}

      {!masters && (
        <p className="text-xs text-[#8B7355]">
          The department and role lists are still loading. You can save without them and set the owner afterwards.
        </p>
      )}
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * ASSIGNMENTS — who owes this checklist, and how often.
 *
 * Straight onto /api/fssai/assignments: the route computes the next due date
 * (it delegates to the Task module's recurrence maths — this screen must never
 * do that arithmetic itself) and returns `following_due_date` so the admin can
 * see the rhythm he just described. Standing an assignment down is is_active=0,
 * never a delete: a recorded check points at the assignment, and the assignment
 * is the evidence of what was owed and to whom.
 * ══════════════════════════════════════════════════════════════════════════ */

const BLANK_ASSIGN = {
  department_id: '',
  responsible_role_id: '',
  assignee_email: '',
  target_kind: 'none',
  target_label: '',
  shift: '',
  frequency: 'daily',
  day_of_week: 1,
  day_of_month: 1,
  times_csv: '',
  grace_minutes: 60,
  next_due_date: '',
};

function AssignmentsModal({ template, masters, onClose, flash }: {
  template: TemplateRow;
  masters: Masters | null;
  onClose: () => void;
  flash: (m: string) => void;
}) {
  const [rows, setRows] = useState<AssignmentRow[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...BLANK_ASSIGN, frequency: template.frequency || 'daily', target_kind: template.target_kind || 'none', department_id: template.department_id || '', responsible_role_id: template.responsible_role_id || '' });

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<{ assignments: AssignmentRow[]; can_author: boolean }>(
        `/api/fssai/assignments?template_id=${encodeURIComponent(template.id)}&include_inactive=1`,
      );
      setRows(j.assignments || []);
      setCanAuthor(!!j.can_author);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load the schedule');
    } finally {
      setLoading(false);
    }
  }, [template.id]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy('new'); setErr('');
    try {
      const j = await apiJson<{ following_due_date: string }>('/api/fssai/assignments', {
        method: 'POST', body: { template_id: template.id, ...form },
      });
      setAdding(false);
      setForm({ ...BLANK_ASSIGN, frequency: template.frequency || 'daily', target_kind: template.target_kind || 'none' });
      flash(
        j.following_due_date
          ? `Assigned. After this one is done, the next is due ${fmtISTDate(j.following_due_date)}.`
          : 'Assigned. It has no schedule — it is run when the event happens.',
      );
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That assignment could not be saved');
    } finally {
      setBusy('');
    }
  }

  async function standDown(a: AssignmentRow) {
    setBusy(a.id); setErr('');
    try {
      await apiJson(`/api/fssai/assignments?id=${encodeURIComponent(a.id)}&reason=${encodeURIComponent('Stood down from the checklist library')}`, { method: 'DELETE' });
      flash('Stood down. It is kept on the record, so you can still see what was owed.');
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That could not be stood down');
    } finally {
      setBusy('');
    }
  }

  async function reactivate(a: AssignmentRow) {
    setBusy(a.id); setErr('');
    try {
      await apiJson('/api/fssai/assignments', { method: 'PUT', body: { id: a.id, is_active: 1 } });
      flash('Back in service.');
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'That could not be brought back');
    } finally {
      setBusy('');
    }
  }

  /** Who this assignment lands on, in words. Blank everywhere = anyone. */
  function who(a: AssignmentRow): string {
    const bits: string[] = [];
    if (a.assignee_email) bits.push(a.assignee_name || a.assignee_email);
    if (a.responsible_role_id) bits.push(a.responsible_role_name || 'a named role');
    if (a.department_id) bits.push(a.department_name || 'a department');
    return bits.length ? bits.join(' · ') : 'Anyone signed in';
  }

  const live = rows.filter((r) => Number(r.is_active));
  const stood = rows.filter((r) => !Number(r.is_active));

  return (
    <Modal
      wide
      title={`Who runs "${template.name}"`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">
            Done
          </button>
          {canAuthor && !adding && (
            <button onClick={() => setAdding(true)}
              className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold inline-flex items-center gap-1.5">
              <Plus size={14} /> Assign someone
            </button>
          )}
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      {template.status !== 'published' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          This checklist is a {fssaiTemplateStatusMeta(template.status).label.toLowerCase()}, so nothing here becomes due
          until it is published. You can set the rota up now.
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
        </div>
      ) : (
        <>
          {live.length === 0 && (
            <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-sm text-[#3D2614]">
              Nobody is assigned yet, so this checklist never appears in anyone&apos;s list of what is due. It can still
              be run on purpose; it simply will not be asked for.
            </div>
          )}

          {live.length > 0 && (
            <div className="border border-[#E8D5C4] rounded-lg divide-y divide-[#E8D5C4] overflow-hidden">
              {live.map((a) => (
                <div key={a.id} className="p-3 flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#2D1B0E]">{who(a)}</p>
                    <p className="text-xs text-[#6B5744] mt-0.5">
                      {freqLabel(a.frequency)}
                      {a.shift ? ` · ${shiftLabel(a.shift)}` : ''}
                      {needsWeekday(a.frequency) ? ` · ${WEEKDAYS[Number(a.day_of_week) || 0]}` : ''}
                      {needsMonthday(a.frequency) ? ` · day ${a.day_of_month}` : ''}
                      {a.times_csv ? ` · ${a.times_csv}` : ''}
                      {a.target_label ? ` · ${a.target_label}` : ''}
                    </p>
                    <p className="text-[11px] text-[#8B7355] mt-0.5">
                      {a.next_due_date ? `Next due ${fmtISTDate(a.next_due_date)}` : 'No schedule — run when it happens'}
                      {a.last_run_date ? ` · last done ${fmtISTDate(a.last_run_date)}` : ''}
                      {` · ${a.grace_minutes} min grace`}
                    </p>
                  </div>
                  {canAuthor && (
                    <button onClick={() => void standDown(a)} disabled={busy === a.id}
                      className="inline-flex items-center gap-1 text-xs font-medium border border-[#E8D5C4] bg-white rounded-lg px-2 py-1.5 hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-40">
                      {busy === a.id ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Stand down
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {stood.length > 0 && (
            <details className="border border-[#E8D5C4] rounded-lg">
              <summary className="px-3 py-2 text-xs font-semibold text-[#6B5744] cursor-pointer">
                {stood.length} stood down — kept, never deleted
              </summary>
              <div className="divide-y divide-[#E8D5C4] border-t border-[#E8D5C4]">
                {stood.map((a) => (
                  <div key={a.id} className="p-3 flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[#6B5744]">{who(a)}</p>
                      <p className="text-[11px] text-[#8B7355]">{freqLabel(a.frequency)}{a.shift ? ` · ${shiftLabel(a.shift)}` : ''}</p>
                    </div>
                    {canAuthor && (
                      <button onClick={() => void reactivate(a)} disabled={busy === a.id}
                        className="inline-flex items-center gap-1 text-xs font-medium border border-[#E8D5C4] bg-white rounded-lg px-2 py-1.5 hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-40">
                        {busy === a.id ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Bring back
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {/* The add form */}
      {canAuthor && adding && (
        <div className="border border-[#D4B896] rounded-xl p-3 space-y-3 bg-[#FFF8F0]">
          <p className="text-sm font-semibold text-[#2D1B0E]">Assign this checklist</p>
          <p className="text-xs text-[#6B5744]">
            Leave a box on &ldquo;anyone&rdquo; to widen who it lands on. A department alone means whoever is on that
            department&apos;s shift; a person means that person only.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Department">
              <select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}
                className={INPUT} disabled={!masters}>
                <option value="">Any department</option>
                {(masters?.departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Role">
              <select value={form.responsible_role_id} onChange={(e) => setForm({ ...form, responsible_role_id: e.target.value })}
                className={INPUT} disabled={!masters}>
                <option value="">Any role</option>
                {(masters?.roles || []).map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{Number(r.is_active) ? '' : ' (inactive)'}</option>
                ))}
              </select>
            </Field>
            <Field label="One named person">
              <select value={form.assignee_email} onChange={(e) => setForm({ ...form, assignee_email: e.target.value })}
                className={INPUT} disabled={!masters}>
                <option value="">Nobody in particular</option>
                {(masters?.users || []).map((u) => (
                  <option key={u.email} value={u.email}>{u.name || u.email}{u.position ? ` — ${u.position}` : ''}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="How often" hint={freqHint(form.frequency)}>
              <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className={INPUT}>
                {FSSAI_FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Shift">
              <select value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })} className={INPUT}>
                {FSSAI_SHIFTS.map((s) => <option key={s.key || 'any'} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            {needsWeekday(form.frequency) ? (
              <Field label="Day of the week">
                <select value={form.day_of_week} onChange={(e) => setForm({ ...form, day_of_week: Number(e.target.value) })} className={INPUT}>
                  {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </Field>
            ) : needsMonthday(form.frequency) ? (
              <Field label="Day of the month">
                <input type="number" min={1} max={31} value={form.day_of_month}
                  onChange={(e) => setForm({ ...form, day_of_month: Number(e.target.value) })} className={INPUT} />
              </Field>
            ) : needsTimes(form.frequency) ? (
              <Field label="Times of day" hint="24-hour, comma separated. Blank = every hour.">
                <input value={form.times_csv} onChange={(e) => setForm({ ...form, times_csv: e.target.value })}
                  className={INPUT} placeholder="09:00,13:00,17:00" />
              </Field>
            ) : (
              <Field label="Grace period (minutes)" hint="How late it may be before it counts as missed.">
                <input type="number" min={0} max={1440} value={form.grace_minutes}
                  onChange={(e) => setForm({ ...form, grace_minutes: Number(e.target.value) })} className={INPUT} />
              </Field>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Run against" hint={targetHint(form.target_kind)}>
              <select value={form.target_kind} onChange={(e) => setForm({ ...form, target_kind: e.target.value })} className={INPUT}>
                {FSSAI_TARGET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </Field>
            <Field label="Which one" hint="A name staff will recognise, e.g. Cold Room 2.">
              <input value={form.target_label} onChange={(e) => setForm({ ...form, target_label: e.target.value })}
                className={INPUT} disabled={form.target_kind === 'none'} placeholder={form.target_kind === 'none' ? 'not needed' : 'e.g. Cold Room 2'} />
            </Field>
            <Field label="First due on" hint="Blank = today (and never, for a checklist with no schedule).">
              <input type="date" value={form.next_due_date}
                onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} className={INPUT} />
            </Field>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)}
              className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3]">Cancel</button>
            <button onClick={() => void create()} disabled={busy === 'new'}
              className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold disabled:opacity-40 inline-flex items-center gap-1.5">
              {busy === 'new' ? <Loader2 size={14} className="animate-spin" /> : <CalendarClock size={14} />} Assign it
            </button>
          </div>
        </div>
      )}

      {!canAuthor && (
        <p className="text-xs text-[#8B7355] flex items-start gap-1.5">
          <Lock size={13} className="shrink-0 mt-0.5" />
          Only an administrator changes who runs a checklist. This is the rota as it stands.
        </p>
      )}

      <p className="text-[11px] text-[#8B7355] flex items-start gap-1.5">
        <ClipboardList size={13} className="shrink-0 mt-0.5" />
        Departments, roles and people are read from your own settings. This module never creates or changes one.
      </p>
    </Modal>
  );
}
