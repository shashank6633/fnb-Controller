'use client';

/**
 * WHAT A TGBCL BILL SAVE DID TO THE WALLET — told to the person who saved it.
 *
 * A TGBCL liquor bill is saved on Goods Receipt → TGBCL Liquor Bill (POST
 * /api/grn, liquor branch, src/lib/liquor-grn.ts; owner rulings #83/#84). That
 * save writes the Net Indent through upsertBillCharges, and inside the same
 * transaction the Liquor Reconciliation hook tries to write the wallet debit
 * (store-engine.ts [LIQUOR-RECON] → liquor-wallet.ts autoDebitForIndent).
 * Owner decision 2026-10-14: a wallet-side problem NEVER takes the bill down —
 * the bill commits and the reply says `bill_charges.wallet_debit.action =
 * 'failed'` with the reason.
 *
 * So the reply is read here, once, into plain notices kept on the saved panel:
 *   · wallet_debit 'failed'  → the bill was saved, the debit was NOT (fail);
 *   · wallet_debit 'adopted' → a hand-entered debit was taken over (info);
 *   · wallet_debit 'removed' → the Net Indent is ₹0 or less, no debit (info);
 *   · wallet_debit 'none'    → no debit, and the server's note says why: ₹0
 *                              Net Indent, a kept hand-entered debit, or an
 *                              indent dated before the wallet's opening (info).
 * 'inserted' / 'updated' are the ordinary outcome and say nothing.
 *
 * Every sentence the SERVER wrote is shown verbatim (`note`, `error`) — this
 * file adds only who-to-tell, never a paraphrase of what happened. The server
 * already keeps wallet ledger figures out of these notes (a bar storekeeper with
 * can_procure saves bills but cannot open the management-only wallet page).
 *
 * LIQUOR-RECON (gated: ships only on "Deploy Liquor Reconciliation"). Without
 * the module, upsertBillCharges returns no wallet_debit key and this returns no
 * notices — the GRN screen behaves exactly as production.
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
  const wd = bc.wallet_debit && typeof bc.wallet_debit === 'object' ? bc.wallet_debit : null;
  if (!wd) return [];
  const action = s(wd.action);
  if (action === 'failed') {
    return [{
      key: `${ref}|wallet_failed`,
      tone: 'fail',
      title: `Indent ${ref} was saved — but its TGBCL wallet debit was NOT written`,
      lines: [s(wd.note) || s(wd.error?.message) || 'The wallet debit could not be written.'],
      /* The fix is NEVER entering this bill again: Goods Receipt refuses an
         indent number that is already recorded (409). Said here so the saver is
         not sent round that loop. */
      hint: 'The bottles and the Net Indent are recorded; only the wallet line is missing. Do not enter this bill again — '
        + 'Goods Receipt refuses an indent number that is already recorded. Once the cause is fixed, '
        + '"Write the debit" on the Liquor Wallet page writes it from this recorded indent. If you cannot open that page '
        + '(it is for managers), tell a manager or an admin — it is also on the admin errors bell.',
    }];
  }
  if (action === 'adopted' || action === 'removed' || action === 'none') {
    /* 'none' is never the ordinary outcome: the server returns it only with a
       reason — the Net Indent is ₹0 or less, a hand-entered debit was kept, or
       the indent is dated before the wallet's opening balance (which already
       includes it). Each is something the saver should know. */
    const note = s(wd.note);
    if (!note) return [];
    return [{
      key: `${ref}|wallet_${action}`,
      tone: 'info',
      title: action === 'adopted'
        ? `Indent ${ref}: an earlier hand-entered wallet debit was taken over`
        : `Indent ${ref}: no wallet debit written`,
      lines: [note],
    }];
  }
  return [];
}

const TONE: Record<BillWalletTone, string> = {
  fail: 'bg-red-50 border-red-300 text-red-900',
  warn: 'bg-amber-50 border-amber-300 text-amber-900',
  info: 'bg-sky-50 border-sky-200 text-sky-900',
};

/** The notices, kept on screen until dismissed (or the panel closes). */
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
