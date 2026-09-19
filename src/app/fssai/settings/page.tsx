'use client';

/**
 * FSSAI SETTINGS — THE HUB. Admin only (page-catalog `adminOnly`).
 *
 * WHAT THIS SCREEN IS FOR. Nobody is going to train the owner on this module, so the
 * hub is written as the thing he opens first: the steps in the order he would do
 * them, each one carrying the LIVE count that says whether it is done, and a plain
 * sentence about what happens if it is not. A step that is not built yet says so in
 * the same voice — an honest "not yet" beats a link that goes nowhere.
 *
 * WHY A HUB AND NOT A SETTINGS FORM. There is nothing to store here. Every standard
 * in this module already lives in rows — a checklist is a template, a frequency is an
 * assignment, a safe range will be an equipment row — so the hub's only job is to
 * lead to the screen that edits those rows and to be honest about what is configured
 * and what is not. It writes NOTHING itself, which is also why it is safe for it to
 * be the first screen anyone opens.
 *
 * WHAT IT READS (three GETs, no writes at all):
 *   GET /api/fssai/templates?include_archived=1  → the library's state
 *   GET /api/fssai/assignments?include_inactive=1 → the rota's state
 *   GET /api/fssai/masters                        → departments · roles · people ·
 *                                                   equipment, READ ONLY
 * `masters` is the proof of HARD RULE 4 rather than a dropdown source here: the hub
 * shows what this module reads from the owner's own configuration and states, on the
 * screen, that it can never create or change one of those rows.
 *
 * THE GATE IS NOT THIS SCREEN'S LABEL. `proxy.ts` guards pages and `canAccessPage`
 * fails open four ways (RECON §2.1), so the real gate is the admin check inside each
 * API route. This page therefore treats a 403 as a normal outcome and renders the
 * house permission panel instead of an error.
 *
 * Styling is the house skeleton (docs/fssai/RECON.md §1.3): the #FFF8F0 page, the
 * #af4408 heading with an icon tile, white cards bordered #E8D5C4, no new component.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  CheckCircle2,
  ClipboardList,
  Hourglass,
  Info,
  ListChecks,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Snowflake,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import {
  FSSAI_EVIDENCE_RULES,
  FSSAI_FREQUENCIES,
  FSSAI_QTYPES,
  FSSAI_TARGET_KINDS,
  FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS,
} from '@/lib/fssai';
import { fmtISTShort } from '@/lib/format-date';

/* ── the slices of each payload this page actually reads ── */

interface TemplateRow {
  id: string;
  name: string;
  status: string;
  is_active: number;
  question_count: number;
  assignment_count: number;
  run_count: number;
  updated_at: string;
}
interface AssignmentRow { id: string; is_active: number; frequency: string; next_due_date: string }
interface MastersPayload {
  departments: { id: string; name: string }[];
  roles: { id: string; name: string; is_active: number }[];
  users: { email: string; name: string }[];
  equipment: { id: string; name: string }[];
  generated_at: string;
}

/** null = not loaded or refused; never conflated with 0 (the HR dashboard habit). */
interface HubState {
  templates: TemplateRow[] | null;
  assignments: AssignmentRow[] | null;
  masters: MastersPayload | null;
}

export default function FssaiSettingsPage() {
  const [s, setS] = useState<HubState>({ templates: null, assignments: null, masters: null });
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const problems: string[] = [];
    let refused = false;

    const [t, a, m] = await Promise.all([
      apiJson<{ templates: TemplateRow[] }>('/api/fssai/templates?include_archived=1')
        .then((j) => j.templates || [])
        .catch((e: unknown) => { problems.push(msgOf(e, 'the checklists')); if (is403(e)) refused = true; return null; }),
      apiJson<{ assignments: AssignmentRow[] }>('/api/fssai/assignments?include_inactive=1')
        .then((j) => j.assignments || [])
        .catch((e: unknown) => { problems.push(msgOf(e, 'the rota')); return null; }),
      apiJson<MastersPayload>('/api/fssai/masters')
        .then((j) => j)
        .catch((e: unknown) => { problems.push(msgOf(e, 'your departments and roles')); if (is403(e)) refused = true; return null; }),
    ]);

    setS({ templates: t, assignments: a, masters: m });
    // Every read refused → this viewer is not an admin, whatever the menu let
    // them click. That is the permission panel, not an error banner.
    if (refused && t === null && m === null) setForbidden(true);
    else if (problems.length) setErr(problems.join(' '));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            🔒 Food-safety settings are restricted to administrators. Ask an administrator for access.
          </div>
        </div>
      </div>
    );
  }

  const templates = s.templates || [];
  const live = templates.filter((t) => t.status !== 'archived');
  const published = templates.filter((t) => t.status === 'published' && Number(t.is_active));
  const drafts = templates.filter((t) => t.status === 'draft');
  const archived = templates.filter((t) => t.status === 'archived');
  const emptyOnes = live.filter((t) => !Number(t.question_count));
  const unassigned = published.filter((t) => !Number(t.assignment_count));
  const liveAssignments = (s.assignments || []).filter((a) => Number(a.is_active));
  const recorded = templates.reduce((n, t) => n + (Number(t.run_count) || 0), 0);

  /* The steps, in the order an admin would do them. `state` is what decides the
   * tick, the amber nudge or the honest "not built yet" — never a guess. */
  const steps: StepProps[] = [
    {
      n: 1,
      icon: ListChecks,
      title: 'Write your checklists',
      what: 'A checklist is a name, a list of questions, and the answer that counts as a pass. Build the ones you already do on paper — the closing clean, the cold-room round, the opening hygiene check.',
      why: 'Nothing about a checklist is written into the software. When a rule changes, or an inspector asks for something stricter, you change it here and it applies from that moment on — no developer, no release.',
      href: '/fssai/checklists',
      cta: live.length ? 'Open the library' : 'Write the first one',
      state: s.templates === null ? 'unknown' : live.length === 0 ? 'todo' : emptyOnes.length ? 'attention' : 'done',
      facts: s.templates === null ? [] : [
        `${live.length} checklist${live.length === 1 ? '' : 's'} written`,
        `${published.length} published`,
        `${drafts.length} still a draft`,
        ...(archived.length ? [`${archived.length} archived`] : []),
      ],
      nudge: emptyOnes.length
        ? `${emptyOnes.length} checklist${emptyOnes.length === 1 ? ' has' : 's have'} no questions yet, so ${emptyOnes.length === 1 ? 'it' : 'they'} cannot be published.`
        : live.length === 0
          ? 'There is nothing here yet. Until at least one checklist is published, nobody has a check to run.'
          : '',
    },
    {
      n: 2,
      icon: UserPlus,
      title: 'Say who runs each one, and how often',
      what: 'Point each checklist at a department, a role or a named person, choose a frequency and a shift, and say what it is run against — a cold room, an area, or the restaurant as a whole.',
      why: 'This is what makes a check appear as DUE. A published checklist nobody is assigned to still works if somebody opens it on purpose, but it is never asked for — and a check nobody is asked for is the one that quietly stops happening.',
      href: '/fssai/checklists',
      cta: 'Assign from the library',
      state: s.assignments === null ? 'unknown' : liveAssignments.length === 0 ? 'todo' : unassigned.length ? 'attention' : 'done',
      facts: s.assignments === null ? [] : [
        `${liveAssignments.length} live assignment${liveAssignments.length === 1 ? '' : 's'}`,
        `${published.length - unassigned.length} of ${published.length} published checklists have somebody`,
      ],
      nudge: unassigned.length
        ? `${unassigned.length} published checklist${unassigned.length === 1 ? ' has' : 's have'} nobody assigned, so ${unassigned.length === 1 ? 'it' : 'they'} will never show up as due.`
        : '',
    },
    {
      n: 3,
      icon: Shield,
      title: 'Say what proof each answer needs',
      what: 'Per question: whether a photograph is compulsory, whether a remark is compulsory, whether the question is critical enough to fail the whole check on its own, and whether a failure raises a corrective action.',
      why: 'This is the difference between a tick and a record. A photograph attached to the answer is what an inspector can actually look at, and a critical question is how "the fridge was warm" outranks "one tile was chipped".',
      href: '/fssai/checklists',
      cta: 'Set it per question in the builder',
      state: 'partial',
      facts: [
        `${FSSAI_QTYPES.length} kinds of answer`,
        `${FSSAI_EVIDENCE_RULES.map((r) => r.label.toLowerCase()).join(' · ')}`,
      ],
      nudge: 'The rules are stored and enforced today, with one gap: a question that demands a photograph cannot be finished yet, because the screen that attaches one is the next piece of work. Until then, leave "photo required" off.',
    },
    {
      n: 4,
      icon: Snowflake,
      title: 'Register the cold rooms, freezers and fryers',
      what: 'Each cold room, chiller, freezer, hot-holding unit and fryer as a named piece of equipment, with its own safe range — so a reading can be judged against the right limits instead of a number somebody remembers.',
      why: 'No temperature is written into this software, and none ever will be. The safe range is yours to set, and the reading is judged against the range that was in force on the day it was taken.',
      state: s.masters === null ? 'unknown' : 'notyet',
      facts: s.masters === null ? [] : [`${s.masters.equipment.length} registered`],
      nudge: 'Not built yet. It arrives with the temperature and cold-room records. Your cold units exist in the app today only as free text on production batches — those exact names will be used so existing batches still line up.',
    },
    {
      n: 5,
      icon: Bell,
      title: 'Choose who is told',
      what: 'Who hears about a missed check, a failed check, and a fix that has run past its date — and how far up it escalates if nothing happens.',
      why: 'A compliance file is only as good as the person who notices the gap on the day, not at the audit.',
      state: 'notyet',
      facts: [],
      nudge: 'Not built yet. It arrives with corrective actions and the follow-up tasks.',
    },
  ];

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Settings2 size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">FSSAI Compliance</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Settings</h1>
            <p className="text-xs text-[#8B7355] mt-0.5">
              Your standards, in the order you would set them. Nothing here is written into the software.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
            <Lock className="w-3 h-3" /> Admin only
          </span>
          <button onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
        </div>

        {err && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span className="min-w-0">{err} The rest of this screen is still accurate.</span>
          </div>
        )}

        {/* The one paragraph that explains the whole module. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">What this module is</h2>
          <p className="text-sm text-[#3D2614] mt-2.5">
            A record of the food-safety checks your restaurant already does, kept properly: who checked, when, against
            what, what they found, with a photograph where it matters, signed, and impossible to rewrite afterwards.
          </p>
          <p className="text-sm text-[#3D2614] mt-2">
            The checks themselves are <b>yours</b>. Twelve of the record screens in this module are the same object —
            a checklist with questions — so they are <b>configuration, not code</b>. That is the whole point of this
            screen: when the rules change you change them here, and you never wait for a release.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <a href="/fssai/checklists"
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2">
              <ListChecks size={15} /> Checklist library
            </a>
            <a href="/fssai"
              className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3]">
              <ClipboardList size={15} /> Compliance dashboard
            </a>
          </div>
        </div>

        {/* Where it stands, in four numbers. */}
        {!loading && s.templates && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Checklists published" value={published.length}
              tone={published.length ? 'green' : 'amber'} sub={drafts.length ? `${drafts.length} draft` : 'no drafts'} />
            <Tile label="People assigned" value={liveAssignments.length}
              tone={liveAssignments.length ? 'green' : 'amber'} sub={unassigned.length ? `${unassigned.length} checklist with nobody` : 'all covered'} />
            <Tile label="Checks recorded" value={recorded} sub={recorded ? 'across every checklist' : 'nothing filed yet'} />
            <Tile label="Equipment registered" value={s.masters ? s.masters.equipment.length : 0}
              sub="arrives with the temperature records" />
          </div>
        )}

        {loading && !s.templates ? (
          <div className="py-16 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Loading…
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355] pt-1">
              Set it up in this order
            </h2>
            {steps.map((st) => <Step key={st.n} {...st} />)}
          </div>
        )}

        {/* The version law — the one rule that decides whether the file tells the truth. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
            What happens when you change a checklist
          </h2>
          <ul className="mt-3 space-y-2.5 text-sm text-[#3D2614]">
            <li className="flex gap-2.5">
              <CheckCircle2 size={15} className="text-green-600 shrink-0 mt-0.5" />
              <span><b>A finished check can never change.</b> The questions, the pass mark, the limits and even the
                checklist&apos;s name are frozen onto the record when it is submitted. Edit the checklist as often as you
                like — last month&apos;s records still read as they did last month.</span>
            </li>
            <li className="flex gap-2.5">
              <Info size={15} className="text-[#af4408] shrink-0 mt-0.5" />
              <span><b>A new version is only for a real change.</b> Adding, editing, reordering or retiring a question
                moves the checklist to a new version, and so do{' '}
                {FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS.length} settings: the pass mark, what the check is run against,
                and whether a signature or a second sign-off is required.</span>
            </li>
            <li className="flex gap-2.5">
              <Info size={15} className="text-[#af4408] shrink-0 mt-0.5" />
              <span><b>Renaming is not a new version</b> — and it does not re-label a single record already filed.
                Correcting a spelling was never meant to rewrite your history.</span>
            </li>
            <li className="flex gap-2.5">
              <Hourglass size={15} className="text-amber-700 shrink-0 mt-0.5" />
              <span><b>A part-filled check keeps the version it started on</b>, so the paper is never swapped underneath
                somebody halfway through a round.</span>
            </li>
            <li className="flex gap-2.5">
              <Shield size={15} className="text-[#af4408] shrink-0 mt-0.5" />
              <span><b>Nothing is deleted.</b> Retiring a checklist archives it: no new checks, records kept, and it can
                be brought back — as a draft, so it is re-read before it goes live again. Only a checklist that has never
                been used can be deleted outright, and that asks you why.</span>
            </li>
          </ul>
        </div>

        {/* HARD RULE 4, on the screen. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
            What this module reads, and never changes
          </h2>
          <p className="text-sm text-[#3D2614] mt-2.5">
            Departments, roles, staff, items, suppliers, deliveries and production batches are <b>yours</b>, set in your
            own screens. Food safety reads them so a checklist can name a real department and a real role. It cannot
            create, rename or deactivate one of them — not even by accident.
          </p>
          {s.masters ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                <ReadOnlyCount icon={Building2} label="Departments" n={s.masters.departments.length} href="/departments" />
                <ReadOnlyCount icon={Shield} label="Roles" n={s.masters.roles.length} href="/settings/roles" />
                <ReadOnlyCount icon={Users} label="People who can sign in" n={s.masters.users.length} href="/users" />
              </div>
              <p className="text-[11px] text-[#8B7355] mt-2.5">Read {fmtISTShort(s.masters.generated_at)}.</p>
            </>
          ) : (
            <p className="text-xs text-[#8B7355] mt-3">
              Those lists could not be read just now, so a new checklist cannot be given an owner until they load. Use
              Refresh above.
            </p>
          )}
        </div>

        {/* The vocabulary, so nothing on this screen is a mystery word. */}
        <details className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
          <summary className="text-xs font-bold uppercase tracking-wider text-[#8B7355] cursor-pointer">
            The words this module uses
          </summary>
          <div className="mt-3 space-y-4">
            <Vocab title="Kinds of answer a question can take"
              items={FSSAI_QTYPES.map((t) => ({ k: t.label, v: t.hint }))} />
            <Vocab title="How often a check can be due"
              items={FSSAI_FREQUENCIES.map((f) => ({ k: f.label, v: f.hint }))} />
            <Vocab title="What a check can be run against"
              items={FSSAI_TARGET_KINDS.map((t) => ({ k: t.label, v: t.hint }))} />
          </div>
        </details>

        <div className="pt-1">
          <a href="/fssai" className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline">
            <ClipboardList className="w-4 h-4" /> Compliance Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function is403(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('403') || /administrator|restricted|not allowed/i.test(m);
}
function msgOf(e: unknown, what: string): string {
  const m = e instanceof Error ? e.message : '';
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} could not be read${m ? ` (${m})` : ''}.`;
}

function Tile({ label, value, sub, tone = 'plain' }: {
  label: string; value: number; sub?: string; tone?: 'plain' | 'green' | 'amber';
}) {
  const ring = tone === 'green' ? 'border-green-200 bg-green-50'
    : tone === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-[#E8D5C4] bg-white';
  return (
    <div className={`rounded-xl border ${ring} px-3 py-3`}>
      <p className="text-2xl font-bold text-[#2D1B0E] leading-none">{value}</p>
      <p className="text-xs font-semibold text-[#3D2614] mt-1.5 leading-tight">{label}</p>
      {sub && <p className="text-[11px] text-[#6B5744] mt-0.5 leading-tight">{sub}</p>}
    </div>
  );
}

function ReadOnlyCount({ icon: Icon, label, n, href }: {
  icon: typeof Building2; label: string; n: number; href: string;
}) {
  return (
    <a href={href}
      className="flex items-center gap-2.5 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2.5 hover:border-[#af4408]">
      <Icon size={16} className="text-[#af4408] shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[#2D1B0E]">{n} {label.toLowerCase()}</span>
        <span className="block text-[11px] text-[#8B7355]">read only here — edit in your own settings</span>
      </span>
      <ArrowRight size={13} className="text-[#af4408] shrink-0" />
    </a>
  );
}

function Vocab({ title, items }: { title: string; items: { k: string; v: string }[] }) {
  return (
    <div>
      <p className="text-xs font-semibold text-[#6B5744]">{title}</p>
      <dl className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {items.map((i) => (
          <div key={i.k} className="text-xs">
            <dt className="inline font-semibold text-[#2D1B0E]">{i.k}</dt>
            {i.v && <dd className="inline text-[#6B5744]"> — {i.v}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ── one step of the setup ────────────────────────────────────────────────── */

type StepState = 'done' | 'attention' | 'todo' | 'partial' | 'notyet' | 'unknown';

interface StepProps {
  n: number;
  icon: typeof ListChecks;
  title: string;
  /** What you configure. */
  what: string;
  /** Why it matters — the sentence that stops a step being skipped. */
  why: string;
  href?: string;
  cta?: string;
  state: StepState;
  facts: string[];
  nudge: string;
}

const STEP_MARK: Record<StepState, { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'bg-green-100 text-green-700 border-green-200' },
  attention: { label: 'Needs a look', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  todo: { label: 'Not started', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  partial: { label: 'Partly ready', cls: 'bg-teal-100 text-teal-700 border-teal-200' },
  notyet: { label: 'Not built yet', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  unknown: { label: 'Could not read', cls: 'bg-gray-100 text-gray-600 border-gray-200' },
};

function Step({ n, icon: Icon, title, what, why, href, cta, state, facts, nudge }: StepProps) {
  const mark = STEP_MARK[state];
  const buildable = state !== 'notyet';
  return (
    <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${buildable ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#8B7355] border border-[#E8D5C4]'}`}>
          {n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold text-[#2D1B0E] flex items-center gap-1.5">
              <Icon size={15} className="text-[#af4408]" /> {title}
            </h3>
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${mark.cls}`}>
              {mark.label}
            </span>
          </div>
          <p className="text-sm text-[#3D2614] mt-2">{what}</p>
          <p className="text-sm text-[#6B5744] mt-1.5">{why}</p>

          {facts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {facts.map((f) => (
                <span key={f} className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded-full px-2 py-0.5">
                  {f}
                </span>
              ))}
            </div>
          )}

          {nudge && (
            <p className={`text-sm mt-2.5 rounded-lg p-3 ${state === 'notyet' ? 'bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]' : 'bg-amber-50 border border-amber-200 text-amber-900'}`}>
              {nudge}
            </p>
          )}

          {href && cta && (
            <a href={href}
              className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium bg-white border border-[#E8D5C4] rounded-lg px-3 py-2 hover:border-[#af4408] hover:bg-[#FFF1E3]">
              {n === 1 && <Plus size={14} className="text-[#af4408]" />}
              {n === 3 && <Wrench size={14} className="text-[#af4408]" />}
              {cta} <ArrowRight size={13} className="text-[#af4408]" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
