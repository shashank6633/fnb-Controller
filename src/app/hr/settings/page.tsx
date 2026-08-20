'use client';

/**
 * HR Settings — Designations master + Attendance engine knobs
 * (contract: docs/HRMS_DECISIONS.md).
 *
 * Designations are a soft-delete master (hr_designations.is_active) — rows are
 * never removed because employees keep referencing them. Reads are
 * management-tier; MUTATIONS ARE ADMIN-ONLY server-side, so this page surfaces
 * the 403 as friendly copy instead of pretending the buttons will work.
 *
 * The list is GROUPED BY MAIN DEPARTMENT (a designation pinned to a
 * sub-department is shown under that sub-department's main, matching how the
 * employee pickers filter), mains A-Z with 'Any department' last, so an admin
 * can see at a glance which department each job title belongs to.
 *
 * Attendance engine card → GET/PUT /api/hr/settings (§8.2): business-day
 * cutoff (hr_day_cutoff, HH:MM IST — a punch before the cutoff belongs to the
 * PREVIOUS attendance day) and punch debounce minutes
 * (hr_punch_debounce_min). GET is management-tier, PUT is admin-only.
 *
 * Shift templates and Leave types are managed on their own live pages
 * (/hr/shifts, /hr/leave) — this page just links there.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarRange,
  Clock3,
  Edit,
  Info,
  Loader2,
  Palmtree,
  Plus,
  Save,
  Settings2,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import Combobox, { type ComboOption } from '@/components/Combobox';
import type { HrDesignation } from '@/lib/hr';

/** GET rows may carry an optional employee_count if the API computes it cheaply. */
interface DesignationRow extends HrDesignation {
  employee_count?: number | null;
}

interface Dept {
  id: string;
  name: string;
  parent_id: string | null;
  parent_name: string | null;
  is_active: number;
}

/** One rendered block of the designations table: every designation that belongs
 *  to one MAIN department (or the trailing 'Any department' block). */
interface DesignationGroup {
  key: string;
  label: string;
  /** The 'Any department' (generic) block — always sorted last. */
  isAny: boolean;
  rows: DesignationRow[];
}

const emptyDesignation = (): Partial<DesignationRow> => ({ name: '', department_id: '', grade: '', is_active: 1 });

export default function HrSettingsPage() {
  const [designations, setDesignations] = useState<DesignationRow[] | null>(null);
  const [departments, setDepartments] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [editing, setEditing] = useState<Partial<DesignationRow> | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Bare fetch for GETs; departments failing must not kill the page (the
      // hint picker just degrades), so it gets its own catch.
      const [dRes, deptRes] = await Promise.all([
        fetch('/api/hr/designations?include_inactive=1'),
        fetch('/api/departments').catch(() => null),
      ]);
      const dJson = await dRes.json().catch(() => null);
      if (!dRes.ok) {
        setError(
          dJson?.error ||
            (dRes.status === 403
              ? 'HR Settings is admin-only.'
              : 'Could not load designations.'),
        );
        setDesignations(null);
        return;
      }
      setDesignations(Array.isArray(dJson?.designations) ? dJson.designations : []);
      if (deptRes && deptRes.ok) {
        const deptJson = await deptRes.json().catch(() => null);
        setDepartments(Array.isArray(deptJson?.departments) ? deptJson.departments : []);
      }
    } catch {
      setError('Could not load designations. Check your connection and retry.');
      setDesignations(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deptNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of departments) m.set(d.id, d.name);
    return m;
  }, [departments]);

  const deptOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: 'None (any department)' },
      ...departments
        .filter((d) => d.is_active)
        .map((d) => ({ value: d.id, label: d.name, hint: d.parent_name || 'Main' })),
    ],
    [departments],
  );

  const visible = useMemo(() => {
    const list = designations || [];
    return showInactive ? list : list.filter((d) => d.is_active);
  }, [designations, showInactive]);

  /** Column shows only when the API actually computed counts. */
  const hasCounts = useMemo(() => (designations || []).some((d) => d.employee_count != null), [designations]);

  /**
   * Group the visible designations by MAIN department — the same tree rule the
   * employee pickers use: a designation pinned to a sub-department belongs to
   * that sub-department's main (departments.parent_id), so "Kitchen" and
   * "Hot Kitchen" designations sit in one block. Order: mains A-Z, then any
   * dangling department, then 'Any department' (generic) last. Row order
   * INSIDE a group is untouched (the API's is_active DESC, name ASC).
   */
  const groups = useMemo<DesignationGroup[]>(() => {
    const byId = new Map(departments.map((d) => [d.id, d]));
    const map = new Map<string, DesignationGroup>();
    for (const d of visible) {
      let key = '';
      let label = 'Any department';
      if (d.department_id) {
        const dept = byId.get(d.department_id);
        const main = dept ? (dept.parent_id ? byId.get(dept.parent_id) || dept : dept) : null;
        if (main) {
          key = main.id;
          label = main.name;
        } else {
          // Departments failed to load, or the department was removed — never
          // hide the designation, just park it in its own block.
          key = 'unknown';
          label = 'Unknown department';
        }
      }
      let g = map.get(key);
      if (!g) {
        g = { key, label, isAny: key === '', rows: [] };
        map.set(key, g);
      }
      g.rows.push(d);
    }
    return [...map.values()].sort((a, b) => {
      if (a.isAny !== b.isAny) return a.isAny ? 1 : -1;
      const aUnknown = a.key === 'unknown';
      const bUnknown = b.key === 'unknown';
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }, [visible, departments]);

  /** colSpan for the group heading rows — keep in step with the header cells. */
  const columnCount = hasCounts ? 6 : 5;

  const friendly = (status: number, serverMsg: string | undefined, fallback: string): string => {
    if (status === 403) return 'Only admins can change designations — ask an admin to make this change.';
    if (status === 409) return serverMsg || 'A designation with this name already exists.';
    return serverMsg || fallback;
  };

  const save = async () => {
    if (!editing) return;
    const name = String(editing.name || '').trim();
    if (!name) {
      setModalError('Name is required.');
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      const isNew = !editing.id;
      const body = isNew
        ? { name, department_id: editing.department_id || '', grade: String(editing.grade || '').trim() }
        : { id: editing.id, name, department_id: editing.department_id || '', grade: String(editing.grade || '').trim() };
      const r = await api('/api/hr/designations', { method: isNew ? 'POST' : 'PUT', body });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setModalError(friendly(r.status, j?.error, 'Could not save the designation. Try again.'));
        return;
      }
      setEditing(null);
      load();
    } catch {
      setModalError('Could not save the designation. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (d: DesignationRow, next: boolean) => {
    if (!next) {
      const ok = confirm(
        `Deactivate "${d.name}"?\n\nEmployees who already hold it keep it on their profile — it only stops appearing in pickers. You can reactivate it any time.`,
      );
      if (!ok) return;
    }
    setTogglingId(d.id);
    setActionError(null);
    try {
      // Reactivate = PUT is_active; deactivate = soft DELETE. The id rides in
      // BOTH the query string and the body so either house convention matches.
      const r = next
        ? await api('/api/hr/designations', { method: 'PUT', body: { id: d.id, is_active: 1 } })
        : await api(`/api/hr/designations?id=${encodeURIComponent(d.id)}`, { method: 'DELETE', body: { id: d.id } });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setActionError(friendly(r.status, j?.error, 'Could not update the designation.'));
      }
      load();
    } catch {
      setActionError('Could not update the designation. Check your connection and try again.');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Settings2 className="w-6 h-6" /> HR Settings
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Designations master and the attendance engine rules. Shifts and leave types live on their own pages.
            </p>
          </div>
          <button
            onClick={() => {
              setModalError(null);
              setEditing(emptyDesignation());
            }}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Designation
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </span>
            <button
              onClick={load}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
            >
              Retry
            </button>
          </div>
        )}

        {actionError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {actionError}
            </span>
            <button onClick={() => setActionError(null)} className="text-red-700 shrink-0" title="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Designations */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E8D5C4] flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
                <BadgeCheck className="w-5 h-5 text-[#af4408]" /> Designations
                <span className="text-xs font-normal text-[#8B7355]">
                  job titles for the employee master — mutations are admin-only
                </span>
              </h2>
              {/* The rule the employee pickers now follow — stated once, here. */}
              <p className="text-xs text-[#8B7355] mt-1 max-w-3xl">
                A designation attached to a department is offered first for employees in that department (including its
                sub-departments); &ldquo;Any department&rdquo; designations are offered everywhere. Pickers keep a
                &ldquo;Show all designations&rdquo; link, so an unusual assignment is never blocked.
              </p>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744] shrink-0">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
          </div>

          {loading && !designations ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading...
            </div>
          ) : !designations ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">Designations could not be loaded.</div>
          ) : visible.length === 0 ? (
            <p className="p-8 text-center text-sm text-[#8B7355]">
              {designations.length === 0
                ? 'No designations yet — add the first one and it appears in the employee form.'
                : 'No active designations — tick "Show inactive" to see the rest.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">Name</th>
                    {/* The exact department pinned on the row — the group heading
                        above it names the MAIN department that row falls under. */}
                    <th className="text-left py-2 px-3 font-medium">Department</th>
                    <th className="text-left py-2 px-3 font-medium">Grade</th>
                    {hasCounts && <th className="text-right py-2 px-3 font-medium">Employees</th>}
                    <th className="text-left py-2 px-3 font-medium">Active</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.key || 'any'}>
                    {/* Group heading — which department these job titles serve. */}
                    <tr className="bg-[#FFF1E3]/70 border-t border-[#E8D5C4]">
                      <td colSpan={columnCount} className="py-1.5 px-3">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355]">
                          {g.label}
                        </span>
                        <span className="ml-2 text-[11px] text-[#8B7355]">
                          {g.rows.length} {g.rows.length === 1 ? 'designation' : 'designations'}
                        </span>
                        {g.isAny && (
                          <span className="ml-2 text-[11px] text-[#8B7355]">— offered to every employee</span>
                        )}
                      </td>
                    </tr>
                    {g.rows.map((d) => (
                      <tr
                        key={d.id}
                        className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] ${!d.is_active ? 'opacity-50' : ''}`}
                      >
                        <td className="py-2 px-3 font-medium text-[#2D1B0E]">{d.name}</td>
                        <td className="py-2 px-3 text-xs text-[#6B5744]">
                          {d.department_id ? (
                            deptNameById.get(d.department_id) || (
                              <span className="text-[#8B7355]">Unknown department</span>
                            )
                          ) : (
                            <span className="text-[#8B7355]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-xs text-[#6B5744]">
                          {d.grade || <span className="text-[#8B7355]">—</span>}
                        </td>
                        {hasCounts && (
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744]">
                            {d.employee_count != null ? d.employee_count : '—'}
                          </td>
                        )}
                        <td className="py-2 px-3">
                          <Toggle
                            size="sm"
                            checked={!!d.is_active}
                            disabled={togglingId === d.id}
                            onChange={(next) => setActive(d, next)}
                            label={d.is_active ? `Deactivate ${d.name}` : `Reactivate ${d.name}`}
                          />
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            onClick={() => {
                              setModalError(null);
                              setEditing({ ...d });
                            }}
                            className="p-1 text-[#6B5744] hover:text-[#af4408]"
                            title="Edit"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </div>

        {/* About access */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
          <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2 mb-2">
            <Info className="w-5 h-5 text-[#af4408]" /> About access
          </h3>
          <p className="text-sm text-[#6B5744]">
            This settings page is admin-only via its page-catalog flag — page grants cannot open it to non-admins.
            Managers and HODs still see designations where they matter: inside the employee pages and pickers, which
            are management-tier. Grants for those pages live in{' '}
            <a href="/settings/page-access" className="text-[#af4408] hover:underline">Settings → Page Access</a>.
          </p>
        </div>

        {/* Attendance engine knobs — GET/PUT /api/hr/settings (§8.2). */}
        <AttendanceEngineCard />

        {/* Shifts and leave types are LIVE on their own pages — link there. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <a
            href="/hr/shifts"
            className="border border-[#E8D5C4] bg-white rounded-xl p-5 shadow hover:border-[#af4408] hover:bg-[#FFF1E3] transition-colors block"
          >
            <div className="flex items-center gap-2 mb-1.5 text-[#af4408]">
              <CalendarRange className="w-5 h-5" />
              <span className="text-sm font-medium text-[#2D1B0E]">Shift templates</span>
            </div>
            <p className="text-xs text-[#8B7355]">
              Split and overnight shift definitions the roster computes against — managed on the Shifts page.
            </p>
          </a>
          <a
            href="/hr/leave"
            className="border border-[#E8D5C4] bg-white rounded-xl p-5 shadow hover:border-[#af4408] hover:bg-[#FFF1E3] transition-colors block"
          >
            <div className="flex items-center gap-2 mb-1.5 text-[#af4408]">
              <Palmtree className="w-5 h-5" />
              <span className="text-sm font-medium text-[#2D1B0E]">Leave types</span>
            </div>
            <p className="text-xs text-[#8B7355]">
              Leave vocabularies, balances and the request/approval flow — managed on the Leave page.
            </p>
          </a>
        </div>

        {/* Add / edit modal */}
        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Designation' : 'New Designation'}</h2>
                <button onClick={() => setEditing(null)} className="text-[#8B7355]" title="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input
                    value={editing.name || ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="e.g. Sous Chef"
                    className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Department</label>
                  {/* Portaled Combobox — a plain absolute dropdown would clip inside this modal. */}
                  <Combobox
                    options={deptOptions}
                    value={
                      editing.department_id
                        ? deptNameById.get(editing.department_id) || 'Unknown department'
                        : 'None (any department)'
                    }
                    onChange={(v, opt) => {
                      if (opt) setEditing({ ...editing, department_id: opt.value });
                    }}
                    placeholder="Pick a department..."
                  />
                  <p className="text-[10px] text-[#8B7355] mt-1">
                    Employee pickers offer this designation first to that department and its sub-departments. It is a
                    default, not a restriction — &ldquo;Show all designations&rdquo; still lists it for anyone, and an
                    employee who already holds it never loses it. Leave it on &ldquo;None (any department)&rdquo; for
                    titles like Manager or Trainee that belong everywhere.
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Grade</label>
                  <input
                    value={editing.grade || ''}
                    onChange={(e) => setEditing({ ...editing, grade: e.target.value })}
                    placeholder="e.g. G3 (optional)"
                    className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                  />
                </div>
                {modalError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" /> {modalError}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
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

/* ── page-local helpers ─────────────────────────────────────────────────── */

/**
 * Attendance engine settings — the two §8.2 knobs, wired to /api/hr/settings.
 * GET is management-tier (values shown are the EFFECTIVE ones the pairing
 * engine reads); PUT is admin-only server-side, so a manager's Save gets the
 * friendly 403 copy — same pattern as the designations mutations above.
 */
function AttendanceEngineCard() {
  const [cutoff, setCutoff] = useState('');
  const [debounce, setDebounce] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Bare fetch is fine for GETs (CSRF header is only for mutations).
        const r = await fetch('/api/hr/settings');
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.settings) {
          setLoadFailed(true);
          return;
        }
        setCutoff(String(j.settings.hr_day_cutoff || '04:00'));
        setDebounce(String(j.settings.hr_punch_debounce_min ?? 3));
        setLoaded(true);
      } catch {
        setLoadFailed(true);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setErr(null);
    try {
      const r = await api('/api/hr/settings', {
        method: 'PUT',
        body: { hr_day_cutoff: cutoff, hr_punch_debounce_min: debounce },
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(
          r.status === 403
            ? 'Only admins can change the attendance engine settings — ask an admin to make this change.'
            : j?.error || 'Could not save the settings. Try again.',
        );
        return;
      }
      if (j?.settings) {
        setCutoff(String(j.settings.hr_day_cutoff));
        setDebounce(String(j.settings.hr_punch_debounce_min));
      }
      setSaved(true);
    } catch {
      setErr('Could not save the settings. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
      <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2 mb-1">
        <Clock3 className="w-5 h-5 text-[#af4408]" /> Attendance engine
        <span className="text-xs font-normal text-[#8B7355]">changes are admin-only</span>
      </h3>
      <p className="text-xs text-[#8B7355] mb-4">
        The business-day cutoff decides which attendance day a punch belongs to: anything BEFORE the cutoff counts as
        the previous day — so with an 04:00 cutoff, a 1 AM checkout belongs to yesterday&apos;s shift. The debounce
        window treats repeat punches within it as duplicates (kept, marked ignored).
      </p>
      {loadFailed ? (
        <p className="text-sm text-[#8B7355]">The attendance settings could not be loaded — reload the page to retry.</p>
      ) : !loaded ? (
        <p className="text-sm text-[#8B7355]">
          <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
            <div>
              <label className="text-xs text-[#6B5744]">Business-day cutoff (IST)</label>
              <input
                type="time"
                value={cutoff}
                onChange={(e) => setCutoff(e.target.value)}
                className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
              />
              <p className="text-[10px] text-[#8B7355] mt-1">Punches before this time belong to the previous day.</p>
            </div>
            <div>
              <label className="text-xs text-[#6B5744]">Punch debounce (minutes)</label>
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={debounce}
                onChange={(e) => setDebounce(e.target.value)}
                className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
              />
              <p className="text-[10px] text-[#8B7355] mt-1">Repeat punches inside this window are duplicates.</p>
            </div>
          </div>
          {err && (
            <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {err}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
            {saved && <span className="text-xs text-green-700">Saved — future punches use the new values.</span>}
          </div>
        </>
      )}
    </div>
  );
}
