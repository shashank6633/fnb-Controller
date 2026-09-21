'use client';

/**
 * Page 4 — ADMIN ANALYTICS & REPORTS  (route: /feedback/analytics)
 *
 * Spec §3 Page 4. The reports live HERE, not on a fifth page: dashboard counts,
 * the date + scope filters, Menu Item Analysis, Most Common Problems / Most
 * Complained / Most Appreciated, Service Recovery Analysis, and the eight
 * Excel/PDF downloads.
 *
 * TWO RATES THE OWNER NAMED, AND THEIR DENOMINATORS — "total complaints alone
 * can be misleading":
 *   · Negative Feedback %  = negative feedbacks ÷ feedbacks RECEIVED for that
 *     item. A quality measure. Using quantity sold instead would punish a
 *     popular dish for being ordered often and would silently reward an item
 *     nobody bothers to comment on.
 *   · Return / Remake Rate = (returned + remade) ÷ quantity SOLD. An operations
 *     measure: what share of plates that left the kitchen came back. Sold is
 *     the right denominator here because the question is about the kitchen's
 *     output, not about how many guests were asked.
 * Both are computed in `rates()` below so the two pages that show them cannot
 * diverge. P0 Lane B flagged the choice as worth confirming with the owner; the
 * reasoning is written down here so that conversation starts from a position.
 *
 * 🔒 THE FAIRNESS RULING. Nothing on this page ranks a GRE by what the guests
 * said. GRE/Manager Performance is a coverage report — tables visited,
 * follow-ups completed, issues properly recorded — and the note at the foot of
 * the page says so on screen, where whoever reads the dashboard will see it.
 *
 * 390px: every table goes through `TableScroll`, so the page body itself never
 * scrolls sideways. Tiles are two per row.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  Download, FileSpreadsheet, FileText, Search, TrendingDown, ThumbsUp, RotateCcw, Smile, Frown,
} from 'lucide-react';
import {
  DATE_RANGES, ITEM_GROUPS, REPORTS, type ItemGroup,
} from '../enums';
import {
  ANALYTICS_SUMMARY, CAPTAIN_NAMES, COMMON_PROBLEMS, COVERAGE_ROWS, FLOORS, GRE_NAMES,
  MENU_ITEM_ROWS, MOST_APPRECIATED, RECOVERY_ROWS, type MenuItemRow,
} from '../placeholder';
import {
  Card, Chip, EmptyState, PageBody, PageHead, PlaceholderNote, Scroller, SectionTitle, Select,
  StickyBar, TableScroll, Tile, pct,
} from '../ui';

/** The two rates, computed once. See the header comment for the denominators. */
function rates(r: MenuItemRow) {
  return {
    negativePct: pct(r.negative, r.feedbacks),
    returnRemakePct: pct(r.returned + r.remade, r.sold),
  };
}

export default function FeedbackAnalyticsPage() {
  const [range, setRange] = useState<string>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [floor, setFloor] = useState('all');
  const [gre, setGre] = useState('all');
  const [captain, setCaptain] = useState('all');
  const [group, setGroup] = useState<'all' | ItemGroup>('all');
  const [q, setQ] = useState('');
  const [openItem, setOpenItem] = useState<MenuItemRow | null>(null);

  const s = ANALYTICS_SUMMARY;

  const menuRows = useMemo(
    () =>
      MENU_ITEM_ROWS.filter((r) => (group === 'all' ? true : r.group === group))
        .filter((r) => (q.trim() ? r.menu_item.toLowerCase().includes(q.trim().toLowerCase()) : true))
        // Worst first — the point of the table is to find the problem dish.
        .sort((a, b) => b.negative / (b.feedbacks || 1) - a.negative / (a.feedbacks || 1)),
    [group, q],
  );

  /** Most Complained Items is the same data ordered by absolute count — kept
   *  beside Negative % deliberately, because the owner's warning cuts both
   *  ways: a rate alone hides a high-volume item with many complaints. */
  const mostComplained = useMemo(
    () => [...MENU_ITEM_ROWS].sort((a, b) => b.negative - a.negative).slice(0, 5),
    [],
  );

  const ratingTotal = s.excellent + s.good + s.average + s.poor;

  const opts = (label: string, values: string[]) => [
    { v: 'all', label },
    ...values.map((x) => ({ v: x, label: x })),
  ];

  return (
    <>
      <PageHead
        title="Feedback Analytics"
        subtitle={`${s.feedback_taken} of ${s.eligible_tables} eligible tables · coverage ${pct(s.feedback_taken, s.eligible_tables)}`}
      />

      <PageBody>
        {/* ── Filters ──────────────────────────────────────────────────── */}
        <div className="pt-3 space-y-2">
          <Scroller label="Date range">
            {DATE_RANGES.map((d) => (
              <Chip key={d.v} active={range === d.v} onClick={() => setRange(d.v)}>
                {d.label}
              </Chip>
            ))}
          </Scroller>

          {range === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 bg-white border border-[#E8D5C4] rounded-full px-3 py-1.5">
                <span className="text-[11px] font-semibold text-[#8B7355]">From</span>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="bg-transparent text-[12px] font-semibold text-[#2D1B0E] outline-none"
                />
              </label>
              <label className="flex items-center gap-1.5 bg-white border border-[#E8D5C4] rounded-full px-3 py-1.5">
                <span className="text-[11px] font-semibold text-[#8B7355]">To</span>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="bg-transparent text-[12px] font-semibold text-[#2D1B0E] outline-none"
                />
              </label>
            </div>
          )}

          <Scroller label="Scope">
            <Select label="Floor" value={floor} onChange={setFloor} options={opts('All floors', FLOORS)} />
            <Select label="GRE" value={gre} onChange={setGre} options={opts('All', GRE_NAMES)} />
            <Select label="Captain" value={captain} onChange={setCaptain} options={opts('All', CAPTAIN_NAMES)} />
            <Select
              label="Group"
              value={group}
              onChange={(v) => setGroup(v as 'all' | ItemGroup)}
              options={[{ v: 'all', label: 'Food & Drinks' }, ...ITEM_GROUPS]}
            />
          </Scroller>

          <label className="flex items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl px-3 py-2.5">
            <Search className="w-4 h-4 text-[#8B7355] shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Menu item"
              aria-label="Filter by menu item"
              className="flex-1 min-w-0 bg-transparent text-sm text-[#2D1B0E] outline-none"
            />
          </label>
        </div>

        {/* ── Dashboard tiles ──────────────────────────────────────────── */}
        <SectionTitle>Dashboard</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <Tile
            label="Coverage"
            value={pct(s.feedback_taken, s.eligible_tables)}
            hint={`${s.feedback_taken} of ${s.eligible_tables} eligible`}
            tone="accent"
          />
          <Tile label="Negative item feedbacks" value={s.negative_item_feedbacks} tone="bad" />
          <Tile
            label="Returned / Remade / Replaced"
            value={s.returned + s.remade + s.replaced}
            hint={`${s.returned} returned · ${s.remade} remade · ${s.replaced} replaced`}
            tone="warn"
          />
          <Tile label="Happy after replacement" value={s.happy_after_replacement} tone="good" />
          <Tile label="Still unhappy" value={s.still_unhappy} tone="bad" />
          <Tile
            label="Pending follow-ups"
            value={s.pending_follow_ups}
            tone={s.pending_follow_ups ? 'warn' : 'plain'}
          />
          <Tile label="Feedback taken" value={s.feedback_taken} />
          <Tile label="Eligible tables" value={s.eligible_tables} />
        </div>

        {/* ── Rating split ─────────────────────────────────────────────── */}
        <SectionTitle hint={`${ratingTotal} rated`}>Overall rating split</SectionTitle>
        <Card className="p-3">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-[#F0E4D6]">
            <span className="bg-emerald-600" style={{ width: `${(s.excellent / ratingTotal) * 100}%` }} />
            <span className="bg-emerald-400" style={{ width: `${(s.good / ratingTotal) * 100}%` }} />
            <span className="bg-amber-400" style={{ width: `${(s.average / ratingTotal) * 100}%` }} />
            <span className="bg-red-500" style={{ width: `${(s.poor / ratingTotal) * 100}%` }} />
          </div>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
            {[
              { label: 'Excellent', n: s.excellent, dot: 'bg-emerald-600' },
              { label: 'Good', n: s.good, dot: 'bg-emerald-400' },
              { label: 'Average', n: s.average, dot: 'bg-amber-400' },
              { label: 'Poor', n: s.poor, dot: 'bg-red-500' },
            ].map((x) => (
              <div key={x.label} className="flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-full ${x.dot}`} />
                <span className="font-semibold text-[#6B5744]">{x.label}</span>
                <span className="ml-auto font-extrabold tabular-nums text-[#2D1B0E]">
                  {x.n} · {pct(x.n, ratingTotal)}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Menu Item Analysis ───────────────────────────────────────── */}
        <SectionTitle hint="tap a row for the comments">Menu item analysis</SectionTitle>
        {menuRows.length === 0 ? (
          <EmptyState>No menu item matches that filter.</EmptyState>
        ) : (
          <Card className="p-3">
            <TableScroll>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[#8B7355]">
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Item</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Sold</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Feedbacks</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Negative</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Neg %</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Ret / Rem</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">R/R %</th>
                    <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Happy</th>
                  </tr>
                </thead>
                <tbody>
                  {menuRows.map((r) => {
                    const k = rates(r);
                    return (
                      <tr
                        key={r.menu_item}
                        onClick={() => setOpenItem(r)}
                        className="border-t border-[#F0E4D6] cursor-pointer hover:bg-[#FFF8F0]"
                      >
                        <td className="py-2 pr-3 font-bold text-[#2D1B0E]">
                          {r.menu_item}
                          <span className="ml-1.5 text-[10px] font-semibold text-[#8B7355]">
                            {r.group === 'food' ? 'Food' : 'Drinks'}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.sold}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.feedbacks}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{r.negative}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-red-700">
                          {k.negativePct}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.returned} / {r.remade}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-amber-700">
                          {k.returnRemakePct}
                        </td>
                        <td className="py-2 text-right tabular-nums text-emerald-700 font-semibold">
                          {r.happy_after}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
            <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
              Neg % = negative ÷ feedbacks received for that item (a quality measure). R/R % =
              (returned + remade) ÷ quantity sold (an operations measure). Two different
              denominators, on purpose.
            </p>
          </Card>
        )}

        {/* ── Lists ────────────────────────────────────────────────────── */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
          <RankList
            title="Most common problems"
            icon={<TrendingDown className="w-4 h-4 text-red-600" />}
            rows={COMMON_PROBLEMS}
            tone="bad"
          />
          <RankList
            title="Most complained items"
            icon={<Frown className="w-4 h-4 text-amber-600" />}
            rows={mostComplained.map((m) => ({ label: m.menu_item, count: m.negative }))}
            tone="warn"
          />
          <RankList
            title="Most appreciated items"
            icon={<ThumbsUp className="w-4 h-4 text-emerald-600" />}
            rows={MOST_APPRECIATED}
            tone="good"
          />
        </div>

        {/* ── Service recovery ─────────────────────────────────────────── */}
        <SectionTitle hint="what happened after a negative feedback">Service recovery</SectionTitle>
        <Card className="p-3">
          <div className="space-y-1.5">
            {RECOVERY_ROWS.map((r) => {
              const total = RECOVERY_ROWS.reduce((a, b) => a + b.count, 0);
              return (
                <div key={r.label} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-[12px] font-semibold text-[#6B5744] truncate">
                    {r.label}
                  </span>
                  <span className="flex-1 h-2.5 rounded-full bg-[#F0E4D6] overflow-hidden">
                    <span
                      className="block h-full bg-[#af4408]"
                      style={{ width: `${(r.count / total) * 100}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right text-[12px] font-extrabold tabular-nums text-[#2D1B0E]">
                    {r.count}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-800">
                <Smile className="w-3.5 h-3.5" /> Guest happy after
              </div>
              <div className="text-xl font-extrabold text-emerald-700">
                {s.happy_after_replacement}
              </div>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-red-800">
                <Frown className="w-3.5 h-3.5" /> Still unhappy
              </div>
              <div className="text-xl font-extrabold text-red-700">{s.still_unhappy}</div>
            </div>
          </div>
        </Card>

        {/* ── Downloads ────────────────────────────────────────────────── */}
        <SectionTitle hint="Excel · PDF">Downloads</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {REPORTS.map((r) => (
            <div
              key={r.v}
              className="flex items-center gap-2 bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5"
            >
              <Download className="w-4 h-4 text-[#8B7355] shrink-0" />
              <span className="min-w-0 flex-1 text-sm font-bold text-[#2D1B0E] truncate">
                {r.label}
              </span>
              <button
                type="button"
                disabled
                title="P5 wires the export"
                className="inline-flex items-center gap-1 rounded-lg border border-[#E8D5C4] px-2.5 py-2 text-[11px] font-bold text-[#6B5744] disabled:opacity-40"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
              </button>
              <button
                type="button"
                disabled
                title="P5 wires the export"
                className="inline-flex items-center gap-1 rounded-lg border border-[#E8D5C4] px-2.5 py-2 text-[11px] font-bold text-[#6B5744] disabled:opacity-40"
              >
                <FileText className="w-3.5 h-3.5" /> PDF
              </button>
            </div>
          ))}
        </div>

        {/* ── The fairness ruling, on screen ───────────────────────────── */}
        <Card className="mt-4 p-3 border-[#D4B896] bg-[#FFF1E3]">
          <div className="text-[12px] font-extrabold text-[#af4408] mb-1">
            How GRE performance is measured
          </div>
          <p className="text-[11px] leading-snug text-[#6B5744]">
            Coverage, tables visited, follow-ups completed, issues properly recorded and guest
            recovery follow-up — never the ratings the guests gave. A GRE must never have a reason to
            avoid recording a complaint. The GRE / Manager Performance download below follows the
            same rule.
          </p>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {COVERAGE_ROWS.map((c) => (
              <div key={c.person} className="rounded-xl bg-white border border-[#E8D5C4] px-2.5 py-2">
                <div className="text-[11px] font-bold text-[#2D1B0E] truncate">{c.person}</div>
                <div className="text-lg font-extrabold text-[#af4408] leading-tight">
                  {pct(c.taken, c.eligible)}
                </div>
                <div className="text-[10px] text-[#8B7355]">
                  {c.taken}/{c.eligible} · {c.follow_ups_done} follow-ups
                </div>
              </div>
            ))}
          </div>
        </Card>

        <PlaceholderNote>
          Every number here is invented in <code>../placeholder.ts</code>. P5 computes them over the{' '}
          <code>gf_</code> tables joined to <code>order_items</code>, and wires the eight downloads
          through <code>buildReportPdf()</code> (<code>src/lib/report-pdf.ts</code> — money renders as
          &ldquo;Rs&rdquo;, not ₹) and <code>xlsx</code>. Report paths must never contain{' '}
          <code>print</code> or end <code>.json</code>.
        </PlaceholderNote>
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">
              {DATE_RANGES.find((d) => d.v === range)?.label} · coverage{' '}
              {pct(s.feedback_taken, s.eligible_tables)}
            </div>
            <div className="text-[#8B7355] truncate">
              {s.negative_item_feedbacks} negative · {s.pending_follow_ups} follow-up open
            </div>
          </div>
          <button
            type="button"
            disabled
            title="P5 wires the export"
            className="shrink-0 inline-flex items-center gap-1.5 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </StickyBar>

      {/* Click-through to the real comments (§3: "clickable through to the real
          comments"). P5 fills it from gf_item_feedback. */}
      {openItem && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpenItem(null)} aria-hidden="true" />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-[#2D1B0E] truncate">
                  {openItem.menu_item}
                </div>
                <div className="text-[11px] text-[#8B7355]">
                  {openItem.sold} sold · {openItem.feedbacks} feedbacks · {openItem.negative}{' '}
                  negative ({rates(openItem).negativePct})
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpenItem(null)}
                className="px-3 py-2 rounded-xl border border-[#E8D5C4] text-[#6B5744] text-sm font-semibold active:scale-95"
              >
                Close
              </button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-[#FFF1E3] px-2 py-2">
                <div className="text-[10px] font-bold text-[#8B7355]">Returned</div>
                <div className="text-lg font-extrabold text-[#2D1B0E]">{openItem.returned}</div>
              </div>
              <div className="rounded-xl bg-[#FFF1E3] px-2 py-2">
                <div className="text-[10px] font-bold text-[#8B7355]">Remade</div>
                <div className="text-lg font-extrabold text-[#2D1B0E]">{openItem.remade}</div>
              </div>
              <div className="rounded-xl bg-[#FFF1E3] px-2 py-2">
                <div className="text-[10px] font-bold text-[#8B7355]">Happy after</div>
                <div className="text-lg font-extrabold text-emerald-700">{openItem.happy_after}</div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-wide text-[#8B7355]">
              <RotateCcw className="w-3.5 h-3.5" /> Guest comments
            </div>
            <div className="mt-2 rounded-xl border border-dashed border-[#D4B896] bg-[#FFF8F0] px-3 py-6 text-center text-[12px] text-[#8B7355]">
              P5 lists the real comments here, from <code>gf_item_feedback</code>.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── a small ranked list ─────────────────────────────────────────────────── */

function RankList({
  title,
  icon,
  rows,
  tone,
}: {
  title: string;
  icon: ReactNode;
  rows: readonly { label: string; count: number }[];
  tone: 'good' | 'warn' | 'bad';
}) {
  const max = rows.reduce((a, b) => Math.max(a, b.count), 0) || 1;
  const bar = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500' }[tone];
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <span className="text-[12px] font-extrabold uppercase tracking-wide text-[#8B7355]">
          {title}
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-[12px] font-semibold text-[#2D1B0E] truncate">
              {r.label}
            </span>
            <span className="flex-1 h-2 rounded-full bg-[#F0E4D6] overflow-hidden">
              <span className={`block h-full ${bar}`} style={{ width: `${(r.count / max) * 100}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right text-[12px] font-extrabold tabular-nums text-[#6B5744]">
              {r.count}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
