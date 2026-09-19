'use client';

/**
 * THE CHECKLIST BUILDER — where a food-safety checklist is actually authored.
 *
 * This is the screen the whole module is configuration ON TOP OF. Twelve of the
 * twenty sub-modules ship as template ROWS rather than code (FSSAI-BUILD-STATE.md
 * §2), so every one of them is authored here. Before this page existed a
 * checklist could be built over the API and not on a screen.
 *
 * WHAT IT TALKS TO — the P2a engine, unchanged. No new route, no new column:
 *   GET  /api/fssai/templates/[id]?include_retired=1 → { template, can_author,
 *        unknown_qtypes, config_warnings }
 *   GET  /api/fssai/masters                          → departments · roles · users
 *        · equipment · vocab (the engine's own lists, so a dropdown here cannot
 *        drift from the server)
 *   POST /api/fssai/templates                        → create, or duplicate
 *   PUT  /api/fssai/templates                        → header edit (returns
 *        version_bumped · changed · config_warnings)
 *   POST /api/fssai/templates/[id]                   → publish | unpublish |
 *        archive | restore
 *   POST·PUT·DELETE /api/fssai/sections              → add · rename · retire ·
 *        reorder · remove-if-empty
 *   POST·PUT·DELETE /api/fssai/questions             → add · edit · reorder ·
 *        move · switch off · remove-if-never-answered
 *
 * EVERY MUTATION GOES THROUGH api() (src/lib/api.ts), which is what attaches the
 * CSRF header. A bare fetch() here would 403 — that is the contract recorded in
 * the §6 log for 2026-09-17/18.
 *
 * ── FOUR THINGS THIS SCREEN REFUSES TO DO QUIETLY ────────────────────────────
 *
 * 1. IT VALIDATES WITH THE SERVER'S OWN CODE, NOT A COPY OF IT.
 *    normalizeFssaiQuestion, fssaiConfigWarnings and templateEditBumpsVersion are
 *    imported from src/lib/fssai.ts — the same pure module the routes import — so
 *    the sentence shown under a field is the sentence the API would have refused
 *    with, and "this edit will bump the version" is decided by the same list the
 *    API decides it by. A second implementation of any of those rules would drift
 *    (RECON §8, the variance-queue lesson).
 *
 * 2. THE PREVIEW RECORDS NOTHING. It opens no run, posts nothing, and touches
 *    /api/fssai/runs not once. It is React state that is thrown away when the
 *    sheet is closed. It still tells the TRUTH, because it reaches the verdict
 *    with the engine's own evaluateFssaiAnswer / summariseFssaiRun and counts an
 *    untouched question exactly as the submit path counts it — present on the
 *    sheet, unanswered, not a failure (runs/route.ts:710-719). A preview that
 *    wrote a run row would be a defect; a preview that lied about the verdict
 *    would be a worse one.
 *
 * 3. RETIRE, NEVER DELETE — and it says so where the button is, not in a manual.
 *    A question with answers cannot be deleted; switching it off takes it off
 *    every FUTURE check and leaves every past one intact. It also keeps counting
 *    in a round already under way, deliberately: "nothing anyone recorded may
 *    leave the verdict" (the HIGH defect closed in the P2 fix round, where a
 *    mid-round retire erased a recorded FAILURE under a PASS stamp). That
 *    sentence is on screen next to the switch, and the exact count comes back
 *    from the API when it happens.
 *
 * 4. IT NAMES THE CONSEQUENCE OF "CRITICAL" WHILE HE IS CHOOSING IT. One
 *    critical failure fails the whole check and the pass mark is ignored
 *    (summariseFssaiRun short-circuits the threshold) — and it still does so from
 *    a question that has since been switched off. That is a surprise worth
 *    having before the fact rather than after.
 *
 * ── AND ONE GAP IT STATES OUT LOUD ───────────────────────────────────────────
 * "Photo: Always" is enforced by the engine but CANNOT be satisfied yet: there is
 * no evidence-write route until the phone runner ships, so an answer that owes a
 * photograph is INCOMPLETE and the check cannot be submitted (proved in the P2
 * fix round by inserting the fssai_evidence row by hand, after which submit
 * succeeded). The screen counts those questions and says it, rather than letting
 * him publish a checklist nobody can finish.
 *
 * ── HOUSE STYLE ──────────────────────────────────────────────────────────────
 * RECON §1.1-§1.5 verbatim: the #FFF8F0 page, #af4408 brand, white cards on
 * #E8D5C4, #D4B896 inputs, the open-coded modal over a bg-black/40 overlay (the
 * bg-black/ class is what triggers the scroll lock at globals.css:295), the
 * shared Toggle, the portaled Combobox for a dropdown inside a modal, and the
 * status metadata arrays from src/lib/fssai.ts. Nothing new is invented and no
 * existing screen is touched (HARD RULE 3).
 *
 * Phone rules for the preview come from RECON §6.2-§6.4: 44px answer buttons,
 * inputMode instead of type="number", text-base so iOS does not zoom, a blank
 * reading that is NOT zero.
 *
 * ACCESS: the path sits under /fssai/settings, which page-catalog.ts marks
 * adminOnly, and bestEntry() matches by LONGEST PREFIX — so this page and every
 * id under it inherit that gate (page-catalog.ts:648-658). That is not the
 * security boundary: every route above re-checks with requireFssaiAdmin, because
 * proxy.ts guards pages and canAccessPage fails open four ways. This screen also
 * refuses to draw an edit control when can_author comes back false.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, ArrowRight, BadgeCheck, Ban, Camera, ChevronDown, ChevronUp,
  ClipboardList, Copy, Eye, FileWarning, Hash, Info, Loader2, Lock, MessageSquare,
  Minus, PenLine, Plus, RefreshCw, RotateCcw, Save, Send, Thermometer,
  Trash2, Undo2, X,
} from 'lucide-react';
import Toggle from '@/components/Toggle';
import Combobox, { type ComboOption } from '@/components/Combobox';
import { api } from '@/lib/api';
import { FSSAI_MODULES } from '@/app/fssai/_components/modules';
import {
  FSSAI_EVIDENCE_RULES, FSSAI_FREQUENCIES, FSSAI_MODULE_KEYS, FSSAI_QTYPES,
  FSSAI_SHIFTS, FSSAI_TARGET_KINDS,
  evaluateFssaiAnswer, fssaiConfigWarnings, fssaiDisplayReading, fssaiTemplateStatusMeta,
  normalizeFssaiQuestion, qtypeMeta, summariseFssaiRun, templateEditBumpsVersion,
  type FssaiEvidenceRule, type FssaiQType, type FssaiVerdict,
} from '@/lib/fssai';

/* ══════════════════════════════════════════════════════════════════════════ *
 * TYPES — the wire shapes, exactly as the engine returns them
 * ══════════════════════════════════════════════════════════════════════════ */

interface SectionRow {
  id: string;
  template_id: string;
  code: string;
  title: string;
  description: string;
  sort_order: number;
  is_active: number;
}

interface QuestionRow {
  id: string;
  template_id: string;
  section_id: string | null;
  code: string;
  qtype: string;
  prompt: string;
  help_text: string;
  uom: string;
  min_value: number | null;
  max_value: number | null;
  target_value: number | null;
  decimals: number;
  expected_value: string;
  options: string[];
  fail_options: string[];
  is_required: number;
  is_critical: number;
  allow_na: number;
  photo_rule: string;
  note_rule: string;
  raise_ca_on_fail: number;
  ca_severity: string;
  sort_order: number;
  is_active: number;
  /** null when this build does not know the type — must never render blank (R1) */
  qtype_label: string | null;
  qtype_known: boolean;
}

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
  outlet_id: string;
  created_at: string;
  updated_at: string;
  sections: SectionRow[];
  questions: QuestionRow[];
  section_count: number;
  question_count: number;
  run_count: number;
  open_run_count: number;
  assignment_count: number;
}

interface Masters {
  departments: { id: string; name: string; code: string; is_active: number }[];
  roles: { id: string; name: string; base_role: string; is_active: number }[];
  users: { email: string; name: string; position: string; department_id: string }[];
}

/* The header fields this screen edits, normalised the way the API normalises
 * them — so "what changed" is decided the same way on both sides. */
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
  requires_signature: 0 | 1;
  requires_verification: 0 | 1;
  allow_backdate_days: string;
  pass_threshold_pct: string;
  sort_order: string;
}

interface QuestionDraft {
  id?: string;
  section_id: string;
  qtype: FssaiQType;
  prompt: string;
  help_text: string;
  code: string;
  uom: string;
  min_value: string;
  max_value: string;
  target_value: string;
  decimals: string;
  expected_value: string;
  options: string[];
  fail_options: string[];
  is_required: boolean;
  is_critical: boolean;
  allow_na: boolean;
  photo_rule: FssaiEvidenceRule;
  note_rule: FssaiEvidenceRule;
  raise_ca_on_fail: boolean;
  ca_severity: string;
  is_active: boolean;
}

interface SectionDraft {
  id?: string;
  title: string;
  code: string;
  description: string;
  is_active: boolean;
}

/** One preview answer. Absent from the map = the question was never touched. */
interface PreviewAnswer {
  value_text?: string;
  value_num?: number | null;
  value_bool?: boolean | null;
  is_na?: boolean;
  note?: string;
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * SMALL SHARED BITS
 * ══════════════════════════════════════════════════════════════════════════ */

const CA_SEVERITIES = ['low', 'medium', 'high', 'urgent'] as const;

const INPUT =
  'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2 disabled:opacity-50';
const BTN_PLAIN =
  'inline-flex items-center justify-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50';
const BTN_ICON =
  'w-9 h-9 inline-flex items-center justify-center rounded-lg border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] disabled:opacity-40';

/** The evidence-rule label, in the admin's own words. */
function evidenceLabel(rule: string): string {
  return FSSAI_EVIDENCE_RULES.find((r) => r.key === rule)?.label || rule;
}

function moduleLabel(key: string): string {
  const hit = FSSAI_MODULES.find((m) => m.href === `/fssai/${key}`);
  return hit ? hit.label : key;
}

function Field({
  label,
  hint,
  required,
  children,
  bumps,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  /** marks a field whose change bumps the checklist version (fssai.ts §7) */
  bumps?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#6B5744]">
        {label}
        {required && <span className="text-[#af4408]"> *</span>}
        {bumps && (
          <span
            title="Changing this changes what was asked or how it was judged, so it raises the checklist version."
            className="ml-1.5 inline-flex items-center align-middle text-[10px] font-semibold px-1.5 py-[1px] rounded-full border bg-[#FFF1E3] text-[#8a3606] border-[#E8D5C4]"
          >
            version
          </span>
        )}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-[#8B7355] mt-1">{hint}</span>}
    </label>
  );
}

function Chip({
  children,
  tone = 'plain',
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'red' | 'amber' | 'green' | 'purple' | 'gray';
  title?: string;
}) {
  const tones: Record<string, string> = {
    plain: 'bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]',
    red: 'bg-red-100 text-red-700 border-red-200',
    amber: 'bg-amber-100 text-amber-800 border-amber-200',
    green: 'bg-green-100 text-green-700 border-green-200',
    purple: 'bg-purple-100 text-purple-700 border-purple-200',
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The house modal (RECON §1.4) plus the two accessibility affordances §1.6 says
 * FSSAI should add to its OWN modals and nowhere else: role="dialog" +
 * aria-modal, and Escape to close. The overlay keeps its bg-black/40 class
 * because globals.css:295 keys the body scroll-lock off exactly that.
 */
function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full ${
          wide ? 'sm:max-w-3xl' : 'sm:max-w-2xl'
        } shadow-xl flex flex-col overflow-hidden max-h-[92vh] sm:max-h-[90vh]`}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-[#2D1B0E]">{title}</h2>
            {subtitle && <p className="text-xs text-[#8B7355] mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={BTN_ICON}>
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * api() + a status-aware throw. apiJson() collapses every failure into the
 * server's sentence, which is the right default — but this screen needs the
 * STATUS as well: a 403 draws the restricted panel, a 404 draws "this checklist
 * no longer exists", and a 409 from publish/archive is a normal outcome to show
 * rather than an error to log.
 */
interface CallError extends Error {
  status?: number;
  data?: unknown;
}
async function call<T = Record<string, unknown>>(
  url: string,
  init: Parameters<typeof api>[1] = {},
): Promise<T> {
  const res = await api(url, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* an empty body is still a valid failure */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `HTTP ${res.status}`;
    const err: CallError = Object.assign(new Error(msg), { status: res.status, data });
    throw err;
  }
  return data as T;
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * THE PAGE
 * ══════════════════════════════════════════════════════════════════════════ */

export default function FssaiChecklistBuilderPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const routeId = String(params?.id || '');
  const isNew = routeId === 'new';

  const [tpl, setTpl] = useState<TemplateRow | null>(null);
  const [masters, setMasters] = useState<Masters | null>(null);
  const [meName, setMeName] = useState('');
  const [canAuthor, setCanAuthor] = useState(false);
  const [unknownQtypes, setUnknownQtypes] = useState<string[]>([]);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);

  const [loading, setLoading] = useState(!isNew);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const [draft, setDraft] = useState<HeaderDraft>(blankHeader());
  const [headerOpen, setHeaderOpen] = useState(isNew);

  const [sectionDraft, setSectionDraft] = useState<SectionDraft | null>(null);
  const [questionDraft, setQuestionDraft] = useState<QuestionDraft | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /* ── load ──────────────────────────────────────────────────────────────── */

  const loadMasters = useCallback(async () => {
    try {
      const j = await call<Masters & { error?: string }>('/api/fssai/masters');
      setMasters({ departments: j.departments || [], roles: j.roles || [], users: j.users || [] });
      setCanAuthor(true);
    } catch (e) {
      // /api/fssai/masters is admin-only, so a 403 here IS the answer to "may
      // this person author?" — the page draws the restricted panel rather than a
      // set of controls whose every click would be refused.
      if ((e as CallError).status === 403 || (e as CallError).status === 401) setForbidden(true);
      else setErr((e as Error).message || 'Failed to load the lists');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    setMissing(false);
    try {
      const j = await call<{
        template: TemplateRow;
        can_author?: boolean;
        unknown_qtypes?: string[];
        config_warnings?: string[];
      }>(`/api/fssai/templates/${encodeURIComponent(routeId)}?include_retired=1`);
      setTpl(j.template);
      setDraft(headerFrom(j.template));
      setUnknownQtypes(j.unknown_qtypes || []);
      setServerWarnings(j.config_warnings || []);
      if (j.can_author === false) setCanAuthor(false);
    } catch (e) {
      const st = (e as CallError).status;
      if (st === 403 || st === 401) setForbidden(true);
      else if (st === 404) setMissing(true);
      else setErr((e as Error).message || 'Failed to load the checklist');
    } finally {
      setLoading(false);
    }
  }, [routeId]);

  useEffect(() => {
    void loadMasters();
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => setMeName(String(j?.user?.name || j?.user?.email || '')))
      .catch(() => setMeName(''));
  }, [loadMasters]);

  useEffect(() => {
    if (isNew) {
      setTpl(null);
      setDraft(blankHeader());
      setHeaderOpen(true);
      setLoading(false);
      return;
    }
    void load();
  }, [isNew, load]);

  /* ── derived ───────────────────────────────────────────────────────────── */

  const activeQuestions = useMemo(
    () => (tpl?.questions || []).filter((q) => Number(q.is_active)),
    [tpl],
  );

  /** The sheet, grouped exactly the way the runner will read it: sections in
   *  sort order, then anything ungrouped. Retired rows keep their place — a
   *  question that was switched off does not move in the history of the sheet. */
  const groups = useMemo(() => {
    if (!tpl) return [] as { section: SectionRow | null; questions: QuestionRow[] }[];
    const out: { section: SectionRow | null; questions: QuestionRow[] }[] = [];
    const sections = [...tpl.sections].sort((a, b) => a.sort_order - b.sort_order);
    const sectionIds = new Set(sections.map((s) => s.id));
    for (const s of sections) {
      out.push({ section: s, questions: tpl.questions.filter((q) => q.section_id === s.id) });
    }
    const loose = tpl.questions.filter(
      (q) => !q.section_id || !sectionIds.has(String(q.section_id)),
    );
    if (loose.length || !sections.length) out.push({ section: null, questions: loose });
    return out;
  }, [tpl]);

  /** The flattened order the reorder routes want: every id, in display order. */
  const flatQuestionOrder = useMemo(
    () => groups.flatMap((g) => g.questions.map((q) => q.id)),
    [groups],
  );

  const changedHeaderFields = useMemo(() => {
    if (!tpl) return [] as string[];
    const next = headerPayload(draft);
    const out: string[] = [];
    for (const k of Object.keys(next) as (keyof ReturnType<typeof headerPayload>)[]) {
      const before = (tpl as unknown as Record<string, unknown>)[k];
      if (String(before ?? '') !== String(next[k] ?? '')) out.push(k);
    }
    return out;
  }, [tpl, draft]);

  const willBump = templateEditBumpsVersion(changedHeaderFields);

  /** The same predicate the API returns on create, edit and publish. Running it
   *  live means the warning appears the moment he picks, not after he saves. */
  const liveWarnings = useMemo(
    () =>
      fssaiConfigWarnings({
        target_kind: draft.target_kind,
        frequency: draft.frequency,
        department_id: draft.department_id,
        requires_verification: draft.requires_verification,
      }),
    [draft.target_kind, draft.frequency, draft.department_id, draft.requires_verification],
  );

  const criticalCount = activeQuestions.filter((q) => Number(q.is_critical)).length;
  const photoOwed = activeQuestions.filter((q) => q.photo_rule !== 'never');
  const photoAlways = photoOwed.filter((q) => q.photo_rule === 'always');
  const unknownOnSheet = activeQuestions.filter((q) => !q.qtype_known);

  /* ── header save / create ──────────────────────────────────────────────── */

  async function saveHeader() {
    setBusy('header');
    setErr('');
    try {
      if (isNew || !tpl) {
        const j = await call<{ template: TemplateRow; config_warnings?: string[] }>(
          '/api/fssai/templates',
          { method: 'POST', body: headerPayload(draft) },
        );
        setServerWarnings(j.config_warnings || []);
        say('Checklist created as a draft.');
        router.replace(`/fssai/settings/checklists/${j.template.id}`);
        return;
      }
      if (!changedHeaderFields.length) {
        say('Nothing changed.');
        setHeaderOpen(false);
        return;
      }
      const body: Record<string, unknown> = { id: tpl.id };
      const next = headerPayload(draft) as unknown as Record<string, unknown>;
      for (const k of changedHeaderFields) body[k] = next[k];
      const j = await call<{
        template: TemplateRow;
        version_bumped?: boolean;
        version?: number;
        changed?: string[];
        config_warnings?: string[];
      }>('/api/fssai/templates', { method: 'PUT', body });
      setTpl(j.template);
      setDraft(headerFrom(j.template));
      setServerWarnings(j.config_warnings || []);
      setHeaderOpen(false);
      say(
        j.version_bumped
          ? `Saved. This changed what is asked, so the checklist is now version ${j.version}.`
          : 'Saved.',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  async function lifecycle(action: 'publish' | 'unpublish' | 'restore', confirmText: string) {
    if (!tpl) return;
    if (!window.confirm(confirmText)) return;
    setBusy(action);
    setErr('');
    try {
      const j = await call<{ template: TemplateRow; config_warnings?: string[] }>(
        `/api/fssai/templates/${encodeURIComponent(tpl.id)}`,
        { method: 'POST', body: { action } },
      );
      setTpl(j.template);
      setDraft(headerFrom(j.template));
      if (j.config_warnings) setServerWarnings(j.config_warnings);
      say(
        action === 'publish'
          ? 'Published. Staff can run it now.'
          : action === 'unpublish'
            ? 'Back to a draft. Staff can no longer see it.'
            : 'Restored as a draft. Read it through and publish it on purpose.',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function archive(reason: string) {
    if (!tpl) return;
    setBusy('archive');
    setErr('');
    try {
      const j = await call<{
        template: TemplateRow;
        assignments_stood_down?: number;
        run_count?: number;
      }>(`/api/fssai/templates/${encodeURIComponent(tpl.id)}`, {
        method: 'POST',
        body: { action: 'archive', reason },
      });
      setTpl(j.template);
      setDraft(headerFrom(j.template));
      setArchiveOpen(false);
      setNotice(
        `Archived. ${j.assignments_stood_down || 0} standing assignment${
          (j.assignments_stood_down || 0) === 1 ? ' was' : 's were'
        } stood down with it, and ${j.run_count || 0} recorded check${
          (j.run_count || 0) === 1 ? '' : 's'
        } stay readable. Nothing was deleted.`,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function duplicate() {
    if (!tpl) return;
    if (
      !window.confirm(
        'Copy this checklist? The copy is a fresh DRAFT at version 1 with no code, ' +
          'carrying every section and question. Nothing about this checklist changes.',
      )
    )
      return;
    setBusy('duplicate');
    setErr('');
    try {
      const j = await call<{ template: TemplateRow }>('/api/fssai/templates', {
        method: 'POST',
        body: { action: 'duplicate', template_id: tpl.id },
      });
      router.push(`/fssai/settings/checklists/${j.template.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy('');
    }
  }

  /* ── sections ──────────────────────────────────────────────────────────── */

  async function saveSection(d: SectionDraft) {
    if (!tpl) return;
    setBusy('section');
    setErr('');
    try {
      const j = d.id
        ? await call<{ template: TemplateRow; version?: number }>('/api/fssai/sections', {
            method: 'PUT',
            body: {
              id: d.id,
              title: d.title,
              code: d.code,
              description: d.description,
              is_active: d.is_active ? 1 : 0,
            },
          })
        : await call<{ template: TemplateRow; version?: number }>('/api/fssai/sections', {
            method: 'POST',
            body: {
              template_id: tpl.id,
              title: d.title,
              code: d.code,
              description: d.description,
            },
          });
      setTpl(j.template);
      setSectionDraft(null);
      say(d.id ? `Section saved — version ${j.version}.` : `Section added — version ${j.version}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function setSectionActive(s: SectionRow, on: boolean) {
    if (
      !on &&
      !window.confirm(
        `Switch off "${s.title}"?\n\nIt disappears from every future check, and its questions go with it. ` +
          'Nothing already recorded changes, and you can switch it back on.',
      )
    )
      return;
    setBusy(`sec:${s.id}`);
    setErr('');
    try {
      const j = await call<{ template: TemplateRow; version?: number }>('/api/fssai/sections', {
        method: 'PUT',
        body: { id: s.id, is_active: on ? 1 : 0 },
      });
      setTpl(j.template);
      say(on ? `"${s.title}" is back on the sheet.` : `"${s.title}" is switched off.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function deleteSection(s: SectionRow) {
    if (
      !window.confirm(
        `Remove the section "${s.title}"?\n\nA section can only be removed while no question sits in it. ` +
          'Nothing in the record refers to a section, so removing an empty one rewrites no history.',
      )
    )
      return;
    setBusy(`sec:${s.id}`);
    setErr('');
    try {
      const j = await call<{ template: TemplateRow }>(
        `/api/fssai/sections?id=${encodeURIComponent(s.id)}`,
        { method: 'DELETE' },
      );
      setTpl(j.template);
      say(`"${s.title}" removed.`);
    } catch (e) {
      // The route refuses with the live question count in words — show it.
      setNotice((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function reorderSections(order: string[]) {
    if (!tpl) return;
    setBusy('reorder-sections');
    setErr('');
    try {
      const j = await call<{ template: TemplateRow }>('/api/fssai/sections', {
        method: 'PUT',
        body: { action: 'reorder', template_id: tpl.id, order },
      });
      setTpl(j.template);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  function moveSection(id: string, delta: -1 | 1) {
    if (!tpl) return;
    const ids = [...tpl.sections].sort((a, b) => a.sort_order - b.sort_order).map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorderSections(ids);
  }

  /* ── questions ─────────────────────────────────────────────────────────── */

  async function saveQuestion(d: QuestionDraft) {
    if (!tpl) return;
    setBusy('question');
    setErr('');
    try {
      const payload: Record<string, unknown> = {
        qtype: d.qtype,
        prompt: d.prompt,
        help_text: d.help_text,
        code: d.code,
        uom: d.uom,
        min_value: d.min_value,
        max_value: d.max_value,
        target_value: d.target_value,
        decimals: d.decimals,
        expected_value: d.expected_value,
        options: d.options,
        fail_options: d.fail_options,
        is_required: d.is_required ? 1 : 0,
        is_critical: d.is_critical ? 1 : 0,
        allow_na: d.allow_na ? 1 : 0,
        photo_rule: d.photo_rule,
        note_rule: d.note_rule,
        raise_ca_on_fail: d.raise_ca_on_fail ? 1 : 0,
        ca_severity: d.ca_severity,
      };
      const j = d.id
        ? await call<{ template: TemplateRow; version?: number }>('/api/fssai/questions', {
            method: 'PUT',
            body: { ...payload, id: d.id, is_active: d.is_active ? 1 : 0 },
          })
        : await call<{ template: TemplateRow; version?: number }>('/api/fssai/questions', {
            method: 'POST',
            body: { ...payload, template_id: tpl.id, section_id: d.section_id || null },
          });
      setTpl(j.template);
      setQuestionDraft(null);
      say(d.id ? `Question saved — version ${j.version}.` : `Question added — version ${j.version}.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function setQuestionActive(q: QuestionRow, on: boolean) {
    if (
      !on &&
      !window.confirm(
        `Switch off "${q.prompt}"?\n\n` +
          'It comes off every future check. Every answer already recorded stays exactly as it was asked.\n\n' +
          'It also keeps counting in any check that is open RIGHT NOW: an answer already given to it still ' +
          'counts towards that round — and if it is marked critical, a failure already recorded still fails ' +
          'that whole round. Nothing anyone recorded leaves the verdict.',
      )
    )
      return;
    setBusy(`q:${q.id}`);
    setErr('');
    try {
      const j = await call<{ template: TemplateRow; version?: number }>('/api/fssai/questions', {
        method: 'PUT',
        body: { id: q.id, is_active: on ? 1 : 0 },
      });
      setTpl(j.template);
      say(on ? 'Question is back on the sheet.' : 'Question switched off. Nothing recorded was lost.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function deleteQuestion(q: QuestionRow) {
    if (
      !window.confirm(
        `Remove "${q.prompt}"?\n\n` +
          'It is only really deleted if nobody has ever answered it. If it has answers it is SWITCHED OFF ' +
          'and kept instead — a question somebody answered is part of a record and is never deleted.',
      )
    )
      return;
    setBusy(`q:${q.id}`);
    setErr('');
    try {
      const j = await call<{
        template: TemplateRow;
        deleted?: boolean;
        retired?: boolean;
        message?: string;
      }>(`/api/fssai/questions?id=${encodeURIComponent(q.id)}`, { method: 'DELETE' });
      setTpl(j.template);
      if (j.retired && j.message) setNotice(j.message);
      else say('Question removed — it had never been answered.');
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function reorderQuestions(order: string[]) {
    if (!tpl) return;
    setBusy('reorder-questions');
    setErr('');
    try {
      const j = await call<{ template: TemplateRow }>('/api/fssai/questions', {
        method: 'PUT',
        body: { action: 'reorder', template_id: tpl.id, order },
      });
      setTpl(j.template);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  /**
   * Move a question one place within its OWN group, then post the WHOLE sheet
   * order. Posting the complete list is what makes the move atomic (the route
   * rewrites every sort_order in one transaction rather than swapping a pair
   * that could half-apply) and what makes it survive a reload: the order on
   * screen and the order in the database are the same list.
   */
  function moveQuestion(q: QuestionRow, delta: -1 | 1) {
    const group = groups.find((g) => (g.section?.id || null) === (q.section_id || null));
    if (!group) return;
    const ids = group.questions.map((x) => x.id);
    const i = ids.indexOf(q.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const swapped = [...ids];
    [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
    const order = flatQuestionOrder.slice();
    // Replace this group's slice, in place, with the swapped order.
    const positions = ids.map((id) => order.indexOf(id)).sort((a, b) => a - b);
    positions.forEach((pos, k) => {
      order[pos] = swapped[k];
    });
    void reorderQuestions(order);
  }

  async function moveQuestionToSection(q: QuestionRow, sectionId: string) {
    if ((q.section_id || '') === sectionId) return;
    setBusy(`q:${q.id}`);
    setErr('');
    try {
      const j = await call<{ template: TemplateRow }>('/api/fssai/questions', {
        method: 'PUT',
        body: { action: 'move', id: q.id, section_id: sectionId || null },
      });
      setTpl(j.template);
      say('Question moved.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  /* ── render guards ─────────────────────────────────────────────────────── */

  if (forbidden) {
    return (
      <Screen>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Only an administrator can set up food-safety checklists. Ask an administrator for
          access.
        </div>
        <BackLinks />
      </Screen>
    );
  }

  if (missing) {
    return (
      <Screen>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          That checklist no longer exists. It may have been deleted while it had never been run.
        </div>
        <BackLinks />
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading the checklist…
        </div>
      </Screen>
    );
  }

  const status = fssaiTemplateStatusMeta(tpl?.status);
  const editable = canAuthor;

  return (
    <Screen>
      {/* ── header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
          <ClipboardList size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
            FSSAI Compliance · Checklist setup
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] break-words">
            {isNew ? 'New checklist' : tpl?.name || 'Checklist'}
          </h1>
          {!isNew && tpl && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Chip tone={status.key === 'published' ? 'green' : 'gray'}>{status.label}</Chip>
              <Chip title="Every change to a section or a question raises this number. A recorded check keeps the version it was taken under.">
                Version {tpl.version}
              </Chip>
              {tpl.code && (
                <Chip>
                  <Hash size={11} /> {tpl.code}
                </Chip>
              )}
              <Chip>{tpl.section_count} sections</Chip>
              <Chip>{tpl.question_count} questions</Chip>
              <Chip tone={tpl.run_count ? 'purple' : 'plain'}>
                {tpl.run_count} recorded
              </Chip>
              {tpl.open_run_count > 0 && (
                <Chip tone="amber">{tpl.open_run_count} open right now</Chip>
              )}
              {Number(tpl.is_seeded) === 1 && <Chip>Shipped with the app</Chip>}
            </div>
          )}
        </div>
        {!isNew && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void load()} disabled={loading} className={BTN_PLAIN}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={() => setPreviewOpen(true)}
              disabled={!activeQuestions.length}
              title={
                activeQuestions.length
                  ? 'See the sheet exactly as staff will see it on a phone. Nothing is recorded.'
                  : 'Add a question first.'
              }
              className={BTN_PLAIN}
            >
              <Eye size={15} /> Preview on a phone
            </button>
          </div>
        )}
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span className="min-w-0">{err}</span>
        </div>
      )}

      {notice && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex items-start gap-2">
          <Info size={16} className="shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button onClick={() => setNotice('')} aria-label="Dismiss" className="shrink-0">
            <X size={15} />
          </button>
        </div>
      )}

      {/* A question type this build does not know must be VISIBLE as a problem,
          never rendered as a blank field (RECON §10 R1). */}
      {(unknownQtypes.length > 0 || unknownOnSheet.length > 0) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-900">
          <p className="font-bold flex items-center gap-2">
            <FileWarning size={16} /> This checklist asks something the app cannot draw
          </p>
          <p className="mt-1">
            {unknownOnSheet.length || unknownQtypes.length} question
            {(unknownOnSheet.length || unknownQtypes.length) === 1 ? '' : 's'} use a kind of answer
            this version does not know
            {unknownQtypes.length ? ` (${unknownQtypes.join(', ')})` : ''}. They are listed below and
            marked. Change each one to one of the eight kinds before publishing — the app will refuse
            to publish until you do, deliberately, rather than show staff an empty box.
          </p>
        </div>
      )}

      {/* ── the header card ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-[#E8D5C4]">
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355] flex-1 min-w-0">
            {isNew ? 'What is this checklist?' : 'The checklist itself'}
          </h2>
          {!isNew && editable && (
            <button onClick={() => setHeaderOpen((v) => !v)} className={BTN_PLAIN}>
              {headerOpen ? <ChevronUp size={15} /> : <PenLine size={15} />}{' '}
              {headerOpen ? 'Hide' : 'Edit'}
            </button>
          )}
        </div>

        {!isNew && tpl && !headerOpen && (
          <dl className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 text-sm">
            <Facts label="Runs" value={freqLabel(tpl.frequency)} />
            <Facts label="Run against" value={targetLabel(tpl.target_kind)} />
            <Facts
              label="Department"
              value={
                masters?.departments.find((d) => d.id === tpl.department_id)?.name ||
                (tpl.department_id ? tpl.department_id : 'The whole restaurant')
              }
            />
            <Facts
              label="Responsible role"
              value={
                masters?.roles.find((r) => r.id === tpl.responsible_role_id)?.name ||
                (tpl.responsible_role_id ? tpl.responsible_role_id : '—')
              }
            />
            <Facts label="Pass mark" value={`${tpl.pass_threshold_pct}%`} />
            <Facts
              label="Signature"
              value={Number(tpl.requires_signature) ? 'Required' : 'Not required'}
            />
            <Facts
              label="Second pair of eyes"
              value={
                Number(tpl.requires_verification)
                  ? 'A manager must verify it'
                  : 'No verification needed'
              }
            />
            <Facts
              label="Backdating"
              value={
                Number(tpl.allow_backdate_days)
                  ? `Up to ${tpl.allow_backdate_days} day${Number(tpl.allow_backdate_days) === 1 ? '' : 's'}`
                  : 'Not allowed'
              }
            />
            <Facts
              label="Food-safety area"
              value={tpl.module_key ? moduleLabel(tpl.module_key) : 'Your own checklist'}
            />
            {tpl.description && (
              <div className="col-span-2 sm:col-span-3 lg:col-span-4">
                <dt className="text-[11px] uppercase tracking-wider text-[#8B7355]">Description</dt>
                <dd className="text-sm text-[#3D2614] mt-0.5 whitespace-pre-wrap">
                  {tpl.description}
                </dd>
              </div>
            )}
          </dl>
        )}

        {headerOpen && editable && (
          <div className="p-4 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Field label="Name" required hint="What staff will see in their list of checks.">
                  <input
                    className={INPUT}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="Cold room temperature — closing"
                  />
                </Field>
              </div>
              <Field
                label="Code"
                hint="A stable key, e.g. CHK-COLDROOM-DAILY. Leave it blank unless you need one; it must be unique."
              >
                <input
                  className={`${INPUT} font-mono`}
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder=""
                />
              </Field>
              <Field label="Category" hint="How it is grouped in lists.">
                <input
                  className={INPUT}
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  placeholder="Compliance"
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Description" hint="Why this check exists. Staff can read it.">
                  <textarea
                    rows={2}
                    className={INPUT}
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </Field>
              </div>

              <Field label="How often" hint={freqHint(draft.frequency)}>
                <select
                  className={INPUT}
                  value={draft.frequency}
                  onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}
                >
                  {FSSAI_FREQUENCIES.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Run against"
                bumps
                hint={targetHint(draft.target_kind)}
              >
                <select
                  className={INPUT}
                  value={draft.target_kind}
                  onChange={(e) => setDraft({ ...draft, target_kind: e.target.value })}
                >
                  {FSSAI_TARGET_KINDS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Department"
                hint="Leave blank for a check that belongs to the whole restaurant. Any signed-in member of staff can then see its records."
              >
                <select
                  className={INPUT}
                  value={draft.department_id}
                  onChange={(e) => setDraft({ ...draft, department_id: e.target.value })}
                >
                  <option value="">The whole restaurant</option>
                  {(masters?.departments || []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Responsible role"
                hint="Whose job this is. Roles are your own configuration — this module never creates one."
              >
                <select
                  className={INPUT}
                  value={draft.responsible_role_id}
                  onChange={(e) => setDraft({ ...draft, responsible_role_id: e.target.value })}
                >
                  <option value="">Anyone signed in</option>
                  {(masters?.roles || []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {Number(r.is_active) ? '' : ' (switched off)'}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Food-safety area" hint="Which part of the module owns it.">
                <select
                  className={INPUT}
                  value={draft.module_key}
                  onChange={(e) => setDraft({ ...draft, module_key: e.target.value })}
                >
                  <option value="">Your own checklist (no area)</option>
                  {FSSAI_MODULE_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {moduleLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Pass mark"
                bumps
                hint="The percentage of the answers that were actually judged which must pass. Questions marked not-applicable are left out of the sum."
              >
                <div className="flex items-center gap-2">
                  <input
                    inputMode="numeric"
                    className={INPUT}
                    value={draft.pass_threshold_pct}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        pass_threshold_pct: e.target.value.replace(/[^0-9.]/g, ''),
                      })
                    }
                  />
                  <span className="text-sm text-[#6B5744] mt-1">%</span>
                </div>
              </Field>

              <Field
                label="Backdating"
                hint="How many days late a check may be filed for. 0 means today only. Every backdated record is flagged and needs a reason."
              >
                <div className="flex items-center gap-2">
                  <input
                    inputMode="numeric"
                    className={INPUT}
                    value={draft.allow_backdate_days}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        allow_backdate_days: e.target.value.replace(/[^0-9]/g, ''),
                      })
                    }
                  />
                  <span className="text-sm text-[#6B5744] mt-1">days</span>
                </div>
              </Field>

              <Field label="Order in the list" hint="Lower numbers come first.">
                <input
                  inputMode="numeric"
                  className={INPUT}
                  value={draft.sort_order}
                  onChange={(e) =>
                    setDraft({ ...draft, sort_order: e.target.value.replace(/[^0-9-]/g, '') })
                  }
                />
              </Field>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <SwitchRow
                label="A signature is part of the record"
                hint="The signed-in person and the time. There is no drawn signature — that is still an open question for you."
                bumps
                checked={!!draft.requires_signature}
                onChange={(v) => setDraft({ ...draft, requires_signature: v ? 1 : 0 })}
              />
              <SwitchRow
                label="A manager must verify it"
                hint="Someone in management signs it off afterwards — never the person who recorded it."
                bumps
                checked={!!draft.requires_verification}
                onChange={(v) => setDraft({ ...draft, requires_verification: v ? 1 : 0 })}
              />
            </div>

            {!isNew && changedHeaderFields.length > 0 && (
              <div
                className={`rounded-lg border p-3 text-sm ${
                  willBump
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]'
                }`}
              >
                {willBump ? (
                  <>
                    <strong>This changes what is asked or how it is judged.</strong> Saving raises the
                    checklist from version {tpl?.version} to {Number(tpl?.version || 0) + 1}. Checks
                    already recorded keep the version they were taken under, so nothing already on
                    file changes.
                  </>
                ) : (
                  <>Saving this is a tidy-up — the version stays at {tpl?.version}.</>
                )}
              </div>
            )}

            {liveWarnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                {liveWarnings.map((w, i) => (
                  <p key={i} className="text-sm text-amber-900 flex items-start gap-2">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                    <span className="min-w-0">{w}</span>
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {!isNew && (
                <button
                  onClick={() => {
                    if (tpl) setDraft(headerFrom(tpl));
                    setHeaderOpen(false);
                  }}
                  className={BTN_PLAIN}
                >
                  <Undo2 size={15} /> Discard changes
                </button>
              )}
              <button
                onClick={() => void saveHeader()}
                disabled={busy === 'header' || !draft.name.trim()}
                className={BTN_PRIMARY}
              >
                {busy === 'header' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Save size={15} />
                )}
                {isNew ? 'Create the checklist' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>

      {isNew ? (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-4 text-sm text-[#6B5744]">
          Give the checklist a name and create it. It starts as a DRAFT, which nobody but an
          administrator can see — you then add the sections and questions, preview it on a phone, and
          publish it when it reads right.
        </div>
      ) : (
        tpl && (
          <>
            {/* ── warnings the server returned ───────────────────────────── */}
            {serverWarnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider text-amber-900">
                  Worth knowing about this setup
                </p>
                {serverWarnings.map((w, i) => (
                  <p key={i} className="text-sm text-amber-900 flex items-start gap-2">
                    <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                    <span className="min-w-0">{w}</span>
                  </p>
                ))}
              </div>
            )}

            {/* ── what this sheet demands ────────────────────────────────── */}
            <div className="grid sm:grid-cols-2 gap-4">
              <div
                className={`rounded-xl border p-4 ${
                  criticalCount
                    ? 'bg-red-50 border-red-200'
                    : 'bg-white border-[#E8D5C4]'
                }`}
              >
                <p
                  className={`text-xs font-bold uppercase tracking-wider ${
                    criticalCount ? 'text-red-800' : 'text-[#8B7355]'
                  }`}
                >
                  Critical questions
                </p>
                {criticalCount ? (
                  <p className="text-sm text-red-900 mt-1.5">
                    <strong>
                      {criticalCount} question{criticalCount === 1 ? '' : 's'} can fail the whole
                      check on {criticalCount === 1 ? 'its' : 'their'} own.
                    </strong>{' '}
                    If one of them fails, the check fails — the {tpl.pass_threshold_pct}% pass mark is
                    ignored entirely. That still holds for a question you switch off later: an answer
                    already recorded against it keeps counting in a round that is already under way.
                  </p>
                ) : (
                  <p className="text-sm text-[#6B5744] mt-1.5">
                    None. The check is judged only against the {tpl.pass_threshold_pct}% pass mark. Mark
                    a question critical when a single failure must fail the whole round — an
                    out-of-range cold room, for instance.
                  </p>
                )}
              </div>

              <div
                className={`rounded-xl border p-4 ${
                  photoAlways.length ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'
                }`}
              >
                <p
                  className={`text-xs font-bold uppercase tracking-wider ${
                    photoAlways.length ? 'text-amber-900' : 'text-[#8B7355]'
                  }`}
                >
                  Required evidence
                </p>
                {photoOwed.length === 0 ? (
                  <p className="text-sm text-[#6B5744] mt-1.5">
                    No question asks for a photograph. Notes and photographs are set on each question.
                  </p>
                ) : (
                  <p className="text-sm text-amber-900 mt-1.5">
                    {photoOwed.length} question{photoOwed.length === 1 ? '' : 's'} ask
                    {photoOwed.length === 1 ? 's' : ''} for a photograph
                    {photoAlways.length ? ` (${photoAlways.length} of them every single time)` : ''}.{' '}
                    <strong>
                      A photograph can only be attached on the phone runner, which is not built yet
                    </strong>{' '}
                    — so until it is, an answer that owes one is unfinished and the check cannot be
                    submitted. That is the engine protecting the record, not a bug, but it means a
                    checklist published today with a compulsory photograph cannot be completed today.
                  </p>
                )}
              </div>
            </div>

            {/* ── sections + questions ───────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-[#E8D5C4]">
              <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-0">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                    The sheet — sections and questions
                  </h2>
                  <p className="text-[11px] text-[#8B7355] mt-0.5">
                    Staff see them in this order. A question is never deleted once it has been
                    answered — it is switched off and kept.
                  </p>
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() =>
                        setSectionDraft({ title: '', code: '', description: '', is_active: true })
                      }
                      className={BTN_PLAIN}
                    >
                      <Plus size={15} /> Section
                    </button>
                    <button
                      onClick={() => setQuestionDraft(blankQuestion(''))}
                      className={BTN_PRIMARY}
                    >
                      <Plus size={15} /> Question
                    </button>
                  </div>
                )}
              </div>

              {tpl.questions.length === 0 && tpl.sections.length === 0 ? (
                <div className="p-10 text-center">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Nothing on the sheet yet</p>
                  <p className="text-xs text-[#8B7355] mt-1 max-w-md mx-auto">
                    Add a question and it appears here. Sections are optional — they group questions
                    under a heading, the way a paper form does.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[#E8D5C4]">
                  {groups.map((g, gi) => (
                    <div key={g.section?.id || 'ungrouped'} className="p-4 space-y-3">
                      {/* section heading */}
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3
                              className={`font-bold text-sm ${
                                g.section && !Number(g.section.is_active)
                                  ? 'text-[#8B7355] line-through'
                                  : 'text-[#2D1B0E]'
                              }`}
                            >
                              {g.section ? g.section.title : 'Not in a section'}
                            </h3>
                            {g.section?.code && (
                              <Chip>
                                <Hash size={11} /> {g.section.code}
                              </Chip>
                            )}
                            {g.section && !Number(g.section.is_active) && (
                              <Chip tone="gray">
                                <Ban size={11} /> Switched off
                              </Chip>
                            )}
                            <Chip>{g.questions.length} questions</Chip>
                          </div>
                          {g.section?.description && (
                            <p className="text-xs text-[#6B5744] mt-1">{g.section.description}</p>
                          )}
                          {!g.section && g.questions.length > 0 && (
                            <p className="text-xs text-[#8B7355] mt-1">
                              These questions have no heading above them. That is fine — a short
                              checklist often needs none.
                            </p>
                          )}
                        </div>
                        {editable && g.section && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => moveSection(g.section!.id, -1)}
                              disabled={gi === 0 || !!busy}
                              aria-label="Move section up"
                              className={BTN_ICON}
                            >
                              <ChevronUp size={15} />
                            </button>
                            <button
                              onClick={() => moveSection(g.section!.id, 1)}
                              disabled={!!busy || gi >= tpl.sections.length - 1}
                              aria-label="Move section down"
                              className={BTN_ICON}
                            >
                              <ChevronDown size={15} />
                            </button>
                            <button
                              onClick={() =>
                                setSectionDraft({
                                  id: g.section!.id,
                                  title: g.section!.title,
                                  code: g.section!.code,
                                  description: g.section!.description,
                                  is_active: !!Number(g.section!.is_active),
                                })
                              }
                              aria-label="Edit section"
                              className={BTN_ICON}
                            >
                              <PenLine size={15} />
                            </button>
                            <button
                              onClick={() =>
                                void setSectionActive(g.section!, !Number(g.section!.is_active))
                              }
                              disabled={!!busy}
                              title={
                                Number(g.section!.is_active)
                                  ? 'Switch this section off'
                                  : 'Put this section back on the sheet'
                              }
                              className={BTN_ICON}
                            >
                              {Number(g.section!.is_active) ? (
                                <Ban size={15} />
                              ) : (
                                <RotateCcw size={15} />
                              )}
                            </button>
                            <button
                              onClick={() => void deleteSection(g.section!)}
                              disabled={!!busy}
                              title="Remove this section (only while it holds no questions)"
                              className={`${BTN_ICON} text-red-700 hover:bg-red-50`}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* questions */}
                      {g.questions.length === 0 ? (
                        <p className="text-xs text-[#8B7355] italic">
                          No questions in this section yet.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {g.questions.map((q, qi) => (
                            <QuestionCard
                              key={q.id}
                              q={q}
                              index={qi}
                              last={qi === g.questions.length - 1}
                              editable={editable}
                              busy={busy}
                              sections={tpl.sections}
                              passMark={tpl.pass_threshold_pct}
                              onUp={() => moveQuestion(q, -1)}
                              onDown={() => moveQuestion(q, 1)}
                              onEdit={() => setQuestionDraft(draftFromQuestion(q))}
                              onToggleActive={() => void setQuestionActive(q, !Number(q.is_active))}
                              onDelete={() => void deleteQuestion(q)}
                              onMoveSection={(sid) => void moveQuestionToSection(q, sid)}
                            />
                          ))}
                        </ul>
                      )}

                      {editable && (
                        <button
                          onClick={() => setQuestionDraft(blankQuestion(g.section?.id || ''))}
                          className="text-sm text-[#af4408] hover:underline inline-flex items-center gap-1"
                        >
                          <Plus size={14} /> Add a question
                          {g.section ? ` to “${g.section.title}”` : ' here'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── lifecycle ─────────────────────────────────────────────── */}
            {editable && (
              <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 space-y-3">
                <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                  Publishing
                </h2>
                <p className="text-sm text-[#6B5744]">
                  {tpl.status === 'draft' &&
                    'A draft is yours alone — staff cannot see it or run it. Publish it when the sheet reads the way you want it read.'}
                  {tpl.status === 'published' &&
                    (tpl.run_count > 0
                      ? `This is live, and ${tpl.run_count} check${tpl.run_count === 1 ? ' has' : 's have'} been recorded against it. It can no longer go back to a draft — archive it instead, and the records stay readable.`
                      : 'This is live and nobody has run it yet, so it can still go back to a draft.')}
                  {tpl.status === 'archived' &&
                    'Archived: no new checks can be started, every record already taken stays readable, and its standing assignments were stood down. Restoring brings it back as a draft, on purpose, so you read it again before publishing.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {tpl.status !== 'published' && tpl.status !== 'archived' && (
                    <button
                      onClick={() =>
                        void lifecycle(
                          'publish',
                          `Publish "${tpl.name}"?\n\nStaff will be able to run it from now on. ` +
                            'It must have at least one question, and no question of a kind the app does not know.',
                        )
                      }
                      disabled={!!busy || activeQuestions.length === 0}
                      title={
                        activeQuestions.length === 0
                          ? 'Add a question first — there would be nothing to run.'
                          : undefined
                      }
                      className={BTN_PRIMARY}
                    >
                      {busy === 'publish' ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Send size={15} />
                      )}{' '}
                      Publish
                    </button>
                  )}
                  {tpl.status === 'published' && (
                    <button
                      onClick={() =>
                        void lifecycle(
                          'unpublish',
                          `Take "${tpl.name}" back to a draft?\n\nStaff will no longer see it. This is only possible while it has never been run.`,
                        )
                      }
                      disabled={!!busy}
                      className={BTN_PLAIN}
                    >
                      <Undo2 size={15} /> Back to a draft
                    </button>
                  )}
                  {tpl.status === 'archived' ? (
                    <button
                      onClick={() =>
                        void lifecycle(
                          'restore',
                          `Bring "${tpl.name}" back?\n\nIt returns as a DRAFT, not as a live checklist, so you can read it through and publish it deliberately.`,
                        )
                      }
                      disabled={!!busy}
                      className={BTN_PLAIN}
                    >
                      <RotateCcw size={15} /> Restore as a draft
                    </button>
                  ) : (
                    <button
                      onClick={() => setArchiveOpen(true)}
                      disabled={!!busy}
                      className={`${BTN_PLAIN} text-red-700 border-red-200 hover:bg-red-50`}
                    >
                      <Ban size={15} /> Archive
                    </button>
                  )}
                  <button onClick={() => void duplicate()} disabled={!!busy} className={BTN_PLAIN}>
                    {busy === 'duplicate' ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Copy size={15} />
                    )}{' '}
                    Make a copy
                  </button>
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Nothing here deletes anything. A checklist with records against it is archived, and
                  the refusal to delete it is itself recorded.
                </p>
              </div>
            )}
          </>
        )
      )}

      <BackLinks />

      {/* ── modals ───────────────────────────────────────────────────────── */}
      {sectionDraft && (
        <SectionEditor
          draft={sectionDraft}
          busy={busy === 'section'}
          onChange={setSectionDraft}
          onClose={() => setSectionDraft(null)}
          onSave={() => void saveSection(sectionDraft)}
        />
      )}

      {questionDraft && (
        <QuestionEditor
          draft={questionDraft}
          sections={tpl?.sections || []}
          passMark={Number(tpl?.pass_threshold_pct ?? 100)}
          busy={busy === 'question'}
          onChange={setQuestionDraft}
          onClose={() => setQuestionDraft(null)}
          onSave={() => void saveQuestion(questionDraft)}
        />
      )}

      {archiveOpen && tpl && (
        <ArchiveModal
          name={tpl.name}
          runCount={tpl.run_count}
          assignmentCount={tpl.assignment_count}
          busy={busy === 'archive'}
          onClose={() => setArchiveOpen(false)}
          onConfirm={(reason) => void archive(reason)}
        />
      )}

      {previewOpen && tpl && (
        <PreviewSheet
          template={tpl}
          meName={meName}
          onClose={() => setPreviewOpen(false)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[92vw] text-center">
          {toast}
        </div>
      )}
    </Screen>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * PIECES
 * ══════════════════════════════════════════════════════════════════════════ */

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">{children}</div>
    </div>
  );
}

function BackLinks() {
  return (
    <div className="flex flex-wrap items-center gap-4 pt-1">
      <a
        href="/fssai/settings"
        className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Compliance Settings
      </a>
      <a
        href="/fssai/checklists"
        className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline"
      >
        FSSAI Checklists <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}

function Facts({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-[#8B7355]">{label}</dt>
      <dd className="text-sm text-[#3D2614] mt-0.5 break-words">{value}</dd>
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  bumps,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  bumps?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#2D1B0E]">
          {label}
          {bumps && (
            <span className="ml-1.5 inline-flex items-center align-middle text-[10px] font-semibold px-1.5 py-[1px] rounded-full border bg-[#FFF1E3] text-[#8a3606] border-[#E8D5C4]">
              version
            </span>
          )}
        </p>
        {hint && <p className="text-[11px] text-[#8B7355] mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

/** One question on the builder's sheet, with everything it demands visible. */
function QuestionCard({
  q,
  index,
  last,
  editable,
  busy,
  sections,
  passMark,
  onUp,
  onDown,
  onEdit,
  onToggleActive,
  onDelete,
  onMoveSection,
}: {
  q: QuestionRow;
  index: number;
  last: boolean;
  editable: boolean;
  busy: string;
  sections: SectionRow[];
  passMark: number;
  onUp: () => void;
  onDown: () => void;
  onEdit: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onMoveSection: (sectionId: string) => void;
}) {
  const retired = !Number(q.is_active);
  const meta = qtypeMeta(q.qtype);
  return (
    <li
      className={`rounded-lg border p-3 ${
        retired
          ? 'bg-gray-50 border-gray-200'
          : Number(q.is_critical)
            ? 'bg-white border-red-200'
            : 'bg-white border-[#E8D5C4]'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="text-xs font-bold text-[#8B7355] w-5 shrink-0 mt-0.5">{index + 1}.</span>
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-medium break-words ${
              retired ? 'text-[#8B7355] line-through' : 'text-[#2D1B0E]'
            }`}
          >
            {q.prompt}
          </p>
          {q.help_text && <p className="text-xs text-[#6B5744] mt-0.5">{q.help_text}</p>}

          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {q.qtype_known ? (
              <Chip>{q.qtype_label || meta?.label || q.qtype}</Chip>
            ) : (
              <Chip tone="red" title="This build cannot draw this kind of answer.">
                <FileWarning size={11} /> Unknown kind: {q.qtype}
              </Chip>
            )}
            {retired && (
              <Chip tone="gray">
                <Ban size={11} /> Switched off
              </Chip>
            )}
            {!!Number(q.is_critical) && (
              <Chip
                tone="red"
                title={`A failure here fails the whole check — the ${passMark}% pass mark is ignored.`}
              >
                <AlertTriangle size={11} /> Critical
              </Chip>
            )}
            <Chip tone={Number(q.is_required) ? 'plain' : 'gray'}>
              {Number(q.is_required) ? 'Must be answered' : 'Optional'}
            </Chip>
            {!Number(q.allow_na) && <Chip tone="gray">No “not applicable”</Chip>}
            {q.photo_rule !== 'never' && (
              <Chip tone="amber">
                <Camera size={11} /> Photo: {evidenceLabel(q.photo_rule)}
              </Chip>
            )}
            {q.note_rule !== 'never' && (
              <Chip tone="amber">
                <MessageSquare size={11} /> Note: {evidenceLabel(q.note_rule)}
              </Chip>
            )}
            {meta?.usesRange && (q.min_value !== null || q.max_value !== null) && (
              <Chip>
                <Thermometer size={11} />
                {q.min_value !== null ? fssaiDisplayReading(q.min_value, q.decimals) : '…'} –{' '}
                {q.max_value !== null ? fssaiDisplayReading(q.max_value, q.decimals) : '…'}
                {q.uom ? ` ${q.uom}` : ''}
              </Chip>
            )}
            {meta?.usesRange && q.target_value !== null && (
              <Chip>Target {fssaiDisplayReading(q.target_value, q.decimals)}</Chip>
            )}
            {meta?.usesExpected && q.expected_value && (
              <Chip tone="green">
                <BadgeCheck size={11} /> Passes on “{q.expected_value}”
              </Chip>
            )}
            {meta?.usesOptions && (
              <Chip>
                {q.options.length} answers
                {q.fail_options.length ? `, ${q.fail_options.length} count as a fail` : ''}
              </Chip>
            )}
            {!!Number(q.raise_ca_on_fail) && (
              <Chip tone="purple">Raises a corrective action ({q.ca_severity})</Chip>
            )}
            {q.code && (
              <Chip>
                <Hash size={11} /> {q.code}
              </Chip>
            )}
          </div>

          {retired && (
            <p className="text-[11px] text-[#6B5744] mt-2">
              Off every future check. Every answer already given to it stays in its record exactly as
              it was asked — and in a check that is open right now it still counts towards the
              verdict
              {Number(q.is_critical)
                ? ', including failing that whole round on its own, because it is critical'
                : ''}
              .
            </p>
          )}
        </div>

        {editable && (
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                onClick={onUp}
                disabled={index === 0 || !!busy}
                aria-label="Move question up"
                className={BTN_ICON}
              >
                <ChevronUp size={15} />
              </button>
              <button
                onClick={onDown}
                disabled={last || !!busy}
                aria-label="Move question down"
                className={BTN_ICON}
              >
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={onEdit} aria-label="Edit question" className={BTN_ICON}>
                <PenLine size={15} />
              </button>
              <button
                onClick={onToggleActive}
                disabled={!!busy}
                title={retired ? 'Put this question back on the sheet' : 'Switch this question off'}
                className={BTN_ICON}
              >
                {retired ? <RotateCcw size={15} /> : <Ban size={15} />}
              </button>
              <button
                onClick={onDelete}
                disabled={!!busy}
                title="Remove (only really deleted if it has never been answered)"
                className={`${BTN_ICON} text-red-700 hover:bg-red-50`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {editable && sections.length > 0 && (
        <div className="mt-2 pl-8">
          <label className="inline-flex items-center gap-2 text-[11px] text-[#8B7355]">
            Section
            <select
              value={q.section_id || ''}
              onChange={(e) => onMoveSection(e.target.value)}
              disabled={!!busy}
              className="bg-white border border-[#D4B896] rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[#af4408]"
            >
              <option value="">Not in a section</option>
              {[...sections]
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {Number(s.is_active) ? '' : ' (switched off)'}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
    </li>
  );
}

function SectionEditor({
  draft,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  draft: SectionDraft;
  busy: boolean;
  onChange: (d: SectionDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const codeBad = !!draft.code && !/^[A-Za-z0-9._-]{2,48}$/.test(draft.code);
  return (
    <Modal
      title={draft.id ? 'Edit the section' : 'Add a section'}
      subtitle="A heading that groups questions, the way a paper form does. Every change here raises the checklist version."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={busy || !draft.title.trim() || codeBad}
            className={BTN_PRIMARY}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
          </button>
        </>
      }
    >
      <Field label="Heading" required>
        <input
          className={INPUT}
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
          placeholder="Before service"
        />
      </Field>
      <Field
        label="Code"
        hint="Optional, and unique within this checklist. Only needed if something else has to refer to this section by name."
      >
        <input
          className={`${INPUT} font-mono`}
          value={draft.code}
          onChange={(e) => onChange({ ...draft, code: e.target.value })}
        />
      </Field>
      {codeBad && (
        <p className="text-sm text-red-700">
          A code may only contain letters, numbers, dots, dashes and underscores (2-48 characters).
        </p>
      )}
      <Field label="Description" hint="Shown under the heading while staff fill it in.">
        <textarea
          rows={2}
          className={INPUT}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </Field>
      {draft.id && (
        <SwitchRow
          label="On the sheet"
          hint="Switch it off to take the section and its questions off every future check. Nothing recorded changes."
          checked={draft.is_active}
          onChange={(v) => onChange({ ...draft, is_active: v })}
        />
      )}
    </Modal>
  );
}

/**
 * THE QUESTION EDITOR — all eight types, each with the settings that type
 * actually has, and the server's own validator running live underneath.
 */
function QuestionEditor({
  draft,
  sections,
  passMark,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  draft: QuestionDraft;
  sections: SectionRow[];
  passMark: number;
  busy: boolean;
  onChange: (d: QuestionDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const meta = qtypeMeta(draft.qtype);
  const set = (patch: Partial<QuestionDraft>) => onChange({ ...draft, ...patch });

  /* normalizeFssaiQuestion is the API's OWN validator, imported not copied — so
   * the sentence below is the sentence the save would have been refused with. */
  const check = useMemo(
    () =>
      normalizeFssaiQuestion({
        qtype: draft.qtype,
        prompt: draft.prompt,
        help_text: draft.help_text,
        code: draft.code,
        uom: draft.uom,
        min_value: draft.min_value,
        max_value: draft.max_value,
        target_value: draft.target_value,
        decimals: draft.decimals,
        expected_value: draft.expected_value,
        options: draft.options,
        fail_options: draft.fail_options,
        is_required: draft.is_required ? 1 : 0,
        is_critical: draft.is_critical ? 1 : 0,
        allow_na: draft.allow_na ? 1 : 0,
        photo_rule: draft.photo_rule,
        note_rule: draft.note_rule,
        raise_ca_on_fail: draft.raise_ca_on_fail ? 1 : 0,
        ca_severity: draft.ca_severity,
      }),
    [draft],
  );

  const boolWords: [string, string] = draft.qtype === 'pass_fail' ? ['pass', 'fail'] : ['yes', 'no'];
  /* The two corrections normalizeFssaiQuestion applies silently, said out loud
   * here instead so nothing is changed behind his back. */
  const photoForced = draft.qtype === 'photo';
  const noteRuleOptions = FSSAI_EVIDENCE_RULES.filter(
    (r) => !(draft.qtype === 'text' && r.key === 'on_fail'),
  );

  return (
    <Modal
      wide
      title={draft.id ? 'Edit the question' : 'Add a question'}
      subtitle="Every change here raises the checklist version. Checks already recorded keep the version they were taken under."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>
            Cancel
          </button>
          <button onClick={onSave} disabled={busy || !check.ok} className={BTN_PRIMARY}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
          </button>
        </>
      }
    >
      {/* the question itself */}
      <Field label="What staff are asked" required>
        <textarea
          rows={2}
          className={INPUT}
          value={draft.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          placeholder="Is the cold room door seal clean and intact?"
        />
      </Field>
      <Field label="Help" hint="One line of guidance shown under the question.">
        <input
          className={INPUT}
          value={draft.help_text}
          onChange={(e) => set({ help_text: e.target.value })}
        />
      </Field>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Kind of answer" required hint={meta?.hint}>
          <select
            className={INPUT}
            value={draft.qtype}
            onChange={(e) => set({ qtype: e.target.value as FssaiQType })}
          >
            {FSSAI_QTYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Section" hint="Where it sits on the sheet.">
          <select
            className={INPUT}
            value={draft.section_id}
            onChange={(e) => set({ section_id: e.target.value })}
            disabled={!!draft.id}
          >
            <option value="">Not in a section</option>
            {[...sections]
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                  {Number(s.is_active) ? '' : ' (switched off)'}
                </option>
              ))}
          </select>
          {draft.id && (
            <span className="block text-[11px] text-[#8B7355] mt-1">
              Move an existing question with the Section picker on its row.
            </span>
          )}
        </Field>
      </div>

      {/* ── the two-button types ─────────────────────────────────────────── */}
      {meta?.usesExpected && (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
          <p className="text-xs font-semibold text-[#6B5744]">Which answer counts as a pass?</p>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {boolWords.map((w) => {
              const on = (draft.expected_value || boolWords[0]) === w;
              const good = w === boolWords[0];
              return (
                <button
                  key={w}
                  type="button"
                  onClick={() => set({ expected_value: w })}
                  className={`min-h-[44px] rounded-lg border text-sm font-semibold capitalize transition-colors ${
                    on
                      ? good
                        ? 'bg-green-600 text-white border-green-600'
                        : 'bg-red-600 text-white border-red-600'
                      : good
                        ? 'bg-white text-green-700 border-green-200 hover:border-green-400'
                        : 'bg-white text-red-700 border-red-200 hover:border-red-400'
                  }`}
                >
                  {w}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[#8B7355] mt-2">
            Staff see two buttons. Anything else typed in — “maybe”, a blank — is refused by name
            rather than quietly counted as a failure.
          </p>
        </div>
      )}

      {/* ── the range types ─────────────────────────────────────────────── */}
      {meta?.usesRange && (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-[#6B5744]">
            The acceptable range
            {draft.qtype === 'temperature'
              ? ' — never written into the software, always yours to set'
              : ''}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Lowest allowed">
              <input
                inputMode="decimal"
                className={INPUT}
                value={draft.min_value}
                onChange={(e) => set({ min_value: e.target.value.replace(/[^0-9.\-]/g, '') })}
                placeholder="blank = no limit"
              />
            </Field>
            <Field label="Highest allowed">
              <input
                inputMode="decimal"
                className={INPUT}
                value={draft.max_value}
                onChange={(e) => set({ max_value: e.target.value.replace(/[^0-9.\-]/g, '') })}
                placeholder="blank = no limit"
              />
            </Field>
            <Field label="Target">
              <input
                inputMode="decimal"
                className={INPUT}
                value={draft.target_value}
                onChange={(e) => set({ target_value: e.target.value.replace(/[^0-9.\-]/g, '') })}
                placeholder="optional"
              />
            </Field>
            <Field label="Unit">
              <input
                className={INPUT}
                value={draft.uom}
                onChange={(e) => set({ uom: e.target.value })}
                placeholder={draft.qtype === 'temperature' ? 'C' : 'kg'}
              />
            </Field>
          </div>
          <Field
            label="Decimal places"
            hint="How the reading is written down and shown. It is NEVER used before the range test — rounding first would let 5.4 pass a 0-5 rule."
          >
            <select
              className={INPUT}
              value={draft.decimals}
              onChange={(e) => set({ decimals: e.target.value })}
            >
              {['0', '1', '2', '3'].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11px] text-[#8B7355]">
            A blank reading is not zero. If nobody takes the reading the answer is missing, not 0
            {draft.uom ? ` ${draft.uom}` : ''}.
          </p>
        </div>
      )}

      {/* ── multiple choice ─────────────────────────────────────────────── */}
      {meta?.usesOptions && (
        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-[#6B5744]">
            The answers staff choose from, and which of them count as a fail
          </p>
          {draft.options.length === 0 && (
            <p className="text-[11px] text-[#8B7355]">
              At least two answers, at most twelve, and at least one of them must be a pass.
            </p>
          )}
          <ul className="space-y-2">
            {draft.options.map((opt, i) => {
              const isFail = draft.fail_options.includes(opt);
              return (
                <li key={i} className="flex items-center gap-2">
                  <input
                    className="flex-1 min-w-0 bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]"
                    value={opt}
                    onChange={(e) => {
                      const next = [...draft.options];
                      const old = next[i];
                      next[i] = e.target.value;
                      set({
                        options: next,
                        fail_options: draft.fail_options.map((f) => (f === old ? e.target.value : f)),
                      });
                    }}
                    placeholder={`Answer ${i + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      set({
                        fail_options: isFail
                          ? draft.fail_options.filter((f) => f !== opt)
                          : [...draft.fail_options, opt],
                      })
                    }
                    className={`min-h-[36px] px-3 rounded-lg border text-xs font-semibold shrink-0 ${
                      isFail
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-white text-red-700 border-red-200 hover:border-red-400'
                    }`}
                  >
                    {isFail ? 'Counts as a fail' : 'Mark as a fail'}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove this answer"
                    onClick={() =>
                      set({
                        options: draft.options.filter((_, k) => k !== i),
                        fail_options: draft.fail_options.filter((f) => f !== opt),
                      })
                    }
                    className={`${BTN_ICON} text-red-700 hover:bg-red-50 shrink-0`}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => set({ options: [...draft.options, ''] })}
            disabled={draft.options.length >= 12}
            className={BTN_PLAIN}
          >
            <Plus size={15} /> Add an answer
          </button>
        </div>
      )}

      {draft.qtype === 'signature' && (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-sm text-[#6B5744]">
          A signature here is the signed-in person and the time — there is no drawn signature. Whether
          that is enough for your inspector is still an open question for you to settle.
        </div>
      )}

      {draft.qtype === 'photo' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          The photograph <strong>is</strong> the answer to this question, so it is always required.
          Photographs can only be taken on the phone runner, which is not built yet — until it is, a
          check containing this question cannot be submitted.
        </div>
      )}

      {/* ── how it is judged ────────────────────────────────────────────── */}
      <div className="grid sm:grid-cols-2 gap-3">
        <SwitchRow
          label="Must be answered"
          hint="A check cannot be submitted while a required question is unanswered."
          checked={draft.is_required}
          onChange={(v) => set({ is_required: v })}
        />
        <SwitchRow
          label="“Not applicable” is allowed"
          hint="Left out of the pass percentage entirely — three N/A out of ten is not 70% compliant, it is 100% of what applied."
          checked={draft.allow_na}
          onChange={(v) => set({ allow_na: v })}
        />
      </div>

      <div
        className={`rounded-lg border p-3 ${
          draft.is_critical ? 'bg-red-50 border-red-200' : 'bg-[#FFF8F0] border-[#E8D5C4]'
        }`}
      >
        <div className="flex items-start gap-3">
          <Toggle
            checked={draft.is_critical}
            onChange={(v) => set({ is_critical: v })}
            label="Critical"
          />
          <div className="min-w-0">
            <p className={`text-sm font-medium ${draft.is_critical ? 'text-red-900' : 'text-[#2D1B0E]'}`}>
              Critical — one failure fails the whole check
            </p>
            {draft.is_critical ? (
              <p className="text-[11px] text-red-800 mt-1">
                If this answer fails, the entire check is recorded as failed and the {passMark}% pass
                mark is ignored. That still happens if you switch this question off later: an answer
                already recorded against it keeps counting in a round that is already under way, and
                a failure already recorded still fails that whole round. Nothing anyone recorded
                leaves the verdict.
              </p>
            ) : (
              <p className="text-[11px] text-[#8B7355] mt-1">
                Off: a failure here only costs the check its share of the {passMark}% pass mark.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── required evidence ──────────────────────────────────────────── */}
      <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
        <p className="text-xs font-semibold text-[#6B5744]">
          Required evidence — what an answer must come with
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="A photograph" hint={photoForced ? 'The photograph is the answer.' : undefined}>
            <select
              className={INPUT}
              value={photoForced ? 'always' : draft.photo_rule}
              disabled={photoForced}
              onChange={(e) => set({ photo_rule: e.target.value as FssaiEvidenceRule })}
            >
              {FSSAI_EVIDENCE_RULES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="A written note"
            hint={
              draft.qtype === 'text'
                ? 'A text answer never fails on its own, so “only when it fails” does not apply to it.'
                : undefined
            }
          >
            <select
              className={INPUT}
              value={draft.note_rule}
              onChange={(e) => set({ note_rule: e.target.value as FssaiEvidenceRule })}
            >
              {noteRuleOptions.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-[11px] text-[#8B7355]">
          An answer that still owes a photograph or a note is <strong>unfinished</strong>, not a
          failure — the check simply cannot be submitted until it is there, and the refusal names
          what it is waiting for. A passing fridge is never recorded as a failure because the
          paperwork was incomplete.
        </p>
        {(draft.photo_rule !== 'never' || photoForced) && (
          <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2">
            Photographs are taken on the phone runner, which is not built yet. Until it is, this
            question cannot be completed and the check cannot be submitted.
          </p>
        )}
      </div>

      {/* ── corrective action ──────────────────────────────────────────── */}
      <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
        <SwitchRow
          label="Raise a corrective action when it fails"
          hint="A job to put it right, raised automatically against the failed check."
          checked={draft.raise_ca_on_fail}
          onChange={(v) => set({ raise_ca_on_fail: v })}
        />
        {draft.raise_ca_on_fail && (
          <Field label="How urgent">
            <select
              className={INPUT}
              value={draft.ca_severity}
              onChange={(e) => set({ ca_severity: e.target.value })}
            >
              {CA_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="text-[11px] text-[#8B7355]">
          Corrective actions are raised and tracked in the Corrective Actions screen, which is not
          built yet — the setting is recorded now and starts acting when that screen ships.
        </p>
      </div>

      <Field
        label="Code"
        hint="Optional, and unique within this checklist. Only needed when something else must refer to this exact question."
      >
        <input
          className={`${INPUT} font-mono`}
          value={draft.code}
          onChange={(e) => set({ code: e.target.value })}
        />
      </Field>

      {draft.id && (
        <SwitchRow
          label="On the sheet"
          hint="Switch it off to take it off every future check. Answers already recorded are kept, and still count in any check open right now."
          checked={draft.is_active}
          onChange={(v) => set({ is_active: v })}
        />
      )}

      {!check.ok && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span className="min-w-0">{check.error}</span>
        </div>
      )}
    </Modal>
  );
}

function ArchiveModal({
  name,
  runCount,
  assignmentCount,
  busy,
  onClose,
  onConfirm,
}: {
  name: string;
  runCount: number;
  assignmentCount: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={`Archive “${name}”?`}
      subtitle="Nothing is deleted. This is the lawful way to retire a checklist that has been used."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>
            Keep it live
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || reason.trim().length < 4}
            className={`${BTN_PRIMARY} bg-red-700 hover:bg-red-800`}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />} Archive it
          </button>
        </>
      }
    >
      <ul className="space-y-2 text-sm text-[#3D2614]">
        <li className="flex gap-2">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
          No new check can be started against it.
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
          {runCount} check{runCount === 1 ? '' : 's'} already recorded stay readable, exactly as they
          were taken.
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
          {assignmentCount} standing assignment{assignmentCount === 1 ? '' : 's'} will be stood down
          with it, so it stops appearing in anyone&apos;s list of what is due. They are kept, not
          deleted.
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#af4408] shrink-0" />
          You can restore it later — it comes back as a draft, so it must be published again
          deliberately.
        </li>
      </ul>
      <Field label="Why is it being archived?" required hint="Recorded against the checklist.">
        <input
          className={INPUT}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Replaced by the new closing round"
        />
      </Field>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * THE PREVIEW — the sheet as staff will see it, recording nothing
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * WHY THIS IS SAFE TO CALL A PREVIEW. It opens no run and posts nothing: the
 * answers live in the `answers` map below and die with the modal. It reaches its
 * verdicts with evaluateFssaiAnswer and summariseFssaiRun — the engine's own
 * functions, imported from the same pure module the submit path imports — and it
 * counts an UNTOUCHED question the way submit counts one: on the sheet,
 * unanswered, and NOT a failure (runs/route.ts:710-719). So it neither writes a
 * record nor flatters one.
 */
function PreviewSheet({
  template,
  meName,
  onClose,
}: {
  template: TemplateRow;
  meName: string;
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, PreviewAnswer>>({});

  const sheet = useMemo(() => {
    const sections = template.sections
      .filter((s) => Number(s.is_active))
      .sort((a, b) => a.sort_order - b.sort_order);
    const ids = new Set(sections.map((s) => s.id));
    const live = template.questions.filter((q) => Number(q.is_active));
    const out: { section: SectionRow | null; questions: QuestionRow[] }[] = sections.map((s) => ({
      section: s,
      questions: live.filter((q) => q.section_id === s.id),
    }));
    const loose = live.filter((q) => !q.section_id || !ids.has(String(q.section_id)));
    if (loose.length) out.push({ section: null, questions: loose });
    return out.filter((g) => g.questions.length > 0);
  }, [template]);

  const liveQuestions = useMemo(() => sheet.flatMap((g) => g.questions), [sheet]);

  const verdicts = useMemo(() => {
    const m = new Map<string, FssaiVerdict | null>();
    for (const q of liveQuestions) {
      const a = answers[q.id];
      if (!a) {
        m.set(q.id, null); // untouched — the submit path counts it exactly so
        continue;
      }
      m.set(
        q.id,
        evaluateFssaiAnswer(
          {
            qtype: q.qtype,
            is_required: q.is_required,
            allow_na: q.allow_na,
            min_value: q.min_value,
            max_value: q.max_value,
            expected_value: q.expected_value,
            options: q.options,
            fail_options: q.fail_options,
            photo_rule: q.photo_rule,
            note_rule: q.note_rule,
          },
          { ...a, evidence_count: 0 },
        ),
      );
    }
    return m;
  }, [liveQuestions, answers]);

  const facts = liveQuestions.map((q) => {
    const v = verdicts.get(q.id);
    return {
      is_fail: v ? (v.is_fail ? 1 : 0) : 0,
      is_na: answers[q.id]?.is_na ? 1 : 0,
      answered: !!v?.answered,
    };
  });
  const criticalFailed = liveQuestions.some(
    (q) => Number(q.is_critical) && verdicts.get(q.id)?.is_fail,
  );
  const summary = summariseFssaiRun(facts, Number(template.pass_threshold_pct ?? 100), criticalFailed);
  const blocking = liveQuestions.filter(
    (q) => Number(q.is_required) && !verdicts.get(q.id)?.answered,
  );

  function put(id: string, patch: PreviewAnswer) {
    setAnswers((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }
  function clear(id: string) {
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  return (
    <Modal
      wide
      title="Preview — how staff will see it"
      subtitle="Nothing on this sheet is recorded. Close it and every answer here is gone."
      onClose={onClose}
      footer={
        <>
          <button onClick={() => setAnswers({})} className={BTN_PLAIN}>
            <RotateCcw size={15} /> Clear the preview
          </button>
          <button onClick={onClose} className={BTN_PRIMARY}>
            Close
          </button>
        </>
      }
    >
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex items-start gap-2">
        <Eye size={16} className="shrink-0 mt-0.5" />
        <span>
          <strong>This is a preview.</strong> It opens no check, writes no answer and leaves no
          record — it is here so you can read the sheet the way the person holding the phone will
          read it. The verdicts are worked out with the same code the real check uses, so what it
          says here is what it would say there.
        </span>
      </div>

      {/* the phone */}
      <div className="mx-auto w-full max-w-[420px] rounded-3xl border-4 border-[#2D1B0E] bg-[#FFF8F0] overflow-hidden">
        <div className="bg-[#2D1B0E] text-white text-[11px] text-center py-1">
          Preview · nothing is recorded
        </div>
        <div className="p-3 space-y-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
              {freqLabel(template.frequency)} · {targetLabel(template.target_kind)}
            </p>
            <h3 className="text-lg font-bold text-[#af4408] break-words">{template.name}</h3>
            {template.description && (
              <p className="text-xs text-[#6B5744] mt-1">{template.description}</p>
            )}
          </div>

          {sheet.length === 0 ? (
            <p className="text-sm text-[#8B7355] py-6 text-center">
              Every question is switched off, so staff would be handed an empty sheet.
            </p>
          ) : (
            sheet.map((g) => (
              <div key={g.section?.id || 'loose'} className="space-y-2">
                {g.section && (
                  <div className="pt-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                      {g.section.title}
                    </p>
                    {g.section.description && (
                      <p className="text-[11px] text-[#8B7355]">{g.section.description}</p>
                    )}
                  </div>
                )}
                {g.questions.map((q) => (
                  <PreviewQuestion
                    key={q.id}
                    q={q}
                    answer={answers[q.id]}
                    verdict={verdicts.get(q.id) || null}
                    meName={meName}
                    onAnswer={(patch) => put(q.id, patch)}
                    onClear={() => clear(q.id)}
                  />
                ))}
              </div>
            ))
          )}

          {/* the sticky-bottom submit bar, deliberately inert */}
          {sheet.length > 0 && (
            <div className="pt-2">
              <div className="rounded-lg border border-[#E8D5C4] bg-white p-3 space-y-2">
                <div className="flex items-center justify-between text-xs text-[#6B5744]">
                  <span>
                    {summary.answered_count} of {liveQuestions.length} answered
                  </span>
                  <span>
                    {summary.fail_count} fail{summary.fail_count === 1 ? '' : 's'} ·{' '}
                    {summary.na_count} not applicable
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">
                    {summary.pass_pct}% of what was judged passed
                  </span>
                  <Chip tone={summary.outcome === 'pass' ? 'green' : 'red'}>
                    Would be {summary.outcome === 'pass' ? 'a PASS' : 'a FAIL'}
                  </Chip>
                </div>
                {criticalFailed && (
                  <p className="text-[11px] text-red-800">
                    A critical question failed, so the whole check fails and the{' '}
                    {template.pass_threshold_pct}% pass mark is ignored.
                  </p>
                )}
                {blocking.length > 0 && (
                  <p className="text-[11px] text-amber-900">
                    {blocking.length} question{blocking.length === 1 ? '' : 's'} still need
                    {blocking.length === 1 ? 's' : ''} an answer before a real check could be
                    submitted
                    {blocking.some((q) => verdicts.get(q.id)?.needs_photo)
                      ? ' — including one waiting for a photograph, which only the phone runner can attach'
                      : ''}
                    .
                  </p>
                )}
                {Number(template.requires_signature) === 1 && (
                  <p className="text-[11px] text-[#8B7355]">
                    A real check is signed by the person filling it in
                    {meName ? ` — that would be ${meName}` : ''}, with the time.
                  </p>
                )}
                <button
                  type="button"
                  disabled
                  title="Submitting is deliberately impossible in a preview."
                  className="w-full inline-flex items-center justify-center gap-2 bg-[#af4408] text-white text-sm font-semibold rounded-lg px-4 py-3 opacity-50 cursor-not-allowed"
                >
                  <Lock size={16} /> Submit — disabled in a preview
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PreviewQuestion({
  q,
  answer,
  verdict,
  meName,
  onAnswer,
  onClear,
}: {
  q: QuestionRow;
  answer?: PreviewAnswer;
  verdict: FssaiVerdict | null;
  meName: string;
  onAnswer: (patch: PreviewAnswer) => void;
  onClear: () => void;
}) {
  const meta = qtypeMeta(q.qtype);
  const na = !!answer?.is_na;
  const step = Number(q.decimals) > 0 ? 0.5 : 1;

  function nudge(delta: number) {
    const base = typeof answer?.value_num === 'number' ? answer.value_num : 0;
    onAnswer({ value_num: Number((base + delta).toFixed(3)), is_na: false });
  }

  const boolWords: [string, string] = q.qtype === 'pass_fail' ? ['Pass', 'Fail'] : ['Yes', 'No'];

  return (
    <div
      className={`rounded-lg border p-3 ${
        verdict?.is_fail ? 'bg-red-50 border-red-200' : 'bg-white border-[#E8D5C4]'
      }`}
    >
      <p className="text-sm font-medium text-[#2D1B0E]">
        {q.prompt}
        {Number(q.is_required) === 1 && <span className="text-[#af4408]"> *</span>}
      </p>
      {q.help_text && <p className="text-[11px] text-[#6B5744] mt-0.5">{q.help_text}</p>}
      {Number(q.is_critical) === 1 && (
        <p className="text-[11px] text-red-800 mt-1 font-semibold">
          Critical — a failure here fails the whole check.
        </p>
      )}

      {!meta ? (
        <p className="mt-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-2">
          This app does not know the answer type “{q.qtype}”, so it will not draw a box for it. Fix
          the question before publishing.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {/* two-button */}
          {meta.value === 'bool' && (
            <div className="grid grid-cols-2 gap-2">
              {[true, false].map((b, i) => {
                const on = answer?.value_bool === b && !na;
                const good = i === 0;
                return (
                  <button
                    key={String(b)}
                    type="button"
                    onClick={() => onAnswer({ value_bool: b, is_na: false })}
                    className={`min-h-[44px] rounded-lg border text-sm font-semibold ${
                      on
                        ? good
                          ? 'bg-green-600 text-white border-green-600'
                          : 'bg-red-600 text-white border-red-600'
                        : good
                          ? 'bg-white text-green-700 border-green-200 hover:border-green-400'
                          : 'bg-white text-red-700 border-red-200 hover:border-red-400'
                    }`}
                  >
                    {boolWords[i]}
                  </button>
                );
              })}
            </div>
          )}

          {/* number / temperature */}
          {meta.value === 'num' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => nudge(-step)}
                aria-label="Lower"
                className="w-11 h-11 shrink-0 rounded-xl border border-[#D4B896] bg-white active:scale-95 inline-flex items-center justify-center"
              >
                <Minus size={18} />
              </button>
              <input
                value={answer?.value_num === null || answer?.value_num === undefined ? '' : String(answer.value_num)}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9.\-]/g, '');
                  // A blank reading is NOT zero — it is no reading at all.
                  onAnswer({ value_num: raw === '' ? null : Number(raw), is_na: false });
                }}
                inputMode="decimal"
                placeholder={q.qtype === 'temperature' ? '°C' : q.uom || 'value'}
                className="flex-1 min-w-0 bg-white border border-[#D4B896] rounded-xl px-3 py-3 text-base text-center focus:outline-none focus:ring-2 focus:ring-[#af4408]"
              />
              <button
                type="button"
                onClick={() => nudge(step)}
                aria-label="Higher"
                className="w-11 h-11 shrink-0 rounded-xl border border-[#D4B896] bg-white active:scale-95 inline-flex items-center justify-center"
              >
                <Plus size={18} />
              </button>
              {q.uom && <span className="text-sm text-[#6B5744] shrink-0">{q.uom}</span>}
            </div>
          )}
          {meta.usesRange && (q.min_value !== null || q.max_value !== null) && (
            <p className="text-[11px] text-[#8B7355]">
              Acceptable: {q.min_value !== null ? fssaiDisplayReading(q.min_value, q.decimals) : '…'}{' '}
              to {q.max_value !== null ? fssaiDisplayReading(q.max_value, q.decimals) : '…'}
              {q.uom ? ` ${q.uom}` : ''}
            </p>
          )}

          {/* multiple choice */}
          {meta.usesOptions &&
            (q.options.length <= 4 ? (
              <div className="grid grid-cols-2 gap-2">
                {q.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => onAnswer({ value_text: o, is_na: false })}
                    className={`min-h-[44px] rounded-lg border text-sm font-semibold px-2 ${
                      answer?.value_text === o && !na
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#2D1B0E] border-[#D4B896] hover:border-[#af4408]'
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            ) : (
              <Combobox
                options={q.options.map<ComboOption>((o) => ({ value: o, label: o }))}
                value={answer?.value_text || ''}
                onChange={(v) => onAnswer({ value_text: v, is_na: false })}
                placeholder="Choose an answer"
              />
            ))}

          {/* text */}
          {q.qtype === 'text' && (
            <textarea
              rows={2}
              value={answer?.value_text || ''}
              onChange={(e) => onAnswer({ value_text: e.target.value, is_na: false })}
              className="w-full bg-white border border-[#D4B896] rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-[#af4408]"
            />
          )}

          {/* photo — honestly inert */}
          {q.qtype === 'photo' && (
            <div className="rounded-lg border border-dashed border-[#D4B896] bg-[#FFF1E3] p-3 text-center">
              <Camera size={18} className="mx-auto text-[#8B7355]" />
              <p className="text-[11px] text-[#6B5744] mt-1">
                The camera opens here on the phone runner, which is not built yet. Nothing can be
                attached today, so this question cannot be completed.
              </p>
            </div>
          )}

          {/* signature */}
          {q.qtype === 'signature' && (
            <button
              type="button"
              onClick={() =>
                onAnswer({
                  value_text: meName || 'the signed-in person',
                  is_na: false,
                })
              }
              className={`w-full min-h-[44px] rounded-lg border text-sm font-semibold ${
                answer?.value_text
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-[#2D1B0E] border-[#D4B896] hover:border-[#af4408]'
              }`}
            >
              <PenLine size={15} className="inline mr-1.5" />
              {answer?.value_text
                ? `Signed — ${answer.value_text}, with the time`
                : 'Tap to sign'}
            </button>
          )}

          {/* the note that travels with the answer */}
          {(q.note_rule !== 'never' || answer?.note) && (
            <input
              value={answer?.note || ''}
              onChange={(e) => onAnswer({ note: e.target.value })}
              placeholder={
                q.note_rule === 'always'
                  ? 'A note is required — what was seen?'
                  : q.note_rule === 'on_fail'
                    ? 'A note is required if this fails'
                    : 'Add a note (optional)'
              }
              className="w-full bg-white border border-[#D4B896] rounded-xl px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-[#af4408]"
            />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {Number(q.allow_na) === 1 && (
              <button
                type="button"
                onClick={() => onAnswer({ is_na: !na })}
                className={`min-h-[36px] px-3 rounded-lg border text-xs font-semibold ${
                  na
                    ? 'bg-gray-500 text-white border-gray-500'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                Not applicable
              </button>
            )}
            {answer && (
              <button
                type="button"
                onClick={onClear}
                className="min-h-[36px] px-3 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#6B5744] hover:bg-[#FFF1E3]"
              >
                Leave it blank
              </button>
            )}
          </div>

          {/* what the engine says about this answer, right now */}
          {verdict && (
            <p
              className={`text-[11px] ${
                verdict.is_fail
                  ? 'text-red-800 font-semibold'
                  : verdict.answered
                    ? 'text-green-700'
                    : 'text-amber-900'
              }`}
            >
              {verdict.is_fail
                ? `Recorded as a FAIL. ${verdict.reason}`
                : verdict.answered
                  ? 'Answered.'
                  : verdict.reason || 'Not answered yet.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * DRAFT HELPERS
 * ══════════════════════════════════════════════════════════════════════════ */

function blankHeader(): HeaderDraft {
  return {
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
    allow_backdate_days: '1',
    pass_threshold_pct: '100',
    sort_order: '0',
  };
}

function headerFrom(t: TemplateRow): HeaderDraft {
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
    allow_backdate_days: String(t.allow_backdate_days ?? 1),
    pass_threshold_pct: String(t.pass_threshold_pct ?? 100),
    sort_order: String(t.sort_order ?? 0),
  };
}

/** The wire shape, typed the way the API types it so "changed" agrees. */
function headerPayload(d: HeaderDraft) {
  return {
    name: d.name.trim(),
    code: d.code.trim(),
    description: d.description.trim(),
    category: d.category.trim() || 'Compliance',
    module_key: d.module_key,
    frequency: d.frequency,
    department_id: d.department_id,
    responsible_role_id: d.responsible_role_id,
    target_kind: d.target_kind,
    requires_signature: d.requires_signature,
    requires_verification: d.requires_verification,
    allow_backdate_days: Number(d.allow_backdate_days || 0),
    pass_threshold_pct: Number(d.pass_threshold_pct || 0),
    sort_order: Number(d.sort_order || 0),
  };
}

function blankQuestion(sectionId: string): QuestionDraft {
  return {
    section_id: sectionId,
    qtype: 'yes_no',
    prompt: '',
    help_text: '',
    code: '',
    uom: '',
    min_value: '',
    max_value: '',
    target_value: '',
    decimals: '0',
    expected_value: 'yes',
    options: [],
    fail_options: [],
    is_required: true,
    is_critical: false,
    allow_na: true,
    photo_rule: 'never',
    note_rule: 'never',
    raise_ca_on_fail: false,
    ca_severity: 'medium',
    is_active: true,
  };
}

function draftFromQuestion(q: QuestionRow): QuestionDraft {
  return {
    id: q.id,
    section_id: q.section_id || '',
    // A row whose type this build does not know still opens in the editor — as
    // the first of the eight, so the admin can fix it rather than being stuck
    // with an un-editable question (R1: fail loudly, then be fixable).
    qtype: (qtypeMeta(q.qtype)?.key || 'yes_no') as FssaiQType,
    prompt: q.prompt || '',
    help_text: q.help_text || '',
    code: q.code || '',
    uom: q.uom || '',
    min_value: q.min_value === null || q.min_value === undefined ? '' : String(q.min_value),
    max_value: q.max_value === null || q.max_value === undefined ? '' : String(q.max_value),
    target_value:
      q.target_value === null || q.target_value === undefined ? '' : String(q.target_value),
    decimals: String(q.decimals ?? 1),
    expected_value: q.expected_value || '',
    options: [...(q.options || [])],
    fail_options: [...(q.fail_options || [])],
    is_required: !!Number(q.is_required),
    is_critical: !!Number(q.is_critical),
    allow_na: !!Number(q.allow_na),
    photo_rule: (q.photo_rule as FssaiEvidenceRule) || 'never',
    note_rule: (q.note_rule as FssaiEvidenceRule) || 'never',
    raise_ca_on_fail: !!Number(q.raise_ca_on_fail),
    ca_severity: q.ca_severity || 'medium',
    is_active: !!Number(q.is_active),
  };
}

function freqLabel(key: string): string {
  return FSSAI_FREQUENCIES.find((f) => f.key === key)?.label || key;
}
function freqHint(key: string): string {
  const hit = FSSAI_FREQUENCIES.find((f) => f.key === key);
  if (!hit) return '';
  const shifts = FSSAI_SHIFTS.filter((s) => s.key)
    .map((s) => s.label)
    .join(', ');
  return key === 'per_shift' ? `${hit.hint} The shifts are: ${shifts}.` : hit.hint;
}
function targetLabel(key: string): string {
  return FSSAI_TARGET_KINDS.find((t) => t.key === key)?.label || key;
}
function targetHint(key: string): string {
  const hit = FSSAI_TARGET_KINDS.find((t) => t.key === key);
  const base = hit ? hit.hint : '';
  return key === 'equipment'
    ? `${base} Equipment is not set up yet — that list arrives with the Cold Room screens.`
    : base;
}
