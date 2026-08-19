'use client';

/**
 * HR — SOP Library (Phase 5). Contract: docs/HRMS_DECISIONS.md (owner spec
 * §24: publishing a version assigns it and archives the previously published
 * one; assignments always point at a VERSION, never the SOP head).
 *
 * Consumes /api/hr/sops exactly as documented in that route:
 *  - list rows carry department_name/designation_name + per-version stats
 *    (assigned/viewed/acknowledged) WITHOUT bodies;
 *  - GET ?id= is the detail (versions WITH body + assignments);
 *  - content is APPEND-ONLY: there is no edit-draft-in-place action — the
 *    draft editor here saves via POST add_version, minting the next version
 *    number as a draft (the UI says so out loud);
 *  - PATCH publish archives vN-1 + publishes vN + assigns in one transaction;
 *  - PATCH acknowledge is an ON-BEHALF stamp (self-service deferred, §8.3).
 *
 * Page tier: mgmtOnly (/hr/sops in page-catalog) — the API re-checks
 * canManageHr on every verb; this page just renders what it is allowed to see.
 * Structure copied from src/app/hr/employees/page.tsx (fetch race guard,
 * modal shell, palette); grouped-by-category list per the build spec.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, Plus, Search, X, Loader2, Save, Send, Pencil,
  ChevronDown, ChevronRight, ChevronLeft, AlertTriangle, UserCheck,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import {
  sopVersionStatusMeta,
  type HrSop,
  type HrSopVersion,
  type HrSopAssignment,
} from '@/lib/hr';

const PAGE_SIZE = 100;

/** Mirrors the publish rule in /api/hr/sops: these states never receive new
 *  assignments (suspended staff DO — the assignment waits for their return). */
const EXITED_STATUSES = ['resigned', 'terminated', 'former'];

// ── API row shapes (see the /api/hr/sops route doc) ───────────────────────
interface AssignmentRow extends HrSopAssignment {
  employee_name: string | null;
  employee_code: string | null;
}

interface VersionRow extends Omit<HrSopVersion, 'body'> {
  /** Present on the detail GET only — the list projection has no bodies. */
  body?: string;
  assigned: number;
  viewed: number;
  acknowledged: number;
  /** Present on the detail GET only. */
  assignments?: AssignmentRow[];
}

interface SopRow extends HrSop {
  department_name: string | null;
  designation_name: string | null;
  version_count: number;
  published: VersionRow | null;
  versions: VersionRow[];
}

// ── Picker data shapes ────────────────────────────────────────────────────
interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface DesigRow { id: string; name: string; grade?: string; is_active?: number }
interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  sub_department_id: string;
  designation_id: string;
  status: string;
}

interface CreateForm {
  title: string;
  category: string;
  department_id: string;
  designation_id: string;
}

const emptyCreateForm = (): CreateForm => ({
  title: '', category: '', department_id: '', designation_id: '',
});

export default function HrSopsPage() {
  // ── List state ──────────────────────────────────────────────────────────
  const [rows, setRows] = useState<SopRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false); // any in-flight list fetch
  const [error, setError] = useState<string | null>(null);

  // ── Filters ─────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState(''); // debounced searchInput
  const [showInactive, setShowInactive] = useState(false);

  // ── Picker data (create modal + publish modal) ─────────────────────────
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [designations, setDesignations] = useState<DesigRow[]>([]);
  const [employees, setEmployees] = useState<EmpRow[]>([]);
  const [empTotal, setEmpTotal] = useState(0);

  // ── Create modal ────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Detail drawer ───────────────────────────────────────────────────────
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SopRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [headSaving, setHeadSaving] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());
  const [ackBusyId, setAckBusyId] = useState<string | null>(null);

  // ── Draft editor (inside the drawer) ────────────────────────────────────
  const [editorBody, setEditorBody] = useState('');
  const [editorRequireAck, setEditorRequireAck] = useState(true);
  const [editorLoadedFrom, setEditorLoadedFrom] = useState<number | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // ── Publish modal (stacks over the drawer) ──────────────────────────────
  const [publishVersion, setPublishVersion] = useState<VersionRow | null>(null);
  const [pubDeptId, setPubDeptId] = useState('');
  const [pubDesigId, setPubDesigId] = useState('');
  const [pubEmpIds, setPubEmpIds] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Race guards: a stale response must never overwrite a newer one
  // (pattern copied from src/app/hr/employees/page.tsx).
  const fetchSeq = useRef(0);
  const detailSeq = useRef(0);

  // Debounce the search box (300ms)
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever any filter changes
  useEffect(() => { setPage(1); }, [q, showInactive]);

  const fetchSops = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (showInactive) sp.set('include_inactive', '1');
      sp.set('page', String(page));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/sops?${sp.toString()}`);
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view the SOP library.'
          : "Couldn't load SOPs");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load SOPs");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [q, showInactive, page]);

  useEffect(() => { fetchSops(); }, [fetchSops]);

  // Picker data — one fetch each on mount (bare fetch is fine for GETs)
  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
    fetch('/api/hr/designations')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDesignations(Array.isArray(j?.designations) ? j.designations : []))
      .catch(() => {});
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => {
        setEmployees(Array.isArray(j?.rows) ? j.rows : []);
        setEmpTotal(Number(j?.total) || 0);
      })
      .catch(() => {});
  }, []);

  // ── Grouping: category → SOPs (case-insensitive key, first-seen label).
  // Keys are PREFIXED ('c:' real category, 'u:' blank) so the blank-category
  // group can never collide with a real category named "Uncategorised"; the
  // key doubles as the group's React key.
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; sops: SopRow[] }>();
    for (const r of rows) {
      const raw = (r.category || '').trim();
      const key = raw ? `c:${raw.toLowerCase()}` : 'u:';
      const g = m.get(key);
      if (g) g.sops.push(r);
      else m.set(key, { key, label: raw || 'Uncategorised', sops: [r] });
    }
    return [...m.values()].sort((a, b) => {
      if (a.key === 'u:') return 1;
      if (b.key === 'u:') return -1;
      return a.key.localeCompare(b.key);
    });
  }, [rows]);

  /** Distinct categories seen on this page — feeds the create-modal datalist. */
  const knownCategories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const raw = (r.category || '').trim();
      if (raw && !seen.has(raw.toLowerCase())) seen.set(raw.toLowerCase(), raw);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // ── Department / designation picker options ─────────────────────────────
  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const desigById = useMemo(() => new Map(designations.map(d => [d.id, d])), [designations]);
  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  const deptOptions = useMemo<ComboOption[]>(() => {
    const mains = departments
      .filter(d => !d.parent_id && d.is_active)
      .sort((a, b) => a.name.localeCompare(b.name));
    const opts: ComboOption[] = [{ value: '', label: '(none)' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of departments
        .filter(d => d.parent_id === m.id && d.is_active)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        opts.push({ value: s.id, label: s.name, hint: m.name });
      }
    }
    return opts;
  }, [departments]);

  const desigOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: '(none)' },
      ...designations
        .filter(d => d.is_active !== 0)
        .map(d => ({ value: d.id, label: d.name, hint: d.grade || undefined })),
    ],
    [designations],
  );

  /** Publish-modal employee picker: active-employment staff not yet picked. */
  const empPickOptions = useMemo<ComboOption[]>(() => {
    const picked = new Set(pubEmpIds);
    return employees
      .filter(e => !EXITED_STATUSES.includes(e.status) && !picked.has(e.id))
      .map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code }));
  }, [employees, pubEmpIds]);

  /** Client-side preview of the publish audience (mirrors the server union:
   *  department matches main OR sub, designation exact, plus picked ids;
   *  exited employees never receive assignments). */
  const previewCount = useMemo(() => {
    if (!publishVersion) return 0;
    const picked = new Set(pubEmpIds);
    let n = 0;
    for (const e of employees) {
      if (EXITED_STATUSES.includes(e.status)) continue;
      const deptHit = !!pubDeptId && (e.department_id === pubDeptId || e.sub_department_id === pubDeptId);
      const desigHit = !!pubDesigId && e.designation_id === pubDesigId;
      if (deptHit || desigHit || picked.has(e.id)) n++;
    }
    return n;
  }, [publishVersion, pubDeptId, pubDesigId, pubEmpIds, employees]);

  // ── Detail drawer ───────────────────────────────────────────────────────
  const refreshDetail = useCallback(async (id: string): Promise<SopRow | null> => {
    const seq = ++detailSeq.current;
    setDetailError(null);
    try {
      const res = await fetch(`/api/hr/sops?id=${encodeURIComponent(id)}`);
      if (seq !== detailSeq.current) return null;
      if (!res.ok) {
        setDetailError(res.status === 404 ? 'This SOP was not found.' : "Couldn't load the SOP");
        return null;
      }
      const json = await res.json();
      if (seq !== detailSeq.current) return null;
      const sop: SopRow | null = json?.sop ?? null;
      setDetail(sop);
      return sop;
    } catch {
      if (seq === detailSeq.current) setDetailError("Couldn't load the SOP");
      return null;
    }
  }, []);

  /** Seed the draft editor from the newest draft (else the newest version). */
  const prefillEditor = useCallback((sop: SopRow) => {
    const versions = sop.versions ?? [];
    const seed = versions.find(v => v.status === 'draft') ?? versions[0] ?? null;
    setEditorBody(seed?.body ?? '');
    setEditorRequireAck(seed ? !!seed.require_ack : true);
    setEditorLoadedFrom(seed ? seed.version : null);
    setEditorError(null);
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setExpandedVersions(new Set());
    const sop = await refreshDetail(id);
    setDetailLoading(false);
    if (sop) prefillEditor(sop);
  }, [refreshDetail, prefillEditor]);

  const closeDetail = () => {
    detailSeq.current++; // invalidate any in-flight detail fetch
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    setPublishVersion(null);
  };

  const toggleVersionExpanded = (versionId: string) => {
    setExpandedVersions(prev => {
      const next = new Set(prev);
      if (next.has(versionId)) next.delete(versionId);
      else next.add(versionId);
      return next;
    });
  };

  // ── Mutations ───────────────────────────────────────────────────────────
  const createSop = async () => {
    if (!createForm.title.trim()) { setCreateError('SOP title is required.'); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiJson<{ sop: SopRow }>('/api/hr/sops', {
        method: 'POST',
        body: {
          action: 'create',
          title: createForm.title.trim(),
          category: createForm.category.trim(),
          department_id: createForm.department_id,
          designation_id: createForm.designation_id,
        },
      });
      setShowCreate(false);
      fetchSops();
      if (res?.sop?.id) {
        // Straight into the drawer so the first draft can be written now.
        setDetailId(res.sop.id);
        setDetail(res.sop);
        setDetailLoading(false);
        setExpandedVersions(new Set());
        prefillEditor(res.sop);
      }
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Could not create the SOP');
    } finally {
      setCreating(false);
    }
  };

  const saveDraft = async () => {
    if (!detail) return;
    if (!editorBody.trim()) { setEditorError('Write the SOP content before saving.'); return; }
    setEditorSaving(true);
    setEditorError(null);
    try {
      await apiJson('/api/hr/sops', {
        method: 'POST',
        body: {
          action: 'add_version',
          sop_id: detail.id,
          body: editorBody,
          require_ack: editorRequireAck,
        },
      });
      const sop = await refreshDetail(detail.id);
      if (sop) {
        const newest = sop.versions?.[0] ?? null;
        setEditorLoadedFrom(newest ? newest.version : null);
      }
      fetchSops();
    } catch (e: unknown) {
      setEditorError(e instanceof Error ? e.message : 'Could not save the draft');
    } finally {
      setEditorSaving(false);
    }
  };

  const toggleActive = async (next: boolean) => {
    if (!detail || headSaving) return;
    setHeadSaving(true);
    setDetailError(null);
    try {
      const res = await apiJson<{ sop: SopRow }>('/api/hr/sops', {
        method: 'PATCH',
        body: { action: 'update', id: detail.id, is_active: next },
      });
      if (res?.sop) setDetail(res.sop);
      fetchSops();
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Could not update the SOP');
    } finally {
      setHeadSaving(false);
    }
  };

  const openPublish = (v: VersionRow) => {
    if (!detail) return;
    setPublishVersion(v);
    // Seed the audience from the SOP head's targeting hints (only when the
    // hinted id still resolves — a dangling hint must not 400 the publish).
    setPubDeptId(detail.department_id && deptById.has(detail.department_id) ? detail.department_id : '');
    setPubDesigId(detail.designation_id && desigById.has(detail.designation_id) ? detail.designation_id : '');
    setPubEmpIds([]);
    setPublishError(null);
  };

  const doPublish = async () => {
    if (!detail || !publishVersion) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await apiJson<{ sop: SopRow }>('/api/hr/sops', {
        method: 'PATCH',
        body: {
          action: 'publish',
          version_id: publishVersion.id,
          assign_to: {
            department_id: pubDeptId,
            designation_id: pubDesigId,
            employee_ids: pubEmpIds,
          },
        },
      });
      if (res?.sop) setDetail(res.sop);
      setPublishVersion(null);
      fetchSops();
    } catch (e: unknown) {
      setPublishError(e instanceof Error ? e.message : 'Could not publish this version');
    } finally {
      setPublishing(false);
    }
  };

  const ackOnBehalf = async (a: AssignmentRow) => {
    if (!detail || ackBusyId) return;
    const who = a.employee_name || a.employee_code || 'this employee';
    if (!window.confirm(
      `Mark this version as acknowledged on behalf of ${who}? ` +
      'Your name is recorded in the audit log and the stamp cannot be undone.',
    )) return;
    setAckBusyId(a.id);
    setDetailError(null);
    try {
      await apiJson('/api/hr/sops', {
        method: 'PATCH',
        body: { action: 'acknowledge', assignment_id: a.id },
      });
      await refreshDetail(detail.id);
      fetchSops();
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Could not record the acknowledgement');
    } finally {
      setAckBusyId(null);
    }
  };

  const loadVersionIntoEditor = (v: VersionRow) => {
    setEditorBody(v.body ?? '');
    setEditorRequireAck(!!v.require_ack);
    setEditorLoadedFrom(v.version);
    setEditorError(null);
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const nextVersionNo = (detail?.versions?.[0]?.version ?? 0) + 1;
  const currentPublished = detail?.versions?.find(v => v.status === 'published') ?? null;

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

  const versionChip = (status: string) => {
    const meta = sopVersionStatusMeta(status);
    return (
      <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
        {meta.label}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <BookOpen className="w-6 h-6" /> SOP Library
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Standard operating procedures{loading ? '' : ` — ${total} SOP${total === 1 ? '' : 's'}`}.
              Versioned content, publish-to-assign, per-person acknowledgements.
            </p>
          </div>
          <button
            onClick={() => { setCreateForm(emptyCreateForm()); setCreateError(null); setShowCreate(true); }}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New SOP
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <input
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Title or category…"
                className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-[#6B5744]">
              <Toggle size="sm" checked={showInactive} onChange={setShowInactive} label="Show inactive SOPs" />
              Show inactive
            </label>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => fetchSops()}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Grouped list */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-6 text-center text-[#8B7355] text-sm">
            {q || showInactive ? 'No SOPs match these filters.' : 'No SOPs yet — create the first one.'}
          </div>
        ) : (
          <div className={`space-y-5 ${fetching ? 'opacity-60' : ''}`}>
            {groups.map(g => (
              <div key={g.key}>
                <div className="flex items-baseline gap-2 mb-2">
                  <h2 className="text-sm font-bold text-[#6B5744] uppercase tracking-wide">{g.label}</h2>
                  <span className="text-xs text-[#8B7355]">{g.sops.length}</span>
                </div>
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium">SOP</th>
                          <th className="text-left py-2 px-3 font-medium">Published</th>
                          <th className="text-left py-2 px-3 font-medium">Completion</th>
                          <th className="text-left py-2 px-3 font-medium">Versions</th>
                          <th className="text-left py-2 px-3 font-medium">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.sops.map(r => (
                          <tr key={r.id}
                              onClick={() => openDetail(r.id)}
                              className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] cursor-pointer">
                            <td className="py-2 px-3">
                              <span className="font-bold text-[#2D1B0E]">{r.title}</span>
                              {!r.is_active && (
                                <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium border bg-gray-100 text-gray-600 border-gray-200">
                                  Inactive
                                </span>
                              )}
                              {(r.department_name || r.designation_name) && (
                                <div className="text-[11px] text-[#8B7355]">
                                  {[r.department_name, r.designation_name].filter(Boolean).join(' · ')}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">
                              {r.published ? (
                                <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border bg-green-100 text-green-700 border-green-200">
                                  v{r.published.version}
                                </span>
                              ) : (
                                <span className="text-xs text-[#8B7355]">none</span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs whitespace-nowrap">
                              {r.published ? (
                                r.published.assigned > 0 ? (
                                  <span className={r.published.acknowledged >= r.published.assigned
                                    ? 'text-green-700 font-medium'
                                    : 'text-[#6B5744]'}>
                                    ack {r.published.acknowledged}/{r.published.assigned}
                                  </span>
                                ) : (
                                  <span className="text-[#8B7355]">unassigned</span>
                                )
                              ) : (
                                <span className="text-[#8B7355]">—</span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs">{r.version_count}</td>
                            <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTDate(r.updated_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))}

            {pageCount > 1 && (
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || fetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </button>
                <span className="text-xs text-[#6B5744]">Page {page} of {pageCount}</span>
                <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount || fetching}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Create modal — house safe-modal shell */}
        {showCreate && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">New SOP</h2>
                <button onClick={() => { if (!creating) setShowCreate(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {createError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {createError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Title *</label>
                  <input value={createForm.title}
                         onChange={e => setCreateForm({ ...createForm, title: e.target.value })}
                         placeholder="e.g. Opening Checklist — Kitchen"
                         className={inputCls} autoFocus />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Category</label>
                  <input value={createForm.category}
                         onChange={e => setCreateForm({ ...createForm, category: e.target.value })}
                         placeholder="e.g. Kitchen, Service, Hygiene…"
                         list="sop-category-options"
                         className={inputCls} />
                  <datalist id="sop-category-options">
                    {knownCategories.map(c => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Department hint</label>
                    <Combobox
                      options={deptOptions}
                      value={createForm.department_id ? (deptById.get(createForm.department_id)?.name || '') : ''}
                      onChange={(v) => setCreateForm({ ...createForm, department_id: v })}
                      placeholder="Pick department"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Designation hint</label>
                    <Combobox
                      options={desigOptions}
                      value={createForm.designation_id ? (desigById.get(createForm.designation_id)?.name || '') : ''}
                      onChange={(v) => setCreateForm({ ...createForm, designation_id: v })}
                      placeholder="Pick designation"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Hints describe who this SOP is for and pre-fill the publish audience — the content
                  itself is written as a draft version after saving.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowCreate(false)} disabled={creating}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={createSop} disabled={creating}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Create
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Detail drawer — house shell anchored right */}
        {detailId && (
          <div className="fixed inset-0 z-50 bg-black/40 flex justify-end p-2 sm:p-3">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden h-full">
              {/* Drawer header */}
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-start justify-between gap-3 shrink-0">
                <div className="min-w-0">
                  <h2 className="font-bold text-[#2D1B0E] truncate">
                    {detail?.title || 'SOP'}
                  </h2>
                  <div className="text-[11px] text-[#8B7355] mt-0.5">
                    {[
                      (detail?.category || '').trim() || null,
                      detail?.department_name || null,
                      detail?.designation_name || null,
                    ].filter(Boolean).join(' · ') || 'No category or targeting hints'}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {detail && (
                    <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
                      <Toggle size="sm" checked={!!detail.is_active} onChange={toggleActive}
                              disabled={headSaving} label="SOP active" />
                      Active
                    </label>
                  )}
                  <button onClick={closeDetail} className="text-[#8B7355]">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Drawer body */}
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
                {detailError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
                    <span>{detailError}</span>
                    <button onClick={() => detailId && refreshDetail(detailId)}
                            className="shrink-0 px-2.5 py-1 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                      Retry
                    </button>
                  </div>
                )}

                {detailLoading ? (
                  <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                  </div>
                ) : detail ? (
                  <>
                    {/* Draft editor */}
                    <div ref={editorRef} className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-bold text-[#2D1B0E]">Draft content</h3>
                        {editorLoadedFrom !== null && (
                          <span className="text-[11px] text-[#8B7355]">loaded from v{editorLoadedFrom}</span>
                        )}
                      </div>
                      {editorError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                          {editorError}
                        </div>
                      )}
                      <textarea
                        value={editorBody}
                        onChange={e => setEditorBody(e.target.value)}
                        rows={10}
                        placeholder="Write the SOP here — steps, checks, do's and don'ts…"
                        className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm leading-relaxed"
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
                          <Toggle size="sm" checked={editorRequireAck} onChange={setEditorRequireAck}
                                  label="Requires acknowledgement" />
                          Requires acknowledgement
                        </label>
                        <button onClick={saveDraft} disabled={editorSaving}
                                className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                          {editorSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          Save as draft v{nextVersionNo}
                        </button>
                      </div>
                      <p className="text-[11px] text-[#8B7355]">
                        Content history is append-only: every save creates a new draft version.
                        Nothing changes for staff until a version is published.
                      </p>
                    </div>

                    {/* Versions */}
                    <div className="space-y-2">
                      <h3 className="text-sm font-bold text-[#2D1B0E]">Versions</h3>
                      {(detail.versions ?? []).length === 0 ? (
                        <p className="text-sm text-[#8B7355]">
                          No versions yet — save the first draft above.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {(detail.versions ?? []).map(v => {
                            const expanded = expandedVersions.has(v.id);
                            const assignments = v.assignments ?? [];
                            return (
                              <div key={v.id} className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                                {/* Version header row */}
                                <div className="px-3 py-2 bg-[#FFF8F0] flex flex-wrap items-center gap-2">
                                  <button onClick={() => toggleVersionExpanded(v.id)}
                                          className="inline-flex items-center gap-1 text-[#6B5744]"
                                          aria-label={expanded ? 'Collapse version' : 'Expand version'}>
                                    {expanded
                                      ? <ChevronDown className="w-4 h-4" />
                                      : <ChevronRight className="w-4 h-4" />}
                                    <span className="font-mono text-sm font-bold">v{v.version}</span>
                                  </button>
                                  {versionChip(v.status)}
                                  {!v.require_ack && (
                                    <span className="text-[10px] text-[#8B7355]">no ack needed</span>
                                  )}
                                  <span className="text-[11px] text-[#8B7355] flex-1 min-w-[120px]">
                                    {v.published_at
                                      ? `${v.status === 'published' ? 'Published' : 'Was published'} ${fmtIST(v.published_at)}${v.published_by ? ` · ${v.published_by}` : ''}`
                                      : `Created ${fmtIST(v.created_at)}`}
                                  </span>
                                  <span className="text-[11px] text-[#6B5744] whitespace-nowrap">
                                    {v.assigned > 0
                                      ? `ack ${v.acknowledged}/${v.assigned} · viewed ${v.viewed}/${v.assigned}`
                                      : 'unassigned'}
                                  </span>
                                  <div className="flex items-center gap-1.5">
                                    <button onClick={() => loadVersionIntoEditor(v)}
                                            title={v.status === 'draft' ? 'Edit this draft in the editor' : 'Load this content into the editor'}
                                            className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-[11px] font-medium">
                                      <Pencil className="w-3 h-3" /> {v.status === 'draft' ? 'Edit' : 'Load'}
                                    </button>
                                    {v.status !== 'published' && (
                                      <button onClick={() => openPublish(v)}
                                              disabled={!detail.is_active}
                                              title={detail.is_active
                                                ? `Publish v${v.version}`
                                                : 'Reactivate the SOP before publishing'}
                                              className="inline-flex items-center gap-1 px-2 py-1 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-[11px] font-medium disabled:opacity-40">
                                        <Send className="w-3 h-3" /> Publish…
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* Expanded: body preview + assignment table */}
                                {expanded && (
                                  <div className="border-t border-[#E8D5C4]/60 p-3 space-y-3">
                                    <div className="max-h-48 overflow-y-auto rounded-lg bg-[#FFF8F0] border border-[#E8D5C4]/60 px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed">
                                      {v.body || <span className="text-[#8B7355]">No content.</span>}
                                    </div>
                                    {assignments.length === 0 ? (
                                      <p className="text-xs text-[#8B7355]">
                                        No employees are assigned to this version.
                                      </p>
                                    ) : (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                          <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                                            <tr>
                                              <th className="text-left py-1.5 px-2 font-medium">Employee</th>
                                              <th className="text-left py-1.5 px-2 font-medium">Viewed</th>
                                              <th className="text-left py-1.5 px-2 font-medium">Acknowledged</th>
                                              <th className="text-right py-1.5 px-2 font-medium"></th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {assignments.map(a => (
                                              <tr key={a.id} className="border-t border-[#E8D5C4]/50">
                                                <td className="py-1.5 px-2">
                                                  <span className="font-medium">
                                                    {a.employee_name || <span className="text-[#8B7355]">(unknown)</span>}
                                                  </span>
                                                  {a.employee_code && (
                                                    <span className="ml-1.5 text-[10px] font-mono text-[#8B7355]">
                                                      {a.employee_code}
                                                    </span>
                                                  )}
                                                </td>
                                                <td className="py-1.5 px-2 text-xs whitespace-nowrap">
                                                  {a.viewed_at
                                                    ? fmtIST(a.viewed_at)
                                                    : <span className="text-[#8B7355]">—</span>}
                                                </td>
                                                <td className="py-1.5 px-2 text-xs whitespace-nowrap">
                                                  {a.acknowledged_at
                                                    ? <span className="text-green-700">{fmtIST(a.acknowledged_at)}</span>
                                                    : <span className="text-[#8B7355]">—</span>}
                                                </td>
                                                <td className="py-1.5 px-2 text-right">
                                                  {!a.acknowledged_at && (
                                                    <button onClick={() => ackOnBehalf(a)}
                                                            disabled={ackBusyId !== null}
                                                            title="Record the acknowledgement on behalf of this employee (self-service is not enabled)"
                                                            className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-[11px] font-medium disabled:opacity-40">
                                                      {ackBusyId === a.id
                                                        ? <Loader2 className="w-3 h-3 animate-spin" />
                                                        : <UserCheck className="w-3 h-3" />}
                                                      Ack on behalf
                                                    </button>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                ) : !detailError ? (
                  <p className="text-sm text-[#8B7355]">This SOP could not be loaded.</p>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* Publish modal — stacks over the drawer */}
        {publishVersion && detail && (
          <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  Publish v{publishVersion.version} — {detail.title}
                </h2>
                <button onClick={() => { if (!publishing) setPublishVersion(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {publishError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {publishError}
                  </div>
                )}

                {/* The §24 warning: publish archives vN-1 and assigns vN */}
                <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2 text-sm flex gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    {currentPublished && currentPublished.id !== publishVersion.id ? (
                      <>Publishing v{publishVersion.version} will <b>archive the currently published
                      v{currentPublished.version}</b> and assign v{publishVersion.version} to the employees
                      selected below. Acknowledgements already recorded stay with v{currentPublished.version}.</>
                    ) : (
                      <>Publishing makes v{publishVersion.version} the live version and assigns it to the
                      employees selected below.</>
                    )}
                  </span>
                </div>

                {/* Audience */}
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">Assign to</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Department (main or sub)</label>
                      <Combobox
                        options={deptOptions}
                        value={pubDeptId ? (deptById.get(pubDeptId)?.name || '') : ''}
                        onChange={(v) => setPubDeptId(v)}
                        placeholder="All of a department"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Designation</label>
                      <Combobox
                        options={desigOptions}
                        value={pubDesigId ? (desigById.get(pubDesigId)?.name || '') : ''}
                        onChange={(v) => setPubDesigId(v)}
                        placeholder="Everyone with a designation"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Specific employees</label>
                    <Combobox
                      options={empPickOptions}
                      value=""
                      onChange={(v) => { if (v) setPubEmpIds(prev => (prev.includes(v) ? prev : [...prev, v])); }}
                      placeholder="Add an employee…"
                    />
                    {pubEmpIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {pubEmpIds.map(id => {
                          const e = empById.get(id);
                          return (
                            <span key={id}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]">
                              {e ? e.full_name : id}
                              {e?.employee_code && (
                                <span className="font-mono text-[10px] text-[#8B7355]">{e.employee_code}</span>
                              )}
                              <button onClick={() => setPubEmpIds(prev => prev.filter(x => x !== id))}
                                      aria-label="Remove employee" className="text-[#8B7355] hover:text-[#af4408]">
                                <X className="w-3 h-3" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Preview count */}
                  <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-sm">
                    {previewCount > 0 ? (
                      <span>
                        <b>{previewCount}</b> employee{previewCount === 1 ? '' : 's'} will be assigned
                        v{publishVersion.version}.
                      </span>
                    ) : (
                      <span className="text-[#8B7355]">
                        No employees selected — the version will be published without assignments.
                      </span>
                    )}
                    <div className="text-[11px] text-[#8B7355] mt-0.5">
                      Employees who left (resigned / terminated / former) are never assigned; anyone
                      already holding this version keeps their existing viewed/ack status.
                      {empTotal > employees.length
                        ? ` Preview is based on the first ${employees.length} of ${empTotal} employees — the publish itself covers everyone.`
                        : ''}
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setPublishVersion(null)} disabled={publishing}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={doPublish} disabled={publishing}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Publish v{publishVersion.version}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
