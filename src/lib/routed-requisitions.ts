import type Database from 'better-sqlite3';
import { logAuditEvent } from './db';
import { routedSchema } from './routed-schema';
import { resolveDirectIssueBulk, type DirectIssueTarget } from './direct-issue';
import { centralFlowBlock } from './store-engine';
import {
  applyIssueDelta, lineIssueComplete, lineFactor, stampShelfClose, markLedgerShelfClose,
  issueLedgerWatermark, isCentralStockShort, fmtLineQtyPU, type CentralStockShort,
} from './issue-stock';
import { deptSendableFor } from './dept-ledger';
import { holdsAny } from './central-debit-clamp';
import { packFactor, shownPurchaseQty } from './pack-units';
import { requisitionLinePoState, storeStageCheck } from './po-helpers';
import { applyPartyFulfillment } from './party-fulfillment';
import { fmtISTDate } from './format-date';

/* ══════════════════════════════════════════════════════════════════════════
 * ROUTED REQUISITION LINES — owner rulings #45 + #74 (2026-10-28).
 *
 * THE OWNER'S CASE (REQ-2026-1330): the Indian kitchen asked for 1 kg CHICKEN
 * BREAST BONELESS, the line went to the STORE, and the store's central book
 * read −2 kg — because a Direct Issue rule (src/lib/direct-issue.ts) sends
 * every chicken delivery straight to Kitchen. The central store never holds
 * chicken, so it can never truthfully issue it.
 *
 * THE RULE. A requisition line for a material a Direct Issue rule sends to
 * department D, raised by ANY OTHER department, is ROUTED to D at approval
 * (requisition_items.routed_department_id = D). It lands on D's "To send"
 * queue, not the store desk. D's head taps Send: a one-step department
 * transfer (dept-ledger.ts sendDeptTransfer) moves the goods from D's own
 * books to the asking department, and that transfer FULFILS the line — it is
 * what writes the line's quantity_issued (syncRoutedLine below). A line D
 * raises for itself (Kitchen asking for chicken) is NOT routed: it goes to the
 * store exactly as before. INTERNAL AND PARTY requisitions alike (#74); a
 * party line Kitchen sends is costed on that party's P&L from quantity_issued
 * exactly as a store-issued one (party-liquor.ts partyReqSplit, unchanged).
 *
 * INVARIANTS (contract v1 §0):
 *   I1 a routed line never moves CENTRAL stock on any rail — applyIssueDelta
 *      carves it out (skip_reason 'routed'), party-fulfillment.ts and
 *      po-requisition-fulfil.ts skip it;
 *   I2 a routed line's quantity_issued (LINE units) equals what its linked
 *      transfers still leave with the receiver — written ONLY here, through
 *      applyIssueDelta, never by a store desk;
 *   I3 completeness is THE RULE, unchanged (lineIssueComplete);
 *   I4 FAIL-TO-STORE: with the column absent nothing is routed and every path
 *      is exactly what it was (routed-schema.ts);
 *   I5 a requisition with no routed line is byte-identical.
 *
 * DEFAULTS, AS THE OWNER STATED THEM: HOD + management approval unchanged,
 * then the routed lines go to D's queue; D's own lines go to the store; party
 * requisitions too; partial sends allowed, the rest stays queued; D sends only
 * what its books hold (the transfer guard); at deploy, open lines with nothing
 * issued follow the new routing and lines the store already part-issued stay
 * with the store (backfillRoutedLines).
 * ══════════════════════════════════════════════════════════════════════════ */

type Db = Database.Database;

const EPS = 1e-9;
const r6 = (v: number) => Math.round((Number(v) || 0) * 1e6) / 1e6;
const SQL_CHUNK = 400;
const STORE_STAGES = new Set(['chef_approved', 'mgmt_approved', 'store_processed']);
export const ROUTED_BACKFILL_KEY = 'routed_requisitions_backfill_v1';
const BACKFILL_ACTOR = 'system:routed-backfill';

function chunked<T>(list: readonly T[], size = SQL_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');

function joinNames(names: string[]): string {
  const u = [...new Set(names.filter(Boolean))];
  if (u.length <= 1) return u[0] || '';
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

/* ── 1.3 THE DECISION ──────────────────────────────────────────────────── */

export interface RoutingDecision extends DirectIssueTarget {
  /** The line's own department (COALESCE(line, requisition)). */
  lineDepartmentId: string;
}

/**
 * Which of these lines are ROUTED, and to whom. A line is routed iff a Direct
 * Issue rule resolves for its material (a material rule beats a category
 * rule — resolveDirectIssueBulk) AND the rule's department is NOT the line's
 * own department. Fail-to-store, line by line:
 *   · no rule, or the rules table / marker column absent → store;
 *   · the line's own department IS the rule's department → store (Kitchen
 *     asking for chicken is served by the store, as today);
 *   · no line department, or the receiving department is switched off → store
 *     (a transfer can never be sent to it, so the line would sit unservable);
 *   · a store-mapped (liquor) material → store (the rules refuse them; this is
 *     the belt to that brace).
 * Pure read. Writes nothing.
 */
export function decideLineRouting(
  db: Db,
  lines: ReadonlyArray<{ id: string; material_id: string; department_id: string | null | undefined }>,
): Map<string, RoutingDecision> {
  const out = new Map<string, RoutingDecision>();
  if (lines.length === 0) return out;
  const targets = resolveDirectIssueBulk(db, lines.map((l) => l.material_id));
  if (targets.size === 0) return out;
  const deptActive = new Map<string, boolean>();
  const activeOf = (id: string): boolean => {
    if (deptActive.has(id)) return deptActive.get(id)!;
    let v = false;
    try {
      const row = db.prepare(`SELECT is_active FROM departments WHERE id = ?`).get(id) as { is_active?: number } | undefined;
      v = !!row && Number(row.is_active) === 1;
    } catch { v = false; }
    deptActive.set(id, v);
    return v;
  };
  for (const l of lines) {
    const t = targets.get(String(l.material_id || '').trim());
    if (!t) continue;
    const lineDept = String(l.department_id || '').trim();
    if (!lineDept) continue;
    if (t.departmentId === lineDept) continue;
    if (!activeOf(lineDept)) continue;
    let storeMapped = false;
    try { storeMapped = centralFlowBlock(db as any, String(l.material_id)) !== null; } catch { storeMapped = true; }
    if (storeMapped) continue;
    out.set(String(l.id), { ...t, lineDepartmentId: lineDept });
  }
  return out;
}

/* ── 1.4 THE STAMP ─────────────────────────────────────────────────────── */

export interface StampResult {
  stamped: Array<{ req_item_id: string; material_id: string; department_id: string; department_name: string; via: string; rule_id: string }>;
  /** Lines a rule routes that something was already issued against — they stay with the store. */
  skipped_issued: number;
  /** Lines a rule routes that sit on a live PO (or were delivered direct) — they stay with the store. */
  skipped_on_po: number;
}

/**
 * Stamp the routed lines of one requisition. MUST run inside the caller's
 * transaction (it opens none). NEVER UN-ROUTES a line and never re-routes one.
 *
 * Considers only lines the store has not started on: not routed yet, not
 * chef- or store-rejected, quantity_issued 0 and nothing net on the issue
 * ledger. A line on a live PO (merged or the per-requisition tick) or one some
 * of which a Direct Issue receipt already covered stays with the store, and so
 * does every line of a requisition that has its own live vendor PO (the tick's
 * PO completes the WHOLE requisition on arrival — po-requisition-fulfil.ts).
 *
 * `opts.clearDefer` (the deploy backfill): a stamped line's defer pair is
 * cleared — the store's promise to issue it later is no longer the store's to
 * keep — and the old value is kept in the audit row's before_json.
 */
export function stampRequisitionRouting(
  db: Db, reqId: string, actor: string, opts?: { clearDefer?: boolean },
): StampResult {
  const res: StampResult = { stamped: [], skipped_issued: 0, skipped_on_po: 0 };
  if (!routedSchema(db).lineCol) return res;
  const r = db.prepare(`
    SELECT r.id, r.req_number, r.department_id, r.outlet_id, r.linked_po_id, lpo.status AS linked_po_status
      FROM requisitions r LEFT JOIN purchase_orders lpo ON lpo.id = r.linked_po_id
     WHERE r.id = ?
  `).get(String(reqId)) as any;
  if (!r) return res;
  const rows = db.prepare(`
    SELECT ri.id, ri.material_id, COALESCE(ri.department_id, r.department_id) AS department_id,
           COALESCE(ri.quantity_issued, 0) AS quantity_issued,
           ri.deferred_until, COALESCE(ri.defer_reason, '') AS defer_reason
      FROM requisition_items ri
      JOIN requisitions r ON r.id = ri.req_id
     WHERE ri.req_id = ?
       AND ri.routed_department_id IS NULL
       AND COALESCE(ri.is_rejected, 0) = 0
       AND COALESCE(ri.store_rejected, 0) = 0
     ORDER BY ri.created_at, ri.rowid
  `).all(String(reqId)) as any[];
  if (rows.length === 0) return res;
  const decided = decideLineRouting(db, rows);
  if (decided.size === 0) return res;
  const candidates = rows.filter((x) => decided.has(String(x.id)));

  // The requisition's own vendor PO (the tick) serves it whole.
  const linkedLive = !!r.linked_po_id && String(r.linked_po_status || '') !== 'cancelled' && r.linked_po_status != null;
  if (linkedLive) { res.skipped_on_po += candidates.length; return res; }

  const ledgerNet = db.prepare(`
    SELECT COALESCE(SUM(recorded_recipe_qty), 0) AS rec, COALESCE(SUM(delta_recipe_qty), 0) AS del
      FROM requisition_issue_ledger WHERE req_item_id = ?
  `);
  let poState: ReturnType<typeof requisitionLinePoState> | null = null;
  try { poState = requisitionLinePoState(db, candidates.map((x) => String(x.id))); } catch { poState = null; }
  const upd = db.prepare(`
    UPDATE requisition_items
       SET routed_department_id = ?, routed_at = datetime('now'), routed_via = ?, routed_rule_id = ?
     WHERE id = ? AND routed_department_id IS NULL
  `);
  const clearDefer = db.prepare(`UPDATE requisition_items SET deferred_until = NULL, defer_reason = '' WHERE id = ?`);
  const matName = db.prepare(`SELECT name FROM raw_materials WHERE id = ?`);
  for (const x of candidates) {
    const d = decided.get(String(x.id))!;
    if (Math.abs(Number(x.quantity_issued) || 0) > EPS) { res.skipped_issued++; continue; }
    let net = { rec: 0, del: 0 };
    try { net = ledgerNet.get(String(x.id)) as { rec: number; del: number }; } catch { /* no ledger ⇒ nothing recorded */ }
    if (Math.abs(Number(net?.rec) || 0) > EPS || Math.abs(Number(net?.del) || 0) > EPS) { res.skipped_issued++; continue; }
    if (poState === null) { res.skipped_on_po++; continue; }   // cannot tell ⇒ the store keeps it
    const st = poState.get(String(x.id));
    if (st && (st.held_by || (Number(st.delivered_direct_qty_purchase) || 0) > EPS)) { res.skipped_on_po++; continue; }
    const w = upd.run(d.departmentId, d.via, d.ruleId, String(x.id));
    if (w.changes !== 1) continue;
    const hadDefer = !!(x.deferred_until || x.defer_reason);
    if (opts?.clearDefer && hadDefer) clearDefer.run(String(x.id));
    const name = String((matName.get(String(x.material_id)) as { name?: string } | undefined)?.name || x.material_id);
    logAuditEvent(db, {
      event_type: 'req_item.routed',
      entity_type: 'requisition_item',
      entity_id: String(x.id),
      actor_email: actor,
      outlet_id: r.outlet_id || null,
      before: { routed_department_id: null, ...(opts?.clearDefer && hadDefer ? { deferred_until: x.deferred_until, defer_reason: x.defer_reason } : {}) },
      after: {
        routed_department_id: d.departmentId, routed_via: d.via, routed_rule_id: d.ruleId,
        ...(opts?.clearDefer && hadDefer ? { deferred_until: null, defer_reason: '' } : {}),
      },
      note: `${r.req_number}: ${name} goes to ${d.departmentName}'s To send list — a Direct Issue rule (${d.via}) sends it `
        + `to ${d.departmentName}, so the central store never holds it`,
    });
    res.stamped.push({
      req_item_id: String(x.id), material_id: String(x.material_id), department_id: d.departmentId,
      department_name: d.departmentName, via: d.via, rule_id: d.ruleId,
    });
  }
  return res;
}

/* ── 1.5 THE DEPLOY STAMP ──────────────────────────────────────────────── */

export interface BackfillCensus {
  stamped: number;
  skipped_issued: number;
  skipped_on_po: number;
  requisitions: number;
  requisitions_routed: number;
  at: string;
}

/**
 * Once per database (settings marker 'routed_requisitions_backfill_v1'):
 * every requisition still with the store — chef_approved, mgmt_approved or
 * store_processed, internal AND party — has its lines stamped by the same
 * predicate as approval (stampRequisitionRouting): only lines with NOTHING
 * issued follow the new routing; a part-issued line stays with the store.
 * A stamped line's defer pair is cleared (kept in the audit row).
 *
 * Writes the marker with the census. Writes NOTHING (not even the marker)
 * when the columns are absent, so it runs on the boot that adds them. NEVER
 * THROWS: a failure is logged and every line stays with the store.
 */
export function backfillRoutedLines(db: Db): BackfillCensus | null {
  try {
    if (!routedSchema(db).lineCol) return null;
    const done = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(ROUTED_BACKFILL_KEY) as { value?: string } | undefined;
    if (done) return null;
    const census: BackfillCensus = {
      stamped: 0, skipped_issued: 0, skipped_on_po: 0, requisitions: 0, requisitions_routed: 0,
      at: new Date().toISOString(),
    };
    const run = db.transaction(() => {
      const reqs = db.prepare(`
        SELECT id FROM requisitions
         WHERE status IN ('chef_approved', 'mgmt_approved', 'store_processed')
         ORDER BY date, req_number
      `).all() as Array<{ id: string }>;
      for (const q of reqs) {
        census.requisitions++;
        const s = stampRequisitionRouting(db, q.id, BACKFILL_ACTOR, { clearDefer: true });
        census.stamped += s.stamped.length;
        census.skipped_issued += s.skipped_issued;
        census.skipped_on_po += s.skipped_on_po;
        if (s.stamped.length > 0) census.requisitions_routed++;
      }
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(ROUTED_BACKFILL_KEY, JSON.stringify(census));
    });
    run.immediate();
    if (census.stamped > 0 || census.skipped_issued > 0 || census.skipped_on_po > 0) {
      console.log(`[routed-requisitions] deploy stamp: ${census.stamped} line(s) routed across ${census.requisitions_routed} requisition(s); `
        + `${census.skipped_issued} part-issued and ${census.skipped_on_po} on a PO stay with the store.`);
    }
    return census;
  } catch (e) {
    console.error('[routed-requisitions] deploy stamp failed — every line stays with the store:', e);
    return null;
  }
}

/** When the deploy stamp ran (ISO), or null. */
export function routedDeployAt(db: Db): string | null {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(ROUTED_BACKFILL_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const v = JSON.parse(String(row.value));
    return typeof v?.at === 'string' ? v.at : null;
  } catch { return null; }
}

/* ── THE TRANSFER LINKS ────────────────────────────────────────────────── */

interface RootLink {
  line_id: string;
  transfer_id: string;
  transfer_no: string;
  req_item_id: string;
  from_department_id: string;
  to_department_id: string;
  qty_sent: number;
  req_line_qty: number | null;
  created_at: string;
  created_by: string;
  dispute_status: string;
}

/** The ROOT transfer lines that fulfil these requisition lines (posted, not
 *  reverse lines), oldest first. Empty when the link columns are absent. */
function rootLinks(db: Db, reqItemIds: readonly string[]): Map<string, RootLink[]> {
  const out = new Map<string, RootLink[]>();
  const ids = [...new Set(reqItemIds.map((x) => String(x || '').trim()).filter(Boolean))];
  if (ids.length === 0 || !routedSchema(db).linkCols) return out;
  for (const part of chunked(ids)) {
    const rows = db.prepare(`
      SELECT l.id AS line_id, l.transfer_id, t.transfer_no, l.req_item_id, t.from_department_id, t.to_department_id,
             l.qty_sent, l.req_line_qty, t.created_at, t.created_by, t.dispute_status
        FROM department_transfer_lines l
        JOIN department_transfers t ON t.id = l.transfer_id
       WHERE t.status = 'posted' AND l.reverses_line_id = '' AND l.req_item_id IN (${ph(part.length)})
       ORDER BY t.created_at, l.rowid
    `).all(...part) as RootLink[];
    for (const r of rows) {
      const arr = out.get(r.req_item_id) || [];
      arr.push(r);
      out.set(r.req_item_id, arr);
    }
  }
  return out;
}

/**
 * RECIPE units a transfer line still leaves with its receiver:
 *   net(L) = qty_sent(L) − Σ net(C) over the posted lines C with reverses_line_id = L.
 * Recursive, so a send-back that is itself sent back (a re-reverse) counts
 * the goods as delivered again. Bounded to [0, qty_sent].
 */
function lineNet(db: Db, lineId: string, qtySent: number, depth = 0): number {
  if (depth > 20) return Math.max(0, r6(qtySent));
  const kids = db.prepare(`
    SELECT l.id, l.qty_sent FROM department_transfer_lines l
      JOIN department_transfers t ON t.id = l.transfer_id
     WHERE t.status = 'posted' AND l.reverses_line_id = ?
  `).all(String(lineId)) as Array<{ id: string; qty_sent: number }>;
  let back = 0;
  for (const k of kids) back += lineNet(db, k.id, Number(k.qty_sent) || 0, depth + 1);
  return Math.min(Math.max(0, r6(qtySent - back)), Math.max(0, r6(qtySent)));
}

/** Open disputed RECIPE units per transfer line (not yet reversed). */
function openDisputed(db: Db, lineIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const ids = [...new Set(lineIds)].filter(Boolean);
  if (ids.length === 0) return out;
  try {
    for (const part of chunked(ids)) {
      const rows = db.prepare(`
        SELECT line_id, COALESCE(SUM(MAX(0, qty_disputed - qty_reversed)), 0) AS q
          FROM department_transfer_disputes
         WHERE status = 'open' AND line_id IN (${ph(part.length)})
         GROUP BY line_id
      `).all(...part) as Array<{ line_id: string; q: number }>;
      for (const r of rows) out.set(String(r.line_id), r6(Number(r.q) || 0));
    }
  } catch { /* no disputes table ⇒ none open */ }
  return out;
}

export interface RoutedSend {
  transfer_id: string;
  transfer_no: string;
  transfer_line_id: string;
  at: string;
  by: string;
  /** PURCHASE units this transfer line moved (the shown figure). */
  sent_purchase: number;
  /** PURCHASE units it still leaves with the receiver (after any send-back). */
  net_purchase: number;
  sent_recipe: number;
  net_recipe: number;
  /** LINE units this send added to the requisition line, and what it still counts for. */
  sent_line: number;
  net_line: number;
  dispute_status: string;
  /** PURCHASE units the receiver has an OPEN dispute on (not yet sent back). */
  open_disputed_purchase: number;
}

interface LineMeta {
  line_unit: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
}

/** Per routed line: every root send, with its net. */
function sendsFor(db: Db, lines: ReadonlyArray<{ id: string } & LineMeta>): Map<string, RoutedSend[]> {
  const out = new Map<string, RoutedSend[]>();
  const links = rootLinks(db, lines.map((l) => l.id));
  const disputes = openDisputed(db, [...links.values()].flat().map((l) => l.line_id));
  for (const l of lines) {
    const meta = { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_size };
    const { factor } = lineFactor(l.line_unit, meta);
    const f = factor || 1;
    const arr: RoutedSend[] = [];
    for (const k of links.get(l.id) || []) {
      const sent = Number(k.qty_sent) || 0;
      const net = lineNet(db, k.line_id, sent);
      const lineQty = k.req_line_qty != null && Number.isFinite(Number(k.req_line_qty)) ? Number(k.req_line_qty) : sent / f;
      const netLine = sent > EPS ? r6(lineQty * net / sent) : 0;
      arr.push({
        transfer_id: k.transfer_id, transfer_no: k.transfer_no, transfer_line_id: k.line_id,
        at: k.created_at, by: k.created_by,
        sent_purchase: shownPurchaseQty(sent, meta), net_purchase: shownPurchaseQty(net, meta),
        sent_recipe: r6(sent), net_recipe: net,
        sent_line: r6(lineQty), net_line: netLine,
        dispute_status: String(k.dispute_status || ''),
        open_disputed_purchase: shownPurchaseQty(Math.min(disputes.get(k.line_id) || 0, net), meta),
      });
    }
    out.set(l.id, arr);
  }
  return out;
}

/** quantity_issued a routed line must hold: Σ over its root sends of net_line. */
function targetFromSends(sends: readonly RoutedSend[]): number {
  return r6(sends.reduce((s, x) => s + x.net_line, 0));
}

/* ── THE PER-LINE STATE (readers, desks, sentences) ────────────────────── */

export interface RoutedLineState {
  req_item_id: string;
  requisition_id: string;
  req_number: string;
  material_id: string;
  material_name: string;
  /** The department that SENDS the line (the Direct Issue rule's department). */
  department: { id: string; name: string; is_active: boolean };
  /** The department that asked (the line's own department). */
  receiver: { id: string; name: string; is_active: boolean };
  via: string;
  rule_id: string;
  /** "Meat" (category rule) or the material's name (material rule). */
  rule_label: string;
  /** The rule still exists and still sends this to `department`. */
  rule_current: boolean;
  routed_at: string | null;
  line_unit: string;
  recipe_unit: string;
  purchase_unit: string;
  pack_factor: number;
  approved_line: number;
  sent_line: number;
  owed_line: number;
  approved_purchase: number;
  sent_purchase: number;
  owed_purchase: number;
  owed_recipe: number;
  /** THE RULE (lineIssueComplete) on the line as it stands. */
  complete: boolean;
  /** Chef- or store-rejected: nothing more is owed on it. */
  closed: boolean;
  /** The line's unit cannot be read (blank/unknown on a packed material). */
  unit_review: boolean;
  sends: RoutedSend[];
  /** The server's one sentence for this line, printed verbatim by every screen. */
  sentence: string;
}

interface StateRow extends LineMeta {
  id: string; req_id: string; req_number: string; material_id: string; material_name: string;
  quantity_requested: number | null; chef_approved_qty: number | null; quantity_issued: number | null;
  shelf_emptied_qty: number | null; is_rejected: number; store_rejected: number;
  routed_department_id: string; routed_via: string; routed_rule_id: string; routed_at: string | null;
  line_department_id: string | null;
  sender_name: string | null; sender_active: number | null;
  receiver_name: string | null; receiver_active: number | null;
}

function ruleLabels(db: Db, ruleIds: readonly string[]): Map<string, { label: string; department_id: string }> {
  const out = new Map<string, { label: string; department_id: string }>();
  const ids = [...new Set(ruleIds)].filter(Boolean);
  if (ids.length === 0) return out;
  try {
    for (const part of chunked(ids)) {
      const rows = db.prepare(`
        SELECT r.id, r.rule_type, r.category_key, r.category_label, r.department_id, rm.name AS material_name
          FROM direct_issue_rules r LEFT JOIN raw_materials rm ON rm.id = r.material_id
         WHERE r.id IN (${ph(part.length)})
      `).all(...part) as any[];
      for (const r of rows) {
        const label = String(r.rule_type) === 'material'
          ? String(r.material_name || 'this item')
          : String(r.category_label || r.category_key || 'this category');
        out.set(String(r.id), { label, department_id: String(r.department_id) });
      }
    }
  } catch { /* rules table unreadable ⇒ no labels (the sentence says "was routed") */ }
  return out;
}

/**
 * The routed state of these requisition lines; lines that are not routed are
 * absent. One batch of reads, never one per line.
 */
export function routedLineState(db: Db, reqItemIds: readonly string[]): Map<string, RoutedLineState> {
  const out = new Map<string, RoutedLineState>();
  if (!routedSchema(db).lineCol) return out;
  const ids = [...new Set(reqItemIds.map((x) => String(x || '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const rows: StateRow[] = [];
  for (const part of chunked(ids)) {
    rows.push(...(db.prepare(`
      SELECT ri.id, ri.req_id, r.req_number, ri.material_id, rm.name AS material_name,
             ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
             COALESCE(ri.is_rejected, 0) AS is_rejected, COALESCE(ri.store_rejected, 0) AS store_rejected,
             ri.routed_department_id, COALESCE(ri.routed_via, '') AS routed_via,
             COALESCE(ri.routed_rule_id, '') AS routed_rule_id, ri.routed_at,
             COALESCE(ri.department_id, r.department_id) AS line_department_id,
             ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size,
             sd.name AS sender_name, sd.is_active AS sender_active,
             rd.name AS receiver_name, rd.is_active AS receiver_active
        FROM requisition_items ri
        JOIN requisitions r ON r.id = ri.req_id
        JOIN raw_materials rm ON rm.id = ri.material_id
        LEFT JOIN departments sd ON sd.id = ri.routed_department_id
        LEFT JOIN departments rd ON rd.id = COALESCE(ri.department_id, r.department_id)
       WHERE ri.id IN (${ph(part.length)}) AND COALESCE(ri.routed_department_id, '') <> ''
    `).all(...part) as StateRow[]));
  }
  if (rows.length === 0) return out;
  const sends = sendsFor(db, rows);
  const labels = ruleLabels(db, rows.map((x) => x.routed_rule_id));
  for (const x of rows) {
    const meta = { unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_size };
    const { factor, needsReview } = lineFactor(x.line_unit, meta);
    const f = factor || 1;
    const approved = (x.chef_approved_qty != null ? Number(x.chef_approved_qty) : Number(x.quantity_requested)) || 0;
    const sent = Number(x.quantity_issued) || 0;
    const closed = Number(x.is_rejected) === 1 || Number(x.store_rejected) === 1;
    const complete = lineIssueComplete({
      quantity_issued: x.quantity_issued, chef_approved_qty: x.chef_approved_qty, quantity_requested: x.quantity_requested,
      line_unit: x.line_unit, unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_size,
      shelf_emptied_qty: x.shelf_emptied_qty,
    });
    const owedLine = complete || closed ? 0 : r6(Math.max(0, approved - sent));
    const lab = labels.get(x.routed_rule_id);
    const senderName = String(x.sender_name || 'the department');
    const ruleCurrent = !!lab && lab.department_id === String(x.routed_department_id);
    const lineSends = sends.get(x.id) || [];
    const st: RoutedLineState = {
      req_item_id: x.id, requisition_id: x.req_id, req_number: String(x.req_number || ''),
      material_id: x.material_id, material_name: String(x.material_name || ''),
      department: { id: String(x.routed_department_id), name: senderName, is_active: Number(x.sender_active) === 1 },
      receiver: { id: String(x.line_department_id || ''), name: String(x.receiver_name || ''), is_active: Number(x.receiver_active) === 1 },
      via: x.routed_via, rule_id: x.routed_rule_id,
      rule_label: lab?.label || String(x.material_name || ''),
      rule_current: ruleCurrent,
      routed_at: x.routed_at || null,
      line_unit: String(x.line_unit ?? ''), recipe_unit: String(x.unit || ''),
      purchase_unit: String(x.purchase_unit || x.unit || ''), pack_factor: packFactor(meta),
      approved_line: r6(approved), sent_line: r6(sent), owed_line: owedLine,
      approved_purchase: needsReview ? 0 : shownPurchaseQty(approved * f, meta),
      sent_purchase: needsReview ? 0 : shownPurchaseQty(sent * f, meta),
      owed_purchase: needsReview ? 0 : shownPurchaseQty(owedLine * f, meta),
      owed_recipe: needsReview ? 0 : r6(owedLine * f),
      complete, closed, unit_review: needsReview,
      sends: lineSends,
      sentence: '',
    };
    st.sentence = routedSentence(st, x);
    out.set(x.id, st);
  }
  return out;
}

/** THE desk sentence (contract §2), built from the line's own figures. */
function routedSentence(st: RoutedLineState, x: LineMeta): string {
  const D = st.department.name;
  const fig = (n: number) => fmtLineQtyPU(n, x.line_unit, x);
  const why = st.rule_current
    ? `Direct Issue routes ${st.rule_label} to ${D}, so the central store never holds it.`
    : `A Direct Issue rule routed ${st.material_name} to ${D} when this requisition was approved, so the line is ${D}'s to send.`;
  const live = st.sends.filter((s) => s.net_line > EPS);
  const nos = [...new Set(live.map((s) => s.transfer_no))].join(', ');
  let progress: string;
  if (st.sent_line <= EPS) {
    progress = st.closed ? `Nothing was sent; the line is closed.` : `Nothing sent yet; ${fig(st.owed_line)} still to send.`;
  } else if (st.complete) {
    progress = `Sent ${fig(st.sent_line)} of ${fig(st.approved_line)}${nos ? ` (${nos})` : ''} — complete.`;
  } else if (st.closed) {
    progress = `Sent ${fig(st.sent_line)} of ${fig(st.approved_line)}${nos ? ` (${nos})` : ''}; the rest is closed.`;
  } else {
    progress = `Sent ${fig(st.sent_line)} of ${fig(st.approved_line)}${nos ? ` (${nos})` : ''}; ${fig(st.owed_line)} still to send.`;
  }
  return `${D} sends this — ${why} ${progress}`;
}

/** Per requisition: how many ROUTED lines are still owed (THE RULE). */
export function routedOwingCounts(db: Db, reqIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!routedSchema(db).lineCol) return out;
  const ids = [...new Set(reqIds.map((x) => String(x || '').trim()).filter(Boolean))];
  for (const part of chunked(ids)) {
    const rows = db.prepare(`
      SELECT ri.req_id, ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
             ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
        FROM requisition_items ri LEFT JOIN raw_materials rm ON rm.id = ri.material_id
       WHERE ri.req_id IN (${ph(part.length)}) AND COALESCE(ri.routed_department_id, '') <> ''
         AND COALESCE(ri.is_rejected, 0) = 0 AND COALESCE(ri.store_rejected, 0) = 0
    `).all(...part) as any[];
    for (const r of rows) {
      if (lineIssueComplete(r)) continue;
      out.set(String(r.req_id), (out.get(String(r.req_id)) || 0) + 1);
    }
  }
  return out;
}

/**
 * Routed lines that the sending department HAS sent goods on (net of any
 * send-back) — the destructive edits (cancel, chef reject, the requisition
 * PUT) refuse on them, because the goods are in the receiving department's
 * books against this line. `message` is the refusal sentence, true as read.
 */
export function routedSendsOn(
  db: Db, sel: { reqId?: string; reqItemId?: string },
): { lines: Array<{ req_item_id: string; material_name: string; department_name: string; receiver_name: string; sent_text: string; transfer_nos: string[] }>; message: string } {
  const empty = { lines: [], message: '' };
  if (!routedSchema(db).lineCol) return empty;
  let ids: string[] = [];
  try {
    ids = sel.reqItemId
      ? [String(sel.reqItemId)]
      : (db.prepare(`SELECT id FROM requisition_items WHERE req_id = ? AND COALESCE(routed_department_id, '') <> ''`)
          .all(String(sel.reqId || '')) as Array<{ id: string }>).map((x) => x.id);
  } catch { return empty; }
  if (ids.length === 0) return empty;
  const lines: Array<{ req_item_id: string; material_name: string; department_name: string; receiver_name: string; sent_text: string; transfer_nos: string[] }> = [];
  const meta = new Map<string, LineMeta>();
  try {
    for (const part of chunked(ids)) {
      for (const m of db.prepare(`
        SELECT ri.id, ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
          FROM requisition_items ri LEFT JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.id IN (${ph(part.length)})
      `).all(...part) as any[]) meta.set(String(m.id), m);
    }
  } catch { /* fall through with no meta */ }
  for (const [id, st] of routedLineState(db, ids)) {
    const net = st.sends.reduce((s, x) => s + x.net_line, 0);
    if (!(net > EPS) && !(st.sent_line > EPS)) continue;
    const m = meta.get(id) || { line_unit: null, unit: null, purchase_unit: null, pack_size: null };
    lines.push({
      req_item_id: id, material_name: st.material_name, department_name: st.department.name,
      receiver_name: st.receiver.name, sent_text: fmtLineQtyPU(st.sent_line, m.line_unit, m),
      transfer_nos: [...new Set(st.sends.filter((s) => s.net_line > EPS).map((s) => s.transfer_no))],
    });
  }
  if (lines.length === 0) return empty;
  const message = lines.map((l) =>
    `${l.department_name} sent ${l.sent_text} of ${l.material_name}${l.transfer_nos.length ? ` on ${l.transfer_nos.join(', ')}` : ''}; `
    + `${l.receiver_name || 'the receiving department'} sends it back first (Department Transfers → the transfer → Send back).`,
  ).join(' ');
  return { lines, message };
}

/* ── 3.2 THE WRITER ────────────────────────────────────────────────────── */

export interface RoutedSyncResult {
  req_item_id: string;
  requisition_id: string;
  req_number: string;
  material_id: string;
  material_name: string;
  before_line: number;
  after_line: number;
  delta_line: number;
  sent_purchase_before: number;
  sent_purchase_after: number;
  owed_line: number;
  owed_purchase: number;
  complete: boolean;
  /** A complete line this sync made owed again (a send-back). */
  reopened: boolean;
}

/**
 * Bring ONE routed line's quantity_issued to what its linked transfers still
 * leave with the receiver. ABSOLUTE and IDEMPOTENT — a send, a send-back and a
 * re-reverse all go through it, and calling it twice changes nothing the
 * second time. MUST run inside the caller's transaction.
 *
 *   target = Σ over the line's ROOT links of req_line_qty × net / qty_sent
 *
 * Writes quantity_issued ONLY — no issue_history, issued_at or issued_by:
 * the sending department's Send is not a store hand-over. The issue ledger row
 * goes through applyIssueDelta (reason 'routed_send' / 'routed_send_back',
 * skip_reason 'routed', central untouched — issue-stock.ts), keyed by the
 * transfer line that triggered it ('dtl:<id>'), so the issue log has its row.
 * THE RULE's shelf arm: a send that left the SENDER holding none of the
 * material (and a remainder below one printed step) closes the line by that
 * arm, exactly as a central take that emptied the shelf does.
 */
export function syncRoutedLine(
  db: Db, reqItemId: string, actor: string, token: string, opts?: { senderDepartmentId?: string },
): RoutedSyncResult | null {
  const sch = routedSchema(db);
  if (!sch.lineCol || !sch.linkCols) return null;
  const x = db.prepare(`
    SELECT ri.id, ri.req_id, r.req_number, ri.material_id, rm.name AS material_name,
           ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
           ri.deferred_until, COALESCE(ri.defer_reason, '') AS defer_reason,
           COALESCE(ri.routed_department_id, '') AS routed_department_id,
           ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      JOIN requisitions r ON r.id = ri.req_id
      JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.id = ?
  `).get(String(reqItemId)) as any;
  if (!x || !x.routed_department_id) return null;
  const meta = { unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_size };
  const { factor, needsReview } = lineFactor(x.line_unit, meta);
  const f = factor || 1;
  const sends = sendsFor(db, [x]).get(String(x.id)) || [];
  const target = targetFromSends(sends);
  const before = Number(x.quantity_issued) || 0;
  const delta = r6(target - before);
  const wasComplete = lineIssueComplete(x);
  const approved = (x.chef_approved_qty != null ? Number(x.chef_approved_qty) : Number(x.quantity_requested)) || 0;
  const pu = (lineQty: number) => (needsReview ? 0 : shownPurchaseQty(lineQty * f, meta));

  if (Math.abs(delta) > EPS) {
    db.prepare(`UPDATE requisition_items SET quantity_issued = ? WHERE id = ?`).run(target, String(x.id));
    const res = applyIssueDelta(db, {
      reqItemId: String(x.id), beforeLineQty: before, afterLineQty: target,
      reason: delta > 0 ? 'routed_send' : 'routed_send_back',
      actor: String(actor || '').trim() || 'system:routed-send',
      clientToken: token,
    });
    const sender = String(opts?.senderDepartmentId || x.routed_department_id);
    let senderEmptied = false;
    if (delta > 0) {
      try { senderEmptied = !holdsAny(Math.max(0, Number(deptSendableFor(db, sender, String(x.material_id)).available) || 0)); }
      catch { senderEmptied = false; }
    }
    const stamp = stampShelfClose(db, String(x.id), senderEmptied);
    if (stamp.byShelf && res.ledgerId) markLedgerShelfClose(db, String(x.id), target, res.ledgerId);
    logAuditEvent(db, {
      event_type: delta > 0 ? 'req_item.routed_send' : 'req_item.routed_send_back',
      entity_type: 'requisition_item',
      entity_id: String(x.id),
      actor_email: actor,
      before: { quantity_issued: before },
      after: { quantity_issued: target, transfer_line: token },
      note: `${x.req_number}: ${x.material_name} — ${delta > 0 ? 'sent' : 'sent back'} `
        + `${fmtLineQtyPU(Math.abs(delta), x.line_unit, meta)} by department transfer; the line now holds `
        + `${fmtLineQtyPU(target, x.line_unit, meta)} of ${fmtLineQtyPU(approved, x.line_unit, meta)}`,
    });
  }
  const now = db.prepare(`
    SELECT ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
           ri.deferred_until, COALESCE(ri.defer_reason, '') AS defer_reason,
           ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri JOIN raw_materials rm ON rm.id = ri.material_id WHERE ri.id = ?
  `).get(String(x.id)) as any;
  const complete = lineIssueComplete(now);
  // A COMPLETE LINE KEEPS NO PROMISE: the store desk's defer rule, here.
  if (complete && (now.deferred_until || now.defer_reason)) {
    db.prepare(`UPDATE requisition_items SET deferred_until = NULL, defer_reason = '' WHERE id = ?`).run(String(x.id));
  }
  const after = Number(now.quantity_issued) || 0;
  const owed = complete ? 0 : r6(Math.max(0, approved - after));
  return {
    req_item_id: String(x.id), requisition_id: String(x.req_id), req_number: String(x.req_number || ''),
    material_id: String(x.material_id), material_name: String(x.material_name || ''),
    before_line: r6(before), after_line: r6(after), delta_line: r6(after - before),
    sent_purchase_before: pu(before), sent_purchase_after: pu(after),
    owed_line: owed, owed_purchase: pu(owed), complete, reopened: wasComplete && !complete,
  };
}

/* ── 3.5 THE REQUISITION ───────────────────────────────────────────────── */

export interface PartyStorePartPending {
  message: string;
  short: Array<{ req_item_id: string; material: string; message: string }>;
}

export interface RoutedAdvanceResult {
  requisition_id: string;
  req_number: string;
  status_before: string;
  status: string;
  fulfilled: boolean;
  party_store_part_pending: PartyStorePartPending | null;
}

/**
 * Move the requisition the way store-issue's auto-advance would, after a
 * routed send or send-back. THE SAME predicate: a line is done when chef- or
 * store-rejected, or complete by THE RULE and not deferred.
 *
 *   every line done, status at a store stage →
 *     party: the party transfer is tried in a savepoint first — it moves the
 *            STORE's lines only (it skips routed lines) and is a no-op when the
 *            store's issue already moved them. A line it leaves open, or a
 *            central-stock refusal, unwinds it and the requisition stays
 *            store_processed (party_store_part_pending says why);
 *     then:  'fulfilled' (fulfilled_at / fulfilled_by by COALESCE; the store's
 *            own store_processed_* stamps are NOT touched — no store gesture ran).
 *   not every line done →
 *     'fulfilled' (a send-back re-opened it) → back to 'store_processed', fulfilled_* cleared;
 *     'chef_approved' / 'mgmt_approved' with a routed send → 'store_processed'
 *            (no store stamps), so a part-served party is costed like a store
 *            partial and the requisition stays on the store's list for its own lines.
 * MUST run inside the caller's transaction.
 */
export function advanceRoutedRequisition(db: Db, reqId: string, actor: string): RoutedAdvanceResult | null {
  const r = db.prepare(`
    SELECT id, req_number, status, COALESCE(NULLIF(TRIM(purpose), ''), 'internal') AS purpose,
           fulfilled_at, fulfilled_by, outlet_id
      FROM requisitions WHERE id = ?
  `).get(String(reqId)) as any;
  if (!r) return null;
  const selLines = db.prepare(`
    SELECT ri.id, ri.is_rejected, ri.store_rejected, ri.quantity_requested, ri.chef_approved_qty,
           ri.quantity_issued, ri.deferred_until, ri.shelf_emptied_qty,
           ${routedSchema(db).lineCol ? `COALESCE(ri.routed_department_id, '')` : `''`} AS routed_department_id,
           ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size, rm.name AS material_name
      FROM requisition_items ri LEFT JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.req_id = ?
  `);
  const done = (it: any) => !!it.is_rejected || !!it.store_rejected || (lineIssueComplete(it) && !it.deferred_until);
  const everyDone = () => (selLines.all(r.id) as any[]).every(done);
  const statusBefore = String(r.status);
  const out: RoutedAdvanceResult = {
    requisition_id: String(r.id), req_number: String(r.req_number || ''), status_before: statusBefore,
    status: statusBefore, fulfilled: statusBefore === 'fulfilled', party_store_part_pending: null,
  };
  const stampOf = (q: any) => ({ status: q?.status ?? null, fulfilled_at: q?.fulfilled_at ?? null, fulfilled_by: q?.fulfilled_by ?? null });
  let allDone = everyDone();

  if (allDone && STORE_STAGES.has(statusBefore)) {
    if (r.purpose === 'party') {
      const unwind = new Error('routed_party_transfer_left_lines_open');
      try {
        db.transaction(() => {
          applyPartyFulfillment(db, r.id, actor, { gestureIssuedIds: new Set<string>(), ledgerSince: issueLedgerWatermark(db) });
          if (!everyDone()) throw unwind;
        })();
      } catch (e) {
        if (e !== unwind && !isCentralStockShort(e)) throw e;
        allDone = false;
        const shorts: CentralStockShort[] = isCentralStockShort(e)
          ? [e as CentralStockShort, ...(((e as CentralStockShort).others) || [])] : [];
        out.party_store_part_pending = {
          message: shorts.length > 0
            ? `Every line of ${r.req_number} is now handed over, but the party transfer could not move the store's own lines from the central store, so the requisition stays open: ${shorts.map((s) => s.message).join(' ')}`
            : `Every line of ${r.req_number} is now handed over, but the party transfer left a store line open, so the requisition stays open for the store to finish.`,
          short: shorts.map((s) => ({ req_item_id: String(s.reqItemId), material: String(s.materialName || ''), message: s.message })),
        };
      }
    }
    if (allDone) {
      const w = db.prepare(`
        UPDATE requisitions
           SET status = 'fulfilled',
               fulfilled_at = COALESCE(fulfilled_at, datetime('now')),
               fulfilled_by = COALESCE(NULLIF(fulfilled_by, ''), ?),
               updated_at = datetime('now')
         WHERE id = ? AND status = ?
      `).run(actor, r.id, statusBefore);
      if (w.changes === 1) {
        const now = db.prepare(`SELECT status, fulfilled_at, fulfilled_by FROM requisitions WHERE id = ?`).get(r.id);
        logAuditEvent(db, {
          event_type: 'requisition.routed_fulfil', entity_type: 'requisition', entity_id: String(r.id),
          actor_email: actor, outlet_id: r.outlet_id || null, before: stampOf(r), after: stampOf(now),
          note: `${r.req_number}: fulfilled — every line is done; the last open line was sent by department transfer`,
        });
        out.status = 'fulfilled';
        out.fulfilled = true;
      }
      return out;
    }
  }

  if (!allDone) {
    if (statusBefore === 'fulfilled') {
      const w = db.prepare(`
        UPDATE requisitions
           SET status = 'store_processed', fulfilled_at = NULL, fulfilled_by = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'fulfilled'
      `).run(r.id);
      if (w.changes === 1) {
        logAuditEvent(db, {
          event_type: 'requisition.routed_reopen', entity_type: 'requisition', entity_id: String(r.id),
          actor_email: actor, outlet_id: r.outlet_id || null, before: stampOf(r),
          after: { status: 'store_processed', fulfilled_at: null, fulfilled_by: null },
          note: `${r.req_number}: re-opened — goods sent by department transfer were sent back, so a line is owed again`,
        });
        out.status = 'store_processed';
        out.fulfilled = false;
      }
    } else if (statusBefore === 'chef_approved' || statusBefore === 'mgmt_approved') {
      const anySent = (selLines.all(r.id) as any[]).some((it) => !!it.routed_department_id && (Number(it.quantity_issued) || 0) > EPS);
      if (anySent) {
        const w = db.prepare(`
          UPDATE requisitions SET status = 'store_processed', updated_at = datetime('now')
           WHERE id = ? AND status = ?
        `).run(r.id, statusBefore);
        if (w.changes === 1) {
          logAuditEvent(db, {
            event_type: 'requisition.routed_progress', entity_type: 'requisition', entity_id: String(r.id),
            actor_email: actor, outlet_id: r.outlet_id || null, before: { status: statusBefore },
            after: { status: 'store_processed' },
            note: `${r.req_number}: part handed over by department transfer; the rest is still owed`,
          });
          out.status = 'store_processed';
        }
      }
    }
  }
  return out;
}

/* ── 3.4 THE TWO ENTRY POINTS THE TRANSFER ROUTES CALL ─────────────────── */

export interface RoutedApplyResult {
  lines: RoutedSyncResult[];
  requisitions: RoutedAdvanceResult[];
  party_store_part_pending: PartyStorePartPending | null;
}

function advanceAll(db: Db, reqIds: Iterable<string>, actor: string, lines: RoutedSyncResult[]): RoutedApplyResult {
  const requisitions: RoutedAdvanceResult[] = [];
  let pending: PartyStorePartPending | null = null;
  for (const id of new Set(reqIds)) {
    const a = advanceRoutedRequisition(db, id, actor);
    if (!a) continue;
    requisitions.push(a);
    if (a.party_store_part_pending && !pending) pending = a.party_store_part_pending;
  }
  return { lines, requisitions, party_store_part_pending: pending };
}

/**
 * After a SEND (inside the POST's IMMEDIATE transaction, after
 * sendDeptTransfer): sync every linked line of the transfer, then advance
 * each requisition it touched. Reads the links from the database, so the
 * caller may pass the transfer document or just its id. A transfer with no
 * linked line is a no-op (the generic Send tray).
 */
export function applyRoutedSend(db: Db, transfer: { id: string; from_department_id?: string }, actor: string): RoutedApplyResult {
  const empty: RoutedApplyResult = { lines: [], requisitions: [], party_store_part_pending: null };
  const sch = routedSchema(db);
  if (!sch.lineCol || !sch.linkCols || !transfer?.id) return empty;
  const t = db.prepare(`SELECT id, from_department_id, status FROM department_transfers WHERE id = ?`).get(String(transfer.id)) as any;
  if (!t || String(t.status) !== 'posted') return empty;
  const links = db.prepare(`
    SELECT id, req_item_id FROM department_transfer_lines
     WHERE transfer_id = ? AND req_item_id <> '' AND reverses_line_id = ''
     ORDER BY created_at, rowid
  `).all(String(t.id)) as Array<{ id: string; req_item_id: string }>;
  if (links.length === 0) return empty;
  const lines: RoutedSyncResult[] = [];
  const reqIds: string[] = [];
  for (const l of links) {
    const s = syncRoutedLine(db, l.req_item_id, actor, `dtl:${l.id}`, { senderDepartmentId: String(t.from_department_id || '') });
    if (!s) continue;
    lines.push(s);
    reqIds.push(s.requisition_id);
  }
  return advanceAll(db, reqIds, actor, lines);
}

/**
 * After a SEND-BACK (a reverse transfer, or a reverse of a reverse): walk each
 * reverse line up reverses_line_id to the root line that fulfils a requisition
 * line, re-sync that line, then advance. A reverse of an ordinary transfer
 * (no root link) is a no-op. A dispute FLAG or a dismissal moves nothing and
 * never reaches here; a reverse — disputed (paper correction) or standing
 * (goods returned) — lowers what the line was fulfilled with, so it is owed
 * again and returns to the sending department's queue.
 */
export function applyRoutedSendBack(db: Db, reverseDoc: { id: string }, actor: string): RoutedApplyResult {
  const empty: RoutedApplyResult = { lines: [], requisitions: [], party_store_part_pending: null };
  const sch = routedSchema(db);
  if (!sch.lineCol || !sch.linkCols || !reverseDoc?.id) return empty;
  const revLines = db.prepare(`
    SELECT id, reverses_line_id FROM department_transfer_lines WHERE transfer_id = ? AND reverses_line_id <> ''
     ORDER BY created_at, rowid
  `).all(String(reverseDoc.id)) as Array<{ id: string; reverses_line_id: string }>;
  if (revLines.length === 0) return empty;
  const up = db.prepare(`SELECT id, req_item_id, reverses_line_id FROM department_transfer_lines WHERE id = ?`);
  const lines: RoutedSyncResult[] = [];
  const reqIds: string[] = [];
  const synced = new Set<string>();
  for (const rl of revLines) {
    let cur = up.get(String(rl.reverses_line_id)) as { id: string; req_item_id: string; reverses_line_id: string } | undefined;
    let hops = 0;
    while (cur && !String(cur.req_item_id || '') && String(cur.reverses_line_id || '') && hops < 20) {
      cur = up.get(String(cur.reverses_line_id)) as typeof cur;
      hops++;
    }
    const reqItemId = String(cur?.req_item_id || '');
    if (!reqItemId || synced.has(reqItemId)) continue;
    synced.add(reqItemId);
    const s = syncRoutedLine(db, reqItemId, actor, `dtl:${rl.id}`);
    if (!s) continue;
    lines.push(s);
    reqIds.push(s.requisition_id);
  }
  return advanceAll(db, reqIds, actor, lines);
}

/* ── 4. THE "TO SEND" QUEUE ────────────────────────────────────────────── */

export interface ToSendLine {
  req_item_id: string;
  material_id: string;
  material_name: string;
  material_category: string;
  line_unit: string;
  purchase_unit: string;
  recipe_unit: string;
  pack_factor: number;
  approved_line: number;
  sent_line: number;
  owed_line: number;
  approved_purchase: number;
  sent_purchase: number;
  owed_purchase: number;
  owed_recipe: number;
  /** What the SENDING department's books hold of it (dept-ledger deptSendableFor). */
  sendable_recipe: number;
  sendable_purchase: number;
  /** The department was never counted for it: "up to", never "holds". */
  sendable_upper_bound: boolean;
  sendable_basis: string;
  /** min(owed, sendable) — the most one Send may move now. */
  max_send_purchase: number;
  max_send_recipe: number;
  can_send: boolean;
  blocked: null | { code: 'nothing_held' | 'receiver_inactive' | 'unit_review'; message: string };
  sends: RoutedSend[];
  /** The line's quantity_issued now — echoed back on the POST as expect_sent_line. */
  expect_sent_line: number;
  sentence: string;
}

export interface ToSendGroup {
  key: string;
  requisition_id: string;
  req_number: string;
  req_date: string;
  req_status: string;
  purpose: 'internal' | 'party';
  event_name: string;
  event_date: string | null;
  fp_id: string | null;
  party_unique_id: string | null;
  to_department_id: string;
  to_department_name: string;
  to_department_active: boolean;
  lines: ToSendLine[];
}

export interface ToSendQueue {
  department: { id: string; name: string; is_active: boolean } | null;
  rules: Array<{ rule_id: string; via: 'material' | 'category'; label: string }>;
  explain: string[];
  groups: ToSendGroup[];
  totals: { groups: number; lines: number; party_groups: number };
}

/** The owed routed lines for department D (THE RULE), store-stage requisitions only. */
function owedRoutedRows(db: Db, deptIds: readonly string[], outletId: string | null): any[] {
  if (!routedSchema(db).lineCol || deptIds.length === 0) return [];
  const atStore = storeStageCheck(db);
  const params: unknown[] = [...deptIds];
  let outlet = '';
  if (outletId) { outlet = ' AND (r.outlet_id = ? OR r.outlet_id IS NULL)'; params.push(outletId); }
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT ri.id AS req_item_id, ri.req_id, ri.material_id, ri.routed_department_id,
             ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
             ri.unit AS line_unit, rm.name AS material_name, COALESCE(rm.category, '') AS material_category,
             rm.unit, rm.purchase_unit, rm.pack_size,
             r.req_number, r.date AS req_date, r.status AS req_status,
             COALESCE(NULLIF(TRIM(r.purpose), ''), 'internal') AS purpose,
             COALESCE(r.event_name, '') AS event_name, r.event_date,
             COALESCE(ri.department_id, r.department_id) AS to_department_id,
             d.name AS to_department_name, d.is_active AS to_department_active
        FROM requisition_items ri
        JOIN requisitions r ON r.id = ri.req_id
        JOIN raw_materials rm ON rm.id = ri.material_id
        LEFT JOIN departments d ON d.id = COALESCE(ri.department_id, r.department_id)
       WHERE ri.routed_department_id IN (${ph(deptIds.length)})
         AND COALESCE(ri.is_rejected, 0) = 0 AND COALESCE(ri.store_rejected, 0) = 0
         AND r.status IN ('chef_approved', 'mgmt_approved', 'store_processed')${outlet}
       ORDER BY r.date, r.req_number, ri.created_at, ri.rowid
    `).all(...params) as any[];
  } catch { return []; }
  return rows.filter((x) => atStore(String(x.req_status), String(x.purpose)) && !lineIssueComplete(x));
}

/** Count of (requisition, receiving department) groups owed by these departments — the bell. */
export function toSendGroupCount(db: Db, deptIds: readonly string[], outletId: string | null): number {
  const ids = [...new Set(deptIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const keys = new Set<string>();
  for (const x of owedRoutedRows(db, ids, outletId)) keys.add(`${x.routed_department_id}|${x.req_id}:${x.to_department_id}`);
  return keys.size;
}

/** Party requisition → its F&P ids, when the columns exist (read-only). */
function partyIdsOf(db: Db, reqIds: readonly string[]): Map<string, { fp_id: string | null; party_unique_id: string | null }> {
  const out = new Map<string, { fp_id: string | null; party_unique_id: string | null }>();
  if (reqIds.length === 0) return out;
  let cols = new Set<string>();
  try { cols = new Set((db.prepare(`PRAGMA table_info(requisitions)`).all() as Array<{ name: string }>).map((c) => c.name)); } catch { /* none */ }
  const fp = cols.has('fp_id') ? 'fp_id' : 'NULL';
  const pu = cols.has('party_unique_id') ? 'party_unique_id' : 'NULL';
  for (const part of chunked([...new Set(reqIds)])) {
    try {
      for (const r of db.prepare(`SELECT id, ${fp} AS fp_id, ${pu} AS party_unique_id FROM requisitions WHERE id IN (${ph(part.length)})`)
        .all(...part) as any[]) {
        out.set(String(r.id), { fp_id: r.fp_id ? String(r.fp_id) : null, party_unique_id: r.party_unique_id ? String(r.party_unique_id) : null });
      }
    } catch { /* leave empty */ }
  }
  return out;
}

/** The department's own Direct Issue rules, labelled. */
function deptRules(db: Db, deptId: string): Array<{ rule_id: string; via: 'material' | 'category'; label: string }> {
  try {
    return (db.prepare(`
      SELECT r.id, r.rule_type, r.category_key, r.category_label, rm.name AS material_name
        FROM direct_issue_rules r LEFT JOIN raw_materials rm ON rm.id = r.material_id
       WHERE r.department_id = ?
       ORDER BY r.rule_type, COALESCE(NULLIF(r.category_label, ''), r.category_key, rm.name)
    `).all(deptId) as any[]).map((r) => ({
      rule_id: String(r.id),
      via: String(r.rule_type) === 'material' ? 'material' as const : 'category' as const,
      label: String(r.rule_type) === 'material' ? String(r.material_name || 'an item') : String(r.category_label || r.category_key || 'a category'),
    }));
  } catch { return []; }
}

/** The six server sentences the To send tab prints verbatim (contract §6). */
export function toSendExplain(db: Db, deptName: string, rules: ReadonlyArray<{ label: string }>): string[] {
  const D = deptName || 'This department';
  const labels = joinNames(rules.map((r) => r.label));
  const out = [
    labels
      ? `Direct Issue sends ${labels} deliveries straight to ${D}, so the central store never holds them. After the HOD approves a requisition (and management, where Settings require it for party requisitions), any other department's line for them comes here, not to the store.`
      // No rule sends anything to D any more: say what is true of the lines
      // still here (they were routed when their requisitions were approved).
      : `No Direct Issue rule sends deliveries to ${D} now. The lines below were routed to ${D} when their requisitions were approved, so they are still ${D}'s to send.`,
    `Send hands it over from ${D}'s own stock at once and fulfils that line. ${D} can send only what its books hold; send part now and the rest stays here.`,
    `Party requisitions work the same way. What ${D} sends is costed on that party's P&L, on the F&P it was raised from, exactly as a store issue.`,
    `${D}'s own requisitions for these items still go to the store.`,
    `If the receiving department reports a problem and goods are sent back, the line is owed again and returns here.`,
  ];
  const at = routedDeployAt(db);
  if (at) out.push(`Lines the store had already started issuing before ${fmtISTDate(at)} stay with the store.`);
  return out;
}

/**
 * Department D's "To send" queue: every owed routed line (THE RULE) of a
 * requisition at a store stage (the store inbox's own rule, storeStageCheck),
 * grouped by requisition and receiving department, oldest first. Figures lead
 * with PURCHASE units; the sendable figure is the transfer guard's own
 * (deptSendableFor), so the screen cannot offer what Send refuses. Access is
 * the ROUTE's business (who may see / send from D) — this reads only.
 */
export function toSendQueue(db: Db, deptId: string, outletId: string | null): ToSendQueue {
  const id = String(deptId || '').trim();
  let dept: { id: string; name: string; is_active: boolean } | null = null;
  try {
    const d = db.prepare(`SELECT id, name, is_active FROM departments WHERE id = ?`).get(id) as any;
    if (d) dept = { id: String(d.id), name: String(d.name || ''), is_active: Number(d.is_active) === 1 };
  } catch { dept = null; }
  const rules = dept ? deptRules(db, id) : [];
  const explain = dept ? toSendExplain(db, dept.name, rules) : [];
  const rows = dept ? owedRoutedRows(db, [id], outletId) : [];
  const states = routedLineState(db, rows.map((x) => String(x.req_item_id)));
  const party = partyIdsOf(db, rows.filter((x) => x.purpose === 'party').map((x) => String(x.req_id)));
  const sendableCache = new Map<string, ReturnType<typeof deptSendableFor> | null>();
  const sendableOf = (matId: string) => {
    if (!sendableCache.has(matId)) {
      let v: ReturnType<typeof deptSendableFor> | null = null;
      try { v = deptSendableFor(db, id, matId); } catch { v = null; }
      sendableCache.set(matId, v);
    }
    return sendableCache.get(matId)!;
  };
  const groups = new Map<string, ToSendGroup>();
  for (const x of rows) {
    const st = states.get(String(x.req_item_id));
    if (!st) continue;
    const meta = { unit: x.unit, purchase_unit: x.purchase_unit, pack_size: x.pack_size };
    const pf = packFactor(meta);
    const sd = sendableOf(String(x.material_id));
    const avail = Math.max(0, Number(sd?.available) || 0);
    const maxRecipe = r6(Math.min(st.owed_recipe, avail));
    const receiverActive = Number(x.to_department_active) === 1;
    const PU = st.purchase_unit;
    let blocked: ToSendLine['blocked'] = null;
    if (st.unit_review) {
      blocked = { code: 'unit_review', message: `${st.material_name} on ${st.req_number} is recorded in "${st.line_unit || '(no unit)'}", which cannot be read as ${st.recipe_unit} or ${PU}, so it cannot be sent until the line's unit is fixed.` };
    } else if (!receiverActive) {
      blocked = { code: 'receiver_inactive', message: `${String(x.to_department_name || 'The asking department')} is switched off, so nothing can be sent to it.` };
    } else if (!holdsAny(avail)) {
      blocked = { code: 'nothing_held', message: `${dept!.name}'s books hold no ${st.material_name}${sd?.upperBound ? ' (it has never been counted for it)' : ''}, so there is nothing to send yet.` };
    }
    const key = `${x.req_id}:${x.to_department_id}`;
    let g = groups.get(key);
    if (!g) {
      const p = party.get(String(x.req_id));
      g = {
        key, requisition_id: String(x.req_id), req_number: String(x.req_number || ''), req_date: String(x.req_date || ''),
        req_status: String(x.req_status || ''), purpose: x.purpose === 'party' ? 'party' : 'internal',
        event_name: String(x.event_name || ''), event_date: x.event_date || null,
        fp_id: p?.fp_id ?? null, party_unique_id: p?.party_unique_id ?? null,
        to_department_id: String(x.to_department_id || ''), to_department_name: String(x.to_department_name || ''),
        to_department_active: receiverActive, lines: [],
      };
      groups.set(key, g);
    }
    g.lines.push({
      req_item_id: st.req_item_id, material_id: st.material_id, material_name: st.material_name,
      material_category: String(x.material_category || ''),
      line_unit: st.line_unit, purchase_unit: PU, recipe_unit: st.recipe_unit, pack_factor: pf,
      approved_line: st.approved_line, sent_line: st.sent_line, owed_line: st.owed_line,
      approved_purchase: st.approved_purchase, sent_purchase: st.sent_purchase, owed_purchase: st.owed_purchase,
      owed_recipe: st.owed_recipe,
      sendable_recipe: r6(avail), sendable_purchase: shownPurchaseQty(avail, meta),
      sendable_upper_bound: !!sd?.upperBound, sendable_basis: String(sd?.basis || ''),
      max_send_purchase: blocked ? 0 : shownPurchaseQty(maxRecipe, meta), max_send_recipe: blocked ? 0 : maxRecipe,
      can_send: !blocked, blocked, sends: st.sends, expect_sent_line: st.sent_line, sentence: st.sentence,
    });
  }
  const list = [...groups.values()];
  return {
    department: dept, rules, explain, groups: list,
    totals: {
      groups: list.length,
      lines: list.reduce((s, g) => s + g.lines.length, 0),
      party_groups: list.filter((g) => g.purpose === 'party').length,
    },
  };
}
