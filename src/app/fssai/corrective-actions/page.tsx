'use client';

/**
 * CORRECTIVE ACTIONS — what was done about a failed check (owner §7 Q14).
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 * A check failed. This is where the fix and the check on the fix are recorded,
 * and it is the screen that answers the question an inspector really asks —
 * not "did anything fail", but "what did you do about it".
 *
 * ── THE ONE THING IT MUST NOT DO, SAID ON THE SCREEN ITSELF ─────────────────
 * THE FAILURE STANDS. Closing an action does not un-fail the check, does not
 * reopen the round, does not void a true observation. That is the owner's
 * ruling in his own words, and the banner at the top says it to the person
 * using the screen — not because it might otherwise be implemented wrongly
 * (/api/fssai/corrective-actions holds no write against fssai_runs or
 * fssai_responses at all), but because somebody who has just written "Fixed and
 * checked" will otherwise assume the record now reads as a pass.
 *
 * ── THE PAIR OF STATES THAT CARRIES THE WHOLE POINT ─────────────────────────
 * 'Fixed — to check' is the person who did the work saying what they did.
 * 'Fixed and checked' is SOMEBODY ELSE agreeing it was enough. The server
 * refuses the fixer, refuses the person who recorded the failed check, and
 * refuses anyone outside management — and this screen shows that refusal in the
 * server's own words rather than hiding the button, because a person who cannot
 * see why they are blocked assumes the screen is broken.
 *
 * ── THE TWO PROMISES THIS SCREEN NOW KEEPS (owner §21 and §23) ──────────────
 * It used to end with a footnote admitting two gaps, and both are closed here:
 *
 *   §21 THE JOB. "Add to the Task Manager" turns the fix into a row in the task
 *   list staff already use, and writes its id into `created_task_id` — the
 *   column nothing wrote before. The job and the action are DELIBERATELY two
 *   things: the job is how a person is asked to do the work, the action is the
 *   compliance record. Completing the job does not close the action, and the
 *   screen says so where somebody is about to assume otherwise.
 *
 *   §23 THE CHASE. "Late" was a red badge for whoever happened to look. Now a
 *   reminder reaches the owner, an escalation reaches management on a
 *   configurable ladder, and the action shows WHAT WAS ACTUALLY SENT — read out
 *   of the audit trail, so tightening a rule tomorrow cannot rewrite what
 *   somebody was told yesterday. The rules live behind "Chasing" (management
 *   reads them, an administrator changes them).
 *
 * ONE THING IT STILL CANNOT PROMISE, said on the panel rather than hidden: there
 * is no fixed-time job on the server for the chase. An action is chased the
 * first time somebody opens this queue each day, and whenever a manager presses
 * "Chase now". Arming it unattended needs one line in the app's scheduler, which
 * is not this module's file to edit.
 *
 * Styling is the house skeleton (RECON §1.3-1.6) as /fssai/verification uses
 * it: the #FFF8F0 page, the #af4408 heading with an icon tile, white cards
 * bordered #E8D5C4, cards under md and a table from md up, a per-page toast, a
 * bg-black/40 overlay and a modal anchored to the BOTTOM of a phone where the
 * thumb already is. ⚠️ globals.css:279-283 force-wraps any `.flex.gap-2|3|4`,
 * so rows that must keep an icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, BellRing, CalendarDays, Check, ClipboardList, Info, Loader2,
  Lock, RefreshCw, Search, Send, ShieldCheck, Undo2, UserCog, Wrench, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import UserPicker from '@/app/tasks/_components/UserPicker';
import {
  FSSAI_CA_SEVERITIES, fssaiCaSeverityMeta, fssaiCaStatusMeta,
  type FssaiCaView,
} from '@/lib/fssai';
import { statusMeta as taskStatusMeta } from '@/lib/tasks';
import type {
  FssaiEscalationRules, FssaiEscalationTarget, FssaiCaTaskLink, FssaiCaAlertEvent,
} from '@/lib/fssai-alerts';

interface Counts {
  open: number; in_progress: number; done: number;
  verified: number; cancelled: number; outstanding: number; overdue: number;
}

interface ListResponse {
  actions: FssaiCaView[];
  counts: Counts;
  can_manage: boolean;
  me: string;
  truncated: boolean;
  task_links?: Record<string, FssaiCaTaskLink>;
  chasing_enabled?: boolean;
}

interface OneResponse {
  action: FssaiCaView;
  complete_refusal: string;
  verify_refusal: string;
  can_manage: boolean;
  cannot_change: string;
  /** null when this action is not a job in the Task Manager (owner §21). */
  task: FssaiCaTaskLink | null;
  /** Every reminder and escalation actually sent about it (owner §23). */
  alerts: FssaiCaAlertEvent[];
}

interface EscalationPicture {
  outstanding: number; unassigned: number; due_today: number; overdue: number;
  overdue_urgent: number; worst_days_late: number; with_task: number;
  told_today: number; last_sweep_at: string;
}

interface RulesResponse {
  rules: FssaiEscalationRules;
  defaults: FssaiEscalationRules;
  picture: EscalationPicture;
  targets: { key: FssaiEscalationTarget; label: string; note: string }[];
  can_edit: boolean;
  today: string;
  arming: string;
}

const TABS = [
  { key: 'outstanding', label: 'Still to do' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'Being fixed' },
  { key: 'done', label: 'To check' },
  { key: 'verified', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
] as const;

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

const ZERO: Counts = {
  open: 0, in_progress: 0, done: 0, verified: 0, cancelled: 0, outstanding: 0, overdue: 0,
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Wrench size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Corrective Actions</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              What was done about a check that failed
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The three or four words that say where a failure came from. */
function whereFrom(a: FssaiCaView): string {
  if (!a.run) return 'Raised by hand';
  return [
    a.run.template_name,
    a.run.business_date ? fmtISTDate(a.run.business_date) : '',
    a.run.target_label,
    a.run.shift,
  ].filter(Boolean).join(' · ');
}

function Pills({ a }: { a: FssaiCaView }) {
  const st = fssaiCaStatusMeta(a.status);
  const sv = fssaiCaSeverityMeta(a.severity);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-[11px] text-[#6B5744]">{a.ca_number}</span>
      <span className={`text-[11px] px-1.5 py-0.5 rounded border ${st.color}`}>{st.label}</span>
      <span className={`text-[11px] px-1.5 py-0.5 rounded border ${sv.color}`}>{sv.label}</span>
      {a.is_overdue && (
        <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-100 text-red-700 border-red-200">
          Late
        </span>
      )}
    </div>
  );
}

/**
 * "It is also a job." A chip, not a sentence, because the list is scanned —
 * and only when a task really exists. An action whose created_task_id points at
 * a deleted task shows the chip in RED rather than silently as "no job": a job
 * somebody removed is not a mended fault, and the modal explains it.
 */
function TaskChip({ link }: { link?: FssaiCaTaskLink }) {
  if (!link) return null;
  if (!link.exists) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-100 text-red-700 border-red-200 inline-flex flex-nowrap items-center gap-1">
        <ClipboardList size={11} className="shrink-0" /> Job deleted
      </span>
    );
  }
  const st = taskStatusMeta(link.status);
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border inline-flex flex-nowrap items-center gap-1 ${st.color}`}>
      <ClipboardList size={11} className="shrink-0" /> Job · {st.label}
    </span>
  );
}

function ActionCard({ a, taskLink, onOpen }: { a: FssaiCaView; taskLink?: FssaiCaTaskLink; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408] focus:outline-none focus:border-[#af4408]"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Pills a={a} />
        <TaskChip link={taskLink} />
      </div>
      <p className="text-sm font-semibold text-[#2D1B0E] mt-1.5">{a.title}</p>
      <p className="text-xs text-[#6B5744] mt-0.5 truncate">{whereFrom(a)}</p>
      <p className="text-xs mt-1">
        {a.owner_email
          ? <span className="text-[#6B5744]">With {a.owner_email}{a.due_date ? ` · due ${fmtISTDate(a.due_date)}` : ''}</span>
          : <span className="text-amber-800">Nobody has been given this yet</span>}
      </p>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function FssaiCorrectiveActionsPage() {
  const [tab, setTab] = useState<string>('outstanding');
  const [rows, setRows] = useState<FssaiCaView[] | null>(null);
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [taskLinks, setTaskLinks] = useState<Record<string, FssaiCaTaskLink>>({});
  const [chasingEnabled, setChasingEnabled] = useState<boolean | null>(null);
  const [showChasing, setShowChasing] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams({ status: tab });
      if (q.trim()) p.set('q', q.trim());
      if (severity) p.set('severity', severity);
      if (lateOnly) p.set('overdue', '1');
      if (mineOnly) p.set('owner', '__me__');
      const j = await apiJson<ListResponse>(`/api/fssai/corrective-actions?${p}`);
      setRows(j.actions || []);
      setCounts(j.counts || ZERO);
      setCanManage(!!j.can_manage);
      setTaskLinks(j.task_links || {});
      setChasingEnabled(typeof j.chasing_enabled === 'boolean' ? j.chasing_enabled : null);
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the corrective actions';
      // Told apart on purpose, as on the sibling FSSAI screens: "your session
      // ended" and "something broke" need different answers, and an empty list
      // under a red banner answers neither.
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else setErr(m);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, q, severity, lateOnly, mineOnly]);

  useEffect(() => { void load(); }, [load]);

  const tabCount = (k: string): number | undefined => {
    if (k === 'outstanding') return counts.outstanding;
    if (k === 'open') return counts.open;
    if (k === 'in_progress') return counts.in_progress;
    if (k === 'done') return counts.done;
    if (k === 'verified') return counts.verified;
    if (k === 'cancelled') return counts.cancelled;
    return undefined;
  };

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the corrective actions.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ── the law of this screen, said once, at the top ─────────────────── */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Lock size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>The failure stands.</strong> Fixing a fault and closing the action here does not
            change the check that failed — the record keeps saying exactly what was found, on the day
            it was found. That is the point: an inspector wants to see that a problem was caught,
            mended and checked, not a file in which nothing ever went wrong.
          </p>
        </div>
      </div>

      {counts.overdue > 0 && (
        <button
          onClick={() => { setLateOnly(true); setTab('outstanding'); }}
          className="w-full text-left bg-red-50 border border-red-200 rounded-xl p-3 hover:border-red-400"
        >
          <div className="flex flex-nowrap items-start gap-2.5">
            <AlertTriangle size={16} className="text-red-700 shrink-0 mt-0.5" />
            <p className="text-[13px] text-red-900">
              <strong>{counts.overdue} action{counts.overdue === 1 ? ' is' : 's are'} past the date they were due.</strong>{' '}
              Tap to see just those.
            </p>
          </div>
        </button>
      )}

      {/* ── tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const n = tabCount(t.key);
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
                on
                  ? 'bg-[#af4408] border-[#af4408] text-white'
                  : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
              }`}
            >
              {t.label}
              {typeof n === 'number' && (
                <span className={`ml-1.5 text-xs ${on ? 'text-white/80' : 'text-[#8B7355]'}`}>{n}</span>
              )}
            </button>
          );
        })}
        {/* CHASING — management only. It names who gets told when the restaurant
          * fails to fix something, which is supervisory information, and the
          * route refuses a non-manager anyway (403), so offering the button to
          * everybody would only produce a dead end. */}
        {canManage && (
          <button
            onClick={() => setShowChasing(true)}
            className={`ml-auto min-h-[44px] text-sm px-3 rounded-lg border font-medium inline-flex flex-nowrap items-center gap-1.5 ${
              chasingEnabled === false
                ? 'bg-amber-50 border-amber-300 text-amber-900'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            <BellRing size={15} className="shrink-0" />
            {chasingEnabled === false ? 'Chasing is off' : 'Chasing'}
          </button>
        )}
        <button
          onClick={() => void load()}
          title="Reload"
          aria-label="Reload"
          className={`${canManage ? '' : 'ml-auto '}w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center`}
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* ── filters ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-2 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the number, what failed, who owns it"
            className={`${INPUT} pl-9`}
          />
        </div>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={INPUT}>
          <option value="">Any severity</option>
          {FSSAI_CA_SEVERITIES.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setMineOnly((v) => !v)}
            className={`flex-1 min-h-[44px] text-sm px-3 rounded-lg border font-medium ${
              mineOnly ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
            }`}
          >
            Mine
          </button>
          <button
            onClick={() => setLateOnly((v) => !v)}
            className={`flex-1 min-h-[44px] text-sm px-3 rounded-lg border font-medium ${
              lateOnly ? 'bg-red-700 border-red-700 text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
            }`}
          >
            Late
          </button>
        </div>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
      )}

      {/* ── the list ─────────────────────────────────────────────────────── */}
      {loading && rows === null ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (rows?.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">
            {tab === 'outstanding' && !q && !severity && !lateOnly && !mineOnly
              ? 'Nothing is waiting to be fixed.'
              : 'Nothing here matches what you asked for.'}
          </p>
          <p className="text-xs text-[#6B5744] mt-1">
            {/* An empty list on a compliance screen has two very different
              * meanings, and a person is entitled to know which one this is. */}
            An action appears here the moment a check fails on a question the
            administrator has set to raise one.
          </p>
        </div>
      ) : (
        <>
          {/* cards under md */}
          <div className="md:hidden space-y-2">
            {rows!.map((a) => (
              <ActionCard key={a.id} a={a} taskLink={taskLinks[a.id]} onOpen={() => setOpenId(a.id)} />
            ))}
          </div>

          {/* table from md up */}
          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Action</th>
                  <th className="text-left font-semibold px-4 py-2">What failed</th>
                  <th className="text-left font-semibold px-4 py-2">Where it came from</th>
                  <th className="text-left font-semibold px-4 py-2">Owner</th>
                  <th className="text-left font-semibold px-4 py-2">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {rows!.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => setOpenId(a.id)}
                    className="cursor-pointer hover:bg-[#FFF8F0]"
                  >
                    <td className="px-4 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Pills a={a} />
                        <TaskChip link={taskLinks[a.id]} />
                      </div>
                    </td>
                    <td className="px-4 py-2 align-top max-w-[22rem]">
                      <span className="text-[#2D1B0E]">{a.title}</span>
                      {a.answer?.text && (
                        <span className="block text-xs text-[#8B7355]">
                          recorded as “{a.answer.text}{a.answer.uom ? ` ${a.answer.uom}` : ''}”
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top text-xs text-[#6B5744] max-w-[16rem] truncate">{whereFrom(a)}</td>
                    <td className="px-4 py-2 align-top text-xs">
                      {a.owner_email || <span className="text-amber-800">unassigned</span>}
                    </td>
                    <td className={`px-4 py-2 align-top text-xs ${a.is_overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                      {a.due_date ? fmtISTDate(a.due_date) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openId && (
        <ActionModal
          id={openId}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onChanged={(msg) => { setToast(msg); void load(); }}
        />
      )}

      {showChasing && (
        <ChasingModal
          onClose={() => setShowChasing(false)}
          onChanged={(msg) => { setToast(msg); void load(); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * ONE ACTION — read it, record the fix, check the fix
 * ------------------------------------------------------------------ */

function ActionModal({
  id, canManage, onClose, onChanged,
}: {
  id: string;
  canManage: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [v, setV] = useState<OneResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);

  // One panel is open at a time; null is the read-only view.
  const [panel, setPanel] = useState<null | 'assign' | 'complete' | 'verify' | 'reopen' | 'cancel' | 'task'>(null);
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskNote, setTaskNote] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [verifyNote, setVerifyNote] = useState('');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [sev, setSev] = useState('medium');
  const [rootCause, setRootCause] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const j = await apiJson<OneResponse>(`/api/fssai/corrective-actions?id=${encodeURIComponent(id)}`);
      setV(j);
      setOwner(j.action.owner_email || '');
      setDue(j.action.due_date || '');
      setSev(j.action.severity || 'medium');
      setRootCause(j.action.root_cause || '');
      // The job starts offered to whoever already owns the action — the common
      // case, and nobody has to pick the same person twice.
      setTaskAssignee(j.action.owner_email || '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open that action');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setActErr(null);
    try {
      const j = await apiJson<{ note_to_staff?: string }>('/api/fssai/corrective-actions', {
        method: 'POST', body: { id, ...body },
      });
      setPanel(null);
      setActionTaken('');
      setVerifyNote('');
      setReason('');
      setTaskNote('');
      await load();
      // The SERVER's own sentence wins when it sent one — it knows things the
      // screen does not, like "somebody still has to check this".
      onChanged(j?.note_to_staff || done);
    } catch (e) {
      setActErr(e instanceof Error ? e.message : 'That could not be recorded');
    } finally {
      setBusy(false);
    }
  }, [id, load, onChanged]);

  const a = v?.action;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#FFF8F0] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-3 sm:px-4 py-3 flex flex-nowrap items-center gap-2">
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
          <p className="font-semibold text-[#2D1B0E] truncate">
            {a ? a.ca_number : 'Corrective action'}
          </p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-3 sm:p-4 space-y-3">
          {loading ? (
            <div className="p-8 text-center"><Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" /></div>
          ) : err ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
          ) : !a || !v ? null : (
            <>
              {/* ── what failed ───────────────────────────────────────────── */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <Pills a={a} />
                <p className="text-base font-semibold text-[#2D1B0E] mt-1.5">{a.title}</p>
                {a.answer?.text && (
                  <p className="text-sm text-red-800 mt-1">
                    Recorded as “{a.answer.text}{a.answer.uom ? ` ${a.answer.uom}` : ''}” — which failed.
                  </p>
                )}
                {a.answer?.note && (
                  <p className="text-xs text-[#6B5744] mt-1">Note on the answer: “{a.answer.note}”</p>
                )}
                <p className="text-xs text-[#6B5744] mt-1.5">{whereFrom(a)}</p>
                {a.run && (
                  <p className="text-xs text-[#6B5744] mt-0.5">
                    Recorded by {a.run.recorded_name || a.run.recorded_by}
                    {a.department_name ? ` · ${a.department_name}` : ''}
                  </p>
                )}
                {a.description && a.description !== a.title && (
                  <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{a.description}</p>
                )}
              </div>

              {/* THE RULE, ON THE RECORD ITSELF — the server's own sentence. */}
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
                <div className="flex flex-nowrap items-start gap-2.5">
                  <Info size={15} className="text-[#af4408] shrink-0 mt-0.5" />
                  <p className="text-xs text-[#3D2614]">{v.cannot_change}</p>
                </div>
              </div>

              {/* ── who owns it ───────────────────────────────────────────── */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-[#6B5744]">
                    <strong className="text-[#2D1B0E]">Owner:</strong>{' '}
                    {a.owner_email || <span className="text-amber-800">nobody yet</span>}
                  </span>
                  <span className={a.is_overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}>
                    <strong className="text-[#2D1B0E]">Due:</strong>{' '}
                    {a.due_date ? fmtISTDate(a.due_date) : '—'}
                  </span>
                </div>
                {a.root_cause && (
                  <p className="text-xs text-[#3D2614] mt-1.5">
                    <strong>Why it happened:</strong> {a.root_cause}
                  </p>
                )}
              </div>

              {/* ── the story so far ──────────────────────────────────────── */}
              {(a.action_taken || a.status === 'verified' || a.void_reason) && (
                <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <p className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] text-xs font-semibold text-[#6B5744]">
                    What has happened
                  </p>
                  <div className="divide-y divide-[#E8D5C4] bg-white">
                    {a.action_taken && (
                      <div className="p-3">
                        <p className="text-sm text-[#2D1B0E]"><strong>Fixed</strong>{a.completed_by ? ` by ${a.completed_by}` : ''}
                          {a.completed_at ? ` · ${fmtIST(a.completed_at)}` : ''}</p>
                        <p className="text-xs text-[#3D2614] mt-0.5 whitespace-pre-wrap">{a.action_taken}</p>
                      </div>
                    )}
                    {a.status === 'verified' && (
                      <div className="p-3">
                        <p className="text-sm text-emerald-800">
                          <strong>Checked</strong> by {a.verified_by}{a.verified_at ? ` · ${fmtIST(a.verified_at)}` : ''}
                        </p>
                        {a.verify_note && <p className="text-xs text-[#3D2614] mt-0.5 whitespace-pre-wrap">{a.verify_note}</p>}
                      </div>
                    )}
                    {a.void_reason && (
                      <div className="p-3">
                        <p className="text-sm text-[#2D1B0E]">
                          <strong>Cancelled</strong>{a.voided_by ? ` by ${a.voided_by}` : ''}
                          {a.voided_at ? ` · ${fmtIST(a.voided_at)}` : ''}
                        </p>
                        <p className="text-xs text-[#3D2614] mt-0.5 whitespace-pre-wrap">{a.void_reason}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── §21 · THE JOB IN THE TASK MANAGER ─────────────────────── */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="flex flex-nowrap items-start gap-2.5">
                  <ClipboardList size={15} className="text-[#af4408] shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    {v.task && v.task.exists ? (
                      <>
                        <p className="text-sm text-[#2D1B0E]">
                          <strong>This is a job in the Task Manager.</strong>{' '}
                          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${taskStatusMeta(v.task.status).color}`}>
                            {taskStatusMeta(v.task.status).label}
                          </span>
                        </p>
                        <p className="text-xs text-[#6B5744] mt-1 break-words">{v.task.title}</p>
                        <p className="text-xs text-[#6B5744] mt-0.5">
                          {v.task.assignee_email || 'Nobody on the job yet'}
                          {v.task.department ? ` · ${v.task.department}` : ''}
                          {v.task.category ? ` · ${v.task.category}` : ''}
                          {v.task.due_date ? ` · due ${fmtISTDate(v.task.due_date)}` : ''}
                        </p>
                        {/* THE THING SOMEBODY WILL OTHERWISE ASSUME. */}
                        <p className="text-[11px] text-[#8B7355] mt-1.5">
                          Finishing that job does not close this action. The fix still has to be
                          written down here and checked by somebody else.
                        </p>
                      </>
                    ) : v.task && !v.task.exists ? (
                      <>
                        <p className="text-sm text-red-800">
                          <strong>The job raised for this action is no longer in the Task Manager.</strong>
                        </p>
                        <p className="text-xs text-[#6B5744] mt-1">
                          Nothing has been created a second time, on purpose — two task ids for one
                          fault with no record of the first is worse than none. A deleted job is not
                          a mended fault, so tell an administrator.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-[#2D1B0E]">Not a job in the Task Manager yet.</p>
                        <p className="text-xs text-[#6B5744] mt-0.5">
                          This action is the compliance record. A job is how somebody is actually
                          asked to do the work — it lands in their task list and on their phone.
                        </p>
                        {canManage && a.status !== 'verified' && a.status !== 'cancelled' && a.status !== 'void' && (
                          <button
                            onClick={() => setPanel('task')}
                            className="mt-2 min-h-[44px] px-3 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] text-sm font-medium inline-flex flex-nowrap items-center gap-2"
                          >
                            <ClipboardList size={15} className="shrink-0" /> Add to the Task Manager
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* ── §23 · WHAT WAS ACTUALLY SENT ──────────────────────────── */}
              {v.alerts.length > 0 && (
                <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <p className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] text-xs font-semibold text-[#6B5744] flex flex-nowrap items-center gap-1.5">
                    <BellRing size={13} className="shrink-0" /> Who has been told
                  </p>
                  <div className="divide-y divide-[#E8D5C4] bg-white">
                    {v.alerts.map((ev, i) => (
                      <div key={`${ev.kind}-${ev.at}-${i}`} className="p-3">
                        <p className="text-sm text-[#2D1B0E]">
                          <strong>{ev.kind_label}</strong>
                          {ev.days_late > 0 ? ` · ${ev.days_late} day${ev.days_late === 1 ? '' : 's'} late` : ''}
                          {ev.at ? ` · ${fmtIST(ev.at)}` : ''}
                        </p>
                        <p className="text-xs text-[#6B5744] mt-0.5 break-words">
                          {ev.recipients.length ? ev.recipients.join(', ') : '—'}
                        </p>
                      </div>
                    ))}
                  </div>
                  {/* Read from the trail, not recomputed — said so nobody reads
                    * this list as "what today's rules would send". */}
                  <p className="px-3 py-2 bg-[#FFF8F0] border-t border-[#E8D5C4] text-[11px] text-[#8B7355]">
                    This is what was sent at the time. Changing the chasing rules does not change it.
                  </p>
                </div>
              )}

              {actErr && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{actErr}</div>
              )}

              {/* ── what can be done now ──────────────────────────────────── */}
              {panel === null && (
                <div className="space-y-2">
                  {/* RECORDING THE FIX. The refusal is SHOWN rather than the
                    * button hidden: somebody who cannot see why they are blocked
                    * assumes the screen is broken. */}
                  {a.status !== 'verified' && a.status !== 'cancelled' && a.status !== 'void' && (
                    v.complete_refusal ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                        <div className="flex flex-nowrap items-start gap-2.5">
                          <Info size={15} className="text-amber-800 shrink-0 mt-0.5" />
                          <p className="text-sm text-amber-900">{v.complete_refusal}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {a.status === 'open' && (
                          <button
                            onClick={() => void post({ action: 'start' }, 'Picked up. It is yours now.')}
                            disabled={busy}
                            className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl border border-[#E8D5C4] bg-white hover:border-[#af4408] font-semibold text-sm px-4 disabled:opacity-60"
                          >
                            <Wrench size={17} className="shrink-0" /> I am on it
                          </button>
                        )}
                        <button
                          onClick={() => setPanel('complete')}
                          className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold text-sm px-4"
                        >
                          <Check size={17} className="shrink-0" /> Record what I did
                        </button>
                      </div>
                    )
                  )}

                  {/* CHECKING THE FIX — the second pair of eyes. */}
                  {a.status === 'done' && (
                    v.verify_refusal ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                        <div className="flex flex-nowrap items-start gap-2.5">
                          <Info size={15} className="text-amber-800 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-sm text-amber-900">{v.verify_refusal}</p>
                            <p className="text-xs text-amber-800 mt-1">
                              You can read everything here — you simply cannot be the one who signs it off.
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setPanel('verify')}
                          className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-semibold text-sm px-4"
                        >
                          <ShieldCheck size={17} className="shrink-0" /> The fix was enough
                        </button>
                        <button
                          onClick={() => setPanel('reopen')}
                          className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl border border-[#E8D5C4] bg-white hover:border-red-300 hover:text-red-800 font-semibold text-sm px-4"
                        >
                          <Undo2 size={17} className="shrink-0" /> Not enough
                        </button>
                      </div>
                    )
                  )}

                  {canManage && a.status !== 'verified' && a.status !== 'cancelled' && a.status !== 'void' && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setPanel('assign')}
                        className="flex-1 min-w-[9rem] min-h-[48px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl border border-[#E8D5C4] bg-white hover:border-[#af4408] font-medium text-sm px-4"
                      >
                        <UserCog size={16} className="shrink-0" /> Owner and deadline
                      </button>
                      <button
                        onClick={() => setPanel('cancel')}
                        className="flex-1 min-w-[9rem] min-h-[48px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl border border-[#E8D5C4] bg-white hover:border-red-300 hover:text-red-800 font-medium text-sm px-4"
                      >
                        <X size={16} className="shrink-0" /> Cancel this action
                      </button>
                    </div>
                  )}

                  {(a.status === 'verified' || a.status === 'cancelled' || a.status === 'void') && (
                    <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-sm text-[#3D2614]">
                      This action reads <strong>{fssaiCaStatusMeta(a.status).label}</strong>, so there is
                      nothing left to do on it.
                      {a.status === 'verified' && (
                        <> If the same fault comes back, the next failed check raises a fresh action —
                        a closed one is not reopened, so the file reads failed, fixed, checked, failed
                        again, which is the truth.</>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── record the fix ────────────────────────────────────────── */}
              {panel === 'complete' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">What did you actually do?</p>
                  <p className="text-xs text-[#6B5744]">
                    {/* The server refuses an empty one. Saying WHY here means the
                      * refusal is never a surprise. */}
                    Write it in plain words — what was wrong, what you did, and anything the next
                    person needs to know. An action closed with no note proves nothing to an
                    inspector, and the person checking it has nothing to check.
                  </p>
                  <textarea
                    value={actionTaken}
                    onChange={(e) => setActionTaken(e.target.value)}
                    rows={4}
                    autoFocus
                    placeholder="e.g. Door seal was perished — replaced it, ran the chiller down to 3 °C and held it two hours."
                    className={INPUT}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post({ action: 'complete', action_taken: actionTaken }, 'Recorded.')}
                      disabled={busy || !actionTaken.trim()}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] disabled:opacity-50 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <Check size={17} className="shrink-0" />}
                      Save what I did
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* ── check the fix ─────────────────────────────────────────── */}
              {panel === 'verify' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">You are saying the fix was enough.</p>
                  <p className="text-xs text-[#6B5744]">
                    This closes the action. It does not change the check that failed — that record
                    stays exactly as it was recorded.
                  </p>
                  <textarea
                    value={verifyNote}
                    onChange={(e) => setVerifyNote(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder="How you satisfied yourself — e.g. re-measured at 3 °C this morning. (Optional)"
                    className={INPUT}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post({ action: 'verify', verify_note: verifyNote }, 'Closed.')}
                      disabled={busy}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <ShieldCheck size={17} className="shrink-0" />}
                      Yes, close it
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* ── send the fix back ─────────────────────────────────────── */}
              {panel === 'reopen' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Why was the fix not enough?</p>
                  <p className="text-xs text-[#6B5744]">
                    {a.completed_by || 'The person who did it'} will see this. What they wrote stays on
                    the action — it is part of the story of this fault, not a draft.
                  </p>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    autoFocus
                    className={INPUT}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post({ action: 'reopen', reason }, 'Sent back.')}
                      disabled={busy || !reason.trim()}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <Undo2 size={17} className="shrink-0" />}
                      Send it back
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* ── owner and deadline ────────────────────────────────────── */}
              {panel === 'assign' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Who is doing this, and by when?</p>
                  <div>
                    <label className="text-xs font-semibold text-[#6B5744]">Owner</label>
                    {/* The app's own directory, so an action cannot be assigned to
                      * an address nobody signs in with — the server refuses one
                      * anyway, and this is how a person avoids meeting that. */}
                    <UserPicker
                      value={owner}
                      onPick={(u) => setOwner(u.email)}
                      allowClear
                      onClear={() => setOwner('')}
                      placeholder="Nobody yet — choose somebody"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-semibold text-[#6B5744]">Due by</label>
                      <div className="relative">
                        <CalendarDays size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
                        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${INPUT} pl-9`} />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-[#6B5744]">How serious</label>
                      <select value={sev} onChange={(e) => setSev(e.target.value)} className={INPUT}>
                        {FSSAI_CA_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-[#6B5744]">Why it happened (optional)</label>
                    <textarea value={rootCause} onChange={(e) => setRootCause(e.target.value)} rows={2} className={INPUT} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post(
                        { action: 'assign', owner_email: owner, due_date: due, severity: sev, root_cause: rootCause },
                        'Saved.',
                      )}
                      disabled={busy}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] disabled:opacity-60 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <Check size={17} className="shrink-0" />}
                      Save
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* ── cancel ────────────────────────────────────────────────── */}
              {panel === 'cancel' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Why is this action being cancelled?</p>
                  <p className="text-xs text-[#6B5744]">
                    Nothing is removed. The action stays on the failed check with your reason on it,
                    and the check still reads exactly as it was recorded.
                  </p>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    autoFocus
                    className={INPUT}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post({ action: 'cancel', reason }, 'Cancelled.')}
                      disabled={busy || !reason.trim()}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <X size={17} className="shrink-0" />}
                      Cancel it
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* ── put it in somebody's task list ────────────────────────── */}
              {panel === 'task' && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <p className="text-sm font-semibold text-[#2D1B0E]">Who is being asked to do the work?</p>
                  <p className="text-xs text-[#6B5744]">
                    This creates one job in the Task Manager, with everything about the failure on it,
                    and sends it to their task list and their phone. The job is{' '}
                    <strong>{fssaiCaSeverityMeta(a.severity).label}</strong> priority and due{' '}
                    {a.due_date ? fmtISTDate(a.due_date) : 'with no date'} — the action&apos;s own severity
                    and deadline, so the two cannot disagree. Leave the person blank to create it as a
                    draft for the task board.
                  </p>
                  <UserPicker
                    value={taskAssignee}
                    onPick={(u) => setTaskAssignee(u.email)}
                    allowClear
                    onClear={() => setTaskAssignee('')}
                    placeholder="Nobody — create it as a draft"
                  />
                  <div>
                    <label className="text-xs font-semibold text-[#6B5744]">Anything to add for them (optional)</label>
                    <textarea
                      value={taskNote}
                      onChange={(e) => setTaskNote(e.target.value)}
                      rows={2}
                      placeholder="e.g. The spare seal is in the store, shelf 4."
                      className={INPUT}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void post(
                        { action: 'create_task', assignee_email: taskAssignee, note: taskNote },
                        'Added to the Task Manager.',
                      )}
                      disabled={busy}
                      className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] disabled:opacity-60 text-white font-semibold text-sm px-4"
                    >
                      {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <ClipboardList size={17} className="shrink-0" />}
                      Create the job
                    </button>
                    <button onClick={() => setPanel(null)} className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium">
                      Back
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * CHASING AND ESCALATION — the owner's §23, on one screen
 *
 * TWO AUDIENCES, ONE PANEL. Management READS it: how many actions are
 * outstanding, how late the worst one is, how many people were told today, and
 * — the number that matters most — whether anything is sitting with nobody's
 * name on it. An ADMINISTRATOR can change the ladder (the route refuses
 * anybody else, 403, and the save button is not offered without `can_edit`).
 *
 * THE ONE SENTENCE THIS PANEL MUST NOT LEAVE OUT is the arming note the server
 * sends: there is no fixed-time job for the chase, so an action is chased the
 * first time somebody opens this queue each day. A screen promising scheduled
 * escalation it does not have is exactly the guard that reads correctly and
 * never fires.
 * ------------------------------------------------------------------ */

function ChasingModal({
  onClose, onChanged,
}: {
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [v, setV] = useState<RulesResponse | null>(null);
  const [draft, setDraft] = useState<FssaiEscalationRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const j = await apiJson<RulesResponse>('/api/fssai/escalations');
      setV(j);
      setDraft(j.rules);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the chasing rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setActErr(null);
    try {
      const j = await apiJson<{ rules: FssaiEscalationRules; note: string }>(
        '/api/fssai/escalations', { method: 'POST', body: { action: 'save_rules', rules: draft } },
      );
      setV((prev) => (prev ? { ...prev, rules: j.rules } : prev));
      setDraft(j.rules);
      onChanged(j.note || 'Saved.');
    } catch (e) {
      setActErr(e instanceof Error ? e.message : 'Those rules could not be saved');
    } finally {
      setBusy(false);
    }
  }, [draft, onChanged]);

  const chaseNow = useCallback(async () => {
    setSweeping(true);
    setActErr(null);
    try {
      const j = await apiJson<{ message: string; picture: EscalationPicture }>(
        '/api/fssai/escalations', { method: 'POST', body: { action: 'sweep', force: true } },
      );
      setV((prev) => (prev ? { ...prev, picture: j.picture } : prev));
      onChanged(j.message || 'Done.');
    } catch (e) {
      setActErr(e instanceof Error ? e.message : 'The chase could not be run');
    } finally {
      setSweeping(false);
    }
  }, [onChanged]);

  const set = <K extends keyof FssaiEscalationRules>(k: K, value: FssaiEscalationRules[K]) =>
    setDraft((d) => (d ? { ...d, [k]: value } : d));

  const toggleTarget = (
    which: 'level1_targets' | 'level2_targets', key: FssaiEscalationTarget,
  ) => setDraft((d) => {
    if (!d) return d;
    const list = d[which];
    return { ...d, [which]: list.includes(key) ? list.filter((t) => t !== key) : [...list, key] };
  });

  const canEdit = !!v?.can_edit;
  const dirty = !!(v && draft) && JSON.stringify(v.rules) !== JSON.stringify(draft);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#FFF8F0] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-3 sm:px-4 py-3 flex flex-nowrap items-center gap-2">
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
          <p className="font-semibold text-[#2D1B0E] truncate">Chasing and escalation</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-3 sm:p-4 space-y-3">
          {loading ? (
            <div className="p-8 text-center"><Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" /></div>
          ) : err ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
          ) : !v || !draft ? null : (
            <>
              {/* ── where things stand ─────────────────────────────────────── */}
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <p className="text-xs font-semibold text-[#6B5744] mb-2">Where things stand today</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  {[
                    { n: v.picture.outstanding, l: 'Still to do', bad: false },
                    { n: v.picture.overdue, l: 'Late', bad: v.picture.overdue > 0 },
                    { n: v.picture.unassigned, l: 'No owner', bad: v.picture.unassigned > 0 },
                    { n: v.picture.told_today, l: 'Told today', bad: false },
                  ].map((c) => (
                    <div key={c.l} className={`rounded-lg border p-2 ${c.bad ? 'bg-red-50 border-red-200' : 'bg-[#FFF8F0] border-[#E8D5C4]'}`}>
                      <p className={`text-lg font-bold ${c.bad ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{c.n}</p>
                      <p className="text-[11px] text-[#6B5744]">{c.l}</p>
                    </div>
                  ))}
                </div>
                {v.picture.worst_days_late > 0 && (
                  <p className="text-xs text-red-800 mt-2">
                    The oldest unfixed action is <strong>{v.picture.worst_days_late} day
                    {v.picture.worst_days_late === 1 ? '' : 's'}</strong> past its date
                    {v.picture.overdue_urgent > 0 && (
                      <> and {v.picture.overdue_urgent} late action{v.picture.overdue_urgent === 1 ? ' is' : 's are'} marked urgent</>
                    )}.
                  </p>
                )}
                <p className="text-[11px] text-[#8B7355] mt-2">
                  {v.picture.with_task} of these {v.picture.outstanding === 1 ? 'is' : 'are'} also a job in
                  the Task Manager.
                  {v.picture.last_sweep_at && <> Last chased {fmtIST(v.picture.last_sweep_at)}.</>}
                </p>
              </div>

              {/* ── the honest sentence about arming ───────────────────────── */}
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
                <div className="flex flex-nowrap items-start gap-2.5">
                  <Info size={15} className="text-[#af4408] shrink-0 mt-0.5" />
                  <p className="text-xs text-[#3D2614]">{v.arming}</p>
                </div>
              </div>

              <button
                onClick={() => void chaseNow()}
                disabled={sweeping || !draft.enabled}
                className="w-full min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] disabled:opacity-50 text-white font-semibold text-sm px-4"
              >
                {sweeping ? <Loader2 size={17} className="animate-spin shrink-0" /> : <Send size={17} className="shrink-0" />}
                {draft.enabled ? 'Chase now' : 'Chasing is switched off'}
              </button>

              {actErr && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{actErr}</div>
              )}

              {!canEdit && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div className="flex flex-nowrap items-start gap-2.5">
                    <Info size={15} className="text-amber-800 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-900">
                      You can read the rules and run the chase. Only an administrator can change who
                      gets told and when.
                    </p>
                  </div>
                </div>
              )}

              {/* ── the rules ─────────────────────────────────────────────── */}
              <fieldset disabled={!canEdit} className="space-y-3 disabled:opacity-70">
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2.5">
                  <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => set('enabled', e.target.checked)}
                      className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
                    />
                    <span className="min-w-0">
                      <span className="text-sm font-semibold text-[#2D1B0E]">Chase late corrective actions</span>
                      <span className="block text-xs text-[#6B5744]">
                        Switch this off and nobody is told about anything. Records and actions are
                        unaffected — only the messages stop.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2.5">
                  <p className="text-xs font-semibold text-[#6B5744]">Reminding the person it belongs to</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-[#6B5744]">Days before it is due</label>
                      <input
                        type="number" min={0} max={30} inputMode="numeric"
                        value={draft.remind_before_days}
                        onChange={(e) => set('remind_before_days', Math.max(0, Math.min(30, parseInt(e.target.value || '0', 10) || 0)))}
                        className={INPUT}
                      />
                      <p className="text-[11px] text-[#8B7355] mt-0.5">0 = no early reminder.</p>
                    </div>
                    <div className="space-y-2 sm:pt-5">
                      <label className="flex flex-nowrap items-center gap-2 text-sm text-[#3D2614] cursor-pointer">
                        <input
                          type="checkbox" checked={draft.remind_on_due}
                          onChange={(e) => set('remind_on_due', e.target.checked)}
                          className="w-4 h-4 shrink-0 accent-[#af4408]"
                        />
                        On the day it is due
                      </label>
                      <label className="flex flex-nowrap items-center gap-2 text-sm text-[#3D2614] cursor-pointer">
                        <input
                          type="checkbox" checked={draft.remind_overdue_daily}
                          onChange={(e) => set('remind_overdue_daily', e.target.checked)}
                          className="w-4 h-4 shrink-0 accent-[#af4408]"
                        />
                        Every day it stays late
                      </label>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-3">
                  <p className="text-xs font-semibold text-[#6B5744]">Escalating past them</p>
                  {([
                    { which: 'level1_targets' as const, days: 'level1_after_days' as const, label: 'First escalation' },
                    { which: 'level2_targets' as const, days: 'level2_after_days' as const, label: 'Second escalation' },
                  ]).map((lvl) => (
                    <div key={lvl.which} className="border border-[#E8D5C4] rounded-lg p-2.5">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-[10rem]">
                          <label className="text-xs text-[#6B5744]">{lvl.label} — days late</label>
                          <input
                            type="number" min={0} max={365} inputMode="numeric"
                            value={draft[lvl.days]}
                            onChange={(e) => set(lvl.days, Math.max(0, Math.min(365, parseInt(e.target.value || '0', 10) || 0)))}
                            className={INPUT}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {v.targets.map((t) => {
                          const on = draft[lvl.which].includes(t.key);
                          return (
                            <button
                              key={t.key}
                              type="button"
                              onClick={() => toggleTarget(lvl.which, t.key)}
                              title={t.note}
                              className={`min-h-[40px] text-xs px-2.5 rounded-lg border font-medium ${
                                on
                                  ? 'bg-[#af4408] border-[#af4408] text-white'
                                  : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
                              }`}
                            >
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                      {draft[lvl.which].length === 0 && (
                        <p className="text-[11px] text-amber-800 mt-1.5">
                          Nobody selected — this level will never be sent. That is a real setting, not
                          a mistake, but it is worth knowing.
                        </p>
                      )}
                    </div>
                  ))}
                  {draft.level2_after_days < draft.level1_after_days && (
                    <p className="text-xs text-red-800">
                      The second escalation cannot happen before the first. The server will refuse
                      this.
                    </p>
                  )}
                </div>

                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2.5">
                  <p className="text-xs font-semibold text-[#6B5744]">The two cases that cannot wait</p>
                  <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox" checked={draft.urgent_escalates_same_day}
                      onChange={(e) => set('urgent_escalates_same_day', e.target.checked)}
                      className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
                    />
                    <span className="min-w-0">
                      <span className="text-sm text-[#3D2614]">An urgent action escalates the day it is raised</span>
                      <span className="block text-xs text-[#6B5744]">
                        An urgent action is due the same day, so waiting for it to be late means
                        waiting until tomorrow.
                      </span>
                    </span>
                  </label>
                  <div>
                    <label className="text-xs text-[#6B5744]">
                      Hours an action may sit with nobody&apos;s name on it
                    </label>
                    <input
                      type="number" min={0} max={720} inputMode="numeric"
                      value={draft.unassigned_escalates_after_hours}
                      onChange={(e) => set('unassigned_escalates_after_hours', Math.max(0, Math.min(720, parseInt(e.target.value || '0', 10) || 0)))}
                      className={INPUT}
                    />
                    <p className="text-[11px] text-[#8B7355] mt-0.5">
                      An action is raised with no owner on purpose — nothing in this app says who mends
                      a fridge. Without this, an unowned failure has nobody to remind. 0 = never.
                    </p>
                  </div>
                </div>

                <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2.5">
                  <p className="text-xs font-semibold text-[#6B5744]">Also</p>
                  <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox" checked={draft.auto_create_task}
                      onChange={(e) => set('auto_create_task', e.target.checked)}
                      className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
                    />
                    <span className="min-w-0">
                      <span className="text-sm text-[#3D2614]">Raise a Task-Manager job automatically</span>
                      <span className="block text-xs text-[#6B5744]">
                        Off by default. With this on, every corrective action becomes a job without
                        anybody pressing a button — which on a restaurant whose questions all raise
                        actions is one job per failed answer. Try it with the button on an action first.
                      </span>
                    </span>
                  </label>
                  <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox" checked={draft.slack}
                      onChange={(e) => set('slack', e.target.checked)}
                      className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
                    />
                    <span className="min-w-0">
                      <span className="text-sm text-[#3D2614]">Post escalations to Slack too</span>
                      <span className="block text-xs text-[#6B5744]">
                        Only sends if a Slack webhook is already configured in Settings. With none
                        configured the rows are written and simply never sent.
                      </span>
                    </span>
                  </label>
                </div>
              </fieldset>

              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void save()}
                    disabled={busy || !dirty || draft.level2_after_days < draft.level1_after_days}
                    className="flex-1 min-w-[9rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] disabled:opacity-50 text-white font-semibold text-sm px-4"
                  >
                    {busy ? <Loader2 size={17} className="animate-spin shrink-0" /> : <Check size={17} className="shrink-0" />}
                    {dirty ? 'Save the rules' : 'Nothing to save'}
                  </button>
                  <button
                    onClick={() => setDraft(v.defaults)}
                    className="min-h-[52px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm font-medium"
                  >
                    Back to the defaults
                  </button>
                </div>
              )}

              {/* The §19 point, because a rule is a decision like any other. */}
              <p className="text-[11px] text-[#8B7355]">
                Every change to these rules is recorded in the food-safety audit trail with the old
                and new values and who made it. Changing them never alters what has already been sent.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
