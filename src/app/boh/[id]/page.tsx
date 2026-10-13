'use client';

/**
 * /boh/[id] — ONE BILL ON HOLD: the original POS bill, everything that has ever
 * happened to it, and the things you can do next.
 *
 * ── THE ORIGINAL BILL ──────────────────────────────────────────────────────
 * Rendered here from the FROZEN figures the hold wrote (orders.subtotal /
 * service_charge / discount / tax_total / total). Those are the numbers the BOH
 * balance is tracking, so they are the numbers on screen.
 *
 * "Reprintable and downloadable" reuses the endpoint that already exists —
 * GET /api/dine-in/orders/[id]/bill-pdf, which /cashier has always linked
 * (cashier/page.tsx:191). The server hands this page that URL as `bill_pdf_url`;
 * nothing here builds a bill path of its own.
 *
 * NO PATH ON THIS SCREEN MAY CONTAIN THE SUBSTRING 'print'. src/proxy.ts:132
 * makes any such path PUBLICLY UNAUTHENTICATED, and this page carries a
 * customer's name, their phone number and an amount owed.
 *
 * ── THE MONEY RULE, AS IT SHOWS UP HERE ────────────────────────────────────
 * A BOH payment is a PAYMENT RECORD, NOT A SALE. Revenue and stock were both
 * booked at the moment of hold. Everything this page posts goes to
 * /api/boh/[id]/*, which writes boh_* rows only; there is no path from this
 * screen to `sales`, to stock, or to the order's frozen totals.
 *
 * ── NOTHING IS EVER OVERWRITTEN ────────────────────────────────────────────
 * "No previous follow-up or status history should be overwritten or deleted."
 * The history tables are append-only in the database itself, so this screen has
 * no edit or delete control for any history row — by design, not by omission.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Banknote, ArrowLeft, RefreshCw, AlertTriangle, Download, Loader2,
  PhoneOff, Phone, UserCog, MessageSquarePlus, IndianRupee, CheckCircle2,
  Clock, History, Lock, Info,
} from 'lucide-react';
import {
  FollowUpModal, PaymentModal, ReassignModal, CloseModal, ContactModal,
} from './actions';
import { money, niceDate, stamp, stampDate, outcomeLabel, type Boh } from '../shared';

/**
 * One line of the story. Everything on this page collapses into these.
 *
 * ── THE THREE-LEVEL ORDER, AND WHY IT NEEDS ALL THREE ──────────────────────
 * SQLite stamps these rows to the SECOND, so a bill held, assigned, handed over
 * and part-paid inside one second — exactly what a scripted flow or a fast till
 * produces — yields a pile of rows with an identical timestamp.
 *
 *   1. `at`   — the timestamp. It decides whenever the stamps differ, which is
 *               the ordinary case.
 *   2. `seq`  — the KIND, ordered the way the events can actually occur
 *               (hold < initial assignment < handover < follow-up < payment <
 *               reminder < close). A convention, and it is what stops the story
 *               reading "handed from Ravi to Priya" before "Ravi made
 *               responsible".
 *   3. `ord`  — the row's SQLite rowid, i.e. THE ORDER IT WAS ACTUALLY
 *               WRITTEN, supplied by the server as `seq` on each history row
 *               (src/lib/boh-timeline-seq.ts). This is a measurement, not a
 *               convention, and it is what kind precedence alone could never
 *               do: separate two handovers, or two payments, inside one second.
 *
 * Before `ord` existed, three handovers fired back to back rendered as
 * "Admin → Ravi", "Priya → Ravi", "Ravi → Priya" — a chain in which Priya
 * passes the bill on before she is ever given it. Observed on a booted server,
 * not hypothesised.
 *
 * `tie` stays as the LAST resort, for a row whose `seq` did not arrive (an
 * older server, or the audit fallback query), so the screen degrades to the
 * behaviour it had rather than to none at all.
 */
interface Event { at: string; seq: number; ord: number; tie: string; text: string; who: string; tone: 'hold' | 'assign' | 'follow' | 'pay' | 'remind' | 'end' }
const SEQ = { hold: 0, assignInitial: 1, assignHandover: 2, follow: 3, pay: 4, remind: 5, end: 6 };
/** The server's insertion-order key for one history row; 0 when absent. */
const ordOf = (r: any) => Number(r?.seq) || 0;

export default function BohRecordPage() {
  const params = useParams<{ id: string }>();
  const id = String(params?.id || '');

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [modal, setModal] = useState<'' | 'followup' | 'payment' | 'reassign' | 'close' | 'contact'>('');
  const [dir, setDir] = useState<{ id: string; name: string }[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 6000); };

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await api(`/api/boh/${id}`);
      const j = await r.json();
      if (!r.ok) { setErr(j?.error || `Could not open this bill (HTTP ${r.status})`); setData(null); }
      else setData(j);
    } catch { setErr('Could not reach the server. Check the connection and try again.'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { if (id) load(); }, [id, load]);

  useEffect(() => {
    if (modal !== 'reassign' || dir.length) return;
    api('/api/tasks/users').then(r => r.json())
      .then(j => setDir((j.users || []).map((u: any) => ({ id: u.id, name: u.name || u.email }))))
      .catch(() => {});
  }, [modal, dir.length]);

  const boh: Boh | null = data?.boh || null;
  const order = data?.order || null;
  const items: any[] = data?.items || [];
  const wa = data?.whatsapp || null;

  /**
   * THE TIMELINE — one readable line per event, oldest first, in the shape the
   * owner wrote out: "15 Sep · Bill placed on hold by User A".
   *
   * Everything is MERGED into one story rather than shown as four tables,
   * because the question a manager actually asks is "what has happened to this
   * bill?", not "what is in the followups table?". The raw audit rows with
   * their old and new values are kept separately below, where they belong.
   */
  const events: Event[] = (() => {
    if (!boh) return [];
    const ev: Event[] = [];
    ev.push({
      at: boh.held_at || boh.created_at,
      seq: SEQ.hold, ord: 0, tie: '',
      tone: 'hold',
      who: boh.created_by || '',
      text: `Bill ${boh.bill_number || ''} placed on hold${boh.reason ? ` — ${boh.reason}` : ''}. ${money(boh.principal_amount)} to collect.`,
    });
    for (const a of (data?.assignments || [])) {
      ev.push({
        at: a.changed_at, seq: a.prev_user_id ? SEQ.assignHandover : SEQ.assignInitial, ord: ordOf(a), tie: '',
        tone: 'assign', who: a.changed_by || '',
        text: a.prev_user_id
          ? `Handed from ${a.prev_user_name || a.prev_user_id} to ${a.new_user_name || a.new_user_id}${a.reason ? ` — ${a.reason}` : ''}`
          : `${a.new_user_name || a.new_user_id} made responsible for collecting it`,
      });
    }
    for (const f of (data?.followups || [])) {
      const next = f.next_expected_date ? ` Next chase ${niceDate(f.next_expected_date)}.` : '';
      /**
       * A FOLLOW-UP THAT ANSWERS NO DATE, SAID IN WORDS.
       *
       * boh_followups.answered_expected_date is whatever the bill's expected
       * date was at the moment the follow-up was written (boh.ts:877), and a
       * hold does NOT set one — /cashier posts `body: {}` and
       * createBohForHold leaves it '' on purpose, so that a promise nobody made
       * is not counted as missed. The FIRST follow-up on almost every bill
       * therefore answers a blank date, and niceDate('') is '—': measured on a
       * booted server, the line rendered "Followed up on the — date: Customer
       * requested more time." An em-dash where a date belongs reads like a bug
       * or a deleted value on the one screen that exists to be the permanent,
       * unrewritable account of what happened. Say the true thing instead.
       */
      const answered = /^\d{4}-\d{2}-\d{2}$/.test(String(f.answered_expected_date || ''))
        ? `Followed up on the ${niceDate(f.answered_expected_date)} date`
        : 'Followed up before any payment date had been set';
      ev.push({
        at: f.created_at, seq: SEQ.follow, ord: ordOf(f), tie: String(f.answered_expected_date || ''), tone: 'follow', who: f.created_by_name || f.created_by || '',
        text: `${answered}: ${outcomeLabel(f.outcome)}.${f.remarks ? ` “${f.remarks}”` : ''}${next}`,
      });
    }
    for (const pay of (data?.payments || [])) {
      const rev = Number(pay.amount) < 0 || pay.reverses_payment_id;
      ev.push({
        at: pay.created_at, seq: SEQ.pay, ord: ordOf(pay), tie: String(pay.paid_on || ''), tone: 'pay', who: pay.created_by_name || pay.created_by || '',
        text: rev
          ? `Payment reversed: ${money(Math.abs(Number(pay.amount)))}${pay.remarks ? ` — ${pay.remarks}` : ''}`
          : `${money(pay.amount)} received by ${String(pay.mode || '').toUpperCase()} on ${niceDate(pay.paid_on)}${pay.reference ? ` (ref ${pay.reference})` : ''}${pay.remarks ? ` — ${pay.remarks}` : ''}`,
      });
    }
    for (const r of (data?.reminders || [])) {
      const when = r.finished_at || r.claimed_at;
      if (!when) continue;
      const waBit = r.wa_status === 'sent' ? ' and on WhatsApp' : r.wa_reason ? ` (WhatsApp did not go: ${r.wa_reason})` : '';
      ev.push({
        at: when, seq: SEQ.remind, ord: ordOf(r), tie: String(r.due_date || ''), tone: 'remind', who: 'System',
        text: `Reminder for the ${niceDate(r.due_date)} date sent to ${r.recipient || 'the responsible user'} in the app${waBit}`,
      });
    }
    if (boh.closed_at) {
      ev.push({
        at: boh.closed_at, seq: SEQ.end, ord: 0, tie: '', tone: 'end', who: boh.closed_by || '',
        text: boh.close_kind === 'write_off'
          ? `Written off with ${money(boh.balance_amount)} still outstanding${boh.close_remarks ? ` — ${boh.close_remarks}` : ''}`
          : boh.close_kind === 'settled_outside_boh'
          ? `Closed as settled at the till${boh.close_remarks ? ` — ${boh.close_remarks}` : ''}`
          : `Closed — paid in full${boh.close_remarks ? ` — ${boh.close_remarks}` : ''}`,
      });
    }
    if (boh.voided_at) {
      ev.push({ at: boh.voided_at, seq: SEQ.end, ord: 0, tie: '', tone: 'end', who: boh.voided_by || '', text: `Record voided${boh.void_reason ? ` — ${boh.void_reason}` : ''}` });
    }
    return ev.sort((a, b) =>
      String(a.at).localeCompare(String(b.at)) || a.seq - b.seq || a.ord - b.ord || a.tie.localeCompare(b.tie));
  })();

  const post = async (url: string, body: any, okMsg: string) => {
    setBusy(url);
    try {
      const r = await api(url, { method: 'POST', body });
      const j = await r.json();
      if (!r.ok) { flash(false, j?.error || `That did not go through (HTTP ${r.status})`); return false; }
      setModal(''); flash(true, okMsg); await load(); return true;
    } catch { flash(false, 'Could not reach the server. Nothing was saved.'); return false; }
    finally { setBusy(''); }
  };

  const patchContact = async (body: any) => {
    setBusy('patch');
    try {
      const r = await api(`/api/boh/${id}`, { method: 'PATCH', body });
      const j = await r.json();
      if (!r.ok) { flash(false, j?.error || 'Could not save those details.'); return false; }
      setModal(''); flash(true, 'Contact details saved.'); await load(); return true;
    } catch { flash(false, 'Could not reach the server. Nothing was saved.'); return false; }
    finally { setBusy(''); }
  };

  if (loading && !data) return (
    <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
      <div className="text-center text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Opening the bill…</div>
    </div>
  );

  if (err || !boh) return (
    <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-8">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center max-w-md">
        <Banknote className="w-8 h-8 text-[#af4408] mx-auto mb-2" />
        <p className="font-semibold text-[#2D1B0E]">This bill on hold could not be opened</p>
        <p className="text-sm text-[#8B7355] mt-1">{err || 'It may have been removed, or it belongs to someone else.'}</p>
        <Link href="/boh" className="inline-flex items-center gap-1.5 mt-4 text-sm text-[#af4408] hover:underline"><ArrowLeft className="w-4 h-4" /> Back to Bills on Hold</Link>
      </div>
    </div>
  );

  const open = boh.status === 'open';
  const dp = Number(boh.days_pending) || 0;
  const pendWord = !boh.expected_payment_date ? 'No expected date set'
    : dp > 0 ? `${dp} day${dp === 1 ? '' : 's'} past the expected date`
    : dp === 0 ? 'Expected today'
    : `${Math.abs(dp)} day${Math.abs(dp) === 1 ? '' : 's'} to go`;
  const pendTone = !boh.expected_payment_date || dp === 0 ? 'text-amber-700' : dp > 0 ? 'text-rose-700' : 'text-[#8B7355]';
  const noNumber = !String(boh.customer_mobile || '').trim();
  /**
   * THE AUDIT LOG, OLDEST FIRST, IN THE ORDER IT WAS WRITTEN.
   *
   * These rows are what the owner reads to answer "what changed, from what, to
   * what" — so an order that is merely plausible is not good enough. Every
   * audit row is stamped to the second and keyed by a random UUID, so a burst
   * of writes came back shuffled: measured, `create` rendered LAST and a
   * payment taking the balance 300 → 600 rendered above the one taking it
   * 0 → 100. `seq` is the row's SQLite rowid, supplied by the server
   * (src/lib/boh-timeline-seq.ts); the timestamp still decides first, so this
   * changes nothing for rows written in different seconds.
   */
  const auditRows: any[] = [...(data?.audit || [])].sort((a: any, b: any) =>
    String(a?.created_at || '').localeCompare(String(b?.created_at || '')) || (Number(a?.seq) || 0) - (Number(b?.seq) || 0));

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">

        {/* HEADER */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/boh" aria-label="Back to Bills on Hold" className="p-2 rounded-lg border border-[#af4408]/30 text-[#af4408] hover:bg-[#af4408]/10"><ArrowLeft className="w-5 h-5" /></Link>
            <div className="p-2 bg-[#af4408]/10 rounded-lg"><Banknote className="w-6 h-6 text-[#af4408]" /></div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-[#af4408] truncate">Bill {boh.bill_number || '—'}</h1>
              <p className="text-sm text-[#8B7355]">
                Put on hold {niceDate(boh.bill_date)}{boh.table_label ? ` · ${boh.table_label}` : ''}{boh.department_name ? ` · ${boh.department_name}` : ''}
              </p>
            </div>
          </div>
          <button onClick={load} className="flex items-center gap-1.5 text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-2 rounded-lg text-sm font-medium">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* STATE BANNERS — the loud things, before anything else. */}
        {boh.reconcile_needed && (
          <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              <b>This bill is now “{boh.order_status || 'gone'}” at the till, not on hold.</b> Someone took the payment
              through the Cashier screen instead of here. Recording another payment on this page would count the same
              money twice, so it is blocked — a manager should close this record as settled at the till.
            </span>
          </div>
        )}
        {boh.status === 'closed' && (
          <div className="bg-emerald-50 border border-emerald-300 rounded-xl px-4 py-3 text-sm text-emerald-900 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {boh.close_kind === 'write_off'
                ? <>This bill was <b>written off</b> on {stampDate(boh.closed_at)} with {money(boh.balance_amount)} never collected.{boh.close_remarks ? ` Reason: ${boh.close_remarks}` : ''}</>
                : boh.close_kind === 'settled_outside_boh'
                ? <>Closed on {stampDate(boh.closed_at)} — the payment was taken at the till.{boh.close_remarks ? ` ${boh.close_remarks}` : ''}</>
                : <>Paid in full and closed on {stampDate(boh.closed_at)}. Nothing more to collect.</>}
            </span>
          </div>
        )}
        {boh.status === 'void' && (
          <div className="bg-[#F5EDE2] border border-[#D4B896] rounded-xl px-4 py-3 text-sm text-[#6B5744] flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>This record was voided{boh.voided_by ? ` by ${boh.voided_by}` : ''}{boh.void_reason ? ` — ${boh.void_reason}` : ''}. Its history is kept below and nothing can be added to it.</span>
          </div>
        )}

        {/* WHAT IS OWED + WHO IS CHASING IT */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-[#F0E6D8] border-b border-[#F0E6D8]">
            <div className="p-3">
              <div className="text-xs text-[#8B7355]">Bill amount</div>
              <div className="text-xl font-bold text-[#2D1B0E] tabular-nums">{money(boh.principal_amount)}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-[#8B7355]">Collected so far</div>
              <div className="text-xl font-bold text-emerald-700 tabular-nums">{money(boh.paid_amount)}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-[#8B7355]">Still owed</div>
              <div className="text-xl font-bold text-[#af4408] tabular-nums">{money(boh.balance_amount)}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-[#8B7355]">Expected {boh.expected_payment_date ? niceDate(boh.expected_payment_date) : ''}</div>
              <div className={`text-sm font-semibold ${pendTone}`}>{pendWord}</div>
            </div>
          </div>

          <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#F0E6D8]">
            <div className="p-3 space-y-1">
              <div className="text-xs uppercase font-semibold text-[#6B5744]">Customer</div>
              <div className="text-[#2D1B0E] font-medium">{boh.customer_name || boh.customer_company || <span className="text-[#B9A48C]">No name recorded</span>}</div>
              {boh.customer_company && boh.customer_name && <div className="text-sm text-[#8B7355]">{boh.customer_company}</div>}
              {noNumber ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-amber-800 inline-flex items-center gap-1"><PhoneOff className="w-4 h-4" /> No phone number on this bill</span>
                  {open && <button onClick={() => setModal('contact')} className="text-sm text-[#af4408] underline">Add one</button>}
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={`tel:${boh.customer_mobile}`} className="text-sm text-[#2D1B0E] tabular-nums inline-flex items-center gap-1 hover:text-[#af4408]"><Phone className="w-4 h-4 text-[#af4408]" /> {boh.customer_mobile}</a>
                  {open && <button onClick={() => setModal('contact')} className="text-sm text-[#8B7355] underline hover:text-[#af4408]">Edit</button>}
                </div>
              )}
              {boh.remarks && <div className="text-sm text-[#8B7355] pt-1">{boh.remarks}</div>}
            </div>

            <div className="p-3 space-y-1">
              <div className="text-xs uppercase font-semibold text-[#6B5744]">Chasing this bill</div>
              <div className="text-[#2D1B0E] font-medium">{boh.responsible_name || boh.responsible_email || '—'}</div>
              <div className="text-sm text-[#8B7355]">Put on hold by {boh.created_by || '—'} on {stamp(boh.held_at || boh.created_at)}</div>
              {open && (
                <button onClick={() => setModal('reassign')} className="text-sm text-[#af4408] underline inline-flex items-center gap-1"><UserCog className="w-4 h-4" /> Hand this to someone else</button>
              )}
              {/* WHY THE WHATSAPP REMINDER IS DARK — the server's own sentences,
                  rendered verbatim. Separate blockers stay separate, because
                  "no approved template" and "no number on file" are separate fixes. */}
              {wa && !wa.ready && open && (
                <div className="text-[11px] text-[#8B7355] bg-[#F5EDE2] border border-[#E8D5C4] rounded p-2 mt-1 space-y-0.5">
                  <div className="font-semibold text-[#6B5744] flex items-center gap-1"><Info className="w-3 h-3" /> Reminders reach the app, not WhatsApp yet</div>
                  {(wa.blockers || []).map((b: string, i: number) => <div key={i}>· {b}</div>)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* WHAT YOU CAN DO */}
        {open && (
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setModal('followup')} className="flex items-center gap-1.5 bg-[#af4408] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#963a07]">
              <MessageSquarePlus className="w-4 h-4" /> Log a follow-up
            </button>
            <button onClick={() => setModal('payment')} disabled={boh.reconcile_needed}
              title={boh.reconcile_needed ? 'The bill was paid at the till — a manager must reconcile this record instead.' : ''}
              className="flex items-center gap-1.5 bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed">
              <IndianRupee className="w-4 h-4" /> Record a payment
            </button>
            <button onClick={() => setModal('reassign')} className="flex items-center gap-1.5 border border-[#af4408]/40 text-[#af4408] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#af4408]/10">
              <UserCog className="w-4 h-4" /> Reassign
            </button>
            {/* Closing a bill that still owes money is a WRITE-OFF of an
                accountability record, so it is management-only and the SERVER
                says so. The button is shown to everyone and the refusal explains
                itself: hiding it leaves a manager hunting for it, and a cashier
                guessing why nothing ever closes. */}
            <button onClick={() => setModal('close')} className="flex items-center gap-1.5 border border-[#D4B896] text-[#6B5744] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#F5EDE2]">
              <Lock className="w-4 h-4" /> Close without full payment
            </button>
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-4 items-start">

          {/* ── THE ORIGINAL POS BILL ─────────────────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-[#F5EDE2] flex-wrap">
              <div className="text-sm font-semibold text-[#2D1B0E]">The original bill</div>
              {data?.bill_pdf_url && (
                <a href={data.bill_pdf_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-2.5 py-1.5 rounded-lg">
                  <Download className="w-4 h-4" /> Download / reprint
                </a>
              )}
            </div>

            {!order ? (
              <div className="p-4 text-sm text-[#8B7355]">The original bill is no longer in the system. The amounts above are the ones frozen when it was held, and they still stand.</div>
            ) : (
              <>
                <div className="px-4 py-2 text-[11px] text-[#8B7355] border-b border-[#F0E6D8]">
                  #{order.order_number} · {order.order_type || 'dine-in'}{order.server_name ? ` · ${order.server_name}` : ''}{order.covers ? ` · ${order.covers} covers` : ''} · {stamp(order.created_at)}
                </div>
                <div className="divide-y divide-[#F0E6D8] max-h-[36vh] overflow-y-auto">
                  {items.length === 0 && <div className="px-4 py-6 text-sm text-[#8B7355] text-center">No items on this bill.</div>}
                  {items.map((it: any) => (
                    <div key={it.id} className="flex items-start justify-between gap-2 px-4 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="text-[#2D1B0E]">{it.name}</span>
                        <span className="text-[11px] text-[#8B7355] ml-1">× {it.quantity}</span>
                        {it.notes && <div className="text-[11px] text-[#8B7355]">{it.notes}</div>}
                      </div>
                      <span className="tabular-nums text-[#2D1B0E] shrink-0">{money(it.line_total)}</span>
                    </div>
                  ))}
                </div>
                <div className="px-4 py-3 bg-[#FFF8F0] border-t border-[#F0E6D8] text-sm space-y-1">
                  <Line label="Items" value={money(order.subtotal)} />
                  {Number(order.discount) > 0 && <Line label={`Discount${order.discount_pct ? ` (${order.discount_pct}%)` : ''}`} value={'− ' + money(order.discount)} />}
                  {Number(order.service_charge) > 0 && <Line label="Service charge" value={money(order.service_charge)} />}
                  {Number(order.tax_total) > 0 && <Line label="GST" value={money(order.tax_total)} />}
                  <div className="flex items-center justify-between pt-1 border-t border-[#E8D5C4] font-bold text-[#2D1B0E]">
                    <span>Bill total</span><span className="tabular-nums">{money(order.total)}</span>
                  </div>
                  {/* THE PAISE GAP, explained rather than hidden.
                      The BOH principal is Math.round(orders.total) — the same
                      whole-rupee figure /cashier shows and the same figure the
                      till will collect, because settle-from-hold itself rounds
                      (settle/route.ts:121). If this line were left out, a
                      manager comparing "Bill total ₹1,976.70" with "Bill amount
                      ₹1,977.00" two inches above would reasonably think one of
                      them was wrong. */}
                  {Math.abs(Number(order.total) - Number(boh.principal_amount)) > 0.005 && (
                    <div className="flex items-center justify-between text-[11px] text-[#8B7355] pt-0.5">
                      <span>Rounded to the nearest rupee for collection</span>
                      <span className="tabular-nums">{money(boh.principal_amount)}</span>
                    </div>
                  )}
                </div>
                {/* WHAT THIS SENTENCE USED TO SAY, AND WHY IT CHANGED.
                    The reprint REUSES the existing bill route rather than a new
                    one invented here, and that route used to redraw a held bill
                    from TODAY's settings and leave it unstamped — so this panel
                    warned the reader not to trust the PDF. Both of those have
                    since been fixed in the bill route itself (bill-pdf.ts:55 and
                    bill-pdf/route.ts:59 now treat 'on_hold' exactly like
                    'settled'), and a warning that is no longer true is worse
                    than no warning: it would have the owner distrust a document
                    that is now correct. Re-measured on a booted server before
                    rewriting it — the held bill's PDF carries the frozen total
                    and the DUPLICATE BILL header, and does not move when the
                    service-charge and GST percentages are changed underneath
                    it. If that route ever regresses, this sentence is wrong
                    again and must change with it. */}
                <div className="px-4 py-2 text-[11px] text-[#8B7355] border-t border-[#F0E6D8]">
                  The figures above are the ones frozen when the bill was held — they are what this record chases.
                  The downloaded PDF carries those same frozen figures and is stamped &ldquo;duplicate&rdquo;,
                  so it stays right even if the tax or service-charge settings change later.
                </div>
              </>
            )}
          </div>

          {/* ── THE TIMELINE ──────────────────────────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-[#F5EDE2]">
              <Clock className="w-4 h-4 text-[#af4408]" />
              <div className="text-sm font-semibold text-[#2D1B0E]">Everything that has happened</div>
              <span className="text-[11px] text-[#8B7355] ml-auto">{events.length} entr{events.length === 1 ? 'y' : 'ies'}</span>
            </div>
            <ol className="divide-y divide-[#F0E6D8]">
              {events.map((e, i) => (
                <li key={i} className="px-4 py-2.5 flex gap-3">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                    e.tone === 'pay' ? 'bg-emerald-600'
                    : e.tone === 'follow' ? 'bg-[#af4408]'
                    : e.tone === 'assign' ? 'bg-sky-600'
                    : e.tone === 'remind' ? 'bg-amber-500'
                    : e.tone === 'end' ? 'bg-purple-600' : 'bg-[#2D1B0E]'}`} />
                  <div className="min-w-0">
                    <div className="text-sm text-[#2D1B0E]">
                      <span className="font-semibold">{stamp(e.at)}</span>
                      <span className="text-[#8B7355]"> · </span>
                      {e.text}
                    </div>
                    {e.who && <div className="text-[11px] text-[#8B7355]">by {e.who}</div>}
                  </div>
                </li>
              ))}
            </ol>
            <div className="px-4 py-2 text-[11px] text-[#8B7355] bg-[#FFF8F0] border-t border-[#F0E6D8]">
              Nothing on this list can be edited or removed — not by you, not by an admin, not by this screen.
            </div>
          </div>
        </div>

        {/* ── THE AUDIT LOG ─────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <button onClick={() => setShowAudit(v => !v)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-[#F5EDE2] text-left">
            <History className="w-4 h-4 text-[#af4408]" />
            <span className="text-sm font-semibold text-[#2D1B0E]">Audit log — what changed, from what, to what</span>
            <span className="text-[11px] text-[#8B7355] ml-auto">{auditRows.length} record{auditRows.length === 1 ? '' : 's'} · {showAudit ? 'hide' : 'show'}</span>
          </button>
          {showAudit && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-[#FFF8F0] text-[11px] uppercase text-[#6B5744]">
                  <tr>
                    <th className="text-left px-3 py-1.5">When</th><th className="text-left px-3 py-1.5">Action</th>
                    <th className="text-left px-3 py-1.5">Old value</th><th className="text-left px-3 py-1.5">New value</th>
                    <th className="text-left px-3 py-1.5">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E6D8]">
                  {auditRows.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-[#8B7355]">No audit records yet.</td></tr>}
                  {auditRows.map((a: any) => (
                    <tr key={a.id} className="align-top">
                      <td className="px-3 py-1.5 whitespace-nowrap text-[#8B7355]">{stamp(a.created_at)}</td>
                      <td className="px-3 py-1.5 text-[#2D1B0E]">{String(a.action || '').replace(/^boh\./, '').replace(/_/g, ' ')}</td>
                      <td className="px-3 py-1.5 text-[#8B7355] break-all max-w-[220px]">{a.old_value || '—'}</td>
                      <td className="px-3 py-1.5 text-[#2D1B0E] break-all max-w-[220px]">{a.new_value || '—'}</td>
                      <td className="px-3 py-1.5 text-[#8B7355] break-all">{a.updated_by || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────────── */}
      {modal === 'followup' && <FollowUpModal boh={boh} busy={!!busy} onClose={() => setModal('')} onSave={(b) => post(`/api/boh/${boh.id}/follow-up`, b, 'Follow-up saved.')} />}
      {modal === 'payment'  && <PaymentModal  boh={boh} busy={!!busy} onClose={() => setModal('')} onSave={(b) => post(`/api/boh/${boh.id}/payments`, b, 'Payment recorded.')} />}
      {modal === 'reassign' && <ReassignModal boh={boh} dir={dir} busy={!!busy} onClose={() => setModal('')} onSave={(b) => post(`/api/boh/${boh.id}/reassign`, b, 'Handed over.')} />}
      {modal === 'close'    && <CloseModal    boh={boh} busy={!!busy} onClose={() => setModal('')} onSave={(b) => post(`/api/boh/${boh.id}/close`, b, 'Record closed.')} />}
      {modal === 'contact'  && <ContactModal  boh={boh} busy={!!busy} onClose={() => setModal('')} onSave={patchContact} />}

      {toast && (
        <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm max-w-[92vw] ${toast.ok ? 'bg-emerald-700 text-white' : 'bg-rose-700 text-white'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-[#8B7355]"><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}
