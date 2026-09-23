'use client';

/**
 * BILL HANDOVER TO ACCOUNTS — THE STORE'S REGISTER
 * ================================================
 *
 * The owner's words for what this is for:
 *   "This will create a proper audit trail and prevent situations where there is
 *    confusion about whether a vendor bill was actually handed over to the
 *    Accounts department."
 *
 * So the whole screen is built around ONE question a Store Manager must be able
 * to answer at a glance: DID WE HAND THAT BILL OVER? Three tiles answer it for
 * the whole month; the search box answers it for one bill; every row carries the
 * two timestamps that are the actual evidence — when the store submitted it and
 * when Accounts confirmed they had it.
 *
 * ── THE FOUR THINGS ON SCREEN, AND WHY EACH IS SEPARATE ───────────────────
 *
 *  1. PENDING SUBMISSION — recorded, still in the store's hands.
 *  2. SUBMITTED - AWAITING ACCOUNTS CONFIRMATION — the store says it handed it
 *     over; Accounts have not said they got it. This is the only state in which
 *     the two departments can disagree, which is exactly the confusion the owner
 *     described, so it is a tile of its own and never merged with Pending.
 *  3. RECEIVED BY ACCOUNTS — both names, both timestamps, closed.
 *  4. NOT YET RECORDED — a goods receipt on/after the start date with NO bill
 *     record at all. IT IS DELIBERATELY NOT PART OF "PENDING", and that is a
 *     structural decision, not a cosmetic one: Pending is a pure read of rows
 *     that were deliberately created, so the 2,121 historical purchase rows with
 *     no bill identity CANNOT surface in it. Folding this in would make Pending
 *     a derived query over goods_receipt_notes, and a derived Pending is the one
 *     mechanism by which the day-one backlog the owner pre-empted could ever
 *     appear. It is the leak detector for a receipt whose store person never
 *     answered the quality-check prompt, and it is fixable from here in one tap.
 *
 * ── WHERE THE RECORD NORMALLY COMES FROM ──────────────────────────────────
 * Not from this page. It is created by answering the question inside the store
 * quality check at the delivery door (components/BillHandoverCheck.tsx), on both
 * receiving doors. Manual entry lives here as the FALLBACK the brief asks for —
 * "a bill that arrived without a purchase behind it" — and is labelled as such,
 * because a store person retyping a number the system already knows is how the
 * two copies come to disagree.
 *
 * ── WHAT THIS REGISTER DOES NOT COVER ─────────────────────────────────────
 * · Bills received before the recorded start date. Stated at the top of the
 *   screen in the server's own words, so nobody hunts for last month's bills.
 * · Liquor / TGBCL. Measured on the live data: 62 purchase rows in store-routed
 *   categories, ZERO with a goods receipt behind them — liquor inward runs on
 *   its own rail (Inventory → Liquor Store). Said on the face of the page rather
 *   than left to be discovered, because a register that looks complete and is
 *   not is worse than one that admits its edge.
 *
 * ── GATING ────────────────────────────────────────────────────────────────
 * Every API route self-gates (src/proxy.ts guards PAGES, not APIs, and
 * canAccessPage fails open four ways — on the live data role_id is set on 0 of 9
 * users and page_access is NULL on 8 of 9, so page gating is effectively inert).
 * This page mirrors the server's answer only to render the right buttons and a
 * readable refusal; it is not the boundary and does not pretend to be.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Receipt,
  Loader2,
  RefreshCw,
  Search,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Hourglass,
  BadgeCheck,
  ShieldAlert,
  Plus,
  X,
  FileWarning,
  Paperclip,
  Download,
  History,
  Ban,
  IndianRupee,
} from 'lucide-react';
import { api } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import {
  BH_PENDING,
  BH_RECEIVED,
  BH_STATUS_LABEL,
  BH_STATUS_SHORT,
  BH_STATUS_TONE,
  BH_STATUS_WASH,
  BH_SUBMITTED,
  BH_VOID,
  attachBillScan,
  bhReadError,
  bhRupees,
  type BhCutoff,
  type BillHandoverStatus,
} from '@/lib/bill-handover-client';
/* The SAME banner the Accounts screen renders, not a second copy of the advice.
   The wording of "create a role named exactly Accounts, tier Staff, tick at
   least one page" is load-bearing config guidance, and two screens paraphrasing
   it apart is how the owner ends up following whichever one he happened to open. */
import { AccountsRoleBanner, type AccountsRoleState } from './_components/bill-handover-ui';

/* ── shapes the API hands back ─────────────────────────────────────────── */

interface Row {
  id: string;
  source: string;
  grn_id: string | null;
  grn_number: string;
  invoice_id: string;
  bill_no: string;
  vendor_name: string;
  bill_date: string;
  received_date: string;
  bill_value: number;
  status: BillHandoverStatus;
  created_by_name: string;
  created_at: string;
  submitted_by_name: string;
  submitted_at: string | null;
  confirmed_by_name: string;
  confirmed_at: string | null;
  voided_by_name: string;
  voided_at: string | null;
  void_reason: string;
  note: string;
  attachment_count?: number;
}

interface TrailRow {
  id: string;
  action: string;
  from_status: string;
  to_status: string;
  actor_name: string;
  actor_role: string;
  note: string;
  at: string;
}

interface Summary {
  cutoff: BhCutoff;
  counts: Record<BillHandoverStatus, number>;
  values: Record<BillHandoverStatus, number>;
  not_yet_recorded: number;
  oldest_pending_date: string | null;
  oldest_submitted_date: string | null;
  /* Shipped by GET /api/bill-submissions/summary for exactly this purpose — the
     diagnosis behind the missing-role banner. It was already on the wire and
     this screen was the one place not reading it. */
  accounts_role?: AccountsRoleState;
  can?: { record?: boolean; confirm?: boolean };
}

interface Unrecorded {
  id: string;
  grn_number: string;
  date: string;
  vendor: string;
  bill_no: string;
  bill_value: number;
}

type Tab = 'open' | typeof BH_PENDING | typeof BH_SUBMITTED | typeof BH_RECEIVED | typeof BH_VOID | 'all';

const PAGE_SIZE = 50;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function BillSubmissionsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [unrecorded, setUnrecorded] = useState<Unrecorded[]>([]);
  const [tab, setTab] = useState<Tab>('open');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null); // a 401/403 sentence
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [trail, setTrail] = useState<Record<string, TrailRow[]>>({});
  const [showManual, setShowManual] = useState(false);

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  };

  const canRecord = summary?.can?.record === true;

  /* ── loads ─────────────────────────────────────────────────────────────── */

  const loadSummary = useCallback(async () => {
    const r = await api('/api/bill-submissions/summary');
    if (r.status === 401 || r.status === 403) {
      setGate(await bhReadError(r, 'You cannot view the bill register.'));
      return null;
    }
    if (!r.ok) {
      setError(await bhReadError(r, 'Could not load the dashboard.'));
      return null;
    }
    const j = (await r.json()) as Summary;
    setSummary(j);
    setGate(null);
    return j;
  }, []);

  const loadRows = useCallback(async () => {
    const sp = new URLSearchParams();
    sp.set('status', tab);
    sp.set('page', String(page));
    sp.set('pageSize', String(PAGE_SIZE));
    if (q.trim()) sp.set('q', q.trim());
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    // 'all' means all the LIVE ones server-side; voided rows are audit and are
    // reached through their own tab, so the flag rides with that tab only.
    if (tab === BH_VOID) sp.set('include_void', '1');
    const r = await api(`/api/bill-submissions?${sp}`);
    if (r.status === 401 || r.status === 403) {
      setGate(await bhReadError(r, 'You cannot view the bill register.'));
      return;
    }
    if (!r.ok) {
      setError(await bhReadError(r, 'Could not load the bill list.'));
      return;
    }
    const j = (await r.json()) as { rows: Row[]; total: number };
    setRows(Array.isArray(j.rows) ? j.rows : []);
    setTotal(Number(j.total) || 0);
    setError(null);
  }, [tab, page, q, from, to]);

  /* The leak detector. Store-side only — the route refuses an Accounts-role
     holder, which is correct: it is a list of work for the store. A 403 here is
     an answer, not an error, so it silently empties instead of shouting. */
  const loadUnrecorded = useCallback(async () => {
    const r = await api('/api/bill-submissions/unrecorded?limit=100');
    if (!r.ok) {
      setUnrecorded([]);
      return;
    }
    const j = (await r.json()) as { rows: Unrecorded[] };
    setUnrecorded(Array.isArray(j.rows) ? j.rows : []);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const s = await loadSummary();
      if (!s) return;
      await loadRows();
      if (s.can?.record) await loadUnrecorded();
      else setUnrecorded([]);
    } finally {
      setLoading(false);
    }
  }, [loadSummary, loadRows, loadUnrecorded]);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filters change → refetch the list only (the tiles are unaffected by them,
  // and a dashboard that moved when you typed in the search box would be lying
  // about the month).
  useEffect(() => {
    if (gate) return;
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, page, from, to]);

  // Debounced search — the same list call, 350ms after the last keystroke.
  useEffect(() => {
    if (gate) return;
    const t = setTimeout(() => {
      setPage(1);
      loadRows();
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  /* ── actions ───────────────────────────────────────────────────────────── */

  /**
   * "SUBMITTED TO ACCOUNTS" — the one action the whole feature turns on.
   *
   * The confirmation is deliberately explicit that this is a claim about a piece
   * of PAPER and not about money. "Submitted" next to a rupee figure reads like
   * a payment to anyone skimming, and a register where half the staff think
   * "Submitted" means "paid" is worse than no register.
   */
  async function markSubmitted(row: Row) {
    const ok = window.confirm(
      `Mark bill ${row.bill_no || row.grn_number || 'this bill'} from ${row.vendor_name || 'this vendor'} ` +
        `(${bhRupees(row.bill_value)}) as HANDED OVER to the Accounts team?\n\n` +
        'This records that the physical or digital bill has gone to Accounts, stamped with your name ' +
        'and the time. It is NOT a payment and it does not approve or settle anything.\n\n' +
        'Accounts then confirm they received it, and their name and time are stamped too.',
    );
    if (!ok) return;
    setBusy(row.id);
    try {
      const r = await api(`/api/bill-submissions/${row.id}/submit`, { method: 'POST', body: {} });
      if (!r.ok) {
        flash(await bhReadError(r, 'Could not mark that bill as submitted.'));
        return;
      }
      flash(`Bill ${row.bill_no || row.grn_number} marked submitted to Accounts.`);
      await Promise.all([loadSummary(), loadRows()]);
      if (openRow === row.id) await loadTrail(row.id, true);
    } finally {
      setBusy(null);
    }
  }

  /** Withdraw a record. VOID WITH A REASON — there is no delete verb anywhere in
   *  this module, because a deleted record turns "we can prove what happened"
   *  back into "we think we remember". */
  async function voidRow(row: Row) {
    const reason = window.prompt(
      `Withdraw the record for bill ${row.bill_no || row.grn_number || ''}?\n\n` +
        'The record is NOT deleted — it stays visible as voided, with your name, the time and this ' +
        'reason on it. Give the reason:',
      '',
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      flash('A reason of at least 3 characters is required to void a record.');
      return;
    }
    setBusy(row.id);
    try {
      const r = await api(`/api/bill-submissions/${row.id}/void`, {
        method: 'POST',
        body: { reason: reason.trim() },
      });
      if (!r.ok) {
        flash(await bhReadError(r, 'Could not void that record.'));
        return;
      }
      flash('Record voided. It stays in the register as audit.');
      await Promise.all([loadSummary(), loadRows(), loadUnrecorded()]);
    } finally {
      setBusy(null);
    }
  }

  /** One tap to fix a delivery whose bill was never recorded. Identity is read
   *  from the goods receipt server-side — nothing is retyped here either. */
  async function recordUnrecorded(u: Unrecorded) {
    setBusy(u.id);
    try {
      const r = await api('/api/bill-submissions', {
        method: 'POST',
        body: { grn_id: u.id },
      });
      if (!r.ok) {
        flash(await bhReadError(r, 'Could not record that bill.'));
        return;
      }
      flash(`${u.grn_number} recorded as "${BH_STATUS_LABEL[BH_PENDING]}".`);
      await Promise.all([loadSummary(), loadRows(), loadUnrecorded()]);
    } finally {
      setBusy(null);
    }
  }

  async function loadTrail(id: string, force = false) {
    if (trail[id] && !force) return;
    const r = await api(`/api/bill-submissions/${id}`);
    if (!r.ok) return;
    const j = (await r.json()) as { trail: TrailRow[] };
    setTrail(t => ({ ...t, [id]: Array.isArray(j.trail) ? j.trail : [] }));
  }

  async function addScan(row: Row, f: File | null) {
    if (!f) return;
    setBusy(row.id);
    try {
      const res = await attachBillScan(row.id, f);
      flash(res.message);
      if (res.ok) await loadRows();
    } finally {
      setBusy(null);
    }
  }

  function downloadCsv() {
    const header = [
      'Bill No',
      'Vendor',
      'Bill Value',
      'Received (date)',
      'Bill date',
      'GRN',
      'Store submitted by',
      'Store submitted at (IST)',
      'Accounts confirmed by',
      'Accounts confirmed at (IST)',
      'Status',
      'Source',
      'Note',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.bill_no,
          r.vendor_name,
          r.bill_value,
          r.received_date,
          r.bill_date,
          r.grn_number,
          r.submitted_by_name,
          r.submitted_at ? fmtIST(r.submitted_at) : '',
          r.confirmed_by_name,
          r.confirmed_at ? fmtIST(r.confirmed_at) : '',
          BH_STATUS_LABEL[r.status] ?? r.status,
          r.source,
          r.note,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bill-handover-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── render ────────────────────────────────────────────────────────────── */

  const counts = summary?.counts;
  const values = summary?.values;
  const cutoff = summary?.cutoff;

  /* ── WHAT AN EMPTY LIST ACTUALLY MEANS ─────────────────────────────────────
     "No rows came back" has FOUR different meanings on this screen, and the one
     it must never be confused with is the all-clear. A register whose entire job
     is to say "that bill has NOT been handed over" may not open with a green
     tick and the words "every recorded bill has been confirmed" when it holds no
     bills at all — on day one that sentence is a lie told to the one person
     whose job it is to notice. So the four are separated here, from `counts`
     (the whole register, unaffected by the filters) rather than from `rows` (one
     filtered page of it):

       · the search/date boxes are filtering       -> a FILTER result
       · the register holds nothing at all          -> EMPTY, not clear
       · it holds bills and none is open            -> the genuine all-clear
       · this one tab is empty                      -> say which tab

     `counts` is undefined only while the summary has not loaded or has failed.
     Unknown is NOT clear: every claim below requires counts to be present. */
  const filtersOn = !!(q.trim() || from || to);
  /* UNKNOWN IS NOT CLEAR, AND IT HAS ITS OWN BRANCH.
     The note above says "every claim below requires counts to be present", and
     without this that was not true of the chain that implements it. When the
     summary call fails (loadSummary setErrors and returns null, loadAll then
     returns BEFORE loadRows, so rows stays []) every count is undefined:
     recordedTotal is null so registerEmpty is false, openTotal is null so
     genuineAllClear is false — and the chain fell through to the voided-only
     branch, which stated "No bill is waiting on the store or on Accounts" over
     "the 0 records in this register are voided". Both are claims about a
     register nothing had been read from, and the first of them is the all-clear
     this screen may never show. So the unknown case is named and answered. */
  const countsUnknown = !counts;
  const recordedTotal = counts
    ? (counts[BH_PENDING] ?? 0) +
      (counts[BH_SUBMITTED] ?? 0) +
      (counts[BH_RECEIVED] ?? 0) +
      (counts[BH_VOID] ?? 0)
    : null;
  const openTotal = counts ? (counts[BH_PENDING] ?? 0) + (counts[BH_SUBMITTED] ?? 0) : null;
  const registerEmpty = recordedTotal === 0;
  /* The ONLY condition under which the words "confirmed by Accounts" may appear:
     the register holds bills, none is open, and at least one was actually
     confirmed. A register holding nothing but voided rows is not an all-clear
     either, and falls through to the neutral sentence. */
  const genuineAllClear = openTotal === 0 && (counts?.[BH_RECEIVED] ?? 0) > 0;

  const tabs: { k: Tab; label: string; n?: number }[] = useMemo(
    () => [
      {
        k: 'open',
        label: 'Still open',
        n: (counts?.[BH_PENDING] ?? 0) + (counts?.[BH_SUBMITTED] ?? 0),
      },
      { k: BH_PENDING, label: BH_STATUS_SHORT[BH_PENDING], n: counts?.[BH_PENDING] },
      { k: BH_SUBMITTED, label: BH_STATUS_SHORT[BH_SUBMITTED], n: counts?.[BH_SUBMITTED] },
      { k: BH_RECEIVED, label: BH_STATUS_SHORT[BH_RECEIVED], n: counts?.[BH_RECEIVED] },
      { k: 'all', label: 'All live', n: undefined },
      { k: BH_VOID, label: 'Voided', n: counts?.[BH_VOID] },
    ],
    [counts],
  );

  if (gate) {
    return (
      <div className="max-w-lg mx-auto p-6 text-center">
        <ShieldAlert className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
        <p className="font-bold text-[#2D1B0E]">Store team and Accounts only</p>
        <p className="text-sm text-[#8B7355] mt-1">{gate}</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4 pb-24">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Receipt className="w-6 h-6 text-[#af4408]" /> Bill Handover to Accounts
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5 max-w-3xl">
            Every vendor bill the store has received, and whether it has actually reached the
            Accounts team. The two timestamps on each row — <b>when the store submitted it</b> and{' '}
            <b>when Accounts confirmed they had it</b> — are the record, so there is never a question
            about whether a bill was handed over.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canRecord && (
            <button
              onClick={() => setShowManual(true)}
              className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2"
              title="Fallback for a bill that arrived with no goods receipt behind it"
            >
              <Plus className="w-4 h-4" /> Add a bill by hand
            </button>
          )}
          <button
            onClick={downloadCsv}
            disabled={rows.length === 0}
            className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
            title="Download the rows currently listed"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
          <button
            onClick={loadAll}
            className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* ── WHERE THIS REGISTER STARTS ───────────────────────────────────────
          The owner: "DONT NEED TO REVIEW ANY PAST BILLS FROM THE NEXT DAY OF
          DEPLOYMENT". `notice` is the server's own sentence, rendered verbatim
          so the screens and the API cannot state the rule two ways. It is at the
          TOP, before any count, because an empty-looking register on day one is
          the first thing that would be read as broken. */}
      {cutoff && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs leading-snug flex items-start gap-2 ${
            cutoff.ready
              ? 'border-[#D4B896] bg-[#FFF8F0] text-[#6B5744]'
              : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}
        >
          <Clock className="w-4 h-4 mt-0.5 shrink-0 text-[#8B7355]" />
          <div>
            <div>{cutoff.notice}</div>
            {cutoff.ready && cutoff.committed_at && (
              <div className="text-[10px] text-[#8B7355] mt-0.5">
                Start date recorded once, on {fmtIST(cutoff.committed_at)}, and it does not move.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── IS THERE ANYBODY TO CONFIRM ANY OF THIS? ─────────────────────────
          The day-one failure this closes: the Store Manager submits bills, the
          middle tile climbs, the right-hand tile stays at zero forever, and
          nothing on his screen says why. On the live data there is no role named
          "Accounts" at all (role_id is set on 0 of 9 users), so until the owner
          creates one, only an Administrator can confirm.

          This is the SAME component the Accounts screen renders, deliberately —
          the instruction "named exactly Accounts, tier Staff, and tick at least
          one page" is config advice that must not exist in two wordings. It
          renders nothing at all once the role exists, is active and is spelled
          right, so it is not a permanent banner.

          It sits ABOVE the tiles because the tiles are what prompt the question. */}
      <AccountsRoleBanner
        state={summary?.accounts_role ?? null}
        viewerCanConfirm={summary?.can?.confirm === true}
      />
      {/* ── WHY YOUR SUBMITTED BILLS ARE SITTING THERE ──────────────────────
         The banner above is written for whoever can FIX it (Settings → Roles).
         A Store Manager cannot: he has no Settings → Roles, and the banner's
         instructions are not addressed to him. What he needs is the sentence
         about HIS screen — why the middle tile climbs and the right-hand one
         never moves — and it must name the role and the place, because "ask an
         administrator" with no name attached is how a day-one question goes
         unasked for a week.

         TWO SHAPES OF THE SAME DAY-ONE FAILURE, and the second one used to be
         silent:
           (a) NO Accounts role exists (his database today: nine roles, none of
               them Accounts). The big amber banner is already on screen saying
               how to create it; this adds what it means for his own bills.
           (b) The role EXISTS but nobody is confirming — most likely because it
               has not been assigned to anyone in Settings → Users. Nothing on
               this screen said a word about that case, and it looks identical
               to (a) from the store's side: bills submitted, nothing confirmed,
               no explanation. `accounts_role` cannot tell us whether anyone
               HOLDS the role, so this speaks only to what is actually visible —
               bills are waiting — and names the two things to check.

         Shown only to someone who cannot confirm: an admin reading this can
         already close the bills himself. */}
      {summary?.accounts_role &&
        summary.can?.confirm !== true &&
        (!summary.accounts_role.exists || (counts?.[BH_SUBMITTED] ?? 0) > 0) && (
          <div className="rounded-lg border border-[#D4B896] bg-[#FFF8F0] px-3 py-2 text-xs leading-snug text-[#6B5744] flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-[#8B7355]" />
            <span>
              {!summary.accounts_role.exists ? (
                <>
                  <b>
                    There is no &ldquo;Accounts&rdquo; role in this system yet, so nobody but an
                    Administrator can confirm a bill.
                  </b>{' '}
                  {/* {' '} NOT a literal space. Measured in the rendered DOM at
                      390px: the source had `</b> stays`, and what reached the
                      screen was `<b>Submitted to Accounts</b>stays at` — the
                      compiler dropped the space where the text node began after
                      a tag and ended in a newline. The rest of this block
                      already uses the explicit form for exactly this reason. */}
                  Until it exists, every bill you mark <b>Submitted to Accounts</b>{' '}
                  stays at &ldquo;{BH_STATUS_LABEL[BH_SUBMITTED]}&rdquo;
                  {(counts?.[BH_SUBMITTED] ?? 0) > 0 && (
                    <>
                      {' '}
                      — <b>{counts?.[BH_SUBMITTED]}</b> already{' '}
                      {(counts?.[BH_SUBMITTED] ?? 0) === 1 ? 'is' : 'are'} waiting
                    </>
                  )}
                  . Nothing is lost: your name and the time you handed it over are already on the
                  record and they do not move.{' '}
                  <b>
                    Ask an administrator to create a role named exactly &ldquo;Accounts&rdquo; in
                    Settings → Roles
                  </b>{' '}
                  and assign it to your accounts person in <b>Settings → Users</b>. This note
                  disappears on its own once that is done.
                </>
              ) : (
                <>
                  <b>
                    {counts?.[BH_SUBMITTED]} bill
                    {(counts?.[BH_SUBMITTED] ?? 0) === 1 ? ' is' : 's are'} waiting for Accounts to
                    confirm.
                  </b>{' '}
                  That is Accounts&rsquo; half of the handover — you cannot close it yourself, and
                  you are not meant to. If nothing is being confirmed, there are only two things to
                  check, both in Settings: that somebody is actually holding the
                  &ldquo;{summary.accounts_role.stored_name || 'Accounts'}&rdquo; role in{' '}
                  <b>Settings → Users</b>, and that they can reach{' '}
                  <b>Purchasing → Bill Handover — Accounts</b>. An Administrator can also confirm in
                  the meantime. Your submission stamp stands either way.
                </>
              )}
            </span>
          </div>
        )}

      {/* ── The dashboard: three states, plus the leak detector ───────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          label={BH_STATUS_LABEL[BH_PENDING]}
          n={counts?.[BH_PENDING] ?? 0}
          v={values?.[BH_PENDING] ?? 0}
          tone={BH_STATUS_WASH[BH_PENDING]}
          icon={<Clock className="w-4 h-4" />}
          hint={
            summary?.oldest_pending_date
              ? `Oldest waiting since ${fmtISTDate(summary.oldest_pending_date)}`
              : 'Nothing waiting'
          }
          onClick={() => {
            setTab(BH_PENDING);
            setPage(1);
          }}
        />
        <Tile
          label={BH_STATUS_SHORT[BH_SUBMITTED]}
          n={counts?.[BH_SUBMITTED] ?? 0}
          v={values?.[BH_SUBMITTED] ?? 0}
          tone={BH_STATUS_WASH[BH_SUBMITTED]}
          icon={<ArrowRightLeft className="w-4 h-4" />}
          hint={
            summary?.oldest_submitted_date
              ? `Awaiting confirmation since ${fmtISTDate(summary.oldest_submitted_date)}`
              : 'Nothing awaiting confirmation'
          }
          onClick={() => {
            setTab(BH_SUBMITTED);
            setPage(1);
          }}
        />
        <Tile
          label={BH_STATUS_LABEL[BH_RECEIVED]}
          n={counts?.[BH_RECEIVED] ?? 0}
          v={values?.[BH_RECEIVED] ?? 0}
          tone={BH_STATUS_WASH[BH_RECEIVED]}
          icon={<CheckCircle2 className="w-4 h-4" />}
          hint="Accounts have confirmed these"
          onClick={() => {
            setTab(BH_RECEIVED);
            setPage(1);
          }}
        />
        {/* SEPARATE ON PURPOSE — see the header note. This is derived from goods
            receipts, not from the register, and merging it into Pending is the
            one change that could let the historical backlog appear. */}
        <div
          className={`border rounded-xl p-3 ${
            (summary?.not_yet_recorded ?? 0) > 0
              ? 'bg-red-50 border-red-200 text-red-900'
              : 'bg-[#FFF1E3] border-[#D4B896] text-[#6B5744]'
          }`}
        >
          <div className="text-[10px] uppercase tracking-wide opacity-80 flex items-center gap-1">
            <FileWarning className="w-4 h-4" /> Bill not recorded
          </div>
          <div className="text-xl font-bold font-mono mt-0.5">{summary?.not_yet_recorded ?? 0}</div>
          <div className="text-[10px] mt-0.5 opacity-80">
            Deliveries received with no bill answer. Not part of Pending.
          </div>
        </div>
      </div>

      {/* ── THE SAME LEAK DETECTOR, SEEN BY SOMEBODY WHO CANNOT WORK IT ─────
          GET /api/bill-submissions/unrecorded refuses an Accounts-role holder,
          and that is right: it is a list of the store's own unfinished work. But
          the tile above still hands them a COUNT, and a number with no list and
          no explanation is exactly how a real gap gets read as a broken screen.
          One sentence saying which it is. */}
      {!canRecord && (summary?.not_yet_recorded ?? 0) > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-3 py-2 text-xs leading-snug text-[#6B5744] flex items-start gap-2">
          <FileWarning className="w-4 h-4 mt-0.5 shrink-0 text-[#8B7355]" />
          <span>
            <b>
              {summary?.not_yet_recorded}{' '}
              {(summary?.not_yet_recorded ?? 0) === 1 ? 'delivery has' : 'deliveries have'} no bill
              record.
            </b>{' '}
            Recording them is the store&apos;s half of the handover, so the list itself is not shown
            here. A store user opens this same screen and records each one in a tap.
          </span>
        </div>
      )}

      {/* ── The leak detector's own rows, fixable in one tap ──────────────── */}
      {canRecord && unrecorded.length > 0 && (
        <div className="bg-white border border-red-200 rounded-xl overflow-hidden">
          <div className="px-3 py-2 bg-red-50 text-red-900 text-xs font-semibold flex items-center gap-1.5">
            <FileWarning className="w-4 h-4" />
            {unrecorded.length} delivery(ies) have no bill record
            <span className="font-normal text-[11px]">
              — the quality-check question was never answered for these. Record each one here; the
              bill number, vendor and value are read from the goods receipt.
            </span>
          </div>
          <div className="divide-y divide-[#F0E4D6] max-h-64 overflow-y-auto">
            {unrecorded.map(u => (
              <div key={u.id} className="px-3 py-2 flex items-center gap-2 text-xs flex-wrap">
                <span className="font-mono font-semibold text-[#2D1B0E]">{u.grn_number}</span>
                <span className="text-[#6B5744]">{u.vendor || '—'}</span>
                <span className="text-[#8B7355]">
                  bill <b className="font-mono">{u.bill_no || '—'}</b>
                </span>
                <span className="text-[#8B7355]">{fmtISTDate(u.date)}</span>
                <span className="font-mono text-[#2D1B0E]">{bhRupees(u.bill_value)}</span>
                <button
                  onClick={() => recordUnrecorded(u)}
                  disabled={busy === u.id}
                  className="ml-auto px-2.5 py-1.5 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white font-semibold flex items-center gap-1.5 disabled:opacity-50"
                >
                  {busy === u.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  Record this bill
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map(t => (
          <button
            key={t.k}
            onClick={() => {
              setTab(t.k);
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-full border text-xs ${
              tab === t.k
                ? 'bg-[#af4408] text-white border-[#af4408]'
                : 'bg-white text-[#6B5744] border-[#E8D5C4]'
            }`}
          >
            {t.label}
            {typeof t.n === 'number' && <span className="ml-1 font-mono">{t.n}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-[#8B7355]" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Bill number, vendor, GRN or invoice ID…"
            className="w-full pl-8 pr-2 py-2 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]"
          />
        </div>
        <label className="text-xs text-[#6B5744] flex items-center gap-1.5">
          Received from
          <input
            type="date"
            value={from}
            onChange={e => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]"
          />
        </label>
        <label className="text-xs text-[#6B5744] flex items-center gap-1.5">
          to
          <input
            type="date"
            value={to}
            onChange={e => {
              setTo(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]"
          />
        </label>
        {(q || from || to) && (
          <button
            onClick={() => {
              setQ('');
              setFrom('');
              setTo('');
              setPage(1);
            }}
            className="px-2 py-1.5 text-xs text-[#8B7355] underline"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── The register ─────────────────────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          /* FOUR EMPTY STATES, and only one of them is allowed a green tick.
             See the note next to `registerEmpty` above for why this matters more
             here than on any other list in the app. */
          <div className="p-6 sm:p-10 text-center text-sm text-[#8B7355]">
            {filtersOn ? (
              /* A FILTER RESULT. Says nothing about the register — the boxes are
                 narrowing it — so it claims nothing about the register. */
              <>
                <Search className="w-7 h-7 mx-auto mb-2 text-[#C0A98F]" />
                <div className="text-[#6B5744]">No bill matches what you have typed.</div>
                <div className="text-[11px] mt-1">
                  The search and the dates are narrowing this list. This is not a statement about
                  the register.
                </div>
                <button
                  onClick={() => {
                    setQ('');
                    setFrom('');
                    setTo('');
                    setPage(1);
                  }}
                  className="mt-3 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#6B5744] hover:bg-[#FFF1E3]"
                >
                  Clear the search and dates
                </button>
              </>
            ) : countsUnknown ? (
              /* THE DASHBOARD DID NOT LOAD. Says so, and claims NOTHING about
                 the register — not empty, not clear, not waiting. The counts
                 above are blank for the same reason, so this names the cause
                 and offers the one action that fixes it. */
              <>
                <ShieldAlert className="w-7 h-7 mx-auto mb-2 text-[#C0A98F]" />
                <div className="font-semibold text-[#2D1B0E]">
                  The register could not be read just now.
                </div>
                <div className="text-[11px] mt-1 max-w-md mx-auto leading-relaxed">
                  This is <b>not</b> an all-clear and not an empty register — the dashboard call did
                  not answer, so nothing on this screen knows what the register holds. The tiles
                  above are blank for the same reason.
                </div>
                <button
                  onClick={loadAll}
                  className="mt-3 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#6B5744] hover:bg-[#FFF1E3] inline-flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Try again
                </button>
              </>
            ) : registerEmpty ? (
              /* THE DAY-ONE STATE, and the one the old sentence got wrong.
                 NOTHING has been recorded. Not a tick, not "confirmed" — the
                 word is EMPTY, and then how the first row gets here. */
              <>
                <Receipt className="w-7 h-7 mx-auto mb-2 text-[#C0A98F]" />
                <div className="font-semibold text-[#2D1B0E]">No bills recorded yet.</div>
                <div className="text-[11px] mt-1 max-w-md mx-auto leading-relaxed">
                  This register is empty — not confirmed, not cleared, <b>empty</b>. A bill arrives
                  here when a store person answers{' '}
                  <i>&ldquo;the vendor&rsquo;s bill — where is it going?&rdquo;</i> while receiving
                  a delivery (Purchase Orders → Receive, or Goods Receipt).
                  {canRecord && <> For a bill with no delivery behind it, use <b>Add a bill by hand</b>.</>}
                </div>
              </>
            ) : tab === 'open' ? (
              genuineAllClear ? (
                /* THE GENUINE ALL-CLEAR — bills exist, Accounts have confirmed
                   them, nothing is waiting. The tick is earned here and only
                   here, and it names the number it is talking about. */
                <>
                  <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-500" />
                  <div className="text-[#6B5744]">
                    Nothing open — all {counts?.[BH_RECEIVED] ?? 0} recorded bill
                    {(counts?.[BH_RECEIVED] ?? 0) === 1 ? ' has' : 's have'} been confirmed by
                    Accounts.
                  </div>
                </>
              ) : (
                /* Bills exist, none is open, none was ever confirmed — a
                   register holding only voided records. Not a failure and not an
                   all-clear, so it is said plainly instead. */
                <>
                  <Ban className="w-7 h-7 mx-auto mb-2 text-[#C0A98F]" />
                  <div className="text-[#6B5744]">
                    No bill is waiting on the store or on Accounts.
                  </div>
                  <div className="text-[11px] mt-1">
                    Nothing here has been confirmed by Accounts — the {counts?.[BH_VOID] ?? 0}{' '}
                    record{(counts?.[BH_VOID] ?? 0) === 1 ? '' : 's'} in this register{' '}
                    {(counts?.[BH_VOID] ?? 0) === 1 ? 'is' : 'are'} voided. See the{' '}
                    <b>Voided</b> tab.
                  </div>
                </>
              )
            ) : (
              /* One tab of a register that is not empty. Name the tab, claim
                 nothing about the rest. */
              <>
                <FileWarning className="w-7 h-7 mx-auto mb-2 text-[#C0A98F]" />
                <div className="text-[#6B5744]">
                  No bill is at &ldquo;{tabs.find(t => t.k === tab)?.label ?? tab}&rdquo; right now.
                </div>
                <div className="text-[11px] mt-1">
                  Other tabs may still have bills — this one is empty.
                </div>
              </>
            )}

            {/* The leak detector, wherever the list is empty: an empty register
                with unrecorded deliveries above it is the one combination that
                genuinely needs work doing. */}
            {(summary?.not_yet_recorded ?? 0) > 0 && (
              <div className="text-[11px] mt-2 text-red-800">
                {summary?.not_yet_recorded} deliver
                {(summary?.not_yet_recorded ?? 0) === 1 ? 'y has' : 'ies have'} no bill record at
                all — see <b>Bill not recorded</b> above.
              </div>
            )}

            {/* WHERE THE REGISTER STARTS, said again at the exact spot where a
                missing bill would be noticed. The banner at the top says it
                first; this is the answer to "so where is last month's?" asked
                while staring at the gap. */}
            {cutoff?.ready && cutoff.date && (
              <div className="text-[11px] mt-2">
                This register starts at <b>{cutoff.date}</b> — bills received before that date are
                deliberately not here.
              </div>
            )}
          </div>
        ) : (
          <>
            {/* ── THE PHONE ───────────────────────────────────────────────────
                A store person does this standing at a delivery door with the
                vendor's bill in one hand, on a phone. The eight-column table
                below is 894px wide; inside a 390px screen that leaves the status
                chip, both timestamps and the primary "Submitted to Accounts"
                button off the right-hand edge — measured at 390px, the button's
                own box sat at x=753..915, i.e. entirely off-screen, reachable
                only by discovering that the strip scrolls sideways. A one-hand
                action you have to go looking for is an action that does not get
                done, and the whole feature is that one action.

                So under `sm` the same rows are cards: everything that matters
                stacked down the screen, nothing horizontal, and the primary
                button full-width under its own bill. The table is untouched and
                takes over from `sm` up — the desk view the owner reads is the
                one he already knows. */}
            <div className="sm:hidden divide-y divide-[#E8D5C4]/70">
              {rows.map(r => {
                const open = openRow === r.id;
                return (
                  <MobileBillCard
                    key={r.id}
                    r={r}
                    open={open}
                    trail={trail[r.id]}
                    busy={busy === r.id}
                    canRecord={canRecord}
                    onToggle={() => {
                      const next = open ? null : r.id;
                      setOpenRow(next);
                      if (next) loadTrail(r.id);
                    }}
                    onSubmit={() => markSubmitted(r)}
                    onVoid={() => voidRow(r)}
                    onScan={f => addScan(r, f)}
                  />
                );
              })}
            </div>

            <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left py-2 px-2 font-medium">Bill no.</th>
                  <th className="text-left py-2 px-2 font-medium">Vendor</th>
                  <th className="text-right py-2 px-2 font-medium">Bill value</th>
                  <th className="text-left py-2 px-2 font-medium" title="Business date of the receiving event — what the start date compares">
                    Received
                  </th>
                  <th className="text-left py-2 px-2 font-medium" title="When the store said it handed the bill to Accounts">
                    Store submitted
                  </th>
                  <th className="text-left py-2 px-2 font-medium" title="When Accounts confirmed they had it">
                    Accounts confirmed
                  </th>
                  <th className="text-left py-2 px-2 font-medium">Status</th>
                  <th className="text-right py-2 px-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const open = openRow === r.id;
                  return (
                    <RowBlock
                      key={r.id}
                      r={r}
                      open={open}
                      trail={trail[r.id]}
                      busy={busy === r.id}
                      canRecord={canRecord}
                      onToggle={() => {
                        const next = open ? null : r.id;
                        setOpenRow(next);
                        if (next) loadTrail(r.id);
                      }}
                      onSubmit={() => markSubmitted(r)}
                      onVoid={() => voidRow(r)}
                      onScan={f => addScan(r, f)}
                    />
                  );
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-[#6B5744]">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-3 py-1.5 border border-[#E8D5C4] rounded bg-white disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={page * PAGE_SIZE >= total}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 border border-[#E8D5C4] rounded bg-white disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* ── What this register does NOT cover, said on its own face ───────── */}
      <div className="text-[10px] text-[#8B7355] leading-snug space-y-1">
        <p>
          <b>Where records come from.</b> A bill is normally recorded by answering{' '}
          <i>&ldquo;the vendor&rsquo;s bill — where is it going?&rdquo;</i> in the store quality
          check while receiving, on both Purchase Orders → Receive and Goods Receipt (GRN). Nothing
          is retyped there or here — the bill number, vendor, date and value are read from the goods
          receipt itself. <b>Add a bill by hand</b> is the fallback for a bill with no goods receipt
          behind it.
        </p>
        <p>
          <b>Liquor / TGBCL bills are not in this register.</b> Liquor inward runs on a separate rail
          (Inventory → Liquor Store) and never produces a goods receipt, so none of it appears here.
          This register covers central-store vendor bills only.
        </p>
        <p>
          <b>Accounts confirm on their own view</b> of this same register. The person who recorded or
          submitted a bill can never be the person who confirms it — that separation is what makes
          the trail worth something, and it is enforced by the server, not by this screen.
        </p>
      </div>

      {showManual && (
        <ManualBillModal
          cutoffDate={cutoff?.date ?? null}
          onClose={() => setShowManual(false)}
          onSaved={async msg => {
            setShowManual(false);
            flash(msg);
            await Promise.all([loadSummary(), loadRows(), loadUnrecorded()]);
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-[92vw] bg-[#2D1B0E] text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function Tile({
  label,
  n,
  v,
  tone,
  icon,
  hint,
  onClick,
}: {
  label: string;
  n: number;
  v: number;
  tone: string;
  icon: React.ReactNode;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className={`text-left border rounded-xl p-3 w-full ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80 flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-xl font-bold font-mono mt-0.5">{n}</div>
      <div className="text-[11px] font-mono opacity-90">{bhRupees(v)}</div>
      <div className="text-[10px] mt-0.5 opacity-80">{hint}</div>
    </button>
  );
}

/**
 * Deliberately the same shape, icon and colour as the chip on the Accounts queue
 * and the shared history (STATUS_STYLE in _components/bill-handover-ui.tsx):
 * rounded-full, icon, 10px semibold. The owner reads both screens in one sitting
 * and one record must not look like two.
 */
const STATUS_ICON: Record<BillHandoverStatus, typeof Clock> = {
  [BH_PENDING]: Clock,
  [BH_SUBMITTED]: Hourglass,
  [BH_RECEIVED]: BadgeCheck,
  [BH_VOID]: Ban,
};

function StatusChip({ s }: { s: BillHandoverStatus }) {
  const Icon = STATUS_ICON[s] ?? Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${BH_STATUS_TONE[s]}`}
    >
      <Icon className="w-3 h-3 shrink-0" />
      {BH_STATUS_SHORT[s] ?? s}
    </span>
  );
}

/**
 * ONE BILL, ON A PHONE, IN ONE HAND.
 *
 * Same data and the same three actions as the table row — this is not a reduced
 * view, and a store person on a phone is not given a lesser register. What
 * changes is the axis: nothing is laid out sideways, so nothing can sit off the
 * right-hand edge of a 390px screen the way the table's primary button did.
 *
 * THE ORDER IS THE ORDER A PERSON HOLDING THE PAPER NEEDS IT IN:
 *  1. the bill number and the vendor — is this the paper in my hand?
 *  2. the value — is this the right bill?
 *  3. the two timestamps, labelled, one per line — has it gone, has it landed?
 *  4. THE ACTION, full width, 48px tall, directly under its own bill.
 *
 * The audit trail and the two secondary actions (attach a scan, void) sit behind
 * one expander, because at a delivery door they are not what the screen is for;
 * they are what you open when something is in dispute. Every control in here is
 * full-width and at least 44px tall — the app's own thumb target, the same one
 * BillHandoverCheck uses at the same door.
 */
function MobileBillCard({
  r,
  open,
  trail,
  busy,
  canRecord,
  onToggle,
  onSubmit,
  onVoid,
  onScan,
}: {
  r: Row;
  open: boolean;
  trail?: TrailRow[];
  busy: boolean;
  canRecord: boolean;
  onToggle: () => void;
  onSubmit: () => void;
  onVoid: () => void;
  onScan: (f: File | null) => void;
}) {
  return (
    <div className={`px-3 py-3 ${r.status === BH_VOID ? 'opacity-70' : ''}`}>
      {/* 1 + 2 — which bill, and for how much.
          flex-nowrap is the documented opt-out from globals.css:279, which
          forces `flex-wrap: wrap` onto every `.flex.gap-2` inside <main> on a
          phone. Without it the value and the status chip drop under the vendor
          name and lose their right-hand alignment — the identity and the amount
          stop reading as one line about one bill. */}
      <div className="flex flex-nowrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono font-semibold text-sm text-[#2D1B0E] break-words">
            {r.bill_no || <span className="text-[#C0A98F]">no bill no.</span>}
          </div>
          <div className="text-[12px] text-[#6B5744] break-words">{r.vendor_name || '—'}</div>
          <div className="text-[10px] text-[#8B7355] font-mono mt-0.5">
            {r.grn_number || (r.source === 'manual' ? 'entered by hand' : '')}
            {(r.attachment_count ?? 0) > 0 && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-emerald-700">
                <Paperclip className="w-2.5 h-2.5" />
                {r.attachment_count}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono font-semibold text-sm text-[#2D1B0E]">
            {bhRupees(r.bill_value)}
          </div>
          <div className="mt-1">
            <StatusChip s={r.status} />
          </div>
        </div>
      </div>

      {/* 3 — THE EVIDENCE, one fact per line and every line labelled. In the
          table these are three unlabelled columns that a phone cannot show at
          all; here the label travels with the value, so "not yet" can never be
          read against the wrong column. */}
      <dl className="mt-2 space-y-0.5 text-[11px]">
        <Fact label="Received">{fmtISTDate(r.received_date)}</Fact>
        <Fact label="Store submitted">
          {r.submitted_at ? (
            <>
              {fmtIST(r.submitted_at, { withTz: false })}
              <span className="text-[#8B7355]"> · {r.submitted_by_name || '—'}</span>
            </>
          ) : (
            <span className="text-[#C0A98F]">not yet</span>
          )}
        </Fact>
        <Fact label="Accounts confirmed">
          {r.confirmed_at ? (
            <span className="text-emerald-800">
              {fmtIST(r.confirmed_at, { withTz: false })}
              <span className="text-[#8B7355]"> · {r.confirmed_by_name || '—'}</span>
            </span>
          ) : (
            <span className="text-[#C0A98F]">not yet</span>
          )}
        </Fact>
      </dl>

      {/* 4 — THE ACTION. Full width, under its own bill, never sideways.
          THE HEIGHT IS SET WITH PADDING, NOT min-h-[…], AND THAT IS NOT A
          STYLE CHOICE. globals.css:247 carries `main button { min-height: 36px }`
          inside the phone media query, unlayered — so it beats every Tailwind
          `min-h-[48px]` utility, which live in @layer utilities. Measured here:
          a button classed min-h-[48px] computed to exactly 36px at 390px.
          Padding is not min-height, so it survives that rule: py-3.5 + a 20px
          line box = 48px of real thumb target. (The same clamp is quietly
          flattening BillHandoverCheck's min-h-[52px] at the delivery door.) */}
      {canRecord && r.status === BH_PENDING && (
        <button
          onClick={onSubmit}
          disabled={busy}
          className="mt-2.5 w-full py-3.5 rounded-lg bg-[#af4408] hover:bg-[#8a3506] active:scale-[0.99] text-white text-[13px] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ArrowRightLeft className="w-4 h-4" />
          )}
          Submitted to Accounts
        </button>
      )}
      {r.status === BH_SUBMITTED && (
        <div className="mt-2.5 rounded-lg border border-[#D4B896] bg-[#FFF1E3] px-2.5 py-2 text-[11px] text-[#8a3506] flex items-center gap-1.5">
          <Hourglass className="w-3.5 h-3.5 shrink-0" />
          Handed over. Waiting on Accounts to confirm they have it.
        </div>
      )}

      {/* The trail and the secondary actions, behind one full-width tap. */}
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="mt-2 w-full py-3 rounded-lg border border-[#E8D5C4] bg-white text-[12px] text-[#6B5744] inline-flex items-center justify-center gap-1.5 active:scale-[0.99]"
      >
        <History className="w-3.5 h-3.5" />
        {open ? 'Hide history and options' : 'History and options'}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5 space-y-2 text-[11px] text-[#6B5744]">
          <div className="font-semibold text-[#2D1B0E]">Handover history</div>
          {!trail ? (
            <div className="text-[#8B7355]">
              <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" /> loading…
            </div>
          ) : trail.length === 0 ? (
            <div className="text-[#8B7355]">No history rows.</div>
          ) : (
            <ul className="space-y-1.5">
              {trail.map(t => (
                <li key={t.id} className="leading-snug">
                  <div className="font-mono text-[10px] text-[#8B7355]">
                    {fmtIST(t.at, { withTz: false })}
                  </div>
                  <div>
                    <b className="text-[#2D1B0E]">{t.action}</b> by {t.actor_name || '—'}
                    {t.actor_role ? ` (${t.actor_role})` : ''}
                    {t.note ? ` · ${t.note}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-[#E8D5C4] pt-2 space-y-0.5">
            <div>
              Status: <b>{BH_STATUS_LABEL[r.status] ?? r.status}</b>
            </div>
            <div>Bill date on the paper: {r.bill_date ? fmtISTDate(r.bill_date) : '—'}</div>
            <div>
              Recorded by {r.created_by_name || '—'} on {fmtIST(r.created_at)}
            </div>
            {r.invoice_id && <div>Our invoice ID: {r.invoice_id}</div>}
            {r.note && <div>Note: &ldquo;{r.note}&rdquo;</div>}
            {r.status === BH_VOID && (
              <div className="rounded border border-[#D4B896] bg-[#F7F1E9] px-2 py-1.5 mt-1">
                <b>Voided</b> by {r.voided_by_name || '—'} on {fmtIST(r.voided_at)} —
                &ldquo;{r.void_reason}&rdquo;. The record is kept as audit, never deleted.
              </div>
            )}
          </div>

          {/* Stacked, full width, 44px. Never a row of small buttons. */}
          <div className="space-y-1.5 pt-0.5">
            {(r.attachment_count ?? 0) > 0 && (
              <a
                href={`/api/bill-submissions/${r.id}/attachment`}
                className="w-full py-3 rounded-lg border border-[#D4B896] bg-white text-[12px] font-semibold text-[#6B5744] inline-flex items-center justify-center gap-1.5"
              >
                <Paperclip className="w-3.5 h-3.5" /> Open the bill scan
              </a>
            )}
            {canRecord && r.status !== BH_VOID && r.status !== BH_RECEIVED && (
              <label className="w-full py-3 rounded-lg border border-[#D4B896] bg-white text-[12px] font-semibold text-[#6B5744] inline-flex items-center justify-center gap-1.5 cursor-pointer">
                <Paperclip className="w-3.5 h-3.5" />
                {(r.attachment_count ?? 0) > 0 ? 'Add another scan' : 'Photo of the bill'}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  capture="environment"
                  className="hidden"
                  onChange={e => onScan(e.target.files?.[0] || null)}
                />
              </label>
            )}
            {canRecord && r.status !== BH_VOID && (
              <button
                onClick={onVoid}
                disabled={busy}
                className="w-full py-3 rounded-lg border border-[#E8D5C4] bg-white text-[12px] text-[#8B7355] inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Ban className="w-3.5 h-3.5" /> Void with a reason
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One labelled fact on the phone card. The label never leaves the value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[#8B7355] shrink-0">{label}:</dt>
      <dd className="text-[#2D1B0E] min-w-0 break-words">{children}</dd>
    </div>
  );
}

function RowBlock({
  r,
  open,
  trail,
  busy,
  canRecord,
  onToggle,
  onSubmit,
  onVoid,
  onScan,
}: {
  r: Row;
  open: boolean;
  trail?: TrailRow[];
  busy: boolean;
  canRecord: boolean;
  onToggle: () => void;
  onSubmit: () => void;
  onVoid: () => void;
  onScan: (f: File | null) => void;
}) {
  return (
    <>
      <tr
        className={`border-t border-[#E8D5C4]/60 cursor-pointer hover:bg-[#FFF8F0] ${
          r.status === BH_VOID ? 'opacity-70' : ''
        }`}
        onClick={onToggle}
      >
        <td className="py-2 px-2">
          <div className="font-mono font-semibold text-[#2D1B0E]">
            {r.bill_no || <span className="text-[#C0A98F]">no bill no.</span>}
          </div>
          <div className="text-[9px] text-[#8B7355] font-mono">
            {r.grn_number || (r.source === 'manual' ? 'entered by hand' : '')}
            {(r.attachment_count ?? 0) > 0 && (
              <span className="ml-1 inline-flex items-center gap-0.5 text-emerald-700">
                <Paperclip className="w-2.5 h-2.5" />
                {r.attachment_count}
              </span>
            )}
          </div>
        </td>
        <td className="py-2 px-2 text-[#6B5744]">{r.vendor_name || '—'}</td>
        <td className="py-2 px-2 text-right font-mono text-[#2D1B0E]">{bhRupees(r.bill_value)}</td>
        <td className="py-2 px-2 text-[#6B5744] whitespace-nowrap">{fmtISTDate(r.received_date)}</td>
        <td className="py-2 px-2 whitespace-nowrap">
          {r.submitted_at ? (
            <>
              <div className="text-[#2D1B0E]">{fmtIST(r.submitted_at, { withTz: false })}</div>
              <div className="text-[9px] text-[#8B7355]">{r.submitted_by_name || '—'}</div>
            </>
          ) : (
            <span className="text-[#C0A98F]">not yet</span>
          )}
        </td>
        <td className="py-2 px-2 whitespace-nowrap">
          {r.confirmed_at ? (
            <>
              <div className="text-emerald-800">{fmtIST(r.confirmed_at, { withTz: false })}</div>
              <div className="text-[9px] text-[#8B7355]">{r.confirmed_by_name || '—'}</div>
            </>
          ) : (
            <span className="text-[#C0A98F]">not yet</span>
          )}
        </td>
        <td className="py-2 px-2">
          <StatusChip s={r.status} />
        </td>
        <td className="py-2 px-2 text-right" onClick={e => e.stopPropagation()}>
          {canRecord && r.status === BH_PENDING && (
            <button
              onClick={onSubmit}
              disabled={busy}
              className="px-2.5 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-[11px] font-bold inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
              title="Record that the paper bill has been handed to the Accounts team. Not a payment."
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ArrowRightLeft className="w-3.5 h-3.5" />
              )}
              Submitted to Accounts
            </button>
          )}
          {r.status === BH_SUBMITTED && (
            <span className="text-[10px] text-[#8a3506]">waiting on Accounts</span>
          )}
        </td>
      </tr>

      {open && (
        <tr className="bg-[#FFF8F0] border-t border-[#E8D5C4]/60">
          <td colSpan={8} className="px-3 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1 text-[11px] text-[#6B5744]">
                <div className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" /> Handover history
                </div>
                {!trail ? (
                  <div className="text-[#8B7355]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" /> loading…
                  </div>
                ) : trail.length === 0 ? (
                  <div className="text-[#8B7355]">No history rows.</div>
                ) : (
                  <ul className="space-y-1">
                    {trail.map(t => (
                      <li key={t.id} className="flex items-start gap-1.5">
                        <span className="font-mono text-[10px] text-[#8B7355] shrink-0">
                          {fmtIST(t.at, { withTz: false })}
                        </span>
                        <span>
                          <b className="text-[#2D1B0E]">{t.action}</b> by {t.actor_name || '—'}
                          {t.actor_role ? ` (${t.actor_role})` : ''}
                          {t.note ? ` · ${t.note}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-1.5 text-[11px] text-[#6B5744]">
                <div className="font-semibold text-[#2D1B0E]">This bill</div>
                <div>
                  Status: <b>{BH_STATUS_LABEL[r.status] ?? r.status}</b>
                </div>
                <div>Bill date on the paper: {r.bill_date ? fmtISTDate(r.bill_date) : '—'}</div>
                <div>
                  Recorded by {r.created_by_name || '—'} on {fmtIST(r.created_at)}
                </div>
                {r.invoice_id && <div>Our invoice ID: {r.invoice_id}</div>}
                {r.note && <div>Note: &ldquo;{r.note}&rdquo;</div>}
                {r.status === BH_VOID && (
                  <div className="rounded border border-[#D4B896] bg-[#F7F1E9] px-2 py-1.5">
                    <b>Voided</b> by {r.voided_by_name || '—'} on {fmtIST(r.voided_at)} —
                    &ldquo;{r.void_reason}&rdquo;. The record is kept as audit, never deleted.
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {(r.attachment_count ?? 0) > 0 && (
                    <a
                      href={`/api/bill-submissions/${r.id}/attachment`}
                      className="px-2.5 py-2 rounded-lg border border-[#D4B896] bg-white text-[11px] font-semibold text-[#6B5744] inline-flex items-center gap-1.5 hover:bg-[#FFF1E3]"
                    >
                      <Paperclip className="w-3.5 h-3.5" /> Open the bill scan
                    </a>
                  )}
                  {canRecord && r.status !== BH_VOID && r.status !== BH_RECEIVED && (
                    <label className="px-2.5 py-2 rounded-lg border border-[#D4B896] bg-white text-[11px] font-semibold text-[#6B5744] inline-flex items-center gap-1.5 hover:bg-[#FFF1E3] cursor-pointer">
                      <Paperclip className="w-3.5 h-3.5" />
                      {(r.attachment_count ?? 0) > 0 ? 'Add another scan' : 'Attach a bill scan'}
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        className="hidden"
                        onChange={e => onScan(e.target.files?.[0] || null)}
                      />
                    </label>
                  )}
                  {canRecord && r.status !== BH_VOID && (
                    <button
                      onClick={onVoid}
                      disabled={busy}
                      className="px-2.5 py-2 rounded-lg border border-[#E8D5C4] bg-white text-[11px] text-[#8B7355] inline-flex items-center gap-1.5 hover:bg-[#FFF1E3] disabled:opacity-50"
                      title="Withdraw this record with a reason. It is never deleted."
                    >
                      <Ban className="w-3.5 h-3.5" /> Void with a reason
                    </button>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * THE FALLBACK — a bill with no goods receipt behind it.
 *
 * The brief: "Manual entry must still be POSSIBLE for a bill that arrived
 * without a purchase behind it, but it is the fallback, never the default."
 * So it is a modal behind a secondary button, it says out loud that the normal
 * path is the quality check at the delivery door, and it warns rather than
 * refuses on a duplicate — his suppliers genuinely reuse bill numbers
 * (FAMOUS MUTTON SUPPLIER wrote "1122" on eight different dates), and a flat
 * refusal on (vendor, bill no) once walled off 5.3% of his real bills.
 */
function ManualBillModal({
  cutoffDate,
  onClose,
  onSaved,
}: {
  cutoffDate: string | null;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const [billNo, setBillNo] = useState('');
  const [vendor, setVendor] = useState('');
  const [billDate, setBillDate] = useState(today);
  const [receivedDate, setReceivedDate] = useState(today);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [submitNow, setSubmitNow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const blocked =
    !billNo.trim() || !vendor.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(receivedDate);

  async function save(confirmDuplicate = false) {
    setSaving(true);
    setErr(null);
    try {
      const r = await api('/api/bill-submissions', {
        method: 'POST',
        body: {
          bill_no: billNo.trim(),
          vendor_name: vendor.trim(),
          bill_date: billDate,
          received_date: receivedDate,
          bill_value: Number(value) || 0,
          note: note.trim(),
          submit_now: submitNow,
          confirm_duplicate: confirmDuplicate,
        },
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as {
          error?: string;
          needs_confirm_duplicate?: boolean;
        };
        if (j?.needs_confirm_duplicate) {
          // WARN, never refuse. Same shape the GRN screen already uses for a
          // reused vendor bill number, for the same measured reason.
          if (window.confirm(`${j.error}\n\nRecord it as a separate bill?`)) {
            setSaving(false);
            return save(true);
          }
          setErr(null);
          return;
        }
        setErr(j?.error || (await bhReadError(r, 'Could not record that bill.')));
        return;
      }
      await onSaved(
        submitNow
          ? `Bill ${billNo.trim()} recorded and marked submitted to Accounts.`
          : `Bill ${billNo.trim()} recorded as "${BH_STATUS_LABEL[BH_PENDING]}".`,
      );
    } catch {
      setErr('The network dropped. Nothing was recorded.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-3 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg my-6 shadow-xl">
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-start justify-between gap-2">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Add a bill by hand</h2>
            <p className="text-[11px] text-[#8B7355] mt-0.5">
              The fallback, not the normal way in. A bill that came with a delivery is recorded by
              answering the question in the store quality check while receiving — that way nothing is
              retyped and the record cannot drift from the purchase. Use this only for a bill with no
              goods receipt behind it.
            </p>
          </div>
          <button onClick={onClose} className="text-[#8B7355]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Vendor bill number <span className="text-red-600">*</span>
            <input
              value={billNo}
              onChange={e => setBillNo(e.target.value)}
              placeholder="the number printed on the vendor's bill"
              className="px-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Vendor <span className="text-red-600">*</span>
            <input
              value={vendor}
              onChange={e => setVendor(e.target.value)}
              placeholder="vendor name as it appears on the bill"
              className="px-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[#6B5744]">
              Bill date
              <input
                type="date"
                value={billDate}
                onChange={e => setBillDate(e.target.value)}
                className="px-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
              />
              <span className="text-[10px] text-[#8B7355]">printed on the paper</span>
            </label>
            <label className="flex flex-col gap-1 text-[#6B5744]">
              Received on <span className="text-red-600">*</span>
              <input
                type="date"
                value={receivedDate}
                onChange={e => setReceivedDate(e.target.value)}
                className="px-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
              />
              {/* The date the register actually bounds on, said where it is typed
                  — not discovered as a 400 after Save. */}
              <span className="text-[10px] text-[#8B7355]">
                when it reached the store
                {cutoffDate ? ` — must be on or after ${cutoffDate}` : ''}
              </span>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Total bill value
            <div className="relative">
              <IndianRupee className="w-3.5 h-3.5 absolute left-2 top-2.5 text-[#8B7355]" />
              <input
                type="number"
                step="0.01"
                min="0"
                value={value}
                onChange={e => setValue(e.target.value)}
                className="w-full pl-7 pr-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-[#6B5744]">
            Note (optional)
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              className="px-2 py-2 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm"
            />
          </label>

          <label className="flex items-start gap-2 cursor-pointer rounded border border-[#E8D5C4] bg-[#FFF8F0] px-2 py-2">
            <input
              type="checkbox"
              checked={submitNow}
              onChange={e => setSubmitNow(e.target.checked)}
              className="mt-0.5 accent-[#af4408]"
            />
            <span className="text-[11px] text-[#6B5744]">
              <b>This bill has already gone to Accounts</b> — stamp the handover now, under my name.
              A handover of paper, not a payment.
            </span>
          </label>

          {err && (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
              {err}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm text-[#6B5744]">
            Cancel
          </button>
          <button
            onClick={() => save(false)}
            disabled={blocked || saving}
            title={blocked ? 'Bill number, vendor and the received date are required' : undefined}
            className="px-4 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Record the bill
          </button>
        </div>
      </div>
    </div>
  );
}
