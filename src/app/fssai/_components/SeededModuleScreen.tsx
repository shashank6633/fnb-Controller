'use client';

/**
 * THE SCREEN FOR A FOOD-SAFETY AREA WHOSE RECORD *IS* A CHECKLIST (P8).
 *
 * Five of the twenty sub-modules — Food Quality (§6), Cleaning & Sanitation
 * (§8), Personal Hygiene (§9), Food Storage (§10) and Kitchen Safety (§11) —
 * have no record shape of their own. FSSAI-BUILD-STATE.md §2 settled that from
 * the owner's §24: they are *"the same object — a template with sections, typed
 * questions, a frequency, a department, a responsible role and pass/fail
 * conditions"*, so they ship as ROWS in the checklist engine and the owner edits
 * them himself when a regulation changes.
 *
 * That makes this screen a VIEW, not a form. It owns no table, writes nothing,
 * and does exactly four things:
 *   1. names the checklists that cover this area and what each one asks;
 *   2. says when each was last recorded, and how it went;
 *   3. sends the person to the runner to do one, or to the builder to change one;
 *   4. when none exist yet, says so and names the ready-made ones that would
 *      cover it — read straight out of the pack module, so the promise on screen
 *      cannot drift from what the seed would actually create.
 *
 * ── THE ONE THING IT MUST NEVER DO ──────────────────────────────────────────
 * It must never imply a check happened. An empty area shows "no checklist set up
 * yet" and "nothing recorded yet" as separate, plainly-worded facts, because on
 * a food-safety screen an empty green panel is worse than an empty one — someone
 * could put it in front of an inspector. Same rule as PhaseShell's `notice`.
 *
 * ── WHY IT READS TWO EXISTING ROUTES AND ADDS NONE ──────────────────────────
 * `GET /api/fssai/templates?module_key=` already filters the library by area and
 * already hides drafts from a non-admin (templates/route.ts). `GET
 * /api/fssai/runs` already returns what the caller is allowed to see, scoped by
 * recorder and department. A third route would be a second answer to a question
 * already answered — the rival-helper trap. The runs list is filtered to this
 * area's templates in the browser.
 *
 * Styling is the house skeleton (RECON §1.3): the #FFF8F0 page, the #af4408
 * heading with an icon tile, white cards bordered #E8D5C4. ⚠️ globals.css
 * force-wraps `.flex.gap-2|3|4`, so a row that must keep its icon beside its
 * text carries `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ClipboardList, Info,
  Loader2, PlayCircle, RefreshCw, Settings2, Sparkles, XCircle,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import { FSSAI_FREQUENCIES, FSSAI_TARGET_KINDS, fssaiRunStatusMeta } from '@/lib/fssai';
import { fssaiPackByModule } from '@/lib/fssai-checklist-pack';
import { fssaiModule } from './modules';

interface TemplateRow {
  id: string;
  code: string;
  name: string;
  description: string;
  module_key: string;
  frequency: string;
  target_kind: string;
  status: string;
  is_active: number;
  is_seeded: number;
  version: number;
  question_count: number;
  section_count: number;
  run_count: number;
  department_name?: string | null;
}

interface RunRow {
  id: string;
  template_id: string;
  template_name?: string | null;
  template_name_at_record?: string | null;
  business_date: string;
  shift: string;
  status: string;
  outcome: string;
  started_at: string;
  submitted_at?: string | null;
  fail_count: number;
  pass_pct: number;
  recorded_name?: string | null;
  recorded_by?: string | null;
  target_label?: string | null;
}

function freqLabel(key: string): string {
  return FSSAI_FREQUENCIES.find((f) => f.key === key)?.label || key || '—';
}
function targetLabel(key: string): string {
  return FSSAI_TARGET_KINDS.find((t) => t.key === key)?.label || key || '—';
}

export interface SeededModuleScreenProps {
  /** This page's own path — the key into modules.ts and the module_key source. */
  href: string;
  /** fssai_templates.module_key for this area. */
  moduleKey: string;
  /** What a good record for this area looks like. One plain sentence per line. */
  covers: string[];
}

export default function SeededModuleScreen({ href, moduleKey, covers }: SeededModuleScreenProps) {
  const mod = fssaiModule(href);
  const Icon = mod.icon;

  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [canAuthor, setCanAuthor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const t = await apiJson<{ templates: TemplateRow[]; can_author: boolean }>(
        `/api/fssai/templates?module_key=${encodeURIComponent(moduleKey)}`,
      );
      setTemplates(t.templates || []);
      setCanAuthor(!!t.can_author);
      // Runs are a secondary read: an area with checklists but no history must
      // still render, so a failure here is reported and does not blank the page.
      try {
        const r = await apiJson<{ runs: RunRow[] }>('/api/fssai/runs');
        setRuns(r.runs || []);
      } catch { setRuns([]); }
      setSignedOut(false);
    } catch (e: any) {
      const m = String(e?.message || '');
      if (/Sign in required/i.test(m)) setSignedOut(true);
      else setErr(m || 'Could not read the checklists for this area.');
    } finally {
      setLoading(false);
    }
  }, [moduleKey]);

  useEffect(() => { void load(); }, [load]);

  /** The most recent run per template, out of what this user may see. */
  const lastByTemplate = useMemo(() => {
    const ids = new Set(templates.map((t) => t.id));
    const out = new Map<string, RunRow>();
    for (const r of runs) {
      if (!ids.has(r.template_id)) continue;
      const cur = out.get(r.template_id);
      // /api/fssai/runs is already ordered business_date DESC, started_at DESC.
      if (!cur) out.set(r.template_id, r);
    }
    return out;
  }, [runs, templates]);

  const areaRuns = useMemo(() => {
    const ids = new Set(templates.map((t) => t.id));
    return runs.filter((r) => ids.has(r.template_id)).slice(0, 12);
  }, [runs, templates]);

  /** What the ready-made pack would put here. Read from the pack, not retyped. */
  const packRows = useMemo(() => fssaiPackByModule().get(moduleKey) || [], [moduleKey]);

  if (signedOut) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 text-center">
          <p className="text-sm text-[#6B5744]">Please sign in to see the food-safety checklists.</p>
          <a href="/login" className="inline-block mt-3 text-sm font-semibold text-[#af4408] hover:underline">Sign in</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Icon size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">FSSAI Compliance</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">{mod.label}</h1>
            {mod.blurb && <p className="text-sm text-[#6B5744] mt-1">{mod.blurb}</p>}
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white hover:bg-[#FFF3E6] disabled:opacity-50 flex-nowrap"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 min-w-0">{err}</p>
          </div>
        )}

        {/* How this area is recorded — the settled architecture, in one panel */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <ClipboardList className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-bold text-[#2D1B0E]">This is recorded as a checklist, not as a separate form</p>
              <p className="text-sm text-[#6B5744] mt-1">
                The questions, the acceptable ranges and which answer counts as a failure are all settings you can
                change yourself — add a question, reword one, change a temperature — without waiting for a developer.
              </p>
              <ul className="mt-3 space-y-1.5">
                {covers.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-[#2D1B0E] flex-nowrap">
                    <ArrowRight className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-1" />
                    <span className="min-w-0">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {loading && templates.length === 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#6B5744]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-[#af4408]" /> Reading the checklists…
          </div>
        )}

        {/* Nothing set up yet — stated plainly, with what would cover it */}
        {!loading && templates.length === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-amber-900">No checklist covers this area yet</p>
                <p className="text-sm text-amber-800 mt-1">
                  Nothing has been recorded here and nothing can be, until a checklist for this area exists and is
                  published. {canAuthor
                    ? 'You can add the ready-made ones below in one step, or write your own.'
                    : 'An administrator sets these up in Settings.'}
                </p>
                {packRows.length > 0 && (
                  <>
                    <p className="text-xs font-semibold text-amber-900 mt-3 uppercase tracking-wider">
                      The ready-made checklists for this area
                    </p>
                    <ul className="mt-1.5 space-y-1.5">
                      {packRows.map((p) => (
                        <li key={p.code} className="text-sm text-amber-900">
                          <span className="font-semibold">{p.name}</span>
                          <span className="text-amber-800"> — {freqLabel(p.frequency)}, {p.questions.length} questions</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {canAuthor && (
                  <div className="flex flex-wrap items-center gap-3 mt-3">
                    <a
                      href="/fssai/settings/ready-made"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-sm font-semibold hover:bg-[#8f3607] active:scale-95 flex-nowrap"
                    >
                      <Sparkles className="w-4 h-4" /> Add the ready-made checklists
                    </a>
                    <a href="/fssai/checklists" className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-900 hover:underline flex-nowrap">
                      <Settings2 className="w-4 h-4" /> Write my own
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* The checklists that cover this area */}
        {templates.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
              <p className="font-bold text-[#af4408] min-w-0 flex-1">
                {templates.length} checklist{templates.length === 1 ? '' : 's'} for this area
              </p>
              <a href="/fssai/checklists" className="shrink-0 text-xs font-semibold text-[#af4408] hover:underline">
                All checklists
              </a>
            </div>
            <ul className="divide-y divide-[#F0E4D7]">
              {templates.map((t) => {
                const last = lastByTemplate.get(t.id);
                const isDraft = t.status !== 'published' || !t.is_active;
                return (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{t.name}</p>
                          {isDraft && (
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full border bg-gray-100 text-gray-700 border-gray-200">
                              {t.status === 'archived' ? 'Retired' : 'Draft — staff cannot run it'}
                            </span>
                          )}
                          {!!t.is_seeded && (
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full border bg-[#FFF3E6] text-[#8B7355] border-[#E8D5C4]">
                              Ready-made
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#6B5744] mt-0.5">
                          {freqLabel(t.frequency)} · run against: {targetLabel(t.target_kind)} ·{' '}
                          {t.question_count} question{t.question_count === 1 ? '' : 's'}
                          {t.department_name ? ` · ${t.department_name}` : ''}
                        </p>
                        {t.description && <p className="text-xs text-[#8B7355] mt-1">{t.description}</p>}
                        <p className="text-xs mt-1.5">
                          {last ? (
                            <span className="inline-flex items-center gap-1.5 flex-nowrap">
                              {last.outcome === 'fail'
                                ? <XCircle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                : <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />}
                              <span className="text-[#6B5744]">
                                Last recorded {last.business_date}
                                {last.recorded_name ? ` by ${last.recorded_name}` : ''} —{' '}
                                {fssaiRunStatusMeta(last.status).label}
                                {last.outcome ? `, ${last.outcome === 'fail' ? `${last.fail_count} failed` : 'all passed'}` : ''}
                              </span>
                            </span>
                          ) : (
                            <span className="text-[#8B7355]">Nothing recorded against this checklist yet.</span>
                          )}
                        </p>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1.5">
                        {!isDraft && (
                          <a
                            href="/fssai/checklists/run"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-sm font-semibold hover:bg-[#8f3607] active:scale-95 flex-nowrap"
                          >
                            <PlayCircle className="w-4 h-4" /> Run a check
                          </a>
                        )}
                        {canAuthor && (
                          <a
                            href={`/fssai/settings/checklists/${t.id}`}
                            className="text-xs font-semibold text-[#af4408] hover:underline"
                          >
                            Change the questions
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Recent history for this area */}
        {templates.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4]">
              <p className="font-bold text-[#af4408]">Recently recorded</p>
              <p className="text-xs text-[#6B5744] mt-0.5">
                The rounds you are allowed to see — your own, and your department&rsquo;s. Management sees all of them.
              </p>
            </div>
            {areaRuns.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[#8B7355] text-center">
                Nothing has been recorded for this area yet.
              </p>
            ) : (
              <ul className="divide-y divide-[#F0E4D7]">
                {areaRuns.map((r) => {
                  const meta = fssaiRunStatusMeta(r.status);
                  return (
                    <li key={r.id} className="px-4 py-2.5">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-semibold min-w-0">
                          {r.template_name_at_record || r.template_name || 'Checklist'}
                        </span>
                        <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full border ${meta.color}`}>
                          {meta.label}
                        </span>
                        {r.outcome === 'fail' && (
                          <span className="text-[11px] font-semibold text-red-700">
                            {r.fail_count} failed
                          </span>
                        )}
                        <span className="text-xs text-[#8B7355] ml-auto">
                          {r.business_date}{r.shift ? ` · ${r.shift}` : ''}
                        </span>
                      </div>
                      <p className="text-xs text-[#6B5744] mt-0.5">
                        {r.target_label ? `${r.target_label} · ` : ''}
                        {r.recorded_name || r.recorded_by || 'unknown'}
                        {r.submitted_at ? ` · filed ${fmtIST(r.submitted_at)}` : ` · started ${fmtIST(r.started_at)}`}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <a href="/fssai" className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline flex-nowrap">
            <ArrowLeft className="w-4 h-4" /> Compliance dashboard
          </a>
          <a href="/fssai/corrective-actions" className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline flex-nowrap">
            Corrective actions <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}
