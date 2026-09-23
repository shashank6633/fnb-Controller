'use client';

/**
 * BILL HANDOVER — THE SHARED HISTORY
 * ==================================
 *
 * The owner's words: "Store Manager AND Accounts can both track the whole
 * handover history: Bill Number, Vendor, Bill Value, Store Submission
 * Timestamp, Accounts Confirmation Timestamp, current status."
 *
 * Those six are the table's columns, in that order, and they are the reason this
 * page is one shared screen rather than a store copy and an accounts copy. Two
 * departments reading two different lists is the argument the feature exists to
 * end; one list that both can open, filter and export is the answer to it.
 *
 * WHO CAN OPEN IT: the union of the two working sets, decided by the API
 * (canViewBillHandovers = the store side OR the accounts side). A refusal is
 * rendered with the server's own sentence. src/proxy.ts guards pages and not
 * APIs, and page_access is inert on the live data, so GET /api/bill-submissions
 * is the entire boundary — nothing on this screen decides access.
 *
 * ── THE WHOLE FILTER, NOT ITS FIRST PAGE ───────────────────────────────────
 * Rows are read through getAllPages so the sort, the counts under the filter bar
 * and above all the CSV are the filter the user is looking at rather than its
 * first 50 rows. An export that silently drops rows 51+ is worse than no export,
 * because it looks authoritative. The 2,000-row ceiling is stated on screen when
 * it is reached.
 *
 * ── EVERY TIMESTAMP IS RENDERED IN IST ─────────────────────────────────────
 * The stamps are UTC in the database. The two timestamp columns are the evidence
 * this feature exists to produce, so they go through src/lib/format-date.ts and
 * carry a visible "IST" — and the CSV exports BOTH the IST rendering and the raw
 * UTC value, so a spreadsheet opened in any timezone can still be reconciled
 * against the database.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import {
  AccountsRoleBanner, CutoffNotice, DashboardTiles, DeniedPanel, LiquorScopeNote, RecordDrawer,
  StatusChip, UnrecordedNote, WaitChip, csvEscape, downloadCsv, getAllPages, getJson,
  money, waitedSince, WAIT_ATTENTION_DAYS,
  type BhStatus, type CanFlags, type HandoverRow, type ListPayload, type SummaryPayload,
} from '../_components/bill-handover-ui';
import { Download, FileText, History, Inbox, Loader2, RefreshCw, Search, X } from 'lucide-react';

type StatusFilter = 'all' | 'open' | BhStatus;
type SortKey = 'received_desc' | 'received_asc' | 'waiting';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All live records' },
  { value: 'open', label: 'Still open (pending or submitted)' },
  { value: 'pending_submission', label: 'Pending Submission' },
  { value: 'submitted', label: 'Submitted to Accounts' },
  { value: 'received', label: 'Received by Accounts' },
  { value: 'void', label: 'Voided' },
];

const PAGE_STEP = 50;

export default function BillHandoverHistoryPage() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('received_desc');

  /**
   * How many rows are shown, TIED TO THE VIEW IT WAS EXPANDED FOR.
   *
   * Stored as {key, n} and read back only when the key still matches the current
   * filter+sort, so changing a filter drops straight back to the first 50 with no
   * effect to reset it. Resetting it from a useEffect would be a setState made
   * synchronously inside an effect body, which cascades renders — and doing it by
   * hand in each of the eight filter controls is the kind of bookkeeping that
   * gets forgotten when a ninth is added.
   */
  const [shownFor, setShownFor] = useState<{ key: string; n: number }>({ key: '', n: PAGE_STEP });

  const [rows, setRows] = useState<HandoverRow[]>([]);
  const [head, setHead] = useState<ListPayload | null>(null);
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [can, setCan] = useState<CanFlags>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  /**
   * NO DEEP LINK, ON PURPOSE.
   *
   * A ?status= entry point would need either useSearchParams — which must sit
   * inside a <Suspense> boundary or it fails the production build, and the
   * owner's deploy is not worth a convenience — or a window.location read in an
   * effect, which means a setState inside an effect body plus a hydration
   * mismatch on the <select>. The three dashboard tiles are one click each and
   * do the same job, so the pages link here plainly.
   */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('status', status);
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    if (q.trim()) sp.set('q', q.trim());
    if (includeVoid && status === 'all') sp.set('include_void', '1');
    return sp.toString();
  }, [status, from, to, q, includeVoid]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      else setRefreshing(true);
      setLoadError(null);

      const r = await getAllPages(`/api/bill-submissions?${queryString}`);
      if (!mounted.current) return;
      if (!r.ok) {
        if (r.problem.status === 401) {
          setDenied('Your session has ended. Sign in again to open the bill register.');
        } else if (r.problem.status === 403) {
          setDenied(r.problem.error);
        } else {
          setLoadError(r.problem.error);
        }
        setLoading(false);
        setRefreshing(false);
        return;
      }
      setDenied(null);
      setRows(r.rows);
      setHead(r.head);
      setCapped(r.capped);
      setCan(r.head?.can || {});

      const s = await getJson<SummaryPayload>('/api/bill-submissions/summary');
      if (mounted.current && s.ok) setSummary(s.data);

      setNow(Date.now());
      setLoading(false);
      setRefreshing(false);
    },
    [queryString],
  );

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  /** Identity of the current view. `shown` follows it; see shownFor above. */
  const viewKey = `${queryString}|${waitingOnly ? 1 : 0}|${sort}`;
  const shown = shownFor.key === viewKey ? shownFor.n : PAGE_STEP;

  const view = useMemo(() => {
    let list = rows;
    if (waitingOnly) {
      list = list.filter(
        (r) => r.status === 'submitted' && waitedSince(r.submitted_at, now).days >= WAIT_ATTENTION_DAYS,
      );
    }
    const recKey = (r: HandoverRow) => `${r.received_date} ${r.created_at}`;
    const sorted = [...list];
    if (sort === 'received_desc') sorted.sort((a, b) => (recKey(a) < recKey(b) ? 1 : recKey(a) > recKey(b) ? -1 : 0));
    else if (sort === 'received_asc') sorted.sort((a, b) => (recKey(a) < recKey(b) ? -1 : recKey(a) > recKey(b) ? 1 : 0));
    else {
      // Longest waiting first: submitted-and-unconfirmed at the top, oldest
      // submission first; everything else keeps newest-received order behind it.
      const wk = (r: HandoverRow) => (r.status === 'submitted' && r.submitted_at ? r.submitted_at : '');
      sorted.sort((a, b) => {
        const A = wk(a);
        const B = wk(b);
        if (A && B) return A < B ? -1 : A > B ? 1 : 0;
        if (A) return -1;
        if (B) return 1;
        return recKey(a) < recKey(b) ? 1 : -1;
      });
    }
    return sorted;
  }, [rows, waitingOnly, sort, now]);

  const totals = useMemo(
    () => ({ n: view.length, value: view.reduce((s, r) => s + (Number(r.bill_value) || 0), 0) }),
    [view],
  );

  /** The house export shape. Both the IST rendering and the raw UTC stamp go in
   *  each timestamp column, so the file can be read by a person and reconciled
   *  by a machine. */
  const exportCsv = useCallback(() => {
    const header = [
      'Bill Number',
      'Vendor',
      'Bill Value',
      'Store Submission Timestamp (IST)',
      'Accounts Confirmation Timestamp (IST)',
      'Status',
      'Received Date',
      'Bill Date',
      'Goods Receipt',
      'Source',
      'Recorded By',
      'Submitted By',
      'Confirmed By',
      'Void Reason',
      'Store Submission (UTC raw)',
      'Accounts Confirmation (UTC raw)',
      'Record Id',
    ];
    const lines = [header.map(csvEscape).join(',')];
    for (const r of view) {
      lines.push(
        [
          r.bill_no,
          r.vendor_name,
          (Number(r.bill_value) || 0).toFixed(2),
          r.submitted_at ? fmtIST(r.submitted_at) : '',
          r.confirmed_at ? fmtIST(r.confirmed_at) : '',
          (summary?.labels?.short ?? {})[r.status] ?? r.status,
          r.received_date,
          r.bill_date,
          r.grn_number,
          r.source,
          r.created_by_name || r.created_by_email,
          r.submitted_by_name || r.submitted_by_email,
          r.confirmed_by_name || r.confirmed_by_email,
          r.void_reason,
          r.submitted_at ?? '',
          r.confirmed_at ?? '',
          r.id,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    downloadCsv(`bill-handover-${status}-${new Date().toISOString().slice(0, 10)}.csv`, lines);
  }, [view, status, summary]);

  if (denied) return <DeniedPanel message={denied} />;

  const labels = summary?.labels;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <History className="w-6 h-6 text-[#af4408]" /> Bill Handover — History
          </h1>
          <p className="text-[11px] text-[#6B5744] mt-0.5 max-w-3xl">
            Every vendor bill in the register, with when the store handed it over and when Accounts confirmed it
            arrived. The same list for both departments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can.confirm && (
            <Link
              href="/bill-submissions/accounts"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F]"
            >
              <Inbox className="w-3.5 h-3.5" /> Accounts queue
            </Link>
          )}
          <button
            type="button"
            onClick={exportCsv}
            disabled={view.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F] disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Download CSV
          </button>
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

      <DashboardTiles
        summary={summary}
        active={status}
        onPick={(s) => {
          setStatus((cur) => (cur === s ? 'all' : s));
          setWaitingOnly(false);
        }}
      />
      <UnrecordedNote summary={summary} />

      {/* ── filters ────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-[#E8D5C4] bg-white px-3 py-3 space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-[#6B5744]">
            <span className="block mb-0.5 font-semibold">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="px-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[11px] text-[#6B5744]">
            <span className="block mb-0.5 font-semibold">Received from</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </label>
          <label className="text-[11px] text-[#6B5744]">
            <span className="block mb-0.5 font-semibold">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </label>

          <label className="text-[11px] text-[#6B5744] flex-1 min-w-[180px]">
            <span className="block mb-0.5 font-semibold">Bill number, vendor or GRN</span>
            <span className="relative block">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[#C0A98F]" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="e.g. 1122, HYPERPURE, GRN-2026-0004"
                className="w-full pl-7 pr-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] placeholder:text-[#C0A98F] focus:outline-none focus:border-[#af4408]"
              />
            </span>
          </label>

          <label className="text-[11px] text-[#6B5744]">
            <span className="block mb-0.5 font-semibold">Order</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="px-2 py-1.5 rounded border border-[#E8D5C4] bg-white text-[12px] text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            >
              <option value="received_desc">Newest received first</option>
              <option value="received_asc">Oldest received first</option>
              <option value="waiting">Longest waiting on Accounts first</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-[#F3EEE7]">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#6B5744] cursor-pointer">
            <input
              type="checkbox"
              checked={waitingOnly}
              onChange={(e) => setWaitingOnly(e.target.checked)}
              className="accent-[#af4408]"
            />
            Only bills waiting more than {WAIT_ATTENTION_DAYS} days for Accounts
          </label>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-[#6B5744] cursor-pointer">
            <input
              type="checkbox"
              checked={includeVoid}
              disabled={status !== 'all'}
              onChange={(e) => setIncludeVoid(e.target.checked)}
              className="accent-[#af4408]"
            />
            Include voided records
            <span className="text-[#B8A590]">(kept as audit, never deleted)</span>
          </label>
          {(status !== 'all' || from || to || q || waitingOnly || includeVoid) && (
            <button
              type="button"
              onClick={() => {
                setStatus('all');
                setFrom('');
                setTo('');
                setQ('');
                setWaitingOnly(false);
                setIncludeVoid(false);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-[#af4408] hover:underline"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
          <span className="ml-auto text-[11px] text-[#8B7355] tabular-nums">
            {totals.n} record{totals.n === 1 ? '' : 's'} · {money(totals.value)}
          </span>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">{loadError}</div>
      )}
      {capped && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          This filter matches more than 2,000 records, and only the first 2,000 were loaded — narrow the date range
          before relying on the totals or the CSV.
        </div>
      )}

      {/* ── the six columns the owner asked for, in his order ───────────── */}
      <div className="rounded-lg border border-[#E8D5C4] bg-white overflow-x-auto">
        <table className="w-full text-[12px] min-w-[880px]">
          <thead>
            <tr className="bg-[#FFF8F0] text-[10px] uppercase tracking-wide text-[#8B7355]">
              <th className="text-left font-semibold px-3 py-2">Bill Number</th>
              <th className="text-left font-semibold px-3 py-2">Vendor</th>
              <th className="text-right font-semibold px-3 py-2">Bill Value</th>
              <th className="text-left font-semibold px-3 py-2">Store Submission</th>
              <th className="text-left font-semibold px-3 py-2">Accounts Confirmation</th>
              <th className="text-left font-semibold px-3 py-2">Status</th>
              <th className="text-left font-semibold px-3 py-2">Received</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F3EEE7]">
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[#8B7355]">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading the handover history…
                  </span>
                </td>
              </tr>
            )}
            {!loading && view.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center">
                  <FileText className="w-5 h-5 text-[#C0A98F] mx-auto mb-2" />
                  <p className="text-[13px] font-semibold text-[#2D1B0E]">No bill records match this view.</p>
                  <p className="text-[11px] text-[#8B7355] mt-1 max-w-md mx-auto">
                    The register starts at {summary?.cutoff?.date ?? 'its recorded start date'} and holds only bills
                    received on or after it. Bills received before that date were deliberately never brought in.
                  </p>
                </td>
              </tr>
            )}
            {view.slice(0, shown).map((r) => {
              const w = r.status === 'submitted' ? waitedSince(r.submitted_at, now) : null;
              return (
                <tr
                  key={r.id}
                  className="hover:bg-[#FFF8F0] cursor-pointer align-top"
                  onClick={() => setOpenId(r.id)}
                >
                  <td className="px-3 py-2">
                    <span className="font-semibold text-[#2D1B0E]">{r.bill_no || '—'}</span>
                    <span className="block text-[10px] text-[#B8A590]">
                      {r.grn_number || (r.source === 'manual' ? 'manual entry' : '')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[#6B5744]">{r.vendor_name || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#2D1B0E]">{money(r.bill_value)}</td>
                  <td className="px-3 py-2">
                    {r.submitted_at ? (
                      <>
                        <span className="text-[#2D1B0E]">{fmtIST(r.submitted_at)}</span>
                        <span className="block text-[10px] text-[#B8A590]">
                          {r.submitted_by_name || r.submitted_by_email || '—'}
                        </span>
                      </>
                    ) : (
                      <span className="text-[#B8A590] italic">Not handed over yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.confirmed_at ? (
                      <>
                        <span className="text-[#2D1B0E]">{fmtIST(r.confirmed_at)}</span>
                        <span className="block text-[10px] text-[#B8A590]">
                          {r.confirmed_by_name || r.confirmed_by_email || '—'}
                        </span>
                      </>
                    ) : (
                      <span className="text-[#B8A590] italic">Not confirmed yet</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col items-start gap-1">
                      <StatusChip status={r.status} labels={labels} />
                      {w ? <WaitChip w={w} /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[#6B5744] whitespace-nowrap">{fmtISTDate(r.received_date)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-[11px] text-[#af4408]">History →</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {view.length > shown && (
        <button
          type="button"
          onClick={() => setShownFor({ key: viewKey, n: shown + PAGE_STEP })}
          className="w-full px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-[12px] font-semibold text-[#6B5744] hover:border-[#C0A98F]"
        >
          Show {Math.min(PAGE_STEP, view.length - shown)} more of {view.length}
        </button>
      )}

      <p className="text-[10px] text-[#B8A590] leading-relaxed">
        Every row here is the record of a physical handover: who recorded the bill, who handed it to Accounts and when,
        and who confirmed it arrived and when. Records are never deleted — one entered in error is voided with a reason
        and keeps its whole history. Open any row for that history.
      </p>
      <LiquorScopeNote />

      {openId && (
        <RecordDrawer id={openId} labels={labels} onClose={() => setOpenId(null)} onChanged={() => void load(true)} />
      )}
    </div>
  );
}
