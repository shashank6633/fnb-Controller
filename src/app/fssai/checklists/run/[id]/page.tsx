'use client';

/**
 * THE PHONE RUNNER (/fssai/checklists/run/[id]) — P3 Lane A, screen 2 of 2.
 *
 * THIS IS THE SCREEN THE WHOLE MODULE IS JUDGED ON. Everything else in FSSAI —
 * twelve of the twenty sub-modules — is a checklist rendered through here. It is
 * used one-handed, in a kitchen, by someone who is not enjoying it, so the design
 * rules are not cosmetic:
 *
 *   · EVERY CONTROL IS A THUMB TARGET. 56px for an answer button, 48px minimum
 *     for everything else, full width on a phone. Not a desktop form squeezed
 *     narrow — the shapes come from ../../../_components/RunnerUI, which exists
 *     precisely so the picker and the runner cannot drift.
 *   · SAVE AS HE GOES. Every answer is its own POST the moment it is given. If
 *     that POST cannot leave the building (signal gone in a cold room) the answer
 *     is kept in the phone's own storage and retried — so a round survives a lost
 *     connection, a locked screen and a reload. The banner says how many answers
 *     are still waiting, and submit refuses while any are.
 *   · THE SERVER'S WORDS REACH THE SCREEN INTACT. A submit refusal names what it
 *     is waiting for (P2a's fix round built that); this screen prints that list,
 *     question by question, and never flattens it into "Error". Same for the
 *     answer refusals: "maybe" on a Yes/No is a 400 with a sentence, and the
 *     sentence is what appears on the card.
 *   · INCOMPLETE IS NOT FAILURE. An answer missing its required photograph or
 *     note is unfinished paperwork, not a compliance failure. The engine is
 *     careful never to turn one into the other, and neither does this screen: the
 *     amber "still needs a photograph" line is a different thing from the red
 *     "recorded as a fail" line, and both come from the server.
 *   · NOTHING IS JUDGED HERE. is_fail is frozen on the answer row by the engine.
 *     This screen displays it and never recomputes it — not for a colour, not for
 *     a count. That is what makes a record taken last Tuesday still read as it did
 *     last Tuesday after the checklist is edited today (RECON §10 R3).
 *
 * WHAT IT TALKS TO — no new route, no new column, no schema change:
 *   GET    /api/auth/me
 *   GET    /api/fssai/runs?id=<run>       → run · template · questions · sections ·
 *          responses (an open round), or the FROZEN sheet_as_asked (a finished one)
 *   GET    /api/fssai/evidence?run_id=    → the attachments, WITHOUT the images,
 *          plus the server's own limits
 *   GET    /api/fssai/evidence?id=        → one image, fetched only when tapped
 *   POST   /api/fssai/runs {action:'answer'|'submit'|'takeover'|'void'}
 *   POST   /api/fssai/evidence            → attach a photograph to one answer
 *   DELETE /api/fssai/evidence?id=        → remove one, while the round is open
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, Ban, Camera, Check, CheckCircle2, CloudOff,
  Image as ImageIcon, Loader2, Minus, PenLine, Plus, Trash2, UserCheck, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { UserRole } from '@/lib/auth';
import {
  FSSAI_SIGNATURE_STATEMENT, canTakeOverFssaiRun, evaluateFssaiAnswer, fssaiBytesLabel,
  fssaiDisplayReading, qtypeMeta,
} from '@/lib/fssai';
import {
  CARD, INPUT, RUNNER_BG, Chip, Field, Note, PageHead, PrimaryButton, Progress,
  RunStatusChip, SecondaryButton, Sheet, shiftLabel, shrinkPhotoToDataUri, targetPrompt,
} from '../../../_components/RunnerUI';

/* ------------------------------------------------------------------ *
 * The rows, exactly as /api/fssai/runs returns them
 * ------------------------------------------------------------------ */

interface Me {
  email: string;
  name: string;
  /** The tier the shared predicates read — canTakeOverFssaiRun takes this shape. */
  role: UserRole;
  is_head_chef: boolean;
  department_id: string | null;
}

interface RunRow {
  id: string; template_id: string; template_version: number; business_date: string; shift: string;
  target_kind: string; target_id: string; target_label: string; department_id: string;
  status: string; started_at: string; submitted_at: string;
  recorded_by: string; recorded_name: string; signed_by: string; signed_at: string;
  total_count: number; answered_count: number; fail_count: number; na_count: number;
  pass_pct: number; outcome: string; is_backdated: number; backdate_reason: string;
  remarks: string; voided_at: string; voided_by: string; void_reason: string;
}

interface TemplateRow {
  id: string; name: string; code: string; version?: number; current_version?: number | null;
  pass_threshold_pct: number; requires_signature?: number; requires_verification?: number;
}

interface QuestionRow {
  id: string; section_id: string | null; qtype: string; prompt: string; help_text: string;
  uom: string; min_value: number | null; max_value: number | null; target_value: number | null;
  decimals: number; expected_value: string; options: string[]; fail_options: string[];
  is_required: number; is_critical: number; allow_na: number;
  photo_rule: string; note_rule: string; sort_order: number;
  qtype_label: string | null; qtype_known: boolean;
}

interface SectionRow { id: string; title: string; description: string; sort_order: number }

interface ResponseRow {
  id: string; question_id: string; qtype: string; prompt_snapshot: string;
  value_text: string; value_num: number | null; value_bool: number | null;
  is_na: number; is_fail: number; min_used: number | null; max_used: number | null;
  expected_used: string; uom: string; note: string; answered_by: string; answered_at: string;
  sort_order: number;
}

interface EvidenceMeta {
  id: string; run_id: string; response_id: string; question_id: string | null;
  kind: string; filename: string; mime: string; size_bytes: number; caption: string;
  created_by: string; created_at: string;
}

interface SheetQuestion {
  question_id: string; prompt: string; qtype: string; section_id: string | null;
  sort_order: number; is_required: number; is_critical: number;
  answered: boolean; is_na: number; is_fail: number; retired_mid_run?: boolean;
}

interface Verdict {
  answered: boolean; is_fail: boolean; reason: string; needs_photo?: boolean; needs_note?: boolean;
}

interface MissingRow { question_id: string; prompt: string; reason: string }

/** What the person has typed but the server may not have yet. */
interface Draft {
  text: string;
  /** kept as the STRING the person typed: '' is "no reading", never 0. */
  num: string;
  bool: boolean | null;
  na: boolean;
  note: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'queued';

const DRAFT_VERSION = 'v1';
const draftKey = (runId: string) => `fssai.run.${runId}.drafts.${DRAFT_VERSION}`;
const queueKey = (runId: string) => `fssai.run.${runId}.queue.${DRAFT_VERSION}`;

function emptyDraft(): Draft {
  return { text: '', num: '', bool: null, na: false, note: '' };
}

function draftOf(r: ResponseRow | undefined): Draft {
  if (!r) return emptyDraft();
  return {
    text: String(r.value_text ?? ''),
    num: r.value_num === null || r.value_num === undefined ? '' : String(r.value_num),
    bool: r.value_bool === null || r.value_bool === undefined ? null : !!Number(r.value_bool),
    na: !!Number(r.is_na),
    note: String(r.note ?? ''),
  };
}

/** Is there anything in this draft worth sending? */
function draftHasValue(q: QuestionRow, d: Draft): boolean {
  if (d.na) return true;
  const meta = qtypeMeta(q.qtype);
  if (!meta) return d.text.trim() !== '';
  if (meta.value === 'bool') return d.bool !== null;
  if (meta.value === 'num') return d.num.trim() !== '';
  if (meta.value === 'evidence') return false;     // the photograph is the answer
  return d.text.trim() !== '';
}

/** The clock out of an SQLite timestamp or an ISO string. */
function clockOf(ts: string | null | undefined): string {
  const m = String(ts || '').match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** The acceptable range, said the way it is written on a fridge. */
function rangeLabel(q: QuestionRow): string {
  const uom = q.qtype === 'temperature' ? (q.uom ? `°${q.uom}` : '°C') : (q.uom || '');
  const mn = q.min_value;
  const mx = q.max_value;
  if (mn !== null && mx !== null) return `Acceptable: ${mn} to ${mx}${uom ? ` ${uom}` : ''}`;
  if (mn !== null) return `Acceptable: ${mn}${uom ? ` ${uom}` : ''} or more`;
  if (mx !== null) return `Acceptable: ${mx}${uom ? ` ${uom}` : ''} or less`;
  return uom ? `In ${uom}` : '';
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export default function FssaiRunnerPage() {
  const params = useParams<{ id: string }>();
  const runId = String(params?.id || '');

  const [me, setMe] = useState<Me | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [tpl, setTpl] = useState<TemplateRow | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [responses, setResponses] = useState<Record<string, ResponseRow>>({});
  const [sheet, setSheet] = useState<SheetQuestion[] | null>(null);
  const [renamedTo, setRenamedTo] = useState<string>('');
  const [editedSince, setEditedSince] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceMeta[]>([]);
  /** The caps the SERVER declares, so "2 of 4" on screen is never the client's guess. */
  const [evLimits, setEvLimits] = useState<{ max_per_answer: number; max_per_run: number; max_bytes_label?: string } | null>(null);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [saveErr, setSaveErr] = useState<Record<string, string>>({});
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState<string[]>([]);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState('');
  const [missing, setMissing] = useState<MissingRow[]>([]);
  const [sigNotice, setSigNotice] = useState<{ message: string; statement: string; endpoint: string } | null>(null);
  const [done, setDone] = useState<{ outcome: string; pass_pct: number; fail_count: number; counted_retired: number; awaiting_verification: boolean } | null>(null);

  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [takeoverReason, setTakeoverReason] = useState('');
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [takeoverErr, setTakeoverErr] = useState('');

  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidErr, setVoidErr] = useState('');

  const [photoBusy, setPhotoBusy] = useState<Record<string, boolean>>({});
  const [photoErr, setPhotoErr] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<{ meta: EvidenceMeta; data_uri: string } | null>(null);

  /** The answers that could not leave the phone, kept across reloads. */
  const queueRef = useRef<Record<string, Draft>>({});
  const draftsRef = useRef<Record<string, Draft>>({});
  draftsRef.current = drafts;

  const isOpen = run?.status === 'in_progress';
  /** Does this checklist ask for a signature? It defaults to 1 on the template. */
  const needsSignature = !!Number(tpl?.requires_signature ?? 0);
  const mine = !!run && !!me
    && String(run.recorded_by || '').toLowerCase() === String(me.email || '').toLowerCase();
  const canWrite = isOpen && mine;

  /* ── loading ──────────────────────────────────────────────────────── */

  const loadEvidence = useCallback(async () => {
    try {
      const res = await api(`/api/fssai/evidence?run_id=${encodeURIComponent(runId)}`);
      if (!res.ok) return;
      const j = await res.json().catch(() => null);
      setEvidence(Array.isArray(j?.evidence) ? j.evidence : []);
      if (j?.limits) setEvLimits(j.limits);
    } catch { /* the photographs are a detail; the round still works */ }
  }, [runId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr('');
    try {
      const [meRes, runRes] = await Promise.all([
        api('/api/auth/me'),
        api(`/api/fssai/runs?id=${encodeURIComponent(runId)}`),
      ]);
      const meJson = meRes.ok ? await meRes.json().catch(() => null) : null;
      const user = meJson?.user || null;
      setMe(user ? {
        email: String(user.email || ''), name: String(user.name || ''),
        // The session's own tier. Narrowed, not trusted: an unexpected value can
        // only ever mean "not management", because every predicate tests for the
        // three it knows.
        role: (String(user.role || '') as UserRole),
        is_head_chef: !!user.is_head_chef,
        department_id: user.department_id ?? null,
      } : null);

      const j = await runRes.json().catch(() => null);
      if (!runRes.ok) {
        setLoadErr(String(j?.error || (runRes.status === 401 ? 'Please sign in to open this check.' : `HTTP ${runRes.status}`)));
        setRun(null);
        return;
      }
      setRun(j.run || null);
      setTpl(j.template || null);
      setQuestions(Array.isArray(j.questions) ? j.questions : []);
      setSections(Array.isArray(j.sections) ? j.sections : []);
      setSheet(Array.isArray(j.sheet_as_asked) ? j.sheet_as_asked : null);
      setRenamedTo(j.template_renamed_since && j.template_now?.name ? String(j.template_now.name) : '');
      setEditedSince(!!j.edited_since_started);
      setRemarks(String(j.run?.remarks || ''));

      const map: Record<string, ResponseRow> = {};
      for (const r of (Array.isArray(j.responses) ? j.responses : []) as ResponseRow[]) {
        map[String(r.question_id)] = r;
      }
      setResponses(map);

      // WHAT THE PHONE STILL HOLDS WINS OVER WHAT THE SERVER HAS, but only for a
      // question whose answer never arrived. Anything the server acknowledged is
      // authoritative — otherwise a stale draft could quietly overwrite a
      // correction made from another device.
      let stored: Record<string, Draft> = {};
      let storedQueue: Record<string, Draft> = {};
      try {
        stored = JSON.parse(localStorage.getItem(draftKey(runId)) || '{}') || {};
        storedQueue = JSON.parse(localStorage.getItem(queueKey(runId)) || '{}') || {};
      } catch { /* a phone with storage switched off simply has no drafts */ }

      const next: Record<string, Draft> = {};
      for (const q of (Array.isArray(j.questions) ? j.questions : []) as QuestionRow[]) {
        const fromServer = draftOf(map[String(q.id)]);
        const pending = storedQueue[String(q.id)] || (map[String(q.id)] ? null : stored[String(q.id)]);
        next[String(q.id)] = pending ? { ...fromServer, ...pending } : fromServer;
      }
      setDrafts(next);
      queueRef.current = storedQueue;
      setQueued(Object.keys(storedQueue));
      await loadEvidence();
    } catch (e: any) {
      setLoadErr(e?.message || 'Could not open this check.');
    } finally {
      setLoading(false);
    }
  }, [runId, loadEvidence]);

  useEffect(() => { void load(); }, [load]);

  /* ── the phone's own memory ───────────────────────────────────────── */

  useEffect(() => {
    if (!runId || loading) return;
    try { localStorage.setItem(draftKey(runId), JSON.stringify(drafts)); } catch { /* storage off */ }
  }, [drafts, runId, loading]);

  const persistQueue = useCallback(() => {
    try { localStorage.setItem(queueKey(runId), JSON.stringify(queueRef.current)); } catch { /* storage off */ }
    setQueued(Object.keys(queueRef.current));
  }, [runId]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  /* ── saving one answer ────────────────────────────────────────────── */

  const questionById = useMemo(
    () => new Map(questions.map((q) => [String(q.id), q])),
    [questions],
  );

  /**
   * POST one answer. Returns true when the server took it.
   *
   * THE ONE DISTINCTION THAT MATTERS: a thrown fetch (no signal) means the answer
   * has not been recorded anywhere but this phone, so it is QUEUED and retried. An
   * HTTP refusal (400/403/409) is the server having read it and said no — that
   * sentence goes on the card and is never retried, because retrying would hide it
   * and spin forever.
   */
  const pushAnswer = useCallback(async (qid: string, d: Draft, opts: { silent?: boolean } = {}): Promise<boolean> => {
    if (!opts.silent) setSaveState((s) => ({ ...s, [qid]: 'saving' }));
    try {
      const res = await api('/api/fssai/runs', {
        method: 'POST',
        body: {
          action: 'answer',
          run_id: runId,
          question_id: qid,
          value_text: d.text,
          value_num: d.num,
          value_bool: d.bool,
          is_na: d.na,
          note: d.note,
        },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setSaveErr((e) => ({ ...e, [qid]: String(j?.error || `HTTP ${res.status}`) }));
        setSaveState((s) => ({ ...s, [qid]: 'idle' }));
        if (queueRef.current[qid]) { delete queueRef.current[qid]; persistQueue(); }
        return false;
      }
      setSaveErr((e) => (e[qid] ? { ...e, [qid]: '' } : e));
      if (j?.response) setResponses((m) => ({ ...m, [qid]: j.response as ResponseRow }));
      if (j?.verdict) setVerdicts((v) => ({ ...v, [qid]: j.verdict as Verdict }));
      if (typeof j?.answered_count === 'number') {
        setRun((r) => (r ? { ...r, answered_count: Number(j.answered_count) } : r));
      }
      setSaveState((s) => ({ ...s, [qid]: 'saved' }));
      if (queueRef.current[qid]) { delete queueRef.current[qid]; persistQueue(); }
      return true;
    } catch {
      // No signal. Keep it, say so, retry later.
      queueRef.current[qid] = d;
      persistQueue();
      setSaveState((s) => ({ ...s, [qid]: 'queued' }));
      return false;
    }
  }, [runId, persistQueue]);

  /** Retry everything the phone is holding. Serial on purpose — order matters. */
  const flushQueue = useCallback(async () => {
    const ids = Object.keys(queueRef.current);
    for (const qid of ids) {
      const d = queueRef.current[qid];
      if (!d) continue;
      const ok = await pushAnswer(qid, d, { silent: true });
      if (!ok && queueRef.current[qid]) break;   // still offline; stop hammering
    }
  }, [pushAnswer]);

  useEffect(() => {
    if (!canWrite) return;
    const t = window.setInterval(() => { if (Object.keys(queueRef.current).length) void flushQueue(); }, 12_000);
    const on = () => { void flushQueue(); };
    window.addEventListener('online', on);
    return () => { window.clearInterval(t); window.removeEventListener('online', on); };
  }, [canWrite, flushQueue]);

  /**
   * ONE CHANGE TO ONE ANSWER: keep it, then send it.
   *
   * The next draft is computed OUTSIDE the state updater on purpose. A React
   * updater must be pure — sending a request from inside one fires twice under
   * StrictMode — and the ref is kept in step here as well as on render, so two
   * changes in the same tick still build on each other.
   *
   * A TAP GOES AT ONCE; TYPING WAITS 900ms. A tap is a finished decision and the
   * round must be safe the moment it is made. Typing is not finished until the
   * thumb stops, and one POST per keystroke on a phone in a cold room is how you
   * lose the connection you were trying to use.
   */
  const timers = useRef<Record<string, number>>({});
  const setDraft = useCallback((qid: string, patch: Partial<Draft>, mode: 'now' | 'typing') => {
    const next: Draft = { ...(draftsRef.current[qid] || emptyDraft()), ...patch };
    draftsRef.current = { ...draftsRef.current, [qid]: next };
    setDrafts((d) => ({ ...d, [qid]: next }));
    if (!questionById.has(qid)) return;
    if (timers.current[qid]) window.clearTimeout(timers.current[qid]);
    if (mode === 'now') {
      void pushAnswer(qid, next);
    } else {
      setSaveState((s) => ({ ...s, [qid]: 'saving' }));
      timers.current[qid] = window.setTimeout(() => { void pushAnswer(qid, next); }, 900);
    }
  }, [pushAnswer, questionById]);

  /* ── photographs ──────────────────────────────────────────────────── */

  const evidenceFor = useCallback(
    (qid: string) => evidence.filter((e) => String(e.question_id || '') === qid),
    [evidence],
  );

  const attachPhoto = useCallback(async (q: QuestionRow, file: File) => {
    const qid = String(q.id);
    setPhotoErr((e) => ({ ...e, [qid]: '' }));
    setPhotoBusy((b) => ({ ...b, [qid]: true }));
    try {
      const shrunk = await shrinkPhotoToDataUri(file);
      if (!shrunk.ok) { setPhotoErr((e) => ({ ...e, [qid]: shrunk.error })); return; }

      const post = () => api('/api/fssai/evidence', {
        method: 'POST',
        body: { run_id: runId, question_id: qid, data_uri: shrunk.data_uri, filename: shrunk.filename, kind: 'photo' },
      });

      let res = await post();
      let j = await res.json().catch(() => null);

      // The route's own contract: an attachment hangs off an ANSWER ROW, so if
      // there is no answer yet it says so with code 'answer_first'. That is a step
      // the runner takes for the person, not an error they should have to read.
      if (!res.ok && res.status === 409 && j?.code === 'answer_first') {
        const wrote = await pushAnswer(qid, draftsRef.current[qid] || emptyDraft());
        if (!wrote) {
          setPhotoErr((e) => ({ ...e, [qid]: 'The answer could not be written down first, so the photograph has nowhere to go yet. It will work once you are back online.' }));
          return;
        }
        res = await post();
        j = await res.json().catch(() => null);
      }

      if (!res.ok) {
        setPhotoErr((e) => ({ ...e, [qid]: String(j?.error || `HTTP ${res.status}`) }));
        return;
      }
      if (j?.response) setResponses((m) => ({ ...m, [qid]: j.response as ResponseRow }));
      if (j?.verdict) setVerdicts((v) => ({ ...v, [qid]: j.verdict as Verdict }));
      if (typeof j?.answered_count === 'number') {
        setRun((r) => (r ? { ...r, answered_count: Number(j.answered_count) } : r));
      }
      await loadEvidence();
    } catch {
      setPhotoErr((e) => ({ ...e, [qid]: 'The photograph could not be sent. Check the signal and try again — nothing else in the round is lost.' }));
    } finally {
      setPhotoBusy((b) => ({ ...b, [qid]: false }));
    }
  }, [runId, pushAnswer, loadEvidence]);

  const removePhoto = useCallback(async (ev: EvidenceMeta) => {
    const qid = String(ev.question_id || '');
    setPhotoBusy((b) => ({ ...b, [qid]: true }));
    try {
      const res = await api(`/api/fssai/evidence?id=${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setPhotoErr((e) => ({ ...e, [qid]: String(j?.error || `HTTP ${res.status}`) })); return; }
      if (j?.response) setResponses((m) => ({ ...m, [qid]: j.response as ResponseRow }));
      if (typeof j?.answered_count === 'number') {
        setRun((r) => (r ? { ...r, answered_count: Number(j.answered_count) } : r));
      }
      await loadEvidence();
    } catch {
      setPhotoErr((e) => ({ ...e, [qid]: 'The photograph could not be removed just now.' }));
    } finally {
      setPhotoBusy((b) => ({ ...b, [qid]: false }));
    }
  }, [loadEvidence]);

  const viewPhoto = useCallback(async (meta: EvidenceMeta) => {
    try {
      const res = await api(`/api/fssai/evidence?id=${encodeURIComponent(meta.id)}`);
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.evidence?.data_uri) return;
      setViewing({ meta, data_uri: String(j.evidence.data_uri) });
    } catch { /* a thumbnail that will not open is not worth a banner */ }
  }, []);

  /* ── submit · takeover · void ─────────────────────────────────────── */

  /**
   * SUBMIT — and, where the checklist demands one, SIGN in the same press.
   *
   * WHY `sign: true` IS IN THE BODY. Submitting no longer stamps a signature by
   * itself (it used to, for every record, without anyone being asked — see the
   * signature gate in api/fssai/runs/route.ts). The engine now offers the phone a
   * one-tap path, `{action:'submit', sign:true}`, on the condition that the person
   * was shown the statement first. That is exactly what the sheet above this
   * button does, and it is the owner's §22 order of work: Readings → Photo →
   * Remarks → Sign → Submit, in one deliberate press rather than two screens.
   *
   * If the server still refuses (`signature_required` / `signature_stale` — the
   * two-step path, or an answer that changed after signing), its own sentence and
   * its own statement go on screen, with one button that signs and submits again.
   */
  const submit = useCallback(async (opts: { signFirst?: boolean } = {}) => {
    setSubmitting(true);
    setSubmitErr('');
    setMissing([]);
    setSigNotice(null);
    try {
      if (Object.keys(queueRef.current).length) {
        await flushQueue();
        if (Object.keys(queueRef.current).length) {
          setSubmitErr(`${Object.keys(queueRef.current).length} answer${Object.keys(queueRef.current).length === 1 ? '' : 's'} on this phone have not reached the server yet. They will go as soon as there is signal — the check cannot be submitted until they do.`);
          return;
        }
      }
      if (opts.signFirst) {
        // The explicit act, for a server that wants it on its own endpoint.
        const sres = await api('/api/fssai/sign', { method: 'POST', body: { run_id: runId } });
        if (!sres.ok && sres.status !== 404) {
          const sj = await sres.json().catch(() => null);
          setSubmitErr(String(sj?.error || `The check could not be signed (HTTP ${sres.status}).`));
          return;
        }
      }
      const res = await api('/api/fssai/runs', {
        method: 'POST',
        // `sign` is meaningless to a build without the signature gate and is
        // ignored there, so one body serves both.
        body: { action: 'submit', run_id: runId, remarks, sign: needsSignature ? true : undefined },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        // THE REFUSAL, AS THE SERVER WROTE IT — including the list of what it is
        // waiting for, question by question.
        setSubmitErr(String(j?.error || `HTTP ${res.status}`));
        if (Array.isArray(j?.missing)) setMissing(j.missing as MissingRow[]);
        if (j?.code === 'signature_required' || j?.code === 'signature_stale') {
          setSigNotice({
            message: String(j.error || ''),
            statement: String(j.statement || FSSAI_SIGNATURE_STATEMENT),
            endpoint: String(j.sign_endpoint || '/api/fssai/sign'),
          });
        }
        return;
      }
      setDone({
        outcome: String(j?.summary?.outcome || ''),
        pass_pct: Number(j?.summary?.pass_pct ?? 0),
        fail_count: Number(j?.summary?.fail_count ?? 0),
        counted_retired: Number(j?.counted_retired_questions ?? 0),
        // The engine says whether somebody else still has to look at it. Said
        // here rather than guessed from the template flag, so the two cannot
        // disagree — the verification screen is another lane's, and this is the
        // one sentence that hands the record over to it.
        awaiting_verification: !!j?.awaiting_verification,
      });
      try { localStorage.removeItem(draftKey(runId)); localStorage.removeItem(queueKey(runId)); } catch { /* storage off */ }
      await load();
    } catch {
      setSubmitErr('The check could not be submitted — the phone could not reach the server. Your answers are saved; try again when there is signal.');
    } finally {
      setSubmitting(false);
    }
  }, [runId, remarks, flushQueue, load, needsSignature]);

  const takeover = useCallback(async () => {
    setTakeoverBusy(true);
    setTakeoverErr('');
    try {
      const res = await api('/api/fssai/runs', {
        method: 'POST', body: { action: 'takeover', run_id: runId, reason: takeoverReason },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setTakeoverErr(String(j?.error || `HTTP ${res.status}`)); return; }
      setTakeoverOpen(false);
      setTakeoverReason('');
      await load();
    } catch {
      setTakeoverErr('Could not hand the check over just now.');
    } finally {
      setTakeoverBusy(false);
    }
  }, [runId, takeoverReason, load]);

  const voidRun = useCallback(async () => {
    setVoidBusy(true);
    setVoidErr('');
    try {
      const res = await api('/api/fssai/runs', {
        method: 'POST', body: { action: 'void', run_id: runId, reason: voidReason },
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) { setVoidErr(String(j?.error || `HTTP ${res.status}`)); return; }
      setVoidOpen(false);
      setVoidReason('');
      await load();
    } catch {
      setVoidErr('Could not void the record just now.');
    } finally {
      setVoidBusy(false);
    }
  }, [runId, voidReason, load]);

  /* ── what is still unfinished, for the bar and the cards ──────────── */

  /**
   * IS THIS CARD FINISHED, AND WHAT IS IT WAITING FOR?
   *
   * TWO SOURCES, AND THE LINE BETWEEN THEM IS THE WHOLE POINT:
   *   · WHETHER IT FAILED comes ONLY from the frozen `is_fail` on the answer row.
   *     Never computed here, for a colour or for anything else — the pass rule
   *     belongs to the version the answer was given under, and recomputing it on
   *     read is how history gets rewritten (RECON §10 R3).
   *   · WHETHER IT IS FINISHED is evaluated locally with the engine's OWN pure
   *     predicate, over the live question and what is on screen. That is the same
   *     function the server's completeness check calls, so the two cannot drift —
   *     and it is why a round RESUMED after a reload still shows "still needs a
   *     photograph" before any request has been made. Without it a resumed round
   *     with an unfinished answer looked complete until submit refused it.
   * The server's last verdict wins over the local one for the words, because it
   * saw the row as stored.
   */
  const cardState = useCallback((q: QuestionRow): { tone: 'none' | 'waiting' | 'fail' | 'done'; line: string } => {
    const qid = String(q.id);
    const r = responses[qid];
    const v = verdicts[qid];
    const d = drafts[qid] || emptyDraft();
    const evCount = evidenceFor(qid).length;

    const local = qtypeMeta(q.qtype)
      ? evaluateFssaiAnswer(
        {
          qtype: String(r?.qtype || q.qtype || ''),
          is_required: q.is_required, allow_na: q.allow_na,
          min_value: q.min_value, max_value: q.max_value, expected_value: q.expected_value,
          options: q.options, fail_options: q.fail_options,
          photo_rule: q.photo_rule, note_rule: q.note_rule,
        },
        {
          value_text: d.text,
          value_num: d.num.trim() === '' ? null : Number(d.num),
          value_bool: d.bool,
          is_na: d.na,
          note: d.note,
          evidence_count: evCount,
        },
      )
      : null;

    const hasAnything = draftHasValue(q, d) || (q.qtype === 'photo' && evCount > 0) || !!r;
    const finished = v ? v.answered : (local ? local.answered : !!r);

    if (r && Number(r.is_fail)) {
      return { tone: 'fail', line: v?.reason || local?.reason || 'Recorded as a fail.' };
    }
    if (!hasAnything) {
      return Number(q.is_required)
        ? { tone: 'waiting', line: 'Still needs an answer.' }
        : { tone: 'none', line: 'Optional.' };
    }
    if (!finished) {
      // INCOMPLETE, NOT FAILED — the engine's own words for what it is waiting for.
      return { tone: 'waiting', line: v?.reason || local?.reason || 'This answer is not finished yet.' };
    }
    return { tone: 'done', line: '' };
  }, [responses, verdicts, drafts, evidenceFor]);

  const unfinished = useMemo(
    () => questions.filter((q) => Number(q.is_required) && cardState(q).tone !== 'done' && cardState(q).tone !== 'fail'),
    [questions, cardState],
  );

  const grouped = useMemo(() => {
    const out: Array<{ section: SectionRow | null; rows: QuestionRow[] }> = [];
    const ordered = [...questions].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    const secOrder = [...sections].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    for (const s of secOrder) {
      const rows = ordered.filter((q) => String(q.section_id || '') === String(s.id));
      if (rows.length) out.push({ section: s, rows });
    }
    const loose = ordered.filter((q) => !q.section_id || !secOrder.some((s) => String(s.id) === String(q.section_id)));
    if (loose.length) out.push({ section: null, rows: loose });
    return out;
  }, [questions, sections]);

  const jumpTo = useCallback((qid: string) => {
    setSubmitOpen(false);
    window.setTimeout(() => {
      document.getElementById(`q-${qid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }, []);

  /* ── render: the states before the sheet ──────────────────────────── */

  if (loading) {
    return (
      <div className={`min-h-screen ${RUNNER_BG}`}>
        <div className="max-w-2xl mx-auto px-1 sm:px-3 py-6">
          <p className="text-sm text-[#8B7355] flex items-center gap-2 flex-nowrap">
            <Loader2 size={16} className="animate-spin" /> Opening the check…
          </p>
        </div>
      </div>
    );
  }

  if (loadErr || !run) {
    return (
      <div className={`min-h-screen ${RUNNER_BG} text-[#2D1B0E]`}>
        <div className="max-w-2xl mx-auto px-1 sm:px-3 py-5 space-y-4">
          <PageHead icon={<AlertTriangle size={20} />} eyebrow="Food safety" title="This check did not open" />
          <Note tone="amber">{loadErr || 'That check no longer exists.'}</Note>
          <SecondaryButton href="/fssai/checklists/run"><ArrowLeft size={16} /> Back to the checks</SecondaryButton>
        </div>
      </div>
    );
  }

  const heading = tpl?.name || 'Check';
  const targetLine = run.target_label
    ? `${targetPrompt(run.target_kind) ? `${targetPrompt(run.target_kind)} ` : ''}${run.target_label}`
    : '';

  return (
    <div className={`min-h-screen ${RUNNER_BG} text-[#2D1B0E]`}>
      <div className="max-w-2xl mx-auto px-1 sm:px-3 py-4 space-y-3">

        {/* ── who and what ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-nowrap">
          <a
            href="/fssai/checklists/run"
            className="w-11 h-11 rounded-xl border border-[#E8D5C4] bg-white flex items-center justify-center text-[#3D2614] shrink-0"
            aria-label="Back to the checks"
          >
            <ArrowLeft size={18} />
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold text-[#af4408] leading-tight truncate">{heading}</h1>
            <p className="text-[11px] text-[#8B7355] truncate">
              {run.business_date}
              {run.shift ? ` · ${shiftLabel(run.shift)}` : ''}
              {targetLine ? ` · ${targetLine}` : ''}
            </p>
          </div>
          <RunStatusChip status={run.status} />
        </div>

        {renamedTo && (
          <Note tone="info">
            This record was taken as <strong>{tpl?.name}</strong>. The checklist is now called <strong>{renamedTo}</strong>.
          </Note>
        )}
        {isOpen && editedSince && (
          <Note tone="amber" title="The checklist was edited after you started">
            You are filling in version {run.template_version}. Anything an administrator has changed since
            will apply to the next round, not to this one.
          </Note>
        )}
        {Number(run.is_backdated) ? (
          <Note tone="amber" title={`Recorded for ${run.business_date}, not for today`}>
            {run.backdate_reason}
          </Note>
        ) : null}

        {/* ── whose round is this? ─────────────────────────────────────── */}
        {isOpen && !mine && (
          <div className={`${CARD} p-3.5 space-y-3`}>
            <div className="flex items-start gap-2.5 flex-nowrap">
              <UserCheck size={18} className="text-[#af4408] shrink-0 mt-0.5" />
              <div className="min-w-0 text-sm">
                <p className="font-bold">
                  {run.recorded_name || run.recorded_by} has this check open
                  {clockOf(run.started_at) ? ` since ${clockOf(run.started_at)}` : ''}.
                </p>
                <p className="text-[#6B5744] mt-1">
                  {Number(run.answered_count) || 0} of {Number(run.total_count) || 0} answered. Only the person
                  holding a check can fill it in — two people writing into one round leaves a record nobody signed.
                  Whoever ends up holding it is who the record is signed by.
                </p>
              </div>
            </div>
            {me && canTakeOverFssaiRun(me) ? (
              <PrimaryButton onClick={() => setTakeoverOpen(true)}>
                <UserCheck size={18} /> Take it over
              </PrimaryButton>
            ) : (
              <p className="text-xs text-[#8B7355]">A manager can hand it over to you.</p>
            )}
          </div>
        )}

        {/* ── the phone is holding answers ─────────────────────────────── */}
        {queued.length > 0 && (
          <Note tone="amber" title={`${queued.length} answer${queued.length === 1 ? '' : 's'} saved on this phone only`} icon={<CloudOff size={17} />}>
            <p className="mt-1">
              {online
                ? 'The app keeps trying to send them. Nothing is lost — you can carry on answering.'
                : 'There is no signal. Carry on answering: they will be sent as soon as there is, even if the screen locks.'}
            </p>
            <button type="button" onClick={() => void flushQueue()} className="mt-2 font-semibold underline min-h-[44px]">
              Try now
            </button>
          </Note>
        )}

        {/* ══════════════ A FINISHED RECORD ══════════════ */}
        {!isOpen && (
          <FinishedRecord
            run={run}
            tpl={tpl}
            sheet={sheet}
            responses={responses}
            evidence={evidence}
            onView={(m) => void viewPhoto(m)}
            canVoid={!!me && canTakeOverFssaiRun(me) && run.status !== 'void'}
            onVoid={() => setVoidOpen(true)}
            justSubmitted={done}
            awaitingVerification={
              (done ? done.awaiting_verification : false)
              || (run.status === 'submitted' && !!Number(tpl?.requires_verification ?? 0))
            }
          />
        )}

        {/* ══════════════ AN OPEN ROUND ══════════════ */}
        {isOpen && grouped.map(({ section, rows }, gi) => (
          <section key={section?.id || `loose-${gi}`} className="space-y-2.5">
            {section ? (
              <div className="px-1 pt-1">
                <h2 className="text-sm font-bold text-[#6B5744]">{section.title}</h2>
                {section.description ? <p className="text-[11px] text-[#8B7355]">{section.description}</p> : null}
              </div>
            ) : grouped.length > 1 ? (
              <div className="px-1 pt-1"><h2 className="text-sm font-bold text-[#6B5744]">Everything else</h2></div>
            ) : null}

            {rows.map((q) => (
              <QuestionCard
                key={q.id}
                index={questions.findIndex((x) => x.id === q.id) + 1}
                total={questions.length}
                q={q}
                draft={drafts[String(q.id)] || emptyDraft()}
                response={responses[String(q.id)]}
                verdict={verdicts[String(q.id)]}
                state={cardState(q)}
                saveState={saveState[String(q.id)] || 'idle'}
                saveErr={saveErr[String(q.id)] || ''}
                evidence={evidenceFor(String(q.id))}
                photoBusy={!!photoBusy[String(q.id)]}
                photoErr={photoErr[String(q.id)] || ''}
                maxPhotos={evLimits?.max_per_answer ?? 4}
                canWrite={canWrite}
                me={me}
                onDraft={(patch, mode) => setDraft(String(q.id), patch, mode)}
                onPhoto={(f) => void attachPhoto(q, f)}
                onRemovePhoto={(ev) => void removePhoto(ev)}
                onViewPhoto={(m) => void viewPhoto(m)}
              />
            ))}
          </section>
        ))}

        {isOpen && questions.length === 0 && (
          <Note tone="amber" title="There are no questions on this check">
            Every question has been switched off since it was started. An administrator has to put them
            back before this round can be filled in.
          </Note>
        )}
      </div>

      {/* ── THE BAR THAT IS ALWAYS UNDER THE THUMB ─────────────────────── */}
      {isOpen && canWrite && questions.length > 0 && (
        <div className="sticky bottom-0 z-30 border-t border-[#E8D5C4] bg-[#FFF8F0]/95 backdrop-blur">
          <div className="max-w-2xl mx-auto px-2 sm:px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2 flex-nowrap">
              <div className="min-w-0 flex-1">
                <Progress done={Number(run.answered_count) || 0} total={Number(run.total_count) || 0} />
              </div>
              <span className="text-xs font-semibold text-[#6B5744] shrink-0 tabular-nums">
                {Number(run.answered_count) || 0}/{Number(run.total_count) || 0}
              </span>
            </div>
            <PrimaryButton onClick={() => { setSubmitErr(''); setMissing([]); setSubmitOpen(true); }}>
              {unfinished.length > 0
                ? <>{unfinished.length} still to do — review</>
                : <><Check size={18} /> {needsSignature ? 'Sign and submit' : 'Submit the check'}</>}
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* ── SUBMIT ─────────────────────────────────────────────────────── */}
      <Sheet
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        busy={submitting}
        title={needsSignature ? 'Sign and submit' : 'Submit this check'}
        subtitle={`${Number(run.answered_count) || 0} of ${Number(run.total_count) || 0} answered`}
        footer={
          <>
            <PrimaryButton onClick={() => void submit()} busy={submitting} disabled={submitting}>
              {needsSignature ? <><PenLine size={18} /> Sign and submit</> : <><Check size={18} /> Submit</>}
            </PrimaryButton>
            <SecondaryButton onClick={() => setSubmitOpen(false)} disabled={submitting}>Keep filling it in</SecondaryButton>
          </>
        }
      >
        {unfinished.length > 0 && (
          <Note tone="amber" title={`${unfinished.length} question${unfinished.length === 1 ? '' : 's'} still unfinished`}>
            <ul className="mt-1.5 space-y-1.5">
              {unfinished.slice(0, 8).map((q) => (
                <li key={q.id}>
                  <button type="button" onClick={() => jumpTo(String(q.id))} className="text-left underline font-semibold">
                    {q.prompt}
                  </button>
                  <span className="block text-[11px]">{cardState(q).line}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px]">
              An unfinished answer is not a failure — it is paperwork the check is still waiting for.
            </p>
          </Note>
        )}

        <Field label="Anything else worth recording?" hint="Optional. It is kept with the record.">
          <textarea
            value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3}
            placeholder="The chiller door was left open at 18:40; kitchen told."
            className={INPUT}
          />
        </Field>

        {needsSignature ? (
          <div className="rounded-xl border border-[#E8D5C4] bg-[#FFF1E3] p-3">
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">Signing this check</p>
            <p className="text-sm mt-1">&ldquo;{FSSAI_SIGNATURE_STATEMENT}&rdquo;</p>
            <p className="text-xs text-[#6B5744] mt-2">
              Signed as <strong>{me?.name || me?.email}</strong> at the moment you submit. The signature is
              your account and the time — it says the sheet was attested by whoever was signed in, not that
              somebody drew a mark.
            </p>
          </div>
        ) : null}

        {sigNotice && (
          <Note tone="amber" title="This check still has to be signed">
            <p className="mt-1">{sigNotice.message}</p>
            <p className="mt-2 text-sm">&ldquo;{sigNotice.statement}&rdquo;</p>
            <button
              type="button" onClick={() => void submit({ signFirst: true })} disabled={submitting}
              className="mt-2 font-semibold underline min-h-[44px]"
            >
              Sign it and submit
            </button>
          </Note>
        )}

        {submitErr && (
          <Note tone="red" title="Not submitted">
            <p className="mt-1">{submitErr}</p>
            {missing.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {missing.map((m) => (
                  <li key={m.question_id}>
                    <button type="button" onClick={() => jumpTo(String(m.question_id))} className="text-left underline font-semibold">
                      {m.prompt}
                    </button>
                    <span className="block text-[11px]">{m.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </Note>
        )}
      </Sheet>

      {/* ── TAKEOVER ───────────────────────────────────────────────────── */}
      <Sheet
        open={takeoverOpen}
        onClose={() => setTakeoverOpen(false)}
        busy={takeoverBusy}
        title="Take this check over"
        subtitle={`Open in ${run.recorded_name || run.recorded_by}'s name`}
        footer={
          <>
            <PrimaryButton onClick={() => void takeover()} busy={takeoverBusy} disabled={!takeoverReason.trim() || takeoverBusy}>
              <UserCheck size={18} /> Take it over
            </PrimaryButton>
            <SecondaryButton onClick={() => setTakeoverOpen(false)} disabled={takeoverBusy}>Leave it with them</SecondaryButton>
          </>
        }
      >
        <p className="text-sm">
          The answers already given keep {run.recorded_name || run.recorded_by}&rsquo;s name against them, and
          anything from now on carries yours. The record will be signed by whoever submits it, so this is
          recorded with your reason.
        </p>
        <Field label="Why are you taking it over?" required>
          <input
            value={takeoverReason} onChange={(e) => setTakeoverReason(e.target.value)}
            placeholder="Shift ended before the round was finished"
            className={INPUT}
          />
        </Field>
        {takeoverErr && <Note tone="red">{takeoverErr}</Note>}
      </Sheet>

      {/* ── VOID ───────────────────────────────────────────────────────── */}
      <Sheet
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        busy={voidBusy}
        title="Void this record"
        subtitle="It stays in the file, marked void, with your reason"
        footer={
          <>
            <PrimaryButton onClick={() => void voidRun()} busy={voidBusy} disabled={!voidReason.trim() || voidBusy}>
              <Ban size={18} /> Void it
            </PrimaryButton>
            <SecondaryButton onClick={() => setVoidOpen(false)} disabled={voidBusy}>Keep the record</SecondaryButton>
          </>
        }
      >
        <Note tone="amber" title="Voiding is for a record entered by mistake">
          It is not the way to record a problem that has since been fixed: a voided failure beside a fresh
          pass reads as though the failure never happened. A repair belongs against the failed record.
        </Note>
        <Field label="Why is it being voided?" required>
          <input
            value={voidReason} onChange={(e) => setVoidReason(e.target.value)}
            placeholder="Filed against the wrong cold room"
            className={INPUT}
          />
        </Field>
        {voidErr && <Note tone="red">{voidErr}</Note>}
      </Sheet>

      {/* ── ONE PHOTOGRAPH, FULL SIZE ──────────────────────────────────── */}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          <div className="flex items-center gap-3 p-3 flex-nowrap">
            <p className="text-white text-xs min-w-0 flex-1 truncate">
              {viewing.meta.filename} · {fssaiBytesLabel(viewing.meta.size_bytes)}
            </p>
            <button
              type="button" onClick={() => setViewing(null)} aria-label="Close"
              className="w-11 h-11 rounded-lg bg-white/15 text-white flex items-center justify-center shrink-0"
            >
              <X size={20} />
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center p-3 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.data_uri} alt={viewing.meta.caption || 'Photograph on this check'} className="max-w-full max-h-full rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * ONE QUESTION
 * ================================================================== */

function QuestionCard({
  index, total, q, draft, response, verdict, state, saveState, saveErr, evidence,
  photoBusy, photoErr, maxPhotos, canWrite, me, onDraft, onPhoto, onRemovePhoto, onViewPhoto,
}: {
  index: number;
  total: number;
  q: QuestionRow;
  draft: Draft;
  response?: ResponseRow;
  verdict?: Verdict;
  state: { tone: 'none' | 'waiting' | 'fail' | 'done'; line: string };
  saveState: SaveState;
  saveErr: string;
  evidence: EvidenceMeta[];
  photoBusy: boolean;
  photoErr: string;
  maxPhotos: number;
  canWrite: boolean;
  me: Me | null;
  onDraft: (patch: Partial<Draft>, mode: 'now' | 'typing') => void;
  onPhoto: (f: File) => void;
  onRemovePhoto: (ev: EvidenceMeta) => void;
  onViewPhoto: (m: EvidenceMeta) => void;
}) {
  const meta = qtypeMeta(q.qtype);
  /* AMBER ONLY WHEN SOMETHING IS ACTUALLY WAITING. "Photo if it fails" must not
   * nag before anything has failed — the engine's verdict says when it is owed,
   * and `always` is owed from the start. */
  const needsPhoto = (q.photo_rule === 'always' && evidence.length === 0) || !!verdict?.needs_photo
    || (state.tone === 'waiting' && /photograph/i.test(state.line));
  const needsNote = (q.note_rule === 'always' && !String(draft.note || '').trim()) || !!verdict?.needs_note
    || (state.tone === 'waiting' && /note/i.test(state.line));
  const [showNote, setShowNote] = useState(
    () => !!String(draft.note || '') || q.note_rule === 'always',
  );

  useEffect(() => {
    if (verdict?.needs_note) setShowNote(true);
  }, [verdict?.needs_note]);

  const fileRef = useRef<HTMLInputElement | null>(null);

  /**
   * A TYPE THIS BUILD DOES NOT KNOW IS NEVER DRAWN AS A BLANK FIELD (RECON §10
   * R1). A checklist edited by a newer version of the app could name a question
   * type this one has never heard of; guessing at a control for it would record an
   * answer to a question nobody can read back.
   */
  if (!meta || q.qtype_known === false) {
    return (
      <div id={`q-${q.id}`} className={`${CARD} p-3.5`}>
        <p className="font-semibold">{q.prompt}</p>
        <div className="mt-2">
          <Note tone="red" title="This question cannot be shown on this phone">
            It is of a kind this version of the app does not know (&ldquo;{q.qtype}&rdquo;). An administrator
            has to open it in Settings. Nothing has been recorded against it.
          </Note>
        </div>
      </div>
    );
  }

  const border =
    state.tone === 'fail' ? 'border-red-300' :
    state.tone === 'waiting' ? 'border-amber-300' :
    state.tone === 'done' ? 'border-green-300' : 'border-[#E8D5C4]';

  const answered = state.tone === 'done' || state.tone === 'fail';

  return (
    <div id={`q-${q.id}`} className={`bg-white rounded-xl border ${border} p-3.5 space-y-3`}>
      {/* the question */}
      <div className="flex items-start gap-2.5 flex-nowrap">
        <span className="text-[11px] font-bold text-[#8B7355] tabular-nums shrink-0 mt-1">{index}/{total}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug break-words">
            {q.prompt}
            {!Number(q.is_required) ? <span className="text-[#8B7355] font-normal"> (optional)</span> : null}
          </p>
          {q.help_text ? <p className="text-xs text-[#8B7355] mt-1 break-words">{q.help_text}</p> : null}
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {Number(q.is_critical) ? (
              <Chip className="bg-red-50 text-red-700 border-red-200">Critical — one failure fails the round</Chip>
            ) : null}
            {q.photo_rule === 'always' ? <Chip>Photograph needed</Chip> : q.photo_rule === 'on_fail' ? <Chip>Photograph if it fails</Chip> : null}
            {q.note_rule === 'always' ? <Chip>Note needed</Chip> : q.note_rule === 'on_fail' ? <Chip>Note if it fails</Chip> : null}
          </div>
        </div>
        <span className="shrink-0 mt-0.5">
          {saveState === 'saving' ? <Loader2 size={16} className="animate-spin text-[#8B7355]" />
            : saveState === 'queued' ? <CloudOff size={16} className="text-amber-600" />
            : answered ? <CheckCircle2 size={17} className={state.tone === 'fail' ? 'text-red-600' : 'text-green-600'} />
            : null}
        </span>
      </div>

      {/* N/A — never removes a question, it records that it did not apply */}
      {canWrite && Number(q.allow_na) ? (
        <button
          type="button"
          onClick={() => onDraft({ na: !draft.na }, 'now')}
          className={`w-full min-h-[44px] rounded-lg border text-sm font-semibold px-3
                      ${draft.na ? 'bg-[#3D2614] text-white border-[#3D2614]' : 'bg-white text-[#6B5744] border-[#E8D5C4]'}`}
        >
          {draft.na ? 'Marked: does not apply today' : 'Does not apply today'}
        </button>
      ) : null}

      {/* the answer itself */}
      {!draft.na && (
        <>
          {(meta.key === 'yes_no' || meta.key === 'pass_fail') && (
            <TwoButtonAnswer
              yesLabel={meta.key === 'yes_no' ? 'Yes' : 'Pass'}
              noLabel={meta.key === 'yes_no' ? 'No' : 'Fail'}
              value={draft.bool}
              disabled={!canWrite}
              onPick={(b) => onDraft({ bool: b, text: '' }, 'now')}
            />
          )}

          {(meta.key === 'numeric' || meta.key === 'temperature') && (
            <ReadingAnswer q={q} draft={draft} disabled={!canWrite} onDraft={onDraft} />
          )}

          {meta.key === 'multiple_choice' && (
            <div className="space-y-2">
              {q.options.length === 0 && (
                <Note tone="amber">This question has no answers to choose from yet. An administrator has to add them.</Note>
              )}
              {q.options.map((o) => {
                const picked = draft.text === o;
                return (
                  <button
                    key={o} type="button" disabled={!canWrite}
                    onClick={() => onDraft({ text: o }, 'now')}
                    className={`w-full min-h-[52px] rounded-xl border px-3 text-left text-base font-semibold
                                disabled:opacity-60 ${picked ? 'bg-[#3D2614] text-white border-[#3D2614]' : 'bg-white text-[#2D1B0E] border-[#E8D5C4]'}`}
                  >
                    <span className="flex items-center gap-2 flex-nowrap">
                      {picked ? <Check size={17} className="shrink-0" /> : null}
                      <span className="min-w-0 break-words">{o}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {meta.key === 'text' && (
            <textarea
              value={draft.text} disabled={!canWrite} rows={3}
              onChange={(e) => onDraft({ text: e.target.value }, 'typing')}
              placeholder="What did you see?"
              className={INPUT}
            />
          )}

          {meta.key === 'signature' && (
            <div className="space-y-2">
              {response?.value_text ? (
                <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-900">
                  <p className="font-semibold">Signed by {response.value_text}</p>
                  <p className="text-xs mt-0.5">{clockOf(response.answered_at) ? `at ${clockOf(response.answered_at)}` : ''}</p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-[#6B5744]">&ldquo;{FSSAI_SIGNATURE_STATEMENT}&rdquo;</p>
                  <PrimaryButton disabled={!canWrite} onClick={() => onDraft({ text: me?.email || '' }, 'now')}>
                    <PenLine size={18} /> Sign as {me?.name || me?.email || 'me'}
                  </PrimaryButton>
                </>
              )}
            </div>
          )}

          {meta.key === 'photo' && (
            <p className="text-xs text-[#6B5744]">
              A photograph is the answer to this one. Use the camera button below.
            </p>
          )}
        </>
      )}

      {/* the server's last word on this answer */}
      {state.tone === 'fail' && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-sm text-red-800">
          <p className="font-bold flex items-center gap-1.5 flex-nowrap"><AlertTriangle size={15} /> Recorded as a fail</p>
          {state.line ? <p className="mt-0.5">{state.line}</p> : null}
        </div>
      )}
      {state.tone === 'waiting' && state.line && (
        <p className="text-xs font-semibold text-amber-800">{state.line}</p>
      )}
      {saveErr && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-2.5 text-sm text-red-800">
          <p className="font-bold">That answer was not accepted</p>
          <p className="mt-0.5 break-words">{saveErr}</p>
        </div>
      )}

      {/* note + photographs */}
      {(canWrite || String(response?.note || '') || evidence.length > 0) && (
        <div className="space-y-2 pt-1">
          <div className="flex gap-2 flex-nowrap">
            {canWrite && (
              <>
                <button
                  type="button" onClick={() => fileRef.current?.click()} disabled={photoBusy || evidence.length >= maxPhotos}
                  className={`flex-1 min-h-[48px] rounded-xl border text-sm font-semibold inline-flex items-center justify-center gap-2 flex-nowrap
                              disabled:opacity-45 ${needsPhoto ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-[#E8D5C4] bg-white text-[#3D2614]'}`}
                >
                  {photoBusy ? <Loader2 size={16} className="animate-spin" /> : <Camera size={17} />}
                  {evidence.length > 0 ? `Photo (${evidence.length}/${maxPhotos})` : 'Take a photo'}
                </button>
                <button
                  type="button" onClick={() => setShowNote((v) => !v)}
                  className={`flex-1 min-h-[48px] rounded-xl border text-sm font-semibold inline-flex items-center justify-center gap-2 flex-nowrap
                              ${needsNote ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-[#E8D5C4] bg-white text-[#3D2614]'}`}
                >
                  <PenLine size={17} /> {draft.note ? 'Edit the note' : 'Add a note'}
                </button>
              </>
            )}
          </div>
          <input
            ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Clear the input so taking the SAME photograph twice still fires.
              e.target.value = '';
              if (f) onPhoto(f);
            }}
          />
          {photoErr && <Note tone="red">{photoErr}</Note>}

          {(showNote || !!String(response?.note || '')) && (
            <div>
              {canWrite ? (
                <textarea
                  value={draft.note} rows={2}
                  onChange={(e) => onDraft({ note: e.target.value }, 'typing')}
                  placeholder={q.note_rule === 'always' ? 'A note is needed on this question' : 'Anything worth writing down'}
                  className={INPUT}
                />
              ) : String(response?.note || '') ? (
                <p className="text-sm text-[#3D2614] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2.5 break-words">{response?.note}</p>
              ) : null}
            </div>
          )}

          {evidence.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {evidence.map((ev) => (
                <div key={ev.id} className="relative">
                  <button
                    type="button" onClick={() => onViewPhoto(ev)}
                    className="w-20 h-20 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex flex-col items-center justify-center text-[10px] text-[#6B5744] px-1"
                  >
                    <ImageIcon size={18} className="text-[#af4408]" />
                    <span className="mt-0.5">{fssaiBytesLabel(ev.size_bytes)}</span>
                    <span>{clockOf(ev.created_at)}</span>
                  </button>
                  {canWrite && (
                    /* THE ONE CONTROL ON THIS SCREEN DELIBERATELY UNDER 44px.
                       Everything a person is meant to press in a kitchen is 48-56px;
                       this removes evidence from a food-safety record, and a wet
                       thumb brushing the corner of a thumbnail must not do that. It
                       is 32px, off the corner of an 80px tile, and the removal is
                       audited either way. */
                    <button
                      type="button" onClick={() => onRemovePhoto(ev)} aria-label="Remove this photograph"
                      className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-white border border-[#E8D5C4] flex items-center justify-center text-red-700 shadow-sm"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * TWO BUTTONS, AND NEITHER IS PAINTED GREEN BEFORE THE SERVER HAS JUDGED IT.
 *
 * The builder screen learned this the hard way: colouring by POSITION painted the
 * failing answer green whenever a question was authored with "no" as the pass
 * ("Any pest sighting during the round?" — the shape of the most important
 * food-safety questions). Here the chosen button is simply marked as chosen, and
 * the pass/fail line under the card comes from the engine's frozen verdict. A
 * colour can then never contradict the verdict printed beside it.
 */
function TwoButtonAnswer({
  yesLabel, noLabel, value, disabled, onPick,
}: {
  yesLabel: string;
  noLabel: string;
  value: boolean | null;
  disabled?: boolean;
  onPick: (b: boolean) => void;
}) {
  const cls = (picked: boolean) =>
    `flex-1 min-h-[56px] rounded-xl border text-base font-bold disabled:opacity-60 ` +
    (picked ? 'bg-[#3D2614] text-white border-[#3D2614]' : 'bg-white text-[#2D1B0E] border-[#E8D5C4]');
  return (
    <div className="flex gap-2 flex-nowrap">
      <button type="button" disabled={disabled} onClick={() => onPick(true)} className={cls(value === true)}>
        {value === true ? <span className="inline-flex items-center gap-1.5 flex-nowrap"><Check size={17} />{yesLabel}</span> : yesLabel}
      </button>
      <button type="button" disabled={disabled} onClick={() => onPick(false)} className={cls(value === false)}>
        {value === false ? <span className="inline-flex items-center gap-1.5 flex-nowrap"><Check size={17} />{noLabel}</span> : noLabel}
      </button>
    </div>
  );
}

/**
 * A READING, typed with a thumb.
 *
 * The keypad is `inputMode="decimal"` on a text input rather than
 * `type="number"`: a number input on Android swallows the minus sign on some
 * keyboards, and a freezer reading is −18. The stepper starts from the question's
 * TARGET value when the box is empty — on a −18…−15 question the first tap must
 * not produce 1.
 */
function ReadingAnswer({
  q, draft, disabled, onDraft,
}: {
  q: QuestionRow;
  draft: Draft;
  disabled?: boolean;
  onDraft: (patch: Partial<Draft>, mode: 'now' | 'typing') => void;
}) {
  const step = Number(q.decimals) > 0 ? 0.5 : 1;
  const nudge = (dir: 1 | -1) => {
    const current = draft.num.trim() === '' ? null : Number(draft.num);
    const base = current !== null && Number.isFinite(current)
      ? current
      : (q.target_value !== null && q.target_value !== undefined && Number.isFinite(Number(q.target_value))
        ? Number(q.target_value)
        : (q.min_value !== null && q.max_value !== null ? (Number(q.min_value) + Number(q.max_value)) / 2 : 0));
    const next = Math.round((base + dir * step) * 100) / 100;
    onDraft({ num: String(next) }, 'now');
  };
  const uom = q.qtype === 'temperature' ? (q.uom ? `°${q.uom}` : '°C') : (q.uom || '');
  const range = rangeLabel(q);
  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-2 flex-nowrap">
        <button
          type="button" disabled={disabled} onClick={() => nudge(-1)} aria-label="Lower"
          className="w-14 min-h-[56px] rounded-xl border border-[#E8D5C4] bg-white text-[#3D2614] flex items-center justify-center disabled:opacity-60 shrink-0"
        >
          <Minus size={20} />
        </button>
        <div className="min-w-0 flex-1 relative">
          <input
            value={draft.num} disabled={disabled}
            onChange={(e) => onDraft({ num: e.target.value.replace(/[^0-9.\-]/g, '') }, 'typing')}
            inputMode="decimal" placeholder="—"
            className="w-full min-h-[56px] text-center text-2xl font-bold tabular-nums border border-[#E8D5C4]
                       rounded-xl px-2 bg-white focus:outline-none focus:ring-2 focus:ring-[#af4408]/30 disabled:opacity-60"
          />
          {uom ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-[#8B7355] pointer-events-none">{uom}</span>
          ) : null}
        </div>
        <button
          type="button" disabled={disabled} onClick={() => nudge(1)} aria-label="Higher"
          className="w-14 min-h-[56px] rounded-xl border border-[#E8D5C4] bg-white text-[#3D2614] flex items-center justify-center disabled:opacity-60 shrink-0"
        >
          <Plus size={20} />
        </button>
      </div>
      {range ? <p className="text-[11px] text-[#8B7355] text-center">{range}</p> : null}
    </div>
  );
}

/* ================================================================== *
 * A FINISHED RECORD — rendered from what was frozen, never re-judged
 * ================================================================== */

function FinishedRecord({
  run, tpl, sheet, responses, evidence, onView, canVoid, onVoid, justSubmitted, awaitingVerification,
}: {
  run: RunRow;
  tpl: TemplateRow | null;
  sheet: SheetQuestion[] | null;
  responses: Record<string, ResponseRow>;
  evidence: EvidenceMeta[];
  onView: (m: EvidenceMeta) => void;
  canVoid: boolean;
  onVoid: () => void;
  justSubmitted: { outcome: string; pass_pct: number; fail_count: number; counted_retired: number; awaiting_verification: boolean } | null;
  awaitingVerification: boolean;
}) {
  const rows = useMemo(() => {
    if (sheet && sheet.length) {
      return [...sheet].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    }
    // A record taken before the snapshot existed still renders — from its own
    // answers, which is the one thing that is always there.
    return Object.values(responses)
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
      .map((r) => ({
        question_id: String(r.question_id), prompt: String(r.prompt_snapshot || ''), qtype: String(r.qtype || ''),
        section_id: null, sort_order: Number(r.sort_order || 0), is_required: 1, is_critical: 0,
        answered: true, is_na: Number(r.is_na) ? 1 : 0, is_fail: Number(r.is_fail) ? 1 : 0,
      })) as SheetQuestion[];
  }, [sheet, responses]);

  const answerText = (r: ResponseRow | undefined, qtype: string): string => {
    if (!r) return 'Not answered';
    if (Number(r.is_na)) return 'Does not apply';
    const meta = qtypeMeta(qtype || r.qtype);
    if (meta?.value === 'bool') {
      if (r.value_bool === null || r.value_bool === undefined) return String(r.value_text || 'Not answered');
      const yes = qtype === 'pass_fail' ? 'Pass' : 'Yes';
      const no = qtype === 'pass_fail' ? 'Fail' : 'No';
      return Number(r.value_bool) ? yes : no;
    }
    if (meta?.value === 'num') {
      if (r.value_num === null || r.value_num === undefined) return 'No reading';
      const uom = (qtype || r.qtype) === 'temperature' ? (r.uom ? `°${r.uom}` : '°C') : (r.uom || '');
      return `${fssaiDisplayReading(r.value_num, null)}${uom ? ` ${uom}` : ''}`;
    }
    if (meta?.value === 'evidence') {
      const n = evidence.filter((e) => String(e.question_id || '') === String(r.question_id)).length;
      return n > 0 ? `${n} photograph${n === 1 ? '' : 's'}` : 'No photograph';
    }
    return String(r.value_text || 'Not answered');
  };

  const outcome = String(run.outcome || '');
  const voided = run.status === 'void';

  return (
    <div className="space-y-3">
      {justSubmitted && (
        <Note tone={justSubmitted.outcome === 'fail' ? 'amber' : 'green'} title="This check is recorded">
          <p className="mt-1">
            {justSubmitted.outcome === 'fail'
              ? `It is recorded as a FAIL${justSubmitted.fail_count ? ` — ${justSubmitted.fail_count} answer${justSubmitted.fail_count === 1 ? '' : 's'} failed` : ''}. Tell whoever can put it right.`
              : 'It passed. Nothing further is needed.'}
          </p>
          {justSubmitted.counted_retired > 0 && (
            <p className="mt-1 text-[11px]">
              {justSubmitted.counted_retired} question{justSubmitted.counted_retired === 1 ? ' was' : 's were'} switched off
              while this round was open. The answer{justSubmitted.counted_retired === 1 ? '' : 's'} already given still count.
            </p>
          )}
        </Note>
      )}

      {voided && (
        <Note tone="red" title="This record is void">
          <p className="mt-1">{run.void_reason}</p>
          <p className="text-[11px] mt-1">Voided by {run.voided_by}{clockOf(run.voided_at) ? ` at ${clockOf(run.voided_at)}` : ''}. It stays in the file.</p>
        </Note>
      )}

      {/* the verdict, as frozen */}
      <div className={`${CARD} p-4`}>
        <div className="flex items-start gap-3 flex-nowrap">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Recorded</p>
            <p className="text-lg font-bold leading-tight">
              {outcome === 'pass' ? 'Passed' : outcome === 'fail' ? 'Failed' : '—'}
              <span className="text-sm font-semibold text-[#6B5744]"> · {Number(run.pass_pct)}%</span>
            </p>
            <p className="text-xs text-[#8B7355] mt-1">
              Pass mark {Number(tpl?.pass_threshold_pct ?? 100)}% · {Number(run.answered_count)} answered ·
              {' '}{Number(run.fail_count)} failed · {Number(run.na_count)} did not apply
            </p>
          </div>
          {outcome === 'fail'
            ? <AlertTriangle size={22} className="text-red-600 shrink-0" />
            : outcome === 'pass' ? <CheckCircle2 size={22} className="text-green-600 shrink-0" /> : null}
        </div>
        <div className="mt-3 pt-3 border-t border-[#E8D5C4] text-xs text-[#6B5744] space-y-1">
          <p>Recorded by <strong>{run.recorded_name || run.recorded_by}</strong>{clockOf(run.submitted_at) ? `, submitted at ${clockOf(run.submitted_at)}` : ''}.</p>
          {run.signed_by ? <p>Signed by <strong>{run.signed_by}</strong> — the account that was signed in, and the time.</p> : null}
          {run.remarks ? <p className="pt-1 break-words">&ldquo;{run.remarks}&rdquo;</p> : null}
          {awaitingVerification && run.status === 'submitted' ? (
            <p className="pt-1">
              Somebody else still has to verify this record — never the person who recorded it.
            </p>
          ) : null}
        </div>
      </div>

      {/* the sheet as it was asked */}
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-[#6B5744] px-1">The sheet, as it was asked</h2>
        {rows.map((s, i) => {
          const r = responses[String(s.question_id)];
          const evs = evidence.filter((e) => String(e.question_id || '') === String(s.question_id));
          return (
            <div key={`${s.question_id}-${i}`} className={`${CARD} p-3`}>
              <div className="flex items-start gap-2.5 flex-nowrap">
                <span className="text-[11px] font-bold text-[#8B7355] tabular-nums shrink-0 mt-0.5">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug break-words">{s.prompt}</p>
                  <p className={`text-sm mt-1 font-bold break-words ${Number(s.is_fail) ? 'text-red-700' : Number(s.is_na) ? 'text-[#8B7355]' : 'text-[#2D1B0E]'}`}>
                    {answerText(r, s.qtype)}
                  </p>
                  {r?.note ? <p className="text-xs text-[#6B5744] mt-1 break-words">{r.note}</p> : null}
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {Number(s.is_fail) ? <Chip className="bg-red-50 text-red-700 border-red-200">Failed</Chip> : null}
                    {Number(s.is_critical) ? <Chip className="bg-red-50 text-red-700 border-red-200">Critical</Chip> : null}
                    {!s.answered && !Number(s.is_na) ? <Chip className="bg-amber-50 text-amber-800 border-amber-200">Left blank</Chip> : null}
                    {s.retired_mid_run ? <Chip>Switched off while this round was open</Chip> : null}
                  </div>
                  {evs.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {evs.map((ev) => (
                        <button
                          key={ev.id} type="button" onClick={() => onView(ev)}
                          className="w-16 h-16 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex flex-col items-center justify-center text-[10px] text-[#6B5744]"
                        >
                          <ImageIcon size={16} className="text-[#af4408]" />
                          {fssaiBytesLabel(ev.size_bytes)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 pt-1">
        <SecondaryButton href="/fssai/checklists/run"><ArrowLeft size={16} /> Back to the checks</SecondaryButton>
        {canVoid && (
          <button
            type="button" onClick={onVoid}
            className="w-full min-h-[48px] rounded-xl border border-red-200 bg-white text-sm font-semibold text-red-700
                       inline-flex items-center justify-center gap-2 flex-nowrap hover:bg-red-50"
          >
            <Ban size={16} /> Void this record
          </button>
        )}
        {!canVoid && (
          <p className="text-[11px] text-[#8B7355] px-1">
            A recorded check is never edited or deleted. If it was entered by mistake a manager voids it,
            with a reason, and the void stays in the file.
          </p>
        )}
      </div>
    </div>
  );
}
