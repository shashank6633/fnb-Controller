'use client';

/**
 * /feedback/take — the landing that keeps the sidebar link honest.
 *
 * WHY THIS FILE EXISTS. Lane A put three things in place that only agree once
 * this page is here:
 *   · `page-catalog.ts` lists `/feedback/take` as a page. It HAS to: `canAccessPage`
 *     grants by prefix (`pathname === p || pathname.startsWith(p + '/')`,
 *     page-catalog.ts:920), so without that entry every `/feedback/take/<orderId>`
 *     would be ungranted.
 *   · `Sidebar.tsx:150` renders it as a nav link labelled "Take Feedback".
 *   · the only route under it was `take/[orderId]`, so that nav link resolved to
 *     a 404 — a dead entry in the sidebar of a module whose whole job is making
 *     sure nothing gets missed.
 *
 * Rather than ask Lane A to drop the link, this makes it mean something. Taking
 * feedback needs a table, so the page asks which one — showing exactly the
 * tables that are due, and nothing else. A GRE who opens the module from the
 * sidebar instead of the floor board lands on the same work, one tap away.
 *
 * ── WHAT CHANGED IN P3 LANE B ───────────────────────────────────────────────
 * It was rendering `../placeholder.ts` — SEVEN INVENTED TABLES with invented
 * order ids — behind a "P1 SHELL" note. On a module whose entire purpose is
 * coverage, a list of fake tables is not a harmless placeholder: tapping one
 * routes to `/feedback/take/<an id that does not exist>`, and a GRE reading
 * "3 tables waiting" on a quiet night is being told the opposite of the truth.
 * It now reads the SAME `GET /api/feedback/floor` the board does, filtered to
 * the two statuses that are actually work (`due`, `follow_up`), and it prints
 * the same refusal body verbatim when the gate says no — because an empty list
 * and a denied list must never look alike here.
 *
 * Read-only, like every screen in this module: it renders a list and routes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Utensils, Clock, ChevronRight, Lock, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { GRE_ROLE_NAME, STATUS_STYLE, statusLabel } from '@/lib/feedback';
import type { FloorMeta, FloorRow } from '@/lib/feedback/read';
import { EmptyState, PageBody, PageHead, StickyBar, elapsed } from '../ui';

interface FloorPayload {
  tables: FloorRow[];
  meta: FloorMeta;
  viewer: { name: string; role_name: string | null; read_only: boolean; scope: string };
}

/** The refusal body `requireFeedbackReader()` returns. `what_to_do` is printed
 *  verbatim — the live trap is "role created but never ASSIGNED", which looks
 *  exactly like a broken page unless the screen names the missing step. */
interface Denial {
  error: string;
  reason: string;
  your_role?: string | null;
  what_to_do?: string;
}

export default function TakeFeedbackLandingPage() {
  const router = useRouter();

  const [data, setData] = useState<FloorPayload | null>(null);
  const [denial, setDenial] = useState<Denial | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /** Filled after mount: elapsed times derive from `Date.now()`, which differs
   *  between the server render and the client one. */
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

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
  }, [load]);

  // Only the tables that actually want a visit. "Not Ready" has nothing to
  // record yet, and a table already taken is not work — it is history, and it
  // lives on the Tracker. The server's ranking is preserved: `filter` keeps
  // order, and that order already puts follow-ups first.
  const waiting = useMemo(
    () => (data?.tables ?? []).filter((t) => t.status === 'due' || t.status === 'follow_up'),
    [data?.tables],
  );

  if (denial) {
    return (
      <>
        <PageHead title="Take Feedback" subtitle="Access not confirmed" />
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
        title="Take Feedback"
        subtitle={
          loading
            ? 'Loading the floor…'
            : waiting.length
              ? `${waiting.length} table${waiting.length === 1 ? '' : 's'} waiting — pick one`
              : 'Nothing waiting right now'
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
            {error} — the list could not be loaded, so this is NOT an empty floor. Tap refresh.
          </div>
        ) : null}

        <div className="pt-3 space-y-2">
          {waiting.map((t) => (
            <button
              key={t.order_id}
              type="button"
              onClick={() => router.push(`/feedback/take/${t.order_id}`)}
              className="w-full text-left bg-white border border-[#E8D5C4] rounded-2xl p-4 active:scale-[0.98] hover:border-[#D4B896] transition"
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
                  {now === null || !t.opened_at ? '···' : elapsed(t.opened_at, now)}
                </span>
                <span className="ml-auto inline-flex items-center gap-0.5 font-bold text-[#af4408]">
                  {t.status === 'follow_up' ? 'Revisit' : 'Take feedback'}
                  <ChevronRight className="w-4 h-4" />
                </span>
              </div>
            </button>
          ))}
        </div>

        {!loading && waiting.length === 0 ? (
          <EmptyState>
            Every eligible table has been covered. The floor board shows the rest.
          </EmptyState>
        ) : null}
      </PageBody>

      <StickyBar>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] leading-tight">
            <div className="font-extrabold text-[#2D1B0E]">{waiting.length} waiting</div>
            <div className="text-[#8B7355] truncate">Pick a table to record against</div>
          </div>
          <button
            type="button"
            onClick={() => router.push('/feedback')}
            className="shrink-0 bg-[#af4408] text-white px-4 py-3 rounded-xl text-sm font-semibold active:scale-95 transition"
          >
            Floor board
          </button>
        </div>
      </StickyBar>
    </>
  );
}
