'use client';

/**
 * ROSTER CONFIG editor — the two tables nothing in the app could write before.
 *
 * On production every generate refuses with no_coverage + no_shift_map, so this
 * modal is the real unblocker, not the Generate button.
 *
 *  · COVERAGE — min_present per designation per weekday per shift role. It is a
 *    FLOOR (owner rule 3, verbatim: "minimum present per group per day"), and
 *    there is deliberately NO max-offs field anywhere on this screen. A cap of
 *    "2 offs" silently becomes a different promise every week as people join and
 *    leave; a floor of "6 present" stays the promise the owner made.
 *
 *  · SHIFT MAP — (shift_role, weekday) → hr_shifts.id. Every weekday needs a row,
 *    SUNDAY INCLUDED, and Sunday must point at its OWN shifts: the owner's Sunday
 *    timings differ (MOR BREAK 11:00-16:00 + 19:30-close, SECOND 14:00-close).
 *    hr_shifts has no weekday dimension, so this map is the only bridge — and an
 *    unmapped pair is a refusal from the generator, never a substitution, because
 *    substituting is exactly how Sunday's 19:30 becomes the weekday 18:30 and
 *    staff turn up ninety minutes early.
 *
 * SHIFT ROLES ARE THE OWNER'S WORDS (MS, M 2 C, MOR BREAK, SECOND, NIGHT), typed
 * freely and suggested from what is already configured — this screen never
 * invents a vocabulary, exactly as it never invents a department or designation.
 *
 * A save is an UPSERT of the rows entered; it never replaces the department's
 * whole configuration, so a half-filled form cannot wipe a configured week.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Save, Trash2, X } from 'lucide-react';
import { apiJson } from '@/lib/api';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import { WEEKDAY_LONG, WEEKDAY_SHORT } from './roster-plan';

interface CoverageRow {
  id: string;
  department_id: string;
  designation_id: string;
  designation_name: string;
  weekday: number;
  shift_role: string;
  min_present: number;
  note: string;
  updated_by: string;
  inherited: number;
}

interface MapRow {
  id: string;
  department_id: string;
  shift_role: string;
  weekday: number;
  shift_id: string;
  shift_name: string;
  shift_start_hhmm: string;
  shift_end_hhmm: string;
  shift_split_json: string;
  shift_is_active: number | null;
  inherited: number;
}

interface DesignationRow { id: string; name: string; headcount: number }
interface ShiftRow {
  id: string; name: string; start_hhmm: string; end_hhmm: string; split_json: string; is_active: number;
}

interface Props {
  departmentId: string;
  departmentLabel: string;
  initialTab: 'coverage' | 'map';
  /** False when the signed-in user is not an HR admin — the API refuses the
   *  write regardless; this only stops offering a button that cannot work. */
  canWrite: boolean;
  onClose: () => void;
  /** Called after a successful save so readiness re-measures. */
  onSaved: () => void;
}

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
const numCls = 'w-16 px-1.5 py-1 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm text-right';

function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'HR admin access is required to change this.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

/** '11:00–15:30 +1d · split' for a shift option hint. */
function shiftHint(s: ShiftRow | undefined): string {
  if (!s) return '';
  let out = `${s.start_hhmm}–${s.end_hhmm}${s.end_hhmm < s.start_hhmm ? ' +1d' : ''}`;
  try {
    const w = JSON.parse(s.split_json || '[]');
    if (Array.isArray(w) && w.length) out += ` + ${w.map((p: string[]) => `${p[0]}–${p[1]}`).join(', ')}`;
  } catch { /* an unparseable split_json simply shows no extra window */ }
  return out;
}

export default function RosterConfigModal({
  departmentId,
  departmentLabel,
  initialTab,
  canWrite,
  onClose,
  onSaved,
}: Props) {
  const [tab, setTab] = useState<'coverage' | 'map'>(initialTab);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [shiftMap, setShiftMap] = useState<MapRow[]>([]);
  const [designations, setDesignations] = useState<DesignationRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);

  /* ── Coverage draft: one designation + role, seven weekday floors. ─────────
       Seven rows at a time, because the generator needs a floor to RESOLVE on
       every weekday it places an off on, and entering them one at a time is how
       Thursday quietly gets left out. ─────────────────────────────────────── */
  const [covDesig, setCovDesig] = useState('');     // '' = whole department
  const [covRole, setCovRole] = useState('');       // '' = the day TOTAL
  const [covFloors, setCovFloors] = useState<string[]>(['', '', '', '', '', '', '']);

  /* ── Shift-map draft: one role, seven weekday shifts. ─────────────────── */
  const [mapRole, setMapRole] = useState('');
  const [mapShiftIds, setMapShiftIds] = useState<string[]>(['', '', '', '', '', '', '']);

  const load = useCallback(async () => {
    setError(null);
    try {
      const json = await apiJson<{
        coverage: CoverageRow[]; shift_map: MapRow[];
        designations: DesignationRow[]; shifts: ShiftRow[]; roles: string[];
      }>(`/api/hr/roster/config?department_id=${encodeURIComponent(departmentId)}`);
      setCoverage(json.coverage ?? []);
      setShiftMap(json.shift_map ?? []);
      setDesignations(json.designations ?? []);
      setShifts(json.shifts ?? []);
      setRoles(json.roles ?? []);
    } catch (e) {
      setError(niceErr(e, "Couldn't load the roster configuration"));
    } finally {
      setLoading(false);
    }
  }, [departmentId]);

  useEffect(() => { load(); }, [load]);

  const shiftById = useMemo(() => new Map(shifts.map(s => [s.id, s])), [shifts]);

  const desigOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: 'Whole department', hint: 'the day total across every designation' },
      ...designations.map(d => ({
        value: d.id,
        label: d.name,
        hint: d.headcount ? `${d.headcount} here` : 'nobody here yet',
      })),
    ],
    [designations],
  );
  const roleOptions = useMemo<ComboOption[]>(
    () => roles.map(r => ({ value: r, label: r })),
    [roles],
  );
  const shiftOptions = useMemo<ComboOption[]>(
    () => shifts.map(s => ({ value: s.id, label: s.name, hint: shiftHint(s) })),
    [shifts],
  );

  /** Roles already mapped for this department, each with the weekdays it covers —
   *  so a gap (SUNDAY especially) is visible rather than inferred. */
  const mappedRoles = useMemo(() => {
    const m = new Map<string, MapRow[]>();
    for (const r of shiftMap) {
      const list = m.get(r.shift_role);
      if (list) list.push(r); else m.set(r.shift_role, [r]);
    }
    return [...m.entries()]
      .map(([role, rows]) => {
        const byDay = new Map<number, MapRow>();
        // Own rows win over the inherited '' default, exactly as the generator
        // resolves them (the API already orders inherited first).
        for (const r of rows) byDay.set(r.weekday, r);
        const missing: number[] = [];
        for (let wd = 0; wd <= 6; wd++) if (!byDay.has(wd)) missing.push(wd);
        const sunday = byDay.get(0);
        const weekdaySample = byDay.get(1) ?? byDay.get(2) ?? byDay.get(3);
        return {
          role,
          byDay,
          missing,
          /** Sunday resolving to the SAME shift as a weekday is the silent
           *  19:30→18:30 trap. Not refused (MS and NIGHT may legitimately match),
           *  but never left unsaid. */
          sundaySameAsWeekday:
            !!sunday && !!weekdaySample && sunday.shift_id === weekdaySample.shift_id,
        };
      })
      .sort((a, b) => a.role.localeCompare(b.role));
  }, [shiftMap]);

  const removeRow = async (kind: 'coverage' | 'shift_map', id: string, label: string) => {
    if (!window.confirm(`Remove ${label}? The generator will name it as missing on the next run.`)) return;
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/api/hr/roster/config?kind=${kind}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
      onSaved();
    } catch (e) {
      setError(niceErr(e, 'Could not remove that row'));
    }
  };

  const saveCoverage = async () => {
    const rows = covFloors
      .map((v, wd) => ({ wd, raw: v.trim() }))
      .filter(x => x.raw !== '')
      .map(x => ({
        designation_id: covDesig,
        weekday: x.wd,
        shift_role: covRole,
        min_present: Number(x.raw),
      }));
    if (!rows.length) { setError('Enter a minimum-present figure for at least one weekday.'); return; }
    if (rows.some(r => !Number.isFinite(r.min_present) || r.min_present < 0)) {
      setError('A minimum present must be 0 or more.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson('/api/hr/roster/config', {
        method: 'PUT',
        body: { department_id: departmentId, coverage: rows },
      });
      setNotice(`Saved ${rows.length} coverage floor${rows.length === 1 ? '' : 's'}.`);
      setCovFloors(['', '', '', '', '', '', '']);
      await load();
      onSaved();
    } catch (e) {
      setError(niceErr(e, 'Could not save the coverage floors'));
    } finally {
      setSaving(false);
    }
  };

  const saveMap = async () => {
    const role = mapRole.trim();
    if (!role) { setError("Name the shift role — the owner's own word for it (MS, MOR BREAK, SECOND, NIGHT…)."); return; }
    const rows = mapShiftIds
      .map((shiftId, wd) => ({ shift_role: role, weekday: wd, shift_id: shiftId }))
      .filter(r => r.shift_id);
    if (!rows.length) { setError('Pick the shift for at least one weekday.'); return; }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiJson('/api/hr/roster/config', {
        method: 'PUT',
        body: { department_id: departmentId, shift_map: rows },
      });
      const gaps = 7 - rows.length;
      setNotice(
        `Mapped ${role} on ${rows.length} weekday${rows.length === 1 ? '' : 's'}.` +
        (gaps > 0
          ? ` ${gaps} weekday${gaps === 1 ? '' : 's'} still unmapped — the generator refuses an unmapped day rather than substituting another day's shift.`
          : ''),
      );
      setMapShiftIds(['', '', '', '', '', '', '']);
      await load();
      onSaved();
    } catch (e) {
      setError(niceErr(e, 'Could not save the shift map'));
    } finally {
      setSaving(false);
    }
  };

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border ${
      active
        ? 'bg-[#af4408] text-white border-[#af4408]'
        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
    }`;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 print:hidden">
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-4xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0 gap-3">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Roster configuration</h2>
            <p className="text-xs text-[#8B7355]">{departmentLabel || departmentId}</p>
          </div>
          <button onClick={() => { if (!saving) onClose(); }} className="text-[#8B7355]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-3 shrink-0">
          <TabScroller className="gap-2">
            <button onClick={() => setTab('coverage')} className={pill(tab === 'coverage')}>
              Coverage floors ({coverage.length})
            </button>
            <button onClick={() => setTab('map')} className={pill(tab === 'map')}>
              Shift map ({shiftMap.length})
            </button>
          </TabScroller>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{error}</div>
          )}
          {notice && (
            <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2 text-sm">{notice}</div>
          )}
          {!canWrite && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-sm">
              You can read this configuration but not change it — HR admin access is required.
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-[#8B7355]">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : tab === 'coverage' ? (
            <>
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-3">
                <p className="text-sm font-medium text-[#2D1B0E]">Set a minimum-present floor</p>
                <p className="text-[11px] text-[#8B7355]">
                  How many people must be <strong>present</strong> in this group on each weekday. This
                  is a floor, not a cap on offs — headcount moves with joiners, leavers and approved
                  leave, so a cap would mean something different every week. Leave a day blank to
                  leave that day&apos;s existing floor alone.
                </p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Group (designation)</label>
                    <Combobox
                      options={desigOptions}
                      value={covDesig ? (designations.find(d => d.id === covDesig)?.name || '') : 'Whole department'}
                      onChange={v => setCovDesig(v)}
                      placeholder="Whole department" />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Shift role (blank = the day total)</label>
                    <Combobox
                      options={[{ value: '', label: 'Day total (every shift)' }, ...roleOptions]}
                      value={covRole || 'Day total (every shift)'}
                      onChange={v => setCovRole(v)}
                      allowCustom
                      placeholder="Day total (every shift)" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAY_SHORT.map((label, wd) => (
                    <div key={wd} className="text-center">
                      <div className={`text-[11px] mb-0.5 ${wd === 0 || wd === 5 || wd === 6 ? 'text-[#af4408] font-medium' : 'text-[#6B5744]'}`}>
                        {label}
                      </div>
                      <input type="number" min={0} step={1} value={covFloors[wd]}
                             onChange={e => setCovFloors(f => f.map((v, i) => (i === wd ? e.target.value : v)))}
                             className={numCls} placeholder="—" />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Fri, Sat and Sun carry no offs under the owner&apos;s rule, so their floors are
                  usually full headcount; Mon–Thu are the days the generator places offs on and the
                  days a floor must resolve for.
                </p>
                {canWrite && (
                  <button onClick={saveCoverage} disabled={saving}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save floors
                  </button>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-[#2D1B0E] mb-1.5">
                  Configured floors ({coverage.length})
                </p>
                {coverage.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">
                    Nothing configured, so every generate for this department refuses with
                    <code className="mx-1 text-[11px]">no_coverage</code>. One whole-department day
                    total per weekday is enough to start.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px] min-w-[560px]">
                      <thead className="bg-[#FFF1E3]">
                        <tr>
                          <th className="text-left px-2 py-1.5 font-semibold">Group</th>
                          <th className="text-left px-2 py-1.5 font-semibold">Weekday</th>
                          <th className="text-left px-2 py-1.5 font-semibold">Shift role</th>
                          <th className="text-right px-2 py-1.5 font-semibold">Min present</th>
                          <th className="text-left px-2 py-1.5 font-semibold">Scope</th>
                          <th className="px-2 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {coverage.map(c => (
                          <tr key={c.id} className="border-t border-[#F3E7D9]">
                            <td className="px-2 py-1.5">
                              {c.designation_id ? (c.designation_name || c.designation_id) : 'Whole department'}
                            </td>
                            <td className="px-2 py-1.5">{WEEKDAY_LONG[c.weekday] ?? c.weekday}</td>
                            <td className="px-2 py-1.5">
                              {c.shift_role || <span className="text-[#C9B8A5]">day total</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-medium">{c.min_present}</td>
                            <td className="px-2 py-1.5">
                              {c.inherited
                                ? <span className="text-[11px] text-[#8B7355]">every department (default)</span>
                                : <span className="text-[11px] text-[#6B5744]">this department</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {canWrite && !c.inherited && (
                                <button
                                  onClick={() => removeRow('coverage', c.id,
                                    `the ${c.designation_id ? (c.designation_name || 'group') : 'whole-department'} floor for ${WEEKDAY_LONG[c.weekday]}`)}
                                  className="text-rose-600 hover:bg-rose-50 rounded p-1"
                                  title="Remove this floor">
                                  <Trash2 className="w-3.5 h-3.5" />
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
            </>
          ) : (
            <>
              <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-3">
                <p className="text-sm font-medium text-[#2D1B0E]">Map a shift role to a shift, per weekday</p>
                <p className="text-[11px] text-[#8B7355]">
                  Shift templates carry no weekday, and the owner&apos;s <strong>Sunday timings
                  differ</strong> — MOR BREAK runs 11:00–16:00 + 19:30–close and SECOND runs
                  14:00–close. Sunday therefore needs its own shift rows, and this map is what points
                  at them. An unmapped weekday is refused, never substituted.
                </p>
                {shifts.length === 0 && (
                  <p className="text-[13px] text-rose-700">
                    No active shift template exists yet — create them on{' '}
                    <a href="/hr/shifts" className="underline font-medium">Shifts</a> first.
                  </p>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">
                    Shift role — the owner&apos;s own word (MS, M 2 C, MOR BREAK, SECOND, NIGHT)
                  </label>
                  <Combobox options={roleOptions} value={mapRole}
                            onChange={v => setMapRole(v)} allowCustom
                            placeholder="Type the role, e.g. MOR BREAK" />
                </div>
                <div className="space-y-2">
                  {WEEKDAY_SHORT.map((label, wd) => {
                    const sel = mapShiftIds[wd];
                    return (
                      <div key={wd} className="flex items-center gap-2">
                        <span className={`w-20 text-xs shrink-0 ${wd === 0 ? 'text-[#af4408] font-semibold' : 'text-[#6B5744]'}`}>
                          {WEEKDAY_LONG[wd]}
                        </span>
                        <div className="flex-1 min-w-0">
                          <Combobox options={shiftOptions}
                                    value={sel ? (shiftById.get(sel)?.name || '') : ''}
                                    onChange={v => setMapShiftIds(ids => ids.map((x, i) => (i === wd ? v : x)))}
                                    placeholder={wd === 0 ? 'Pick the SUNDAY shift…' : 'Pick the shift…'} />
                        </div>
                        <span className="w-44 text-[11px] text-[#8B7355] shrink-0 truncate">
                          {shiftHint(shiftById.get(sel))}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {canWrite && (
                  <button onClick={saveMap} disabled={saving}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save mapping
                  </button>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-[#2D1B0E] mb-1.5">
                  Configured roles ({mappedRoles.length})
                </p>
                {mappedRoles.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">
                    Nothing mapped, so every generate for this department refuses with
                    <code className="mx-1 text-[11px]">no_shift_map</code>.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {mappedRoles.map(r => (
                      <div key={r.role} className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                        <div className="px-3 py-2 bg-[#FFF1E3] flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm">{r.role}</span>
                          {r.missing.length > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-rose-700">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              unmapped: {r.missing.map(wd => WEEKDAY_SHORT[wd]).join(', ')}
                            </span>
                          )}
                          {r.sundaySameAsWeekday && (
                            <span className="text-[11px] text-amber-700">
                              Sunday points at the same shift as the weekdays — check that this role
                              really has no different Sunday timing.
                            </span>
                          )}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px] min-w-[520px]">
                            <tbody>
                              {Array.from({ length: 7 }, (_, wd) => wd).map(wd => {
                                const row = r.byDay.get(wd);
                                return (
                                  <tr key={wd} className="border-t border-[#F3E7D9]">
                                    <td className={`px-3 py-1.5 w-28 ${wd === 0 ? 'text-[#af4408] font-medium' : ''}`}>
                                      {WEEKDAY_LONG[wd]}
                                    </td>
                                    <td className="px-2 py-1.5">
                                      {row ? (
                                        <>
                                          <span className={row.shift_is_active === 0 ? 'opacity-60' : ''}>
                                            {row.shift_name || 'Unknown shift'}
                                          </span>
                                          {row.shift_is_active === 0 && (
                                            <span className="text-[11px] text-rose-700"> · deactivated</span>
                                          )}
                                        </>
                                      ) : (
                                        <span className="text-rose-700">not mapped — the generator refuses this day</span>
                                      )}
                                    </td>
                                    <td className="px-2 py-1.5 text-[11px] text-[#8B7355] whitespace-nowrap">
                                      {row ? `${row.shift_start_hhmm}–${row.shift_end_hhmm}` : ''}
                                    </td>
                                    <td className="px-2 py-1.5 text-[11px] text-[#8B7355]">
                                      {row?.inherited ? 'default (every department)' : row ? 'this department' : ''}
                                    </td>
                                    <td className="px-2 py-1.5 text-right">
                                      {canWrite && row && !row.inherited && (
                                        <button
                                          onClick={() => removeRow('shift_map', row.id, `${r.role} on ${WEEKDAY_LONG[wd]}`)}
                                          className="text-rose-600 hover:bg-rose-50 rounded p-1"
                                          title="Remove this mapping">
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2 shrink-0">
          <p className="text-[11px] text-[#8B7355]">
            Departments, designations and shifts are read here, never created — they are the
            owner&apos;s to set.
          </p>
          <button onClick={onClose} disabled={saving}
                  className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
