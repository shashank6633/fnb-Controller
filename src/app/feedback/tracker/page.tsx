'use client';

/**
 * Page 3 — FEEDBACK TRACKER  (route: /feedback/tracker)
 *
 * Spec §3 Page 3: header counts (Active Tables · Feedback Due · Feedback Taken ·
 * Issues Raised · Follow-Up Required), one record per table, the six-way filter
 * plus Floor / GRE / Manager / Captain, and the GRE/Manager progress table
 * (Eligible Tables · Feedback Taken · Pending · Coverage %).
 *
 * ── WHAT CHANGED IN P4 LANE A ───────────────────────────────────────────────
 * It was rendering `../placeholder.ts`: five invented records, three invented
 * coverage rows and three invented captains, above a note promising a route
 * that did not exist. On a coverage ledger that is not a harmless stub — the
 * numbers a Floor Manager uses to decide whether the floor was actually walked
 * were fiction, and "83.3% coverage" read exactly like a measurement. It now
 * reads `GET /api/feedback/tracker`, which computes every count over the whole
 * BUSINESS DAY (not over the live floor board — see the route's §1: the tables
 * a GRE missed are precisely the ones that have already settled and left).
 *
 * 🔒 THE FAIRNESS RULING SHAPES THIS PAGE, in the owner's words: "The system
 * should not judge GRE performance based on positive feedback. A GRE should
 * never avoid recording negative feedback because it affects their performance."
 * So the progress table counts ACTIVITY only — tables visited, feedback taken,
 * follow-ups completed, issues RECORDED (the owner's own allowed metric, framed
 * as diligence) — and it is ordered by how much was done, never by sentiment.
 * There is deliberately no average rating, no complaint ratio and no score per
 * person: a GRE who records ten complaints and one who records none must look
 * identical here. Any column added later that makes recording a complaint look
 * bad for the recorder is a defect, not a feature.
 *
 * Eligible / Pending / Coverage % appear ONLY on the floor-total row, because
 * nothing in this app assigns a table to a person — a per-person denominator
 * would have to be invented, and an invented denominator in a performance table
 * is worse than no number at all. The page says so on screen.
 *
 * Records are cards, not table rows: at 390px a six-column row is either
 * unreadable or forces the page to scroll sideways. The one genuine table on
 * this page — coverage — is wrapped in `TableScroll` and scrolls inside itself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clock, Users, ChevronRight, MessageSquare, Lock, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  ACTIONS_TAKEN, GRE_ROLE_NAME, ITEM_ISSUES, ITEM_RATINGS, OVERALL_RATINGS, STATUS_STYLE,
  TRACKER_FILTERS, isNegative, statusLabel,
} from '@/lib/feedback';
import type {
  TrackerCoverageRow, TrackerItemRow, TrackerMeta, TrackerOptions, TrackerPayload,
  TrackerRecordRow, TrackerTotals,
} from '@/app/api/feedback/tracker/query';
import {
  Card, Chip, EmptyState, PageBody, PageHead, Scroller, Select,
  SectionTitle, StickyBar, TableScroll, Tile, elapsed, pct,
} from '../ui';

type FilterKey = (typeof TRACKER_FILTERS)[number]['v'];

/** What the route actually sends: the payload plus who is looking at it. */
type TrackerResponse = TrackerPayload & {
  viewer: { name: string; role_name: string | null; read_only: boolean; scope: string };
};

/** The refusal body `requireFeedbackReader()` returns. `what_to_do` is printed
 *  verbatim — the live trap is "role created but never ASSIGNED", which looks
 *  exactly like a broken page unless the screen names the missing step. */
interface Denial {
  error: string;
  reason: string;
  your_role?: string | null;
  what_to_do?: string;
}

const label = (list: readonly { v: string; label: string }[], v: string): string =>
  list.find((x) => x.v === v)?.label ?? v;

/** "Chicken Tikka - Poor · Dry · Remade" — the owner's own record line. */
function ItemLine({ it }: { it: TrackerItemRow }) {
  const bad = it.is_negative;
  const fu = it.follow_up;
  return (
    <div className="rounded-lg bg-[#FFF8F0] border border-[#F0E4D6] px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        <span className="font-extrabold text-[#2D1B0E]">{it.item_name || '—'}</span>
        {it.rating ? (
          <span className={`font-bold ${bad ? 'text-red-700' : 'text-emerald-700'}`}>
            {label(ITEM_RATINGS, it.rating)}
          </span>
        ) : null}
        {it.issue ? <span className="text-[#6B5744]">Issue: {label(ITEM_ISSUES, it.issue)}</span> : null}
        {it.action_taken && it.action_taken !== 'none' ? (
          <span className="text-[#6B5744]">
            Action: {label(ACTIONS_TAKEN, it.action_taken)}
            {it.replacement_item_name ? ` → ${it.replacement_item_name}` : ''}
          </span>
        ) : null}
        <span className="ml-auto text-[10px] uppercase tracking-wide text-[#8B7355]">
          {it.item_group === 'drinks' ? 'Drinks' : 'Food'}
        </span>
      </div>
      {it.comment ? (
        <div className="mt-1 text-[11px] italic text-[#6B5744]">“{it.comment}”</div>
      ) : null}
      {fu ? (
        <div
          className={`mt-1 text-[10px] font-bold ${fu.status === 'open' ? 'text-violet-700' : 'text-emerald-700'}`}
        >
          {fu.status === 'open'
            ? 'Revisit owed — the complaint stays open until the guest is asked again'
            : `Closed${fu.happiness ? ` · guest ${fu.happiness}` : ''}`}
        </div>
      ) : null}
    </div>
  );
}

export default function FeedbackTrackerPage() {
  const router = useRouter();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [floor, setFloor] = useState('all');
  const [gre, setGre] = useState('all');
  const [manager, setManager] = useState('all');
  const [captain, setCaptain] = useState('all');

  const [data, setData] = useState<TrackerResponse | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /** Filled after mount: elapsed times derive from Date.now(), which differs
   *  between the server render and the client one. */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    const qs = new URLSearchParams({ filter, floor, gre, manager, captain });
    try {
      const res = await api(`/api/feedback/tracker?${qs.toString()}`);
      if (res.status === 401 || res.status === 403) {
        let body: Denial = { error: `HTTP ${res.status}`, reason: 'unknown' };
        try { body = await res.json(); } catch { /* keep the fallback */ }
        setDenial(body);
        setData(null);
        setError(null);
        return;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* keep the fallback */ }
        setError(msg);
        return;
      }
      const body = (await res.json()) as TrackerResponse;
      setDenial(null);
      setError(null);
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [filter, floor, gre, manager, captain]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  // Every number below is the SERVER's, computed over the same scoped rows it
  // sent. Nothing is re-derived here — that is what stops the chips counting
  // one population while the list draws another (the Page 1 defect).
  const records: TrackerRecordRow[] = data?.records ?? [];
  const counts = data?.counts ?? {};
  const filterCounts = data?.filter_counts ?? {};
  const coverage: TrackerCoverageRow[] = data?.coverage ?? [];
  const totals: TrackerTotals | null = data?.totals ?? null;
  const options: TrackerOptions = data?.options ?? { floors: [], gres: [], managers: [], captains: [] };
  const meta: TrackerMeta | null = data?.meta ?? null;

  /** Keep a chosen value in its own dropdown even when the day's data no longer
   *  offers it — a `<select>` whose value is absent from its options silently
   *  renders the FIRST option, which would move the reader to "All" without
   *  saying so (the Page 1 floor-select defect). */
  const opts = useCallback(
    (allLabel: string, values: string[], current: string) => {
      const known = values.includes(current) || current === 'all';
      return [
        { v: 'all', label: allLabel },
        ...values.map((x) => ({ v: x, label: x })),
        ...(known ? [] : [{ v: current, label: `${current} (none today)` }]),
      ];
    },
    [],
  );

  const carried = useMemo(() => records.filter((r) => r.carried_over), [records]);

  if (denial) {
    return (
      <>
        <PageHead title="Feedback Tracker" subtitle="Access not confirmed" />
        <PageBody>
          <div className="mt-4 bg-white border border-[#E8D5C4] rounded-2xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-[#FFF1E3] border border-[#E8D5C4] flex items-center justify-center">
                <Lock className="w-5 h-5 text-[#af4408]" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-extrabold text-[#2D1B0E] leading-snug">{denial.error}</h2>
                {denial.what_to_do ? (
                  <p className="mt-2 text-[13px] leading-relaxed text-[#6B5744]">{denial.what_to_do}</p>
                ) : null}
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-[#8B7355] font-semibold">Role needed</dt>
                  <dd className="text-[#2D1B0E] font-bold">{GRE_ROLE_NAME} or management</dd>
                  <dt className="text-[#8B7355] font-semibold">Your role</dt>
                  <dd className="text-[#2D1B0E] font-bold">{denial.your_role || 'none assigned'}</dd>
                </dl>
              </div>
            </div>
          </div>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Feedback Tracker"
        subtitle={
          loading
            ? 'Loading the service…'
            : `${counts.taken ?? 0} of ${counts.active ?? 0} eligible tables covered${meta ? ` · ${meta.business_date}` : ''}`
        }
        right={
          <button
            type="button"
            onClick={() => { setNow(Date.now()); load(); }}
            aria-label="Refresh"
            className="w-11 h-11 rounded-xl bg-white border border-[#E8D5C4] text-[#6B5744] flex items-center justify-center active:scale-95 transition disabled:opacity-50"
            disabled={busy}
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
        }
      />

      <PageBody>
        {error ? (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error} — the ledger could not be loaded, so this is NOT an empty floor and NOT 100%
            coverage. Tap refresh.
          </div>
        ) : null}

        {/* Header counts — five tiles, two per row at 390px. They follow Floor
            and Captain but NOT the GRE / Manager filter: an unvisited table
            carries nobody's name, so a person-filtered coverage figure always
            reads 100 %. `meta.counts_scope` prints the rule below. */}
        <div className="pt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <Tile label="Active Tables" value={counts.active ?? 0} hint="eligible today" />
          <Tile
            label="Feedback Due"
            value={counts.due ?? 0}
            tone={counts.due ? 'warn' : 'plain'}
          />
          <Tile label="Feedback Taken" value={counts.taken ?? 0} tone="good" />
          <Tile
            label="Issues Raised"
            value={counts.issues ?? 0}
            tone={counts.issues ? 'bad' : 'plain'}
          />
          <Tile
            label="Follow-Up Required"
            value={counts.follow_up ?? 0}
            tone={counts.follow_up ? 'warn' : 'plain'}
            hint={
              counts.carried_over_follow_up
                ? `+${counts.carried_over_follow_up} from earlier days`
                : undefined
            }
          />
        </div>

        {carried.length > 0 ? (
          <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] leading-snug text-violet-800">
            <span className="font-bold">{carried.length} complaint{carried.length === 1 ? '' : 's'} carried over</span>{' '}
            from an earlier service ({carried.map((r) => `Table ${r.table_number}`).join(' · ')}). A
            revisit is still owed, so {carried.length === 1 ? 'it is' : 'they are'} listed here — and
            deliberately kept out of today&apos;s coverage arithmetic, which belongs to
            {carried.length === 1 ? ' its' : ' their'} own day.
          </div>
        ) : null}

        {/* Filters */}
        <div className="mt-4 space-y-2">
          <Scroller label="Filter records">
            {TRACKER_FILTERS.map((f) => (
              <Chip key={f.v} active={filter === f.v} onClick={() => setFilter(f.v)}>
                {f.label}
                {data ? ` ${filterCounts[f.v] ?? 0}` : ''}
              </Chip>
            ))}
          </Scroller>
          <Scroller label="Scope">
            <Select
              label="Floor"
              value={floor}
              onChange={setFloor}
              options={opts('All floors', options.floors, floor)}
            />
            <Select label="GRE" value={gre} onChange={setGre} options={opts('All', options.gres, gre)} />
            <Select
              label="Manager"
              value={manager}
              onChange={setManager}
              options={opts('All', options.managers, manager)}
            />
            <Select
              label="Captain"
              value={captain}
              onChange={setCaptain}
              options={opts('All', options.captains, captain)}
            />
          </Scroller>
        </div>

        {/* Records */}
        <SectionTitle hint={`${records.length} shown`}>Records</SectionTitle>
        <div className="space-y-2">
          {records.map((r) => (
            <Card key={r.order_id} className="p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-base font-extrabold leading-tight text-[#2D1B0E]">
                    Table {r.table_number || '—'}
                  </div>
                  <div className="text-[11px] text-[#8B7355] leading-tight">
                    {r.floor}
                    {r.covers ? ` · ${r.covers} pax` : ''}
                    {r.item_count ? ` · ${r.item_count} items` : ''}
                    {r.order_status === 'settled' ? ' · settled' : ''}
                    {r.carried_over ? ` · carried over from ${r.business_date || 'an earlier day'}` : ''}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLE[r.status]}`}
                >
                  {statusLabel(r.status)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#6B5744]">
                {r.overall ? (
                  <span
                    className={`font-extrabold ${isNegative(r.overall) ? 'text-red-700' : 'text-emerald-700'}`}
                  >
                    {label(OVERALL_RATINGS, r.overall)}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-[#8B7355]" />
                  {r.gre_name ? `${r.gre_role || 'Taken'} ${r.gre_name}` : 'Not visited'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-[#8B7355]" />
                  {r.taken_at
                    ? (now === null ? '···' : `${elapsed(r.taken_at, now)} ago`)
                    : 'pending'}
                </span>
                {r.issues > 0 ? (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                    <MessageSquare className="w-3.5 h-3.5" />
                    {r.issues} issue{r.issues === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>

              {r.visit_comment ? (
                <div className="mt-2 rounded-lg bg-[#FFF1E3] px-2.5 py-1.5 text-[11px] text-[#6B5744]">
                  “{r.visit_comment}”
                </div>
              ) : null}

              {r.items.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {r.items.map((it) => <ItemLine key={it.id} it={it} />)}
                </div>
              ) : null}

              <div className="mt-2 flex items-center gap-2 text-[11px] text-[#8B7355]">
                <span className="truncate">Capt. {r.captain_name || '—'}</span>
                {r.open_follow_ups > 0 ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/feedback/take/${r.order_id}`)}
                    className="ml-auto inline-flex items-center gap-0.5 font-bold text-violet-700 shrink-0 active:scale-95 transition"
                  >
                    {r.open_follow_ups} revisit owed
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : !r.visit_id ? (
                  <button
                    type="button"
                    onClick={() => router.push(`/feedback/take/${r.order_id}`)}
                    className="ml-auto inline-flex items-center gap-0.5 font-bold text-[#af4408] shrink-0 active:scale-95 transition"
                  >
                    Take feedback
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>

        {!loading && records.length === 0 ? (
          <EmptyState>
            {(counts.active ?? 0) === 0
              ? 'No eligible tables for this service yet. A table becomes eligible once it reaches the item threshold, asks for the bill, or has one printed.'
              : 'No records match this filter.'}
          </EmptyState>
        ) : null}

        {/* GRE / Manager progress — activity only, per the fairness ruling. */}
        <SectionTitle hint="coverage only — never rating">GRE / Manager progress</SectionTitle>
        <Card className="p-3">
          <TableScroll>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[#8B7355]">
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Person</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Role</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Tables</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Taken</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Share</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Issues rec.</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Follow-ups</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((c) => (
                  <tr key={c.person_id || c.person} className="border-t border-[#F0E4D6]">
                    <td className="py-2 pr-3 font-bold text-[#2D1B0E]">{c.person}</td>
                    <td className="py-2 pr-3 text-[#6B5744]">
                      {c.role}
                      {c.kind === 'assigned' ? ' · nothing yet' : ''}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.tables_visited}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.taken}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {c.share_pct === null ? '—' : `${c.share_pct}%`}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.issues_recorded}</td>
                    <td className="py-2 text-right tabular-nums">
                      {c.follow_ups_completed} done
                      {c.follow_ups_open > 0 ? ` · ${c.follow_ups_open} open` : ''}
                    </td>
                  </tr>
                ))}
                {totals ? (
                  <tr className="border-t-2 border-[#E8D5C4] bg-[#FFF8F0]">
                    <td className="py-2 pr-3 font-extrabold text-[#2D1B0E]">Floor total</td>
                    <td className="py-2 pr-3 text-[#6B5744]">eligible {totals.eligible}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-bold">{totals.taken}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-bold">{totals.taken}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-[#af4408]">
                      {pct(totals.taken, totals.eligible)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-[#6B5744]">
                      {totals.pending} pending
                    </td>
                    <td className="py-2 text-right tabular-nums text-[#6B5744]">
                      {coverage.reduce((n, c) => n + c.follow_ups_open, 0)} open
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableScroll>
          {coverage.length === 0 ? (
            <p className="mt-2 text-[11px] text-[#8B7355]">
              No one holds the “{GRE_ROLE_NAME}” role on this database and nobody has recorded
              feedback today, so there is nothing to show. Assign the role in Settings → Roles and
              every holder appears here — including the ones who have taken nothing.
            </p>
          ) : null}
          <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
            Activity only. No rating, complaint ratio or score appears per person — recording a
            complaint must never look bad for the recorder, so “Issues rec.” counts complaints
            PROPERLY RECORDED and more is better. Eligible / Pending / Coverage % sit on the floor
            total because no table is assigned to a person: a per-person coverage denominator would
            have to be invented.
          </p>
        </Card>

        {/* What is NOT on screen, and why. */}
        {meta ? (
          <div className="mt-4 space-y-1 text-[10px] leading-snug text-[#8B7355]">
            <p>
              Service {meta.business_date} (rolls over at {meta.board_cutoff} IST,{' '}
              {meta.board_cutoff_source === 'hr_day_cutoff' ? 'from hr_day_cutoff' : 'default'})
              {meta.business_date !== meta.today_business_date
                ? ` — today is ${meta.today_business_date}`
                : ''}
              . A table counts as eligible at {meta.item_threshold} item
              {meta.item_threshold === 1 ? '' : 's'}
              {meta.item_threshold_is_default ? ' (default)' : ''}
              {meta.item_threshold_clamped ? ' — a stored value below 1 was raised' : ''}, or as soon
              as the bill is requested or printed.
            </p>
            {meta.date_note ? <p className="text-amber-700">{meta.date_note}</p> : null}
            <p>{meta.counts_scope}</p>
            <p>
              Not counted here: {meta.excluded.not_yet_eligible} table
              {meta.excluded.not_yet_eligible === 1 ? '' : 's'} not yet eligible ·{' '}
              {meta.excluded.takeaway_or_other} takeaway/other ·{' '}
              {meta.excluded.table_row_missing} with no table row. {meta.section_filter}
            </p>
            {meta.cache_mismatch > 0 ? (
              <p className="inline-flex items-start gap-1 text-red-700 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5 mt-[1px] shrink-0" />
                {meta.cache_mismatch} visit{meta.cache_mismatch === 1 ? '' : 's'} carry counters that
                disagree with the rows they count. The numbers above are the COUNTED rows, not the
                cached counters — report this.
              </p>
            ) : null}
          </div>
        ) : null}
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">
              Coverage {totals ? pct(totals.taken, totals.eligible) : '—'}
            </div>
            <div className="text-[#8B7355] truncate">
              {counts.due ?? 0} still due · {counts.follow_up ?? 0} revisit owed
            </div>
          </div>
          <button
            type="button"
            onClick={() => router.push('/feedback')}
            className="shrink-0 bg-white border border-[#E8D5C4] text-[#6B5744] px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
          >
            Floor
          </button>
          {/* Analytics is management-only (catalog `mgmtOnly`, and
              `canOpenFeedbackAnalytics()` behind it), so a GRE tapping this
              would get a refusal card. The gate still decides; this only stops
              offering a door the viewer cannot open. */}
          {data && data.viewer.scope !== 'gre' ? (
            <button
              type="button"
              onClick={() => router.push('/feedback/analytics')}
              className="shrink-0 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
            >
              Analytics
            </button>
          ) : null}
        </div>
      </StickyBar>
    </>
  );
}
