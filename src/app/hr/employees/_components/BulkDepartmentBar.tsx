'use client';

/**
 * Bulk department assignment bar for the employee master list.
 *
 * WHY THIS EXISTS (Phase 0 of the duty roster). Production carries 129 employees
 * on rolls and 128 of them have no department. Nothing can be rostered by field
 * until they are classified, and the per-employee modal means 128 round trips.
 * This bar is the one place that classifies a whole filtered set at once, over
 * POST /api/hr/employees/bulk-department.
 *
 * IT ASKS BEFORE IT WRITES. The route overwrites a column and there is no undo
 * button (the audit event carries per-row before-images, which is a recovery
 * path, not an undo). So the Assign button only opens a confirm step that states
 * the exact sentence — "Assign 128 employees to Kitchen?" — and the POST goes
 * out from THAT button, never the first one.
 *
 * '(none)' IN THE DEPARTMENT PICKER ONLY RESETS THE PICK. The route can clear a
 * department (department_id: '') and this bar deliberately will not: one stray
 * click would unclassify everyone a manager had just finished classifying.
 * Clearing stays a one-employee action on the profile page.
 *
 * NO SUB-DEPARTMENT MEANS "LEAVE IT ALONE", NOT "CLEAR IT". The route's rule is
 * that an omitted key leaves the column untouched while '' clears it, so the
 * sub_department_id key is only sent when one was actually picked — otherwise a
 * mixed selection would quietly lose its sub-departments.
 *
 * THE CAP IS LEARNED, NOT RETYPED. The route refuses more than its own maximum
 * and names it in the 400 body (`cap`). That number is remembered from the
 * refusal rather than hardcoded here, so this bar cannot drift out of step with
 * the server's limit the way a second copy of a constant does.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Users, X } from 'lucide-react';
import { api } from '@/lib/api';
import Combobox, { type ComboOption } from '@/components/Combobox';
import type { EmployeeSelection } from './useEmployeeSelection';

/** The slice of a departments row this bar needs — the page's own DeptRow fits. */
export interface BulkDeptOption { id: string; name: string }

interface BulkResult {
  changed: number;
  requested: number;
  not_found: string[];
  department_name: string;
  sub_department_name: string;
}

export default function BulkDepartmentBar({
  total,
  pageIds,
  selection,
  mains,
  subsOf,
  unassignedFilter,
  onApplied,
}: {
  /** Employees matching the current filter — what "select all" would reach. */
  total: number;
  /** Row ids rendered on the current page, for the on-this-page/other-pages split. */
  pageIds: string[];
  selection: EmployeeSelection;
  /** Active MAIN departments, already sorted by the page's tree helpers. */
  mains: BulkDeptOption[];
  /** Active children of a main department — the page's own subsOf. */
  subsOf: (parentId: string) => BulkDeptOption[];
  /** True when the list is filtered to "No department" (changes the nudge copy). */
  unassignedFilter: boolean;
  /** Fired after a successful assignment so the page can refetch the list. */
  onApplied: () => void;
}) {
  const [deptId, setDeptId] = useState('');
  const [subId, setSubId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  /** The route's own per-call maximum, as reported by its 400. */
  const [learnedCap, setLearnedCap] = useState<number | null>(null);

  const count = selection.count;
  const selectedOnPage = pageIds.filter(id => selection.selected.has(id)).length;
  const offPage = Math.max(0, count - selectedOnPage);
  const pageAllSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;

  const deptOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: '(none)' }, ...mains.map(m => ({ value: m.id, label: m.name }))],
    [mains],
  );
  const subs = useMemo(() => (deptId ? subsOf(deptId) : []), [deptId, subsOf]);
  const subOptions = useMemo<ComboOption[]>(
    () => [
      // Not "(none)": omitting the key LEAVES the column, it does not clear it,
      // and the label has to say which of the two this is.
      { value: '', label: 'Leave sub-department as it is' },
      ...subs.map(s => ({ value: s.id, label: s.name })),
    ],
    [subs],
  );

  const deptName = mains.find(m => m.id === deptId)?.name || '';
  const subName = subs.find(s => s.id === subId)?.name || '';

  const overCap = learnedCap !== null && count > learnedCap;
  const canAssign = count > 0 && !!deptId && !busy && !selection.collecting && !overCap;

  const reset = () => { setConfirming(false); setDeptId(''); setSubId(''); setError(null); };

  const apply = async () => {
    if (!canAssign) return;
    setBusy(true);
    setError(null);
    try {
      // sub_department_id is sent ONLY when one was picked — see the header note.
      const body: { employee_ids: string[]; department_id: string; sub_department_id?: string } = {
        employee_ids: [...selection.selected],
        department_id: deptId,
      };
      if (subId) body.sub_department_id = subId;

      // api() (not a bare fetch) — the CSRF header is what keeps this off a 403.
      const res = await api('/api/hr/employees/bulk-department', { method: 'POST', body });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // Remember the cap the route just named so the next attempt is stopped
        // before it is sent, instead of being refused again.
        const cap = Number(json?.cap);
        if (Number.isFinite(cap) && cap > 0) setLearnedCap(Math.floor(cap));
        // The route's own words are the honest answer (wrong sub-department,
        // over the cap, nothing found) — rendered verbatim.
        setError(
          json?.error
            || (res.status === 401 || res.status === 403
              ? 'You need management access to assign departments.'
              : 'Could not assign departments — nothing was changed.'),
        );
        return;
      }
      setResult({
        changed: Number(json?.changed) || 0,
        requested: Number(json?.requested) || 0,
        not_found: Array.isArray(json?.not_found) ? json.not_found.map(String) : [],
        // The server's names, not the picker's — if they disagree, the server is right.
        department_name: String(json?.department_name ?? '') || deptName,
        sub_department_name: String(json?.sub_department_name ?? '') || subName,
      });
      reset();
      selection.clear();
      onApplied();
    } catch {
      setError('Could not reach the server — check the list before trying again.');
    } finally {
      setBusy(false);
    }
  };

  // Nothing matching and nothing held: no bar at all.
  if (total === 0 && count === 0 && !result) return null;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">

      {/* What the last assignment actually did — changed / skipped, not a bare "done". */}
      {result && (
        <div className="rounded-lg border border-green-200 bg-green-50 text-green-800 px-3 py-2 text-sm flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            Assigned {result.changed} of {result.requested} selected employee
            {result.requested === 1 ? '' : 's'} to{' '}
            <span className="font-medium">{result.department_name || '(no department)'}</span>
            {result.sub_department_name && (
              <> → <span className="font-medium">{result.sub_department_name}</span></>
            )}
            .
            {result.not_found.length > 0 && (
              <div className="text-[12px] text-green-900 mt-0.5">
                {result.not_found.length} of them {result.not_found.length === 1 ? 'was' : 'were'} no
                longer on the list and {result.not_found.length === 1 ? 'was' : 'were'} skipped —
                nothing was created for {result.not_found.length === 1 ? 'it' : 'them'}.
              </div>
            )}
          </div>
          <button onClick={() => setResult(null)} className="text-green-700 shrink-0" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Row 1 — the count, and the two ways to change it. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-[#6B5744] min-w-0">
          {count > 0 ? (
            <>
              <strong className="text-[#2D1B0E]">{count}</strong> selected
              {/* Says plainly that a selection outruns the page in view — the
                  whole point of the cross-page collect. */}
              {offPage > 0
                ? <span className="text-[#8B7355]"> · {selectedOnPage} on this page, {offPage} on other pages</span>
                : <span className="text-[#8B7355]"> · all on this page</span>}
            </>
          ) : unassignedFilter ? (
            <>
              <strong className="text-[#2D1B0E]">{total}</strong> employee{total === 1 ? '' : 's'} with no
              department. <span className="text-[#8B7355]">Nothing can be rostered until they are classified.</span>
            </>
          ) : (
            <span className="text-[#8B7355]">
              Tick employees to assign a department in bulk, or select everything matching this filter.
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {count < total && (
            <button
              onClick={() => { setResult(null); selection.selectAllMatching(); }}
              disabled={selection.collecting || busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-xs font-medium disabled:opacity-40"
            >
              {selection.collecting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Users className="w-3.5 h-3.5" />}
              {selection.collecting
                ? `Collecting${selection.progress ? ` — page ${selection.progress.page} of ${selection.progress.of}` : ''}…`
                : `Select all ${total} matching this filter`}
            </button>
          )}
          {count > 0 && !busy && (
            <button
              onClick={() => { reset(); selection.clear(); }}
              className="px-3 py-1.5 text-xs font-medium text-[#af4408] hover:bg-[#FFF1E3] rounded-lg"
            >
              Clear selection
            </button>
          )}
        </div>
      </div>

      {/* A page fully ticked but more matching behind it: the easy thing to miss. */}
      {count > 0 && pageAllSelected && offPage === 0 && total > pageIds.length && (
        <div className="text-[11px] text-[#8B7355]">
          This page only — {total - count} more match this filter on other pages.
        </div>
      )}

      {selection.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-[13px] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{selection.error}</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-[13px] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Row 2 — pick, then confirm. Only ever one of the two is on screen. */}
      {count > 0 && (
        confirming ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">
                  Assign {count} employee{count === 1 ? '' : 's'} to{' '}
                  {deptName}{subName ? ` → ${subName}` : ''}?
                </div>
                <div className="text-[12px] text-amber-800 mt-0.5">
                  {offPage > 0 && <>{offPage} of them {offPage === 1 ? 'is' : 'are'} on other pages. </>}
                  {subName
                    ? <>Their sub-department becomes {subName}. </>
                    : <>Their sub-department is left exactly as it is. </>}
                  This overwrites whatever department they have now. The change is recorded in the audit
                  log with each employee&apos;s previous department, but there is no undo button.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={apply}
                disabled={!canAssign}
                className="px-3 py-1.5 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1.5 disabled:opacity-40"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Yes, assign {count}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="px-3 py-1.5 text-sm text-[#6B5744] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-56">
              <label className="text-xs text-[#6B5744]">Department</label>
              <Combobox
                options={deptOptions}
                value={deptName}
                // A different department invalidates the sub-department — the
                // route rejects a sub that is not a child of it (400), so the
                // picker must not keep offering the old one.
                onChange={(v) => { setDeptId(v); setSubId(''); }}
                placeholder="Pick department"
              />
            </div>
            <div className="w-full sm:w-56">
              <label className="text-xs text-[#6B5744]">Sub-department</label>
              {!deptId ? (
                <input disabled placeholder="Pick department first"
                       className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm opacity-60" />
              ) : subs.length === 0 ? (
                <input disabled placeholder="No sub-departments"
                       className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm opacity-60" />
              ) : (
                <Combobox
                  options={subOptions}
                  value={subName}
                  onChange={(v) => setSubId(v)}
                  placeholder="Leave sub-department as it is"
                />
              )}
            </div>
            <button
              onClick={() => { setResult(null); setError(null); setConfirming(true); }}
              disabled={!canAssign}
              title={
                overCap
                  ? `Too many selected — the server assigns at most ${learnedCap} in one go.`
                  : !deptId ? 'Pick a department first' : undefined
              }
              className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg disabled:opacity-40"
            >
              Assign {count} employee{count === 1 ? '' : 's'}…
            </button>
            {overCap && (
              <span className="text-[11px] text-red-700">
                The server assigns at most {learnedCap} at a time — narrow the filter and do it in batches.
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
