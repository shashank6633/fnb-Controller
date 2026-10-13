'use client';

/**
 * THE FOURTH STORE CHECK — "has this bill gone to Accounts?"
 * =========================================================
 *
 * The owner's instruction, verbatim:
 *   "DONT NEED TO REVIEW ANY PAST BILLS FROM THE NEXT DAY OF DEPLOYMENT
 *    IT SHOULD ASK IN QUALITY CHECK FOR STORE PERSON"
 *
 * So it is asked HERE — inside the store half of the receiving quality check,
 * on both doors (the PO receive modal and the ad-hoc /grn receipt), at the exact
 * moment the store person has the vendor's paper in their hand. They have just
 * typed the bill number off it, typed its date off it, and are ticking a box
 * that says "Invoice matches PO (rate, qty, vendor)". Nothing has to be
 * remembered, no screen has to be visited later, and nothing is retyped.
 *
 * ── WHAT IT COSTS THE PERSON AT THE DELIVERY DOOR ─────────────────────────
 * ZERO TAPS in the common case. The default answer — "With the store" — is what
 * is actually true at the instant a delivery is received, so a receiver who
 * reads this and carries on has still recorded the bill correctly. One tap moves
 * it to "Handed to Accounts now" if the paper is going across the counter there
 * and then. Every target is a full-width button, not a checkbox.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * IT NEVER BLOCKS A RECEIPT. There is a truck at the bay; a bill-register
 * question may not be the thing that stops goods being booked in. The receipt is
 * the important write and it happens first — this answer is applied immediately
 * afterwards, and if that follow-up fails the receipt still stands and the bill
 * turns up on the store screen's "not yet recorded" list.
 *
 * IT DOES NOT RETYPE ANYTHING. Bill number, vendor, bill date and value are
 * shown read-only, straight off the form, and are NOT posted: the server reads
 * identity from the goods receipt itself. The brief is explicit that a store
 * person retyping a number the system already knows is how the two copies come
 * to disagree.
 *
 * IT DOES NOT ASK ABOUT A BILL THAT DOES NOT EXIST. With no vendor bill number —
 * on /grn that is a declared state (cash market run, sample, donation, return) —
 * the question answers itself and says so.
 *
 * IT DOES NOT ASK OUTSIDE THE REGISTER. Before the recorded cutoff date it shows
 * one grey line naming that date instead of a question the server would refuse.
 * That line is also the answer to "where are last month's bills?", asked at the
 * only place a receiver would think to ask it.
 *
 * ── LIQUOR IS OUT OF SCOPE FOR v1 ─────────────────────────────────────────
 * TGBCL / liquor inward never comes through either of these two doors (measured:
 * 62 purchase rows in store-routed categories, ZERO with a grn_id — it runs on
 * its own store_stock_ledger rail). Nothing here silently swallows one; they
 * simply never reach this component. The store register says so on its own face.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Receipt,
  Loader2,
  Camera,
  X,
  Check,
  Store as StoreIcon,
  ArrowRightLeft,
  Ban,
  ShieldAlert,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  bhDateInRange,
  bhKb,
  bhRupees,
  compressBillScan,
  resolveBhMode,
  type BhAnswerMode,
  type BhCutoff,
  type BillHandoverAnswer,
} from '@/lib/bill-handover-client';

interface SummaryShape {
  cutoff?: BhCutoff;
  can?: { record?: boolean; confirm?: boolean };
}

const OPTIONS: { k: BhAnswerMode; label: string; sub: string; icon: typeof StoreIcon }[] = [
  {
    k: 'store',
    label: 'With the store',
    sub: 'Bill is in our hands — not handed over yet',
    icon: StoreIcon,
  },
  {
    k: 'submitted',
    label: 'Handed to Accounts now',
    sub: 'Going across to Accounts with this delivery',
    icon: ArrowRightLeft,
  },
  {
    k: 'none',
    label: 'No vendor bill',
    sub: 'Nothing on paper came with this delivery',
    icon: Ban,
  },
];

export default function BillHandoverCheck({
  receivedDate,
  hasBill,
  billNo,
  vendorName,
  billDate,
  billValue,
  value,
  onChange,
  disabled = false,
}: {
  /** The business date of the RECEIVING event — what the cutoff compares. */
  receivedDate: string;
  /** Does this receipt carry a vendor bill number at all? */
  hasBill: boolean;
  billNo: string;
  vendorName: string;
  billDate: string;
  /** Bill total as this form has computed it. Display only — never posted. */
  billValue: number;
  value: BillHandoverAnswer;
  onChange: (next: BillHandoverAnswer) => void;
  disabled?: boolean;
}) {
  const [summary, setSummary] = useState<SummaryShape | null | undefined>(undefined); // undefined = loading
  const [fileNote, setFileNote] = useState<string>('');
  const [working, setWorking] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** The answer overwritten by the forced 'none' below, so it can be given back
   *  if the refusal stops applying. Never the user's own 'none'. */
  const forcedFrom = useRef<BhAnswerMode | null>(null);

  /* One read, on mount. It answers three questions at once: may this user record
     a handover at all, is the register ready, and what date does it start from.
     A 401/403 is NOT an error here — it is the answer "this is not your job",
     and the block simply does not render. POST /api/grn gates on nothing but a
     signed-in session, so a user who can create a receipt but cannot record a
     handover is a real case, not a theoretical one. */
  useEffect(() => {
    let dead = false;
    api('/api/bill-submissions/summary')
      .then(async r => (r.ok ? ((await r.json()) as SummaryShape) : null))
      .then(j => {
        if (!dead) setSummary(j);
      })
      .catch(() => {
        if (!dead) setSummary(null);
      });
    return () => {
      dead = true;
    };
  }, []);

  /* ── WHEN THE REGISTER IS GOING TO REFUSE THIS RECEIPT, SAY 'none' ────────
     THE BUG THIS CLOSES, and it is not cosmetic. The two receiving screens post
     the answer AFTER the receipt saves, unconditionally — they call
     recordBillHandoverForReceipt(grnId, grnNumber, billHandover, hasBill) on
     every outcome, whatever this component chose to render. The starting answer
     is BH_ANSWER_DEFAULT = { mode: 'store' }. So whenever this component hides
     the question, the host still POSTs /api/bill-submissions with mode 'store'
     and the server refuses it — 403 for an Accounts-role holder, 400/503 outside
     the cutoff — and the receiving screen then shows the receipt with an amber
     "the bill was NOT recorded" panel (grn/page.tsx: `j.bill_handover?.ok ===
     false` forces the panel). The receiver has just been told on this very block
     that no record would be created, and is then shown what reads like a failure
     for every delivery they take. That is the misbehaviour.

     THE OWNER'S CASE IS THE COMMON ONE. He has no dedicated accounts user (nine
     users, none in Accounts), so the plausible day-one move is to give the new
     Accounts role to the STORE person or to an existing manager — the very
     people who receive deliveries. canRecordBillHandover() refuses an
     Accounts-role holder BY NAME (bill-handover.ts:161) and that rule is
     structural: whoever hands a bill over may not be the one who signs for it.
     It is not this component's to weaken. What IS this component's job is to
     stop claiming a record will be made, and to stop the host posting one that
     cannot succeed.

     So: when the refusal is CERTAIN, the answer is set to 'none', which
     recordBillHandoverForReceipt short-circuits — no request, no 403, no false
     failure, and the truthful line "No vendor bill was recorded for this
     receipt". Certain means the summary ANSWERED and said either "you may not
     record" or "this date is outside the register". A summary that failed to
     load is NOT certain — the POST may well succeed — so the blind default is
     left exactly as it was, and the delivery still lands on the store register's
     "Bill not recorded" list if it does not. */
  const answered = summary !== undefined;
  const knownRefusal =
    !!summary &&
    (summary.can?.record !== true || !bhDateInRange(summary.cutoff || null, receivedDate));

  const applyMode = useCallback(
    (next: BhAnswerMode) => onChange({ ...value, mode: next }),
    [onChange, value],
  );
  useEffect(() => {
    if (!answered) return;
    if (knownRefusal) {
      if (value.mode !== 'none') {
        forcedFrom.current = value.mode;
        applyMode('none');
      }
    } else if (forcedFrom.current && value.mode === 'none') {
      // The receipt's date moved back inside the register (the receiver edited
      // it) — give back the answer that was overwritten rather than leaving a
      // recordable bill silently unrecorded.
      const back = forcedFrom.current;
      forcedFrom.current = null;
      applyMode(back);
    }
  }, [answered, knownRefusal, value.mode, applyMode]);

  if (summary === undefined) return null; // still loading — never flash a half-question

  /* NOT A VIEWER OF THE REGISTER AT ALL — a plain staff user, or the call
     failed. Stay silent, deliberately. The server would refuse them, they have
     no remedy at a delivery door, and their receipt still lands on the store
     manager's "Bill not recorded" list, which is the designed backstop. */
  if (!summary) return null;

  const cutoff = summary.cutoff || null;

  /* ── BEFORE THE REGISTER STARTS ────────────────────────────────────────────
     One grey line, not a question. The server refuses an out-of-range create
     with a 400 naming the date, so asking here would only produce a refusal the
     receiver cannot act on. Saying the date instead answers the question they
     would otherwise ask ("why is it not asking me?" / "where are last month's
     bills?") at the moment they would ask it. */
  if (!bhDateInRange(cutoff, receivedDate)) {
    return (
      <div className="rounded-lg border border-[#E8D5C4] bg-[#F7F1E9] px-2.5 py-2 text-[10px] leading-snug text-[#6B5744] flex items-start gap-1.5">
        <Receipt className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#8B7355]" />
        <span>
          {cutoff?.ready && cutoff.date ? (
            <>
              <b>Bill handover to Accounts starts on {cutoff.date}.</b> This receipt is dated{' '}
              {receivedDate || '—'}, so it is not tracked in the bill register. Bills received before
              the start date were deliberately left out — the instruction was to start forward, not
              to review past bills.
            </>
          ) : (
            <>
              <b>The bill register is not ready yet</b> — its start date has not been recorded.
              Nothing is lost; the goods receipt saves normally.
            </>
          )}
        </span>
      </div>
    );
  }

  /* ── THE PERSON AT THE DOOR CANNOT RECORD A HANDOVER ──────────────────────
     Only two kinds of user reach this line, and they must NOT be treated alike.

     (a) THEY HOLD THE "Accounts" ROLE. The server refuses them the store half
         BY NAME — POST /api/bill-submissions answers 403 "The Accounts team
         confirms receipt; it does not record the handover" — and that refusal
         is correct: the whole evidentiary value of this register is that the
         person who hands a bill over is never the person who signs for it.
         But it is also a configuration mistake waiting to happen. The owner has
         no dedicated accounts user today (9 users: 4 admins, one store, one
         bar, three test), so the plausible first move on day one is to give the
         new Accounts role to somebody who ALREADY receives deliveries. If this
         block just vanished for them, the bill question would disappear from
         the receiving door with no message of any kind, and the feature would
         look dead on the day it was rolled out. So it says what happened, what
         it costs, and exactly who fixes it.

     (b) ANYONE ELSE who cannot record — handled above, silently, and on
         purpose. This branch is only ever the Accounts case. */
  if (summary.can?.record !== true) {
    if (summary.can?.confirm !== true) return null;
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[10px] leading-snug text-amber-900 flex items-start gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          <b>You hold the Accounts role, so the store&apos;s bill question is not shown to you.</b>{' '}
          Accounts confirm that a bill <i>arrived</i>; they do not record the handover. That
          separation is what makes the trail worth something, and the server enforces it — holding
          the store job as well does not change it.
          <span className="block mt-1">
            <b>This delivery saves normally and nothing fails.</b> No bill record is created for it,
            and you will not be shown an error about one: the delivery appears on{' '}
            <b>Purchasing → Bill Handover to Accounts</b> under <b>&ldquo;Bill not recorded&rdquo;</b>,
            where any store user records it in one tap with the bill number, vendor and value read
            straight off this receipt. Nothing is retyped and nothing is lost.
          </span>
          <span className="block mt-1">
            If you are the person who receives deliveries here, there are two ways to close this for
            good, and an administrator does either one in <b>Settings → Users</b>: move the Accounts
            role to whoever actually works in Accounts, or leave it with you and let a second store
            user record the bills.
          </span>
        </span>
      </div>
    );
  }

  /* ── HOLDS BOTH SIDES AND CAN STILL RECORD ────────────────────────────────
     An Administrator — including one who has ALSO been given the Accounts role,
     where canRecordBillHandover()'s admin exemption is checked before the
     Accounts refusal (bill-handover.ts:160-161), so the question is correctly
     still asked. What is NOT true for them is the thing the rest of this block
     implies: selfConfirmRefusal() has no admin exemption, so the bill they are
     about to record is one they will never be allowed to confirm. Better said
     here, in one line, than discovered as a refusal on the Accounts screen with
     the paper long gone. */
  const holdsBothSides = summary.can?.confirm === true;

  const mode = resolveBhMode(value, hasBill);
  const set = (patch: Partial<BillHandoverAnswer>) => onChange({ ...value, ...patch });

  async function pickFile(f: File | null) {
    if (!f) {
      set({ file: null });
      setFileNote('');
      return;
    }
    setWorking(true);
    try {
      // Compress HERE, at pick time, so the receiver sees the real outcome while
      // the bill is still in their hand — not thirty seconds later, after the
      // receipt is committed, when the only remedy is to find the paper again.
      const c = await compressBillScan(f);
      set({ file: f });
      setFileNote(
        c.originalBytes > c.outBytes
          ? `${f.name} · ${bhKb(c.originalBytes)} → ${bhKb(c.outBytes)}, ready`
          : `${f.name} · ${bhKb(c.outBytes)}, ready`,
      );
    } catch (e) {
      set({ file: null });
      setFileNote((e as Error)?.message || 'That file could not be used.');
    } finally {
      setWorking(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="border border-blue-200 rounded-lg p-3 bg-blue-50/40 space-y-2">
      <div className="text-xs font-semibold text-blue-900 flex items-center gap-1.5 flex-wrap">
        <Receipt className="w-3.5 h-3.5" /> The vendor&apos;s bill — where is it going?
        <span className="text-[10px] font-normal text-blue-700">
          asked here so it is answered with the paper in your hand
        </span>
      </div>

      {/* WHAT THE SYSTEM ALREADY KNOWS, shown read-only. Nothing in this strip is
          posted — the server reads identity off the goods receipt itself. It is
          here so the receiver can check the register will describe the right
          piece of paper before they answer. */}
      <div className="rounded border border-blue-200/70 bg-white/70 px-2 py-1.5 text-[11px] text-[#2D1B0E] flex flex-wrap gap-x-3 gap-y-0.5">
        <span>
          <span className="text-[#8B7355]">Bill</span>{' '}
          <b className="font-mono">{hasBill ? billNo : '—'}</b>
        </span>
        <span>
          <span className="text-[#8B7355]">Vendor</span> <b>{vendorName || '—'}</b>
        </span>
        <span>
          <span className="text-[#8B7355]">Bill date</span> <b>{billDate || receivedDate || '—'}</b>
        </span>
        <span>
          <span className="text-[#8B7355]">Value</span>{' '}
          <b className="font-mono">{bhRupees(billValue)}</b>
        </span>
        <span className="text-[10px] text-[#8B7355] w-full">
          Taken from this receipt — you are not retyping it, and it cannot drift from the purchase.
        </span>
      </div>

      {!hasBill ? (
        /* NO PAPER, NO QUESTION. Stated rather than silently skipped, because the
           receiver needs to know why the bill register will have nothing for this
           delivery — and that that is correct, not a miss. */
        <div className="rounded border border-[#D4B896] bg-[#FFF8F0] px-2 py-1.5 text-[11px] text-[#6B5744] flex items-start gap-1.5">
          <Ban className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#8B7355]" />
          <span>
            <b>No vendor bill number on this receipt</b>, so there is nothing to hand to Accounts and
            nothing is recorded in the bill register. Enter the bill number above if the vendor did
            give you paper.
          </span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
            {OPTIONS.map(o => {
              const on = mode === o.k;
              const Icon = o.icon;
              return (
                <button
                  key={o.k}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() => set({ mode: o.k })}
                  /* min-h-[52px]: a thumb at a delivery door, not a mouse. */
                  /* Selected tones stay inside the app's accent family and match
                     the status colours the register and the Accounts queue use
                     for the same two states (#8a3506 = "submitted", #af4408 =
                     "still ours"), so the answer given here looks like the row
                     it produces. */
                  className={`min-h-[52px] text-left rounded-lg border px-2.5 py-2 transition-colors active:scale-[0.99] disabled:opacity-50 ${
                    on
                      ? o.k === 'submitted'
                        ? 'bg-[#8a3506] border-[#8a3506] text-white'
                        : o.k === 'store'
                          ? 'bg-[#af4408] border-[#af4408] text-white'
                          : 'bg-[#6B5744] border-[#6B5744] text-white'
                      : 'bg-white border-[#D4B896] text-[#2D1B0E] hover:bg-[#FFF1E3]'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-bold leading-tight">
                    {on ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Icon className="w-3.5 h-3.5 shrink-0" />}
                    {o.label}
                  </span>
                  <span
                    className={`block text-[10px] leading-snug mt-0.5 ${on ? 'text-white/85' : 'text-[#8B7355]'}`}
                  >
                    {o.sub}
                  </span>
                </button>
              );
            })}
          </div>

          {/* THE CONSEQUENCE OF THE CHOSEN ANSWER, stated before Confirm rather
              than discovered on a list afterwards. "Handed to Accounts" is a
              HANDOVER claim about a piece of paper — the wording says so in as
              many words, because the one thing it must never be read as is a
              payment. */}
          <div
            className={`text-[10px] leading-snug rounded px-2 py-1.5 border ${
              mode === 'submitted'
                ? 'bg-[#FFF1E3] border-[#D4B896] text-[#8a3506]'
                : mode === 'store'
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : 'bg-[#F5EDE3] border-[#E8D5C4] text-[#6B5744]'
            }`}
          >
            {mode === 'submitted' ? (
              <>
                This records that <b>you physically handed this bill to the Accounts team</b> and
                stamps the time under your name. It is a handover of paper — <b>not</b> a payment,
                and it does not approve or settle anything. Accounts then confirm they received it,
                and their name and time are stamped too.
              </>
            ) : mode === 'store' ? (
              <>
                The bill is recorded as <b>Pending Submission</b> and stays on the store&apos;s list
                until someone marks it handed over. Nothing goes to Accounts yet.
              </>
            ) : (
              <>
                Nothing will be recorded in the bill register for this delivery. Use this only when
                the vendor genuinely gave you no paper.
              </>
            )}
          </div>

          {/* HOLDS BOTH SIDES — the one thing the panel above does not say.
              Reached only when can.record AND can.confirm are both true, which
              on this codebase means an administrator (canRecordBillHandover
              exempts admin at bill-handover.ts:160 BEFORE the Accounts refusal
              at :161, so an admin who has also been given the Accounts role
              still gets asked the question — correctly). What is not true for
              them is the implication of the consequence line above: "Accounts
              then confirm they received it" will not be them.
              selfConfirmRefusal() has NO admin exemption — it refuses on
              submitted_by_id or created_by_id matching the actor — so the row
              this answer is about to create is one they personally can never
              confirm. Said here, with the paper still in hand, rather than
              discovered as a 403 on the Accounts screen days later.
              Only when something is actually being recorded: at mode 'none'
              there is no row and nothing to confirm. */}
          {holdsBothSides && mode !== 'none' && (
            <div className="rounded border border-[#D4B896] bg-[#FFF8F0] px-2 py-1.5 text-[10px] leading-snug text-[#6B5744] flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#8B7355]" />
              <span>
                <b>You hold the Accounts side as well, so you will not be able to confirm this
                one yourself.</b>{' '}
                Recording it puts your name on the store half, and nobody may sign for a bill they
                handed over — the server refuses that even for an administrator. Someone else on the
                Accounts side closes it at <b>Purchasing → Bill Handover — Accounts</b>. Your stamp
                here stands either way.
              </span>
            </div>
          )}

          {mode !== 'none' && (
            <div className="flex flex-wrap items-center gap-2">
              {/* capture="environment" opens the rear camera straight away on a
                  phone, which is the whole interaction: point at the bill, done.
                  The file is compressed in the browser BEFORE it is sent —
                  a phone photo of a bill is routinely 3-5 MB and the production
                  proxy refuses anything over ~1 MB with an HTML 413. */}
              <input
                ref={fileRef}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                className="hidden"
                onChange={e => pickFile(e.target.files?.[0] || null)}
              />
              <button
                type="button"
                disabled={disabled || working}
                onClick={() => fileRef.current?.click()}
                className="min-h-[40px] px-3 rounded-lg border border-[#D4B896] bg-white text-[11px] font-semibold text-[#6B5744] flex items-center gap-1.5 hover:bg-[#FFF1E3] active:scale-[0.99] disabled:opacity-50"
              >
                {working ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Camera className="w-3.5 h-3.5" />
                )}
                {value.file ? 'Change photo' : 'Photo of the bill'}
                <span className="font-normal text-[#8B7355]">(optional)</span>
              </button>
              {value.file && (
                <button
                  type="button"
                  onClick={() => pickFile(null)}
                  className="min-h-[40px] px-2 rounded-lg border border-[#E8D5C4] bg-white text-[11px] text-[#8B7355] flex items-center gap-1 hover:bg-[#FFF1E3]"
                >
                  <X className="w-3.5 h-3.5" /> Remove
                </button>
              )}
              <input
                value={value.note}
                onChange={e => set({ note: e.target.value })}
                disabled={disabled}
                placeholder={
                  mode === 'submitted' ? 'Handed to whom? (optional)' : 'Note (optional)'
                }
                className="flex-1 min-w-[150px] min-h-[40px] px-2 border border-[#E8D5C4] rounded-lg text-[11px] bg-white"
              />
            </div>
          )}

          {fileNote && (
            <div
              className={`text-[10px] leading-snug ${value.file ? 'text-emerald-800' : 'text-red-700'}`}
            >
              {fileNote}
            </div>
          )}
        </>
      )}

      {/* WHERE THIS ENDS UP, and the start date, on the screen where the record
          is created. Requirement 4 of the brief: nobody should have to wonder
          where last month's bills are. */}
      <div className="text-[10px] text-blue-700 leading-snug">
        Recorded when you confirm this receipt, and tracked at{' '}
        <b>Purchasing → Bill Handover to Accounts</b>.
        {cutoff?.date ? <> This register covers bills received on or after <b>{cutoff.date}</b>.</> : null}
      </div>
    </div>
  );
}
