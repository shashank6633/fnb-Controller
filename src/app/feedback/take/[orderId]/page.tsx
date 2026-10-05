'use client';

/**
 * Page 2 — TAKE FEEDBACK  (route: /feedback/take/[orderId])
 *
 * The owner's hardest requirement on this screen is a time budget, not a
 * feature: "Not every field mandatory — normal positive feedback must finish in
 * 10–20 seconds." So the happy path is ONE tap: **Everything Good** fills the
 * overall rating and all four categories, and Submit lights up immediately. The
 * detail — per-item rating, issue, comment, action taken — is entirely optional
 * and lives behind a tap on an item, out of the way of the common case.
 *
 * ── WHAT CHANGED IN P3 LANE C ───────────────────────────────────────────────
 * THE BUG THE OWNER HIT: "In Floor Feedback Page for the Table no FA3 it showing
 * 2 items. Idli and Masala Dosa. But when i Click on Take Feedback It is not
 * showing the Ordered Items. Its showing the Other Items."
 *
 * He was right, and the cause was not a display glitch. This file rendered
 * `../../placeholder.ts` — ONE INVENTED ORDER with invented dishes — behind a
 * "P1 SHELL" note, and Submit flashed "Shell only". So the screen showed the
 * same fake order for every table on the floor, and the per-item capture that is
 * the entire point of the feature ("to that particular item if there is negative
 * review their itself they can take the review for that item") wrote nothing
 * anywhere. The floor board was reading real orders while this screen was
 * reading fiction, which is why the two disagreed about FA3.
 *
 * It now reads `GET /api/feedback/order/[orderId]` — the module's OWN narrow
 * SELECT over `order_items`, never a proxy to `/api/dine-in/orders/[id]`, whose
 * PATCH exports add_item · set_qty · remove_item · fire — and submits through
 * `POST /api/feedback`. Food vs Drinks is NOT guessed here from a dish name: the
 * server resolves it from `order_items.station` via `classifyStation()` and
 * hands back two arrays already split, so this screen and the writer that stores
 * `item_group` cannot disagree about where a plate belongs.
 *
 * Like the sibling landing at `../page.tsx`, a denial and an empty order must
 * never look alike: a 401/403 prints the gate's own `what_to_do` verbatim,
 * because the live trap is "role created but never ASSIGNED", which otherwise
 * reads as a broken page.
 *
 * 🔒 READ-ONLY. Every control here writes to this module's own draft state, and
 * the only request it ever POSTs is `/api/feedback`, which touches `gf_*` and
 * nothing else. The screen shows the ordered items and cannot change one: no
 * quantity stepper, no remove, no add, no fire, no reprint. "Item Cancelled" and
 * "Fresh Item Replaced" are *records of what the kitchen did*, not commands.
 * No money is read, shown or sent — the GRE records how the food was, not the
 * cheque.
 *
 * 🔒 CSRF. Submit goes through `src/lib/api.ts`, which injects `x-csrf-token` on
 * state-changing methods. `/api/feedback` is in `CSRF_REQUIRED_PREFIXES`
 * (`src/proxy.ts`), so a bare `fetch()` here would 403 at the proxy.
 *
 * The route is `/feedback/take/[orderId]` — no `print` segment, no `.json`
 * ending, both of which `proxy.ts` would turn into a public, CSRF-exempt path
 * (hard rule 9).
 *
 * `useParams()` rather than the page's `params` prop: in Next 16 `params` is a
 * Promise in a Server Component, and this screen is a Client Component anyway
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-params.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Users, Clock, Check, X, MessageSquare, Mic, Star, RotateCcw, ChevronRight,
  Lock, RefreshCw, AlertTriangle, Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  ACTIONS_TAKEN, CATEGORIES, GRE_ROLE_NAME, HAPPINESS, ITEM_ISSUES, ITEM_RATINGS,
  OVERALL_RATINGS, REVISIT_RATINGS, closesIssue, isNegative, requiresFollowUp,
  type Category, type ItemRating, type OverallRating,
} from '@/lib/feedback';
// Type-only, so nothing from the server modules reaches the client bundle — the
// same thing `../page.tsx` does for FloorRow.
import type { FeedbackOrderItem, FeedbackOrderView } from '@/lib/feedback/read';
import type { SubmitFeedbackOk } from '@/lib/feedback/write';
// The pure half of this screen: the silence rule and the request body, as plain
// functions over plain data so a test can drive them into the real route. See
// the header of ./draft.ts for why they are not inlined here.
import {
  buildSubmitBody, canSubmit as draftCanSubmit, isRecordable,
  type ItemFeedback, type Revisit, type TakeDraft,
} from './draft';
import { Card, Chip, PrimaryButton, Scroller, SectionTitle, StickyBar, elapsed } from '../../ui';

/** The refusal body the feedback gate returns. `what_to_do` is printed verbatim
 *  — the live trap is "role created but never ASSIGNED", which looks exactly
 *  like a broken page unless the screen names the missing step. */
interface Denial {
  error: string;
  reason: string;
  your_role?: string | null;
  what_to_do?: string;
}

/** A refused submit, as the route reports it. */
interface SubmitRefusal {
  error: string;
  reason?: string;
  taken_by?: string;
  taken_at?: string;
}

const CATEGORY_CHOICES = ITEM_RATINGS; // Good · Average · Poor, the same three

/** Stable empty array, so the `useMemo` over the two item lists does not get a
 *  fresh `[]` on every render while the order is still loading. */
const NO_ITEMS: FeedbackOrderItem[] = [];

export default function TakeFeedbackPage() {
  const router = useRouter();
  const params = useParams<{ orderId: string }>();
  const orderId = typeof params?.orderId === 'string' ? params.orderId : '';

  /* ── the real order ───────────────────────────────────────────────────── */
  const [view, setView] = useState<FeedbackOrderView | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /* ── the draft ────────────────────────────────────────────────────────── */
  const [overall, setOverall] = useState<OverallRating | null>(null);
  const [categories, setCategories] = useState<Partial<Record<Category, ItemRating>>>({});
  const [itemFb, setItemFb] = useState<Record<string, ItemFeedback>>({});
  const [revisits, setRevisits] = useState<Record<string, Revisit>>({});
  /** Was the one-tap path used? Sent as `everything_good`, which the writer
   *  stores — and which it refuses to store as 1 next to a negative item. Any
   *  later edit clears it, so this screen never produces that contradiction. */
  const [oneTap, setOneTap] = useState(false);
  const [sheetFor, setSheetFor] = useState<FeedbackOrderItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /* ── the submit ───────────────────────────────────────────────────────── */
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<SubmitRefusal | null>(null);
  const [done, setDone] = useState<SubmitFeedbackOk | null>(null);

  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }, []);

  /**
   * One load, plus a manual refresh. NOT a poll like the floor board: the GRE is
   * standing at the table typing into this form, and swapping the item list out
   * from under a half-written complaint would lose it.
   */
  const load = useCallback(async (quiet = false) => {
    if (!orderId) {
      setLoadError('No order id in the address — open this screen from the floor board.');
      setLoading(false);
      return;
    }
    if (!quiet) setBusy(true);
    try {
      const res = await api(`/api/feedback/order/${encodeURIComponent(orderId)}`);
      if (res.status === 401 || res.status === 403) {
        let body: Denial = { error: `HTTP ${res.status}`, reason: 'unknown' };
        try { body = await res.json(); } catch { /* keep the fallback */ }
        setDenial(body);
        setView(null);
        setLoadError(null);
        return;
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* keep the fallback */ }
        setLoadError(
          res.status === 404
            ? 'This order is not open for feedback — it may have been voided, or it belongs to '
              + 'another outlet. Go back to the floor board and pick a table from there.'
            : msg,
        );
        setView(null);
        return;
      }
      const body = (await res.json()) as { order: FeedbackOrderView };
      setDenial(null);
      setLoadError(null);
      setView(body.order);
    } catch (e: any) {
      setLoadError(e?.message || 'Could not reach the server');
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  /** Already split by the SERVER, from `order_items.station`. Nothing on this
   *  screen re-derives Food vs Drinks from a dish name. */
  const food = view?.food ?? NO_ITEMS;
  const drinks = view?.drinks ?? NO_ITEMS;
  const allItems = useMemo(() => [...food, ...drinks], [food, drinks]);

  const resetAll = useCallback(() => {
    setOverall(null);
    setCategories({});
    setItemFb({});
    setRevisits({});
    setOneTap(false);
    setRefusal(null);
  }, []);

  /** THE 10-SECOND PATH. One tap sets everything the happy case needs and
   *  clears any half-entered detail, so a mis-tap cannot leave a stray "Poor"
   *  on an item while the header says Excellent. */
  const everythingGood = useCallback(() => {
    setOverall('excellent');
    setCategories({ food: 'good', drinks: 'good', service: 'good', ambience: 'good' });
    setItemFb({});
    setRevisits({});
    setOneTap(true);
    setRefusal(null);
    flash('Everything Good — ready to submit');
  }, [flash]);

  /** Items whose recorded action forces a Follow-Up Required and holds the
   *  complaint open — the rule lives in feedback.ts so Pages 1, 3 and 4 cannot
   *  each decide it differently. */
  const followUpItems = useMemo(
    () => allItems.filter((i) => requiresFollowUp(itemFb[i.id]?.action || '')),
    [allItems, itemFb],
  );

  const negativeCount = useMemo(
    () => allItems.filter((i) => isNegative(itemFb[i.id]?.rating || '')).length,
    [allItems, itemFb],
  );

  /** Only the entries the server would actually store — see `isRecordable`. */
  const notedCount = useMemo(
    () => Object.values(itemFb).filter(isRecordable).length,
    [itemFb],
  );

  /** The draft, as one serialisable object — the exact input the tested
   *  `buildSubmitBody()` / `canSubmit()` in ./draft.ts take. `order_id` comes
   *  from the SERVER's view, never from the URL, so a body can only ever name
   *  the order the GET route actually returned. */
  const draft: TakeDraft = useMemo(
    () => ({
      order_id: view?.order_id ?? '',
      overall,
      categories,
      itemFb,
      revisits,
      oneTap,
    }),
    [view?.order_id, overall, categories, itemFb, revisits, oneTap],
  );

  const canSubmit = draftCanSubmit(draft);

  const submit = useCallback(async () => {
    if (!view || submitting) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      // Through `api()`, never a bare fetch: `/api/feedback` is CSRF-required.
      const res = await api('/api/feedback', { method: 'POST', body: buildSubmitBody(draft) });
      let payload: any = null;
      try { payload = await res.json(); } catch { /* handled below */ }

      if (res.status === 401 || res.status === 403) {
        setDenial(payload && payload.error
          ? payload
          : { error: `HTTP ${res.status}`, reason: 'unknown' });
        return;
      }
      if (!res.ok || !payload?.ok) {
        setRefusal({
          error: payload?.error || `HTTP ${res.status} — nothing was recorded.`,
          reason: payload?.reason,
          taken_by: payload?.taken_by,
          taken_at: payload?.taken_at,
        });
        return;
      }
      setDone(payload as SubmitFeedbackOk);
    } catch (e: any) {
      setRefusal({
        error: e?.message
          || 'Could not reach the server, so nothing was recorded. Your entries are still here — tap Submit again.',
      });
    } finally {
      setSubmitting(false);
    }
  }, [view, submitting, draft]);

  /** Recorded — hand the floor back. The GRE's next table is on the board, and
   *  this screen has nothing left to say. */
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => router.push('/feedback'), 1800);
    return () => clearTimeout(t);
  }, [done, router]);

  /* ── GATE REFUSED ─────────────────────────────────────────────────────── */
  if (denial) {
    return (
      <div className="pb-6">
        <SimpleHead onBack={() => router.push('/feedback')} title="Take Feedback" sub="Access not confirmed" />
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
                <dd className="text-[#2D1B0E] font-bold">{denial.your_role || 'none assigned'}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ── RECORDED ─────────────────────────────────────────────────────────── */
  if (done) {
    return (
      <div className="pb-6">
        <SimpleHead onBack={() => router.push('/feedback')} title="Feedback recorded" sub="Returning to the floor…" />
        <Card className="mt-4 p-4 border-emerald-300 bg-emerald-50/50">
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0">
              <Check className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-extrabold text-[#2D1B0E]">
                {done.duplicate ? 'Already recorded by you' : 'Recorded'}
              </div>
              <div className="mt-1 text-[12px] text-[#6B5744] leading-relaxed">
                {done.duplicate
                  ? 'This table was already taken on your login, so nothing was written twice. '
                    + 'The counts below are the visit that is already on the Tracker.'
                  : 'The visit is on the Tracker and in the reports.'}
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-[#8B7355] font-semibold">Items noted</dt>
                <dd className="text-[#2D1B0E] font-bold">{done.items_recorded}</dd>
                {done.follow_ups_open > 0 ? (
                  <>
                    <dt className="text-[#8B7355] font-semibold">Open follow-ups</dt>
                    <dd className="text-violet-800 font-bold">{done.follow_ups_open}</dd>
                  </>
                ) : null}
                {done.follow_ups_closed > 0 ? (
                  <>
                    <dt className="text-[#8B7355] font-semibold">Closed on submit</dt>
                    <dd className="text-emerald-800 font-bold">{done.follow_ups_closed}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </div>
          <div className="mt-4">
            <PrimaryButton onClick={() => router.push('/feedback')}>Back to floor</PrimaryButton>
          </div>
        </Card>
      </div>
    );
  }

  /* ── STILL LOADING ────────────────────────────────────────────────────── */
  if (loading && !view) {
    return (
      <div className="pb-6">
        <SimpleHead onBack={() => router.push('/feedback')} title="Take Feedback" sub="Loading the order…" />
        <div className="mt-4 flex items-center justify-center gap-2 bg-white border border-[#E8D5C4] rounded-2xl px-4 py-10 text-[13px] text-[#8B7355]">
          <Loader2 className="w-4 h-4 animate-spin" />
          Reading the ordered items…
        </div>
      </div>
    );
  }

  /* ── COULD NOT LOAD ───────────────────────────────────────────────────── */
  // Never an empty form: a GRE who cannot see what the table ordered must not be
  // handed a blank item list that looks like "nothing was ordered".
  if (!view) {
    return (
      <div className="pb-6">
        <SimpleHead onBack={() => router.push('/feedback')} title="Take Feedback" sub="Order not loaded" />
        <Card className="mt-4 p-4 border-red-200 bg-red-50/60">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0 text-[13px] leading-relaxed text-red-800">
              {loadError || 'The order could not be loaded.'}
              <div className="mt-1 text-[12px] text-red-700">
                Nothing has been recorded. This is NOT an empty order.
              </div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => load()}
              disabled={busy}
              className="px-4 py-3 rounded-xl bg-white border border-[#E8D5C4] text-[#6B5744] text-sm font-semibold active:scale-95 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
              Try again
            </button>
            <button
              type="button"
              onClick={() => router.push('/feedback')}
              className="px-4 py-3 rounded-xl bg-[#af4408] text-white text-sm font-semibold active:scale-95"
            >
              Floor board
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const order = view;

  return (
    <div className="pb-28 lg:pb-6">
      {/* Header — a focused task screen, so no tab bar here: the only way out is
          Back, which is what a one-handed 15-second flow wants. `sticky` pins it
          from lg: up; on a phone it scrolls away, because globals.css:211 turns
          <main> into a scroll container below lg: and kills sticky inside it.
          Submit is the control that must survive that, and it does — see
          StickyBar in ../../ui.tsx. */}
      <header className="sticky top-12 lg:top-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 py-2.5 bg-[#FFF8F0]/95 backdrop-blur border-b border-[#E8D5C4] flex items-center gap-2">
        <button
          type="button"
          onClick={() => router.push('/feedback')}
          aria-label="Back to floor"
          className="w-11 h-11 -ml-2 rounded-xl flex items-center justify-center text-[#6B5744] active:scale-95 transition"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-extrabold leading-tight truncate text-[#2D1B0E]">
            Table {order.table_number || '—'} · #{order.order_number}
          </div>
          <div className="text-[11px] text-[#8B7355] leading-tight flex flex-wrap items-center gap-x-2">
            <span className="truncate">{order.floor}</span>
            <span className="inline-flex items-center gap-0.5">
              <Users className="w-3 h-3" />
              {order.covers ?? '—'}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-3 h-3" />
              {/* `elapsed()` takes a non-nullable string and answers '—' for
                  anything it cannot parse, so a null open time needs no branch. */}
              {now === null ? '···' : elapsed(order.opened_at ?? '', now)}
            </span>
            <span className="truncate">Capt. {order.server_name || '—'}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={resetAll}
          aria-label="Clear"
          className="w-11 h-11 rounded-xl flex items-center justify-center text-[#8B7355] active:scale-95 transition"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </header>

      {/* ── THE HAPPY PATH ─────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={everythingGood}
        className="mt-3 w-full rounded-2xl bg-emerald-600 text-white px-4 py-4 text-left active:scale-[0.98] transition"
      >
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <Check className="w-5 h-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-extrabold leading-tight">Everything Good</span>
            <span className="block text-[11px] opacity-90 leading-tight">
              Fills the rating and all four categories — then just Submit
            </span>
          </span>
        </div>
      </button>

      {/* ── OVERALL ────────────────────────────────────────────────────── */}
      <SectionTitle>Overall experience</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {OVERALL_RATINGS.map((r) => {
          const active = overall === r.v;
          const bad = isNegative(r.v);
          return (
            <button
              key={r.v}
              type="button"
              onClick={() => { setOverall(r.v); setOneTap(false); setRefusal(null); }}
              aria-pressed={active}
              className={`h-14 rounded-xl border text-base font-bold active:scale-95 transition ${
                active
                  ? bad
                    ? 'bg-red-600 text-white border-red-600'
                    : 'bg-[#af4408] text-white border-[#af4408]'
                  : 'bg-white text-[#2D1B0E] border-[#E8D5C4]'
              }`}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {/* ── CATEGORIES ─────────────────────────────────────────────────── */}
      <SectionTitle hint="optional">Categories</SectionTitle>
      <div className="space-y-2">
        {CATEGORIES.map((c) => (
          <Card key={c.v} className="px-3 py-2.5 flex items-center gap-2">
            <span className="text-sm font-bold text-[#2D1B0E] w-20 shrink-0">{c.label}</span>
            <div className="flex-1 grid grid-cols-3 gap-1.5">
              {CATEGORY_CHOICES.map((o) => {
                const active = categories[c.v] === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => {
                      setCategories((prev) => ({
                        ...prev,
                        [c.v]: prev[c.v] === o.v ? undefined : (o.v as ItemRating),
                      }));
                      setOneTap(false);
                      setRefusal(null);
                    }}
                    aria-pressed={active}
                    className={`h-11 rounded-lg border text-[12px] font-bold active:scale-95 transition ${
                      active
                        ? isNegative(o.v)
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {/* ── THE ORDERED ITEMS ──────────────────────────────────────────── */}
      {/* These are the lines on THIS order, split Food/Drinks by the server from
          `order_items.station`. If the station is blank or off the menu master
          the item is filed under Food and the note below says so, rather than
          leaving a drink in the wrong list with no explanation. */}
      <SectionTitle hint="tap an item only if there is a problem">
        Food · {food.length}
      </SectionTitle>
      <ItemList items={food} feedback={itemFb} onOpen={setSheetFor} />

      <SectionTitle>Drinks · {drinks.length}</SectionTitle>
      <ItemList items={drinks} feedback={itemFb} onOpen={setSheetFor} />

      {order.unclassified_count > 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-[#D4B896] bg-[#FFF1E3] px-3 py-2 text-[11px] leading-snug text-[#6B5744]">
          <span className="font-bold text-[#af4408]">
            {order.unclassified_count} item{order.unclassified_count === 1 ? '' : 's'} filed under Food ·{' '}
          </span>
          {order.unclassified_reason}
        </div>
      ) : null}

      {order.item_count === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-[#E8D5C4] bg-white px-3 py-3 text-[12px] text-[#8B7355]">
          This order has no items yet. You can still record the overall experience, service and
          ambience.
        </div>
      ) : null}

      {/* ── FOLLOW-UP / REVISIT ────────────────────────────────────────── */}
      {followUpItems.length > 0 && (
        <>
          <SectionTitle hint="stays open until answered">Revisit</SectionTitle>
          <div className="space-y-2">
            {followUpItems.map((i) => {
              const rv = revisits[i.id] || {};
              const closed = closesIssue(rv.happy || '');
              return (
                <Card key={i.id} className="p-3 border-violet-300 bg-violet-50/40">
                  <div className="text-sm font-extrabold text-[#2D1B0E]">{i.name}</div>
                  <div className="text-[11px] text-[#6B5744] mb-2">
                    {ACTIONS_TAKEN.find((a) => a.v === itemFb[i.id]?.action)?.label}
                  </div>

                  <div className="text-[11px] font-bold text-[#6B5744] mb-1">
                    How was the item after replacement/remake?
                  </div>
                  <Scroller>
                    {REVISIT_RATINGS.map((r) => (
                      <Chip
                        key={r.v}
                        active={rv.after === r.v}
                        onClick={() =>
                          setRevisits((p) => ({ ...p, [i.id]: { ...p[i.id], after: r.v } }))
                        }
                      >
                        {r.label}
                      </Chip>
                    ))}
                  </Scroller>

                  <div className="text-[11px] font-bold text-[#6B5744] mt-3 mb-1">
                    Is the Guest Happy Now?
                  </div>
                  <Scroller>
                    {HAPPINESS.map((h) => (
                      <Chip
                        key={h.v}
                        active={rv.happy === h.v}
                        onClick={() =>
                          setRevisits((p) => ({ ...p, [i.id]: { ...p[i.id], happy: h.v } }))
                        }
                      >
                        {h.label}
                      </Chip>
                    ))}
                  </Scroller>

                  {/* The owner's ruling, made visible: only "Yes - Happy"
                      closes. Partially Happy and Still Unhappy stay open for
                      Manager attention. */}
                  <div
                    className={`mt-2 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold ${
                      rv.happy
                        ? closed
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                        : 'bg-[#F0E4D6] text-[#8B7355]'
                    }`}
                  >
                    {rv.happy
                      ? closed
                        ? 'Issue closes on submit.'
                        : 'Issue stays OPEN for Manager attention.'
                      : 'Unanswered — the complaint stays open.'}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ── A REFUSED SUBMIT ───────────────────────────────────────────── */}
      {/* The draft is deliberately kept: a GRE who just typed a complaint must
          not lose it because the server said no. */}
      {refusal ? (
        <Card className="mt-3 p-3 border-red-200 bg-red-50/60">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="min-w-0 text-[12px] leading-relaxed text-red-800">
              <span className="font-bold">Not recorded. </span>
              {refusal.error}
              {refusal.reason === 'already_taken' ? (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => router.push('/feedback/tracker')}
                    className="rounded-lg bg-white border border-red-200 px-3 py-2 text-[12px] font-bold text-red-800 active:scale-95"
                  >
                    Open the Tracker
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {/* ── STICKY SUBMIT ──────────────────────────────────────────────── */}
      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[11px] leading-tight text-[#8B7355]">
            {overall ? (
              <span className="font-extrabold text-[#2D1B0E] text-[13px] block">
                {OVERALL_RATINGS.find((r) => r.v === overall)?.label}
              </span>
            ) : (
              <span className="font-extrabold text-[#8B7355] text-[13px] block">No rating yet</span>
            )}
            {/* An item can be NOTED without being negative — "Same Item Remade"
                with no rating, say. Saying "No item issues" over a noted plate
                would be a small lie on the one screen that exists to stop
                things being missed. */}
            <span className="truncate block">
              {negativeCount > 0
                ? `${negativeCount} item issue${negativeCount === 1 ? '' : 's'}`
                : notedCount > 0
                  ? `${notedCount} item${notedCount === 1 ? '' : 's'} noted`
                  : 'No item issues'}
              {followUpItems.length > 0 ? ` · ${followUpItems.length} follow-up` : ''}
            </span>
          </div>
          <div className="w-40 shrink-0">
            <PrimaryButton onClick={submit} disabled={!canSubmit || submitting}>
              {submitting ? (
                <span className="inline-flex items-center gap-1.5 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                </span>
              ) : (
                'Submit'
              )}
            </PrimaryButton>
          </div>
        </div>
      </StickyBar>

      {/* ── THE ITEM SHEET ─────────────────────────────────────────────── */}
      {sheetFor && (
        <ItemSheet
          item={sheetFor}
          value={itemFb[sheetFor.id] || {}}
          onClose={() => setSheetFor(null)}
          onClear={() => {
            setItemFb((p) => {
              const next = { ...p };
              delete next[sheetFor.id];
              return next;
            });
            setRevisits((p) => {
              const next = { ...p };
              delete next[sheetFor.id];
              return next;
            });
            setSheetFor(null);
          }}
          onSave={(v) => {
            setItemFb((p) => ({ ...p, [sheetFor.id]: v }));
            // A per-item opinion and "Everything Good" cannot both be true.
            setOneTap(false);
            setRefusal(null);
            // Dropping an action that no longer needs a follow-up must also
            // drop its half-answered revisit, or Page 3 would count a
            // follow-up that no item is asking for.
            if (!requiresFollowUp(v.action || '')) {
              setRevisits((p) => {
                const next = { ...p };
                delete next[sheetFor.id];
                return next;
              });
            }
            setSheetFor(null);
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-white border border-[#E8D5C4] rounded-full px-4 py-2 text-sm font-semibold text-[#2D1B0E] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── a header for the states that have no order to describe ──────────────── */

function SimpleHead({ onBack, title, sub }: { onBack: () => void; title: string; sub: string }) {
  return (
    <header className="sticky top-12 lg:top-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 py-2.5 bg-[#FFF8F0]/95 backdrop-blur border-b border-[#E8D5C4] flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to floor"
        className="w-11 h-11 -ml-2 rounded-xl flex items-center justify-center text-[#6B5744] active:scale-95 transition"
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <div className="min-w-0">
        <div className="text-lg font-extrabold leading-tight truncate text-[#2D1B0E]">{title}</div>
        <div className="text-[11px] text-[#8B7355] leading-tight truncate">{sub}</div>
      </div>
    </header>
  );
}

/* ── the item list ───────────────────────────────────────────────────────── */

function ItemList({
  items,
  feedback,
  onOpen,
}: {
  items: FeedbackOrderItem[];
  feedback: Record<string, ItemFeedback>;
  onOpen: (i: FeedbackOrderItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="bg-white border border-dashed border-[#E8D5C4] rounded-2xl px-4 py-5 text-center text-[12px] text-[#8B7355]">
        Nothing in this group.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((i) => {
        const fb = feedback[i.id];
        const noted = isRecordable(fb);
        const bad = isNegative(fb?.rating || '');
        return (
          <button
            key={i.id}
            type="button"
            onClick={() => onOpen(i)}
            className={`w-full text-left bg-white border rounded-2xl px-3 py-3 flex items-center gap-3 active:scale-[0.98] transition ${
              noted ? (bad ? 'border-red-300' : 'border-emerald-300') : 'border-[#E8D5C4]'
            }`}
          >
            <span className="w-9 h-9 rounded-lg bg-[#FFF1E3] text-[#af4408] text-sm font-extrabold flex items-center justify-center shrink-0">
              ×{i.quantity}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-[#2D1B0E] truncate">{i.name}</span>
              <span className="block text-[11px] text-[#8B7355] truncate">
                {noted ? (
                  <>
                    {ITEM_RATINGS.find((r) => r.v === fb?.rating)?.label || 'Noted'}
                    {fb?.issue ? ` · ${ITEM_ISSUES.find((x) => x.v === fb.issue)?.label}` : ''}
                    {fb?.action && fb.action !== 'none'
                      ? ` · ${ACTIONS_TAKEN.find((a) => a.v === fb.action)?.label}`
                      : ''}
                  </>
                ) : (
                  // The station, so the GRE can see WHY a line sits in this
                  // group — blank when the menu item has none set.
                  i.station || 'no station set'
                )}
              </span>
            </span>
            {fb?.comment ? <MessageSquare className="w-4 h-4 text-[#8B7355] shrink-0" /> : null}
            <ChevronRight className="w-4 h-4 text-[#8B7355] shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

/* ── the item sheet ──────────────────────────────────────────────────────── */

/**
 * A bottom sheet, not a full page: the GRE is standing at the table and must
 * not lose the list. z-[60] matches the Captain app's modal layer (above the
 * sticky bars at z-20 and MobileTopBar at z-40).
 */
function ItemSheet({
  item,
  value,
  onSave,
  onClear,
  onClose,
}: {
  item: FeedbackOrderItem;
  value: ItemFeedback;
  onSave: (v: ItemFeedback) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ItemFeedback>(value);
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);

  /**
   * Voice-to-text "where supported" (§3 Mobile UX). Feature-detected: on a
   * browser without the Web Speech API the button is simply not rendered, and
   * the phone keyboard's own mic still works on the textarea. Not a dependency,
   * not a polyfill — `any` because the API has no lib.dom typing.
   */
  const speech = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }, []);

  const dictate = () => {
    if (!speech) return;
    if (listening) {
      try { recogRef.current?.stop(); } catch { /* already stopped */ }
      setListening(false);
      return;
    }
    try {
      const r = new speech();
      r.lang = 'en-IN';
      r.interimResults = false;
      r.onresult = (e: any) => {
        const said = e?.results?.[0]?.[0]?.transcript;
        if (said) setDraft((d) => ({ ...d, comment: `${d.comment ? d.comment + ' ' : ''}${said}` }));
      };
      r.onend = () => setListening(false);
      r.onerror = () => setListening(false);
      recogRef.current = r;
      r.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  useEffect(() => () => { try { recogRef.current?.stop(); } catch { /* noop */ } }, []);

  const needsFollowUp = requiresFollowUp(draft.action || '');

  return (
    // `bg-black/40` sits on the FIXED wrapper, not on the click-catcher inside
    // it, so that globals.css:295 — `body:has(.fixed.inset-0[class*="bg-black/"])
    // { overflow: hidden }` — actually matches and locks the page behind the
    // sheet. On the inner div it would not.
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end justify-center">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl sm:mb-6 max-h-[88vh] flex flex-col">
        <div className="px-4 pt-3 pb-2 border-b border-[#E8D5C4] flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-base font-extrabold text-[#2D1B0E] truncate">{item.name}</div>
            <div className="text-[11px] text-[#8B7355]">
              ×{item.quantity} · {item.group === 'drinks' ? 'Drinks' : 'Food'}
              {item.station ? ` · ${item.station}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-10 h-10 -mr-2 rounded-xl flex items-center justify-center text-[#8B7355] active:scale-95"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 py-3 overflow-y-auto flex-1 space-y-4">
          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#8B7355] mb-1.5">
              Rating
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ITEM_RATINGS.map((r) => {
                const active = draft.rating === r.v;
                return (
                  <button
                    key={r.v}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, rating: r.v }))}
                    aria-pressed={active}
                    className={`h-12 rounded-xl border text-sm font-bold active:scale-95 transition ${
                      active
                        ? isNegative(r.v)
                          ? 'bg-red-600 text-white border-red-600'
                          : 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#8B7355] mb-1.5">
              Issue
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ITEM_ISSUES.map((x) => (
                <Chip
                  key={x.v}
                  active={draft.issue === x.v}
                  onClick={() =>
                    setDraft((d) => ({ ...d, issue: d.issue === x.v ? undefined : x.v }))
                  }
                >
                  {x.label}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-[#8B7355]">
                Comment
              </span>
              {speech && (
                <button
                  type="button"
                  onClick={dictate}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold border active:scale-95 transition ${
                    listening
                      ? 'bg-red-600 text-white border-red-600'
                      : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                  }`}
                >
                  <Mic className="w-3.5 h-3.5" />
                  {listening ? 'Listening…' : 'Speak'}
                </button>
              )}
            </div>
            <textarea
              value={draft.comment || ''}
              onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))}
              rows={3}
              placeholder="Optional — the guest's own words help most"
              className="w-full rounded-xl border border-[#E8D5C4] bg-white px-3 py-2 text-sm text-[#2D1B0E] outline-none focus:border-[#D4B896] resize-none"
            />
          </div>

          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-[#8B7355] mb-1.5">
              Action taken
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ACTIONS_TAKEN.map((a) => {
                const active = draft.action === a.v;
                return (
                  <button
                    key={a.v}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, action: a.v }))}
                    aria-pressed={active}
                    className={`min-h-[48px] px-2 py-2 rounded-xl border text-[12px] font-bold leading-tight active:scale-95 transition ${
                      active
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4]'
                    }`}
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            {needsFollowUp && (
              <div className="mt-2 rounded-lg bg-violet-100 text-violet-800 px-2.5 py-1.5 text-[11px] font-semibold">
                This creates a <strong>Follow-Up Required</strong>. The complaint stays open until
                you revisit the table.
              </div>
            )}
            {/* The replacement item itself is §7 Q3, still open with the owner:
                record WHICH item replaced which, or is the label enough? The
                writer already accepts `replacement_menu_item_id` /
                `replacement_item_name` and stores them, so adding the picker is
                a UI change only — not guessed here. */}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[#E8D5C4] flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="px-3 py-3 rounded-xl border border-[#E8D5C4] text-[#8B7355] text-sm font-semibold active:scale-95"
          >
            Clear
          </button>
          <div className="flex-1">
            <PrimaryButton
              onClick={() => onSave(draft)}
              disabled={!isRecordable(draft)}
            >
              <span className="inline-flex items-center gap-1.5 justify-center">
                <Star className="w-4 h-4" /> Save item
              </span>
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}
