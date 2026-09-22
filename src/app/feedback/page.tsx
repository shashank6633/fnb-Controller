'use client';

/**
 * Page 1 — FLOOR FEEDBACK  (route: /feedback)   ·  P2 Lane A, now LIVE
 *
 * The GRE's board. Spec §3 Page 1: table cards carrying
 * `Table no · Pax · Captain · Items Ordered · Table Open time · status`, with
 * the five statuses `Not Ready · Feedback Due · Feedback Taken · Issue Raised ·
 * Follow-Up Required`.
 *
 * ── WHAT CHANGED FROM THE P1 SHELL ──────────────────────────────────────────
 * Rows now come from `GET /api/feedback/floor` over the real columns
 * (`orders.bill_requested_at`, `orders.bill_printed_at`, `COUNT(order_items)`,
 * `orders.covers`, `orders.server_name`, `orders.created_at`,
 * `restaurant_tables.zone`), and the fixtures in `./placeholder.ts` are no
 * longer imported here. That file stays put — Pages 2-4 are other lanes and
 * still render from it.
 *
 * ── 🔒 READ-ONLY, AND WHERE THAT IS ACTUALLY ENFORCED ───────────────────────
 * This page renders no mutating control of any kind, but that is a COURTESY,
 * not the control. The control is that the whole Page-1 surface is two route
 * files exporting `GET` and nothing else, over a `SELECT`-only library — so
 * there is no write path in this module to reach an order, an order item, a KOT
 * or a bill. The separate, larger problem — that the EXISTING POS routes still
 * authorise with `if (!me) return 401` — is a diff for the owner, not something
 * this lane applies to shipped code captains depend on.
 *
 * ── SORT ORDER IS THE SERVER'S, ON PURPOSE ──────────────────────────────────
 * The lane's requirement is that a GRE sees instantly which tables still need
 * visiting, so the board is deliberately NOT chronological: `Follow-Up` first
 * (a guest is already unhappy and waiting on a remake), then `Feedback Due`,
 * and inside each group the tables whose guests are ABOUT TO LEAVE (bill
 * requested or printed) before the rest, then oldest-open first. That ranking
 * lives in `listFloorTables()` so Pages 3 and 4 can reuse it. This component
 * FILTERS the list; it never re-sorts it.
 *
 * ── 390px ───────────────────────────────────────────────────────────────────
 * One card per row. The Captain app's tiles are 2-3 across because they carry
 * three fields; ours carry six, and a ~180px column turns "Capt. Ramesh ·
 * Open 52m" into two truncated lines. One column, one thumb, nothing that
 * scrolls sideways.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Utensils, Clock, ChevronRight, ChevronDown, RefreshCw, Lock, AlertTriangle, Wine,
} from 'lucide-react';
import { api } from '@/lib/api';
import { GRE_ROLE_NAME, STATUS_STYLE, TABLE_STATUSES, statusLabel, type TableStatus } from '@/lib/feedback';
import type { FeedbackOrderView, FloorMeta, FloorRow } from '@/lib/feedback/read';
import {
  Chip, EmptyState, PageBody, PageHead, Scroller, Select, StickyBar, elapsed,
} from './ui';

/** "Not Ready" is the only status that is not a call to action, so its card
 *  offers no Take-feedback action — there is nothing to record yet. */
const isActionable = (s: TableStatus) => s !== 'not_ready';

interface FloorPayload {
  tables: FloorRow[];
  meta: FloorMeta;
  viewer: { name: string; role_name: string | null; read_only: boolean; scope: string };
}

/** The shape `requireFeedbackReader()` refuses with. `what_to_do` is printed
 *  verbatim: the role trap (role created but never ASSIGNED) looks exactly like
 *  a broken page unless the screen says which step is missing. */
interface Denial {
  error: string;
  reason: string;
  your_role?: string | null;
  what_to_do?: string;
}

export default function FloorFeedbackPage() {
  const router = useRouter();

  const [status, setStatus] = useState<'all' | TableStatus>('all');
  const [floor, setFloor] = useState<string>('all');

  const [data, setData] = useState<FloorPayload | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /** Lazily-fetched ordered items, keyed by order id. `null` = in flight. */
  const [items, setItems] = useState<Record<string, FeedbackOrderView | null>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  /**
   * `now` starts null and is filled after mount. Elapsed times derive from
   * `Date.now()`, which differs between the server render and the client one —
   * rendering them before mount is a guaranteed hydration mismatch.
   *
   * The stamps themselves are safe to parse: the API emits ISO-8601 UTC. The
   * raw column is `2026-08-11 19:05:14` (SQLite `datetime('now')`, UTC, space
   * separated, no zone) and V8 reads that space form as LOCAL time — a table
   * open ten minutes would have rendered "5h 40m". `sqlUtcToIso()` repairs it
   * server-side, so nothing here has to know.
   */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const res = await api('/api/feedback/floor');
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
      const body = (await res.json()) as FloorPayload;
      setDenial(null);
      setError(null);
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);

  // 10s — the cadence the Captain board already uses for the same data.
  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
  }, [load]);

  const toggleItems = useCallback(async (orderId: string, itemCount: number) => {
    setOpen((o) => ({ ...o, [orderId]: !o[orderId] }));
    // Re-fetch when the board says the table has a different number of items
    // than the cached view holds. Without this the disclosure keeps showing the
    // list as it was when first opened, while the card beside it counts the new
    // ones — and a GRE would take feedback against a dish that is not on screen.
    const cached = items[orderId];
    if (cached !== undefined && !(cached && cached.item_count !== itemCount)) return;
    setItems((m) => ({ ...m, [orderId]: null }));
    try {
      const res = await api(`/api/feedback/order/${encodeURIComponent(orderId)}`);
      if (!res.ok) { setItems((m) => ({ ...m, [orderId]: undefined as any })); return; }
      const body = await res.json();
      setItems((m) => ({ ...m, [orderId]: body.order as FeedbackOrderView }));
    } catch {
      setItems((m) => ({ ...m, [orderId]: undefined as any }));
    }
  }, [items]);

  const tables = data?.tables ?? [];
  const meta = data?.meta;

  /** FILTER ONLY — the server's ranking is the point of the board, and both
   *  filters below preserve array order, so the ranking survives them. */
  const onThisFloor = useMemo(
    () => (floor === 'all' ? tables : tables.filter((t) => t.floor === floor)),
    [tables, floor],
  );

  /**
   * ⚠️ COUNTED ON THE FLOOR YOU ARE LOOKING AT, not on the whole venue.
   *
   * These numbers were `meta.counts` — the server's totals — while the board
   * below was ALSO filtered by floor. Pick "Rooftop" and the chips said
   * `All · 12 · Feedback Due · 5` above a grid showing three cards, and the
   * counts a GRE is measured on disagreed with the tables in front of them.
   * The server's ranking is still the server's; only the tally is local, and it
   * is derived from exactly the rows the grid draws.
   */
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: onThisFloor.length };
    for (const s of TABLE_STATUSES) c[s.v] = 0;
    for (const t of onThisFloor) c[t.status] = (c[t.status] || 0) + 1;
    return c;
  }, [onThisFloor]);

  const visible = useMemo(
    () => onThisFloor.filter((t) => (status === 'all' ? true : t.status === status)),
    [onThisFloor, status],
  );

  /**
   * `meta.floors` is derived from the tables ON the board, so a floor empties
   * out of the list the moment its last table settles — and a <select> whose
   * value is not among its options renders as the FIRST option, silently moving
   * the GRE to "All floors" without telling them. The selected floor is kept in
   * the list (marked empty) until they leave it themselves.
   */
  const floorOptions = useMemo(() => {
    const live = meta?.floors ?? [];
    const opts = [{ v: 'all', label: 'All floors' }, ...live.map((f) => ({ v: f, label: f }))];
    if (floor !== 'all' && !live.includes(floor)) opts.push({ v: floor, label: `${floor} (none open)` });
    return opts;
  }, [meta?.floors, floor]);

  /* ── the refusal screen ───────────────────────────────────────────────────
     Printed instead of an empty board, because an empty board is exactly what
     the unassigned-role trap looks like. */
  if (denial) {
    return (
      <>
        <PageHead title="Floor Feedback" subtitle="Access not confirmed" />
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
                  <dd className="text-[#2D1B0E] font-bold">{GRE_ROLE_NAME}</dd>
                  <dt className="text-[#8B7355] font-semibold">Your role</dt>
                  <dd className="text-[#2D1B0E] font-bold">
                    {denial.your_role || 'none assigned'}
                  </dd>
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
        title="Floor Feedback"
        subtitle={
          loading
            ? 'Loading the floor…'
            : <>{counts.due || 0} due · {counts.issue || 0} issues · {counts.follow_up || 0} follow-up</>
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
        {/* Filters. Status scrolls; floor is a native select so the phone gives
            the OS picker instead of a row that grows with every new floor.
            The floor list is restaurant_tables.zone — there is no `floor`
            column, and `section` is 0% populated so no filter is built on it. */}
        <div className="pt-3 space-y-2">
          <Scroller label="Filter by status">
            <Chip active={status === 'all'} onClick={() => setStatus('all')}>
              All · {counts.all || 0}
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

        {error ? (
          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error} — the board could not be loaded, so this is NOT an empty floor. Tap refresh.
          </div>
        ) : null}

        {/* A station that fits neither bucket is reported, never silently
            dropped: BAR_STATIONS is total, so anything off it — a blank station
            included — becomes Food with no error. */}
        {meta && meta.unclassified.length > 0 ? (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <span className="font-bold">
                  {meta.unclassified.reduce((s, u) => s + u.items, 0)} item(s) counted under Food
                </span>{' '}
                — station {meta.unclassified.map((u) => u.station).join(', ')}. {meta.unclassified_reason}
              </div>
            </div>
          </div>
        ) : null}

        {/* The board */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((t) => {
            const live = isActionable(t.status);
            const isOpen = !!open[t.order_id];
            const detail = items[t.order_id];
            return (
              <div
                key={t.order_id}
                className={`bg-white border rounded-2xl p-4 ${live ? 'border-[#E8D5C4]' : 'border-[#F0E4D6] opacity-80'}`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-extrabold leading-tight text-[#2D1B0E]">
                      Table {t.table_number || '—'}
                    </div>
                    <div className="text-[11px] text-[#8B7355] leading-tight">
                      {t.floor}
                      {t.order_status === 'settled' ? ' · settled, still in grace' : ''}
                    </div>
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
                    {t.covers ? `${t.covers} pax` : '— pax'}
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Utensils className="w-3.5 h-3.5 text-[#8B7355]" />
                    {t.item_count} items
                  </span>
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Clock className="w-3.5 h-3.5 text-[#8B7355]" />
                    {now === null || !t.opened_at ? '···' : elapsed(t.opened_at, now)}
                  </span>
                  {t.drinks_count > 0 ? (
                    <span className="inline-flex items-center gap-1 font-semibold">
                      <Wine className="w-3.5 h-3.5 text-[#8B7355]" />
                      {t.food_count}F · {t.drinks_count}D
                    </span>
                  ) : null}
                </div>

                <div className="mt-2 flex items-center gap-2 text-[12px]">
                  <span className="text-[#8B7355] truncate">
                    Capt. {t.server_name || '—'}
                    {t.gre_name ? ` · GRE ${t.gre_name}` : ''}
                  </span>
                </div>

                {/* The eligibility evidence, shown because the GRE is judged on
                    coverage and deserves to see WHY a table became due — or why
                    it has not yet. Columns are real (BUILD-STATE §2). */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {t.eligible_by.items ? (
                    <EvidenceChip>{t.item_count} items ordered</EvidenceChip>
                  ) : null}
                  {t.eligible_by.bill_requested ? <EvidenceChip>Bill requested</EvidenceChip> : null}
                  {t.eligible_by.bill_printed ? <EvidenceChip>Bill printed</EvidenceChip> : null}
                  {!t.eligible && meta ? (
                    <span className="rounded-full bg-[#F7F0E7] border border-[#F0E4D6] px-2 py-0.5 text-[10px] font-semibold text-[#8B7355]">
                      {Math.max(0, meta.item_threshold - t.item_count)} more item(s), or the bill
                    </span>
                  ) : null}
                </div>

                {/* Two actions, both read-only in effect: look at what was
                    ordered, or go and record the feedback. Deliberately NOT a
                    single <button> card any more — a nested button is invalid
                    HTML and the disclosure has to be independently tappable. */}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleItems(t.order_id, t.item_count)}
                    aria-expanded={isOpen}
                    disabled={t.item_count === 0}
                    className="shrink-0 min-h-[44px] px-3 rounded-xl bg-white border border-[#E8D5C4] text-[#6B5744] text-[12px] font-semibold inline-flex items-center gap-1 active:scale-95 transition disabled:opacity-40 disabled:active:scale-100"
                  >
                    {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    Items
                  </button>
                  {live ? (
                    <button
                      type="button"
                      onClick={() => router.push(`/feedback/take/${t.order_id}`)}
                      className="flex-1 min-h-[44px] rounded-xl bg-[#af4408] text-white text-[13px] font-semibold active:scale-95 transition"
                    >
                      {t.status === 'due' ? 'Take feedback'
                        : t.status === 'follow_up' ? 'Revisit' : 'Open'}
                    </button>
                  ) : (
                    <span className="flex-1 text-[11px] text-[#8B7355] text-right">
                      waiting for items
                    </span>
                  )}
                </div>

                {isOpen ? (
                  <div className="mt-3 border-t border-[#F0E4D6] pt-3">
                    {detail === null ? (
                      <div className="text-[12px] text-[#8B7355]">Loading items…</div>
                    ) : !detail ? (
                      <div className="text-[12px] text-red-700">Could not load the items.</div>
                    ) : (
                      <ItemLists view={detail} />
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {!loading && visible.length === 0 ? (
          <EmptyState>
            {tables.length === 0
              ? 'No dine-in tables are open right now.'
              : 'No tables match this filter.'}
          </EmptyState>
        ) : null}

        {/* An open complaint that dropped off tonight's board is the one
            exclusion that must never be a footnote: gf_follow_ups keeps it
            OPEN, but no GRE can walk to that table any more, so a manager has
            to pick it up from the Tracker. */}
        {meta && meta.excluded.stale_with_open_issue > 0 ? (
          <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] leading-snug text-violet-900">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div>
                <span className="font-bold">
                  {meta.excluded.stale_with_open_issue} unresolved complaint(s) on a table from an
                  earlier service
                </span>{' '}
                — still open, but off tonight&apos;s floor. The guests have gone; a manager closes
                these from the Tracker.
              </div>
            </div>
          </div>
        ) : null}

        {meta ? (
          <p className="mt-3 text-[11px] leading-snug text-[#8B7355]">
            A table becomes <b>Feedback Due</b> at <b>{meta.item_threshold} items</b>
            {meta.item_threshold_is_default ? ' (default)' : ''}
            {meta.item_threshold_clamped
              ? ' (the saved setting was below 1 and has been raised — 0 would make every table due)'
              : ''}
            , or as soon as the guest asks for the bill, or the bill is printed. Settled tables stay
            visitable for <b>{meta.grace_minutes} min</b>{meta.grace_is_default ? ' (default)' : ''}.
            {meta.business_date ? (
              <>
                {' '}The board shows <b>tonight&apos;s service</b> ({meta.business_date}), which
                rolls over at <b>{meta.board_cutoff}</b>
                {meta.board_cutoff_source === 'default' ? ' (default)' : ''}: a table still open
                from an earlier service drops off instead of queueing here forever.
              </>
            ) : null}
            {meta.excluded.takeaway_or_other || meta.excluded.table_row_missing
              || meta.excluded.stale_open_order ? (
              <>
                {' '}Not shown: {meta.excluded.takeaway_or_other} non-dine-in,{' '}
                {meta.excluded.table_row_missing} order(s) whose table record no longer exists, and{' '}
                {meta.excluded.stale_open_order} still-open order(s) left over from an earlier
                service. Nothing was closed or changed to take them off — they are only off this
                list.
              </>
            ) : null}
            {' '}This board is read-only — opening a table records nothing until you submit feedback.
          </p>
        ) : null}
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

/* ── small parts ─────────────────────────────────────────────────────────── */

function EvidenceChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[#FFF1E3] border border-[#E8D5C4] px-2 py-0.5 text-[10px] font-semibold text-[#6B5744]">
      {children}
    </span>
  );
}

/** Food and Drinks, split by the shipped `BAR_STATIONS` authority (resolved
 *  server-side). An item whose station is blank or off the menu master is
 *  marked — it is counted under Food, and saying so beats a mocktail quietly
 *  becoming a food complaint. */
function ItemLists({ view }: { view: FeedbackOrderView }) {
  return (
    <div className="space-y-3">
      <ItemGroupList title="Food" rows={view.food} />
      <ItemGroupList title="Drinks" rows={view.drinks} />
      {view.unclassified_count > 0 ? (
        <p className="text-[10px] leading-snug text-amber-800">
          <AlertTriangle className="w-3 h-3 inline-block mr-0.5 -mt-0.5" />
          {view.unclassified_count} item(s) marked <b>?</b> have no recognised station.{' '}
          {view.unclassified_reason}
        </p>
      ) : null}
    </div>
  );
}

function ItemGroupList({ title, rows }: { title: string; rows: FeedbackOrderView['food'] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-[#8B7355]">
        {title} · {rows.length}
      </h3>
      <ul className="mt-1 space-y-1">
        {rows.map((it) => (
          <li key={it.id} className="flex items-baseline gap-2 text-[12px] text-[#2D1B0E]">
            <span className="font-bold tabular-nums shrink-0">{it.quantity}×</span>
            <span className="min-w-0 flex-1">
              {it.name}
              {!it.station_recognised ? (
                <span className="ml-1 text-amber-700 font-bold" title="No recognised station">?</span>
              ) : null}
            </span>
            <span className="shrink-0 text-[10px] text-[#8B7355] capitalize">
              {it.served_at ? 'served' : it.kitchen_status || '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
