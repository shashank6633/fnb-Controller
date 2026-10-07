'use client';

/**
 * GENERATE card — /hr/roster, above the week grid.
 *
 * Pick department + week → PREVIEW (writes nothing) → APPLY. Preview is the
 * default on the server too: POST /api/hr/roster/generate without commit:true is
 * pure, and a 200 always carries { preview:true, plan } even when plan.ok is
 * false, because a refusal naming what is missing IS the answer.
 *
 * WHAT APPLY WRITES: shift rows only. OFFS ARE NOT PERSISTED — the owner's call.
 * hr_rosters cannot express an off (shift_id is NOT NULL), and an off stored as a
 * roster row becomes a FALSE ABSENT, because
 * src/lib/reports/hr-attendance-register.ts counts a roster row with no
 * attendance as absent and does not join hr_shifts. So the offs on this screen
 * and on the printout come from the PLAN, and the card says so out loud rather
 * than letting them look saved.
 *
 * SETTINGS, NOT HARDCODED RULES. Shift rotation is a setting (owner rule 2) and
 * the allowed off weekdays are a setting (owner rule 1: Mon–Thu only, "it is a
 * Pub, weekend is more busy"). Both are overridable here as a WHAT-IF for the
 * preview only — an empty weekday selection means "nobody chose" and the server
 * falls back to the saved setting, never to "any day".
 */

import { useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  Eye,
  Info,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { WEEKDAY_SHORT, refusalFix, type RosterPlan } from './roster-plan';

interface Props {
  departmentId: string;
  departmentLabel: string;
  weekStart: string;
  weekEnd: string;
  /** The plan currently overlaid on the grid, or null. */
  plan: RosterPlan | null;
  onPlan: (plan: RosterPlan | null, forDeptId: string, forWeekStart: string) => void;
  /** Called after a successful commit so the parent refetches grid + readiness. */
  onCommitted: () => void;
  onOpenConfig: (departmentId: string, tab: 'coverage' | 'map') => void;
  onPrint: () => void;
}

const card = 'bg-white border border-[#E8D5C4] rounded-xl shadow';

/** Map thrown fetch errors to venue-friendly copy (server 500s are generic). */
function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'You do not have permission for this action.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

export default function RosterGenerateCard({
  departmentId,
  departmentLabel,
  weekStart,
  weekEnd,
  plan,
  onPlan,
  onCommitted,
  onOpenConfig,
  onPrint,
}: Props) {
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [showWhatIf, setShowWhatIf] = useState(false);
  /** undefined = use the saved setting. A what-if is deliberately opt-in. */
  const [rotate, setRotate] = useState<boolean | undefined>(undefined);
  const [offDays, setOffDays] = useState<number[] | undefined>(undefined);
  const [ackBreaches, setAckBreaches] = useState(false);

  const body = () => ({
    department_id: departmentId,
    week_start: weekStart,
    ...(rotate === undefined ? {} : { rotate_shifts: rotate }),
    ...(offDays === undefined ? {} : { offs_weekdays: offDays }),
  });

  const preview = async () => {
    setBusy('preview');
    setError(null);
    setDone(null);
    setAckBreaches(false);
    try {
      const json = await apiJson<{ plan: RosterPlan }>('/api/hr/roster/generate', {
        method: 'POST',
        body: body(),
      });
      onPlan(json.plan ?? null, departmentId, weekStart);
    } catch (e) {
      onPlan(null, departmentId, weekStart);
      setError(niceErr(e, 'Could not preview the week'));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan?.ok) return;
    if (plan.breaches.length > 0 && !ackBreaches) {
      setError('Tick the acknowledgement first — a coverage breach is a promise being broken.');
      return;
    }
    setBusy('apply');
    setError(null);
    setDone(null);
    try {
      const json = await apiJson<{ plan: RosterPlan; result: {
        shift_rows_written: number;
        stale_rows_removed: number;
        kept_manual: Array<{ employee_id: string; date: string }>;
        weekly_off_rows_written: number;
      } }>('/api/hr/roster/generate', {
        method: 'POST',
        body: { ...body(), commit: true, allow_breaches: ackBreaches },
      });
      const r = json.result;
      // Re-seat the committed plan so the grid keeps rendering the offs it just
      // planned — they were NOT written and nothing can read them back.
      onPlan(json.plan ?? plan, departmentId, weekStart);
      setDone(
        `Wrote ${r.shift_rows_written} shift row${r.shift_rows_written === 1 ? '' : 's'}. ` +
        (r.stale_rows_removed ? `${r.stale_rows_removed} stale generated row(s) removed. ` : '') +
        (r.kept_manual.length ? `${r.kept_manual.length} day(s) left untouched because a human edited them. ` : '') +
        (r.weekly_off_rows_written
          ? `${r.weekly_off_rows_written} weekly-off attendance row(s) recorded (paid-off policy). `
          : 'No off rows were stored — offs are shown from the plan, never saved.'),
      );
      onCommitted();
    } catch (e) {
      setError(niceErr(e, 'Could not apply the week'));
    } finally {
      setBusy(null);
    }
  };

  const toggleOffDay = (wd: number) =>
    setOffDays(prev => {
      const base = prev ?? [];
      return base.includes(wd) ? base.filter(d => d !== wd) : [...base, wd].sort((a, b) => a - b);
    });

  const noDept = !departmentId;

  return (
    <div className={`${card} print:hidden`}>
      <div className="px-4 py-3 border-b border-[#F3E7D9] flex flex-wrap items-center gap-2">
        <Sparkles className="w-5 h-5 text-[#af4408] shrink-0" />
        <span className="font-semibold text-[#2D1B0E]">Generate the week</span>
        <span className="text-xs text-[#8B7355]">
          {noDept ? 'pick a department first' : `${departmentLabel} · ${weekStart} – ${weekEnd}`}
        </span>
        <span className="flex-1" />
        <button onClick={() => setShowWhatIf(v => !v)}
                className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
          {showWhatIf ? 'Hide what-if' : 'What-if settings'}
        </button>
        <button onClick={preview} disabled={noDept || busy !== null}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-sm text-[#6B5744] disabled:opacity-50">
          {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
          Preview
        </button>
        <button onClick={apply} disabled={noDept || busy !== null || !plan?.ok}
                title={plan?.ok ? 'Write the shift rows' : 'Preview a plan that does not refuse first'}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium disabled:opacity-50">
          {busy === 'apply' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarCheck className="w-4 h-4" />}
          Apply
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        {noDept && (
          <p className="text-sm text-[#8B7355]">
            Choose a department above. The generator plans one department at a time, and the
            department is read from the master — it never assumes a name.
          </p>
        )}

        {showWhatIf && (
          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox"
                     checked={rotate ?? true}
                     onChange={e => setRotate(e.target.checked)} />
              <span>Rotate people between shifts</span>
            </label>
            <p className="text-[11px] text-[#8B7355] pl-6">
              The owner&apos;s usual setting. Unticked, each person keeps their usual shift and only
              the off day moves. This is a what-if for the preview — the saved default lives on
              /hr/settings.
            </p>
            <div>
              <div className="text-xs text-[#6B5744] mb-1">Weekly offs may land on</div>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_SHORT.map((label, wd) => {
                  const on = (offDays ?? []).includes(wd);
                  const weekend = wd === 0 || wd === 5 || wd === 6;
                  return (
                    <button key={wd} onClick={() => toggleOffDay(wd)}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                              on
                                ? weekend
                                  ? 'bg-rose-600 text-white border-rose-600'
                                  : 'bg-[#af4408] text-white border-[#af4408]'
                                : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                            }`}>
                      {label}
                    </button>
                  );
                })}
                {offDays !== undefined && (
                  <button onClick={() => setOffDays(undefined)}
                          className="px-2.5 py-1 rounded-full text-xs text-[#8B7355] underline">
                    use saved setting
                  </button>
                )}
              </div>
              {(offDays ?? []).some(d => d === 0 || d === 5 || d === 6) && (
                <p className="text-[11px] text-rose-700 mt-1.5">
                  Fri, Sat and Sun break the owner&apos;s hard rule — weekly offs land Mon–Thu only,
                  because it is a Pub and the weekend is busier.
                </p>
              )}
              <p className="text-[11px] text-[#8B7355] mt-1">
                Nothing selected means &quot;nobody chose&quot;, and the saved setting is used — an
                empty selection is never read as &quot;any day&quot;.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
            {error}
          </div>
        )}
        {done && (
          <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2 text-sm">
            {done}
          </div>
        )}

        {/* ── REFUSALS. The whole answer when the plan cannot be built. ────── */}
        {plan && !plan.ok && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-rose-800">
              This week cannot be generated yet — {plan.refusals.length} thing
              {plan.refusals.length === 1 ? '' : 's'} missing:
            </p>
            {plan.refusals.map((r, i) => {
              const fix = refusalFix(r.code);
              return (
                <div key={`${r.code}-${i}`}
                     className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                  <div>{r.message}</div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <code className="text-[11px] text-rose-700/80">{r.code}</code>
                    {fix.kind === 'page' && (
                      <a href={fix.href} className="text-[11px] font-medium text-[#af4408] hover:underline">
                        {fix.label}
                      </a>
                    )}
                    {fix.kind === 'config' && (
                      <button onClick={() => onOpenConfig(departmentId, fix.tab)}
                              className="text-[11px] font-medium text-[#af4408] hover:underline">
                        {fix.label}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {plan?.warnings.map((w, i) => (
          <div key={`warn-${i}`}
               className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {w}
          </div>
        ))}

        {/* ── THE PLAN. Groups strip, breaches, coverage. ──────────────────── */}
        {plan?.ok && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#6B5744]">
              <span className="inline-flex items-center gap-1 text-green-700">
                <Check className="w-3.5 h-3.5" /> Plan ready
              </span>
              <span><strong>{plan.rows.filter(r => r.kind === 'shift').length}</strong> shift cells</span>
              <span><strong>{plan.rows.filter(r => r.kind === 'off').length}</strong> offs (not stored)</span>
              <span><strong>{plan.rows.filter(r => r.kind === 'leave').length}</strong> on approved leave</span>
              <span>rotation {plan.rotate_shifts ? 'on' : 'off'}</span>
              <span>
                offs allowed {plan.offs_weekdays.map(d => WEEKDAY_SHORT[d]).join(', ') || '—'}
              </span>
              <span>off policy {plan.weekly_off_policy}</span>
              <button onClick={onPrint}
                      className="ml-auto px-2.5 py-1 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-xs text-[#6B5744]">
                Print sheet
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-[#FFF1E3]">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Group</th>
                    <th className="text-right px-2 py-2 font-semibold">People</th>
                    <th className="text-left px-3 py-2 font-semibold">Shift roles</th>
                    {plan.dates.map(d => (
                      <th key={d} className="text-center px-2 py-2 font-semibold whitespace-nowrap">
                        {WEEKDAY_SHORT[new Date(`${d}T00:00:00Z`).getUTCDay()]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plan.groups.map(g => (
                    <tr key={g.designation_id || '(none)'} className="border-t border-[#F3E7D9]">
                      <td className="px-3 py-2 font-medium">{g.designation_name}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{g.employee_count}</td>
                      <td className="px-3 py-2 text-[11px] text-[#6B5744]">
                        {Object.entries(g.role_counts).map(([role, n]) => `${role} ×${n}`).join(' · ') || '—'}
                      </td>
                      {plan.dates.map(d => (
                        <td key={d} className="px-2 py-2 text-center tabular-nums text-[#6B5744]"
                            title={`${g.offs_by_date[d] ?? 0} off on ${d}`}>
                          {g.offs_by_date[d] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-[#8B7355] mt-1">
                The day columns count <strong>offs</strong> in that group — the owner&apos;s offs run
                Mon–Thu, so Fri/Sat/Sun should read 0.
              </p>
            </div>

            {plan.breaches.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1.5">
                <p className="text-sm font-medium text-amber-900 inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4" />
                  {plan.breaches.length} coverage floor
                  {plan.breaches.length === 1 ? '' : 's'} cannot be kept
                </p>
                {plan.breaches.slice(0, 20).map((b, i) => (
                  <div key={i} className="text-[13px] text-amber-900">• {b.message}</div>
                ))}
                {plan.breaches.length > 20 && (
                  <div className="text-[11px] text-amber-800">
                    and {plan.breaches.length - 20} more
                  </div>
                )}
                <label className="flex items-start gap-2 text-[13px] text-amber-900 pt-1">
                  <input type="checkbox" checked={ackBreaches} className="mt-0.5"
                         onChange={e => { setAckBreaches(e.target.checked); setError(null); }} />
                  <span>
                    I have read these and want to apply the week anyway. A floor is a promise the
                    owner made — it is acknowledged, not stumbled past.
                  </span>
                </label>
              </div>
            )}

            <details className="text-sm">
              <summary className="cursor-pointer text-[#6B5744]">
                Coverage measured per day ({plan.coverage.length} floor{plan.coverage.length === 1 ? '' : 's'})
              </summary>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-[13px] min-w-[620px]">
                  <thead className="bg-[#FFF1E3]">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-semibold">Date</th>
                      <th className="text-left px-2 py-1.5 font-semibold">Group</th>
                      <th className="text-left px-2 py-1.5 font-semibold">Shift role</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Min present</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Planned</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Off</th>
                      <th className="text-right px-2 py-1.5 font-semibold">Leave</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.coverage.map((c, i) => (
                      <tr key={i}
                          className={`border-t border-[#F3E7D9] ${c.shortfall > 0 ? 'bg-amber-50' : ''}`}>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {WEEKDAY_SHORT[c.weekday]} {c.date}
                        </td>
                        <td className="px-2 py-1.5">{c.group}</td>
                        <td className="px-2 py-1.5">{c.shift_role || <span className="text-[#C9B8A5]">day total</span>}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.min_present}</td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${c.shortfall > 0 ? 'text-amber-800 font-semibold' : ''}`}>
                          {c.planned_present}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.off_count}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.leave_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <p className="text-[11px] text-[#8B7355] inline-flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Apply writes <strong>shift rows only</strong>. Offs are rendered from this plan and
                never stored — hr_rosters cannot express an off, and one stored there would be
                counted as an absence by the attendance register. Reload the page and the OFF chips
                go until you preview again. A day a human edited by hand is left alone.
              </span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
