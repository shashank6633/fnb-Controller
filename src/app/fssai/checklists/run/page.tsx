'use client';

/**
 * PICK A CHECK AND START IT (/fssai/checklists/run) — P3 Lane A, screen 1 of 2.
 *
 * WHO THIS SCREEN IS FOR. A member of staff holding a phone in one hand, in a
 * kitchen, who has been told to "do the closing round". Not an administrator at a
 * desk. So the screen answers three questions in this order and nothing else:
 *   1. Did I already start something?  — carry on, never start a second round.
 *   2. What do I owe right now?        — the schedule, soonest first.
 *   3. What else could I run?          — the published library, folded away.
 *
 * WHAT IT TALKS TO — the P2a engine and Lane B's routes, unchanged. No new route,
 * no new column, no schema change:
 *   GET  /api/auth/me                    → who is holding the phone
 *   GET  /api/fssai/runs?mine=1&status=in_progress → rounds already open
 *   GET  /api/fssai/runs?mine=1          → what I recorded lately
 *   GET  /api/fssai/assignments          → what is due to me (the route scopes it
 *        to my email / department / role; an admin sees everything)
 *   GET  /api/fssai/templates            → the published library (a non-admin sees
 *        only published+active rows — the route does that, not this screen)
 *   GET  /api/fssai/runs?slot=1&…        → "can I start this?", the SAME predicate
 *        the POST uses, so the button and the refusal can never disagree
 *   POST /api/fssai/runs {action:'open'} → resume or create, then navigate
 *
 * ── THE THREE RULES THIS SCREEN KEEPS ────────────────────────────────────────
 * 1. RESUME, NEVER DUPLICATE. Every "Start" asks `?slot=1` first and renders the
 *    engine's own decision: resume (carry on), create (start), or refuse — and a
 *    refusal is shown in the ENGINE'S WORDS, never flattened into "Error". The
 *    "Open that record" button appears only when the server said `can_view`,
 *    because offering a button that then 403s is worse than not offering it.
 * 2. A TARGET IS NEVER TYPED. target_id is part of the slot key, so free text
 *    would let "Cold room 1" and "cold room 1" become two different rounds of the
 *    same check. This screen therefore offers ONLY targets that already exist —
 *    the one named on the schedule, the person holding the phone, or the
 *    checklist's own department — and where none exists it says plainly who can
 *    add it. It never invents one. (Equipment and areas have no staff-readable
 *    master yet; that arrives with the equipment register.)
 * 3. IT SHOWS NO COMPLIANCE FIGURES. A pass rate belongs to the dashboard and to
 *    management (§7 Q10/Q11). This screen shows what YOU have open and what YOU
 *    recorded — progress, not scores.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Clock, Loader2, Play, RefreshCw, Search, User,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  FSSAI_SHIFTS, daysBetweenISO, fssaiToday, isISODate,
} from '@/lib/fssai';
import {
  CARD, INPUT, RUNNER_BG, Chip, Field, Note, PageHead, PrimaryButton, Progress,
  RunStatusChip, SecondaryButton, Sheet, freqLabel, shiftLabel, targetKindLabel, targetPrompt,
} from '../../_components/RunnerUI';

/* ------------------------------------------------------------------ *
 * The rows, exactly as the routes return them
 * ------------------------------------------------------------------ */

interface Me {
  email: string;
  name: string;
  role: string;
  is_head_chef: boolean;
  department_id: string | null;
}

interface TemplateRow {
  id: string;
  name: string;
  code: string;
  description: string;
  module_key: string;
  frequency: string;
  target_kind: string;
  department_id: string;
  department_name: string | null;
  responsible_role_name: string | null;
  status: string;
  is_active: number;
  version: number;
  requires_signature: number;
  requires_verification: number;
  allow_backdate_days: number;
  question_count: number;
  open_run_count: number;
  assignment_count: number;
}

interface AssignmentRow {
  id: string;
  template_id: string;
  template_name: string;
  template_status: string;
  frequency: string;
  shift: string;
  target_kind: string;
  target_id: string;
  target_label: string;
  department_id: string;
  department_name: string | null;
  responsible_role_name: string | null;
  assignee_email: string;
  assignee_name: string | null;
  next_due_date: string;
  times_csv: string;
  is_active: number;
}

interface RunRow {
  id: string;
  template_id: string;
  template_name: string;
  template_name_at_record: string | null;
  business_date: string;
  shift: string;
  status: string;
  target_kind: string;
  target_id: string;
  target_label: string;
  answered_count: number;
  total_count: number;
  outcome: string;
  recorded_by: string;
  recorded_name: string;
  started_at: string;
  submitted_at: string;
}

type SlotDecision =
  | { action: 'resume'; run_id: string }
  | { action: 'create' }
  | { action: 'refuse'; code: string; message: string; run_id: string };

/* ------------------------------------------------------------------ *
 * Small shared words
 * ------------------------------------------------------------------ */

/** "today" · "yesterday" · "3 days ago" · "in 2 days" — a date a person reads. */
function whenLabel(iso: string): string {
  if (!isISODate(iso)) return '—';
  const d = daysBetweenISO(iso, fssaiToday());   // today − iso
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d > 1) return `${d} days ago`;
  if (d === -1) return 'tomorrow';
  return `in ${Math.abs(d)} days`;
}

/** The clock time out of an SQLite 'YYYY-MM-DD HH:MM:SS', for "open since". */
function clockOf(ts: string | null | undefined): string {
  const s = String(ts || '');
  const m = s.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

/* ------------------------------------------------------------------ *
 * WHAT IS THIS CHECK RUN AGAINST? — resolved, never typed (rule 2)
 * ------------------------------------------------------------------ */

interface ResolvedTarget {
  kind: string;
  /** '' for target_kind 'none' — which is a legitimate, complete answer. */
  id: string;
  label: string;
  /** Where the target came from, so the sheet can say so. */
  from: 'schedule' | 'you' | 'department' | 'none';
}

/**
 * The target a round will be filed against, or the sentence explaining why this
 * check cannot be started from a phone yet.
 *
 * ORDER MATTERS. The schedule wins, because an administrator wrote it down
 * deliberately. Only then do the two unambiguous defaults apply.
 *
 * ⚠️ THE 'person' CONVENTION IS PROVISIONAL. target_id for a person is the user's
 * EMAIL — the same key fssai_assignments.assignee_email uses, and the only stable
 * identifier this app has for a member of staff while hr_employees is empty
 * (FSSAI-BUILD-STATE.md §3). If the equipment/people registers later prefer
 * users.id, existing personal-hygiene rounds keep their email key and the two
 * would not collide; nothing here needs changing, but it must be a deliberate
 * decision, not a discovery.
 */
function resolveTarget(
  tpl: Pick<TemplateRow, 'target_kind' | 'department_id' | 'department_name'> | null,
  assignment: AssignmentRow | null,
  me: Me | null,
): { ok: true; target: ResolvedTarget } | { ok: false; why: string } {
  const kind = String(assignment?.target_kind || tpl?.target_kind || 'none');

  if (kind === 'none') {
    return { ok: true, target: { kind, id: '', label: '', from: 'none' } };
  }
  if (assignment && String(assignment.target_id || '')) {
    return {
      ok: true,
      target: {
        kind,
        id: String(assignment.target_id),
        label: String(assignment.target_label || assignment.target_id),
        from: 'schedule',
      },
    };
  }
  if (kind === 'person') {
    if (!me?.email) {
      return { ok: false, why: 'This check is recorded about one person, and your account has no email address, so it cannot say who. An administrator has to fix the account first.' };
    }
    return { ok: true, target: { kind, id: me.email, label: me.name || me.email, from: 'you' } };
  }
  if (kind === 'department') {
    const id = String(assignment?.department_id || tpl?.department_id || me?.department_id || '');
    if (!id) {
      return { ok: false, why: 'This check is recorded against a department, and neither the checklist nor the schedule names one. An administrator can set the department on the checklist, or put it on the schedule.' };
    }
    const label = String(assignment?.department_name || tpl?.department_name || 'the department');
    return { ok: true, target: { kind, id, label, from: 'department' } };
  }
  // equipment · area · grn · batch — real things that must be CHOSEN from a list
  // this app does not have a staff-readable copy of yet. Say so; never type one.
  const noun = targetKindLabel(kind).toLowerCase();
  return {
    ok: false,
    why:
      `This check is run against ${noun}, and the schedule does not say which one. ` +
      `Ask an administrator to put it on the schedule — the list to pick from arrives with the ` +
      `${kind === 'equipment' ? 'equipment register (cold rooms, chillers, fryers)' : kind === 'grn' ? 'receiving screens' : kind === 'batch' ? 'kitchen production screens' : 'areas register'}. ` +
      `Typing it by hand would let two spellings become two separate records of one round.`,
  };
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export default function FssaiRunPickerPage() {
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [openRuns, setOpenRuns] = useState<RunRow[]>([]);
  const [recent, setRecent] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [q, setQ] = useState('');

  /* ── the start sheet ──────────────────────────────────────────────── */
  const [pick, setPick] = useState<{ tpl: TemplateRow; assignment: AssignmentRow | null } | null>(null);
  const [shift, setShift] = useState('');
  const [date, setDate] = useState(fssaiToday());
  const [backdateReason, setBackdateReason] = useState('');
  const [showDate, setShowDate] = useState(false);
  const [slot, setSlot] = useState<{ decision: SlotDecision; can_view?: boolean } | null>(null);
  const [slotBusy, setSlotBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState('');
  const [startBlock, setStartBlock] = useState<{ message: string; run_id: string; can_view: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [meRes, tplRes, asgRes, openRes, recRes] = await Promise.all([
        api('/api/auth/me'),
        api('/api/fssai/templates'),
        api('/api/fssai/assignments'),
        api('/api/fssai/runs?mine=1&status=in_progress'),
        api('/api/fssai/runs?mine=1'),
      ]);
      const meJson = meRes.ok ? await meRes.json().catch(() => null) : null;
      const user = meJson?.user || null;
      if (!user) {
        // The sibling screens answer this case the same way; a signed-out phone
        // must be told to sign in, not shown an empty list of things to do.
        setSignedOut(true);
        setMe(null);
        setTemplates([]); setAssignments([]); setOpenRuns([]); setRecent([]);
        return;
      }
      setSignedOut(false);
      setMe({
        email: String(user.email || ''),
        name: String(user.name || ''),
        role: String(user.role || ''),
        is_head_chef: !!user.is_head_chef,
        department_id: user.department_id ?? null,
      });

      const tplJson = tplRes.ok ? await tplRes.json().catch(() => null) : null;
      const asgJson = asgRes.ok ? await asgRes.json().catch(() => null) : null;
      const openJson = openRes.ok ? await openRes.json().catch(() => null) : null;
      const recJson = recRes.ok ? await recRes.json().catch(() => null) : null;

      setTemplates(Array.isArray(tplJson?.templates) ? tplJson.templates : []);
      setAssignments(Array.isArray(asgJson?.assignments) ? asgJson.assignments : []);
      setOpenRuns(Array.isArray(openJson?.runs) ? openJson.runs : []);
      setRecent(Array.isArray(recJson?.runs) ? recJson.runs : []);

      // One honest banner if a list could not be read, naming which.
      const failed: string[] = [];
      if (!tplRes.ok) failed.push('the checklists');
      if (!asgRes.ok) failed.push('your schedule');
      if (!openRes.ok || !recRes.ok) failed.push('your recent checks');
      if (failed.length) setErr(`Could not read ${failed.join(' and ')}. Pull to refresh, or try again in a moment.`);
    } catch (e: any) {
      setErr(e?.message || 'Could not load your checks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Published, runnable checklists only — a draft is the admin's working copy. */
  const runnable = useMemo(
    () => templates.filter((t) => t.status === 'published' && Number(t.is_active) && Number(t.question_count) > 0),
    [templates],
  );
  const byId = useMemo(() => new Map(runnable.map((t) => [t.id, t])), [runnable]);

  /**
   * WHAT I OWE, soonest first. An assignment whose checklist is not published (or
   * has no questions) cannot be run, so it is shown as a row that says why rather
   * than a button that fails.
   */
  const due = useMemo(() => {
    const today = fssaiToday();
    return assignments
      .filter((a) => Number(a.is_active))
      .map((a) => ({
        a,
        tpl: byId.get(a.template_id) || null,
        overdue: !!a.next_due_date && isISODate(a.next_due_date) && daysBetweenISO(a.next_due_date, today) > 0,
        dueToday: !a.next_due_date || (isISODate(a.next_due_date) && daysBetweenISO(a.next_due_date, today) >= 0),
      }))
      .sort((x, y) => String(x.a.next_due_date || '').localeCompare(String(y.a.next_due_date || '')));
  }, [assignments, byId]);

  const filteredLibrary = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return runnable;
    return runnable.filter((t) =>
      `${t.name} ${t.code} ${t.description} ${t.module_key} ${t.department_name || ''}`.toLowerCase().includes(needle));
  }, [runnable, q]);

  const todayRecords = useMemo(
    () => recent.filter((r) => r.business_date === fssaiToday() && r.status !== 'in_progress').slice(0, 6),
    [recent],
  );

  /* ── opening the sheet ────────────────────────────────────────────── */

  const openSheet = useCallback((tpl: TemplateRow, assignment: AssignmentRow | null) => {
    setPick({ tpl, assignment });
    setShift(String(assignment?.shift || ''));
    setDate(fssaiToday());
    setBackdateReason('');
    setShowDate(false);
    setSlot(null);
    setStartErr('');
    setStartBlock(null);
  }, []);

  const target = useMemo(
    () => (pick ? resolveTarget(pick.tpl, pick.assignment, me) : null),
    [pick, me],
  );

  /**
   * ASK THE ENGINE BEFORE OFFERING THE BUTTON. The same query the POST uses, so
   * "Start" cannot promise something the server will refuse — and when it does
   * refuse, the refusal on screen is the server's own sentence.
   */
  useEffect(() => {
    if (!pick || !target?.ok) { setSlot(null); return; }
    let cancelled = false;
    setSlotBusy(true);
    const params = new URLSearchParams({
      slot: '1',
      template_id: pick.tpl.id,
      business_date: date,
      target_id: target.target.id,
      shift,
    });
    (async () => {
      try {
        const res = await api(`/api/fssai/runs?${params.toString()}`);
        const j = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) { setSlot(null); setStartErr(String(j?.error || `HTTP ${res.status}`)); return; }
        setStartErr('');
        setSlot({ decision: j?.decision, can_view: j?.can_view });
      } catch {
        if (!cancelled) setSlot(null);
      } finally {
        if (!cancelled) setSlotBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pick, target, date, shift]);

  const backdateDays = useMemo(() => (isISODate(date) ? daysBetweenISO(date, fssaiToday()) : 0), [date]);
  const allowedBackdate = Number(pick?.tpl.allow_backdate_days ?? 0);

  const start = useCallback(async () => {
    if (!pick || !target?.ok) return;
    setStarting(true);
    setStartErr('');
    setStartBlock(null);
    try {
      const res = await api('/api/fssai/runs', {
        method: 'POST',
        body: {
          action: 'open',
          template_id: pick.tpl.id,
          business_date: date,
          shift,
          target_kind: target.target.kind,
          target_id: target.target.id,
          target_label: target.target.label,
          department_id: pick.assignment?.department_id || pick.tpl.department_id || '',
          assignment_id: pick.assignment?.id || '',
          backdate_reason: backdateDays > 0 ? backdateReason : '',
        },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && j?.run_id) {
          // The engine's own words, and the "open it" button ONLY when it said
          // this person may look at that record.
          setStartBlock({ message: String(j.error || ''), run_id: String(j.run_id), can_view: j.can_view !== false });
        } else {
          setStartErr(String(j?.error || `HTTP ${res.status}`));
        }
        return;
      }
      const runId = String(j?.run?.id || '');
      if (!runId) { setStartErr('The check was started but the app did not get its number back. Pull to refresh.'); return; }
      router.push(`/fssai/checklists/run/${encodeURIComponent(runId)}`);
    } catch (e: any) {
      setStartErr(e?.message || 'Could not start the check.');
    } finally {
      setStarting(false);
    }
  }, [pick, target, date, shift, backdateReason, backdateDays, router]);

  /* ── render ───────────────────────────────────────────────────────── */

  if (signedOut) {
    return (
      <div className={`min-h-screen ${RUNNER_BG} text-[#2D1B0E]`}>
        <div className="max-w-2xl mx-auto px-1 sm:px-3 py-5 space-y-4">
          <PageHead icon={<ClipboardList size={20} />} eyebrow="Food safety" title="Run a check" />
          <Note tone="amber" title="Please sign in">
            <p className="mt-1">Sign in to see the checks that are due to you.</p>
          </Note>
          <SecondaryButton href="/login?next=%2Ffssai%2Fchecklists%2Frun">Go to sign in</SecondaryButton>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${RUNNER_BG} text-[#2D1B0E]`}>
      <div className="max-w-2xl mx-auto px-1 sm:px-3 py-4 sm:py-5 space-y-4 pb-10">

        <PageHead
          icon={<ClipboardList size={20} />}
          eyebrow="Food safety"
          title="Run a check"
          sub={me ? `${me.name || me.email} — only you can fill in a check you have started.` : undefined}
          right={
            <button
              type="button" onClick={() => void load()} disabled={loading}
              className="min-h-[44px] px-3 rounded-xl border border-[#E8D5C4] bg-white text-sm font-semibold
                         text-[#3D2614] hover:bg-[#FFF1E3] disabled:opacity-50 inline-flex items-center gap-2 flex-nowrap"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          }
        />

        {err && <Note tone="amber" title="Something did not load">{err}</Note>}

        {/* ── 1. CARRY ON ─────────────────────────────────────────────── */}
        {openRuns.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-[#6B5744] px-1">Carry on where you left off</h2>
            {openRuns.map((r) => (
              <a
                key={r.id}
                href={`/fssai/checklists/run/${encodeURIComponent(r.id)}`}
                className={`${CARD} block p-3.5 active:bg-[#FFF1E3]`}
              >
                <div className="flex items-start gap-3 flex-nowrap">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold leading-tight">{r.template_name}</p>
                    <p className="text-xs text-[#8B7355] mt-0.5">
                      {r.target_label ? `${r.target_label} · ` : ''}
                      {whenLabel(r.business_date)}{r.shift ? ` · ${shiftLabel(r.shift)}` : ''}
                      {clockOf(r.started_at) ? ` · started ${clockOf(r.started_at)}` : ''}
                    </p>
                    <div className="mt-2">
                      <Progress done={Number(r.answered_count) || 0} total={Number(r.total_count) || 0} />
                      <p className="text-[11px] text-[#8B7355] mt-1">
                        {Number(r.answered_count) || 0} of {Number(r.total_count) || 0} answered
                      </p>
                    </div>
                  </div>
                  <ChevronRight size={20} className="text-[#af4408] shrink-0 mt-0.5" />
                </div>
              </a>
            ))}
          </section>
        )}

        {/* ── 2. DUE TO YOU ───────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-[#6B5744] px-1">Due to you</h2>

          {loading && assignments.length === 0 && (
            <div className={`${CARD} p-4 text-sm text-[#8B7355] flex items-center gap-2 flex-nowrap`}>
              <Loader2 size={16} className="animate-spin" /> Reading your schedule…
            </div>
          )}

          {!loading && due.length === 0 && (
            <div className={`${CARD} p-4`}>
              <p className="text-sm font-semibold">Nothing is scheduled to you yet.</p>
              <p className="text-xs text-[#8B7355] mt-1">
                A check appears here once an administrator puts your name, your department or your role
                on its schedule. Until then you can still run anything from the list below.
              </p>
            </div>
          )}

          {due.map(({ a, tpl, overdue }) => {
            const t = tpl;
            return (
              <div key={a.id} className={`${CARD} p-3.5`}>
                <div className="flex items-start gap-3 flex-nowrap">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold leading-tight">{a.template_name}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <Chip><Clock size={11} />{freqLabel(a.frequency)}</Chip>
                      {a.shift ? <Chip>{shiftLabel(a.shift)}</Chip> : null}
                      {a.target_label ? <Chip>{a.target_label}</Chip> : null}
                      {a.next_due_date ? (
                        <Chip className={overdue ? 'bg-red-50 text-red-700 border-red-200' : 'bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]'}>
                          <CalendarDays size={11} />
                          {overdue ? `due ${whenLabel(a.next_due_date)}` : `due ${whenLabel(a.next_due_date)}`}
                        </Chip>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-[#8B7355] mt-1.5">
                      {a.assignee_email
                        ? `Yours: ${a.assignee_name || a.assignee_email}`
                        : a.responsible_role_name
                          ? `Anyone who is ${a.responsible_role_name}`
                          : a.department_name
                            ? `Anyone in ${a.department_name}`
                            : 'Anyone on shift'}
                    </p>
                  </div>
                </div>

                <div className="mt-3">
                  {!t ? (
                    <Note tone="amber">
                      {a.template_status === 'published'
                        ? 'This checklist has no questions yet, so it cannot be run. An administrator has to add them.'
                        : `This checklist is ${a.template_status === 'archived' ? 'archived' : 'not published yet'}, so it cannot be run. An administrator has to publish it.`}
                    </Note>
                  ) : (
                    <PrimaryButton onClick={() => openSheet(t, a)}>
                      <Play size={18} /> Start this check
                    </PrimaryButton>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* ── 3. EVERYTHING ELSE ──────────────────────────────────────── */}
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowLibrary((v) => !v)}
            className={`${CARD} w-full p-3.5 flex items-center gap-3 flex-nowrap text-left min-h-[56px]`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-bold leading-tight">Another check</p>
              <p className="text-xs text-[#8B7355] mt-0.5">
                {runnable.length === 0
                  ? 'No checklist is published yet.'
                  : `${runnable.length} checklist${runnable.length === 1 ? '' : 's'} you can run without being asked.`}
              </p>
            </div>
            <ChevronDown size={20} className={`text-[#af4408] shrink-0 transition-transform ${showLibrary ? 'rotate-180' : ''}`} />
          </button>

          {showLibrary && (
            <div className="space-y-2">
              {runnable.length > 3 && (
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
                  <input
                    value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the checklists"
                    className={`${INPUT} pl-9`} inputMode="search"
                  />
                </div>
              )}
              {filteredLibrary.length === 0 && (
                <div className={`${CARD} p-4 text-sm text-[#8B7355]`}>
                  {runnable.length === 0
                    ? 'Nothing is published yet. An administrator writes the checklists in Settings.'
                    : 'No checklist matches that.'}
                </div>
              )}
              {filteredLibrary.map((t) => (
                <button
                  key={t.id} type="button" onClick={() => openSheet(t, null)}
                  className={`${CARD} w-full p-3.5 text-left active:bg-[#FFF1E3] min-h-[56px]`}
                >
                  <div className="flex items-start gap-3 flex-nowrap">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold leading-tight">{t.name}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <Chip>{freqLabel(t.frequency)}</Chip>
                        <Chip>{t.question_count} question{Number(t.question_count) === 1 ? '' : 's'}</Chip>
                        {t.target_kind !== 'none' ? <Chip>{targetKindLabel(t.target_kind)}</Chip> : null}
                      </div>
                    </div>
                    <Play size={18} className="text-[#af4408] shrink-0 mt-1" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── 4. WHAT YOU RECORDED TODAY ──────────────────────────────── */}
        {todayRecords.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-[#6B5744] px-1">You recorded today</h2>
            {todayRecords.map((r) => (
              <a
                key={r.id}
                href={`/fssai/checklists/run/${encodeURIComponent(r.id)}`}
                className={`${CARD} block p-3 active:bg-[#FFF1E3]`}
              >
                <div className="flex items-center gap-2.5 flex-nowrap">
                  <CheckCircle2 size={17} className="text-teal-700 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-tight truncate">
                      {r.template_name_at_record || r.template_name}
                    </p>
                    <p className="text-[11px] text-[#8B7355]">
                      {r.target_label ? `${r.target_label} · ` : ''}{shiftLabel(r.shift)}
                    </p>
                  </div>
                  <RunStatusChip status={r.status} />
                </div>
              </a>
            ))}
          </section>
        )}

        <p className="text-[11px] text-[#8B7355] px-1 pt-2">
          A check is filed against the day and shift it was done in. Two people cannot fill in the same
          round at once — whoever starts it holds it until it is submitted, and a manager can hand it over.
        </p>
      </div>

      {/* ── THE START SHEET ─────────────────────────────────────────────── */}
      <Sheet
        open={!!pick}
        onClose={() => setPick(null)}
        busy={starting}
        title={pick?.tpl.name || ''}
        subtitle={pick ? `${pick.tpl.question_count} question${Number(pick.tpl.question_count) === 1 ? '' : 's'} · ${freqLabel(pick.tpl.frequency)}` : undefined}
        footer={
          pick && target?.ok && !startBlock ? (
            <>
              <PrimaryButton
                onClick={() => void start()}
                busy={starting}
                disabled={
                  slotBusy ||
                  slot?.decision.action === 'refuse' ||
                  (backdateDays > 0 && (!backdateReason.trim() || allowedBackdate <= 0 || backdateDays > allowedBackdate)) ||
                  backdateDays < 0
                }
              >
                {slot?.decision.action === 'resume' ? <><Play size={18} /> Carry on with this check</> : <><Play size={18} /> Start the check</>}
              </PrimaryButton>
              <SecondaryButton onClick={() => setPick(null)} disabled={starting}>Not now</SecondaryButton>
            </>
          ) : (
            <SecondaryButton onClick={() => setPick(null)}>Close</SecondaryButton>
          )
        }
      >
        {pick && (
          <>
            {pick.tpl.description ? (
              <p className="text-sm text-[#3D2614]">{pick.tpl.description}</p>
            ) : null}

            {/* What it is filed against */}
            {target && !target.ok ? (
              <Note tone="amber" title="This one cannot be started here yet">{target.why}</Note>
            ) : target?.ok ? (
              <div className="rounded-xl border border-[#E8D5C4] bg-[#FFF1E3] p-3 space-y-1.5">
                <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">This check is filed as</p>
                <p className="text-sm font-semibold flex items-center gap-2 flex-nowrap">
                  <CalendarDays size={15} className="text-[#af4408] shrink-0" />
                  {date} ({whenLabel(date)}){shift ? ` · ${shiftLabel(shift)}` : ' · any time of day'}
                </p>
                {target.target.kind !== 'none' && (
                  <p className="text-sm font-semibold flex items-center gap-2 flex-nowrap">
                    <User size={15} className="text-[#af4408] shrink-0" />
                    {targetPrompt(target.target.kind)} {target.target.label}
                    {target.target.from === 'you' ? ' (you)' : ''}
                  </p>
                )}
                {target.target.kind === 'none' && (
                  <p className="text-xs text-[#6B5744]">
                    One round for the whole restaurant — whoever files it first files it for everyone.
                  </p>
                )}
              </div>
            ) : null}

            {/* Shift — only where the schedule has not already fixed it */}
            {target?.ok && !pick.assignment?.shift && (
              <Field label="Which part of the day?" hint="This is part of what makes one round different from the next.">
                <select value={shift} onChange={(e) => setShift(e.target.value)} className={INPUT}>
                  {FSSAI_SHIFTS.map((s) => (
                    <option key={s.key || 'any'} value={s.key}>{s.label}</option>
                  ))}
                </select>
              </Field>
            )}

            {/* The date, folded away — today is nearly always right */}
            {target?.ok && (
              <div>
                <button
                  type="button" onClick={() => setShowDate((v) => !v)}
                  className="text-sm font-semibold text-[#af4408] underline min-h-[44px]"
                >
                  {showDate ? 'Keep today' : 'Recording this for an earlier day?'}
                </button>
                {showDate && (
                  <div className="mt-2 space-y-2">
                    {allowedBackdate <= 0 ? (
                      <Note tone="amber">
                        This check has to be recorded on the day it is done, so the date cannot be changed.
                      </Note>
                    ) : (
                      <>
                        <Field label="The day the check was done" hint={`Up to ${allowedBackdate} day${allowedBackdate === 1 ? '' : 's'} ago.`}>
                          <input
                            type="date" value={date} max={fssaiToday()}
                            onChange={(e) => { setDate(e.target.value); setShowDate(true); }}
                            className={INPUT}
                          />
                        </Field>
                        {backdateDays > 0 && (
                          <Field label="Why is it being recorded late?" required>
                            <input
                              value={backdateReason} onChange={(e) => setBackdateReason(e.target.value)}
                              placeholder="The tablet was flat, so it was written on paper"
                              className={INPUT}
                            />
                          </Field>
                        )}
                        {backdateDays > allowedBackdate && (
                          <Note tone="red">
                            {`This check can only be backdated ${allowedBackdate} day${allowedBackdate === 1 ? '' : 's'}. ${date} is ${backdateDays} days ago.`}
                          </Note>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* The engine's answer to "can I start this?" */}
            {target?.ok && slotBusy && (
              <p className="text-xs text-[#8B7355] flex items-center gap-2 flex-nowrap">
                <Loader2 size={14} className="animate-spin" /> Checking whether this round is already being filled in…
              </p>
            )}
            {target?.ok && !slotBusy && slot?.decision.action === 'resume' && (
              <Note tone="info" title="You already have this one open">
                Carrying on keeps the answers you have already given. A second round of the same check
                would contradict the first.
              </Note>
            )}
            {target?.ok && !slotBusy && slot?.decision.action === 'refuse' && (
              <Note tone="amber" title="This round is already taken">
                <p className="mt-1">{slot.decision.message}</p>
                {slot.can_view !== false && (
                  <a
                    href={`/fssai/checklists/run/${encodeURIComponent(slot.decision.run_id)}`}
                    className="inline-flex items-center gap-1 mt-2 font-semibold underline min-h-[44px]"
                  >
                    Open that record <ChevronRight size={15} />
                  </a>
                )}
              </Note>
            )}

            {startBlock && (
              <Note tone="amber" title="Not started" icon={<AlertTriangle size={17} />}>
                <p className="mt-1">{startBlock.message}</p>
                {startBlock.can_view && startBlock.run_id && (
                  <a
                    href={`/fssai/checklists/run/${encodeURIComponent(startBlock.run_id)}`}
                    className="inline-flex items-center gap-1 mt-2 font-semibold underline min-h-[44px]"
                  >
                    Open that record <ChevronRight size={15} />
                  </a>
                )}
              </Note>
            )}
            {startErr && <Note tone="red" title="Could not start">{startErr}</Note>}

            {Number(pick.tpl.requires_signature) ? (
              <p className="text-[11px] text-[#8B7355]">You will be asked to sign this check before it is submitted.</p>
            ) : null}
          </>
        )}
      </Sheet>
    </div>
  );
}
