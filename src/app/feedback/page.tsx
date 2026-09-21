'use client';

/**
 * Page 1 — FLOOR FEEDBACK  (route: /feedback)
 *
 * The GRE's board. Spec §3 Page 1: table cards carrying
 * `Table no · Pax · Captain · Items Ordered · Table Open time · status`, with
 * the five statuses `Not Ready · Feedback Due · Feedback Taken · Issue Raised ·
 * Follow-Up Required`.
 *
 * 🔒 THE READ-ONLY CONSTRAINT LIVES ON THE SERVER, NOT HERE. The owner's own
 * words: the GRE "cannot place orders · cancel items · change quantity · modify
 * KOT · modify bill · apply discounts", and "this must be enforced server-side,
 * not merely hidden in the UI." P0 Lane A measured exactly why that sentence
 * matters: `PATCH /api/dine-in/orders/[id]` authorises with nothing but
 * `if (!me) return 401`, so add_item / set_qty / remove_item / fire are reachable
 * by any signed-in session via curl. This page therefore renders no mutating
 * control of any kind — but that is a courtesy, not the control. P2 owns the
 * server-side deny and the `GET /api/feedback/*` reads that replace the
 * placeholder import below.
 *
 * 390px: one card per row. The Captain app's table tiles are 2–3 across
 * (captain/page.tsx:66) because they carry three fields; ours carry six, and a
 * ~180px column turns "Capt. Ramesh · Open 52m" into two truncated lines. One
 * column, one thumb, no horizontal scroll.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Utensils, Clock, ChevronRight, RefreshCw } from 'lucide-react';
import { STATUS_STYLE, TABLE_STATUSES, statusLabel, type TableStatus } from './enums';
import { FLOOR_TABLES, FLOORS, type FloorTable } from './placeholder';
import {
  Chip, EmptyState, PageBody, PageHead, PlaceholderNote, Scroller, Select,
  StickyBar, elapsed,
} from './ui';

/** "Not Ready" is the only status that is not a call to action, so its card is
 *  not tappable — there is nothing to record yet. */
const isActionable = (s: TableStatus) => s !== 'not_ready';

export default function FloorFeedbackPage() {
  const router = useRouter();

  const [status, setStatus] = useState<'all' | TableStatus>('all');
  const [floor, setFloor] = useState<string>('all');

  /**
   * `now` starts null and is filled after mount. Elapsed times are derived from
   * `Date.now()`, which differs between the server render and the client one —
   * rendering them before mount is a guaranteed hydration mismatch. Null means
   * "not mounted yet", and every time display below checks it.
   */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // P2: replace with `api('/api/feedback/floor')` on a 10s interval — the
  // cadence the Captain board uses for the same data (captain/page.tsx:32).
  const tables: FloorTable[] = FLOOR_TABLES;

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tables.length };
    for (const s of TABLE_STATUSES) c[s.v] = 0;
    for (const t of tables) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [tables]);

  const visible = useMemo(
    () =>
      tables
        .filter((t) => (status === 'all' ? true : t.status === status))
        .filter((t) => (floor === 'all' ? true : t.floor === floor))
        // Oldest table first: the one that has been open longest is the one
        // most at risk of settling before anybody visits it.
        .sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at)),
    [tables, status, floor],
  );

  const floorOptions = useMemo(
    () => [{ v: 'all', label: 'All floors' }, ...FLOORS.map((f) => ({ v: f, label: f }))],
    [],
  );

  return (
    <>
      <PageHead
        title="Floor Feedback"
        subtitle={
          <>
            {counts.due || 0} due · {counts.issue || 0} issues · {counts.follow_up || 0} follow-up
          </>
        }
        right={
          <button
            type="button"
            onClick={() => setNow(Date.now())}
            aria-label="Refresh"
            className="w-11 h-11 rounded-xl bg-white border border-[#E8D5C4] text-[#6B5744] flex items-center justify-center active:scale-95 transition"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
      />

      <PageBody>
        {/* Filters. Status scrolls; floor is a native select so the phone gives
            the OS picker instead of a row that grows with every new floor. */}
        <div className="pt-3 space-y-2">
          <Scroller label="Filter by status">
            <Chip active={status === 'all'} onClick={() => setStatus('all')}>
              All · {counts.all}
            </Chip>
            {TABLE_STATUSES.map((s) => (
              <Chip key={s.v} active={status === s.v} onClick={() => setStatus(s.v)}>
                {s.label} · {counts[s.v] || 0}
              </Chip>
            ))}
          </Scroller>
          <Scroller label="Filter by floor">
            <Select label="Floor" value={floor} onChange={setFloor} options={floorOptions} />
          </Scroller>
        </div>

        {/* The board */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((t) => {
            const live = isActionable(t.status);
            return (
              <button
                key={t.order_id}
                type="button"
                disabled={!live}
                onClick={() => router.push(`/feedback/take/${t.order_id}`)}
                className={`text-left bg-white border rounded-2xl p-4 transition ${
                  live
                    ? 'border-[#E8D5C4] active:scale-[0.98] hover:border-[#D4B896]'
                    : 'border-[#F0E4D6] opacity-70 cursor-default'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-extrabold leading-tight text-[#2D1B0E]">
                      Table {t.table_number}
                    </div>
                    <div className="text-[11px] text-[#8B7355] leading-tight">{t.floor}</div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLE[t.status]}`}
                  >
                    {statusLabel(t.status)}
                  </span>
                </div>

                {/* The four facts, in the owner's order. Wraps rather than
                    truncates — at 390px this is one full-width line. */}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[#6B5744]">
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Users className="w-3.5 h-3.5 text-[#8B7355]" />
                    {t.covers ?? '—'} pax
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Utensils className="w-3.5 h-3.5 text-[#8B7355]" />
                    {t.item_count} items
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Clock className="w-3.5 h-3.5 text-[#8B7355]" />
                    {now === null ? '···' : elapsed(t.opened_at, now)}
                  </span>
                </div>

                <div className="mt-2 flex items-center gap-2 text-[12px]">
                  <span className="text-[#8B7355] truncate">
                    Capt. {t.server_name || '—'}
                    {t.gre_name ? ` · GRE ${t.gre_name}` : ''}
                  </span>
                  {live ? (
                    <span className="ml-auto inline-flex items-center gap-0.5 font-bold text-[#af4408] shrink-0">
                      {t.status === 'due' ? 'Take feedback' : 'Open'}
                      <ChevronRight className="w-4 h-4" />
                    </span>
                  ) : (
                    <span className="ml-auto text-[11px] text-[#8B7355] shrink-0">
                      waiting for items
                    </span>
                  )}
                </div>

                {/* The eligibility evidence, shown because the GRE is judged on
                    coverage and deserves to see WHY a table became due.
                    Columns are real: orders.bill_requested_at / bill_printed_at
                    (BUILD-STATE §2). */}
                {(t.bill_requested_at || t.bill_printed_at) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.bill_requested_at && (
                      <span className="rounded-full bg-[#FFF1E3] border border-[#E8D5C4] px-2 py-0.5 text-[10px] font-semibold text-[#6B5744]">
                        Bill requested
                      </span>
                    )}
                    {t.bill_printed_at && (
                      <span className="rounded-full bg-[#FFF1E3] border border-[#E8D5C4] px-2 py-0.5 text-[10px] font-semibold text-[#6B5744]">
                        Bill printed
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {visible.length === 0 && (
          <EmptyState>No tables match this filter.</EmptyState>
        )}

        <PlaceholderNote>
          Rows come from <code>./placeholder.ts</code>. P2 replaces them with a read-only
          <code> GET /api/feedback/floor</code> over <code>orders</code> +{' '}
          <code>restaurant_tables</code>, and adds the server-side deny that actually enforces the
          owner&rsquo;s read-only rule.
        </PlaceholderNote>
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">
              {visible.length} table{visible.length === 1 ? '' : 's'} shown
            </div>
            <div className="text-[#8B7355] truncate">
              {counts.due || 0} awaiting a visit · {counts.follow_up || 0} need a revisit
            </div>
          </div>
          <button
            type="button"
            onClick={() => router.push('/feedback/tracker')}
            className="shrink-0 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
          >
            Tracker
          </button>
        </div>
      </StickyBar>
    </>
  );
}
