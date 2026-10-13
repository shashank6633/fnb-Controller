'use client';

/**
 * BILL HANDOVER — THE ACCOUNTS VIEW
 * =================================
 *
 * The owner's words: "The Accounts User has a SEPARATE VIEW of everything the
 * Store submitted. Having checked the bill really arrived, they click 'Confirm
 * Received', and the system records Received/Confirmed By, Accounts
 * Confirmation Date & Time, and the final status 'Received by Accounts'."
 *
 * So this screen is one question asked once per bill — did this piece of paper
 * actually reach your desk? — and it is ordered so the question that has gone
 * unanswered longest is the first one on the page.
 *
 * ── OLDEST FIRST, AND MEASURED FROM THE SUBMISSION ─────────────────────────
 * GET /api/bill-submissions orders newest-first (received_date DESC) and takes
 * no sort parameter, so the ordering is done here — over the WHOLE filtered set,
 * not one page (getAllPages). Sorting page 1 alone would put the second-oldest
 * bill on page 2 and then call the wrong one "longest waiting", which on a
 * screen built to end an argument about who has what is worse than not sorting
 * at all.
 *
 * The clock runs from submitted_at, not received_date: a bill received on Monday
 * and handed over on Thursday has been waiting on Accounts since Thursday.
 *
 * ── NOTHING AUTO-CONFIRMS, AND NOTHING HERE COULD ──────────────────────────
 * The waiting colours and the "waiting too long" banner are display only. There
 * is no timer, no sweep and no "after N days assume it arrived" anywhere in this
 * feature: the single code path to "Received by Accounts" is a person clicking
 * Confirm, which POSTs to :id/confirm, which is the only caller of
 * confirmBillHandover(). A machine-set confirmation would be a lie in exactly
 * the place the owner asked for the truth.
 *
 * ── TWO PEOPLE, OR IT IS NOT EVIDENCE ──────────────────────────────────────
 * The server refuses a confirmation by whoever recorded or submitted the bill,
 * with NO admin exemption (bill-handover.ts selfConfirmRefusal, re-stated in the
 * UPDATE's WHERE). This screen mirrors that rule so the button is never rendered
 * live for a bill you cannot confirm — but the mirror is a courtesy, never the
 * gate, and when the server refuses anyway its sentence is shown verbatim rather
 * than re-worded.
 *
 * ── THE GATE IS THE ROUTE'S, NOT THE CATALOG'S ─────────────────────────────
 * page_access is inert on the live data (role_id set on 0 of 9 users, page_access
 * NULL on 8 of 9) and src/proxy.ts guards pages, not APIs. Everything below
 * renders from what the API returned, including its refusals; nothing here
 * decides who may do what.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import {
  AccountsRoleBanner, CutoffNotice, DashboardTiles, DeniedPanel, LiquorScopeNote, RecordDrawer,
  StatusChip, UnrecordedNote, WaitChip, billTitle, getAllPages, getJson, money, waitedSince,
  WAIT_ATTENTION_DAYS,
  type CanFlags, type HandoverRow, type ListPayload, type SummaryPayload,
} from '../_components/bill-handover-ui';
import {
  AlertTriangle, BadgeCheck, CheckCircle2, History, Inbox, Loader2, RefreshCw, ShieldAlert,
} from 'lucide-react';

interface MePayload {
  user: { id: string; name: string; email: string; role: string; role_name: string | null } | null;
}

export default function BillHandoverAccountsPage() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [queue, setQueue] = useState<HandoverRow[]>([]);
  const [recent, setRecent] = useState<HandoverRow[]>([]);
  const [head, setHead] = useState<ListPayload | null>(null);
  const [me, setMe] = useState<MePayload['user']>(null);
  const [can, setCan] = useState<CanFlags>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);

  /** The row whose Confirm button has been pressed once — the affirm step. */
  const [arming, setArming] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  /** Ticks so the waiting clock ages on screen without a reload. */
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);

    const s = await getJson<SummaryPayload>('/api/bill-submissions/summary');
    if (!mounted.current) return;
    if (!s.ok) {
      if (s.problem.status === 401) {
        setDenied('Your session has ended. Sign in again to open the bill register.');
      } else if (s.problem.status === 403) {
        setDenied(s.problem.error);
      } else {
        setLoadError(s.problem.error);
      }
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setDenied(null);
    setSummary(s.data);
    setCan(s.data.can || {});

    // Everything the store has submitted and Accounts has not yet confirmed.
    const q = await getAllPages('/api/bill-submissions?status=submitted');
    if (!mounted.current) return;
    if (!q.ok) {
      setLoadError(q.problem.error);
    } else {
      setQueue(q.rows);
      setHead(q.head);
      setCapped(q.capped);
      if (q.head?.can) setCan(q.head.can);
    }

    // A short tail of what has already been confirmed, so the screen shows the
    // loop closing and not only the work outstanding.
    const r = await getJson<ListPayload>('/api/bill-submissions?status=received&page=1&pageSize=5');
    if (mounted.current && r.ok) setRecent(r.data.rows || []);

    setNow(Date.now());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Keep the waiting clock honest, and pick up a store submission made while
  // this tab sat open. Refreshing on focus is the grn/qc precedent.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    const poll = setInterval(() => void load(true), 120_000);
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  useEffect(() => {
    void (async () => {
      const r = await getJson<MePayload>('/api/auth/me');
      if (mounted.current && r.ok) setMe(r.data.user);
    })();
  }, []);

  /**
   * Oldest first. submitted_at is the clock; a row that somehow reached
   * 'submitted' with no stamp falls back to its received date so it still sorts
   * rather than silently sinking to the bottom.
   */
  const ordered = useMemo(() => {
    const key = (r: HandoverRow) => r.submitted_at || `${r.received_date} 00:00:00`;
    return [...queue].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }, [queue]);

  const overdue = useMemo(
    () => ordered.filter((r) => waitedSince(r.submitted_at, now).days >= WAIT_ATTENTION_DAYS),
    [ordered, now],
  );

  /** Mirrors selfConfirmRefusal() on the server. A courtesy, not the gate. */
  const blockedReason = useCallback(
    (r: HandoverRow): string | null => {
      if (!me) return null;
      if (r.submitted_by_id && r.submitted_by_id === me.id) {
        return 'You submitted this bill, so you cannot also confirm that Accounts received it.';
      }
      if (r.created_by_id && r.created_by_id === me.id) {
        return 'You recorded this bill on the store side, so you cannot also confirm that Accounts received it.';
      }
      return null;
    },
    [me],
  );

  const confirm = useCallback(
    async (row: HandoverRow) => {
      setBusy(row.id);
      setRowError(null);
      try {
        const res = await api(`/api/bill-submissions/${encodeURIComponent(row.id)}/confirm`, {
          method: 'POST',
          body: { note: note.trim() },
        });
        let body: { error?: string; handover?: HandoverRow } | null = null;
        let parsed = true;
        try {
          body = await res.json();
        } catch {
          parsed = false;
        }
        if (!res.ok) {
          // The server's own sentence, verbatim. A non-JSON body means the proxy
          // refused the request before it reached the app — say that instead of
          // blaming the feature.
          setRowError({
            id: row.id,
            message: parsed
              ? body?.error || `HTTP ${res.status}`
              : `The server answered ${res.status} without a message — the request may have been refused by the proxy before it reached the app.`,
          });
          return;
        }
        setFlash(
          `Recorded: ${billTitle(row)} from ${row.vendor_name || 'the vendor'} is now "Received by Accounts", stamped with your name and the time.`,
        );
        setArming(null);
        setNote('');
        await load(true);
      } catch {
        setRowError({ id: row.id, message: 'Network error — nothing was recorded. Try again.' });
      } finally {
        setBusy(null);
      }
    },
    [note, load],
  );

  if (denied) return <DeniedPanel message={denied} />;

  const labels = summary?.labels;
  const readOnly = !can.confirm;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Inbox className="w-6 h-6 text-[#af4408]" /> Bill Handover — Accounts
          </h1>
          <p className="text-[11px] text-[#6B5744] mt-0.5 max-w-2xl">
            Every vendor bill the store has marked as handed over, waiting for you to confirm it actually arrived.
            Longest wait first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/bill-submissions/history"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F]"
          >
            <History className="w-3.5 h-3.5" /> Full history
          </Link>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F] disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <AccountsRoleBanner state={summary?.accounts_role ?? head?.accounts_role} viewerCanConfirm={!!can.confirm} />
      <CutoffNotice cutoff={summary?.cutoff ?? head?.cutoff} />

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">{loadError}</div>
      )}

      {flash && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-px shrink-0" />
          <span className="flex-1">{flash}</span>
          <button type="button" onClick={() => setFlash(null)} className="text-[11px] underline shrink-0">
            dismiss
          </button>
        </div>
      )}

      {/* ── the dashboard ──────────────────────────────────────────────── */}
      <DashboardTiles summary={summary} active="submitted" />
      <UnrecordedNote summary={summary} />

      {/* ── the thing that must not stay buried ────────────────────────── */}
      {overdue.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-px shrink-0" />
          <span>
            <b>
              {overdue.length} bill{overdue.length === 1 ? '' : 's'}
            </b>{' '}
            {overdue.length === 1 ? 'has' : 'have'} been waiting more than {WAIT_ATTENTION_DAYS} days for your
            confirmation — the oldest since {fmtIST(overdue[0]?.submitted_at)}. Nothing confirms itself; each one needs
            somebody to say the bill arrived.
          </span>
        </div>
      )}

      {readOnly && !loading && (
        <div className="rounded-lg border border-[#E8D5C4] bg-white px-3 py-2.5 text-[12px] text-[#6B5744] flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 mt-px shrink-0 text-[#8B7355]" />
          <span>
            You can see this queue but not confirm on it — confirming is the Accounts team&apos;s half of the handover,
            and the store side does not sign for its own delivery. This is the same list Accounts is looking at.
          </span>
        </div>
      )}

      {/* ── the queue ──────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-bold text-[#2D1B0E]">
            Awaiting your confirmation{' '}
            <span className="text-[11px] font-normal text-[#8B7355]">({ordered.length}, longest wait first)</span>
          </h2>
          {capped && (
            <span className="text-[10px] text-amber-800">
              Showing the first 2,000 — narrow the view on the history page.
            </span>
          )}
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-[12px] text-[#8B7355] py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading what the store has submitted…
          </div>
        )}

        {!loading && ordered.length === 0 && (
          <div className="rounded-lg border border-[#E8D5C4] bg-white px-4 py-8 text-center">
            <BadgeCheck className="w-6 h-6 text-emerald-600 mx-auto mb-2" />
            <p className="text-[13px] font-semibold text-[#2D1B0E]">Nothing is waiting on Accounts.</p>
            <p className="text-[11px] text-[#8B7355] mt-1 max-w-md mx-auto">
              Every bill the store has handed over has been confirmed. When the store marks its next bill as submitted
              it appears here — this register only covers bills received from{' '}
              {summary?.cutoff?.date ?? 'its start date'} onwards.
            </p>
          </div>
        )}

        {ordered.map((r) => {
          const w = waitedSince(r.submitted_at, now);
          const blocked = blockedReason(r);
          const armed = arming === r.id;
          const isBusy = busy === r.id;
          const err = rowError?.id === r.id ? rowError.message : null;
          return (
            <div
              key={r.id}
              className={`rounded-lg border bg-white px-3 py-3 ${
                w.tone === 'overdue' ? 'border-red-200' : w.tone === 'attention' ? 'border-amber-200' : 'border-[#E8D5C4]'
              }`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] font-bold text-[#2D1B0E]">{billTitle(r)}</span>
                    <StatusChip status={r.status} labels={labels} />
                    <WaitChip w={w} />
                  </div>
                  <p className="text-[12px] text-[#6B5744] mt-0.5">{r.vendor_name || 'Vendor not recorded'}</p>
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    {money(r.bill_value)} · received {fmtISTDate(r.received_date)}
                    {r.grn_number ? ` · ${r.grn_number}` : r.source === 'manual' ? ' · manual entry' : ''}
                    {r.attachment_count ? ` · ${r.attachment_count} scan` : ''}
                  </p>
                  <p className="text-[11px] text-[#8B7355]">
                    Handed over by <b className="font-semibold text-[#6B5744]">{r.submitted_by_name || r.submitted_by_email || '—'}</b>{' '}
                    on {fmtIST(r.submitted_at)}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className="text-[11px] text-[#af4408] hover:underline"
                  >
                    Full history
                  </button>
                  {can.confirm && !blocked && !armed && (
                    <button
                      type="button"
                      onClick={() => {
                        setArming(r.id);
                        setNote('');
                        setRowError(null);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-[12px] font-semibold hover:bg-[#8a3506]"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Confirm Received
                    </button>
                  )}
                </div>
              </div>

              {/* The affirm step. Confirming is the evidence this whole feature
                  exists to produce, so it is never a single stray tap. */}
              {armed && (
                <div className="mt-3 rounded-lg border border-[#D4B896] bg-[#FFF8F0] px-3 py-3">
                  <p className="text-[12px] font-semibold text-[#2D1B0E]">
                    Do you have this bill in Accounts?
                  </p>
                  <p className="text-[11px] text-[#6B5744] mt-1">
                    Confirming records your name and the time against{' '}
                    <b>
                      {billTitle(r)} · {r.vendor_name || 'vendor'} · {money(r.bill_value)}
                    </b>{' '}
                    and sets it to “Received by Accounts”. Only an Administrator can undo it afterwards, and the undo is
                    itself recorded.
                  </p>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    placeholder="Optional note — e.g. received with the Thursday batch"
                    className="mt-2 w-full px-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] placeholder:text-[#C0A98F] focus:outline-none focus:border-[#af4408]"
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void confirm(r)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#af4408] text-white text-[12px] font-semibold hover:bg-[#8a3506] disabled:opacity-60"
                    >
                      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      Yes — confirm receipt
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setArming(null);
                        setNote('');
                        setRowError(null);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F] disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {blocked && can.confirm && (
                <p className="mt-2 text-[11px] text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded px-2 py-1.5">
                  {blocked} Two different people is the whole point of the record — ask a colleague on the Accounts side
                  to confirm this one.
                </p>
              )}

              {err && (
                <p className="mt-2 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">{err}</p>
              )}
            </div>
          );
        })}
      </section>

      {/* ── the loop closing ───────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="space-y-1.5">
          <h2 className="text-[13px] font-bold text-[#2D1B0E]">Recently confirmed</h2>
          <div className="rounded-lg border border-[#E8D5C4] bg-white divide-y divide-[#F3EEE7]">
            {recent.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setOpenId(r.id)}
                className="w-full text-left px-3 py-2 hover:bg-[#FFF8F0] flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="text-[12px] font-semibold text-[#2D1B0E] block truncate">
                    {billTitle(r)} · {r.vendor_name || '—'}
                  </span>
                  <span className="text-[11px] text-[#8B7355]">
                    {money(r.bill_value)} · confirmed by {r.confirmed_by_name || r.confirmed_by_email || '—'} on{' '}
                    {fmtIST(r.confirmed_at)}
                  </span>
                </span>
                <BadgeCheck className="w-4 h-4 text-emerald-600 shrink-0" />
              </button>
            ))}
          </div>
          {/* No ?status= on purpose — see the note in history/page.tsx. The
              "Received by Accounts" tile on that page is one click. */}
          <Link href="/bill-submissions/history" className="text-[11px] text-[#af4408] hover:underline">
            See the full handover history →
          </Link>
        </section>
      )}

      <LiquorScopeNote />

      {openId && (
        <RecordDrawer
          id={openId}
          labels={labels}
          onClose={() => setOpenId(null)}
          onChanged={() => void load(true)}
        />
      )}
    </div>
  );
}
