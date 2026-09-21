'use client';

/**
 * Page 3 — FEEDBACK TRACKER  (route: /feedback/tracker)
 *
 * Spec §3 Page 3: header counts (Active Tables · Feedback Due · Feedback Taken ·
 * Issues Raised · Follow-Up Required), one record per table, the six-way filter
 * plus Floor / GRE / Manager / Captain, and the GRE/Manager progress table
 * (Eligible Tables · Feedback Taken · Pending · Coverage %).
 *
 * 🔒 THE FAIRNESS RULING SHAPES THIS PAGE, in the owner's words: "The system
 * should not judge GRE performance based on positive feedback. A GRE should
 * never avoid recording negative feedback because it affects their performance."
 * So the progress table counts ACTIVITY only — eligible, taken, pending,
 * coverage %, follow-ups completed. There is deliberately no average rating, no
 * complaint count and no score per person: a GRE who records ten complaints and
 * one who records none must look identical here. Any column added later that
 * makes recording a complaint look bad for the recorder is a defect, not a
 * feature.
 *
 * Records are cards, not table rows: at 390px a six-column row is either
 * unreadable or forces the page to scroll sideways. The one genuine table on
 * this page — coverage — is wrapped in `TableScroll` and scrolls inside itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Users, ChevronRight, MessageSquare } from 'lucide-react';
import {
  OVERALL_RATINGS, STATUS_STYLE, TRACKER_FILTERS, isNegative, statusLabel,
} from '@/lib/feedback';
import {
  CAPTAIN_NAMES, COVERAGE_ROWS, FLOORS, GRE_NAMES, TRACKER_RECORDS, type TrackerRecord,
} from '../placeholder';
import {
  Card, Chip, EmptyState, PageBody, PageHead, PlaceholderNote, Scroller, Select,
  SectionTitle, StickyBar, TableScroll, Tile, elapsed, pct,
} from '../ui';

type FilterKey = (typeof TRACKER_FILTERS)[number]['v'];

/**
 * One filter, one predicate, in one place — so "Completed" cannot mean
 * something different in the chip count than it does in the list.
 *   pending   → no feedback recorded yet (due OR not_ready)
 *   completed → feedback recorded and nothing left open
 *   negative  → overall rating is Average or Poor (enums.isNegative)
 *   follow_up → a revisit is owed
 *   resolved  → an issue was raised and is now closed
 */
function matches(r: TrackerRecord, f: FilterKey): boolean {
  switch (f) {
    case 'all': return true;
    case 'pending': return r.taken_at === null;
    case 'completed': return r.taken_at !== null && r.open_follow_ups === 0;
    case 'negative': return isNegative(r.overall || '');
    case 'follow_up': return r.open_follow_ups > 0;
    case 'resolved': return r.issues > 0 && r.open_follow_ups === 0;
    default: return true;
  }
}

export default function FeedbackTrackerPage() {
  const router = useRouter();

  const [filter, setFilter] = useState<FilterKey>('all');
  const [floor, setFloor] = useState('all');
  const [gre, setGre] = useState('all');
  const [captain, setCaptain] = useState('all');

  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // P4: `api('/api/feedback/tracker?…')` with these four filters as query
  // parameters, so the counts are computed over the whole day server-side and
  // not over whatever happens to be on this page.
  const records: TrackerRecord[] = TRACKER_RECORDS;

  const scoped = useMemo(
    () =>
      records
        .filter((r) => (floor === 'all' ? true : r.floor === floor))
        .filter((r) => (gre === 'all' ? true : r.gre_name === gre))
        .filter((r) => (captain === 'all' ? true : r.captain_name === captain)),
    [records, floor, gre, captain],
  );

  const counts = useMemo(
    () => ({
      active: scoped.length,
      due: scoped.filter((r) => r.status === 'due').length,
      taken: scoped.filter((r) => r.taken_at !== null).length,
      issues: scoped.filter((r) => r.issues > 0).length,
      follow_up: scoped.filter((r) => r.open_follow_ups > 0).length,
    }),
    [scoped],
  );

  const visible = useMemo(() => scoped.filter((r) => matches(r, filter)), [scoped, filter]);

  const opts = (label: string, values: string[]) => [
    { v: 'all', label },
    ...values.map((x) => ({ v: x, label: x })),
  ];

  return (
    <>
      <PageHead
        title="Feedback Tracker"
        subtitle={`${counts.taken} of ${counts.active} active tables covered`}
      />

      <PageBody>
        {/* Header counts — five tiles, two per row at 390px. */}
        <div className="pt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <Tile label="Active Tables" value={counts.active} />
          <Tile label="Feedback Due" value={counts.due} tone={counts.due ? 'warn' : 'plain'} />
          <Tile label="Feedback Taken" value={counts.taken} tone="good" />
          <Tile label="Issues Raised" value={counts.issues} tone={counts.issues ? 'bad' : 'plain'} />
          <Tile
            label="Follow-Up Required"
            value={counts.follow_up}
            tone={counts.follow_up ? 'warn' : 'plain'}
          />
        </div>

        {/* Filters */}
        <div className="mt-4 space-y-2">
          <Scroller label="Filter records">
            {TRACKER_FILTERS.map((f) => (
              <Chip key={f.v} active={filter === f.v} onClick={() => setFilter(f.v)}>
                {f.label}
              </Chip>
            ))}
          </Scroller>
          <Scroller label="Scope">
            <Select label="Floor" value={floor} onChange={setFloor} options={opts('All floors', FLOORS)} />
            <Select label="GRE" value={gre} onChange={setGre} options={opts('All', GRE_NAMES)} />
            <Select
              label="Captain"
              value={captain}
              onChange={setCaptain}
              options={opts('All', CAPTAIN_NAMES)}
            />
          </Scroller>
        </div>

        {/* Records */}
        <SectionTitle hint={`${visible.length} shown`}>Records</SectionTitle>
        <div className="space-y-2">
          {visible.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-base font-extrabold leading-tight text-[#2D1B0E]">
                    Table {r.table_number}
                  </div>
                  <div className="text-[11px] text-[#8B7355] leading-tight">{r.floor}</div>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLE[r.status]}`}
                >
                  {statusLabel(r.status)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#6B5744]">
                {r.overall && (
                  <span
                    className={`font-extrabold ${isNegative(r.overall) ? 'text-red-700' : 'text-emerald-700'}`}
                  >
                    {OVERALL_RATINGS.find((o) => o.v === r.overall)?.label}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-[#8B7355]" />
                  {r.gre_name ? `GRE ${r.gre_name}` : 'Not visited'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5 text-[#8B7355]" />
                  {r.taken_at ? (now === null ? '···' : `${elapsed(r.taken_at, now)} ago`) : 'pending'}
                </span>
                {r.issues > 0 && (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                    <MessageSquare className="w-3.5 h-3.5" />
                    {r.issues} issue{r.issues === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {r.note && (
                <div className="mt-2 rounded-lg bg-[#FFF1E3] px-2.5 py-1.5 text-[11px] text-[#6B5744]">
                  {r.note}
                </div>
              )}

              <div className="mt-2 flex items-center gap-2 text-[11px] text-[#8B7355]">
                <span className="truncate">Capt. {r.captain_name || '—'}</span>
                {r.open_follow_ups > 0 && (
                  <span className="ml-auto inline-flex items-center gap-0.5 font-bold text-violet-700 shrink-0">
                    {r.open_follow_ups} revisit owed
                    <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>

        {visible.length === 0 && <EmptyState>No records match this filter.</EmptyState>}

        {/* GRE / Manager progress — activity only, per the fairness ruling. */}
        <SectionTitle hint="coverage only — never rating">GRE / Manager progress</SectionTitle>
        <Card className="p-3">
          <TableScroll>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[#8B7355]">
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Person</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Role</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Eligible</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Taken</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Pending</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Coverage</th>
                  <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Follow-ups</th>
                </tr>
              </thead>
              <tbody>
                {COVERAGE_ROWS.map((c) => (
                  <tr key={c.person} className="border-t border-[#F0E4D6]">
                    <td className="py-2 pr-3 font-bold text-[#2D1B0E]">{c.person}</td>
                    <td className="py-2 pr-3 text-[#6B5744]">{c.role}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.eligible}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.taken}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{c.eligible - c.taken}</td>
                    <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-[#af4408]">
                      {pct(c.taken, c.eligible)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.follow_ups_done} done
                      {c.follow_ups_open > 0 ? ` · ${c.follow_ups_open} open` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
            Activity only. No rating, complaint count or score appears per person — recording a
            complaint must never look bad for the recorder.
          </p>
        </Card>

        <PlaceholderNote>
          Records and coverage come from <code>../placeholder.ts</code>. P4 replaces them with{' '}
          <code>GET /api/feedback/tracker</code>, computing the five header counts and coverage over
          the whole service day rather than the rows on screen.
        </PlaceholderNote>
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">
              Coverage {pct(counts.taken, counts.active)}
            </div>
            <div className="text-[#8B7355] truncate">
              {counts.due} still due · {counts.follow_up} revisit owed
            </div>
          </div>
          <button
            type="button"
            onClick={() => router.push('/feedback')}
            className="shrink-0 bg-white border border-[#E8D5C4] text-[#6B5744] px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
          >
            Floor
          </button>
          <button
            type="button"
            onClick={() => router.push('/feedback/analytics')}
            className="shrink-0 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
          >
            Analytics
          </button>
        </div>
      </StickyBar>
    </>
  );
}
