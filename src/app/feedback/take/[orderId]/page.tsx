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
 * 🔒 READ-ONLY. Every control here writes to this module's own draft state. The
 * screen shows the ordered items and cannot change one: no quantity stepper, no
 * remove, no add, no fire, no reprint. "Item Cancelled" and "Fresh Item
 * Replaced" are *records of what the kitchen did*, not commands — P3 writes them
 * to `gf_*` only, never to `order_items`. The actual enforcement is P2's
 * server-side deny (P0 Lane A: `PATCH /api/dine-in/orders/[id]` currently gates
 * on nothing but a session).
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
} from 'lucide-react';
import {
  ACTIONS_TAKEN, CATEGORIES, HAPPINESS, ITEM_ISSUES, ITEM_RATINGS, OVERALL_RATINGS,
  REVISIT_RATINGS, closesIssue, isNegative, requiresFollowUp,
  type ActionTaken, type Category, type Happiness, type ItemIssue, type ItemRating,
  type OverallRating,
} from '@/lib/feedback';
import { TAKE_ORDER, type TakeItem } from '../../placeholder';
import { Card, Chip, PlaceholderNote, PrimaryButton, Scroller, SectionTitle, StickyBar, elapsed } from '../../ui';

/** What the GRE has recorded against one ordered line. All fields optional —
 *  that is the point of the screen. */
interface ItemFeedback {
  rating?: ItemRating;
  issue?: ItemIssue;
  comment?: string;
  action?: ActionTaken;
}

/** The revisit, asked only for items whose action forces a follow-up. */
interface Revisit {
  after?: string;
  happy?: Happiness;
}

const CATEGORY_CHOICES = ITEM_RATINGS; // Good · Average · Poor, the same three

export default function TakeFeedbackPage() {
  const router = useRouter();
  const params = useParams<{ orderId: string }>();
  const orderId = typeof params?.orderId === 'string' ? params.orderId : '';

  // P3: `api('/api/feedback/order/' + orderId)` — a read-only projection of the
  // order with its items already split Food/Drinks by `stationKdsSection()`.
  const order = TAKE_ORDER;

  const [overall, setOverall] = useState<OverallRating | null>(null);
  const [categories, setCategories] = useState<Partial<Record<Category, ItemRating>>>({});
  const [itemFb, setItemFb] = useState<Record<string, ItemFeedback>>({});
  const [revisits, setRevisits] = useState<Record<string, Revisit>>({});
  const [sheetFor, setSheetFor] = useState<TakeItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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

  const food = useMemo(() => order.items.filter((i) => i.group === 'food'), [order.items]);
  const drinks = useMemo(() => order.items.filter((i) => i.group === 'drinks'), [order.items]);

  /** THE 10-SECOND PATH. One tap sets everything the happy case needs and
   *  clears any half-entered detail, so a mis-tap cannot leave a stray "Poor"
   *  on an item while the header says Excellent. */
  const everythingGood = useCallback(() => {
    setOverall('excellent');
    setCategories({ food: 'good', drinks: 'good', service: 'good', ambience: 'good' });
    setItemFb({});
    setRevisits({});
    flash('Everything Good — ready to submit');
  }, [flash]);

  const resetAll = useCallback(() => {
    setOverall(null);
    setCategories({});
    setItemFb({});
    setRevisits({});
  }, []);

  /** Items whose recorded action forces a Follow-Up Required and holds the
   *  complaint open — the rule lives in enums.ts so Pages 1, 3 and 4 cannot
   *  each decide it differently. */
  const followUpItems = useMemo(
    () => order.items.filter((i) => requiresFollowUp(itemFb[i.id]?.action || '')),
    [order.items, itemFb],
  );

  const negativeCount = useMemo(
    () => order.items.filter((i) => isNegative(itemFb[i.id]?.rating || '')).length,
    [order.items, itemFb],
  );

  const canSubmit = overall !== null || Object.keys(itemFb).length > 0;

  const submit = () => {
    // P3 wires `api('/api/feedback', { method: 'POST', body: {...} })`. Writing
    // it now would mean writing it twice, and the endpoint does not exist.
    flash('Shell only — P3 wires POST /api/feedback');
  };

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
            Table {order.table_number} · #{order.order_number}
          </div>
          <div className="text-[11px] text-[#8B7355] leading-tight flex flex-wrap items-center gap-x-2">
            <span className="truncate">{order.floor}</span>
            <span className="inline-flex items-center gap-0.5">
              <Users className="w-3 h-3" />
              {order.covers ?? '—'}
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-3 h-3" />
              {now === null ? '···' : elapsed(order.opened_at, now)}
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
              onClick={() => setOverall(r.v)}
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
                    onClick={() =>
                      setCategories((prev) => ({
                        ...prev,
                        [c.v]: prev[c.v] === o.v ? undefined : (o.v as ItemRating),
                      }))
                    }
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
      <SectionTitle hint="tap an item only if there is a problem">
        Food · {food.length}
      </SectionTitle>
      <ItemList items={food} feedback={itemFb} onOpen={setSheetFor} />

      <SectionTitle>Drinks · {drinks.length}</SectionTitle>
      <ItemList items={drinks} feedback={itemFb} onOpen={setSheetFor} />

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

      <PlaceholderNote>
        Routed for order <code>{orderId || '(none)'}</code>, but the order and items below come from{' '}
        <code>../../placeholder.ts</code>. Nothing submits yet: P3 adds <code>POST /api/feedback</code>{' '}
        and the <code>gf_</code> tables, and derives Food vs Drinks server-side from{' '}
        <code>order_items.station</code> via <code>stationKdsSection()</code>.
      </PlaceholderNote>

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
            <span className="truncate block">
              {negativeCount > 0 ? `${negativeCount} item issue${negativeCount === 1 ? '' : 's'}` : 'No item issues'}
              {followUpItems.length > 0 ? ` · ${followUpItems.length} follow-up` : ''}
            </span>
          </div>
          <div className="w-40 shrink-0">
            <PrimaryButton onClick={submit} disabled={!canSubmit}>
              Submit
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

/* ── the item list ───────────────────────────────────────────────────────── */

function ItemList({
  items,
  feedback,
  onOpen,
}: {
  items: TakeItem[];
  feedback: Record<string, ItemFeedback>;
  onOpen: (i: TakeItem) => void;
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
        const bad = isNegative(fb?.rating || '');
        return (
          <button
            key={i.id}
            type="button"
            onClick={() => onOpen(i)}
            className={`w-full text-left bg-white border rounded-2xl px-3 py-3 flex items-center gap-3 active:scale-[0.98] transition ${
              fb ? (bad ? 'border-red-300' : 'border-emerald-300') : 'border-[#E8D5C4]'
            }`}
          >
            <span className="w-9 h-9 rounded-lg bg-[#FFF1E3] text-[#af4408] text-sm font-extrabold flex items-center justify-center shrink-0">
              ×{i.quantity}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-[#2D1B0E] truncate">{i.name}</span>
              <span className="block text-[11px] text-[#8B7355] truncate">
                {fb ? (
                  <>
                    {ITEM_RATINGS.find((r) => r.v === fb.rating)?.label || 'Noted'}
                    {fb.issue ? ` · ${ITEM_ISSUES.find((x) => x.v === fb.issue)?.label}` : ''}
                    {fb.action && fb.action !== 'none'
                      ? ` · ${ACTIONS_TAKEN.find((a) => a.v === fb.action)?.label}`
                      : ''}
                  </>
                ) : (
                  i.station
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
  item: TakeItem;
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
              ×{item.quantity} · {item.group === 'food' ? 'Food' : 'Drinks'} · {item.station}
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
                record WHICH item replaced which, or is the label enough? Not
                guessed here — P3 adds the picker if he says record it. */}
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
              disabled={!draft.rating && !draft.issue && !draft.comment && !draft.action}
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
