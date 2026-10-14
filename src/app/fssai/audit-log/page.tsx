'use client';

/**
 * RECORD CHANGES & VOIDS — the owner's §19 surface (P10).
 *
 * ── WHAT WAS ALREADY TRUE BEFORE THIS SCREEN EXISTED ────────────────────────
 * The trail was never missing. `fssai_audit_log` has been filled on every
 * checklist create, edit, submit, signature, verification, rejection,
 * cancellation and dropped photograph since the engine shipped, with the frozen
 * before value, the after value, the actor and the reason. What did not exist was
 * anywhere to read it. So this screen adds no data and takes no decision — it
 * renders what the module has been writing all along, and that is why it could be
 * built after the registers rather than before them.
 *
 * ── WHAT IT SHOWS, AND THE ONE THING IT WILL NOT DO ─────────────────────────
 * Every line, with the ORIGINAL value beside the CHANGED one (§19(b)), the person
 * (§19(a)) and the reason (§19(c)). It holds no way to edit or delete a line:
 * there is no POST on /api/fssai/audit-log at all, and an audit screen that can
 * write to the audit log is not an audit trail. Cancelling a record happens on the
 * register that holds it, through /api/fssai/void, never here — this screen is
 * where you find out that it happened.
 *
 * ── TWO HONEST NOTES THAT BELONG ON SCREEN AND NOT IN A COMMENT ─────────────
 * 1. Times are IST and the column is UTC. The server converts with the house
 *    '+330 minutes' for every date filter, so "today" means today in Hyderabad and
 *    not a window that starts at 05:30. The stamp is rendered with fmtIST, the
 *    same helper every other screen uses.
 * 2. The retention panel says whether the sweep runs by itself ON EVIDENCE. The
 *    sweep drops images that have passed the 12-month window the owner ruled and
 *    records what it dropped, and the app's scheduler now runs it once a day
 *    (src/lib/fssai-jobs.ts). Wired is not the same as running — the scheduler
 *    is production-only and a stopped server ticks nothing — so the banner prints
 *    what GET /api/fssai/escalations reads off the scheduler's heartbeat: when it
 *    last ran and what that run did, that it has stopped, or that there is no
 *    record of it ever running here. The retention payload's `armed: false` is
 *    NOT read: it predates the scheduler and no longer describes it.
 *
 * Styling is the house skeleton (RECON §1.3-1.6): the #FFF8F0 page, the #af4408
 * heading with an icon tile, white cards bordered #E8D5C4, cards under md and a
 * table from md up, native <select>/<input type="date">, a per-page toast, and a
 * detail sheet anchored to the BOTTOM of a phone where the thumb already is.
 * ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so rows that must keep an
 * icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CalendarDays, Camera, Check, Download, FileClock,
  History, Info, Loader2, Lock, RefreshCw, Search, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import {
  fssaiAuditActionMeta, fssaiAuditEntityMeta, type FssaiAuditChange,
} from '@/lib/fssai-audit';

/* ------------------------------------------------------------------ *
 * Shapes — every field below is returned by /api/fssai/audit-log
 * ------------------------------------------------------------------ */

interface TrailRow {
  id: string;
  entity_table: string;
  entity_id: string;
  entity_one: string;
  entity_many: string;
  entity_path: string;
  entity_is_record: boolean;
  action: string;
  action_label: string;
  action_means: string;
  action_color: string;
  is_override: boolean;
  field: string;
  reason: string;
  actor_email: string;
  actor_name: string;
  created_at: string;
  summary: string;
  before_json: string;
  after_json: string;
  before_bytes: number;
  after_bytes: number;
  truncated: boolean;
  changes: FssaiAuditChange[];
}

interface Summary {
  total: number;
  actors: number;
  records: number;
  overrides: number;
  voided: number;
  voided_without_reason: number;
  first_day: string;
  last_day: string;
}

interface Facet { key: string; count: number; label: string }

interface TrailPayload {
  rows: TrailRow[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  summary: Summary;
  facets: { tables: Facet[]; actions: Facet[] };
}

interface RetentionStoreRow {
  store: string;
  present: boolean;
  held: number;
  held_bytes: number;
  overdue: number;
  overdue_bytes: number;
  already_dropped: number;
}

interface RetentionRun {
  id: string;
  started_at: string;
  finished_at: string;
  cutoff_date: string;
  months_kept: number;
  scanned_count: number;
  dropped_count: number;
  bytes_freed_label: string;
  evidence_dropped: number;
  attachments_dropped: number;
  status: string;
  detail: string;
  triggered_by: string;
  interrupted: boolean;
}

interface RetentionPayload {
  status: {
    held: number; held_bytes_label: string;
    overdue: number; overdue_bytes_label: string;
    already_dropped: number; cutoff: string; retention_months: number;
    /* `armed` is still sent by the retention lib and is NOT read here — it was
     * written before the scheduler ran this sweep. JobsTruth below is the answer. */
    stores: RetentionStoreRow[]; stores_missing: string; armed?: boolean;
  };
  runs: RetentionRun[];
  ruled_months: number;
  can_sweep: boolean;
}

/** What GET /api/fssai/escalations read off the scheduler's heartbeat (its `jobs`). */
interface JobsTruth {
  state: 'never' | 'running' | 'stopped';
  last_tick_at: string;
  minutes_since: number | null;
  retention: {
    tick_outcome: string;
    tick_day: string;
    tick_dropped: number;
    words: string;
    last_pass: null | {
      id: string; started_at: string; finished_at: string; status: string;
      scanned: number; dropped: number; detail: string;
    };
  } | null;
  retention_sentence: string;
}

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

const PAGE = 50;

export default function FssaiAuditLogPage() {
  const [tab, setTab] = useState<'trail' | 'retention'>('trail');

  /* filters */
  const [table, setTable] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [overridesOnly, setOverridesOnly] = useState(false);
  const [offset, setOffset] = useState(0);

  const [data, setData] = useState<TrailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const [open, setOpen] = useState<TrailRow | null>(null);
  const [openFull, setOpenFull] = useState<TrailRow | null>(null);

  const [ret, setRet] = useState<RetentionPayload | null>(null);
  const [retBusy, setRetBusy] = useState(false);
  const [retMsg, setRetMsg] = useState<string | null>(null);
  const [confirmSweep, setConfirmSweep] = useState(false);
  const [jobs, setJobs] = useState<JobsTruth | null>(null);
  const [jobsErr, setJobsErr] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (table) p.set('entity_table', table);
    if (action) p.set('action', action);
    if (actor.trim()) p.set('actor', actor.trim());
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q.trim()) p.set('q', q.trim());
    if (overridesOnly) p.set('overrides', '1');
    return p;
  }, [table, action, actor, from, to, q, overridesOnly, offset]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const j = await apiJson<TrailPayload>(`/api/fssai/audit-log?${query}`);
      setData(j);
      setForbidden(false);
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the change trail';
      /* Told apart on purpose, copied from the sibling FSSAI screens so they
       * cannot drift: "you are not a manager" and "your session ended" need
       * different answers, and an empty list under a red banner answers neither. */
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else if (/403|manager|administrator|not allowed/i.test(m)) setForbidden(true);
      else setErr(m);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  /* Whether the sweep runs by itself is read off the scheduler's heartbeat,
   * which GET /api/fssai/escalations serves to the same management audience as
   * this screen. Fetched beside the retention state, and a failure here is
   * shown as "could not read" — never filled in with a guess either way. */
  const loadJobs = useCallback(async () => {
    try {
      const j = await apiJson<{ jobs?: JobsTruth }>('/api/fssai/escalations');
      if (!j.jobs) throw new Error('The server did not say whether the scheduler has run.');
      setJobs(j.jobs);
      setJobsErr(null);
    } catch (e) {
      setJobs(null);
      setJobsErr(e instanceof Error ? e.message : 'Could not read whether the scheduler has run');
    }
  }, []);

  const loadRetention = useCallback(async () => {
    void loadJobs();
    try {
      const j = await apiJson<RetentionPayload>('/api/fssai/retention');
      setRet(j);
    } catch (e) {
      setRetMsg(e instanceof Error ? e.message : 'Could not read the retention state');
    }
  }, [loadJobs]);

  useEffect(() => { if (tab === 'retention') void loadRetention(); }, [tab, loadRetention]);

  /* Reset the page whenever a filter moves — otherwise a narrower filter lands on
   * page 4 of 1 and the screen looks empty. */
  useEffect(() => { setOffset(0); }, [table, action, actor, from, to, q, overridesOnly]);

  const openRow = useCallback(async (row: TrailRow) => {
    setOpen(row);
    setOpenFull(null);
    if (!row.truncated) { setOpenFull(row); return; }
    try {
      const j = await apiJson<{ entry: TrailRow }>(`/api/fssai/audit-log?id=${encodeURIComponent(row.id)}`);
      setOpenFull(j.entry);
    } catch {
      /* The preview is still true as far as it goes — show it rather than an
       * error, and say that the rest could not be fetched. */
      setOpenFull(row);
      setToast('The full entry could not be fetched. What is shown is the first part of it.');
    }
  }, []);

  const exportCsv = useCallback(async () => {
    try {
      const p = new URLSearchParams(query);
      p.set('format', 'csv');
      p.delete('limit');
      p.delete('offset');
      const res = await api(`/api/fssai/audit-log?${p}`);
      if (!res.ok) throw new Error('The export could not be built.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fssai-record-changes-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setToast('Downloaded. One line per changed field, so a spreadsheet can read it.');
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'The export could not be built.');
    }
  }, [query]);

  const runRetention = useCallback(async (which: 'preview' | 'sweep') => {
    setRetBusy(true);
    setRetMsg(null);
    try {
      const j = await apiJson<{ message: string; status?: RetentionPayload['status']; runs?: RetentionRun[] }>(
        '/api/fssai/retention',
        { method: 'POST', body: { action: which } },
      );
      setRetMsg(j.message);
      if (which === 'sweep') { await loadRetention(); await load(); }
    } catch (e) {
      setRetMsg(e instanceof Error ? e.message : 'That could not be done.');
    } finally {
      setRetBusy(false);
      setConfirmSweep(false);
    }
  }, [loadRetention, load]);

  /* ── the two states that are not an error ──────────────────────────────── */

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to read the record-change trail.</p>
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
              <p className="text-sm font-semibold text-[#2D1B0E]">
                The record-change trail is for managers and administrators.
              </p>
              <p className="text-sm text-[#6B5744] mt-1">
                This is a list of the moments somebody&apos;s record was overridden, with the reason
                that was given. Your own checks and the records you filed are on the checklist and
                register screens.
              </p>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  const s = data?.summary;

  return (
    <Shell>
      {/* ── the law of this screen, said once, at the top ─────────────────── */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Lock size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>Nothing in this module is ever deleted.</strong> A record entered by mistake is
            cancelled with a written reason, and both the record and the reason stay in the file —
            which is the only reason this screen can exist. Only a manager, a head of department or an
            admin can cancel one, and never the person who filed it.
          </p>
        </div>
      </div>

      {/* ── tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-nowrap gap-2 overflow-x-auto">
        {([
          { k: 'trail' as const, label: 'Changes & cancellations', icon: History },
          { k: 'retention' as const, label: 'Photo retention', icon: Camera },
        ]).map(({ k, label, icon: Icon }) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 rounded-lg border text-sm font-medium flex flex-nowrap items-center gap-2 shrink-0 ${
              tab === k
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            <Icon size={15} className="shrink-0" />
            {label}
          </button>
        ))}
        <button
          onClick={() => { void (tab === 'trail' ? load() : loadRetention()); }}
          className="ml-auto w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center shrink-0"
          aria-label="Reload"
        >
          <RefreshCw size={16} className={`text-[#af4408] ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {tab === 'trail' ? (
        <>
          {/* ── filters ──────────────────────────────────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">Register</span>
                <select className={INPUT} value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">Everything</option>
                  {(data?.facets.tables || []).map((f) => (
                    <option key={f.key} value={f.key}>{f.label} ({f.count})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">What happened</span>
                <select className={INPUT} value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="">Anything</option>
                  {(data?.facets.actions || []).map((f) => (
                    <option key={f.key} value={f.key}>{f.label} ({f.count})</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">From</span>
                <input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">To</span>
                <input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">Person</span>
                <input
                  className={INPUT}
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                  placeholder="part of an email"
                />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">
                  Search the reasons and the values
                </span>
                <div className="relative">
                  <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
                  <input
                    className={`${INPUT} pl-8`}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="wrong fridge"
                  />
                </div>
              </label>
              <div className="flex flex-nowrap items-end gap-2">
                <button
                  onClick={() => setOverridesOnly((v) => !v)}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium whitespace-nowrap ${
                    overridesOnly
                      ? 'bg-[#af4408] border-[#af4408] text-white'
                      : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
                  }`}
                  title="Only the lines where something was cancelled, sent back or removed"
                >
                  Overrides only
                </button>
                <button
                  onClick={() => { void exportCsv(); }}
                  className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm font-medium text-[#6B5744] hover:border-[#af4408] flex flex-nowrap items-center gap-2 whitespace-nowrap"
                >
                  <Download size={15} className="shrink-0" /> CSV
                </button>
              </div>
            </div>
          </div>

          {/* ── the figures for the period on screen ─────────────────────── */}
          {s ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Entries" value={s.total} />
              <Stat label="Records touched" value={s.records} />
              <Stat label="Overrides" value={s.overrides} tone={s.overrides > 0 ? 'warn' : 'plain'} />
              <Stat label="Cancellations" value={s.voided} tone={s.voided > 0 ? 'warn' : 'plain'} />
            </div>
          ) : null}

          {s && s.voided_without_reason > 0 ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3">
              <div className="flex flex-nowrap items-start gap-2.5">
                <AlertTriangle size={16} className="text-red-600 shrink-0 mt-0.5" />
                <p className="text-[13px] text-red-800 leading-relaxed">
                  <strong>{s.voided_without_reason} cancellation
                  {s.voided_without_reason === 1 ? '' : 's'} with no reason written down.</strong>{' '}
                  Every path in this module demands one, so this should read zero. Treat it as
                  something to look into rather than as a statistic.
                </p>
              </div>
            </div>
          ) : null}

          {err ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
          ) : null}

          {loading && !data ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
              <Loader2 className="w-5 h-5 mx-auto animate-spin text-[#af4408]" />
            </div>
          ) : !data || data.rows.length === 0 ? (
            <EmptyTrail filtered={!!(table || action || actor || from || to || q || overridesOnly)} />
          ) : (
            <>
              {/* cards under md */}
              <div className="space-y-2 md:hidden">
                {data.rows.map((r) => <TrailCard key={r.id} row={r} onOpen={() => void openRow(r)} />)}
              </div>

              {/* table from md up */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">When</th>
                      <th className="text-left font-semibold px-3 py-2">What happened</th>
                      <th className="text-left font-semibold px-3 py-2">Register</th>
                      <th className="text-left font-semibold px-3 py-2">Reason</th>
                      <th className="text-left font-semibold px-3 py-2">By</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className="border-t border-[#F0E4D6] align-top">
                        <td className="px-3 py-2 whitespace-nowrap text-[#6B5744]">{fmtIST(r.created_at)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-semibold ${r.action_color}`}>
                            {r.action_label}
                          </span>
                          {r.field ? <span className="ml-2 text-[#8B7355]">{r.field}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-[#3D2614]">
                          {r.entity_many}
                          <div className="text-[11px] text-[#8B7355] font-mono truncate max-w-[14rem]">{r.entity_id}</div>
                        </td>
                        <td className="px-3 py-2 text-[#3D2614] max-w-[18rem]">
                          {r.reason || <span className="text-[#B8A08C]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-[#6B5744] whitespace-nowrap">
                          {r.actor_name || r.actor_email || <span className="text-[#B8A08C]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => void openRow(r)}
                            className="text-[#af4408] font-medium hover:underline whitespace-nowrap"
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── paging ─────────────────────────────────────────────── */}
              <div className="flex flex-nowrap items-center justify-between gap-2">
                <p className="text-xs text-[#8B7355]">
                  {data.offset + 1}–{data.offset + data.rows.length} of {data.total}
                </p>
                <div className="flex flex-nowrap gap-2">
                  <button
                    disabled={data.offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm disabled:opacity-40"
                  >
                    Newer
                  </button>
                  <button
                    disabled={!data.has_more}
                    onClick={() => setOffset(offset + PAGE)}
                    className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm disabled:opacity-40"
                  >
                    Older
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <RetentionPanel
          data={ret}
          busy={retBusy}
          msg={retMsg}
          confirming={confirmSweep}
          onConfirm={setConfirmSweep}
          onRun={runRetention}
          jobs={jobs}
          jobsErr={jobsErr}
        />
      )}

      {open ? (
        <EntrySheet
          row={openFull || open}
          loadingFull={!openFull}
          onClose={() => { setOpen(null); setOpenFull(null); }}
          onDone={(m) => { setOpen(null); setOpenFull(null); setToast(m); void load(); }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[92vw]">
          {toast}
        </div>
      ) : null}
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
            <History size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Record Changes &amp; Voids</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              What changed, who changed it, and the reason they gave
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'plain' }: { label: string; value: number; tone?: 'plain' | 'warn' }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'warn' ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
      <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">{label}</p>
      <p className="text-lg font-bold text-[#2D1B0E]">{value}</p>
    </div>
  );
}

function EmptyTrail({ filtered }: { filtered: boolean }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
      <FileClock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
      {filtered ? (
        <p className="text-sm text-[#3D2614]">
          Nothing matches those filters. Widen the dates or clear the register.
        </p>
      ) : (
        <>
          <p className="text-sm font-semibold text-[#2D1B0E]">Nothing has been changed yet.</p>
          <p className="text-sm text-[#6B5744] mt-1 max-w-md mx-auto">
            This is not a screen waiting to be built — the trail is written as the module is used.
            The first checklist filed, the first reading cancelled, the first certificate edited will
            each appear here on its own line, with the reason beside it.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One line, on a phone
 * ------------------------------------------------------------------ */

function TrailCard({ row, onOpen }: { row: TrailRow; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408] focus:outline-none focus:border-[#af4408]"
    >
      <div className="flex flex-nowrap items-start justify-between gap-2">
        <span className={`inline-block px-2 py-0.5 rounded-md border text-[11px] font-semibold shrink-0 ${row.action_color}`}>
          {row.action_label}
        </span>
        <span className="text-[11px] text-[#8B7355] whitespace-nowrap">{fmtIST(row.created_at)}</span>
      </div>
      <p className="text-sm font-semibold text-[#2D1B0E] mt-2">{row.entity_many}</p>
      {row.field ? <p className="text-[12px] text-[#8B7355]">{row.field}</p> : null}
      {row.reason ? <p className="text-[13px] text-[#3D2614] mt-1">&ldquo;{row.reason}&rdquo;</p> : null}
      <p className="text-[12px] text-[#6B5744] mt-1">
        {row.actor_name || row.actor_email || 'no actor recorded'}
      </p>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * One line, in full — the original beside the changed value (§19(b))
 * ------------------------------------------------------------------ */

function EntrySheet({
  row, loadingFull, onClose, onDone,
}: { row: TrailRow; loadingFull: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const meta = fssaiAuditActionMeta(row.action);
  const entity = fssaiAuditEntityMeta(row.entity_table);
  const changed = row.changes.filter((c) => c.before !== c.after);
  const restated = row.changes.filter((c) => c.before === c.after);

  /* ── cancelling the record this line is about ────────────────────────────
   * The register that holds a record is the natural place to cancel one, and
   * each register screen owns that button. This panel exists because it is the
   * one place a manager is already looking at a record across EVERY register —
   * and because the §19 write path should be reachable from somewhere today
   * rather than waiting on eight screens. It never decides anything itself: the
   * preflight below, and then the POST, are both answered by /api/fssai/void,
   * which is also the only thing that can refuse. */
  const [pre, setPre] = useState<null | {
    record: { label: string; status: string; status_label: string; author_email: string; path: string; one: string };
    can_void: boolean; refusal: string; handled_here: boolean; use_endpoint: string; use_action: string;
  }>(null);
  const [preErr, setPreErr] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voidErr, setVoidErr] = useState('');

  useEffect(() => {
    if (!row.entity_is_record || !row.entity_id) return;
    let live = true;
    (async () => {
      try {
        const j = await apiJson<NonNullable<typeof pre>>(
          `/api/fssai/void?entity_table=${encodeURIComponent(row.entity_table)}&id=${encodeURIComponent(row.entity_id)}`,
        );
        if (live) setPre(j);
      } catch (e) {
        if (live) setPreErr(e instanceof Error ? e.message : 'Could not read that record.');
      }
    })();
    return () => { live = false; };
  }, [row.entity_table, row.entity_id, row.entity_is_record]);

  const doVoid = async () => {
    setBusy(true);
    setVoidErr('');
    try {
      const j = await apiJson<{ message: string }>('/api/fssai/void', {
        method: 'POST',
        body: { entity_table: row.entity_table, id: row.entity_id, reason },
      });
      onDone(j.message || 'That record is cancelled.');
    } catch (e) {
      setVoidErr(e instanceof Error ? e.message : 'That record could not be cancelled.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full sm:max-w-2xl shadow-xl flex flex-col overflow-hidden max-h-[92vh] sm:max-h-[90vh]">
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#2D1B0E] truncate">{meta.label} — {entity.one}</p>
            <p className="text-[11px] text-[#8B7355]">{fmtIST(row.created_at)}</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-lg border border-[#E8D5C4] flex items-center justify-center shrink-0"
            aria-label="Close"
          >
            <X size={16} className="text-[#6B5744]" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {meta.means ? (
            <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5">
              <div className="flex flex-nowrap items-start gap-2">
                <Info size={14} className="text-[#af4408] shrink-0 mt-0.5" />
                <p className="text-[12px] text-[#3D2614] leading-relaxed">{meta.means}</p>
              </div>
            </div>
          ) : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-[#8B7355]">Register</dt>
            <dd className="text-[#2D1B0E]">{entity.many}</dd>
            <dt className="text-[#8B7355]">Record</dt>
            <dd className="text-[#2D1B0E] font-mono text-[12px] break-all">{row.entity_id}</dd>
            <dt className="text-[#8B7355]">By</dt>
            <dd className="text-[#2D1B0E]">
              {row.actor_name || '—'}{row.actor_email ? ` · ${row.actor_email}` : ''}
            </dd>
            {row.reason ? (
              <>
                <dt className="text-[#8B7355]">Reason</dt>
                <dd className="text-[#2D1B0E]">{row.reason}</dd>
              </>
            ) : null}
          </dl>

          {loadingFull ? (
            <p className="text-[12px] text-[#8B7355] flex flex-nowrap items-center gap-2">
              <Loader2 size={13} className="animate-spin shrink-0" /> fetching the rest of this entry…
            </p>
          ) : null}

          {changed.length ? (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1">What changed</p>
              <div className="border border-[#E8D5C4] rounded-lg divide-y divide-[#F0E4D6]">
                {changed.map((c) => (
                  <div key={c.field} className="p-2.5">
                    <p className="text-[12px] font-semibold text-[#2D1B0E]">{c.field}</p>
                    <div className="flex flex-nowrap items-start gap-2 mt-1 text-[13px]">
                      <span className="text-[#6B5744] break-all">{c.before}</span>
                      <ArrowRight size={14} className="text-[#af4408] shrink-0 mt-0.5" />
                      <span className="text-[#2D1B0E] font-medium break-all">{c.after}</span>
                    </div>
                    {c.oneSided ? (
                      <p className="text-[11px] text-[#8B7355] mt-1">
                        This field is only on one side of the entry — it was added or removed, not edited.
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {restated.length ? (
            <details className="border border-[#E8D5C4] rounded-lg">
              <summary className="p-2.5 text-[12px] text-[#6B5744] cursor-pointer">
                {restated.length} field{restated.length === 1 ? '' : 's'} unchanged, and restated to prove it
              </summary>
              <div className="px-2.5 pb-2.5 space-y-1">
                {restated.map((c) => (
                  <p key={c.field} className="text-[12px] text-[#6B5744] break-all">
                    <span className="font-semibold text-[#2D1B0E]">{c.field}</span>: {c.after}
                  </p>
                ))}
              </div>
            </details>
          ) : null}

          {!changed.length && !restated.length ? (
            <p className="text-[13px] text-[#6B5744]">
              This entry carries no before-and-after values — it records that the action happened.
            </p>
          ) : null}

          {entity.path ? (
            <a
              href={entity.path}
              className="inline-flex flex-nowrap items-center gap-2 text-[13px] font-medium text-[#af4408] hover:underline"
            >
              Open {entity.many} <ArrowRight size={14} className="shrink-0" />
            </a>
          ) : null}

          {/* ── cancel the record (owner §19) ───────────────────────────── */}
          {row.entity_is_record ? (
            <div className="border-t border-[#F0E4D6] pt-3">
              <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1">
                The record this line is about
              </p>
              {preErr ? (
                <p className="text-[13px] text-[#6B5744]">{preErr}</p>
              ) : !pre ? (
                <p className="text-[12px] text-[#8B7355] flex flex-nowrap items-center gap-2">
                  <Loader2 size={13} className="animate-spin shrink-0" /> reading it…
                </p>
              ) : (
                <>
                  <p className="text-[13px] text-[#2D1B0E]">
                    {pre.record.label}
                    <span className="text-[#8B7355]"> · {pre.record.status_label}</span>
                  </p>
                  {pre.record.author_email ? (
                    <p className="text-[12px] text-[#8B7355]">filed by {pre.record.author_email}</p>
                  ) : null}

                  {pre.can_void ? (
                    <div className="mt-2 space-y-2">
                      <label className="block">
                        <span className="text-[12px] text-[#3D2614]">
                          Why is this {pre.record.one} being cancelled? The reason stays in the file beside it.
                        </span>
                        <textarea
                          className={`${INPUT} mt-1`}
                          rows={2}
                          value={reason}
                          onChange={(e) => { setReason(e.target.value); setConfirming(false); }}
                          placeholder="Entered against the wrong cold room"
                        />
                      </label>
                      {voidErr ? <p className="text-[13px] text-red-700">{voidErr}</p> : null}
                      <div className="flex flex-nowrap gap-2">
                        {confirming ? (
                          <>
                            <button
                              disabled={busy}
                              onClick={() => void doVoid()}
                              className="px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 flex flex-nowrap items-center gap-2 whitespace-nowrap"
                            >
                              <Check size={15} className="shrink-0" /> Yes, cancel it
                            </button>
                            <button
                              onClick={() => setConfirming(false)}
                              className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#6B5744] whitespace-nowrap"
                            >
                              Keep it
                            </button>
                          </>
                        ) : (
                          <button
                            disabled={busy || reason.trim().length < 4}
                            onClick={() => setConfirming(true)}
                            className="px-3 py-2 rounded-lg border border-[#af4408] bg-white text-sm font-semibold text-[#af4408] disabled:opacity-40 whitespace-nowrap"
                            title={reason.trim().length < 4 ? 'Write the reason first' : undefined}
                          >
                            Cancel this {pre.record.one}
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-[#8B7355] leading-relaxed">
                        Cancelling does not delete anything and cannot change a single reading. The
                        record stays in the file, marked cancelled, with your reason on it.
                      </p>
                    </div>
                  ) : (
                    <p className="text-[12px] text-[#6B5744] mt-1 leading-relaxed">
                      {pre.refusal || 'This record cannot be cancelled from here.'}
                      {!pre.handled_here ? (
                        <>
                          {' '}
                          <a href={pre.record.path} className="text-[#af4408] font-medium hover:underline">
                            Open its own screen
                          </a>.
                        </>
                      ) : null}
                    </p>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * PHOTO RETENTION — the other half of §19
 * ------------------------------------------------------------------ */

const STORE_WORDS: Record<string, string> = {
  fssai_evidence: 'Checklist rounds',
  fssai_attachments: 'Registers (deliveries, sightings, certificates)',
};

/**
 * THE SENTENCE A MANAGER MUST NOT MISREAD — does the sweep run by itself? Said
 * from the scheduler's heartbeat only: running (when it last ran, what it did),
 * stopped, or no record of it ever running. When the heartbeat could not be
 * read, it says exactly that and claims nothing either way.
 */
function RetentionArming({
  jobs, jobsErr, months,
}: {
  jobs: JobsTruth | null;
  jobsErr: string | null;
  months: number;
}) {
  const keep = (
    <>
      Photographs are kept for {months} months, after which the PICTURE can be dropped while the
      record, its size and its fingerprint stay for ever.
    </>
  );
  if (!jobs) {
    return (
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          {jobsErr
            ? <AlertTriangle size={16} className="text-[#af4408] shrink-0 mt-0.5" />
            : <Loader2 size={16} className="text-[#af4408] shrink-0 mt-0.5 animate-spin" />}
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            {jobsErr ? (
              <>
                <strong>Whether the sweep runs by itself could not be read.</strong> ({jobsErr})
                Nothing here says it is scheduled, or that it is not. {keep}
              </>
            ) : (
              <>Reading whether the sweep has run by itself… {keep}</>
            )}
          </p>
        </div>
      </div>
    );
  }
  const tone = jobs.state === 'running'
    ? 'bg-green-50 border-green-200'
    : jobs.state === 'stopped'
      ? 'bg-red-50 border-red-200'
      : 'bg-amber-50 border-amber-200';
  const head = jobs.state === 'running'
    ? 'Running by itself.'
    : jobs.state === 'stopped'
      ? 'Stopped.'
      : 'Never run by itself here.';
  return (
    <div className={`border rounded-xl p-3 sm:p-4 ${tone}`}>
      <div className="flex flex-nowrap items-start gap-2.5">
        {jobs.state === 'running'
          ? <ShieldCheck size={16} className="text-green-700 shrink-0 mt-0.5" />
          : <AlertTriangle size={16} className={`${jobs.state === 'stopped' ? 'text-red-700' : 'text-amber-800'} shrink-0 mt-0.5`} />}
        <p className="text-[13px] text-[#3D2614] leading-relaxed">
          <strong>{head}</strong> {jobs.retention_sentence} {keep}
        </p>
      </div>
    </div>
  );
}

function RetentionPanel({
  data, busy, msg, confirming, onConfirm, onRun, jobs, jobsErr,
}: {
  data: RetentionPayload | null;
  busy: boolean;
  msg: string | null;
  confirming: boolean;
  onConfirm: (v: boolean) => void;
  onRun: (which: 'preview' | 'sweep') => void;
  jobs: JobsTruth | null;
  jobsErr: string | null;
}) {
  if (!data) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
        {msg ? <p className="text-sm text-red-700">{msg}</p> : <Loader2 className="w-5 h-5 mx-auto animate-spin text-[#af4408]" />}
      </div>
    );
  }
  const st = data.status;

  return (
    <div className="space-y-3">
      {/* The honest sentence first — it is the one a manager must not misread. */}
      <RetentionArming jobs={jobs} jobsErr={jobsErr} months={st.retention_months} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Images held" value={st.held} />
        <Stat label="Past the window" value={st.overdue} tone={st.overdue > 0 ? 'warn' : 'plain'} />
        <Stat label="Already aged out" value={st.already_dropped} />
        <div className="rounded-xl border border-[#E8D5C4] bg-white p-3">
          <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">Space held</p>
          <p className="text-lg font-bold text-[#2D1B0E]">{st.held_bytes_label}</p>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
        <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-2">Both photo stores</p>
        <div className="space-y-1.5">
          {st.stores.map((x) => (
            <div key={x.store} className="flex flex-nowrap items-baseline justify-between gap-2 text-[13px]">
              <span className="text-[#2D1B0E] min-w-0 truncate">
                {STORE_WORDS[x.store] || x.store}
              </span>
              <span className="text-[#6B5744] whitespace-nowrap shrink-0">
                {x.present
                  ? `${x.held} held · ${x.overdue} past the window · ${x.already_dropped} aged out`
                  : 'not in this database yet'}
              </span>
            </div>
          ))}
        </div>
        {st.stores_missing ? (
          <p className="text-[12px] text-amber-800 mt-2">
            A sweep cannot walk {st.stores_missing} on this database, so those photographs are not
            counted above. It appears on the next restart.
          </p>
        ) : null}
      </div>

      {data.can_sweep ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <p className="text-[13px] text-[#3D2614]">
            A <strong>preview</strong> changes nothing and tells you what a sweep would drop.
            A <strong>sweep</strong> drops the pictures that have passed {data.ruled_months} months
            and records what it did.
          </p>
          <div className="flex flex-nowrap gap-2">
            <button
              disabled={busy}
              onClick={() => onRun('preview')}
              className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm font-medium text-[#6B5744] hover:border-[#af4408] disabled:opacity-50 whitespace-nowrap"
            >
              {busy ? 'Working…' : 'Preview'}
            </button>
            {confirming ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => onRun('sweep')}
                  className="px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 flex flex-nowrap items-center gap-2 whitespace-nowrap"
                >
                  <Check size={15} className="shrink-0" /> Yes, drop them
                </button>
                <button
                  onClick={() => onConfirm(false)}
                  className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#6B5744] whitespace-nowrap"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                disabled={busy || st.overdue === 0}
                onClick={() => onConfirm(true)}
                className="px-3 py-2 rounded-lg border border-[#af4408] bg-white text-sm font-semibold text-[#af4408] disabled:opacity-40 flex flex-nowrap items-center gap-2 whitespace-nowrap"
                title={st.overdue === 0 ? 'Nothing has passed the window yet' : undefined}
              >
                <Trash2 size={15} className="shrink-0" /> Run the sweep
              </button>
            )}
          </div>
          {msg ? <p className="text-[13px] text-[#2D1B0E]">{msg}</p> : null}
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <p className="text-[13px] text-[#6B5744]">
            Only an administrator can run a sweep. Dropping images is the most destructive thing this
            module does, so the button is not here for a manager.
          </p>
        </div>
      )}

      <div>
        <p className="text-[11px] uppercase tracking-wide text-[#8B7355] mb-1 flex flex-nowrap items-center gap-2">
          <CalendarDays size={13} className="shrink-0" /> Every sweep so far
        </p>
        {data.runs.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 text-center">
            <p className="text-[13px] text-[#3D2614]">
              No sweep has ever run. That is itself the answer: nothing has been dropped.
            </p>
          </div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E4D6]">
            {data.runs.map((r) => (
              <div key={r.id} className="p-3">
                <div className="flex flex-nowrap items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold text-[#2D1B0E]">{fmtIST(r.started_at)}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border shrink-0 ${
                    r.interrupted
                      ? 'bg-amber-100 text-amber-800 border-amber-200'
                      : r.status === 'failed'
                        ? 'bg-red-100 text-red-700 border-red-200'
                        : 'bg-green-100 text-green-700 border-green-200'
                  }`}>
                    {r.interrupted ? 'interrupted' : r.status}
                  </span>
                </div>
                <p className="text-[12px] text-[#6B5744] mt-1">
                  scanned {r.scanned_count} · dropped {r.dropped_count} ({r.evidence_dropped} rounds,{' '}
                  {r.attachments_dropped} registers) · freed {r.bytes_freed_label} · window{' '}
                  {r.months_kept} months · by {r.triggered_by || 'unknown'}
                </p>
                {r.detail ? <p className="text-[12px] text-amber-800 mt-1">{r.detail}</p> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
