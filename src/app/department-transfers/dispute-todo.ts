/**
 * "DISPUTES FOR YOU TO SETTLE" — the Department Transfers screen's to-do list.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE PAGE DECIDES NOTHING HERE EITHER. Each document carries
 * `permissions.dispute_to_act`, computed by the server with ONE predicate
 * (src/app/api/department-transfers/access.ts hasDisputeActionFor): this
 * person holds at least one control on an open dispute that the server will
 * ACCEPT — a take-back whose prefill moves something, or a close
 * canDismissDispute allows. The bell (notify.ts openDisputesToActFor) and GET
 * /api/department-transfers' open_disputes_to_act count the very same
 * predicate, so the badge, the API figure and this list cannot disagree.
 *
 * It replaced a client-side guess (round 2) that kept a count-blocked dispute
 * on the list "for whoever may be the one to count it" and hid the flagger's
 * own claim, while the bell counted every open dispute out of a department the
 * caller may send from: the Kitchen head saw a bell of 1 he could never clear
 * and a page with nothing to press.
 */

export interface SettleCandidate {
  dispute_status: string;
  permissions?: { dispute_to_act?: boolean } | null;
}

/** The documents to list under "Disputes for you to settle", in the order given. */
export function disputesToSettle<T extends SettleCandidate>(transfers: readonly T[]): T[] {
  return transfers.filter((t) => t.dispute_status === 'open' && t.permissions?.dispute_to_act === true);
}
