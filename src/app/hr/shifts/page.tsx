'use client';

/**
 * HR — Shift Templates (Phase 3).
 *
 * Contract: docs/HRMS_DECISIONS.md §8.2.6 — templates support OVERNIGHT spans
 * (end < start ⇒ the shift crosses midnight; rendered '18:00 → 03:00 (+1d)',
 * never a validation error) and SPLIT definitions (extra [start, end] windows
 * stored in split_json — the venue's own day is 09:30-15:00 + 18:30-01:00).
 *
 * Structure copied from the canonical CRUD page (src/app/vendors/page.tsx).
 * The page is mgmtOnly (viewing); MUTATIONS ARE ADMIN — a manager/HOD sees the
 * list but a create/edit/toggle gets the API's honest 403 message surfaced,
 * never a silent failure. API: /api/hr/shifts (GET { shifts }, POST/PUT
 * { shift }, all validation server-side; this page mirrors it client-side
 * only for friendlier messages).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Plus, Search, Edit, X, Loader2, Save } from 'lucide-react';
import { apiJson } from '@/lib/api';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import { type HrShift } from '@/lib/hr';

interface DeptRow { id: string; name: string; parent_id: string | null; is_active: number }

/** One split-window row in the editor ('' = not yet filled). */
interface WindowRow { start: string; end: string }

interface ShiftForm {
  id?: string;
  name: string;
  start_hhmm: string;
  end_hhmm: string;
  /** EXTRA windows beyond the main span (→ split_json). */
  windows: WindowRow[];
  break_minutes: string;
  grace_minutes: string;
  late_after_minutes: string;
  early_out_before_minutes: string;
  overtime_after_minutes: string;
  department_id: string;
}

/** Defaults mirror the hr_shifts column defaults in db.ts. */
const emptyForm = (): ShiftForm => ({
  name: '', start_hhmm: '09:00', end_hhmm: '18:00', windows: [],
  break_minutes: '0', grace_minutes: '10', late_after_minutes: '15',
  early_out_before_minutes: '15', overtime_after_minutes: '30', department_id: '',
});

/** Overnight test — end < start means the window crosses midnight (§8.2.6).
 *  Plain string compare is correct for zero-padded 24h 'HH:MM'. */
const isOvernight = (start: string, end: string) => !!start && !!end && end < start;

/** '18:00 → 03:00 (+1d)' — the house rendering for a shift window. */
const fmtWindow = (start: string, end: string) =>
  `${start} → ${end}${isOvernight(start, end) ? ' (+1d)' : ''}`;

/** Tolerant split_json parse — bad JSON degrades to no extra windows, never a crash. */
function parseSplit(json: string): [string, string][] {
  try {
    const arr = JSON.parse(json || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (w): w is [string, string] =>
        Array.isArray(w) && w.length === 2 && typeof w[0] === 'string' && typeof w[1] === 'string',
    );
  } catch { return []; }
}

/** Non-negative integer from a form field; garbage → 0 (mirrors the API's int0). */
const toInt = (v: string) => Math.max(0, parseInt(v, 10) || 0);

export default function HrShiftsPage() {
  const [shifts, setShifts] = useState<HrShift[]>([]);
  const [departments, setDepartments] = useState<DeptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);        // list load failure (Retry)
  const [actionError, setActionError] = useState<string | null>(null); // toggle failures (e.g. 403)

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [editing, setEditing] = useState<ShiftForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/hr/shifts?include_inactive=1');
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view shift templates.'
          : "Couldn't load shifts");
        return;
      }
      const json = await res.json();
      setShifts(Array.isArray(json?.shifts) ? json.shifts : []);
    } catch {
      setError("Couldn't load shifts");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Department names for the hint column + the modal picker (LEFT-JOIN style:
  // a dangling department_id degrades to '—', never drops the row).
  useEffect(() => {
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setDepartments(Array.isArray(j?.departments) ? j.departments : []))
      .catch(() => {});
  }, []);

  const deptById = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const mains = useMemo(
    () => departments.filter(d => !d.parent_id && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const subsOf = useCallback(
    (parentId: string) =>
      departments.filter(d => d.parent_id === parentId && d.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [departments],
  );
  const deptOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: '(none)' }];
    for (const m of mains) {
      opts.push({ value: m.id, label: m.name });
      for (const s of subsOf(m.id)) opts.push({ value: s.id, label: s.name, hint: m.name });
    }
    return opts;
  }, [mains, subsOf]);

  const filtered = useMemo(() => {
    let l = shifts;
    if (!showInactive) l = l.filter(s => s.is_active);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      l = l.filter(s => s.name.toLowerCase().includes(q));
    }
    return l;
  }, [shifts, search, showInactive]);

  // ── Active toggle (table) — admin-only on the server; surface 403 honestly ──
  const toggleActive = async (sh: HrShift, next: boolean) => {
    setTogglingId(sh.id);
    setActionError(null);
    try {
      const res = await apiJson<{ shift: HrShift }>('/api/hr/shifts', {
        method: 'PUT',
        body: { id: sh.id, is_active: next },
      });
      setShifts(prev => prev.map(s => (s.id === res.shift.id ? res.shift : s)));
    } catch (e: any) {
      // e.message is the API's own error ('Admin role required' on 403).
      setActionError(e?.message || 'Could not update the shift');
    } finally {
      setTogglingId(null);
    }
  };

  // ── Create / edit modal ─────────────────────────────────────────────────
  const openCreate = () => { setEditing(emptyForm()); setFormError(null); };
  const openEdit = (sh: HrShift) => {
    setEditing({
      id: sh.id,
      name: sh.name,
      start_hhmm: sh.start_hhmm,
      end_hhmm: sh.end_hhmm,
      windows: parseSplit(sh.split_json).map(([start, end]) => ({ start, end })),
      break_minutes: String(sh.break_minutes),
      grace_minutes: String(sh.grace_minutes),
      late_after_minutes: String(sh.late_after_minutes),
      early_out_before_minutes: String(sh.early_out_before_minutes),
      overtime_after_minutes: String(sh.overtime_after_minutes),
      department_id: sh.department_id,
    });
    setFormError(null);
  };

  const setWin = (i: number, patch: Partial<WindowRow>) => {
    if (!editing) return;
    setEditing({
      ...editing,
      windows: editing.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)),
    });
  };

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setFormError('Shift name is required.'); return; }
    if (!editing.start_hhmm || !editing.end_hhmm) {
      setFormError('Start and end times are required.');
      return;
    }
    // Split windows: fully blank rows are dropped; a half-filled row is a mistake.
    const windows = editing.windows.filter(w => w.start || w.end);
    if (windows.some(w => !w.start || !w.end)) {
      setFormError('Each split window needs both a start and an end time (or remove the row).');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const body = {
        ...(editing.id ? { id: editing.id } : {}),
        name,
        start_hhmm: editing.start_hhmm,
        end_hhmm: editing.end_hhmm,
        split_json: windows.map(w => [w.start, w.end]),
        break_minutes: toInt(editing.break_minutes),
        grace_minutes: toInt(editing.grace_minutes),
        late_after_minutes: toInt(editing.late_after_minutes),
        early_out_before_minutes: toInt(editing.early_out_before_minutes),
        overtime_after_minutes: toInt(editing.overtime_after_minutes),
        department_id: editing.department_id,
      };
      await apiJson('/api/hr/shifts', { method: editing.id ? 'PUT' : 'POST', body });
      setEditing(null);
      load();
    } catch (e: any) {
      // Honest server message — 'Admin role required' (403), duplicate-name 409, etc.
      setFormError(e?.message || 'Could not save the shift');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <CalendarClock className="w-6 h-6" /> Shifts
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Shift templates for rosters &amp; attendance. Overnight spans (end past midnight, shown as +1d)
              and split shifts are supported. Creating and editing needs the admin role.
            </p>
          </div>
          <button onClick={openCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> New Shift
          </button>
        </div>

        {/* Load error */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={load}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Mutation error (e.g. a manager hitting the admin-only toggle) */}
        {actionError && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} className="shrink-0 text-red-700" title="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#8B7355]" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Shift name…"
                   className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
          </div>
          <label className="flex items-center gap-1 text-xs text-[#6B5744]">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <span className="text-xs text-[#8B7355]">{filtered.length} of {shifts.length}</span>
        </div>

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {search || showInactive ? 'No shifts match.' : 'No shift templates yet — create the first one.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left  py-2 px-3 font-medium">Name</th>
                    <th className="text-left  py-2 px-3 font-medium">Timing</th>
                    <th className="text-right py-2 px-3 font-medium">Break</th>
                    <th className="text-right py-2 px-3 font-medium">Grace</th>
                    <th className="text-right py-2 px-3 font-medium">Late after</th>
                    <th className="text-right py-2 px-3 font-medium">OT after</th>
                    <th className="text-left  py-2 px-3 font-medium">Department</th>
                    <th className="text-left  py-2 px-3 font-medium">Active</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(sh => {
                    const splits = parseSplit(sh.split_json);
                    return (
                      <tr key={sh.id}
                          className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${!sh.is_active ? 'opacity-50' : ''}`}>
                        <td className="py-2 px-3 text-xs font-medium">{sh.name}</td>
                        <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">
                          {fmtWindow(sh.start_hhmm, sh.end_hhmm)}
                          {splits.map(([ws, we], i) => (
                            <div key={i} className="text-[11px] text-[#8B7355]">
                              {fmtWindow(ws, we)}
                            </div>
                          ))}
                          {splits.length > 0 && (
                            <div className="font-sans text-[10px] text-[#8B7355]">split shift</div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {sh.break_minutes ? `${sh.break_minutes}m` : <span className="text-[#8B7355]">—</span>}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {sh.grace_minutes ? `${sh.grace_minutes}m` : <span className="text-[#8B7355]">—</span>}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {sh.late_after_minutes ? `${sh.late_after_minutes}m` : <span className="text-[#8B7355]">—</span>}
                        </td>
                        <td className="py-2 px-3 text-xs text-right font-mono">
                          {sh.overtime_after_minutes ? `${sh.overtime_after_minutes}m` : <span className="text-[#8B7355]">—</span>}
                        </td>
                        <td className="py-2 px-3 text-xs">
                          {(sh.department_id && deptById.get(sh.department_id)?.name) || <span className="text-[#8B7355]">—</span>}
                        </td>
                        <td className="py-2 px-3">
                          <Toggle
                            size="sm"
                            checked={!!sh.is_active}
                            disabled={togglingId === sh.id}
                            onChange={next => toggleActive(sh, next)}
                            label={`${sh.is_active ? 'Deactivate' : 'Activate'} ${sh.name}`}
                            title={sh.is_active
                              ? 'Deactivate — hidden from pickers; roster history keeps the label (admin only)'
                              : 'Reactivate this shift (admin only)'}
                          />
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button onClick={() => openEdit(sh)} className="p-1 text-[#6B5744] hover:text-[#af4408]" title="Edit">
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Create / edit modal — house safe-modal shell */}
        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{editing.id ? 'Edit Shift' : 'New Shift'}</h2>
                <button onClick={() => { if (!saving) setEditing(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {formError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {formError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })}
                         placeholder="e.g. Evening Service" className={inputCls} autoFocus />
                </div>

                {/* Main window */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Start (IST) *</label>
                    <input type="time" value={editing.start_hhmm}
                           onChange={e => setEditing({ ...editing, start_hhmm: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">End (IST) *</label>
                    <input type="time" value={editing.end_hhmm}
                           onChange={e => setEditing({ ...editing, end_hhmm: e.target.value })}
                           className={inputCls} />
                    {isOvernight(editing.start_hhmm, editing.end_hhmm) && (
                      <p className="text-[11px] text-[#8B7355] mt-1">
                        Ends the next day (+1d) — overnight shifts are supported.
                      </p>
                    )}
                  </div>
                </div>

                {/* Split windows */}
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">
                    Split windows (optional)
                  </div>
                  <p className="text-[11px] text-[#8B7355]">
                    For a split shift, add the extra session(s) — e.g. main 09:30 → 15:00 plus a second
                    window 18:30 → 01:00 (+1d). Both sessions count as one attendance day.
                  </p>
                  {editing.windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="time" value={w.start} onChange={e => setWin(i, { start: e.target.value })}
                             className={`${inputCls} flex-1`} aria-label={`Split window ${i + 1} start`} />
                      <span className="text-[#8B7355] text-xs shrink-0">→</span>
                      <input type="time" value={w.end} onChange={e => setWin(i, { end: e.target.value })}
                             className={`${inputCls} flex-1`} aria-label={`Split window ${i + 1} end`} />
                      {isOvernight(w.start, w.end) && (
                        <span className="text-[10px] text-[#8B7355] shrink-0">+1d</span>
                      )}
                      <button onClick={() => setEditing({ ...editing, windows: editing.windows.filter((_, j) => j !== i) })}
                              className="p-1 text-red-500 hover:text-red-700 shrink-0" title="Remove window">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setEditing({ ...editing, windows: [...editing.windows, { start: '', end: '' }] })}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg text-xs font-medium">
                    <Plus className="w-3.5 h-3.5" /> Add window
                  </button>
                </div>

                {/* Rules */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Break (min)</label>
                    <input type="number" min={0} value={editing.break_minutes}
                           onChange={e => setEditing({ ...editing, break_minutes: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Grace (min)</label>
                    <input type="number" min={0} value={editing.grace_minutes}
                           onChange={e => setEditing({ ...editing, grace_minutes: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Late after (min)</label>
                    <input type="number" min={0} value={editing.late_after_minutes}
                           onChange={e => setEditing({ ...editing, late_after_minutes: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Early out before (min)</label>
                    <input type="number" min={0} value={editing.early_out_before_minutes}
                           onChange={e => setEditing({ ...editing, early_out_before_minutes: e.target.value })}
                           className={inputCls} />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Overtime after (min)</label>
                    <input type="number" min={0} value={editing.overtime_after_minutes}
                           onChange={e => setEditing({ ...editing, overtime_after_minutes: e.target.value })}
                           className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Department (hint)</label>
                  <Combobox
                    options={deptOptions}
                    value={editing.department_id ? (deptById.get(editing.department_id)?.name || '') : ''}
                    onChange={v => setEditing({ ...editing, department_id: v })}
                    placeholder="Any department"
                  />
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    A picker hint only — the shift can still be rostered to anyone.
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setEditing(null)} disabled={saving}
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
