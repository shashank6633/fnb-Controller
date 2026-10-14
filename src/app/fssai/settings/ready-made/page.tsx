'use client';

/**
 * READY-MADE CHECKLISTS — the screen that sets the fifteen up (P8). Admin only:
 * the twelve FSSAI routines and the Hyderabad Food Safety Authority's own
 * three-page audit (CHK-HYD-AUDIT-1/2/3), word for word.
 *
 * ── WHY THERE IS A SCREEN AT ALL, AND NOT JUST A BOOT SEED ──────────────────
 * Because a boot seed resurrects rows an administrator deleted. The rule is in
 * `scripts/check-boot-migrations.js`: anything a HUMAN has decided must not be
 * re-applied by a restart, and the ready-made checklists are the clearest case of
 * that in this module — the owner is meant to edit them and retire the ones he
 * does not want (owner §24). So nothing happens on boot. Somebody presses this
 * button, once, and `fssai_seed_log` remembers that it happened for ever.
 *
 * ── WHAT THE SCREEN HAS TO BE HONEST ABOUT ──────────────────────────────────
 *   1. It writes FIFTEEN checklists and about three hundred questions into
 *      a compliance module. It therefore shows exactly what it will create
 *      BEFORE anything is pressed, grouped by the screen each one belongs to.
 *   2. They arrive as DRAFTS by default. A draft is invisible to staff
 *      (/api/fssai/templates shows a non-admin only published, active
 *      checklists), which is the reversible choice: read each one, change what
 *      you want, publish it — one at a time on its own page, or every untouched
 *      ready-made draft at once with "Publish the ready-made checklists" (never
 *      an archived one, never one whose status a person already changed).
 *      Un-publishing fifteen that staff have already filed in is not one click.
 *   3. Several of them carry a configuration WARNING, and it is shown next to
 *      the checklist it belongs to rather than buried. "Not run against anything
 *      in particular, every shift" means ONE person files for the whole
 *      restaurant each time — true, deliberate, and something the owner should
 *      see on this screen and not discover on a Friday night.
 *   4. A code that already exists is SKIPPED, never overwritten, and the card
 *      says so with the name of what is already there.
 *   5. A checklist an EARLIER version created and the owner since removed is
 *      RETIRED and stays retired; the card says so instead of offering it.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It cannot un-seed. There is no DELETE on /api/fssai/seed, because a seed able
 * to remove what it created would be able to remove the owner's edits with it.
 * Once the fifteen exist they are ordinary checklists, retired in the builder
 * like any other. It also creates no rota: `fssai_assignments` needs a person or
 * a role, and roles and departments are the owner's (HARD RULE 4).
 *
 * Styling is the house skeleton (RECON §1.3): the #FFF8F0 page, the #af4408
 * heading with an icon tile, white cards bordered #E8D5C4, the amber notice
 * panel, no new component. ⚠️ globals.css force-wraps `.flex.gap-2|3|4`, so a
 * row that must keep its icon beside its text carries `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ClipboardList, Info, Loader2,
  Lock, PackagePlus, RefreshCw, Send, ShieldAlert, Sparkles,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import { FSSAI_FREQUENCIES, FSSAI_TARGET_KINDS } from '@/lib/fssai';
import { fssaiModule } from '../../_components/modules';

/* ── what the route returns (the slices this screen reads) ── */

interface ExistingRow {
  id: string;
  name: string;
  status: string;
  version: number;
  is_active: number;
  is_seeded: number;
  question_count: number;
  run_count: number;
}

interface TemplateState {
  code: string;
  name: string;
  module_key: string;
  frequency: string;
  target_kind: string;
  category: string;
  section_count: number;
  question_count: number;
  critical_count: number;
  /** An earlier version created it here and it has since been removed: it stays retired. */
  retired: null | { pack_version: number; created_at: string; template_id: string };
  existing: ExistingRow | null;
  warnings: string[];
}

interface LogRow {
  item_kind: string;
  item_code: string;
  item_id: string;
  action: string;
  detail: string;
  applied_by: string;
  created_at: string;
}

interface SeedState {
  pack_key: string;
  pack_version: number;
  pack_title: string;
  applied: boolean;
  applied_at: string;
  applied_by: string;
  counts: { templates: number; sections: number; questions: number };
  problems: { template_code: string; item: string; problem: string }[];
  templates: TemplateState[];
  log: LogRow[];
  drafts: ReadyMadeDrafts;
}

interface DraftRow { template_id: string; code: string; name: string; question_count: number }
interface HeldRow { template_id: string; code: string; name: string; status: string; why: string }
interface ReadyMadeDrafts { publishable: DraftRow[]; held: HeldRow[]; published: number }

interface PublishResponse {
  published: { template_id: string; code: string; name: string; questions: number; warnings: string[] }[];
  held: HeldRow[];
  lost_race: string[];
  state: SeedState;
}

interface DeptRow { id: string; name: string }

interface StateResponse {
  state: SeedState;
  departments: DeptRow[];
  can_apply: boolean;
}

interface ApplyItem {
  code: string;
  name: string;
  action: 'inserted' | 'skipped';
  reason?: 'code_in_use' | 'retired';
  template_id: string;
  sections: number;
  questions: number;
  detail: string;
  warnings: string[];
}

interface ApplyResponse {
  inserted: number;
  skipped: number;
  status: string;
  items: ApplyItem[];
  state: SeedState;
}

/* ── small label helpers, from the engine's own vocabularies ── */

function freqLabel(key: string): string {
  return FSSAI_FREQUENCIES.find((f) => f.key === key)?.label || key || '—';
}
function targetLabel(key: string): string {
  return FSSAI_TARGET_KINDS.find((t) => t.key === key)?.label || key || '—';
}
/**
 * The food-safety screen a checklist belongs to, named as the menu names it. The
 * three Hyderabad audit pages belong to no one screen — they walk across all of
 * them — so they are grouped under their own category instead.
 */
function groupFor(t: { module_key: string; category: string }): { key: string; label: string } {
  if (t.module_key) return { key: t.module_key, label: fssaiModule(`/fssai/${t.module_key}`).label };
  if (t.category === 'Hyderabad Food Safety Audit') {
    return { key: 'cat:' + t.category, label: 'Hyderabad Food Safety Authority — its own audit, three pages' };
  }
  return { key: 'cat:' + (t.category || ''), label: t.category || 'No particular screen' };
}

export default function FssaiReadyMadeChecklistsPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const [publish, setPublish] = useState(false);
  const [deptByCode, setDeptByCode] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PublishResponse | null>(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const j = await apiJson<StateResponse>('/api/fssai/seed');
      setData(j);
      setForbidden(false);
    } catch (e: any) {
      const m = String(e?.message || '');
      // A 403 is a normal outcome on an admin-only screen, not an error state:
      // the catalog's tier flag is visibility only and the route is the gate.
      if (/administrator/i.test(m) || /Sign in required/i.test(m)) setForbidden(true);
      else setErr(m || 'Could not read the ready-made checklists.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const state = data?.state || null;

  /** Grouped by the screen each checklist belongs to, in pack order. */
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: TemplateState[] }[] = [];
    for (const t of state?.templates || []) {
      const gk = groupFor(t);
      let g = out.find((x) => x.key === gk.key);
      if (!g) { g = { key: gk.key, label: gk.label, rows: [] }; out.push(g); }
      g.rows.push(t);
    }
    return out;
  }, [state]);

  // A retired checklist is never offered again, so it is neither "to create" nor "already there".
  const willCreate = (state?.templates || []).filter((t) => !t.existing && !t.retired);
  const willSkip = (state?.templates || []).filter((t) => t.existing);
  const retired = (state?.templates || []).filter((t) => !t.existing && t.retired);
  const questionsToCreate = willCreate.reduce((n, t) => n + t.question_count, 0);

  const apply = useCallback(async () => {
    setApplying(true);
    setErr('');
    try {
      const j = await apiJson<ApplyResponse>('/api/fssai/seed', {
        method: 'POST',
        body: { publish, department_by_code: deptByCode },
      });
      setResult(j);
      setData((d) => (d ? { ...d, state: j.state, can_apply: false } : d));
      setConfirming(false);
      setToast(
        `${j.inserted} checklist${j.inserted === 1 ? '' : 's'} created as ${j.status === 'published' ? 'published' : 'drafts'}` +
        (j.skipped ? `, ${j.skipped} left alone` : ''),
      );
    } catch (e: any) {
      setErr(String(e?.message || 'Could not set the checklists up.'));
      setConfirming(false);
      void load();
    } finally {
      setApplying(false);
    }
  }, [publish, deptByCode, load]);

  /** ONE CLICK: every untouched ready-made draft goes live. The route says what it left alone and why. */
  const publishAll = useCallback(async () => {
    setPublishing(true);
    setErr('');
    try {
      const j = await apiJson<PublishResponse>('/api/fssai/seed/publish', { method: 'POST', body: {} });
      setPublished(j);
      setData((d) => (d ? { ...d, state: j.state } : d));
      setToast(
        `${j.published.length} checklist${j.published.length === 1 ? '' : 's'} published — staff can run ` +
        `${j.published.length === 1 ? 'it' : 'them'} now` + (j.held.length ? `, ${j.held.length} left alone` : ''),
      );
    } catch (e: any) {
      setErr(String(e?.message || 'Could not publish the ready-made checklists.'));
      void load();
    } finally {
      setPublishing(false);
    }
  }, [load]);

  /* ── permission panel ── */
  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
            <Lock className="w-8 h-8 text-[#af4408] mx-auto mb-3" />
            <h1 className="text-lg font-bold text-[#af4408]">Only an administrator can set up checklists</h1>
            <p className="text-sm text-[#6B5744] mt-2">
              The ready-made checklists write into the food-safety records, so only an administrator can add them.
            </p>
            <a href="/fssai" className="inline-flex items-center gap-1.5 mt-4 text-sm text-[#af4408] hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to the Compliance dashboard
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Sparkles size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">FSSAI Compliance · Settings</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Ready-made Checklists</h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Fifteen checklists: the twelve written to FSSAI Schedule 4 — food quality, cleaning, personal hygiene,
              storage and kitchen safety — and the Hyderabad Food Safety Authority’s own audit, its three pages word for
              word. Add them once, publish them, then change anything you like in the builder.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-nowrap">
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
              <Lock className="w-3 h-3" /> Admin only
            </span>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white hover:bg-[#FFF3E6] disabled:opacity-50 flex-nowrap"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
            </button>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 min-w-0">{err}</p>
          </div>
        )}

        {loading && !state && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#6B5744]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-[#af4408]" /> Reading the pack…
          </div>
        )}

        {/* Something in the pack this build cannot render (RECON §10 R1). */}
        {state && state.problems.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-red-900">These checklists cannot be added to this version of the builder</p>
                <p className="text-sm text-red-800 mt-1">
                  Nothing was created, and the button is switched off. Each line below names the checklist and what the
                  builder refused — this is the check that stops a half-built checklist being filed in as a real one.
                </p>
                <ul className="mt-3 space-y-1.5">
                  {state.problems.map((p, i) => (
                    <li key={i} className="text-sm text-red-900">
                      <span className="font-mono text-xs bg-red-100 px-1.5 py-0.5 rounded">{p.template_code}</span>{' '}
                      <span className="text-red-700">{p.item}</span> — {p.problem}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Already done */}
        {state?.applied && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-green-900">The ready-made checklists have been set up</p>
                <p className="text-sm text-green-800 mt-1">
                  {state.applied_at ? `Added ${fmtIST(state.applied_at)}` : 'Added'}
                  {state.applied_by ? ` by ${state.applied_by}` : ''}. They are not added again — that would bring back
                  any checklist you have since retired. Edit or retire them like any other checklist.
                </p>
                <a href="/fssai/checklists" className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-green-900 hover:underline flex-nowrap">
                  <ClipboardList className="w-4 h-4" /> Open the checklist library
                </a>
              </div>
            </div>
          </div>
        )}

        {/* The result of the apply that just happened */}
        {result && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF3E6]">
              <p className="font-bold text-[#af4408]">What was created</p>
              <p className="text-xs text-[#6B5744] mt-0.5">
                {result.inserted} created as {result.status === 'published' ? 'published' : 'drafts'}
                {result.skipped ? `, ${result.skipped} left exactly as they were or kept retired` : ''}.
                {result.status !== 'published' && ' A draft is not visible to staff until you publish it.'}
              </p>
            </div>
            <ul className="divide-y divide-[#F0E4D7]">
              {result.items.map((it) => (
                <li key={it.code} className="px-4 py-3">
                  <div className="flex items-start gap-2 flex-nowrap">
                    {it.action === 'inserted'
                      ? <Check className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                      : <Info className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{it.name}</p>
                      <p className="text-xs text-[#6B5744]">{it.detail}</p>
                      {it.warnings.map((w, i) => (
                        <p key={i} className="text-xs text-amber-800 mt-1">{w}</p>
                      ))}
                    </div>
                    {it.action === 'inserted' && (
                      <a
                        href={`/fssai/settings/checklists/${it.template_id}`}
                        className="ml-auto shrink-0 text-xs font-semibold text-[#af4408] hover:underline"
                      >
                        Open
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ONE CLICK — publish every untouched ready-made draft. The pack adds them
            as drafts and a draft cannot be run; this is the button that makes
            them runnable without opening fifteen pages. */}
        {state && (state.drafts.publishable.length > 0 || published || state.drafts.held.length > 0) && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-start gap-3 flex-nowrap">
              <Send className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold text-[#af4408]">Publish the ready-made checklists</p>
                <p className="text-sm text-[#6B5744] mt-1">
                  They were added as drafts, and staff cannot see or run a draft. One click publishes every ready-made
                  draft nobody has touched, so staff can run them straight away. Nothing else about them changes — not
                  a question, not a range. A checklist you archived, or whose status you already changed yourself, is
                  left alone.
                  {state.drafts.published ? ` ${state.drafts.published} already published.` : ''}
                </p>
              </div>
            </div>

            {state.drafts.publishable.length > 0 && (
              <>
                <ul className="text-xs text-[#6B5744] space-y-0.5 pl-8">
                  {state.drafts.publishable.map((d) => (
                    <li key={d.template_id}>{d.name} · {d.question_count} questions</li>
                  ))}
                </ul>
                <div className="pl-8">
                  <button
                    onClick={() => void publishAll()}
                    disabled={publishing}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#af4408] text-white font-semibold hover:bg-[#8f3607] active:scale-95 disabled:opacity-50 flex-nowrap"
                  >
                    {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Publish {state.drafts.publishable.length} ready-made checklist{state.drafts.publishable.length === 1 ? '' : 's'}
                  </button>
                </div>
              </>
            )}

            {published && published.published.length > 0 && (
              <div className="pl-8">
                <p className="text-sm font-semibold text-green-800">
                  Published {published.published.length} — staff can run {published.published.length === 1 ? 'it' : 'them'} now.
                </p>
                <ul className="mt-1 space-y-1">
                  {published.published.map((p) => (
                    <li key={p.template_id} className="text-xs">
                      <div className="flex items-start gap-2 flex-nowrap">
                        <Check className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <span className="font-semibold">{p.name}</span>
                          {p.warnings.map((w, i) => <p key={i} className="text-amber-800">{w}</p>)}
                        </div>
                        <a href={`/fssai/settings/checklists/${p.template_id}`} className="ml-auto shrink-0 font-semibold text-[#af4408] hover:underline">
                          Open
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                {published.lost_race.length > 0 && (
                  <p className="text-xs text-amber-800 mt-1">
                    {published.lost_race.length} changed while this was running and were left as they are: {published.lost_race.join(', ')}.
                  </p>
                )}
              </div>
            )}

            {state.drafts.held.length > 0 && (
              <div className="pl-8">
                <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wider">Left alone</p>
                <ul className="mt-1 space-y-1">
                  {state.drafts.held.map((h) => (
                    <li key={h.template_id} className="text-xs text-[#6B5744]">
                      <span className="font-semibold text-[#2D1B0E]">{h.name}</span> — {h.why}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* What the pack contains */}
        {state && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[#af4408]">{state.pack_title}</p>
                <p className="text-xs text-[#6B5744] mt-0.5">
                  {state.counts.templates} checklists · {state.counts.sections} sections · {state.counts.questions} questions
                  <span className="text-[#8B7355]"> · pack {state.pack_key} v{state.pack_version}</span>
                </p>
              </div>
              {!state.applied && state.problems.length === 0 && (
                <p className="text-xs text-[#6B5744]">
                  {willCreate.length} to create ({questionsToCreate} questions)
                  {willSkip.length ? ` · ${willSkip.length} already there` : ''}
                  {retired.length ? ` · ${retired.length} retired, not brought back` : ''}
                </p>
              )}
            </div>

            {groups.map((g) => (
              <div key={g.key}>
                <div className="px-4 py-2 bg-[#FFF8F0] border-y border-[#F0E4D7]">
                  <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">{g.label}</p>
                </div>
                <ul className="divide-y divide-[#F0E4D7]">
                  {g.rows.map((t) => (
                    <li key={t.code} className="px-4 py-3">
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{t.name}</p>
                          <p className="text-xs text-[#6B5744] mt-0.5">
                            {freqLabel(t.frequency)} · run against: {targetLabel(t.target_kind)} ·{' '}
                            {t.section_count} sections · {t.question_count} questions
                            {t.critical_count ? ` · ${t.critical_count} critical` : ''}
                          </p>
                          <p className="text-[11px] font-mono text-[#8B7355] mt-0.5">{t.code}</p>

                          {t.existing && (
                            <p className="text-xs text-amber-800 mt-1.5">
                              A checklist already uses this code — &ldquo;{t.existing.name}&rdquo; ({t.existing.status},
                              {' '}{t.existing.question_count} questions, {t.existing.run_count} recorded).
                              It will be left exactly as it is.
                            </p>
                          )}
                          {!t.existing && t.retired && (
                            <p className="text-xs text-[#6B5744] mt-1.5">
                              Retired — the ready-made checklists added this
                              {t.retired.created_at ? ` on ${fmtIST(t.retired.created_at)}` : ''} and it has since been
                              removed. It is not brought back.
                            </p>
                          )}
                          {t.warnings.map((w, i) => (
                            <p key={i} className="text-xs text-amber-800 mt-1.5">{w}</p>
                          ))}
                        </div>

                        {/* Optional department. Sent as an ID — live names carry
                            double spaces, so a name is never matched on. */}
                        {!state.applied && !t.existing && !t.retired && (
                          <label className="shrink-0 text-xs text-[#6B5744]">
                            <span className="block mb-1">Department</span>
                            <select
                              value={deptByCode[t.code] || ''}
                              onChange={(e) => setDeptByCode((m) => ({ ...m, [t.code]: e.target.value }))}
                              className="text-sm px-2 py-1.5 rounded-lg border border-[#E8D5C4] bg-white max-w-[14rem]"
                            >
                              <option value="">Whole restaurant</option>
                              {(data?.departments || []).map((d) => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* The decision + the button */}
        {state && !state.applied && state.problems.length === 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-4">
            <div>
              <p className="font-bold text-[#af4408]">How should they arrive?</p>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="publish" checked={!publish} onChange={() => setPublish(false)} className="mt-1 shrink-0" />
                  <span className="min-w-0">
                    <span className="font-semibold">As drafts, for me to read first</span>
                    <span className="block text-xs text-[#6B5744]">
                      Recommended. Staff cannot see or run a draft. Read each one, change the questions, the ranges and
                      the frequency to match this kitchen, then publish it.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="publish" checked={publish} onChange={() => setPublish(true)} className="mt-1 shrink-0" />
                  <span className="min-w-0">
                    <span className="font-semibold">Published straight away</span>
                    <span className="block text-xs text-[#6B5744]">
                      Staff can run all fifteen immediately, with the standard FSSAI ranges exactly as written here.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-start gap-2 flex-nowrap">
                <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-900 min-w-0">
                  This can only be done once. Nothing sets a rota — no checklist becomes &ldquo;due&rdquo; until you add
                  it to the schedule yourself, so nobody is marked late for a check nobody asked them to do. The fifteen
                  are added to your own library and are yours to change after that.
                </p>
              </div>
            </div>

            {!confirming ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={!data?.can_apply || willCreate.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#af4408] text-white font-semibold hover:bg-[#8f3607] active:scale-95 disabled:opacity-50 flex-nowrap"
              >
                <PackagePlus className="w-4 h-4" />
                {willCreate.length === 0
                  ? (retired.length ? 'Nothing new to add — each one is already here or retired' : 'Every one of these codes is already in use')
                  : `Add ${willCreate.length} checklist${willCreate.length === 1 ? '' : 's'}`}
              </button>
            ) : (
              <div className="bg-[#FFF3E6] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
                <p className="text-sm font-semibold text-[#2D1B0E]">
                  Add {willCreate.length} checklist{willCreate.length === 1 ? '' : 's'} and {questionsToCreate} questions
                  {publish ? ', published and runnable immediately' : ' as drafts'}?
                </p>
                <div className="flex items-center gap-2 flex-nowrap">
                  <button
                    onClick={() => void apply()}
                    disabled={applying}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#af4408] text-white font-semibold hover:bg-[#8f3607] active:scale-95 disabled:opacity-50 flex-nowrap"
                  >
                    {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    Yes, add them
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={applying}
                    className="px-4 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm hover:bg-[#FFF8F0] disabled:opacity-50"
                  >
                    Not yet
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* The seed's own memory */}
        {state && state.log.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4]">
              <p className="font-bold text-[#af4408]">What the set-up did</p>
              <p className="text-xs text-[#6B5744] mt-0.5">
                Kept for ever, append-only. This is the record that says a checklist was created by the ready-made pack
                rather than by a person — and the reason a restart can never add them again.
              </p>
            </div>
            <ul className="divide-y divide-[#F0E4D7]">
              {state.log.map((l, i) => (
                <li key={i} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs bg-[#FFF3E6] text-[#8B7355] px-1.5 py-0.5 rounded">
                      {l.item_kind}{l.item_code ? ` ${l.item_code}` : ''}
                    </span>
                    <span className={l.action === 'inserted' ? 'text-green-700 font-semibold text-xs' : 'text-[#8B7355] text-xs'}>
                      {l.action}
                    </span>
                    <span className="text-xs text-[#8B7355] ml-auto">{fmtIST(l.created_at)}</span>
                  </div>
                  {l.detail && <p className="text-xs text-[#6B5744] mt-0.5">{l.detail}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4 pt-1">
          <a href="/fssai/settings" className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline flex-nowrap">
            <ArrowLeft className="w-4 h-4" /> Settings
          </a>
          <a href="/fssai/checklists" className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline flex-nowrap">
            <ClipboardList className="w-4 h-4" /> Checklist library
          </a>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg bg-[#2D1B0E] text-white text-sm shadow-lg max-w-[92vw]">
          {toast}
        </div>
      )}
    </div>
  );
}
