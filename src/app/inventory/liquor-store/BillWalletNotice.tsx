'use client';

/**
 * WHAT A TGBCL BILL SAVE DID TO THE WALLET — told to the person who saved it.
 *
 * Saving a TGBCL bill with its levies (/procure-bill, /procure-bulk) writes the
 * Net Indent, and inside the same transaction tries to write the wallet debit
 * (store-engine.ts upsertBillCharges → liquor-wallet.ts autoDebitForIndent).
 * Owner decision 2026-10-14: a wallet-side problem NEVER takes the bill down —
 * the bill commits and the reply says `bill_charges.wallet_debit.action =
 * 'failed'` with the reason. Before this file nothing on the bill screens read
 * that key: the saver got the green "Bill saved" flash, which vanishes after
 * five seconds, and never learned the wallet was not debited.
 *
 * So the reply is read here, once, into plain notices the page keeps on screen
 * until they are dismissed:
 *   · wallet_debit 'failed'  → the bill was saved, the debit was NOT (fail);
 *   · wallet_debit 'adopted' → a hand-entered debit was taken over (info);
 *   · wallet_debit 'removed' → the Net Indent is ₹0 or less, no debit (info);
 *   · wallet_debit 'none'    → no debit, and the server's note says why: ₹0
 *                              Net Indent, a kept hand-entered debit, or an
 *                              indent dated before the wallet's opening (info);
 *   · covers.error           → a register upload's inward numbers were not
 *                              linked to its charges (warn);
 *   · covers.also_covered_by → an inward number another register already
 *                              covers (warn);
 *   · covers.register        → a register header re-totalled over every inward
 *                              linked to it (info); its wallet_debit, when
 *                              present, is the outcome the notices above read.
 * 'inserted' / 'updated' are the ordinary outcome and say nothing.
 *
 * Every sentence the SERVER wrote is shown verbatim (`note`, `error`) — this
 * file adds only who-to-tell, never a paraphrase of what happened. The server
 * already keeps wallet ledger figures out of these notes (a bar storekeeper with
 * can_procure saves bills but cannot open the management-only wallet page).
 *
 * LIQUOR-RECON (gated: ships only on "Deploy Liqour Reconcilation"). With the
 * module stripped, upsertBillCharges returns no wallet_debit / covers keys, and
 * this returns no notices — the bill screens behave exactly as production.
 */

import { AlertTriangle, Info, X, ShieldAlert } from 'lucide-react';

export type BillWalletTone = 'fail' | 'warn' | 'info';
export interface BillWalletNotice {
  /** Stable per bill + kind, so a re-render or a second identical reply does not stack. */
  key: string;
  tone: BillWalletTone;
  title: string;
  /** The server's own sentence(s), verbatim. */
  lines: string[];
  /** Who to tell, when the fix is not on a page the saver can open. */
  hint?: string;
}

const s = (v: unknown) => String(v ?? '').trim();

/**
 * The notices a bill-save reply carries. `billCharges` is the reply's
 * `bill_charges` (null/undefined when the bill had no charges row — then the
 * wallet was never touched and there is nothing to say).
 */
export function billWalletNotices(billCharges: unknown, invoiceRef: string): BillWalletNotice[] {
  const bc = (billCharges && typeof billCharges === 'object') ? billCharges as Record<string, any> : null;
  if (!bc) return [];
  const ref = s(invoiceRef) || s(bc.invoice_ref) || 'this bill';
  const out: BillWalletNotice[] = [];
  const cv = bc.covers && typeof bc.covers === 'object' ? bc.covers : null;
  /* A register upload can WIDEN its header after the links are written
     (liquor-wallet.ts settleRegisterHeader): the header's invoice value grows to
     span every inward linked to it and the debit is re-derived. The re-derived
     outcome is covers.register.wallet_debit; the server also restates the
     top-level one to match, but the register's is read first so a reply that
     carries only one of them still reports what the wallet finally holds. */
  const reg = cv && cv.register && typeof cv.register === 'object' ? cv.register : null;
  const wd = (reg && reg.wallet_debit && typeof reg.wallet_debit === 'object') ? reg.wallet_debit
    : (bc.wallet_debit && typeof bc.wallet_debit === 'object' ? bc.wallet_debit : null);
  if (wd) {
    const action = s(wd.action);
    if (action === 'failed') {
      out.push({
        key: `${ref}|wallet_failed`,
        tone: 'fail',
        title: `Bill ${ref} was saved — but its TGBCL wallet debit was NOT written`,
        lines: [s(wd.note) || s(wd.error?.message) || 'The wallet debit could not be written.'],
        /* The fix is NEVER a re-save of this bill: /procure-bill refuses a
           recorded invoice as a duplicate (409), and the server's sentence above
           can still end "then re-save" (liquor-wallet.ts). Said here so the
           saver is not sent round that loop. */
        hint: 'The stock and the Net Indent are recorded; only the wallet line is missing. Do not save this bill again — '
          + 'a recorded invoice is refused as a duplicate, so a re-save cannot write the debit. Once the cause is fixed, '
          + '"Write the debit" on the Liquor Wallet page writes it from this recorded indent. If you cannot open that page '
          + '(it is for managers), tell a manager or an admin — it is also on the admin errors bell.',
      });
    } else if (action === 'adopted' || action === 'removed' || action === 'none') {
      /* 'none' is never the ordinary outcome: the server returns it only with a
         reason — the Net Indent is ₹0 or less, a hand-entered debit was kept,
         or the indent is dated before the wallet's opening balance (which
         already includes it). Each is something the saver should know. */
      const note = s(wd.note);
      if (note) {
        out.push({
          key: `${ref}|wallet_${action}`,
          tone: 'info',
          title: action === 'adopted'
            ? `Bill ${ref}: an earlier hand-entered wallet debit was taken over`
            : `Bill ${ref}: no wallet debit written`,
          lines: [note],
        });
      }
    }
  }
  if (reg) {
    const n = (v: unknown) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    out.push({
      key: `${ref}|register_widened`,
      tone: 'info',
      title: `Register ${ref}: its Net Indent now covers every inward linked to it`,
      /* The bill's OWN figures — what the saver typed and the register holds —
         never a wallet-ledger figure. */
      lines: [`Invoice value ${n(reg.previous_invoice_value)} → ${n(reg.invoice_value)}; Net Indent ${n(reg.previous_net_indent_value)} → ${n(reg.net_indent_value)}. `
        + 'The header is totalled over every inward number linked to it across the uploads of this register, not only the rows in this file.'],
    });
  }
  if (cv) {
    if (s(cv.error)) {
      out.push({
        key: `${ref}|covers_error`,
        tone: 'warn',
        title: `Register ${ref} was saved — but the inward numbers its levies cover were NOT recorded`,
        lines: [s(cv.error)],
        hint: 'The wallet page will list those inwards as purchases with no indent record until this is put right. Tell a manager or an admin.',
      });
    }
    const also = Array.isArray(cv.also_covered_by) ? cv.also_covered_by : [];
    if (also.length > 0) {
      out.push({
        key: `${ref}|also_covered`,
        tone: 'warn',
        title: `Register ${ref}: ${also.length} inward number${also.length === 1 ? ' is' : 's are'} also inside another register`,
        lines: also.slice(0, 12).map((a: any) =>
          `Inward ${s(a?.ref) || '?'} is also covered by register ${s(a?.header_ref) || '?'} — the lines recorded under it count towards both registers' invoice value, and so towards both Net Indents.`)
          .concat(also.length > 12 ? [`…and ${also.length - 12} more.`] : []),
        hint: 'One inward belongs to one indent. Check which register it was really charged on.',
      });
    }
  }
  return out;
}

/** Add new notices to the ones on screen; a repeat of a key replaces the old one. */
export function mergeBillWalletNotices(prev: BillWalletNotice[], next: BillWalletNotice[]): BillWalletNotice[] {
  if (next.length === 0) return prev;
  const keys = new Set(next.map(n => n.key));
  return [...prev.filter(p => !keys.has(p.key)), ...next];
}

const TONE: Record<BillWalletTone, string> = {
  fail: 'bg-red-50 border-red-300 text-red-900',
  warn: 'bg-amber-50 border-amber-300 text-amber-900',
  info: 'bg-sky-50 border-sky-200 text-sky-900',
};

/** The notices, kept on screen until dismissed (unlike the 5-second flash). */
export function BillWalletNotices({ notices, onDismiss }: {
  notices: BillWalletNotice[];
  /** Omitted → no dismiss button (e.g. inside a modal that is about to close). */
  onDismiss?: (key: string) => void;
}) {
  if (!notices || notices.length === 0) return null;
  return (
    <div className="space-y-2" data-bill-wallet-notices={notices.length}>
      {notices.map(n => (
        <div key={n.key} data-notice={n.key} data-tone={n.tone}
             className={`border rounded-lg p-3 text-sm flex items-start gap-2 ${TONE[n.tone]}`}>
          {n.tone === 'fail'
            ? <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            : n.tone === 'warn' ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> : <Info className="w-4 h-4 shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="font-semibold">{n.title}</div>
            {n.lines.map((l, i) => <div key={i} className="text-[12px]">{l}</div>)}
            {n.hint && <div className="text-[11px] opacity-80">{n.hint}</div>}
          </div>
          {onDismiss && (
            <button type="button" onClick={() => onDismiss(n.key)} title="Dismiss"
                    className="shrink-0 opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
