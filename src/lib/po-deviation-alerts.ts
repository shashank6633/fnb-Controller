import type Database from 'better-sqlite3';
import {
  type GrnDeviationAlert, type PoDeviationLine, type DeviationCounts,
} from './po-deviation-format';

/**
 * OFF-PO DEVIATION ALERTS — READING BACK WHAT THE RECEIVING DESK ALREADY WROTE.
 *
 * ══ THE DEFECT THIS CLOSES ════════════════════════════════════════════════
 * Detection works and DELIVERY DOES NOT. In the reported case a DRAGON FRUIT
 * line ordered 1 pcs @ ₹80 came in 9 pcs @ ₹100 and a THAI BIRD RED CHILLI line
 * ordered 1 @ ₹820 came in 0 — a 9× over-receipt and a total non-delivery on
 * one bill. api/purchase-orders/[id]/receive/route.ts saw BOTH: it built
 * `deviationLines`, classified them, logged an audit_event and wrote a
 * `notifications` row. Nothing on the GRN row, the GRN detail panel or the bell
 * ever told a human one existed — every one of them was written into a table no
 * screen reads.
 *
 * ══ WHAT THE 17 ROWS IN THIS DATABASE ACTUALLY ARE — MEASURED ═════════════
 * Do not cite them as evidence for the off-PO path. There are 17
 * po_received_deviation rows, all created 2026-08-07, all recipient='admin',
 * all sent_at NULL — and every one of them carries `lines: []` with
 * over/short/rate/acc_short counters of 0/0/0/0. They are BILL-DISCOUNT-ONLY
 * alerts (₹100 ×15, ₹60 ×2). There is no PO-2026-0028 in this database;
 * GRN-2026-0028 is a ₹100 discount on PO-2026-0022. So today this module
 * correctly renders "Bill charges · discount" 17 times, and the off-PO line
 * path — the reason it was written — has never been exercised by live data.
 * It is covered by fixtures only. Anyone changing the line path should build a
 * receipt that actually deviates rather than trusting these rows.
 *
 * THIS MODULE ONLY READS. Detection is not touched, re-derived or second-
 * guessed here: the receive route (deployed, and owned by another lane) stays
 * the single author of what counts as a deviation. If a figure on screen ever
 * disagrees with the alert, the alert is right and this file is wrong.
 *
 * ══ THE TWO ROWS BEHIND ONE ALERT, AND WHY BOTH ARE NEEDED ════════════════
 *   · notifications  — kind 'po_received_deviation' | 'po_received_excess'.
 *     THE EXISTENCE RECORD, and therefore the driver: a badge means "an alert
 *     fired for this receipt", so it must be keyed off the row the alert
 *     actually is. Carries the title/body a human can read, and — crucially —
 *     the GRN's id inside `party_unique_id`.
 *   · audit_events   — event_type 'po.received_deviation' | 'po.received_excess'.
 *     THE STRUCTURED DETAIL: after_json.lines is the `deviationLines` array
 *     verbatim (ordered / received / accepted / both rates / the four axis
 *     flags / value_impact / the reason typed at the bay). The notification's
 *     body has the same facts as prose; parsing prose back into numbers would
 *     be a second, weaker implementation of the receive route's own arithmetic,
 *     so it is never attempted. When the audit row cannot be matched the alert
 *     is still surfaced with `detail_available: false` and its verbatim text —
 *     "we know something is wrong here" beats silence, which is the exact
 *     failure being fixed.
 *
 * ══ THE JOIN KEY ══════════════════════════════════════════════════════════
 * `notifications.party_unique_id` is `po:<poId>:grn:<grnId>` from the receiving
 * desk, and `po:<poId>:grn:<grnId>:amend:<epoch>` from a post-receipt bill
 * correction (src/lib/grn-reversal.ts:raisePoDeviationAlert). Both carry the
 * GRN id after ':grn:' — parsed here, never guessed, and a row whose key does
 * not fit that shape is skipped rather than half-read.
 *
 * The audit row is matched on `after_json.grn_number` (the only GRN identifier
 * it carries — it has no grn_id), then split by whether the alert came from the
 * desk or from an amendment, then zipped in time order within each group. A
 * bill corrected twice therefore lines its two amendment alerts up with its two
 * amendment audit rows instead of both reading the first.
 *
 * ══ THE NET-VARIANCE TRAP ═════════════════════════════════════════════════
 * The owner's actual complaint: +₹820 over and −₹820 short cancel to a tidy net
 * and two serious failures disappear. This module NEVER computes a net without
 * also computing the gross pair (above_value / below_value) and the per-axis
 * counts, they travel together in one object, and every string built from them
 * goes through src/lib/po-deviation-format.ts, which will not print a net
 * except after both. See that file's header for the rule.
 *
 * ══ OUTLET + BLAST RADIUS ═════════════════════════════════════════════════
 * Scoped with the same lenient rule the GRN list uses — `(g.outlet_id = ? OR
 * g.outlet_id IS NULL)` — so a badge counts what its page shows. Both source
 * tables are created lazily by their writers, so their absence is a normal
 * state on a fresh database and returns an empty result rather than throwing.
 */

/** Rows come back keyed by GRN id; a receipt can carry several alerts (the
 *  original receipt plus one per later bill correction), newest first. */
export type DeviationAlertsByGrn = Record<string, GrnDeviationAlert[]>;

const DEVIATION_KINDS = ['po_received_deviation', 'po_received_excess'] as const;
const DEVIATION_EVENTS = ['po.received_deviation', 'po.received_excess'] as const;

const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => String(v ?? '');

/** Split a bind list so an `IN (...)` can never exceed SQLite's variable limit.
 *  NOT theoretical: the GRN register's date range is user-set, and a reader who
 *  drags it back a year hands this a few thousand receipt ids. SQLite's default
 *  SQLITE_MAX_VARIABLE_NUMBER would then throw, the route would 500, and every
 *  badge on the page would vanish silently — the failure mode this whole
 *  feature exists to remove, reintroduced by a bind list. 400 leaves room for
 *  the fixed params each query adds alongside the chunk. */
const CHUNK = 400;
function chunked<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

function tableExists(db: Database.Database, name: string): boolean {
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  } catch { return false; }
}

/**
 * Keep only the receipts that belong to `outletId`, by the SAME lenient rule
 * the GRN list and this file's own range query use: `outlet_id = ? OR
 * outlet_id IS NULL`. One implementation so the predicate cannot drift between
 * the three places that need it.
 *
 * Returns `null` — never a partial list — when the query itself fails, because
 * the two callers want opposite things from that and neither may guess:
 *   · a by-ID read returns DOCUMENTS and fails CLOSED (drops everything);
 *   · the bell's bucket returns a COUNT and fails OPEN (keeps the unscoped set
 *     rather than dropping the bucket) — deliberate, and documented at its
 *     call site.
 */
function scopeToOutlet(db: Database.Database, ids: string[], outletId: string): string[] | null {
  try {
    const keep: string[] = [];
    for (const part of chunked(ids)) {
      keep.push(...(db.prepare(`
        SELECT id FROM goods_receipt_notes
         WHERE id IN (${part.map(() => '?').join(',')})
           AND (outlet_id = ? OR outlet_id IS NULL)
      `).all(...part, outletId) as any[]).map(r => str(r.id)));
    }
    return keep;
  } catch { return null; }
}

/** The GRN id out of a `po:<poId>:grn:<grnId>[:amend:<epoch>]` key, or null.
 *  Never falls back to "the last segment": on an amendment key that segment is
 *  a timestamp, and a badge keyed on a timestamp would attach to no GRN at all
 *  while looking like it worked. */
function keyParts(key: string): { poId: string; grnId: string; isAmend: boolean } | null {
  const m = /^po:([^:]+):grn:([^:]+)(?::amend:(\d+))?$/.exec(String(key || ''));
  if (!m) return null;
  return { poId: m[1], grnId: m[2], isAmend: !!m[3] };
}

/** One deviating line off the audit payload, coerced. Unknown / missing fields
 *  become 0 or '' rather than NaN or undefined: this object is rendered
 *  directly, and a NaN in a rupee column is worse than a zero beside a reason. */
function readLine(raw: any): PoDeviationLine {
  return {
    material_name: str(raw?.material_name),
    material_id:   str(raw?.material_id),
    ordered:       num(raw?.ordered),
    received:      num(raw?.received),
    accepted:      num(raw?.accepted),
    unit_pu:       str(raw?.unit_pu),
    ordered_rate:  num(raw?.ordered_rate),
    actual_rate:   num(raw?.actual_rate),
    qty_short:     raw?.qty_short === true,
    acc_short:     raw?.acc_short === true,
    qty_excess:    raw?.qty_excess === true,
    rate_changed:  raw?.rate_changed === true,
    value_impact:  num(raw?.value_impact),
    reason:        str(raw?.reason),
  };
}

/**
 * Counts and money, computed from the LINES themselves.
 *
 * The audit payload also carries its own short_lines / over_lines /
 * acc_short_lines / rate_changed_lines counters, and they are deliberately not
 * used when `lines` is present: two counters for one fact drift, and the lines
 * are what the panel prints underneath, so the summary above them must be the
 * summary OF them. The acc_short test reproduces the receive route's own
 * (`l.acc_short && !l.qty_short`) so a vendor short is never also counted as a
 * short-accept. Stored counters are the fallback only when `lines` is empty.
 */
function summarise(lines: PoDeviationLine[], after: any): {
  counts: DeviationCounts; above: number; below: number; net: number;
} {
  if (!lines.length) {
    return {
      counts: {
        over: num(after?.over_lines), short: num(after?.short_lines),
        acc_short: num(after?.acc_short_lines), rate: num(after?.rate_changed_lines),
        lines: 0,
      },
      above: 0, below: 0, net: r2(num(after?.net_value_impact)),
    };
  }
  const counts: DeviationCounts = {
    over: lines.filter(l => l.qty_excess).length,
    short: lines.filter(l => l.qty_short).length,
    acc_short: lines.filter(l => l.acc_short && !l.qty_short).length,
    rate: lines.filter(l => l.rate_changed).length,
    lines: lines.length,
  };
  // GROSS, SPLIT BY THE DIRECTION THE MONEY MOVED — not by axis. A short
  // delivery at a doubled rate costs MORE, and a rate-change-only line has no
  // quantity axis at all, so bucketing rupees under "over"/"short" would file
  // a rate rise as a surplus that never arrived. See the format module.
  let above = 0, below = 0;
  for (const l of lines) {
    if (l.value_impact > 0) above += l.value_impact;
    else if (l.value_impact < 0) below += l.value_impact;
  }
  return { counts, above: r2(above), below: r2(below), net: r2(above + below) };
}

/**
 * Every off-PO alert already written for the given GRNs.
 *
 * @param grnIds  the receipts on screen. Empty → empty result, no queries.
 * @param opts.outletId  when given, ids outside the caller's outlet are dropped
 *   before anything is read. See scopeToOutlet() — a by-id read MUST be scoped
 *   when it is reachable from a request, because the id is caller-supplied.
 */
export function deviationAlertsForGrns(
  db: Database.Database,
  grnIds: string[],
  opts: { outletId?: string | null } = {},
): DeviationAlertsByGrn {
  const out: DeviationAlertsByGrn = {};
  let ids = [...new Set((grnIds || []).map(s => String(s || '').trim()).filter(Boolean))];
  if (!ids.length) return out;
  if (opts.outletId) {
    // FAIL CLOSED. This branch answers with the receipt's vendor, its material
    // names, ordered vs received quantities, both rates, the value impact and
    // the free-text reason typed at the bay — so on a scoping failure it
    // returns nothing rather than everything.
    const scoped = scopeToOutlet(db, ids, opts.outletId);
    if (!scoped || !scoped.length) return out;
    ids = scoped;
  }
  if (!tableExists(db, 'notifications')) return out;

  // ── 1. THE EXISTENCE RECORDS ────────────────────────────────────────────
  // Matched on the ':grn:<id>' fragment rather than a reconstructed key,
  // because the po id sits in front of it and is not known here. A LIKE with
  // the id spliced into the pattern is not an option (it would be unparameterised
  // SQL, and LIKE metacharacters in a uuid-shaped value change the match), so
  // the kinds are filtered in SQL and the key is parsed in JS — the table holds
  // ~17 of these rows, not 17,000.
  const wanted = new Set(ids);
  let notifs: any[] = [];
  try {
    notifs = db.prepare(`
      SELECT id, kind, party_unique_id, title, body, created_at
        FROM notifications
       WHERE kind IN (${DEVIATION_KINDS.map(() => '?').join(',')})
       ORDER BY created_at ASC, id ASC
    `).all(...DEVIATION_KINDS) as any[];
  } catch { return out; }

  interface Pending {
    grnId: string; poId: string; isAmend: boolean;
    kind: GrnDeviationAlert['kind'];
    title: string; body: string; created_at: string;
  }
  const pending: Pending[] = [];
  for (const n of notifs) {
    const p = keyParts(str(n.party_unique_id));
    if (!p || !wanted.has(p.grnId)) continue;
    pending.push({
      grnId: p.grnId, poId: p.poId, isAmend: p.isAmend,
      kind: str(n.kind) === 'po_received_excess' ? 'po_received_excess' : 'po_received_deviation',
      title: str(n.title), body: str(n.body), created_at: str(n.created_at),
    });
  }
  if (!pending.length) return out;

  // ── 2. THE GRN NUMBERS, WHICH ARE HOW THE AUDIT ROW NAMES ITSELF ────────
  const grnNumberById = new Map<string, string>();
  for (const part of chunked([...new Set(pending.map(p => p.grnId))])) {
    const grnRows = db.prepare(`
      SELECT id, grn_number FROM goods_receipt_notes
       WHERE id IN (${part.map(() => '?').join(',')})
    `).all(...part) as any[];
    for (const g of grnRows) grnNumberById.set(str(g.id), str(g.grn_number));
  }

  // ── 3. THE STRUCTURED DETAIL ────────────────────────────────────────────
  const numbers = [...new Set([...grnNumberById.values()].filter(Boolean))];
  interface AuditRow { grn_number: string; isAmend: boolean; after: any; created_at: string; actor: string; }
  const auditByGrn = new Map<string, AuditRow[]>();
  if (numbers.length && tableExists(db, 'audit_events')) {
    try {
      const rows: any[] = [];
      for (const part of chunked(numbers)) {
        rows.push(...(db.prepare(`
          SELECT after_json, created_at, actor_email, id
            FROM audit_events
           WHERE entity_type = 'purchase_order'
             AND event_type IN (${DEVIATION_EVENTS.map(() => '?').join(',')})
             AND json_extract(after_json, '$.grn_number') IN (${part.map(() => '?').join(',')})
        `).all(...DEVIATION_EVENTS, ...part) as any[]));
      }
      // Sorted HERE, not per chunk: the zip below pairs the nth alert with the
      // nth audit row in time order, and a list that is only sorted within each
      // chunk would pair a second amendment with the first one's lines.
      rows.sort((a, b) => (str(a.created_at) < str(b.created_at) ? -1
                        : str(a.created_at) > str(b.created_at) ? 1
                        : str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0));
      for (const r of rows) {
        let after: any = null;
        try { after = JSON.parse(str(r.after_json)); } catch { continue; }
        const gn = str(after?.grn_number);
        if (!gn) continue;
        const list = auditByGrn.get(gn) || [];
        list.push({
          grn_number: gn,
          isAmend: str(after?.source) === 'grn_line_amendment',
          after,
          created_at: str(r.created_at),
          actor: str(r.actor_email),
        });
        auditByGrn.set(gn, list);
      }
    } catch {
      // json_extract missing, or a malformed payload — the alerts still surface
      // with detail_available:false rather than the whole read failing.
    }
  }

  // ── 4. ZIP, PER GRN, PER SOURCE, IN TIME ORDER ──────────────────────────
  // Both lists are already ascending by created_at. A receipt raises exactly
  // one desk alert; amendments raise one each. Pairing within the group (rather
  // than "the first audit row for this GRN") is what stops a bill corrected
  // twice from showing its first correction's lines under both alerts.
  const cursor = new Map<string, number>();
  for (const p of pending) {
    const gn = grnNumberById.get(p.grnId) || '';
    const bucketKey = `${gn}|${p.isAmend ? 'a' : 'r'}`;
    const pool = (auditByGrn.get(gn) || []).filter(a => a.isAmend === p.isAmend);
    const at = cursor.get(bucketKey) || 0;
    const hit = pool[at];
    cursor.set(bucketKey, at + 1);

    const after = hit?.after ?? null;
    const lines = Array.isArray(after?.lines) ? (after.lines as any[]).map(readLine) : [];
    const s = summarise(lines, after);
    const discount = num(after?.bill_charges?.discount_applied);

    const alert: GrnDeviationAlert = {
      grn_id: p.grnId,
      grn_number: gn,
      po_id: p.poId,
      po_number: after?.po_number ? str(after.po_number) : null,
      vendor: str(after?.vendor?.vendor_name ?? ''),
      kind: p.kind,
      source: p.isAmend ? 'amendment' : 'receipt',
      title: p.title,
      body: p.body,
      created_at: p.created_at,
      counts: s.counts,
      above_value: s.above,
      below_value: s.below,
      gross_value: r2(s.above + Math.abs(s.below)),
      net_value: s.net,
      lines,
      detail_available: !!after,
      bill_discount: discount,
      amendment_reason: str(after?.amendment_reason ?? ''),
      actor_email: hit?.actor || '',
    };
    (out[p.grnId] ||= []).push(alert);
  }
  // Newest first inside each receipt — a bill corrected today leads with today.
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
  return out;
}

/**
 * The same alerts for every GRN received in a date range — what the /grn list
 * needs in ONE call beside its own list fetch, rather than a request per row.
 *
 * Scoped exactly like the list it decorates: `g.date` between from/to, and the
 * lenient outlet rule. Void receipts are INCLUDED deliberately — a bill that
 * was voided after arriving 9× over is still a thing that happened, and the row
 * is on screen (struck through) either way.
 */
export function deviationAlertsInRange(
  db: Database.Database,
  opts: { from: string; to: string; outletId?: string | null },
): DeviationAlertsByGrn {
  const where: string[] = ['g.date BETWEEN ? AND ?'];
  const params: unknown[] = [opts.from, opts.to];
  if (opts.outletId) { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(opts.outletId); }
  let ids: string[] = [];
  try {
    ids = (db.prepare(`
      SELECT g.id FROM goods_receipt_notes g WHERE ${where.join(' AND ')}
    `).all(...(params as any[])) as any[]).map(r => str(r.id));
  } catch { return {}; }
  return deviationAlertsForGrns(db, ids);
}

/**
 * THE BELL'S BUCKET. Every off-PO alert raised in the last `days`, for the
 * caller's outlet.
 *
 * Windowed rather than open-ended because this is a STANDING state with no
 * server-side "reviewed" flag — the bell acks per device (src/lib/notif-ack.ts)
 * and re-surfaces a bucket whose count RISES, so an unbounded history would
 * make the count only ever grow and the badge meaningless. Seven days matches
 * the closing-count digest window already in the inbox route.
 *
 * ONE ROW PER RECEIPT, NEVER ONE PER LINE: the badge SUMS `count` across items
 * (CaptainAlertsProvider), so a per-line count would bury every other bucket —
 * the same rule the cutover and closing-digest buckets state.
 *
 * The window is applied to the NOTIFICATION's created_at (when the admin was
 * told), not the GRN date, so a receipt back-dated to last month still appears
 * the day its alert fired.
 */
export function recentDeviationAlerts(
  db: Database.Database,
  opts: { outletId?: string | null; days?: number } = {},
): GrnDeviationAlert[] {
  const days = Number(opts.days) > 0 ? Number(opts.days) : 7;
  if (!tableExists(db, 'notifications')) return [];
  let keys: any[] = [];
  try {
    keys = db.prepare(`
      SELECT party_unique_id
        FROM notifications
       WHERE kind IN (${DEVIATION_KINDS.map(() => '?').join(',')})
         AND created_at >= datetime('now', ?)
    `).all(...DEVIATION_KINDS, `-${days} days`) as any[];
  } catch { return []; }
  const grnIds = [...new Set(keys.map(k => keyParts(str(k.party_unique_id))?.grnId).filter(Boolean) as string[])];
  if (!grnIds.length) return [];
  // Outlet-scope through the GRN, so an admin is never badged for a receipt
  // their /grn list will not show.
  let allowed = grnIds;
  if (opts.outletId) {
    const scoped = scopeToOutlet(db, grnIds, opts.outletId);
    // null == the scoping query itself failed. This bucket is a COUNT on an
    // admin-only bell, so it keeps the unscoped set rather than dropping the
    // bucket entirely — the opposite choice from the by-id read above, and the
    // reason scopeToOutlet reports failure instead of deciding for its callers.
    if (scoped) allowed = scoped;
  }
  if (!allowed.length) return [];
  const byGrn = deviationAlertsForGrns(db, allowed);
  const cut = Date.now() - days * 86400000;
  const flat: GrnDeviationAlert[] = [];
  for (const list of Object.values(byGrn)) {
    for (const a of list) {
      // Re-apply the window per ALERT: a GRN can carry an old receipt alert and
      // a fresh amendment alert, and only the fresh one belongs in the bucket.
      const t = Date.parse(a.created_at.includes('T') ? a.created_at : a.created_at.replace(' ', 'T') + 'Z');
      if (Number.isFinite(t) && t < cut) continue;
      flat.push(a);
    }
  }
  flat.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return flat;
}
