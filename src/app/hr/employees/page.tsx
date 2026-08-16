'use client';

/**
 * HR — Employee Master list (Phase 1).
 *
 * Contract: docs/HRMS_DECISIONS.md. Server-side pagination against
 * GET /api/hr/employees (isManagement-gated — the API is the boundary, this
 * page just renders what it is allowed to see). Structure copied from the
 * canonical CRUD page (src/app/vendors/page.tsx); fetch race guard copied
 * from src/app/crm-calls/log/page.tsx.
 *
 * The create modal is deliberately MINIMAL (Personal + Employment essentials)
 * — everything else is edited on the profile page (/hr/employees/[id]), which
 * the save navigates straight into.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Users, Plus, Search, X, Loader2, Save, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtISTDate } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import PhoneField from '@/components/PhoneField';
import TabScroller from '@/components/TabScroller';
import {
  HR_EMPLOYEE_STATUSES,
  HR_EMPLOYMENT_TYPES,
  employeeStatusMeta,
  type HrEmployeeListRow,
} from '@/lib/hr';

const PAGE_SIZE = 25;

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }
interface DesigRow { id: string; name: string; grade?: string; is_active?: number }
interface OutletRow { id: string; name: string; is_active?: number }

interface CreateForm {
  full_name: string;
  phone10: string;
  gender: string;
  dob: string;
  department_id: string;
  sub_department_id: string;
  designation_id: string;
  employment_type: string;
  joining_date: string;
  home_outlet_id: string;
}

const emptyForm = (): CreateForm => ({
  full_name: '', phone10: '', gender: '', dob: '',
  department_id: '', sub_department_id: '', designation_id: '',
  employment_type: 'permanent', joining_date: '', home_outlet_id: '',
});

/** First letters of the first two words — the no-photo avatar. */
function initialsOf(name: string): string {
  return (
    name.trim().split(/\s+/).slice(0, 2).map(w => (w[0] || '').toUpperCase()).join('') || '?'
  );
}

export default function HrEmployeesPage() {
  const router = useRouter();

  // ── List state ──────────────────────────────────────────────────────────
  const [rows, setRows] = useState<HrEmployeeListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false); // any in-flight list fetch
  const [error, setError] = useState<string | null>(null);

  // ── Filters ─────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');            // debounced searchInput
  const [deptId, setDeptId] = useState('');  // '' = all departments
  const [status, setStatus] = useState('');  // '' = all statuses

  // ── Picker data (shared by the filter card + the create modal) ─────────
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [designations, setDesignations] = useState<DesigRow[]>([]);
  const [outlets, setOutlets] = useState<OutletRow[]>([]);

  // ── Create modal ────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Race guard: a stale response must never overwrite a newer one
  // (pattern copied from src/app/crm-calls/log/page.tsx).
  const fetchSeq = useRef(0);

  // Debounce the search box (300ms)
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever any filter changes
  useEffect(() => { setPage(1); }, [q, deptId, status]);

  const buildQuery = useCallback((p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (deptId) sp.set('department_id', deptId);
    if (status) sp.set('status', status);
    sp.set('page', String(p));
    sp.set('pageSize', String(PAGE_SIZE));
    return sp.toString();
  }, [q, deptId, status]);

  const fetchEmployees = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/hr/employees?${buildQuery(page)}`);
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view the employee master.'
          : "Couldn't load employees");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      // transient network error — keep last data, surface a retryable error state
      if (seq === fetchSeq.current) setError("Couldn't load employees");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [buildQuery, page]);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

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
    fetch('/api/outlets')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setOutlets(Array.isArray(j?.outlets) ? j.outlets : []))
      .catch(() => {});
  }, []);

  // ── Department tree helpers ─────────────────────────────────────────────
  const mains = useMemo(
    () => departments.filter(d => !d.parent_id && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const subsOf = useCallback(
    (parentId: string) =>
      departments.filter(d => d.parent_id === parentId && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );

  /** Filter picker: all departments; subs carry their parent name as the hint (profile-page pattern). */
  const deptFilterOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: 'All departments' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of subsOf(m.id)) opts.push({ value: s.id, label: s.name, hint: m.name });
    }
    return opts;
  }, [mains, subsOf]);

  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const deptFilterLabel = deptId ? (deptById.get(deptId)?.name || '') : '';

  // Modal pickers
  const mainOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(none)' }, ...mains.map(m => ({ value: m.id, label: m.name }))],
    [mains],
  );
  const subOptions = useMemo<ComboOption[]>(() => {
    if (!form.department_id) return [];
    return [{ value: '', label: '(none)' }, ...subsOf(form.department_id).map(s => ({ value: s.id, label: s.name }))];
  }, [form.department_id, subsOf]);
  const desigOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: '(none)' },
      ...designations
        .filter(d => d.is_active !== 0)
        .map(d => ({ value: d.id, label: d.name, hint: d.grade || undefined })),
    ],
    [designations],
  );
  const outletOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(none)' }, ...outlets.map(o => ({ value: o.id, label: o.name }))],
    [outlets],
  );

  // ── Create ──────────────────────────────────────────────────────────────
  const openCreate = () => { setForm(emptyForm()); setCreateError(null); setShowCreate(true); };

  const save = async () => {
    if (!form.full_name.trim()) { setCreateError('Full name is required.'); return; }
    setSaving(true);
    setCreateError(null);
    try {
      const res = await apiJson<{ employee: { id: string } }>('/api/hr/employees', {
        method: 'POST',
        body: { ...form, full_name: form.full_name.trim() },
      });
      if (res?.employee?.id) {
        router.push(`/hr/employees/${res.employee.id}`);
      } else {
        // Defensive: created but no id came back — refresh the list instead.
        setShowCreate(false);
        fetchEmployees();
      }
    } catch (e: any) {
      setCreateError(e?.message || 'Could not create the employee');
      setSaving(false);
    }
    // Keep `saving` true through a successful navigation so the button can't double-fire.
  };

  // ── Pagination derived ──────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Users className="w-6 h-6" /> Employees
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Employee master{loading ? '' : ` — ${total} employee${total === 1 ? '' : 's'}`}. Profiles, departments and designations.
            </p>
          </div>
          <button onClick={openCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Employee
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                     placeholder="Name, code, phone…"
                     className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </div>
            <div className="w-full sm:w-64">
              <Combobox
                options={deptFilterOptions}
                value={deptFilterLabel}
                onChange={(v) => setDeptId(v)}
                placeholder="All departments"
              />
            </div>
          </div>
          <TabScroller className="gap-2">
            <button onClick={() => setStatus('')}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                      status === ''
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                    }`}>
              All
            </button>
            {HR_EMPLOYEE_STATUSES.map(s => (
              <button key={s.key} onClick={() => setStatus(prev => (prev === s.key ? '' : s.key))}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                        status === s.key
                          ? 'bg-[#af4408] text-white border-[#af4408]'
                          : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                      }`}>
                {s.label}
              </button>
            ))}
          </TabScroller>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => fetchEmployees()}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {q || deptId || status ? 'No employees match these filters.' : 'No employees yet — add the first one.'}
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium w-10"></th>
                      <th className="text-left py-2 px-3 font-medium">Code</th>
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                      <th className="text-left py-2 px-3 font-medium">Department</th>
                      <th className="text-left py-2 px-3 font-medium">Designation</th>
                      <th className="text-left py-2 px-3 font-medium">Phone</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-left py-2 px-3 font-medium">Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const meta = employeeStatusMeta(r.status);
                      return (
                        <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                          <td className="py-2 pl-3 pr-0">
                            {/* Per-row photos deliberately not fetched in lists (Phase 1) — the list API sends has_photo only. */}
                            <div className="w-8 h-8 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] text-[#af4408] text-xs font-bold flex items-center justify-center">
                              {initialsOf(r.full_name)}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">{r.employee_code}</td>
                          <td className="py-2 px-3">
                            <Link href={`/hr/employees/${r.id}`}
                                  className="font-bold text-[#2D1B0E] hover:text-[#af4408] hover:underline">
                              {r.full_name}
                            </Link>
                            {r.linked_user_email && (
                              <div className="text-[10px] text-[#8B7355]">{r.linked_user_email}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs">
                            {r.department_name || <span className="text-[#8B7355]">—</span>}
                            {r.sub_department_name && (
                              <div className="text-[10px] text-[#8B7355]">{r.sub_department_name}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs">{r.designation_name || <span className="text-[#8B7355]">—</span>}</td>
                          <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">{r.phone10 || <span className="text-[#8B7355]">—</span>}</td>
                          <td className="py-2 px-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.color}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">
                            {r.joining_date ? fmtISTDate(r.joining_date) : <span className="text-[#8B7355]">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[#8B7355]">Showing {fromN}–{toN} of {total}</span>
                <div className="flex items-center gap-2">
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
              </div>
            </>
          )}
        </div>

        {/* Create modal — house safe-modal shell */}
        {showCreate && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Add Employee</h2>
                <button onClick={() => { if (!saving) setShowCreate(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {createError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {createError}
                  </div>
                )}

                {/* Personal */}
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">Personal</div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Full name *</label>
                    <input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
                           placeholder="e.g. Ravi Kumar" className={inputCls} autoFocus />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Phone</label>
                    <PhoneField value={form.phone10} onChange={v => setForm({ ...form, phone10: v })} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Gender</label>
                      <select value={form.gender} onChange={e => setForm({ ...form, gender: e.target.value })}
                              className={inputCls}>
                        <option value="">—</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Date of birth</label>
                      <input type="date" value={form.dob} onChange={e => setForm({ ...form, dob: e.target.value })}
                             className={inputCls} />
                    </div>
                  </div>
                </div>

                {/* Employment */}
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">Employment</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Department</label>
                      <Combobox
                        options={mainOptions}
                        value={form.department_id ? (deptById.get(form.department_id)?.name || '') : ''}
                        onChange={(v) => setForm({ ...form, department_id: v, sub_department_id: '' })}
                        placeholder="Pick department"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Sub-department</label>
                      {!form.department_id ? (
                        <input disabled placeholder="Pick department first" className={`${inputCls} opacity-60`} />
                      ) : subOptions.length <= 1 ? (
                        <input disabled placeholder="No sub-departments" className={`${inputCls} opacity-60`} />
                      ) : (
                        <Combobox
                          options={subOptions}
                          value={form.sub_department_id ? (deptById.get(form.sub_department_id)?.name || '') : ''}
                          onChange={(v) => setForm({ ...form, sub_department_id: v })}
                          placeholder="Pick sub-department"
                        />
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Designation</label>
                      <Combobox
                        options={desigOptions}
                        value={form.designation_id ? (designations.find(d => d.id === form.designation_id)?.name || '') : ''}
                        onChange={(v) => setForm({ ...form, designation_id: v })}
                        placeholder="Pick designation"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Employment type</label>
                      <select value={form.employment_type}
                              onChange={e => setForm({ ...form, employment_type: e.target.value })}
                              className={inputCls}>
                        {HR_EMPLOYMENT_TYPES.map(t => (
                          <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-[#6B5744]">Joining date</label>
                      <input type="date" value={form.joining_date}
                             onChange={e => setForm({ ...form, joining_date: e.target.value })}
                             className={inputCls} />
                    </div>
                    <div>
                      <label className="text-xs text-[#6B5744]">Home outlet</label>
                      <Combobox
                        options={outletOptions}
                        value={form.home_outlet_id ? (outlets.find(o => o.id === form.home_outlet_id)?.name || '') : ''}
                        onChange={(v) => setForm({ ...form, home_outlet_id: v })}
                        placeholder="Pick outlet"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-[#8B7355]">
                    Photo, addresses, emergency contact, login link and everything else are added on the
                    employee&apos;s profile after saving.
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowCreate(false)} disabled={saving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
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
