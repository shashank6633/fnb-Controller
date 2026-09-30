'use client';

/**
 * Page 4 — ADMIN ANALYTICS & REPORTS  (route: /feedback/analytics)  ·  P5, LIVE
 *
 * Spec section 3 Page 4. The reports live HERE, not on a fifth page: dashboard
 * counts, the date + scope filters, Menu Item Analysis, Most Common Problems /
 * Most Complained / Most Appreciated, Service Recovery Analysis, GRE/Manager
 * performance, and the eight Excel/PDF downloads.
 *
 * ── WHAT CHANGED FROM THE P1 SHELL ──────────────────────────────────────────
 * Every tile, table, list and button on this page used to be inert. The page
 * imported `../placeholder.ts` and fetched NOTHING AT ALL — zero
 * `/api/feedback` references in 524 lines — so a manager reading it was reading
 * invented numbers with no way to tell. It now reads
 * `GET /api/feedback/analytics` for everything and
 * `GET /api/feedback/reports?report=..&format=..` for the downloads, and it
 * imports no fixture.
 *
 * ── THE TWO RATES, AND WHY BOTH APPEAR BESIDE THEIR COUNTS ──────────────────
 * The owner: *"This is important because total complaints alone can be
 * misleading."* A dish sold 500 times with 7 complaints is not the dish sold 12
 * times with 5.
 *   · Negative %   = negative feedbacks / feedbacks received for that item.
 *                    Both sides count feedback rows — a QUALITY measure.
 *   · Ret/Rem %    = plates returned + remade / plates SOLD. Both sides are
 *                    quantities — an OPERATIONS measure.
 * Two different denominators on purpose. They are computed ONCE, server-side in
 * `src/lib/feedback/reporting.ts`, so this page and the eight downloads cannot
 * disagree about the restaurant's coverage.
 *
 * ── 🔒 THE FAIRNESS RULING ──────────────────────────────────────────────────
 * Nothing here ranks a GRE by what the guests said. The performance table
 * carries Tables Visited, Issues Recorded, Follow-Ups Completed/Open and
 * Recovery Follow-Up % — and `meta.fairness_note` prints the reason on screen,
 * where whoever reads the dashboard will see it. "Issues Recorded" is shown in
 * the SAME neutral ink as every other count, deliberately: colouring it red
 * would make recording a complaint look like a mark against the recorder, which
 * is the exact behaviour the ruling forbids.
 *
 * ── MANAGEMENT ONLY ─────────────────────────────────────────────────────────
 * `page-catalog.ts` carries `mgmtOnly` for this path, and the API gates itself
 * with `requireFeedbackAnalyst()` — the page flag alone would not stop a GRE
 * fetching the URL (hard rule 9: `proxy.ts` guards PAGES, NOT APIs). A refusal
 * renders the server's own `what_to_do` verbatim rather than an empty
 * dashboard, because an empty dashboard is indistinguishable from "nobody
 * complained today", which is the most dangerous sentence this page could say.
 *
 * ── 390px ───────────────────────────────────────────────────────────────────
 * Every table goes through `TableScroll`, so the page body itself never scrolls
 * sideways. Tiles are two per row.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Download, FileSpreadsheet, FileText, Search, TrendingDown, ThumbsUp, RotateCcw, Smile, Frown,
  Lock, RefreshCw, AlertTriangle, MessageSquare,
} from 'lucide-react';
import { api } from '@/lib/api';
import { DATE_RANGES, ITEM_GROUPS, REPORTS, type ItemGroup } from '@/lib/feedback';
import type { AnalyticsPayload, ItemCommentRow, MenuItemRow, RecoveryKey } from '@/lib/feedback/reporting';
import {
  Card, Chip, EmptyState, PageBody, PageHead, Scroller, SectionTitle, Select,
  StickyBar, TableScroll, Tile,
} from '../ui';

/** The shape `requireFeedbackAnalyst()` refuses with. `what_to_do` is printed
 *  verbatim — the role trap (role created but never ASSIGNED) looks exactly
 *  like a broken page unless the screen says which step is missing. */
interface Denial {
  error: string;
  reason: string;
  your_role?: string | null;
  what_to_do?: string;
}

type Payload = AnalyticsPayload & {
  viewer: { name: string; role_name: string | null; scope: string };
};

/** A percentage the SERVER computed, or an em dash. */
function pctText(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/**
 * The one place this file divides, and it is the same formula the server's
 * `rate()` uses — kept here only so a tile can show a share of two numbers that
 * are already on screen. Null for a zero denominator, never NaN.
 */
function rateOf(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

/**
 * Bar width, with the zero denominator guarded. `(0 / 0) * 100` is NaN and
 * `width: NaN%` is silently DROPPED by the browser, which renders as a
 * full-width bar — a venue with no feedback at all would have shown four
 * confident rating bars.
 */
function barWidth(n: number, total: number): string {
  if (!Number.isFinite(n) || !Number.isFinite(total) || total <= 0) return '0%';
  return `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
}

export default function FeedbackAnalyticsPage() {
  const [range, setRange] = useState<string>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [floor, setFloor] = useState('all');
  const [section, setSection] = useState('all');
  const [gre, setGre] = useState('all');
  const [manager, setManager] = useState('all');
  const [captain, setCaptain] = useState('all');
  const [group, setGroup] = useState<'all' | ItemGroup>('all');
  const [q, setQ] = useState('');

  const [data, setData] = useState<Payload | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [openItem, setOpenItem] = useState<MenuItemRow | null>(null);
  const [comments, setComments] = useState<ItemCommentRow[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<string>('');
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** The filters, as the query string BOTH the dashboard and every download are
   *  asked for. One builder, so a download can never be run against a different
   *  period from the one on screen. */
  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('range', range);
    if (range === 'custom') { if (from) sp.set('from', from); if (to) sp.set('to', to); }
    sp.set('floor', floor);
    sp.set('section', section);
    sp.set('captain', captain);
    sp.set('gre', gre);
    sp.set('manager', manager);
    sp.set('group', group);
    if (q.trim()) sp.set('item', q.trim());
    return sp.toString();
  }, [range, from, to, floor, section, captain, gre, manager, group, q]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setBusy(true);
    try {
      const res = await api(`/api/feedback/analytics?${query}`);
      if (res.status === 401 || res.status === 403) {
        setDenial(await res.json().catch(() => ({ error: 'Access refused', reason: 'unknown' })));
        setData(null);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `HTTP ${res.status}`);
        return;
      }
      setDenial(null);
      setError(null);
      setData(await res.json());
    } catch (e: any) {
      setError(e?.message || 'Could not reach the feedback analytics');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [query]);

  useEffect(() => { void load(true); }, [load]);

  /* ── the click-through the owner asked for by name ───────────────────────
     "management can CLICK AN ITEM TO SEE THE ACTUAL COMMENTS". The count tells
     a chef something is wrong; the sentence the guest said is what tells them
     what to change. Fetched on open, under the SAME filters as the row. */
  const openComments = useCallback(async (row: MenuItemRow) => {
    setOpenItem(row);
    setComments(null);
    setCommentsError(null);
    try {
      const res = await api(`/api/feedback/analytics?${query}&item_key=${encodeURIComponent(row.item_key)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCommentsError(body?.error || `HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      setComments((body.comments ?? []) as ItemCommentRow[]);
    } catch (e: any) {
      setCommentsError(e?.message || 'Could not load the comments');
    }
  }, [query]);

  /**
   * A download is FETCHED rather than linked, so a refusal or a 500 becomes a
   * message on the page. An `<a href>` to the same URL would open a new tab and
   * render the JSON error as text — or, worse for a report, hand over a file
   * the reader would open, see nothing in, and read as "no complaints".
   */
  const download = useCallback(async (reportKey: string, format: 'xlsx' | 'pdf') => {
    const tag = `${reportKey}:${format}`;
    setDownloading(tag);
    setDownloadError(null);
    try {
      const res = await api(`/api/feedback/reports?report=${encodeURIComponent(reportKey)}&format=${format}&${query}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDownloadError(body?.error || `Download failed (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const named = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = named || `feedback-${reportKey}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on a timer: revoking synchronously can beat the click in some
      // browsers and hand the reader an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      setDownloadError(e?.message || 'Download failed');
    } finally {
      setDownloading('');
    }
  }, [query]);

  /* ── refusal ─────────────────────────────────────────────────────────── */
  if (denial) {
    return (
      <>
        <PageHead title="Feedback Analytics" subtitle="Access not confirmed" />
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
                  <dt className="text-[#8B7355] font-semibold">Access needed</dt>
                  <dd className="text-[#2D1B0E] font-bold">Manager or Administrator</dd>
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

  const s = data?.summary;
  const meta = data?.meta;
  const opts = data?.options;
  /**
   * ⚠️ ONE POPULATION, NAMED. The split used to be drawn over "rated only"
   * while the tile beside it said "Feedbacks taken", which counted a DIFFERENT
   * set — visits on eligible tables. The same two numbers disagreed inside one
   * exported workbook (Summary 9, Rating split 10). Both are now
   * `feedbacks_recorded`: every visit in scope, Not rated included, which is
   * exactly what the Rating split sheet totals.
   */
  const ratingTotal = s ? s.feedbacks_recorded : 0;
  const recoveryTotal = (data?.recovery ?? []).reduce((a, b) => a + b.count, 0);
  /* 🐞 THE THREE COLOURED TILES INSIDE THE RECOVERY CARD USED TO BE VENUE
     FIGURES SITTING UNDER RECORD-LEVEL BARS. Since D11(a) made the recovery
     queue narrow to the selected person, `s.happy_after_replacement` beside the
     bar "Guest happy after correction — <name>'s records" printed TWO DIFFERENT
     NUMBERS for one outcome in ONE card. They are read from the queue itself now,
     by stable `key` rather than by row position, so the card is internally
     consistent at both scopes. The venue's own three figures are not lost: they
     are the Dashboard tiles further up ("Happy after replacement", "Still
     unhappy" with its partially-happy hint), which never narrow. */
  const recoveryBy = new Map((data?.recovery ?? []).map((r) => [r.key, r.count]));
  const rec = (k: RecoveryKey): number => recoveryBy.get(k) ?? 0;
  /** The name the RECORD-level sections are narrowed to, '' when venue-wide.
   *  Safe before `data` loads, so the comments drawer (which renders outside the
   *  payload's null guard) can say whose comments it is showing. */
  const recordPerson = data?.records.scope === 'person' ? data.records.person : '';

  /** A value that is not among its options makes a `<select>` render the FIRST
   *  one, silently moving the reader back to "All" — the same trap Page 1's
   *  floor picker hit. Keep the selection visible until they leave it. */
  const selectOpts = (label: string, values: readonly string[], current: string) => {
    const out = [{ v: 'all', label }, ...values.map((x) => ({ v: x, label: x }))];
    if (current !== 'all' && !values.includes(current)) out.push({ v: current, label: `${current} (none)` });
    return out;
  };

  return (
    <>
      <PageHead
        title="Feedback Analytics"
        subtitle={
          s
            ? `${s.eligible_tables_covered} of ${s.eligible_tables} eligible tables · coverage ${pctText(s.coverage_pct)}`
            : loading ? 'Loading…' : 'No data'
        }
      />

      <PageBody>
        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-3 py-2.5">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0 text-[12px] text-red-800">
              <div className="font-bold">Could not load the analytics.</div>
              <div className="break-words">{error}</div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="ml-auto shrink-0 rounded-lg border border-red-300 px-2.5 py-1.5 text-[11px] font-bold text-red-800"
            >
              Retry
            </button>
          </div>
        ) : null}

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
            <Select label="Floor" value={floor} onChange={setFloor} options={selectOpts('All floors', opts?.floors ?? [], floor)} />
            {/* The Section filter appears ONLY when the data has sections. The
                owner's production census (2026-09-23) shows 7 sections across
                3 floors; the working snapshot has none at all, and a dropdown
                that returns nothing is worse than no dropdown. */}
            {opts?.sections_available ? (
              <Select label="Section" value={section} onChange={setSection} options={selectOpts('All sections', opts.sections, section)} />
            ) : null}
            <Select label="GRE" value={gre} onChange={setGre} options={selectOpts('All', opts?.gres ?? [], gre)} />
            <Select label="Manager" value={manager} onChange={setManager} options={selectOpts('All', opts?.managers ?? [], manager)} />
            <Select label="Captain" value={captain} onChange={setCaptain} options={selectOpts('All', opts?.captains ?? [], captain)} />
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

          {data ? (
            <p className="text-[11px] leading-snug text-[#8B7355]">
              {data.range.label}
              {data.range.note ? ` · ${data.range.note}` : ''}
              {opts && !opts.sections_available ? ` · ${opts.sections_note}` : ''}
            </p>
          ) : null}
        </div>

        {!data && loading ? <EmptyState>Loading the period…</EmptyState> : null}

        {data && s && meta ? (
          <>
            {/* ── 🔒 WHAT THE PERSON FILTER DID, AND WHAT IT DID NOT ─────
                Selecting a GRE used to narrow the rating split and the four
                red/amber tiles below. The same person on the same tables then
                read "Excellent 100%, Negative 0" if she recorded nothing and
                "Average 100%, Negative 4" if she recorded what the guests
                said — an appraisal that improves by staying silent, which is
                the one thing the owner's ruling forbids. It now fills in the
                card below and changes nothing else, and the page says so
                where the reader is looking. */}
            {data.person ? (
              <>
                <SectionTitle hint="the only thing this filter changed">
                  What {data.person.person} did
                </SectionTitle>
                <Card className="p-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <Tile label="Tables visited" value={data.person.tables_visited} tone="accent" />
                    <Tile
                      label="Coverage of their floor"
                      value={data.person.area_assigned ? pctText(data.person.area_coverage_pct) : '—'}
                      hint={data.person.area_assigned
                        ? `${data.person.area_covered ?? 0} of ${data.person.area_eligible ?? 0} on ${data.person.area_label}`
                        : 'no floor assigned — measured venue-wide'}
                    />
                    <Tile
                      label="Feedbacks recorded"
                      value={data.person.feedbacks_recorded}
                      hint={data.person.off_area_visits
                        ? `${data.person.off_area_visits} helping on another floor`
                        : undefined}
                    />
                    <Tile label="Issues properly recorded" value={data.person.issues_recorded} hint="a credit, never a penalty" />
                    <Tile label="Follow-ups completed" value={data.person.follow_ups_completed} hint={`${data.person.follow_ups_open} still open`} />
                    {/* 🔒 A QUEUE, NOT A SCORE. A bare "0.0%" here for the GRE
                        with two complaints still to revisit sat beside a "—"
                        for the GRE who recorded none, and the honest one read
                        worse. The cell now carries its own denominator and an
                        empty queue says so in words. */}
                    <Tile
                      label="Guest recovery follow-up"
                      value={data.person.follow_ups_raised
                        ? `${data.person.follow_ups_completed}/${data.person.follow_ups_raised}`
                        : 'none raised'}
                      hint={data.person.follow_ups_raised
                        ? `${pctText(data.person.recovery_pct)} of the complaints they recorded are closed`
                        : 'they recorded no complaints in this period — not a better score, just nothing to close'}
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-[#8B7355]">
                    {data.person.coverage_basis}
                  </p>
                </Card>
              </>
            ) : null}

            {/* ── Dashboard tiles ──────────────────────────────────────── */}
            <SectionTitle
              hint={meta.person_filter_active
                ? 'the whole selected floor / captain / period — NOT the person above'
                : undefined}
            >
              Dashboard
            </SectionTitle>
            {meta.person_filter_active ? (
              <p className="-mt-1 text-[11px] leading-snug text-[#8B7355]">{meta.counts_scope}</p>
            ) : null}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              <Tile
                label="Coverage"
                value={pctText(s.coverage_pct)}
                hint={`${s.eligible_tables_covered} of ${s.eligible_tables} eligible`}
                tone="accent"
              />
              <Tile
                label="Eligible tables"
                value={s.eligible_tables}
                hint={`${meta.item_threshold} items${meta.item_threshold_is_default ? ' (default)' : ''}, or bill asked / printed`}
              />
              <Tile
                label="Feedbacks recorded"
                value={s.feedbacks_recorded}
                hint={
                  s.extra_visits
                    ? `${s.eligible_tables_covered} on eligible tables + ${s.extra_visits} on tables that never met the trigger`
                    : (s.everything_good ? `${s.everything_good} “everything good”` : 'all on eligible tables')
                }
              />
              <Tile
                label="Negative item feedbacks"
                value={s.negative_item_feedbacks}
                hint={`${pctText(rateOf(s.negative_item_feedbacks, s.item_feedbacks))} of ${s.item_feedbacks} item feedbacks`}
                tone="bad"
              />
              <Tile
                label="Returned / Remade / Replaced"
                value={s.returned + s.remade + s.replaced}
                hint={`${s.returned} returned · ${s.remade} remade · ${s.replaced} replaced`}
                tone="warn"
              />
              <Tile label="Happy after replacement" value={s.happy_after_replacement} tone="good" />
              <Tile
                label="Still unhappy"
                value={s.still_unhappy}
                hint={s.partially_happy ? `${s.partially_happy} partially happy` : undefined}
                tone="bad"
              />
              <Tile
                label="Pending follow-ups"
                value={s.pending_follow_ups}
                hint={`${s.open_follow_ups_now} open now (all dates)`}
                tone={s.pending_follow_ups ? 'warn' : 'plain'}
              />
            </div>

            {/* ── Rating split ─────────────────────────────────────────── */}
            {/* 🔒 D11(a). THE RATING BLOCK IS VENUE-WIDE AND HAS TO SAY SO ON ITS
                OWN FACE. Below this point the page shows the RECORDS of the person
                picked in the GRE / Manager filter, and above it the judgement of
                the ROOM. A reader who scrolls to a name-filtered page and sees
                "Excellent 100%" must not be able to read it as that person's, so
                the scope is printed here rather than left to the Dashboard note
                further up the page. */}
            <SectionTitle
              hint={data.records.scope === 'person'
                ? `whole venue — ${ratingTotal} feedbacks by everyone, NOT ${data.records.person}`
                : `${ratingTotal} feedbacks recorded${s.unrated ? ` · ${s.unrated} not rated` : ''}`}
            >
              Overall rating split
            </SectionTitle>
            <Card className="p-3">
              {data.records.scope === 'person' ? (
                <p className="mb-2 rounded-lg bg-[#F7EEE4] px-2.5 py-1.5 text-[11px] font-semibold leading-snug text-[#6B5744]">
                  Whole venue, every recorder. This block does not change when a name is
                  picked — so recording what a guest actually said can never move
                  {' '}{data.records.person}&rsquo;s numbers.
                </p>
              ) : null}
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-[#F0E4D6]">
                <span className="bg-emerald-600" style={{ width: barWidth(s.excellent, ratingTotal) }} />
                <span className="bg-emerald-400" style={{ width: barWidth(s.good, ratingTotal) }} />
                <span className="bg-amber-400" style={{ width: barWidth(s.average, ratingTotal) }} />
                <span className="bg-red-500" style={{ width: barWidth(s.poor, ratingTotal) }} />
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
                      {x.n} · {pctText(rateOf(x.n, ratingTotal))}
                    </span>
                  </div>
                ))}
              </div>

              {/* Food · Drinks · Service · Ambience, from the same visits. */}
              <TableScroll>
                <table className="w-full text-[12px] mt-3">
                  <thead>
                    <tr className="text-left text-[#8B7355]">
                      <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Category</th>
                      <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Excellent</th>
                      <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Good</th>
                      <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Average</th>
                      <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Poor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.categories.map((c) => (
                      <tr key={c.key} className="border-t border-[#F0E4D6]">
                        <td className="py-2 pr-3 font-bold text-[#2D1B0E]">{c.label}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.excellent}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.good}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.average}</td>
                        <td className="py-2 text-right tabular-nums">{c.poor}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </Card>

            {/* ── Menu Item Analysis ───────────────────────────────────── */}
            {/* RECORD-LEVEL from here down to the end of Service recovery: under a
                GRE / Manager filter these are that person's own records, which is
                what the owner ruled in D11(a). `records.note` is the server's own
                sentence, so the screen and all eight downloads say the same thing. */}
            <SectionTitle hint={data.records.scope === 'person' ? `recorded by ${data.records.person} · tap a row for the comments` : 'tap a row for the comments'}>
              Menu item analysis
            </SectionTitle>
            {data.records.note ? (
              <p className="-mt-1 text-[11px] leading-snug text-[#8B7355]">{data.records.note}</p>
            ) : null}
            {data.menu_items.length === 0 ? (
              <EmptyState>
                {data.records.scope === 'person'
                  ? `${data.records.person} recorded no item feedback in this period. That is not a clean venue — the Dashboard tiles and the rating split above are unaffected by this filter.`
                  : 'No menu item matches that filter.'}
              </EmptyState>
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
                      {data.menu_items.map((r) => (
                        <tr
                          key={r.item_key}
                          onClick={() => void openComments(r)}
                          className="border-t border-[#F0E4D6] cursor-pointer hover:bg-[#FFF8F0]"
                        >
                          <td className="py-2 pr-3 font-bold text-[#2D1B0E]">
                            {r.menu_item}
                            <span className="ml-1.5 text-[10px] font-semibold text-[#8B7355]">
                              {r.feedbacks === 0 ? 'no feedback' : r.group === 'food' ? 'Food' : 'Drinks'}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.sold}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.feedbacks}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.negative}</td>
                          <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-red-700">
                            {pctText(rateOf(r.negative, r.feedbacks))}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {r.returned} / {r.remade}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-amber-700">
                            {pctText(rateOf(r.returned_qty + r.remade_qty, r.sold))}
                          </td>
                          <td className="py-2 text-right tabular-nums text-emerald-700 font-semibold">
                            {r.happy_after}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
                <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
                  {meta.negative_pct_basis} {meta.return_remake_basis}
                </p>
              </Card>
            )}

            {/* ── Lists ────────────────────────────────────────────────── */}
            <div className="mt-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
              <RankList
                title="Most common problems"
                icon={<TrendingDown className="w-4 h-4 text-red-600" />}
                rows={data.common_problems}
                tone="bad"
                empty={data.records.scope === 'person'
                  ? `${data.records.person} recorded no issue against an item in this period.`
                  : 'No issue was recorded against an item in this period.'}
                note={data.records.note || undefined}
              />
              <RankList
                title="Most complained items"
                icon={<Frown className="w-4 h-4 text-amber-600" />}
                rows={data.most_complained.map((m) => ({
                  label: m.label,
                  count: m.count,
                  sub: `${pctText(m.negative_pct)} of ${m.feedbacks}`,
                }))}
                tone="warn"
                empty={data.records.scope === 'person'
                  ? `${data.records.person} recorded no complaint against an item. NOT a clean venue — see the Dashboard tiles.`
                  : 'No negative item feedback in this period.'}
                note={`Ordered by count, with the rate printed beside it: a rate alone hides a busy dish with many complaints, and a count alone hides a rare one that is always wrong.${data.records.note ? ` ${data.records.note}` : ''}`}
              />
              <RankList
                title="Most appreciated items"
                icon={<ThumbsUp className="w-4 h-4 text-emerald-600" />}
                rows={data.most_appreciated.map((m) => ({ label: m.label, count: m.count, sub: `of ${m.feedbacks}` }))}
                tone="good"
                empty={data.records.scope === 'person'
                  ? `${data.records.person} recorded no positive item feedback in this period.`
                  : 'No positive item feedback in this period.'}
                note={data.records.note || undefined}
              />
            </div>

            {/* ── Service recovery ─────────────────────────────────────── */}
            <SectionTitle hint={data.records.scope === 'person' ? `what happened after a complaint ${data.records.person} recorded` : 'what happened after a negative feedback'}>
              Service recovery
            </SectionTitle>
            <Card className="p-3">
              {data.records.note ? (
                <p className="mb-2 rounded-lg bg-[#F7EEE4] px-2.5 py-1.5 text-[11px] font-semibold leading-snug text-[#6B5744]">
                  {data.records.person}&rsquo;s records only. The venue&rsquo;s own negative,
                  returned/remade and still-unhappy figures are the Dashboard tiles above, and they
                  do not move when a name is picked.
                </p>
              ) : null}
              {recoveryTotal === 0 ? (
                <p className="text-[12px] text-[#8B7355]">
                  {data.records.scope === 'person'
                    ? `${data.records.person} recorded no complaint in this period, so there is nothing here to recover. Read the Dashboard tiles above for the venue's own figures — an empty queue here is not a clean service.`
                    : 'Nothing was returned, remade or replaced in this period, and no complaint needed a follow-up.'}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {data.recovery.map((r) => (
                    <div key={r.label} className="flex items-center gap-2">
                      {/* NOT `truncate`. Under a GRE / Manager filter the label
                          carries "— <name>'s records" (the server qualifies it so
                          the e-mailed workbook cannot read the queue as the venue
                          tile of the same name), and at w-44 a clipped label lost
                          the OUTCOME word: "Guest happy after correcti…". It wraps
                          instead, which costs a line and keeps every word. */}
                      <span
                        className="w-44 shrink-0 text-[12px] font-semibold leading-tight text-[#6B5744] break-words"
                        title={r.label}
                      >
                        {r.label}
                      </span>
                      <span className="flex-1 h-2.5 rounded-full bg-[#F0E4D6] overflow-hidden">
                        <span className="block h-full bg-[#af4408]" style={{ width: barWidth(r.count, recoveryTotal) }} />
                      </span>
                      <span className="w-14 shrink-0 text-right text-[12px] font-extrabold tabular-nums text-[#2D1B0E]">
                        {r.count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-800">
                    <Smile className="w-3.5 h-3.5" /> Happy after
                  </div>
                  <div className="text-xl font-extrabold text-emerald-700">{rec('happy')}</div>
                </div>
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2">
                  <div className="text-[11px] font-bold text-amber-800">Partially happy</div>
                  <div className="text-xl font-extrabold text-amber-700">{rec('partial')}</div>
                </div>
                <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-red-800">
                    <Frown className="w-3.5 h-3.5" /> Still unhappy
                  </div>
                  <div className="text-xl font-extrabold text-red-700">{rec('unhappy')}</div>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
                “Guest happy after correction” closes the complaint. “Partially happy” and “still
                unhappy” leave it open for the manager — {s.open_follow_ups_now} follow-up
                {s.open_follow_ups_now === 1 ? ' is' : 's are'} open right now across all dates, which
                is deliberately not bound by the period filter above.
                {/* 🐞 A VENUE, ALL-DATES NUMBER INSIDE A CARD THAT IS NOW THIS
                    PERSON'S. `open_follow_ups_now` is the venue's live queue and is
                    not even range-bound, so in a card headed with one name it read
                    as hers. The exports have said whose it is since the first cut
                    (`openNowFootnote`); the screen says it here, in the same words
                    and with the person's own figure beside it. */}
                {data.records.scope === 'person' && data.person ? (
                  <>
                    {' '}That figure is the WHOLE VENUE&rsquo;s open queue, not {data.records.person}
                    &rsquo;s — {data.person.follow_ups_open} of{' '}
                    {data.person.follow_ups_open === 1 ? 'them is' : 'them are'} theirs.
                  </>
                ) : null}
              </p>
            </Card>

            {/* ── By day ───────────────────────────────────────────────── */}
            {data.daily.length > 1 ? (
              <>
                {/* VENUE again, after the record-level block above it — so it says
                    so, in reading order, rather than relying on a note near the top. */}
                <SectionTitle
                  hint={data.records.scope === 'person'
                    ? `whole venue · ${data.range.cutoff} IST rollover — NOT ${data.records.person}`
                    : `${data.range.cutoff} IST rollover`}
                >
                  By business day
                </SectionTitle>
                <Card className="p-3">
                  <TableScroll>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left text-[#8B7355]">
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Day</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Eligible</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Taken</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Coverage</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Negative</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.daily.map((d) => (
                          <tr key={d.day} className="border-t border-[#F0E4D6]">
                            <td className="py-2 pr-3 font-bold text-[#2D1B0E] whitespace-nowrap">{d.label}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{d.eligible}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{d.taken}</td>
                            <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-[#af4408]">
                              {pctText(d.coverage_pct)}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">{d.negative}</td>
                            <td className="py-2 text-right tabular-nums">{d.open}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </Card>
              </>
            ) : null}

            {/* ── Downloads ────────────────────────────────────────────── */}
            <SectionTitle hint="Excel · PDF">Downloads</SectionTitle>
            {downloadError ? (
              <div className="mb-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="break-words">{downloadError}</span>
              </div>
            ) : null}
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
                    onClick={() => void download(r.v, 'xlsx')}
                    disabled={downloading !== ''}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#E8D5C4] px-2.5 py-2 text-[11px] font-bold text-[#6B5744] disabled:opacity-40 active:scale-95"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    {downloading === `${r.v}:xlsx` ? '…' : 'Excel'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void download(r.v, 'pdf')}
                    disabled={downloading !== ''}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#E8D5C4] px-2.5 py-2 text-[11px] font-bold text-[#6B5744] disabled:opacity-40 active:scale-95"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    {downloading === `${r.v}:pdf` ? '…' : 'PDF'}
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">
              Daily, Weekly and Monthly carry their own period regardless of the chips above — a
              “Monthly” file must never quietly hold one day. Every other download uses the filters in
              force, and each file states them on its first sheet or page.
            </p>

            {/* ── GRE / Manager performance + the fairness ruling ──────── */}
            <SectionTitle hint="coverage and follow-through only">GRE / Manager performance</SectionTitle>
            <Card className="p-3 border-[#D4B896] bg-[#FFF1E3]">
              <p className="text-[11px] leading-snug text-[#6B5744]">{meta.fairness_note}</p>
              <p className="mt-1 text-[11px] leading-snug text-[#8B7355]">
                Coverage of their floor uses the floors assigned to that person (Settings &rarr; user
                &rarr; preferred zones); the floor is a default, not a restriction, so visits they
                made helping elsewhere are counted as work and never as a shortfall.
                {' '}{meta.coverage_per_gre_unavailable}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-[#8B7355]">{meta.recovery_is_a_queue}</p>
              {data.gre_performance.length === 0 ? (
                <p className="mt-3 text-[12px] text-[#8B7355]">
                  Nobody holds the GRE role and nobody recorded feedback in this period.
                </p>
              ) : (
                <div className="mt-3 rounded-xl bg-white border border-[#E8D5C4] p-2">
                  <TableScroll>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left text-[#8B7355]">
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Person</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3">Their floor</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Tables visited</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Coverage of their floor</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Issues recorded</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Follow-ups done</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 pr-3 text-right">Open</th>
                          <th className="font-extrabold uppercase tracking-wide pb-2 text-right">Recovery</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.gre_performance.map((g) => (
                          <tr key={g.person} className="border-t border-[#F0E4D6]">
                            <td className="py-2 pr-3 font-bold text-[#2D1B0E]">
                              {g.person}
                              {g.kind === 'assigned' ? (
                                <span className="ml-1 font-semibold text-[#8B7355]">· nothing recorded</span>
                              ) : null}
                            </td>
                            <td className="py-2 pr-3 text-[#6B5744]">
                              {g.area_assigned ? g.area_zones.join(' · ') : 'all floors'}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums font-extrabold text-[#af4408]">
                              {g.tables_visited}
                              {g.off_area_visits ? (
                                <span className="ml-1 text-[10px] font-semibold text-[#8B7355]">
                                  ({g.off_area_visits} off-floor)
                                </span>
                              ) : null}
                            </td>
                            {/* 🔒 The owner's floor ruling gives this column a
                                real denominator for whoever has an assignment.
                                Whoever does not gets an em dash — an invented
                                per-person denominator is worse than no number. */}
                            <td className="py-2 pr-3 text-right tabular-nums font-semibold">
                              {g.area_assigned ? (
                                <>
                                  {pctText(g.area_coverage_pct)}
                                  <span className="ml-1 text-[10px] text-[#8B7355]">
                                    {g.area_covered ?? 0}/{g.area_eligible ?? 0}
                                  </span>
                                </>
                              ) : '—'}
                            </td>
                            {/* Same neutral ink as every other count — see the
                                header note. Colouring this red would make
                                recording a complaint look like a mark against
                                the recorder. */}
                            <td className="py-2 pr-3 text-right tabular-nums">{g.issues_recorded}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{g.follow_ups_completed}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{g.follow_ups_open}</td>
                            {/* Queue, not score — see the person tile above.
                                `1/3` carries its denominator; "none raised" is
                                words, so it cannot be misread as a good rate
                                and cannot sort above a real one. */}
                            <td className="py-2 text-right tabular-nums font-semibold text-emerald-700">
                              {g.follow_ups_raised
                                ? `${g.follow_ups_completed}/${g.follow_ups_raised} · ${pctText(g.recovery_pct)}`
                                : <span className="font-normal text-[#8B7355]">none raised</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                </div>
              )}
            </Card>

            {/* What is NOT in the denominator, so coverage is never quietly
                shrunk by an exclusion nobody can see. */}
            {meta.excluded.not_dine_in + meta.excluded.table_row_missing + meta.excluded.voided > 0 ? (
              <p className="mt-3 text-[10px] leading-snug text-[#8B7355]">
                Excluded from this period: {meta.excluded.voided} voided ·{' '}
                {meta.excluded.not_dine_in} takeaway or other · {meta.excluded.table_row_missing} with
                no table row. They are named rather than silently dropped, so the coverage denominator
                can be reconciled against the POS.
              </p>
            ) : null}
          </>
        ) : null}
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">
              {DATE_RANGES.find((d) => d.v === range)?.label} · coverage {pctText(s?.coverage_pct)}
            </div>
            <div className="text-[#8B7355] truncate">
              {s ? `${s.negative_item_feedbacks} negative · ${s.pending_follow_ups} follow-up open` : '—'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            aria-label="Refresh"
            className="shrink-0 inline-flex items-center gap-1.5 border border-[#E8D5C4] bg-white text-[#6B5744] px-3 py-3 rounded-xl text-sm font-semibold disabled:opacity-40 active:scale-95"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => void download('daily', 'xlsx')}
            disabled={!data || downloading !== ''}
            className="shrink-0 inline-flex items-center gap-1.5 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold disabled:opacity-40 active:scale-95"
          >
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </StickyBar>

      {/* ── The actual comments behind one item ─────────────────────────── */}
      {openItem && (
        // `bg-black/40` on the FIXED wrapper so globals.css:295 locks body
        // scroll behind the sheet; on the inner click-catcher it would not match.
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0"
            onClick={() => { setOpenItem(null); setComments(null); }}
            aria-hidden="true"
          />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-[#2D1B0E] truncate">
                  {openItem.menu_item}
                </div>
                <div className="text-[11px] text-[#8B7355]">
                  {openItem.sold} sold · {openItem.feedbacks} feedbacks · {openItem.negative} negative
                  ({pctText(rateOf(openItem.negative, openItem.feedbacks))})
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setOpenItem(null); setComments(null); }}
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
              <MessageSquare className="w-3.5 h-3.5" /> Guest comments
              {recordPerson ? (
                <span className="normal-case tracking-normal font-semibold text-[#af4408]">
                  — recorded by {recordPerson}
                </span>
              ) : null}
            </div>

            {commentsError ? (
              <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-[12px] text-red-800">
                {commentsError}
              </div>
            ) : comments === null ? (
              <div className="mt-2 rounded-xl border border-dashed border-[#D4B896] bg-[#FFF8F0] px-3 py-6 text-center text-[12px] text-[#8B7355]">
                Loading the comments…
              </div>
            ) : comments.length === 0 ? (
              <div className="mt-2 rounded-xl border border-dashed border-[#D4B896] bg-[#FFF8F0] px-3 py-6 text-center text-[12px] text-[#8B7355]">
                {recordPerson
                  ? `${recordPerson} recorded no feedback against this dish in this period. Other staff may have — clear the GRE / Manager filter to read the venue's comments on it.`
                  : 'No item feedback was recorded against this dish in this period.'}
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {comments.map((c, i) => (
                  <div key={`${c.when}-${i}`} className="rounded-xl border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#8B7355]">
                      <span className="font-bold text-[#2D1B0E]">Table {c.table_number || '—'}</span>
                      {c.floor ? <span>· {c.floor}</span> : null}
                      {c.rating ? (
                        <span
                          className={`font-bold ${
                            c.rating === 'poor' ? 'text-red-700'
                              : c.rating === 'average' ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          · {c.rating}
                        </span>
                      ) : null}
                      {c.issue_label ? <span>· {c.issue_label}</span> : null}
                      {c.action_label && c.action_taken !== 'none' ? <span>· {c.action_label}</span> : null}
                      {c.replacement_item_name ? <span>· given {c.replacement_item_name}</span> : null}
                    </div>
                    {c.comment ? (
                      <p className="mt-1 text-[13px] leading-snug text-[#2D1B0E]">“{c.comment}”</p>
                    ) : (
                      <p className="mt-1 text-[12px] italic text-[#8B7355]">No comment written — rating only.</p>
                    )}
                    {c.revisit_comment ? (
                      <p className="mt-1 flex items-start gap-1 text-[12px] leading-snug text-[#6B5744]">
                        <RotateCcw className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>After the follow-up: “{c.revisit_comment}”</span>
                      </p>
                    ) : null}
                    <div className="mt-1 text-[10px] text-[#8B7355]">
                      {c.business_day || '—'}
                      {c.gre_name ? ` · recorded by ${c.gre_name}` : ''}
                      {c.captain ? ` · captain ${c.captain}` : ''}
                      {c.follow_up_status
                        ? ` · follow-up ${c.follow_up_status}${c.happiness ? ` (${c.happiness})` : ''}`
                        : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
  empty,
  note,
}: {
  title: string;
  icon: ReactNode;
  rows: readonly { label: string; count: number; sub?: string }[];
  tone: 'good' | 'warn' | 'bad';
  empty: string;
  note?: string;
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
      {rows.length === 0 ? (
        <p className="text-[12px] text-[#8B7355]">{empty}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-[12px] font-semibold text-[#2D1B0E] truncate" title={r.label}>
                {r.label}
              </span>
              <span className="flex-1 h-2 rounded-full bg-[#F0E4D6] overflow-hidden">
                <span className={`block h-full ${bar}`} style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="w-8 shrink-0 text-right text-[12px] font-extrabold tabular-nums text-[#6B5744]">
                {r.count}
              </span>
              {r.sub ? (
                <span className="w-16 shrink-0 text-right text-[10px] tabular-nums text-[#8B7355]">
                  {r.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {note ? <p className="mt-2 text-[10px] leading-snug text-[#8B7355]">{note}</p> : null}
    </Card>
  );
}
