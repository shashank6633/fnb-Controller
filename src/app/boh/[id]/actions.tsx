'use client';

/**
 * The five things you can do to a bill on hold.
 *
 * Every one of these posts to /api/boh/[id]/*, and every one of those routes
 * re-checks the rule this form enforces. The forms are a courtesy — they stop a
 * busy cashier wasting a round trip — and the server's refusal is the rule.
 * Where the two could drift (the seven outcomes, the eight payment modes) both
 * sides read the same tokens.
 *
 * NOTHING HERE MOVES STOCK OR WRITES A SALE. Revenue and stock were both booked
 * the moment the bill was held; a payment recorded on this screen is a
 * collection against a sale that already exists.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { money, niceDate, istToday, OUTCOMES, MODES, inputCls, labelCls, type Boh } from '../shared';

function Shell({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[#F0E6D8] sticky top-0 bg-white">
          <div>
            <h2 className="font-bold text-[#2D1B0E]">{title}</h2>
            {sub && <p className="text-sm text-[#8B7355]">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-[#8B7355] hover:text-[#af4408]"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

interface ModalProps { boh: Boh; busy: boolean; onClose: () => void; onSave: (body: any) => Promise<boolean> }

/* ═══════════════════════════════ FOLLOW-UP ════════════════════════════════ */

/**
 * "When payment is NOT received, remarks and a new expected date are REQUIRED
 * and the next reminder is scheduled — make that impossible to skip."
 *
 * Four things enforce that, three here and one on the server:
 *   1. The two fields APPEAR the moment they become required, so they are never
 *      background furniture a busy cashier scrolls past.
 *   2. Save is disabled AND a line underneath says which field is still
 *      missing — a greyed-out button with no explanation is its own bug.
 *   3. The date picker will not offer a day before today: a past date would be
 *      overdue the instant it was written.
 *   4. addFollowUp() re-checks all three and refuses with 400. That is the rule;
 *      the three above are the courtesy.
 *
 * Note what "not received" covers: everything except a completed collection.
 * A customer who asked for more time, is not responding, is disputing, or whose
 * payment is "processing" has not paid — each of those must leave a date the
 * system can chase, or the loop the owner described quietly stops.
 */
export function FollowUpModal({ boh, busy, onClose, onSave }: ModalProps) {
  const [outcome, setOutcome] = useState('');
  const [remarks, setRemarks] = useState('');
  const [next, setNext] = useState('');
  const today = istToday();
  const chosen = OUTCOMES.find(o => o.key === outcome);
  const needsMore = !!chosen && !chosen.paid;
  const ready = !!outcome && (!needsMore || (remarks.trim().length > 0 && !!next));

  return (
    <Shell title="Log a follow-up" sub={`${boh.customer_name || boh.customer_company || 'This customer'} · ${money(boh.balance_amount)} still owed`} onClose={onClose}>
      <div>
        <span className={labelCls}>What happened?</span>
        <div className="space-y-1.5">
          {OUTCOMES.map(o => (
            <label key={o.key} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${outcome === o.key ? 'border-[#af4408] bg-[#af4408]/5' : 'border-[#E8D5C4] hover:border-[#D4B896]'}`}>
              <input type="radio" name="outcome" value={o.key} checked={outcome === o.key} onChange={() => setOutcome(o.key)} className="accent-[#af4408]" />
              <span className="text-[#2D1B0E]">{o.label}</span>
            </label>
          ))}
        </div>
      </div>

      {chosen?.paid && (
        <div className="text-sm bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
          This only records that the customer <b>said</b> they have paid. It does not move any money.
          When the payment actually lands, close this box and use <b>Record a payment</b> — that is the only
          thing that reduces the balance.
        </div>
      )}

      {needsMore && (
        <>
          <div className="text-sm bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-[#6B5744]">
            The money has not come in, so two things are required: <b>what was said</b>, and <b>when you will chase again</b>.
            The new date schedules the next reminder.
          </div>
          <div>
            <label className={labelCls}>What was said <span className="text-rose-600">*</span></label>
            <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={3}
              placeholder="e.g. Spoke to Mr Rao — accounts will release it after their audit on Friday."
              className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>New expected payment date <span className="text-rose-600">*</span></label>
            <input type="date" value={next} min={today} onChange={e => setNext(e.target.value)} className={inputCls} />
            {next && <p className="text-[11px] text-[#8B7355] mt-1">A reminder will reach {boh.responsible_name || 'the person chasing this'} on {niceDate(next)}.</p>}
          </div>
        </>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button disabled={!ready || busy} onClick={() => onSave({ outcome, remarks, next_expected_date: next || undefined })}
          className="flex-1 bg-[#af4408] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#963a07] disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Save follow-up'}
        </button>
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-[#8B7355] hover:text-[#af4408]">Cancel</button>
      </div>
      {!ready && (
        <p className="text-[11px] text-[#8B7355] text-center">
          {!outcome ? 'Pick what happened to continue.'
            : !remarks.trim() ? 'Write what was said to continue.'
            : 'Pick the next date you will chase this.'}
        </p>
      )}
    </Shell>
  );
}

/* ════════════════════════════════ PAYMENT ═════════════════════════════════ */

/**
 * PARTIALS ARE FIRST-CLASS. The amount defaults to the whole balance because
 * that is the common case, but any smaller number is accepted and the remainder
 * stays an active BOH. The line that matters most is "still owed after this",
 * which updates as you type — a cashier should never have to do the subtraction
 * on a busy counter.
 *
 * Over-collection is refused here and on the server. It is almost always a
 * typo, and accepting it would push the replayed tenders past the frozen bill
 * total, which settle's own ±₹1 split check would then refuse — wedging the
 * close on the one payment that was meant to finish it.
 */
export function PaymentModal({ boh, busy, onClose, onSave }: ModalProps) {
  const bal = Number(boh.balance_amount) || 0;
  const [amount, setAmount] = useState(bal.toFixed(2));
  const [mode, setMode] = useState('cash');
  const [paidOn, setPaidOn] = useState(istToday());
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');

  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0 && n - bal <= 0.005;
  const after = valid ? Math.round((bal - n) * 100) / 100 : bal;
  const clears = valid && after <= 0.005;

  return (
    <Shell title="Record a payment" sub={`${money(bal)} still owed on bill ${boh.bill_number || ''}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Amount received</label>
          <input type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className={`${inputCls} tabular-nums`} />
        </div>
        <div>
          <label className={labelCls}>Date received</label>
          <input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className={inputCls} />
        </div>
      </div>

      {!valid && amount !== '' && (
        <p className="text-sm text-rose-700">
          {n > bal ? `That is more than the ${money(bal)} still owed. Record at most the balance.` : 'Enter an amount greater than zero.'}
        </p>
      )}

      <div className={`rounded-lg p-3 text-sm ${clears ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' : 'bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]'}`}>
        {clears
          ? <>This clears the bill. The record closes and the original bill is marked settled — <b>no new sale is created</b>, because the sale was already booked when the bill went on hold.</>
          : <>Still owed after this payment: <b className="tabular-nums">{money(after)}</b>. The bill stays on hold and keeps being chased.</>}
      </div>

      <div>
        <span className={labelCls}>How was it paid?</span>
        <div className="flex flex-wrap gap-1.5">
          {MODES.map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`text-sm px-3 py-1.5 rounded-full capitalize ${mode === m ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>{m}</button>
          ))}
        </div>
      </div>

      <div>
        <label className={labelCls}>Reference (UTR, cheque number, transaction id)</label>
        <input value={reference} onChange={e => setReference(e.target.value)} placeholder="Optional, but worth having" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Remarks</label>
        <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Optional" className={inputCls} />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button disabled={!valid || busy} onClick={() => onSave({ amount: n, mode, paid_on: paidOn, reference, remarks })}
          className="flex-1 bg-emerald-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : clears ? `Record ${money(n)} and close this bill` : `Record ${money(valid ? n : 0)}`}
        </button>
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-[#8B7355] hover:text-[#af4408]">Cancel</button>
      </div>
    </Shell>
  );
}

/* ═══════════════════════════════ REASSIGN ═════════════════════════════════ */

/**
 * "Every reassignment recorded (previous user, new user, changed by, when,
 * why)." All five are written by the server; this form's only job is to make
 * the fifth one impossible to leave blank, and to show the handover in words
 * before it happens so nobody hands a debt to the wrong Ravi.
 */
export function ReassignModal({ boh, dir, busy, onClose, onSave }: ModalProps & { dir: { id: string; name: string }[] }) {
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const picked = dir.find(d => d.id === userId);
  const ready = !!userId && reason.trim().length > 0;

  return (
    <Shell title="Hand this bill to someone else" sub="Both names and your reason are kept on the record for good." onClose={onClose}>
      <div className="text-sm bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-[#6B5744]">
        Right now <b>{boh.responsible_name || boh.responsible_email || '—'}</b> is responsible for collecting {money(boh.balance_amount)}.
      </div>
      <div>
        <label className={labelCls}>Hand it to</label>
        <select value={userId} onChange={e => setUserId(e.target.value)} className={inputCls}>
          <option value="">Choose a person…</option>
          {dir.filter(d => d.id !== boh.responsible_user_id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {dir.length === 0 && <p className="text-[11px] text-[#8B7355] mt-1">Loading the staff list…</p>}
      </div>
      <div>
        <label className={labelCls}>Why <span className="text-rose-600">*</span></label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
          placeholder="e.g. Ravi is on leave from Monday — Priya knows this customer." className={inputCls} />
      </div>
      {picked && reason.trim() && (
        <p className="text-sm text-[#6B5744]">
          This will be recorded as: <b>{boh.responsible_name || '—'} → {picked.name}</b>, by you, today.
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button disabled={!ready || busy} onClick={() => onSave({ user_id: userId, reason })}
          className="flex-1 bg-[#af4408] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#963a07] disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Hand it over'}
        </button>
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-[#8B7355] hover:text-[#af4408]">Cancel</button>
      </div>
      {!ready && <p className="text-[11px] text-[#8B7355] text-center">{!userId ? 'Choose who takes this on.' : 'A reason is required.'}</p>}
    </Shell>
  );
}

/* ════════════════════════════════ CLOSE ═══════════════════════════════════ */

/**
 * Closing a BOH that still carries a balance. MANAGEMENT ONLY, and the server
 * is what enforces that — this dialog is shown to everyone and a cashier's
 * attempt comes back with the reason in full, which is better than a button
 * that silently is not there.
 *
 * "Paid at the till" is offered ONLY when the POS actually shows the bill as no
 * longer on hold. Offering it otherwise would be an invitation to close a live
 * debt by picking the softer-sounding option.
 */
export function CloseModal({ boh, busy, onClose, onSave }: ModalProps) {
  const reconciled = boh.reconcile_needed;
  const [kind, setKind] = useState(reconciled ? 'settled_outside_boh' : 'write_off');
  const [remarks, setRemarks] = useState('');
  const [ack, setAck] = useState(false);
  // MONEY THIS RECORD ALREADY TOOK. When the till has settled the bill AND this
  // record carries collections of its own, the guest has very probably paid
  // twice — and this dialog used to say the opposite ("closes the chase without
  // recording the money twice") while showing only the outstanding figure. The
  // server refuses the close with a 409 until the acknowledgement below is
  // ticked, then stamps the figure permanently onto the record.
  const alreadyHere = Math.max(Number(boh.paid_amount) || 0, 0);
  const doubleRisk = kind === 'settled_outside_boh' && alreadyHere > 0.005;
  const ready = remarks.trim().length > 0 && (!doubleRisk || ack);

  return (
    <Shell title="Close without full payment" sub={`${money(boh.balance_amount)} is still outstanding on this record.`} onClose={onClose}>
      <div className="text-sm bg-amber-50 border border-amber-300 rounded-lg p-3 text-amber-900">
        Only a manager or admin can do this, and it cannot be undone. Everything below is kept on the record for good.
      </div>
      <div className="space-y-1.5">
        <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm ${kind === 'write_off' ? 'border-[#af4408] bg-[#af4408]/5' : 'border-[#E8D5C4]'}`}>
          <input type="radio" checked={kind === 'write_off'} onChange={() => setKind('write_off')} className="accent-[#af4408] mt-0.5" />
          <span><b className="text-[#2D1B0E]">Write it off</b><br /><span className="text-[#8B7355]">The money is never coming. The bill stays exactly as it is; nothing is marked paid.</span></span>
        </label>
        <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm ${!reconciled ? 'opacity-50 cursor-not-allowed border-[#E8D5C4]' : kind === 'settled_outside_boh' ? 'border-[#af4408] bg-[#af4408]/5 cursor-pointer' : 'border-[#E8D5C4] cursor-pointer'}`}>
          <input type="radio" disabled={!reconciled} checked={kind === 'settled_outside_boh'} onChange={() => setKind('settled_outside_boh')} className="accent-[#af4408] mt-0.5" />
          <span><b className="text-[#2D1B0E]">It was paid at the till</b><br /><span className="text-[#8B7355]">
            {!reconciled
              ? 'Only available when the POS shows this bill as already settled. It does not.'
              : alreadyHere > 0.005
                ? `The bill is already settled in the POS — but ${money(alreadyHere)} was also collected here. Check which money is real before closing this.`
                : 'The bill is already settled in the POS. This closes the chase without recording a second collection.'}
          </span></span>
        </label>
      </div>
      {doubleRisk && (
        <div className="text-sm bg-rose-50 border border-rose-300 rounded-lg p-3 text-rose-900 space-y-2">
          <p>
            <b>{money(alreadyHere)} has already been collected on this record</b>, and the till has since settled
            the bill for its full amount. If both collections really happened, the guest paid twice and
            {' '}{money(alreadyHere)} has to be refunded or accounted for.
          </p>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="accent-rose-700 mt-0.5" />
            <span>I have checked what was actually taken. Record {money(alreadyHere)} on this closure.</span>
          </label>
        </div>
      )}
      <div>
        <label className={labelCls}>Why <span className="text-rose-600">*</span></label>
        <textarea value={remarks} onChange={e => setRemarks(e.target.value)} rows={3}
          placeholder="e.g. Company shut down, no recovery possible. Approved by the owner on 18 Sep." className={inputCls} />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button disabled={!ready || busy} onClick={() => onSave({ kind, remarks, acknowledge_collected: doubleRisk ? ack : undefined })}
          className="flex-1 bg-[#6B5744] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#4a3c2f] disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Close this record'}
        </button>
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-[#8B7355] hover:text-[#af4408]">Cancel</button>
      </div>
      {!ready && (
        <p className="text-[11px] text-[#8B7355] text-center">
          {remarks.trim().length === 0 ? 'A reason is required.' : `Confirm you have checked the ${money(alreadyHere)} already collected here.`}
        </p>
      )}
    </Shell>
  );
}

/* ═══════════════════════════════ CONTACT ══════════════════════════════════ */

/**
 * The measured gap this whole module trips over: of the owner's 37 orders, ZERO
 * carry a mobile number. A bill you cannot ring is a bill you cannot chase, so
 * filling one in later is a first-class action rather than a settings page.
 *
 * PATCH /api/boh/[id] writes it with a field-by-field audit row and can never
 * touch money or the expected date — the date moves only through a recorded
 * follow-up, which is what keeps the reminder loop honest.
 */
export function ContactModal({ boh, busy, onClose, onSave }: ModalProps) {
  const [name, setName] = useState(boh.customer_name || '');
  const [mobile, setMobile] = useState(boh.customer_mobile || '');
  const [company, setCompany] = useState(boh.customer_company || '');
  const digits = mobile.replace(/\D/g, '');
  const okNumber = mobile.trim() === '' || digits.length >= 10;

  return (
    <Shell title="Customer details" sub="Who to ring about this bill." onClose={onClose}>
      <div>
        <label className={labelCls}>Name</label>
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Mobile</label>
        <input value={mobile} onChange={e => setMobile(e.target.value)} inputMode="tel" placeholder="10-digit number" className={`${inputCls} tabular-nums`} />
        {!okNumber && <p className="text-sm text-rose-700 mt-1">That is not a full mobile number — 10 digits are needed.</p>}
      </div>
      <div>
        <label className={labelCls}>Company (if the bill is on a company)</label>
        <input value={company} onChange={e => setCompany(e.target.value)} className={inputCls} />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button disabled={!okNumber || busy} onClick={() => onSave({ customer_name: name, customer_mobile: mobile, customer_company: company })}
          className="flex-1 bg-[#af4408] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#963a07] disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Save details'}
        </button>
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-[#8B7355] hover:text-[#af4408]">Cancel</button>
      </div>
    </Shell>
  );
}
