'use client';

/**
 * VERIFY RECORDS — the supervisor's screen (P3).
 *
 * A submitted check is read here and either VERIFIED or SENT BACK. It is the
 * second pair of eyes an FSSAI file is supposed to have, and it is the last
 * screen before a record becomes history.
 *
 * ── THE ONE THING THIS SCREEN PROMISES, AND THE ONE THING IT MUST NOT DO ─────
 * Verifying CANNOT change what the record says. Not a temperature, not a verdict,
 * not a photograph, not the signature. That is stated on the screen itself rather
 * than merely implemented, because a supervisor who believes he can "correct" a
 * reading here will eventually try, and the honest answer is that a register whose
 * history can be edited is not a register.
 *
 * It is not enforced by the absence of a button either: /api/fssai/approvals
 * builds its UPDATE from FSSAI_VERIFY_WRITABLE_RUN_COLUMNS (['status',
 * 'updated_at']), holds no write against fssai_responses or fssai_evidence at all,
 * and reads exactly three fields out of the request body. The P3 proofs POST a
 * body stuffed with value_text / is_fail / pass_pct and then re-read the answers to
 * show they did not move.
 *
 * ── WHO MAY DECIDE ──────────────────────────────────────────────────────────
 * §7 Q3 (PROVISIONAL DEFAULT — the owner has not ruled): any management may
 * verify, but NEVER the person who recorded it. The second half is the one that
 * bites in a small kitchen: a manager who ran the check himself sees the row, sees
 * everything on it, and sees why he cannot be the one to sign it off. The row is
 * shown rather than hidden — hiding it would look like the record had vanished.
 *
 * ── SENDING ONE BACK ────────────────────────────────────────────────────────
 * A rejection needs a written reason, because it is the one decision that tells a
 * member of staff their work was not accepted. `rejected` reopens the round so a
 * fresh check can be recorded, and the record that was sent back STAYS in the file
 * with the reason on it (owner §19 — nothing is deleted).
 *
 * THE API THIS PAGE DRIVES (P3):
 *   GET  /api/fssai/approvals?queue=1&status=&department_id=&from=&to=&q=
 *   GET  /api/fssai/approvals?run_id=<id>        one record, everything on it
 *   POST /api/fssai/approvals  { run_id, decision, note }
 *   GET  /api/fssai/evidence?id=<id>             one photograph, only when tapped
 * Every mutation goes through apiJson() so the fnb_csrf header is sent.
 *
 * Styling is the house skeleton (RECON §1.3-1.6) verbatim: the #FFF8F0 page, the
 * #af4408 heading with an icon tile, white cards bordered #E8D5C4, cards under md
 * and a table from md up, native <select>/<input type="date">, a per-page toast, a
 * bg-black/40 overlay, and the modal anchored to the BOTTOM of a phone where the
 * thumb already is. ⚠️ globals.css:279-283 force-wraps any `.flex.gap-2|3|4`, so
 * rows that must keep an icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Ban, CalendarDays, Camera, Check,
  ClipboardCheck, Info, Loader2, Lock, PenLine, RefreshCw, Search, ShieldCheck,
  Undo2, User, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_SHIFTS, fssaiBytesLabel, fssaiRunStatusMeta, qtypeMeta,
  fssaiSignatureModeFrom, fssaiSignatureModeLabel,
  fssaiCaStatusMeta, fssaiCaSeverityMeta,
  type FssaiCaView, type FssaiSignature,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * Shapes — every field below is returned by /api/fssai/approvals
 * ------------------------------------------------------------------ */

interface QueueRow {
  id: string;
  template_id: string;
  template_name: string;
  template_code: string;
  /** The name the record was TAKEN under. Lead with this, never template_name. */
  template_name_at_record: string;
  template_version: number;
  business_date: string;
  shift: string;
  target_kind: string;
  target_label: string;
  department_id: string;
  department_name: string;
  status: string;
  status_label: string;
  submitted_at: string;
  recorded_by: string;
  recorded_name: string;
  signed_by: string;
  signed_at: string;
  total_count: number;
  answered_count: number;
  fail_count: number;
  na_count: number;
  pass_pct: number;
  outcome: string;
  remarks: string;
  is_backdated: 0 | 1;
  backdate_reason: string;
  photo_count: number;
  requires_verification: 0 | 1;
  verify_refusal: string;
  can_verify: boolean;
}

interface SheetRow {
  question_id: string;
  prompt: string;
  qtype: string;
  sort_order?: number;
  is_required: 0 | 1;
  is_critical: 0 | 1;
  answered: boolean;
  is_na: 0 | 1;
  is_fail: 0 | 1;
  retired_mid_run?: boolean;
}

interface ResponseRow {
  id: string;
  question_id: string;
  qtype: string;
  value_text: string | null;
  value_num: number | null;
  value_bool: number | null;
  is_na: number;
  note: string | null;
  is_fail: number;
  prompt_snapshot?: string | null;
}

interface EvidenceMeta {
  id: string;
  response_id: string;
  question_id: string | null;
  kind: string;
  filename: string;
  mime: string;
  size_bytes: number;
  caption: string;
  created_by: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  decision: string;
  decided_by: string;
  decided_at: string;
  note: string;
}

interface RecordView {
  run: QueueRow;
  template_as_recorded: { name?: string; code?: string; version_at_open?: number; version_at_submit?: number; pass_threshold_pct?: number } | null;
  template_name_source: 'record' | 'live';
  sheet_as_asked: SheetRow[];
  responses: ResponseRow[];
  evidence: EvidenceMeta[];
  approvals: ApprovalRow[];
  signature: FssaiSignature | null;
  signature_intact: boolean | null;
  /** Owner Q14 — what this record raised, and how far it has got. */
  corrective_actions: FssaiCaView[];
  requires_verification: 0 | 1;
  can_verify: boolean;
  verify_refusal: string;
  cannot_change: string;
}

const TABS = [
  { key: 'submitted', label: 'To verify' },
  { key: 'verified', label: 'Verified' },
  { key: 'rejected', label: 'Sent back' },
  { key: 'all', label: 'All' },
] as const;

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

function shiftLabel(key: string): string {
  return FSSAI_SHIFTS.find((s) => s.key === key)?.label || key || '';
}

/** An answer as a person reads it, from the FROZEN response row. */
function answerText(r: ResponseRow | undefined): string {
  if (!r) return '—';
  if (Number(r.is_na)) return 'Not applicable';
  if (r.value_bool !== null && r.value_bool !== undefined) return Number(r.value_bool) ? 'Yes' : 'No';
  if (r.value_num !== null && r.value_num !== undefined) return String(r.value_num);
  if (r.value_text) return String(r.value_text);
  return '—';
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function FssaiVerificationPage() {
  const [tab, setTab] = useState<string>('submitted');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [counts, setCounts] = useState<{ submitted: number; verified: number; rejected: number }>({ submitted: 0, verified: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams({ queue: '1', status: tab });
      if (q.trim()) p.set('q', q.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const j = await apiJson<{ runs: QueueRow[]; counts: typeof counts }>(`/api/fssai/approvals?${p}`);
      setRows(j.runs || []);
      setCounts(j.counts || { submitted: 0, verified: 0, rejected: 0 });
      setForbidden(false);
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the records';
      // Told apart on purpose: "you are not a manager" and "your session ended"
      // need different answers, and an empty screen under a red banner answers
      // neither. Copied from the sibling FSSAI screens so they cannot drift.
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else if (/403|manager|administrator|not allowed/i.test(m)) setForbidden(true);
      else setErr(m);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, q, from, to]);

  useEffect(() => { void load(); }, [load]);

  const tabCount = (k: string) =>
    k === 'submitted' ? counts.submitted : k === 'verified' ? counts.verified : k === 'rejected' ? counts.rejected : undefined;

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to review recorded checks.</p>
        </div>
      </Shell>
    );
  }

  if (forbidden) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6">
          <div className="flex flex-nowrap items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E]">Only a manager can verify a recorded check.</p>
              <p className="text-sm text-[#6B5744] mt-1">
                Checking somebody else&apos;s work is a management job (§7 Q3), so this list is for managers,
                heads of department and administrators. Your own checks, and the records you recorded
                yourself, are on the checklist screens.
              </p>
            </div>
          </div>
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
            <strong>Verifying a check cannot change what it says.</strong> Not a reading, not a
            photograph, not the signature. You can accept it, or send it back with a reason — and
            sending it back lets the round be recorded again, with the record you returned still in
            the file beside it.
          </p>
        </div>
      </div>

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
        <button
          onClick={() => void load()}
          title="Reload"
          aria-label="Reload"
          className="ml-auto w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* ── filters ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Checklist, place or person"
            aria-label="Search the records"
            className={`${INPUT} pl-8`}
          />
        </div>
        <label className="flex flex-nowrap items-center gap-1.5 text-xs text-[#6B5744]">
          <CalendarDays size={14} className="shrink-0" />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className={INPUT} />
        </label>
        <label className="flex flex-nowrap items-center gap-1.5 text-xs text-[#6B5744]">
          <span className="shrink-0">to</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className={INPUT} />
        </label>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>
      )}

      {/* ── the list ─────────────────────────────────────────────────────── */}
      {loading && rows === null ? (
        <div className="py-12 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading the records…
        </div>
      ) : (rows || []).length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <ClipboardCheck className="w-7 h-7 mx-auto mb-2 text-[#D4B896]" />
          <p className="text-sm font-semibold text-[#2D1B0E]">
            {tab === 'submitted' ? 'Nothing is waiting to be verified.' : 'No records here.'}
          </p>
          <p className="text-sm text-[#6B5744] mt-1">
            {tab === 'submitted'
              ? 'A check appears here the moment somebody submits it.'
              : 'Try another tab, or widen the dates.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {(rows || []).map((r) => (
            <QueueCard key={r.id} row={r} onOpen={() => setOpenId(r.id)} />
          ))}
        </div>
      )}

      {openId && (
        <RecordSheet
          runId={openId}
          onClose={() => setOpenId(null)}
          onDecided={(msg) => { setToast(msg); setOpenId(null); void load(); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[130] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[92vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * The page shell — the house heading (RECON §1.3)
 * ------------------------------------------------------------------ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ClipboardCheck size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Verify Records</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              The second pair of eyes on a recorded check
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One row in the queue
 * ------------------------------------------------------------------ */

function QueueCard({ row, onOpen }: { row: QueueRow; onOpen: () => void }) {
  const failed = row.outcome === 'fail' || row.fail_count > 0;
  const meta = fssaiRunStatusMeta(row.status);
  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408] focus:outline-none focus:border-[#af4408]"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#2D1B0E] truncate">
            {row.template_name_at_record || row.template_name}
          </p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {fmtISTDate(row.business_date)}
            {row.shift ? ` · ${shiftLabel(row.shift)}` : ''}
            {row.target_label ? ` · ${row.target_label}` : ''}
            {row.department_name ? ` · ${row.department_name}` : ''}
          </p>
          <p className="text-[11px] text-[#8B7355] mt-0.5 truncate">
            {row.recorded_name || row.recorded_by || 'unknown'}
            {row.submitted_at ? ` · submitted ${fmtIST(row.submitted_at)}` : ''}
            {row.photo_count ? ` · ${row.photo_count} photo${row.photo_count === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${
              meta?.color || 'bg-[#FFF1E3] border-[#E8D5C4] text-[#6B5744]'
            }`}
          >
            {row.status_label}
          </span>
          <span
            className={`text-xs font-semibold ${failed ? 'text-red-700' : 'text-emerald-700'}`}
          >
            {failed ? `${row.fail_count} failed` : 'All passed'}
            {` · ${Math.round(row.pass_pct)}%`}
          </span>
          {!row.can_verify && row.verify_refusal && row.status === 'submitted' && (
            <span className="text-[11px] text-amber-800 max-w-[12rem] text-right leading-snug">
              {/^You recorded/.test(row.verify_refusal) ? 'Your own check' : 'You cannot verify this'}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * ONE RECORD — read it, then decide
 * ------------------------------------------------------------------ */

function RecordSheet({
  runId, onClose, onDecided,
}: { runId: string; onClose: () => void; onDecided: (msg: string) => void }) {
  const [v, setV] = useState<RecordView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<null | 'verify' | 'reject'>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);
  const [showLimits, setShowLimits] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await apiJson<RecordView>(`/api/fssai/approvals?run_id=${encodeURIComponent(runId)}`);
      setV(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not open that record');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  /* A photograph is fetched only when it is tapped. A round with six on it must
   * not cost megabytes to open on a phone in a kitchen. */
  const showPhoto = async (id: string) => {
    if (photos[id]) return;
    setPhotoBusy(id);
    try {
      const j = await apiJson<{ evidence: { data_uri: string } }>(`/api/fssai/evidence?id=${encodeURIComponent(id)}`);
      setPhotos((p) => ({ ...p, [id]: j.evidence?.data_uri || '' }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load that photograph');
    } finally {
      setPhotoBusy(null);
    }
  };

  const decide = async (decision: 'verified' | 'rejected') => {
    setBusy(true);
    setErr(null);
    try {
      const j = await apiJson<{ decision: string; slot_reopened?: boolean }>('/api/fssai/approvals', {
        method: 'POST',
        body: { run_id: runId, decision, note: note.trim() },
      });
      onDecided(
        j.decision === 'verified'
          ? 'Verified. The record is now part of the file.'
          : 'Sent back. This round can be recorded again, and your reason is on the record you returned.',
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not record the decision');
      setBusy(false);
    }
  };

  const byQ = useMemo(() => {
    const m = new Map<string, ResponseRow>();
    for (const r of v?.responses || []) m.set(String(r.question_id), r);
    return m;
  }, [v]);

  const evByQ = useMemo(() => {
    const m = new Map<string, EvidenceMeta[]>();
    for (const e of v?.evidence || []) {
      const k = String(e.question_id || '');
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [v]);

  const run = v?.run;
  const failed = !!run && (run.outcome === 'fail' || run.fail_count > 0);

  return (
    <div
      className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="The recorded check"
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full sm:max-w-3xl shadow-xl flex flex-col overflow-hidden max-h-[92vh] sm:max-h-[90vh]"
      >
        {/* header */}
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-[#2D1B0E] truncate">
              {run?.template_name_at_record || run?.template_name || 'The recorded check'}
            </h2>
            {run && (
              <p className="text-[11px] text-[#8B7355] truncate">
                {fmtISTDate(run.business_date)}
                {run.shift ? ` · ${shiftLabel(run.shift)}` : ''}
                {run.target_label ? ` · ${run.target_label}` : ''}
                {` · v${run.template_version}`}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-10 h-10 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center shrink-0">
            <X size={17} />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {loading ? (
            <div className="py-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Opening the record…
            </div>
          ) : !v || !run ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
              {err || 'That record could not be opened.'}
            </div>
          ) : (
            <>
              {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

              {/* the verdict, frozen at submit */}
              <div
                className={`rounded-xl border p-3 ${
                  failed ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'
                }`}
              >
                <div className="flex flex-nowrap items-start gap-2.5">
                  {failed
                    ? <AlertTriangle size={18} className="text-red-700 shrink-0 mt-0.5" />
                    : <BadgeCheck size={18} className="text-emerald-700 shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <p className={`text-sm font-semibold ${failed ? 'text-red-900' : 'text-emerald-900'}`}>
                      {failed
                        ? `${run.fail_count} of ${run.total_count} answers failed — ${Math.round(run.pass_pct)}% passed`
                        : `Every answer passed — ${Math.round(run.pass_pct)}%`}
                    </p>
                    <p className={`text-xs mt-0.5 ${failed ? 'text-red-800' : 'text-emerald-800'}`}>
                      Recorded by {run.recorded_name || run.recorded_by}
                      {run.submitted_at ? `, submitted ${fmtIST(run.submitted_at)}` : ''}
                      {run.na_count ? ` · ${run.na_count} not applicable` : ''}
                      {/* The verdict is the one frozen at submit and is never
                          recomputed on read (RECON §10 R3). */}
                    </p>
                    {run.is_backdated === 1 && (
                      <p className="text-xs text-amber-900 mt-1">
                        Recorded for an earlier day. Reason given: {run.backdate_reason || '—'}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* THE SIGNATURE — and exactly what it does and does not prove */}
              <SignatureBlock
                signature={v.signature}
                intact={v.signature_intact}
                showLimits={showLimits}
                onToggleLimits={() => setShowLimits((s) => !s)}
              />

              {run.remarks && (
                <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
                  <p className="text-xs font-semibold text-[#6B5744]">What they wrote at the end</p>
                  <p className="text-sm text-[#2D1B0E] mt-0.5 whitespace-pre-wrap">{run.remarks}</p>
                </div>
              )}

              {/* the sheet as it was ASKED — including anything left blank */}
              <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-[#6B5744]">
                    The sheet as it was asked
                    {v.template_name_source === 'live' && ' (this record was taken before the sheet was frozen)'}
                  </p>
                  <span className="ml-auto text-[11px] text-[#8B7355]">
                    {run.answered_count} of {run.total_count} answered
                  </span>
                </div>
                <div className="divide-y divide-[#E8D5C4]">
                  {/* A record submitted before the sheet-freeze landed has no
                      snapshot, so it is rebuilt from the answers themselves. Such a
                      record cannot name a question that was left blank — it never
                      stored one — and the header above says so. */}
                  {(v.sheet_as_asked.length
                    ? v.sheet_as_asked
                    : v.responses.map((r): SheetRow => ({
                      question_id: r.question_id,
                      prompt: r.prompt_snapshot || '(question)',
                      qtype: r.qtype,
                      is_required: 1,
                      is_critical: 0,
                      answered: true,
                      is_na: Number(r.is_na) ? 1 : 0,
                      is_fail: Number(r.is_fail) ? 1 : 0,
                    }))
                  ).map((s) => {
                    const r = byQ.get(String(s.question_id));
                    const shots = evByQ.get(String(s.question_id)) || [];
                    return (
                      <div key={s.question_id} className="p-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-[#2D1B0E]">
                              {s.prompt}
                              {s.is_critical === 1 && (
                                <span className="ml-1.5 text-[10px] font-bold text-red-700 uppercase">critical</span>
                              )}
                              {s.retired_mid_run && (
                                <span className="ml-1.5 text-[10px] text-amber-800">
                                  switched off while this round was open — the answer still counts
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-[#8B7355] mt-0.5">
                              {qtypeMeta(s.qtype)?.label || s.qtype}
                            </p>
                            {r?.note && (
                              <p className="text-xs text-[#6B5744] mt-1 whitespace-pre-wrap">{r.note}</p>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <p
                              className={`text-sm font-semibold ${
                                s.is_fail === 1 ? 'text-red-700' : s.answered ? 'text-[#2D1B0E]' : 'text-[#8B7355]'
                              }`}
                            >
                              {s.answered ? answerText(r) : 'Left blank'}
                            </p>
                            {s.is_fail === 1 && <p className="text-[11px] text-red-700">failed</p>}
                          </div>
                        </div>

                        {shots.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {shots.map((e) => (
                              photos[e.id]
                                ? <ImageThumb key={e.id} src={photos[e.id]} size={56} alt={e.caption || e.filename} />
                                : (
                                  <button
                                    key={e.id}
                                    onClick={() => void showPhoto(e.id)}
                                    className="inline-flex flex-nowrap items-center gap-1.5 text-xs border border-dashed border-[#D4B896] rounded-lg px-2.5 py-2 text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] min-h-[44px]"
                                  >
                                    {photoBusy === e.id
                                      ? <Loader2 size={14} className="animate-spin shrink-0" />
                                      : <Camera size={14} className="shrink-0" />}
                                    Show photo
                                    <span className="text-[10px] text-[#8B7355]">{fssaiBytesLabel(e.size_bytes)}</span>
                                  </button>
                                )
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* WHAT WAS RAISED BY THIS RECORD, AND WHETHER IT WAS MENDED.
                * Owner Q14. A supervisor deciding on a FAILED check needs the
                * answer to the question an inspector actually asks — not "did it
                * fail", but "what was done about it". Read-only here: verifying a
                * record neither closes nor changes an action, and the actions are
                * worked in /fssai/corrective-actions. */}
              {(v.corrective_actions?.length ?? 0) > 0 && (
                <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <div className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-[#6B5744]">
                      Raised by this check
                    </p>
                    <a
                      href="/fssai/corrective-actions"
                      className="text-xs font-semibold text-[#af4408] hover:underline shrink-0"
                    >
                      Open the list
                    </a>
                  </div>
                  <div className="divide-y divide-[#E8D5C4]">
                    {v.corrective_actions.map((c) => {
                      const meta = fssaiCaStatusMeta(c.status);
                      return (
                        <div key={c.id} className="p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[#6B5744]">{c.ca_number}</span>
                            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${meta.color}`}>{meta.label}</span>
                            <span className={`text-[11px] px-1.5 py-0.5 rounded border ${fssaiCaSeverityMeta(c.severity).color}`}>
                              {fssaiCaSeverityMeta(c.severity).label}
                            </span>
                            {c.is_overdue && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-100 text-red-700 border-red-200">
                                Late
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-[#2D1B0E] mt-1">{c.title}</p>
                          {c.owner_email
                            ? <p className="text-xs text-[#6B5744] mt-0.5">With {c.owner_email}{c.due_date ? ` · due ${fmtISTDate(c.due_date)}` : ''}</p>
                            : <p className="text-xs text-amber-800 mt-0.5">Nobody has been given this yet.</p>}
                          {c.action_taken && (
                            <p className="text-xs text-[#3D2614] mt-1">
                              <strong>What was done:</strong> {c.action_taken}
                              {c.completed_by ? ` — ${c.completed_by}` : ''}
                            </p>
                          )}
                          {c.status === 'verified' && (
                            <p className="text-xs text-emerald-800 mt-1">
                              Checked by {c.verified_by}{c.verified_at ? ` · ${fmtIST(c.verified_at)}` : ''}
                              {c.verify_note ? ` — “${c.verify_note}”` : ''}
                            </p>
                          )}
                          {(c.status === 'cancelled' || c.status === 'void') && c.void_reason && (
                            <p className="text-xs text-[#6B5744] mt-1">Cancelled: {c.void_reason}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Said on the screen, not just implemented — a supervisor who
                    * has seen "Fixed and checked" is exactly the person likely to
                    * assume the check itself now passes. */}
                  <p className="px-3 py-2 border-t border-[#E8D5C4] bg-white text-[11px] text-[#8B7355]">
                    A corrective action records what was done about a failure. It does not change the
                    check — this record still reads exactly as it was submitted.
                  </p>
                </div>
              )}

              {/* what has already been decided about this record */}
              {v.approvals.length > 0 && (
                <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
                  <p className="px-3 py-2 bg-[#FFF8F0] border-b border-[#E8D5C4] text-xs font-semibold text-[#6B5744]">
                    What has been decided so far
                  </p>
                  <div className="divide-y divide-[#E8D5C4]">
                    {v.approvals.map((a) => (
                      <div key={a.id} className="p-3">
                        <p className="text-sm text-[#2D1B0E]">
                          <strong>{a.decision === 'verified' ? 'Verified' : 'Sent back'}</strong> by {a.decided_by}
                          {a.decided_at ? ` · ${fmtIST(a.decided_at)}` : ''}
                        </p>
                        {a.note && <p className="text-xs text-[#6B5744] mt-0.5 whitespace-pre-wrap">{a.note}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* the decision */}
              {run.status !== 'submitted' ? (
                <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-sm text-[#3D2614]">
                  This record reads <strong>{run.status_label}</strong>, so there is nothing left to decide on it.
                </div>
              ) : !v.can_verify ? (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div className="flex flex-nowrap items-start gap-2.5">
                    <Info size={16} className="text-amber-800 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm text-amber-900">{v.verify_refusal}</p>
                      <p className="text-xs text-amber-800 mt-1">
                        You can read everything on the record — you simply cannot be the one who signs it off.
                      </p>
                    </div>
                  </div>
                </div>
              ) : mode === null ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setMode('verify')}
                    className="flex-1 min-w-[10rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold text-sm px-4"
                  >
                    <Check size={18} className="shrink-0" /> Verify this check
                  </button>
                  <button
                    onClick={() => setMode('reject')}
                    className="flex-1 min-w-[10rem] min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl border border-[#E8D5C4] bg-white hover:border-red-300 hover:text-red-800 font-semibold text-sm px-4"
                  >
                    <Undo2 size={18} className="shrink-0" /> Send it back
                  </button>
                </div>
              ) : (
                <div className="border border-[#E8D5C4] rounded-xl p-3 space-y-2">
                  <div className="flex flex-nowrap items-center gap-2">
                    <button onClick={() => { setMode(null); setNote(''); }} aria-label="Back"
                      className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center shrink-0">
                      <ArrowLeft size={16} />
                    </button>
                    <p className="text-sm font-semibold text-[#2D1B0E]">
                      {mode === 'verify' ? 'Verify this check' : 'Send this check back'}
                    </p>
                  </div>
                  <label className="block">
                    <span className="text-xs font-semibold text-[#6B5744]">
                      {mode === 'verify' ? 'Anything to add (optional)' : 'Why are you sending it back?'}
                      {mode === 'reject' && <span className="text-[#af4408]"> *</span>}
                    </span>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder={mode === 'verify'
                        ? 'e.g. Spoke to the chef about the door seal.'
                        : 'e.g. The freezer reading looks copied from yesterday — please take it again.'}
                      className={`${INPUT} mt-1`}
                    />
                    {mode === 'reject' && (
                      <span className="block text-[11px] text-[#8B7355] mt-1">
                        The person who recorded it will see this. A record sent back with no reason cannot be
                        acted on, so a reason is required.
                      </span>
                    )}
                  </label>
                  <button
                    onClick={() => void decide(mode === 'verify' ? 'verified' : 'rejected')}
                    disabled={busy || (mode === 'reject' && !note.trim())}
                    className={`w-full min-h-[52px] inline-flex flex-nowrap items-center justify-center gap-2 rounded-xl font-semibold text-sm px-4 disabled:opacity-40 ${
                      mode === 'verify'
                        ? 'bg-[#af4408] hover:bg-[#8a3606] text-white'
                        : 'bg-red-700 hover:bg-red-800 text-white'
                    }`}
                  >
                    {busy
                      ? <Loader2 size={18} className="animate-spin shrink-0" />
                      : mode === 'verify' ? <Check size={18} className="shrink-0" /> : <Ban size={18} className="shrink-0" />}
                    {mode === 'verify' ? 'Yes, verify it' : 'Send it back'}
                  </button>
                  <p className="text-[11px] text-[#8B7355]">{v.cannot_change}</p>
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
 * THE SIGNATURE — stated precisely, including its limits
 * ------------------------------------------------------------------ */

function SignatureBlock({
  signature, intact, showLimits, onToggleLimits,
}: {
  signature: FssaiSignature | null;
  intact: boolean | null;
  showLimits: boolean;
  onToggleLimits: () => void;
}) {
  if (!signature) {
    return (
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
        <div className="flex flex-nowrap items-start gap-2.5">
          <PenLine size={16} className="text-[#8B7355] shrink-0 mt-0.5" />
          <p className="text-sm text-[#3D2614]">
            <strong>This record is not signed.</strong> Either the checklist does not ask for a signature,
            or it was recorded before signing existed. Nothing has been assumed on its behalf.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="p-3 bg-[#FFF8F0]">
        <div className="flex flex-nowrap items-start gap-2.5">
          <PenLine size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#2D1B0E]">
              Signed by {signature.signed_name || signature.signed_by}
            </p>
            <p className="text-xs text-[#6B5744] mt-0.5">
              {signature.signed_at ? fmtIST(signature.signed_at) : ''}
              {' · '}
              {/* The three kinds are not equally strong, so the record says which
                * — in the SHARED words, so this screen and any report cannot
                * describe the same signature differently. */}
              {fssaiSignatureModeLabel(signature.mode)}
            </p>
            {/* THE WEAKEST KIND IS NOT LEFT AS A PHRASE TO PARSE. When nobody was
              * asked, a reader is told plainly that there was no act to
              * repudiate — the sentence this build used to print here claimed a
              * button press instead (owner Q17). */}
            {fssaiSignatureModeFrom(signature.mode) === 'not_asked' && (
              <p className="text-[11px] text-amber-800 mt-1 flex flex-nowrap items-start gap-1.5">
                <Info size={12} className="shrink-0 mt-0.5" />
                <span>
                  Nobody was shown the statement and asked to sign this one. The system attested it
                  when the check was submitted, so treat it as a record of <em>who submitted</em>,
                  not of a signature anybody gave.
                </span>
              </p>
            )}
            <p className="text-xs text-[#3D2614] mt-1 italic">“{signature.statement}”</p>
            <p className="text-[11px] text-[#8B7355] mt-1">
              Covering {signature.answers} answer{signature.answers === 1 ? '' : 's'}
              {signature.photos ? ` and ${signature.photos} photograph${signature.photos === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        </div>

        {intact === true && (
          <p className="text-xs text-emerald-800 mt-2 flex flex-nowrap items-start gap-1.5">
            <ShieldCheck size={13} className="shrink-0 mt-0.5" />
            Nothing has been changed through the app since it was signed.
          </p>
        )}
        {intact === false && (
          <p className="text-xs text-red-800 mt-2 flex flex-nowrap items-start gap-1.5">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              <strong>The signature no longer matches this record.</strong> Something differs from what was
              signed. Treat the attestation as covering the earlier version, not this one.
            </span>
          </p>
        )}
      </div>

      <button
        onClick={onToggleLimits}
        className="w-full text-left px-3 py-2 border-t border-[#E8D5C4] text-xs font-semibold text-[#6B5744] hover:bg-[#FFF1E3] min-h-[44px] flex flex-nowrap items-center gap-1.5"
      >
        <User size={13} className="shrink-0" />
        {showLimits ? 'Hide what this signature does not prove' : 'What this signature does not prove'}
      </button>
      {showLimits && (
        <div className="px-3 py-2 border-t border-[#E8D5C4] bg-white">
          <ul className="text-xs text-[#6B5744] space-y-1.5 list-disc pl-4">
            <li>
              It does not prove <strong>who held the phone</strong> — only which account was signed in. A
              shared login is a shared signature, and there is no second check at the moment of signing.
            </li>
            <li>
              It is <strong>not a cryptographic signature</strong>. The digest sits in the same database as
              the answers, so it detects an edit made <em>through this app</em> — which is what it is for —
              not someone with direct access to the file.
            </li>
            <li>It is not a handwritten mark and is not an e-signature under the IT Act.</li>
            <li>It says the sheet was <strong>attested</strong>, not that the reading was true.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
