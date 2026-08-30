/**
 * OFF-PO DEVIATION — the shapes, and the ONE rule about how they are worded.
 *
 * THIS MODULE IMPORTS NOTHING, and must never grow an import. It is read by
 * BOTH a server lib (src/lib/po-deviation-alerts.ts, which reaches better-sqlite3)
 * and a 'use client' page (src/app/grn/page.tsx) — the same constraint
 * src/lib/line-dedupe.ts carries and for the same reason: an import here would
 * drag a native Node addon into the browser bundle. Types and pure string /
 * number functions only.
 *
 * ══ THE NET-VARIANCE TRAP, WHICH IS WHY THIS FILE EXISTS ══════════════════
 * THE REPORTED CASE (not a row in this database — see the evidence note in
 * src/lib/po-deviation-alerts.ts before citing it as one): a DRAGON FRUIT line
 * ordered 1 pcs @ ₹80 received 9 pcs @ ₹100 (+₹820), and a THAI BIRD RED CHILLI
 * line ordered 1 @ ₹820 received 0 (−₹820). Netted, that is a tidy ₹0 — and a
 * 9× over-receipt plus a total non-delivery vanish inside it. A netted figure is
 * the one number that can make two serious failures look like nothing happened.
 *
 * So the rule, enforced HERE rather than at each call site so it cannot drift
 * between the row badge, the detail panel and the bell:
 *
 *   1. NEVER emit a net without the gross movements that produced it.
 *   2. The AXIS COUNTS ("1 over, 1 short") come FIRST — they are the fact a
 *      cancelling pair cannot hide, because counts do not cancel.
 *   3. The GROSS money pair (above-PO / below-PO) comes second.
 *   4. The net comes LAST, in brackets, and only ever after 2 and 3.
 *
 * deviationHeadline() is the only sanctioned way to put a net on screen. If a
 * caller wants just the money, deviationMoneySummary() still leads with the
 * gross pair. There is no exported function that returns a bare net string.
 *
 * ══ WHY "ABOVE / BELOW PO" AND NOT "OVER / SHORT" FOR THE MONEY ═══════════
 * The axis flags and the rupees are different questions and must not share a
 * word. A line can be SHORT on quantity and still cost MORE (a short delivery
 * at a doubled rate), and a RATE-CHANGE-ONLY line has a money impact with no
 * quantity axis at all. Bucketing rupees by the sign of value_impact and
 * calling the positive bucket "over" would file that rate rise as an
 * over-receipt that never arrived. Counts are per AXIS; money is per
 * DIRECTION. Keeping the two vocabularies apart is deliberate.
 */

/** One PO line that came in differently from the approved order.
 *  Mirrors the `deviationLines` element built in
 *  api/purchase-orders/[id]/receive/route.ts (~:500) and the PoDeviationLine
 *  in src/lib/grn-reversal.ts — both write it into the audit row this reads
 *  back. Every quantity is a PURCHASE unit and every rate is ₹/purchase-unit;
 *  mixing in a recipe unit here would restate a ₹900 surplus as ₹900,000
 *  (see the rate-basis note at the receive route's push site). */
export interface PoDeviationLine {
  material_name: string;
  material_id: string;
  /** PO line qty — PURCHASE units. */
  ordered: number;
  /** What arrived — PURCHASE units. */
  received: number;
  /** What was taken into stock — PURCHASE units. 0 on a held (awaiting QC)
   *  receipt means "nobody has decided", never "all rejected". */
  accepted: number;
  /** PURCHASE unit label (never the recipe unit). */
  unit_pu: string;
  ordered_rate: number;
  actual_rate: number;
  qty_short: boolean;
  /** accepted < ordered while the full quantity DID arrive — part-rejected at
   *  QC. Distinct from a vendor short, and it still moves money. */
  acc_short: boolean;
  qty_excess: boolean;
  rate_changed: boolean;
  /** ₹ (accepted × actual rate) − (ordered × ordered rate). */
  value_impact: number;
  /** What the receiver was forced to type at the bay. '' on the amendment
   *  path, which carries one reason for the whole correction instead. */
  reason: string;
}

/** Per-AXIS counts. These are the numbers that cannot cancel, which is exactly
 *  why they lead every sentence this module builds. */
export interface DeviationCounts {
  /** Lines with qty_excess — more arrived than was ordered. */
  over: number;
  /** Lines with qty_short — less arrived than was ordered. */
  short: number;
  /** Arrived in full, part-rejected at QC (and NOT also a vendor short). */
  acc_short: number;
  /** Lines billed at a rate other than the ordered rate. */
  rate: number;
  /** Total deviating lines. NOT the sum of the four above — one line can
   *  deviate on several axes at once (the owner's DRAGON FRUIT is both OVER
   *  and a RATE change). */
  lines: number;
}

/** One alert as it already exists in the database: a `notifications` row of
 *  kind po_received_deviation / po_received_excess, joined to the audit_event
 *  written in the same breath that carries the structured lines. */
export interface GrnDeviationAlert {
  grn_id: string;
  grn_number: string;
  po_id: string;
  po_number: string | null;
  vendor: string;
  kind: 'po_received_deviation' | 'po_received_excess';
  /** 'receipt'  = raised at the receiving desk when the goods were booked.
   *  'amendment' = raised by a bill correction AFTER the receipt, which never
   *  went through the receiving desk's deviation gate (grn-reversal.ts). */
  source: 'receipt' | 'amendment';
  /** The notification's own title / body, verbatim. Kept so the screen can
   *  always show SOMETHING true even when the structured audit row behind it
   *  could not be found. */
  title: string;
  body: string;
  /** notifications.created_at — a SQLite `datetime('now')` UTC stamp. */
  created_at: string;
  counts: DeviationCounts;
  /** GROSS ₹ of the lines that cost MORE than the PO said. Always ≥ 0. */
  above_value: number;
  /** GROSS ₹ of the lines that cost LESS. Always ≤ 0 (kept signed so it can
   *  never be added to `above_value` by accident). */
  below_value: number;
  /** above_value + |below_value| — how much money MOVED, which is the figure
   *  the net destroys. */
  gross_value: number;
  /** The netted figure. Never render this without the two above. */
  net_value: number;
  lines: PoDeviationLine[];
  /** False when the structured audit row could not be matched — the alert is
   *  real (the notifications row exists) but only its title/body can be shown.
   *  The screen must say so rather than printing zeros as if nothing deviated. */
  detail_available: boolean;
  /** ₹ knocked off the whole bill. Moves the cost basis of every line and
   *  therefore average_price and every recipe — which is why it raises this
   *  alert on its own, with no line deviation at all. */
  bill_discount: number;
  /** The one reason recorded for a post-receipt bill correction. */
  amendment_reason: string;
  /** Who booked the receipt / typed the correction. */
  actor_email: string;
}

/** Half a paisa. Below this there is genuinely nothing to report; at or above
 *  it there IS a movement and no surface may say otherwise.
 *
 *  WHY THIS CONSTANT EXISTS. The money used to be compared AFTER Math.round,
 *  which broke twice at sub-rupee scale. `Math.round(-0.5)` is `-0` and `-0 < 0`
 *  is FALSE, so a −₹0.50 below-PO movement failed the "did anything go down?"
 *  test and was dropped, while the identical +₹0.50 rounded up to ₹1 and
 *  survived — the one function written to forbid presenting one direction alone
 *  presented one direction alone. And a real ₹0.50 rate deviation (100× the
 *  receive route's RATE_EPS of ₹0.005, i.e. a movement the detector deliberately
 *  raised) was then asserted as "no change to what the PO expected to spend".
 *  The arithmetic is PER LINE, so this is not a fifty-paise curiosity: ₹0.40 of
 *  GST-shaped rounding on 200 lines is ₹80 of real movement.
 *
 *  So: compare RAW values against this epsilon, never rounded ones. */
const MONEY_EPS = 0.005;

/** Is this a rupee movement worth stating at all? */
export function isMoneyMove(n: number): boolean {
  return Math.abs(Number(n) || 0) >= MONEY_EPS;
}

/** The magnitude, unsigned. Whole rupees — EXCEPT a real movement smaller than
 *  a rupee, which is printed in paise rather than rounded to the ₹0 that reads
 *  as "nothing happened". A figure this file prints as ₹0 must MEAN zero. */
function absMoney(n: number): string {
  const a = Math.abs(Number(n) || 0);
  if (a >= MONEY_EPS && a < 0.995) return a.toFixed(2);
  return Math.round(a).toLocaleString('en-IN');
}

/** ₹ with a sign always shown — the alert's own money() shape, so the screen
 *  and the notification title cannot print one figure two ways. */
export function signedMoney(n: number): string {
  const v = Number(n) || 0;
  // ZERO CARRIES NO SIGN. "+₹0" states a direction, and zero has none — it
  // reads as a rise that did not happen. This is not a corner: the ONE sentence
  // this module exists for, a +₹820 over against a −₹820 short, ends in exactly
  // that net, so the flagship case printed "(net +₹0)". The delivery lane's
  // money() (src/lib/po-deviation-alert.ts) already refuses to sign zero for
  // the same reason; two files in one feature must not take opposite positions
  // on one character. Below MONEY_EPS is a zero by this module's own
  // definition, so it is tested with the same predicate everything else uses.
  if (!isMoneyMove(v)) return `₹${absMoney(v)}`;
  return `${v < 0 ? '−' : '+'}₹${absMoney(v)}`;
}

/** ₹ without a sign, for a magnitude that is not a delta. */
export function plainMoney(n: number): string {
  return `₹${absMoney(n)}`;
}

/** "1 over, 1 short" — the axis counts, in a fixed order, non-zero only.
 *  THE ANTI-CANCELLATION SENTENCE: two lines that net to ₹0 still read as two
 *  separate failures here, because counts do not cancel.
 *  Returns '' only when nothing deviated on any axis (a bill-discount-only
 *  alert), and callers must then say what DID happen rather than nothing. */
export function deviationAxisSummary(c: DeviationCounts): string {
  const bits: string[] = [];
  if (c.over)      bits.push(`${c.over} over`);
  if (c.short)     bits.push(`${c.short} short`);
  if (c.acc_short) bits.push(`${c.acc_short} short-accepted`);
  if (c.rate)      bits.push(`${c.rate} rate change${c.rate === 1 ? '' : 's'}`);
  return bits.join(', ');
}

/** The GROSS money pair, then the net — never the net alone.
 *  "+₹820 above PO and −₹820 below PO (net ₹0)".
 *  With only one direction moved there is nothing to cancel, so the sentence
 *  collapses to that direction and the net is dropped as a redundant repeat
 *  ("+₹820 above PO"), which is the one case where a single figure cannot
 *  hide a second one. */
export function deviationMoneySummary(a: Pick<GrnDeviationAlert, 'above_value' | 'below_value' | 'net_value'>): string {
  // RAW values against MONEY_EPS — never Math.round'ed ones. Rounding first is
  // what dropped a −₹0.50 below-PO clause (Math.round(-0.5) === -0, and -0 < 0
  // is false) while keeping its +₹0.50 twin, and what let a real deviation be
  // announced as "no change". See the note on MONEY_EPS.
  const above = Number(a.above_value) || 0;
  const below = Number(a.below_value) || 0;
  const up = above >= MONEY_EPS;
  const down = below <= -MONEY_EPS;
  if (up && down) {
    return `${signedMoney(above)} above PO and ${signedMoney(below)} below PO (net ${signedMoney(a.net_value)})`;
  }
  if (up) return `${signedMoney(above)} above PO`;
  if (down) return `${signedMoney(below)} below PO`;
  return 'no change to what the PO expected to spend';
}

/** THE ONE SANCTIONED HEADLINE. Counts first, gross money second, net last and
 *  only in brackets. Used by the row badge tooltip, the detail panel and the
 *  bell label so all three say the same sentence in the same order. */
export function deviationHeadline(a: GrnDeviationAlert): string {
  const axes = deviationAxisSummary(a.counts);
  // DID A LINE MOVE? The `lines` array, or — on the stored-counter fallback
  // shape summarise() supports (po-deviation-alerts.ts:147) — any axis counter.
  // Testing `lines > 0` ALONE is the same mistake rollUpDeviationCounts guards
  // against below, and it broke this function two ways, both observed:
  //   · an UNREADABLE alert (detail_available false ⇒ counts are all 0) whose
  //     own title says "1 line(s) received off-PO" had this function call it
  //     "Received with bill charges" — the row tooltip contradicting the alert
  //     it describes, which is the exact "inventing a reassuring fact out of a
  //     missing one" deviationBadgeText refuses six lines below;
  //   · the fallback shape read "Off-PO · 1 over" on the badge and the bell and
  //     "Received with bill charges" here, for one and the same receipt.
  // So: bill charges are named only when there IS a bill charge, and an alert
  // we cannot read is not described at all.
  const head = a.counts.lines > 0
    ? `${a.counts.lines} line${a.counts.lines === 1 ? '' : 's'} off-PO${axes ? ` — ${axes}` : ''}`
    : axes ? `Received off-PO — ${axes}`
    : a.bill_discount > 0 ? 'Received with bill charges'
    : 'Alert raised';
  if (!a.detail_available) return `${head} (details unavailable — see the alert text)`;
  // MONEY STAYS GATED ON `lines`, not on the head above. above_value /
  // below_value are computed FROM the lines, so on the fallback shape they are
  // both 0 while a net may not be — and deviationMoneySummary() would then
  // assert "no change to what the PO expected to spend" over a real movement.
  // Rule 1 of this file forbids emitting the net without the gross pair that
  // produced it, so on that shape the money is left unsaid rather than misstated.
  const money = a.counts.lines > 0 ? ` · ${deviationMoneySummary(a)}` : '';
  const disc = a.bill_discount > 0
    ? ` · bill discount ${plainMoney(a.bill_discount)} netted into cost`
    : '';
  return `${head}${money}${disc}`;
}

/** Is this alert about LINES that came in differently, or only about what the
 *  BILL charged? Both raise the same alert (a discount moves the cost basis of
 *  every line, so it is the admin's call by the same argument as a rate change)
 *  — but they are not the same sentence, and calling a clean delivery with a
 *  ₹100 discount "received off-PO" would be a false statement about the goods.
 *  Every caption in this file branches on this rather than on `counts.lines`
 *  directly, so the two cases can never be worded as one by accident. */
export function isChargesOnly(a: Pick<GrnDeviationAlert, 'counts' | 'bill_discount'>): boolean {
  return a.counts.lines === 0 && a.bill_discount > 0;
}

/** The short caption on the LIST row — it has one line of space, so it carries
 *  the axis counts (which cannot cancel) and nothing else. The rupees are one
 *  hover or one expand away. */
export function deviationBadgeText(a: GrnDeviationAlert): string {
  const axes = deviationAxisSummary(a.counts);
  if (axes) return `Off-PO · ${axes}`;
  // NO STRUCTURED DETAIL: say exactly that. Falling through to a charges
  // caption here would put "bill charges" on a receipt whose alert says "1 over"
  // — inventing a reassuring fact out of a missing one, which is a worse
  // failure than the silence this whole feature replaces.
  if (!a.detail_available) return 'Alert raised · open for details';
  if (isChargesOnly(a)) return 'Bill charges · discount';
  // Same rule as deviationHeadline: with no lines, no axes and no discount
  // there is nothing that can truthfully be called a bill charge either.
  return a.counts.lines > 0 ? 'Off-PO' : 'Alert raised';
}

/** THE LIST-ROW CAPTION FOR A RECEIPT, which may carry SEVERAL alerts.
 *
 *  The row used to render `deviationBadgeText(alerts[0])` — the NEWEST alert
 *  alone. Two ways that lied about the receipt, both seen live:
 *    · a receipt 15 kg over at the desk, later given a ₹400 bill discount,
 *      read "Bill charges · discount" — the newest alert is the benign one, so
 *      the serious one was simply not on the row;
 *    · a receipt 3 lines over, later re-priced on one line, read "1 rate
 *      change" — two of the three over-lines were absent from the only caption
 *      a human reads without expanding.
 *  So the row rolls up like the panel does, and off-PO always leads. Axis
 *  counts only, never a rupee: a +₹820 over and a −₹820 short cancel, counts
 *  do not.
 *
 *  The roll-up counts a line once PER ALERT, so a line that deviated at the
 *  desk and was re-priced later can read as two. It over-reports rather than
 *  hides, it is the figure the expanded panel already prints, and the two
 *  agreeing matters more than either being minimal. */
export function deviationRowBadgeText(alerts: GrnDeviationAlert[]): string {
  if (alerts.length === 0) return '';
  if (alerts.length === 1) return deviationBadgeText(alerts[0]);
  const roll = rollUpDeviationCounts(alerts);
  const axes = deviationAxisSummary(roll);
  const parts: string[] = [];
  if (axes) parts.push(`Off-PO · ${axes}`);
  else if (roll.lines > 0) parts.push('Off-PO');
  // AN ALERT WE COULD NOT READ IS SAID OUT LOUD, and it is said BEFORE the bill
  // charges. On a receipt carrying one unreadable alert and one charges-only
  // correction this line used to be the whole caption's undoing: the row read
  // "bill charges" and nothing else, so an alert whose own title may say "1
  // line(s) received off-PO" was represented on the row by a ₹400 discount.
  if (alerts.some(a => !a.detail_available)) parts.push('details unavailable');
  if (alerts.some(a => a.bill_discount > 0)) parts.push('bill charges');
  if (parts.length > 0) return parts.join(' · ');
  // Reached only when every alert is readable and none of them carries a line,
  // an axis or a discount — so, as above, nothing here may be called a bill
  // charge on the strength of having found nothing else.
  return alerts.every(a => !a.detail_available)
    ? 'Alert raised · open for details'
    : 'Alert raised';
}

/** The row TOOLTIP for the same receipt. Counts roll up because they cannot
 *  cancel; MONEY DOES NOT — each alert keeps its own gross pair on its own
 *  clause, because adding two alerts' rupees together is the same cancellation
 *  trap inside one document that rollUpDeviationCounts refuses across them. */
export function deviationRowTooltip(alerts: GrnDeviationAlert[]): string {
  if (alerts.length === 0) return '';
  if (alerts.length === 1) return `${deviationHeadline(alerts[0])}.`;
  const roll = rollUpDeviationCounts(alerts);
  const axes = deviationAxisSummary(roll);
  const head = roll.lines > 0
    ? `${alerts.length} alerts on this bill — ${roll.lines} line${roll.lines === 1 ? '' : 's'} off-PO in total${axes ? `, ${axes}` : ''}`
    : `${alerts.length} alerts on this bill`;
  const each = alerts.map((a, i) => `${i + 1}) ${deviationHeadline(a)}`).join('. ');
  return `${head}. ${each}.`;
}

/** What ONE line did, in the receive route's own words ("OVER 8 pcs",
 *  "RATE ₹80 → ₹100 per pcs"), so the panel, the audit row and the Slack ping
 *  describe a line identically. */
export function deviationLineWhat(l: PoDeviationLine): string[] {
  const r6 = (v: number) => Math.round((Number(v) || 0) * 1000) / 1000;
  const what: string[] = [];
  if (l.qty_short)  what.push(`SHORT ${r6(l.ordered - l.received)} ${l.unit_pu}`);
  if (l.qty_excess) what.push(`OVER ${r6(l.received - l.ordered)} ${l.unit_pu}`);
  if (l.acc_short && !l.qty_short) {
    what.push(`SHORT-ACCEPTED ${r6(l.ordered - l.accepted)} ${l.unit_pu} (arrived, not accepted)`);
  }
  if (l.rate_changed) what.push(`RATE ₹${l.ordered_rate} → ₹${l.actual_rate} per ${l.unit_pu}`);
  return what;
}

/** A roll-up across several alerts. The three receipt buckets are DISJOINT and
 *  sum to `grns` by construction, so no arithmetic between them is ever needed
 *  at a call site — which is exactly how the bug below happened. */
export interface DeviationRollUp extends DeviationCounts {
  /** Distinct receipts carrying at least one alert of any kind. */
  grns: number;
  /** Distinct receipts where at least one LINE came in off the PO. */
  off_po: number;
  /** Distinct receipts whose alerts are ALL charges-only AND all readable — the
   *  goods arrived exactly as ordered and only the bill moved the cost. The
   *  "all readable" half is load-bearing: this bucket's caption states as a
   *  fact that nothing was wrong with the goods, so it may only claim a receipt
   *  every one of whose alerts could actually be read. */
  discount_only: number;
  /** Distinct receipts carrying at least one alert whose structure could not be
   *  read back (the audit row could not be matched), and which no off-PO alert
   *  already claimed. We do not know what these receipts did — which is a
   *  louder fact than a bill discount, not a quieter one. */
  unclassified: number;
}

/** Roll several alerts up for ONE sentence (the bell label, the page counter).
 *  Money is deliberately NOT rolled up: a cross-document rupee total is the
 *  same cancellation trap one level higher — two GRNs, one over and one short,
 *  would roll to ₹0 across the register. Counts only, and they are per AXIS.
 *
 *  ══ THE BUG THIS SHAPE EXISTS TO PREVENT ═════════════════════════════════
 *  This used to return `grns` (a count of RECEIPTS) beside `discount_only` (a
 *  count of ALERTS), and both callers then computed `off_po = grns −
 *  discount_only`. One receipt carrying TWO alerts — goods 15 kg over at the
 *  desk, plus a later charges-only bill correction — therefore netted its own
 *  two alerts against each other: 1 − 1 = 0 off-PO. The chip filed it under
 *  "bill charges", the bell said "1 bill with charges that moved cost", and the
 *  words "off-PO" and "1 over" appeared on no summary surface at all. That is
 *  the owner's net-variance complaint by a different mechanism — a benign fact
 *  cancelling a serious one — so the buckets are now counted per RECEIPT here,
 *  disjointly, and no caller subtracts anything. */
export function rollUpDeviationCounts(alerts: GrnDeviationAlert[]): DeviationRollUp {
  const t: DeviationRollUp = {
    over: 0, short: 0, acc_short: 0, rate: 0, lines: 0,
    grns: 0, off_po: 0, discount_only: 0, unclassified: 0,
  };
  /** Per receipt: did any alert move a LINE, did any alert come back UNREADABLE,
   *  and did any move only the BILL. The bucket is decided by the LOUDEST of the
   *  three, in that order — see the precedence note below the loop. */
  const byGrn = new Map<string, { off: boolean; unknown: boolean; disc: boolean }>();
  for (const a of alerts) {
    t.over += a.counts.over; t.short += a.counts.short;
    t.acc_short += a.counts.acc_short; t.rate += a.counts.rate;
    t.lines += a.counts.lines;
    if (!a.grn_id) continue;
    let e = byGrn.get(a.grn_id);
    if (!e) { e = { off: false, unknown: false, disc: false }; byGrn.set(a.grn_id, e); }
    // Any axis count means a line came in off the PO, even on the fallback path
    // where the audit payload carried the stored counters but no `lines` array
    // (see summarise() in po-deviation-alerts.ts). Testing `lines > 0` alone
    // would let a receipt read "1 over" in the axis summary while being counted
    // as something other than off-PO in the very same roll-up.
    if (a.counts.lines > 0 || a.counts.over > 0 || a.counts.short > 0
        || a.counts.acc_short > 0 || a.counts.rate > 0) e.off = true;
    if (!a.detail_available) e.unknown = true;
    if (a.bill_discount > 0) e.disc = true;
  }
  t.grns = byGrn.size;
  // PRECEDENCE, AND WHY UNKNOWN OUTRANKS A DISCOUNT. These buckets are printed
  // as statements of fact — `discount_only` is captioned "arrived exactly as
  // ordered but carried bill charges". A receipt whose audit row could not be
  // read has an alert saying something we cannot see, and its title may well be
  // "1 line(s) received off-PO (1 over)". Letting a later bill discount claim
  // that receipt would print "arrived exactly as ordered" over an unread
  // warning — the same shape as the bug this function was rewritten to fix (a
  // benign fact absorbing a serious one), just with "unknown" in place of
  // "over". So: off-PO wins, then unknown, and only a receipt that is wholly
  // readable and wholly benign reaches discount_only.
  for (const e of byGrn.values()) {
    if (e.off) t.off_po += 1;
    else if (e.unknown) t.unclassified += 1;
    else if (e.disc) t.discount_only += 1;
    else t.unclassified += 1;
  }
  return t;
}

/** A roll-up as two SEPARATE statements, never merged into one number.
 *  A receipt whose lines came in wrong and a clean receipt that carried a bill
 *  discount are both flagged, and both are the admin's call — but they are
 *  different facts, and one count covering both would say "24 deliveries came
 *  in off the purchase order" about seventeen deliveries that arrived exactly
 *  as ordered. Returns the parts in reading order; a caller joins them.  */
export function deviationChipParts(roll: DeviationRollUp): string[] {
  const axes = deviationAxisSummary(roll);
  const parts: string[] = [];
  // roll.off_po is counted per RECEIPT and never derived by subtraction — see
  // rollUpDeviationCounts. The `else if` is the belt-and-braces case of an
  // alert that carries axis counts but no grn_id: the axes must still be said.
  if (roll.off_po > 0) parts.push(`${roll.off_po} off-PO${axes ? ` · ${axes}` : ''}`);
  else if (axes) parts.push(`Off-PO · ${axes}`);
  if (roll.discount_only > 0) parts.push(`${roll.discount_only} bill charges`);
  if (roll.unclassified > 0) parts.push(`${roll.unclassified} flagged`);
  return parts;
}

/** The bell's one-line label. Counts, never a net — a bucket label has no room
 *  for the gross pair, so it carries only the figures that cannot cancel. */
export function deviationBucketLabel(roll: DeviationRollUp): string {
  const axes = deviationAxisSummary(roll);
  const bits: string[] = [];
  // Off-PO leads, always. A receipt that came in off the PO AND later carried a
  // bill correction is counted here, not under "bill charges" — the serious
  // fact must never be displaced by the benign one on the one line the bell has.
  if (roll.off_po > 0) bits.push(`${roll.off_po} ${roll.off_po === 1 ? 'delivery' : 'deliveries'} received off-PO${axes ? ` (${axes})` : ''}`);
  else if (axes) bits.push(`Deliveries received off-PO (${axes})`);
  if (roll.discount_only > 0) {
    bits.push(`${roll.discount_only} ${roll.discount_only === 1 ? 'bill' : 'bills'} with charges that moved cost`);
  }
  if (roll.unclassified > 0) {
    bits.push(`${roll.unclassified} ${roll.unclassified === 1 ? 'delivery' : 'deliveries'} flagged (details unavailable)`);
  }
  return bits.length ? bits.join(' · ') : `${roll.grns} ${roll.grns === 1 ? 'delivery' : 'deliveries'} to review`;
}
