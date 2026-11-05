/**
 * ROUTED REQUISITION LINES, as the three screens read them (ruling #45, #74).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A requisition line for an item a Direct Issue rule sends straight to another
 * department (Meat / Poultry / Seafood → Kitchen) is ROUTED: after the HOD (and,
 * where Settings require it, management) approves, it waits on THAT
 * department's "To send" list, not on the store desk, and the department's
 * one-step transfer fulfils it. The central store never holds those goods, so
 * it never issues them.
 *
 * THE SERVER DECIDES, THIS FILE ONLY READS. GET /api/requisitions?id= stamps
 * each line with
 *   routed_department_id   the raw column (ri.*) — '' / NULL = the store serves it
 *   routed                 null, or the server's RoutedLineState: the
 *                          department, the rule, approved / sent / owed in the
 *                          LINE unit and the PURCHASE unit, complete, the
 *                          transfers that sent it, and ONE sentence written for
 *                          the person reading it.
 * A line is routed when EITHER says so — the store-issue route refuses an issue
 * by the column alone, so a screen that saw the column but not the state must
 * not offer the button. When neither is present (an older payload, the column
 * not migrated) the line is the store's, exactly as before (contract I4).
 *
 * Every quantity a screen prints from here is the server's PURCHASE figure;
 * nothing is converted locally (owner rule, pack-units). Every sentence is the
 * server's, printed verbatim; the fallbacks below only ever say what the
 * payload proves.
 *
 * Pure functions: no React, no fetch.
 */

const str = (v: unknown): string => (v == null ? '' : String(v));
const fin = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** First finite number among the candidates, else null. */
const firstNum = (...vs: unknown[]): number | null => {
  for (const v of vs) { const n = fin(v); if (n != null) return n; }
  return null;
};
/** First non-blank string among the candidates, else ''. */
const firstStr = (...vs: unknown[]): string => {
  for (const v of vs) { const s = str(v).replace(/\s+/g, ' ').trim(); if (s) return s; }
  return '';
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** One department transfer that sent (part of) a routed line. */
export interface RoutedSendView {
  transferId: string;
  transferNo: string;
  at: string;
  by: string;
  /** PURCHASE units, the server's figures. */
  sentPU: number | null;
  /** What still stands after any send-back, PURCHASE units. */
  netPU: number | null;
  disputeStatus: string;
}

export interface RoutedLineView {
  deptId: string;
  /** The department that sends it — '' when the payload does not name it. */
  deptName: string;
  /** 'material' | 'category' | '' — which rule routed it. */
  via: string;
  /** The rule's own words ("Poultry", "CHICKEN BREAST BONELESS"). */
  ruleLabel: string;
  /** The department that asked (it receives the transfer). */
  receiverName: string;
  approvedLine: number | null; sentLine: number | null; owedLine: number | null;
  /** PURCHASE units — the figures a screen leads with. */
  approvedPU: number | null; sentPU: number | null; owedPU: number | null;
  purchaseUnit: string;
  /** The server's verdict by THE RULE, when it sent one. */
  complete: boolean | null;
  /** Chef- or store-rejected: nothing more is owed on it (server's flag). */
  closed: boolean | null;
  /** The server could not read the line's unit — its purchase figures are 0. */
  unitReview: boolean;
  sends: RoutedSendView[];
  /** The server's sentence, verbatim ('' when it sent none). */
  sentence: string;
}

/** Is this line routed to a department (and so never issued by the store)? */
export function isRoutedLine(line: unknown): boolean {
  const l = obj(line);
  if (!l) return false;
  if (obj(l.routed)) return true;
  return str(l.routed_department_id).trim() !== '';
}

/** The routed state of a line, or null when the store serves it. */
export function routedLineOf(line: unknown): RoutedLineView | null {
  const l = obj(line);
  if (!l || !isRoutedLine(l)) return null;
  const r = obj(l.routed) || {};
  const dept = obj(r.department) || obj(r.dept) || {};
  const receiver = obj(r.receiver) || obj(r.to_department) || {};
  const approved = obj(r.approved) || {};
  const sent = obj(r.sent) || {};
  const owed = obj(r.owed) || {};
  const rule = obj(r.rule) || {};
  const sendsRaw: unknown[] = Array.isArray(r.sends) ? r.sends : Array.isArray(r.transfers) ? r.transfers : [];
  const sends: RoutedSendView[] = sendsRaw.map((x) => {
    const s = obj(x) || {};
    return {
      transferId: firstStr(s.transfer_id, s.id),
      transferNo: firstStr(s.transfer_no, s.no),
      at: firstStr(s.at, s.created_at),
      by: firstStr(s.by, s.created_by),
      sentPU: firstNum(s.sent_purchase, s.qty_sent_purchase, s.quantity_purchase),
      netPU: firstNum(s.net_purchase, s.qty_net_purchase),
      disputeStatus: firstStr(s.dispute_status),
    };
  }).filter((s) => s.transferNo || s.transferId);
  const completeRaw = r.complete ?? r.is_complete;
  const closedRaw = r.closed;
  const yes = (v: unknown) => v === true || v === 1 || v === '1';
  return {
    deptId: firstStr(r.department_id, dept.id, r.routed_department_id, l.routed_department_id),
    deptName: firstStr(dept.name, r.department_name, r.dept_name, r.routed_department_name, l.routed_department_name),
    via: firstStr(r.via, r.routed_via, l.routed_via).toLowerCase(),
    ruleLabel: firstStr(r.rule_label, r.label, rule.label),
    receiverName: firstStr(r.receiver_name, r.to_department_name, receiver.name),
    approvedLine: firstNum(r.approved_line, approved.line),
    sentLine: firstNum(r.sent_line, sent.line),
    owedLine: firstNum(r.owed_line, owed.line),
    approvedPU: firstNum(r.approved_purchase, approved.purchase),
    sentPU: firstNum(r.sent_purchase, sent.purchase),
    owedPU: firstNum(r.owed_purchase, owed.purchase),
    purchaseUnit: firstStr(r.purchase_unit, approved.purchase_unit, owed.purchase_unit),
    complete: completeRaw == null ? null : yes(completeRaw),
    closed: closedRaw == null ? null : yes(closedRaw),
    unitReview: yes(r.unit_review),
    sends,
    sentence: firstStr(r.sentence, r.message, r.text),
  };
}

/** "Kitchen" — or, when the payload does not name the department, words that
 *  are still true. Never guessed from the rule (the rule names a destination
 *  the line may have been stamped against before a rule change). */
export function routedDeptWord(v: RoutedLineView | null, fallback = 'the routed department'): string {
  return v?.deptName || fallback;
}

/** "DTR-0042, DTR-0047" — the transfers that sent it, in the server's order. */
export function routedSendNos(v: RoutedLineView | null): string {
  if (!v) return '';
  return [...new Set(v.sends.map((s) => s.transferNo).filter(Boolean))].join(', ');
}

/** Distinct department names that send this requisition's routed lines. */
export function routedDeptNames(lines: unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const l of lines || []) {
    const v = routedLineOf(l);
    if (!v) continue;
    const n = v.deptName;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** "With Kitchen" / "With Kitchen, Bar" / "With other departments" — the tab
 *  and chip words, from the departments the payload names. */
export function withDeptLabel(names: string[]): string {
  if (names.length === 0) return 'With other departments';
  if (names.length <= 2) return `With ${names.join(', ')}`;
  return `With ${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}
