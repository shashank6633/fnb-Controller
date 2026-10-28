import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { lineFactor, lineIssueComplete } from '@/lib/issue-stock';
// Delivered direct by quantity (rulings #68/#73) — the one reader, shared with
// the close-by-itself in po-link-lifecycle.ts, so badge, guard and close agree.
import { fmtLineQtyPU } from '@/lib/issue-stock';
import { reqLineDirectState } from '@/lib/po-link-lifecycle';
import { packFactor, shownPurchaseQty } from '@/lib/pack-units';
import { poReceiptLines, isReceiptHeldForQc } from '@/lib/po-receipts';
import { vendorResolver, vendorMappingError, headerVendorFromLines, vendorsForMaterial } from '@/lib/vendor-mapping';
import { duplicateLineError as duplicateLineErrorRule } from '@/lib/line-dedupe';
import { snapshotPoLines } from '@/lib/po-stock-snapshot';
import { stockOnHandBulk } from '@/lib/dept-stock';
import { todayIST } from '@/lib/format-date';
// ROUTED LINES (rulings #45/#74): the leaf probe — routed-requisitions imports
// this file, so it is never imported back.
import { routedSchema } from '@/lib/routed-schema';

/**
 * Shared Purchase Order helpers.
 *
 * Moved out of /api/purchase-orders/route.ts: Next.js route modules may only
 * export HTTP handlers (GET/POST/…), so the helpers shared with the
 * [id]/submit|approve|receive|reject action routes live here instead of being
 * re-exported from the route file (which fails route-module type validation).
 */

/** Role of the CURRENT SESSION, or null when there is no valid session.
 *  SECURITY: never falls back to a privileged role. The old settings-based
 *  `current_role` fallback meant a forged/expired cookie was treated as admin
 *  on every PO money/stock action — removed. Callers MUST 401 on null.
 *  Collapses 'staff' → 'manager' for the legacy two-tier PO callers. */
export async function effectiveRole(): Promise<'admin' | 'manager' | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === 'admin' ? 'admin' : 'manager';
}
/** Back-compat shim for callers that used the old sync currentRole(db): now
 *  session-based and nullable. */
export async function currentRole(): Promise<'admin' | 'manager' | null> {
  return effectiveRole();
}

/** Gate every PO WRITE action (create / edit / delete / submit / receive /
 *  revise) with this. 'anon' → 401, 'denied' → 403, 'ok' → proceed.
 *  WHY IT EXISTS: those routes are documented "Manager OR Admin" but test
 *  `if (!(await effectiveRole()))` — and effectiveRole()/currentRole() collapse
 *  staff into 'manager' (above), so that test only asserts "has a session", not
 *  a tier. A truthiness check on effectiveRole/currentRole is never a tier check.
 *  NOT for approve/reject: those are intentionally stricter (admin-only).
 *  MEMBERSHIP: management (admin, any manager, or a HOD — the same isManagement()
 *  that gates the rest of the app's management-only surfaces) PLUS the store
 *  manager flag. That is the set /api/crm/reorder/route.ts:28 already calls "the
 *  people who raise POs today", and is_store_manager is independent of tier
 *  (auth/users + auth/roles both allow it on a 'staff' base role), so without it
 *  this would 403 the storekeeper whose job submit/receive actually is.
 *  403 COPY: say "Only Management or the Store Manager …" — "Manager or Admin"
 *  misstates the rule, since a staff-tier HOD and a storekeeper both pass.
 *  ACCEPTED RISK: isManagement passes every base_role='manager', which includes
 *  the seeded Floor Manager and Bar Manager (db.ts roles seed) — roles whose
 *  page_access carries no store page at all. They therefore also pass on receive,
 *  the irreversible one (stock bump + last_purchase_price + average_price
 *  rewrite). Deliberate: one gate for the whole PO lifecycle. If that stops being
 *  acceptable, narrow RECEIVE only, to `admin || is_store_manager`. */
export async function poWriteGate(): Promise<'anon' | 'denied' | 'ok'> {
  const user = await getCurrentUser();
  if (!user) return 'anon';
  return (isManagement(user) || user.is_store_manager) ? 'ok' : 'denied';
}

export async function effectiveActor(): Promise<string> {
  const user = await getCurrentUser();
  return user ? user.email : 'system';
}

/**
 * THE PO NUMBER — PO-<year of the PO date>-NNNN. ONE COPY, used by every PO
 * creator: POST /api/purchase-orders, Smart Reorder (crm-reorder-po.ts), the
 * per-requisition "Also raise a vendor PO" tick (requisitions/[id]/
 * store-process) and the merge (createMergedPo below). It used to be written out
 * three times; three copies of a numbering rule is how two writers one day mint
 * the same number and one of them dies on purchase_orders.po_number UNIQUE.
 *
 * CALL IT INSIDE THE SAME db.transaction() AS THE INSERT it numbers.
 * better-sqlite3 is synchronous and single-connection per process, so MAX + 1
 * and the INSERT cannot interleave with another writer while the transaction
 * holds the lock — and several POs minted in one transaction (Smart Reorder's
 * one-per-vendor loop) each see the previous one's row and number on from it.
 *
 * SAME NUMBERS AS THE THREE COPIES IT REPLACES on every well-formed number: they
 * took the lexicographically greatest po_number of the year and parsed its last
 * '-' segment, which for 4-digit zero-padded suffixes IS the numeric maximum.
 * This reads the numeric maximum directly, so it also stays right after
 * PO-yyyy-9999 (where a string sort puts "10000" below "9999" and the old copies
 * would re-mint an existing number) and on a malformed suffix (where the old
 * parse produced "PO-yyyy-NaN"). The year is the first four characters of the
 * PO date, exactly as before.
 */
export function nextPoNumber(db: ReturnType<typeof getDb>, isoDate: string): string {
  const year = String(isoDate || '').slice(0, 4);
  const prefix = `PO-${year}-`;
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(po_number, ?) AS INTEGER)) AS n
      FROM purchase_orders
     WHERE po_number LIKE ? || '%'
  `).get(prefix.length + 1, prefix) as { n: number | null } | undefined;
  const last = Number(row?.n) || 0;
  return `${prefix}${String(last + 1).padStart(4, '0')}`;
}

export function recalcTotal(db: ReturnType<typeof getDb>, poId: string) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) AS t FROM purchase_order_items WHERE po_id = ?
  `).get(poId) as any;
  db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r.t, poId);
}

/** Is the admin approval step switched ON? Reads `po_require_admin_approval`
 *  from the settings KV (same table as the `po_send_to_vendor` toggle).
 *  THE RULE, one sentence, shared with the client: TRIM the stored value and
 *  compare to "0" — only "0" (padding allowed) turns approval off, so a MISSING
 *  row, a blank or any garbage value still requires approval.
 *  The Purchasing settings page applies that exact expression
 *  (`String(value ?? '').trim() !== '0'`, settings/purchasing/page.tsx) so its
 *  "Admin approval is OFF" banner can never contradict what this enforces. The
 *  `??` fallbacks are spelled differently ('1' here, '' there) only because each
 *  side's "nothing was read" sentinel differs; neither equals "0", so both read a
 *  missing row as required. The `.trim()` is what keeps them in step: without it
 *  a hand-edited/migrated " 0 " read OFF in the UI while this still enforced ON.
 *  FAIL-SAFE: any throw (table missing on an un-migrated DB, locked file) also
 *  returns true. Approval is a spend control — a failed read must never be the
 *  thing that silently lets a PO skip it. */
export function requiresAdminApproval(db: ReturnType<typeof getDb>): boolean {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('po_require_admin_approval') as
      | { value?: string }
      | undefined;
    return String(r?.value ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

/** Zero-rate gate. Returns null when every line has a usable rate, else the
 *  ready-to-return error message naming the offending material.
 *  A 0/blank rate is legal on a DRAFT on purpose (Smart Reorder drafts a line
 *  whose ₹/purchase-unit is not known yet — see lineSanityError in
 *  /api/purchase-orders/route.ts), but the last decision gate before the vendor
 *  ships must refuse it: [id]/receive rejects a 0 rate on every line it books (a
 *  ₹0 purchases row makes updateMaterialPrice wipe the material's average_price
 *  to 0 and cascade a "free" ingredient through every recipe), so leaving it to
 *  receive strands goods the warehouse is already holding.
 *  SHARED ON PURPOSE: this lives here, not inline in [id]/approve, because when
 *  `po_require_admin_approval` is off the submit path auto-approves and never
 *  reaches that route — both paths must run this or turning the switch off would
 *  remove the only thing standing between a ₹0 draft and the books.
 *  DIAGNOSIS ONLY, NO REMEDY: the message is shared by [id]/approve (where the
 *  fix is reject → revise → re-submit) and [id]/submit's auto-approve (where the
 *  txn rolled back and the PO never left draft, so there is nothing to reject).
 *  Each caller appends its own remedy sentence; naming one here made the other
 *  path hand out two contradictory instructions in a single alert.
 *  SCOPE = the lines receive can actually book: same JOIN, and store-mapped lines
 *  are skipped exactly as receive skips them (centralFlowBlock → `receivable`).
 *  Still a deliberate SUPERSET in the one direction that cannot be mirrored:
 *  receive only enforces the rate where accepted > 0, and whether a line will be
 *  fully rejected at QC is unknowable here, so a line that ends up rejected in
 *  full must still carry a real rate to get past this.
 *  Number.isFinite first — a bare `<= 0` is false for NaN. */
export function zeroRateBlocker(db: ReturnType<typeof getDb>, poId: string): string | null {
  const rateLines = db.prepare(`
    SELECT poi.material_id, poi.unit_price, rm.name AS material_name,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit
    FROM purchase_order_items poi
    JOIN raw_materials rm ON rm.id = poi.material_id
    WHERE poi.po_id = ?
  `).all(poId) as any[];
  for (const line of rateLines) {
    // Store-mapped (liquor) lines never enter Central purchases: receive filters
    // them out before pricing anything, so their rate cannot reach
    // updateMaterialPrice and blocking on one only strands the PO — PUT
    // /api/purchase-orders 400s on any payload naming a store-mapped material,
    // so the draft could be neither approved nor edited, only deleted.
    // FAIL-CLOSED: if the store lookup throws, treat the line as receivable and
    // hold it to the rate rule.
    let storeMapped = false;
    try {
      storeMapped = centralFlowBlock(db, String(line.material_id || '')) !== null;
    } catch {
      storeMapped = false;
    }
    if (storeMapped) continue;
    const px = Number(line.unit_price);
    if (!Number.isFinite(px) || px <= 0) {
      // Unit label = the PURCHASE unit: a PO line's rate is ₹ per purchase
      // unit (canon), so "₹/kg" here, never the recipe unit.
      const unit = String(line.material_purchase_unit || '').trim() || 'unit';
      return `Missing or zero rate on "${line.material_name}" (${px}). Receiving this PO would rewrite the material's average price, so the line needs a real ₹/${unit}.`;
    }
  }
  return null;
}

/* THE DUPLICATE-LINE RULE NOW LIVES IN ONE MODULE: @/lib/line-dedupe.
 * PoLineLike, lineKey, lineQty, lineLabel, duplicateLineError and
 * mergeDuplicateLines moved there VERBATIM (bodies, message strings and their
 * doc comments — read them there, they are not duplicated here).
 *
 * WHY IT MOVED: "Enter Full Bill" (src/app/purchases/page.tsx) is a 'use client'
 * component and can never import this file — po-helpers pulls in @/lib/db, i.e.
 * better-sqlite3, a native addon that must not reach the browser bundle. So the
 * bill modal RESTATED the rule inline, the two copies drifted (the mirror grew a
 * rate/GST/brand merge key and a "Keep both" escape hatch the PO never had), and
 * that drift is the whole reason for this ticket. line-dedupe imports NOTHING,
 * so both sides can now import the SAME rule.
 * DO NOT RESTATE THE RULE INLINE AGAIN — anywhere. Restating it is the bug.
 * And never let line-dedupe import po-helpers: one-way dependency only, or the
 * client bundle picks up the native driver through the back door.
 *
 * THIS IS A RE-EXPORT, NOT A WRAPPER, ON PURPOSE. `export … from` binds the very
 * same function objects and declarations, so the signature of duplicateLineError,
 * the `<T extends PoLineLike>` generic on mergeDuplicateLines and every emitted
 * message string are identical BY CONSTRUCTION — there is no second declaration
 * that can drift. A wrapper would re-declare all three and could. The callers
 * below still import from '@/lib/po-helpers' and were not touched:
 *   api/purchase-orders/route.ts (:484, :605)
 *   api/purchase-orders/[id]/edit-approved/route.ts (:181)
 *   api/requisitions/[id]/store-process/route.ts (:212)
 *   lib/crm-reorder-po.ts (:157) */
export { duplicateLineError, mergeDuplicateLines } from '@/lib/line-dedupe';

/* ══════════════════════════════════════════════════════════════════════════
 * MERGED PURCHASE ORDERS — owner rulings #63-#70 (2026-10-23).
 *
 * ONE master PO built from many requisitions (every department, internal AND
 * party), many vendors (a vendor per line), received one vendor bill at a time
 * under the SAME PO number by the shipped multi-vendor receive. This section
 * owns the three things the receive side does not:
 *
 *   1. WHICH requisition lines can go on a PO (evaluateRequisitionLines),
 *      read by GET /api/purchase-orders/merge/candidates and re-checked by the
 *      merge itself inside its transaction.
 *   2. BUILDING the PO (createMergedPo): one DRAFT PO, one line per material
 *      (summed across requisition lines), one po_requisition_lines row per
 *      requisition line. purchase_orders.requisition_id stays NULL and no
 *      requisition row is written at all — the store issues from the desk
 *      exactly as today (ruling #64).
 *   3. WHAT A REQUISITION LINE SHOULD SAY about its PO (requisitionLinePoState):
 *      on PO-x / arrived on GRN-y / delivered direct / vendor closed. Read by
 *      GET /api/requisitions (the management desk and the store desk feed).
 *
 * UNITS. A requisition line is stored in its OWN unit (requisition_items.unit,
 * "Option B"); a PO line counts PURCHASE units at ₹/purchase unit. Every
 * conversion goes line unit → recipe (issue-stock.ts lineFactor, THE line rule)
 * → purchase (pack-units.ts shownPurchaseQty, the figure the desks print). A
 * line whose unit cannot be resolved (blank on a packed material) is refused,
 * never guessed — the same stance lineFactor takes for stock.
 * ══════════════════════════════════════════════════════════════════════════ */

type PoDb = ReturnType<typeof getDb>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** Coverage tolerance in PURCHASE units. Both sides of every comparison are
 *  3-dp purchase figures (shownPurchaseQty shares, human-entered receipts), so
 *  this only absorbs float dust from summing them. */
const COVER_EPS = 1e-6;
const SQL_CHUNK = 400;

function chunked<T>(list: T[], size = SQL_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Is a requisition at a status where the STORE still owes it goods?
 *  The same rule as GET /api/requisitions?inbox=store (requisitions/route.ts),
 *  restated here because that route's rule lives inline in a WHERE clause:
 *    require_mgmt_approval = '1' → internal at chef_approved / store_processed,
 *                                  party at mgmt_approved / store_processed
 *    otherwise                   → chef_approved / mgmt_approved / store_processed
 *  If the two ever disagree, a line shows in the store's inbox but cannot be
 *  merged (or the reverse) — change both together. Exported for the routed
 *  lines' "To send" queue (routed-requisitions.ts), which opens at exactly the
 *  point the store inbox does (rulings #45/#74). */
export function storeStageCheck(db: PoDb): (status: string, purpose: string) => boolean {
  let requireMgmt = false;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'require_mgmt_approval'").get() as { value?: string } | undefined;
    requireMgmt = row?.value === '1';
  } catch { requireMgmt = false; }
  return (status, purpose) => {
    if (requireMgmt) {
      return purpose === 'party'
        ? status === 'mgmt_approved' || status === 'store_processed'
        : status === 'chef_approved' || status === 'store_processed';
    }
    return status === 'chef_approved' || status === 'mgmt_approved' || status === 'store_processed';
  };
}

/** A PO that no longer orders anything. Every other status — draft, pending,
 *  pending_reapproval, approved, rejected (revisable back to draft), received —
 *  still speaks for the lines it carries. */
const PO_DEAD = 'cancelled';

/* ── 3. WHAT A REQUISITION LINE SAYS ABOUT ITS PO ──────────────────────── */

export interface ReqLineOnPo {
  po_id: string;
  po_number: string;
  /** The vendor THIS line is ordered from (the PO line's vendor, else the
   *  header's) — never "Mixed (N vendors)" when the line has its own. */
  vendor_name: string;
  vendor_id: string | null;
  status: string;
  /** 1 = a merged PO (purchase_orders.merged). */
  merged: boolean;
  /** 'merge' = a po_requisition_lines row; 'requisition' = the per-requisition
   *  "Also raise a vendor PO" tick (purchase_order_items.req_item_id). */
  source: 'merge' | 'requisition';
  /** This line's share of the PO line, PURCHASE units. */
  qty_purchase: number;
}

export interface ReqLineArrival {
  grn_number: string;
  /** The receipt's date (goods_receipt_notes.date). */
  at: string;
  /** PURCHASE units of THIS line's share the receipt covers. */
  qty_purchase: number;
}

export interface ReqLinePoState {
  on_po: ReqLineOnPo | null;
  /** The line's whole share is covered by accepted, live (not void, not held
   *  for QC) receipts on its PO line, taking the PO line's links in creation
   *  order. VALUE-based: a voided bill or one still waiting on the kitchen
   *  never makes a line read "arrived". */
  arrived: ReqLineArrival | null;
  /** Part of the share is covered, not all of it (short or partly accepted
   *  delivery). `of_qty_purchase` is the whole share. Null when arrived. */
  arrived_partial: (ReqLineArrival & { of_qty_purchase: number }) | null;
  /** Rulings #68/#73: a Direct Issue rule sent this line's goods straight to
   *  the rule's department and that delivery covers the line's WHOLE remaining
   *  balance — nothing more of it may be issued from central. An internal line
   *  in this state closes by itself (po-link-lifecycle.ts section 4). A line
   *  only PART delivered direct reads false here and carries
   *  delivered_direct_partial instead: the rest of it is still owed. */
  delivered_direct: boolean;
  /** Ruling #73: PURCHASE units of this line delivered direct (0 = none),
   *  full or part. */
  delivered_direct_qty_purchase: number;
  /** Ruling #73: PART of the line was delivered direct; the rest is still
   *  owed — issuable from central (up to still_issuable_*) or on a later
   *  bill. Null when nothing, or everything, was delivered direct. */
  delivered_direct_partial: {
    qty_purchase: number;
    /** The line's share on its merged PO(s), PURCHASE units. */
    of_qty_purchase: number;
    /** The most the line may still take from central, LINE units / PURCHASE. */
    still_issuable_line: number;
    still_issuable_purchase: number;
  } | null;
  /** Who closed a delivered-direct line that reads store-closed: 'system' =
   *  it closed by itself after the receipt (rulings #68/#73,
   *  po-link-lifecycle.ts), 'store' = a person pressed Reject. Null on an open
   *  line or one nothing was delivered direct for — so a screen can say who
   *  closed it instead of "Closed by store" for both. */
  delivered_direct_closed_by: 'system' | 'store' | null;
  /** Where that Direct Issue delivery went — the department(s) the receipt's
   *  purchases rows were routed to (purchases.direct_issue_dept_id), joined
   *  with ', ' — and the bill it came on. Null unless some of the line was
   *  delivered direct (full or part). Often NOT the asking department (the
   *  rule decides), which is why it is named. */
  delivered_direct_dept_name: string | null;
  delivered_direct_grn: string | null;
  /** Ruling #69: the vendor was short-closed on the PO before this line was
   *  delivered — it reads "not delivered". */
  vendor_closed: boolean;
  vendor_closed_reason: string | null;
  /** Another PO that is ALSO still open for this same line (e.g. the tick path
   *  raised one after the merge). Empty in the normal case; non-empty means the
   *  line is ordered twice and someone should cancel one. */
  also_on_po: Array<{ po_id: string; po_number: string; status: string }>;
  /** Internal to the merge rule: the open link that still holds this line
   *  (null = free to merge). Same derivation as on_po, minus released links. */
  held_by: { po_id: string; po_number: string; status: string; source: 'merge' | 'requisition' } | null;
}

const EMPTY_STATE = (): ReqLinePoState => ({
  on_po: null, arrived: null, arrived_partial: null, delivered_direct: false,
  delivered_direct_qty_purchase: 0, delivered_direct_partial: null, delivered_direct_closed_by: null,
  delivered_direct_dept_name: null, delivered_direct_grn: null,
  vendor_closed: false, vendor_closed_reason: null, also_on_po: [], held_by: null,
});

interface LinkRow {
  link_id: string;            // po_requisition_lines.id, or 'poi:<id>' for the tick path
  source: 'merge' | 'requisition';
  req_item_id: string;
  po_id: string;
  po_item_id: string;
  po_number: string;
  po_status: string;
  po_merged: number;
  line_vendor: string;
  line_vendor_id: string | null;
  qty_purchase: number;
  delivered_direct: number;
  vendor_closed: number;
  created_at: string;
  rid: number;
}

/**
 * THE per-line PO state for a set of requisition lines, in a few batched
 * queries (never one per line). Lines with no PO link come back EMPTY_STATE.
 *
 * WHICH LINK IS "THE" PO. A line is normally on at most one live PO (the merge
 * refuses a held line). If it is on several, the one still HOLDING it wins
 * (newest first), then the newest live one; the rest are listed in also_on_po.
 * A cancelled PO is never reported — the line is simply not on it any more.
 *
 * ARRIVED is derived, never stored: po-receipts.ts poReceiptLines (the CLAIM
 * reader) filtered to the VALUE predicate by isReceiptHeldForQc, summed per PO
 * line as quantity_accepted (PURCHASE units, the PO line's own basis), then
 * handed to that PO line's links in creation order (created_at, rowid).
 */
export function requisitionLinePoState(db: PoDb, reqItemIds: readonly string[]): Map<string, ReqLinePoState> {
  const ids = [...new Set(reqItemIds.map(x => String(x || '').trim()).filter(Boolean))];
  const out = new Map<string, ReqLinePoState>();
  for (const id of ids) out.set(id, EMPTY_STATE());
  if (ids.length === 0) return out;
  // No link table (its migration has not run) means no line is on a merged PO
  // — a true statement, and the requisition screens keep working instead of
  // failing on a missing table.
  const haveLinks = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'po_requisition_lines'`).get();

  const links: LinkRow[] = [];
  for (const part of chunked(ids)) {
    const ph = part.map(() => '?').join(',');
    // Merge links. LEFT JOIN on the PO line so a link can never vanish from the
    // read because its line did (it cannot: the FK cascades — but a read that
    // hides a row is how a "held" line becomes mergeable twice).
    if (haveLinks) links.push(...(db.prepare(`
      SELECT prl.id AS link_id, 'merge' AS source, prl.req_item_id, prl.po_id, prl.po_item_id,
             po.po_number, po.status AS po_status, COALESCE(po.merged, 0) AS po_merged,
             COALESCE(NULLIF(TRIM(poi.vendor), ''), NULLIF(TRIM(po.vendor), ''), '') AS line_vendor,
             COALESCE(poi.vendor_id, po.vendor_id) AS line_vendor_id,
             prl.qty_purchase, prl.delivered_direct, prl.vendor_closed,
             prl.created_at, prl.rowid AS rid
        FROM po_requisition_lines prl
        JOIN purchase_orders po ON po.id = prl.po_id
        LEFT JOIN purchase_order_items poi ON poi.id = prl.po_item_id
       WHERE prl.req_item_id IN (${ph})
    `).all(...part) as LinkRow[]));
    // The per-requisition tick (store-process): purchase_order_items.req_item_id.
    // One requisition line per PO line there, so the whole PO line is its share.
    links.push(...(db.prepare(`
      SELECT 'poi:' || poi.id AS link_id, 'requisition' AS source, poi.req_item_id, poi.po_id, poi.id AS po_item_id,
             po.po_number, po.status AS po_status, COALESCE(po.merged, 0) AS po_merged,
             COALESCE(NULLIF(TRIM(poi.vendor), ''), NULLIF(TRIM(po.vendor), ''), '') AS line_vendor,
             COALESCE(poi.vendor_id, po.vendor_id) AS line_vendor_id,
             poi.quantity AS qty_purchase, 0 AS delivered_direct, 0 AS vendor_closed,
             po.created_at, poi.rowid AS rid
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.po_id
       WHERE poi.req_item_id IN (${ph})
    `).all(...part) as LinkRow[]));
  }
  const live = links.filter(l => String(l.po_status) !== PO_DEAD);
  if (live.length === 0) return out;

  // ── what arrived, per PO line (VALUE) ──
  const poIds = [...new Set(live.map(l => l.po_id))];
  const accepted = new Map<string, { qty: number; grn_number: string; at: string }>();
  const claimed = new Set<string>();   // PO lines with ANY live receipt (CLAIM)
  for (const poId of poIds) {
    for (const g of poReceiptLines(db, poId)) {
      const key = String(g.po_item_id);
      claimed.add(key);
      if (isReceiptHeldForQc(g.grn_status)) continue;   // VALUE: a held bill has accepted nothing yet
      const prev = accepted.get(key);
      const qty = (prev?.qty || 0) + (Number(g.quantity_accepted) || 0);
      // Ordered oldest receipt first, so the last one written is the latest.
      accepted.set(key, { qty, grn_number: String(g.grn_number || ''), at: String(g.received_on || '') });
    }
  }

  // ── every link on each PO line involved, in creation order ──
  const poItemIds = [...new Set(live.filter(l => l.source === 'merge').map(l => l.po_item_id))];
  const order = new Map<string, Array<{ link_id: string; qty: number }>>();
  for (const part of chunked(poItemIds)) {
    const rows = db.prepare(`
      SELECT id AS link_id, po_item_id, qty_purchase
        FROM po_requisition_lines
       WHERE po_item_id IN (${part.map(() => '?').join(',')})
       ORDER BY created_at, rowid
    `).all(...part) as Array<{ link_id: string; po_item_id: string; qty_purchase: number }>;
    for (const r of rows) {
      const arr = order.get(r.po_item_id) || [];
      arr.push({ link_id: r.link_id, qty: Number(r.qty_purchase) || 0 });
      order.set(r.po_item_id, arr);
    }
  }
  // ── what was delivered DIRECT (rulings #68/#73) ──
  // The same walk over the same links, restricted to the direct-routed
  // accepted quantity (po-link-lifecycle.ts reqLineDirectState). A link's
  // direct part is NOT "arrived": those goods went to the Direct Issue rule's
  // department, never into central, so the arrival badge ("issue it from here
  // as usual") counts only what came in centrally. Zero on every link no
  // Direct Issue receipt reached — the arrival figures there are unchanged.
  const directState = reqLineDirectState(db, [...new Set(live.filter(l => l.source === 'merge').map(l => l.req_item_id))]);
  const directOf = (l: LinkRow): number => l.source === 'merge'
    ? (directState.get(l.req_item_id)?.link_cover.get(l.link_id) || 0)
    : 0;
  const coverageOf = (l: LinkRow): { covered: number; share: number; direct: number; grn?: { grn_number: string; at: string } } => {
    const share = Number(l.qty_purchase) || 0;
    const direct = directOf(l);
    const got = accepted.get(l.po_item_id);
    if (!got || !(got.qty > 0)) return { covered: 0, share, direct };
    let before = 0;
    if (l.source === 'merge') {
      for (const o of order.get(l.po_item_id) || []) {
        if (o.link_id === l.link_id) break;
        before += o.qty;
      }
    }
    const covered = Math.max(0, Math.min(share, got.qty - before));
    return { covered: r6(covered), share, direct, grn: { grn_number: got.grn_number, at: got.at } };
  };

  // ── vendor closures on the POs involved ──
  const closures = new Map<string, Array<{ vendor_id: string | null; vendor_name: string; reason: string }>>();
  for (const part of chunked(poIds)) {
    let rows: Array<{ po_id: string; vendor_id: string | null; vendor_name: string; reason: string }> = [];
    try {
      rows = db.prepare(`
        SELECT po_id, vendor_id, COALESCE(vendor_name, '') AS vendor_name, COALESCE(reason, '') AS reason
          FROM po_vendor_closures WHERE po_id IN (${part.map(() => '?').join(',')})
      `).all(...part) as typeof rows;
    } catch { rows = []; }
    for (const r of rows) {
      const arr = closures.get(r.po_id) || [];
      arr.push(r);
      closures.set(r.po_id, arr);
    }
  }
  const closureFor = (l: LinkRow) => {
    const list = closures.get(l.po_id) || [];
    const vid = String(l.line_vendor_id || '').trim();
    const vname = String(l.line_vendor || '').trim().toLowerCase();
    return list.find(c =>
      (vid && String(c.vendor_id || '').trim() === vid)
      || (!!vname && String(c.vendor_name || '').trim().toLowerCase() === vname)) || null;
  };

  // ── per requisition line ──
  const byLine = new Map<string, LinkRow[]>();
  for (const l of live) {
    const arr = byLine.get(l.req_item_id) || [];
    arr.push(l);
    byLine.set(l.req_item_id, arr);
  }
  for (const [reqItemId, rows] of byLine) {
    // Newest first.
    rows.sort((a, b) => (String(b.created_at).localeCompare(String(a.created_at))) || (Number(b.rid) - Number(a.rid)));
    const judged = rows.map(l => {
      const cov = coverageOf(l);
      const full = cov.share > 0 && cov.covered + COVER_EPS >= cov.share;
      const closure = closureFor(l);
      // RELEASED = the vendor was closed on this PO and this share never came
      // (the link's own flag, or a closure row over a PO line nothing claimed).
      const closedUndelivered = !full && (Number(l.vendor_closed) === 1 || (!!closure && !claimed.has(l.po_item_id)));
      return { l, cov, full, closure, closedUndelivered };
    });
    const holding = judged.filter(j => !j.closedUndelivered);
    const pick = holding[0] || judged[0];
    const st = out.get(reqItemId) || EMPTY_STATE();
    const l = pick.l;
    st.on_po = {
      po_id: l.po_id, po_number: l.po_number, vendor_name: l.line_vendor, vendor_id: l.line_vendor_id || null,
      status: l.po_status, merged: Number(l.po_merged) === 1, source: l.source, qty_purchase: r6(Number(l.qty_purchase) || 0),
    };
    // ARRIVED IN CENTRAL = what the walk covers MINUS the direct part (both in
    // PURCHASE units, both in creation order). With nothing delivered direct
    // (direct = 0) these are exactly the figures this reader always gave.
    const centralGot = r6(Math.max(0, pick.cov.covered - pick.cov.direct));
    const centralShare = r6(Math.max(0, pick.cov.share - pick.cov.direct));
    if (pick.cov.grn && centralGot > COVER_EPS && centralGot + COVER_EPS >= centralShare) {
      st.arrived = { grn_number: pick.cov.grn.grn_number, at: pick.cov.grn.at, qty_purchase: centralShare };
    } else if (pick.cov.grn && centralGot > COVER_EPS) {
      st.arrived_partial = {
        grn_number: pick.cov.grn.grn_number, at: pick.cov.grn.at,
        qty_purchase: centralGot, of_qty_purchase: centralShare,
      };
    }
    // DELIVERED DIRECT (rulings #68/#73), by quantity, from the one reader the
    // issue routes' guards and the close-by-itself read too.
    const dd = directState.get(reqItemId);
    if (dd && dd.covered_purchase > COVER_EPS) {
      st.delivered_direct = dd.verdict.full;
      st.delivered_direct_qty_purchase = dd.covered_purchase;
      st.delivered_direct_closed_by = dd.store_rejected ? (dd.closed_by_system ? 'system' : 'store') : null;
      st.delivered_direct_dept_name = dd.dept_names.length > 0 ? dd.dept_names.join(', ') : null;
      // Oldest first, so the last is the latest bill.
      st.delivered_direct_grn = dd.grn_numbers.length > 0 ? dd.grn_numbers[dd.grn_numbers.length - 1] : null;
      st.delivered_direct_partial = dd.verdict.full ? null : {
        qty_purchase: dd.covered_purchase,
        of_qty_purchase: dd.share_purchase,
        still_issuable_line: dd.verdict.max_add_line,
        still_issuable_purchase: dd.verdict.max_add_purchase,
      };
    }
    st.vendor_closed = pick.closedUndelivered;
    st.vendor_closed_reason = pick.closedUndelivered ? (pick.closure?.reason || null) : null;
    st.held_by = holding[0]
      ? { po_id: holding[0].l.po_id, po_number: holding[0].l.po_number, status: holding[0].l.po_status, source: holding[0].l.source }
      : null;
    st.also_on_po = holding.slice(1)
      .filter(j => j.l.po_id !== l.po_id)
      .map(j => ({ po_id: j.l.po_id, po_number: j.l.po_number, status: j.l.po_status }));
    out.set(reqItemId, st);
  }

  return out;
}

/** One requisition line's delivered-direct position, as both issue routes'
 *  guards read it (rulings #68/#73). Present only for a line some of which a
 *  merged PO delivered direct. */
export interface DeliveredDirectCap {
  req_item_id: string;
  /** The line's whole remaining balance was delivered direct: nothing more of
   *  it may be issued from central. */
  full: boolean;
  /** The line is store-closed (by the store, or by itself after the receipt). */
  closed: boolean;
  is_party: boolean;
  covered_purchase: number;
  covered_line: number | null;
  approved_line: number;
  issued_line: number;
  /** The most quantity_issued may reach while the delivered-direct part stays
   *  unissued, LINE units — what an ABSOLUTE writer (store-process) may post. */
  max_issued_line: number;
  /** max_issued_line − issued_line — what an ADDING writer (store-issue) may add. */
  max_add_line: number;
  max_add_purchase: number;
  line_unit: string;
  /** "to <dept> on <PO> (<GRN>)". */
  where: string;
  /** A line quantity printed the way the desks print it (purchase unit first). */
  fmt: (lineQty: number) => string;
  /** One sentence: what was delivered direct and where. */
  what: string;
}

/**
 * RULINGS #68 + #73 AT THE ISSUE ROUTES. For each requisition line some of
 * which a merged PO delivered DIRECT (a Direct Issue rule sent the goods
 * straight to the rule's department), how much of it the central store may
 * still issue. ONLY THE COVERED PART IS REFUSED: a line part delivered direct
 * may still take its uncovered rest from central; a line FULLY delivered direct
 * may take nothing more. Read through the same reader as the desks' badge
 * (requisitionLinePoState) and the close-by-itself (po-link-lifecycle.ts
 * reqLineDirectState), so the refusal, the badge and the close cannot disagree.
 * Lines nothing was delivered direct for are absent — every other line is
 * exactly what it always was.
 */
export function deliveredDirectCaps(db: PoDb, reqItemIds: readonly string[]): Map<string, DeliveredDirectCap> {
  const out = new Map<string, DeliveredDirectCap>();
  const ids = [...new Set(reqItemIds.map(x => String(x || '').trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  for (const [id, st] of reqLineDirectState(db, ids)) {
    if (!(st.covered_purchase > COVER_EPS)) continue;
    const v = st.verdict;
    const meta = { unit: st.line.unit, purchase_unit: st.line.purchase_unit, pack_size: st.line.pack_size };
    const fmt = (q: number) => fmtLineQtyPU(q, st.line.line_unit, meta);
    const pu = String(st.line.purchase_unit || st.line.unit || '').trim();
    const coveredText = v.covered_line != null
      ? fmt(v.covered_line)
      : `${(Math.round(st.covered_purchase * 1000) / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })}${pu ? ` ${pu}` : ''}`;
    out.set(id, {
      req_item_id: id, full: v.full, closed: st.store_rejected, is_party: st.is_party,
      covered_purchase: st.covered_purchase, covered_line: v.covered_line,
      approved_line: v.approved_line, issued_line: v.issued_line,
      max_issued_line: v.max_issued_line, max_add_line: v.max_add_line, max_add_purchase: v.max_add_purchase,
      line_unit: String(st.line.line_unit ?? ''), where: st.where, fmt,
      what: `${coveredText} of it was delivered direct ${st.where} under a Direct Issue rule, so the central store never received that part`,
    });
  }
  return out;
}

/**
 * The FULLY delivered-direct lines among these (the line's whole remaining
 * balance went straight to the rule's department), each with one sentence
 * naming where the goods went. A line only PART delivered direct is not here —
 * its rest is still owed (ruling #73); read deliveredDirectCaps for it.
 */
export function deliveredDirectLines(db: PoDb, reqItemIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, cap] of deliveredDirectCaps(db, reqItemIds)) {
    if (!cap.full) continue;
    out.set(id, `delivered direct ${cap.where} under a Direct Issue rule, so the central store never received it`);
  }
  return out;
}

/**
 * THE TICK GUARD. The per-requisition "Also raise a vendor PO" tick
 * (store-process) writes purchase_orders.requisition_id, and when that PO
 * completes po-requisition-fulfil.ts marks the WHOLE requisition fulfilled
 * with no per-line check. A line of the same requisition that sits on a live
 * merged PO would then be stranded: still owed, its goods arriving on the
 * merged PO, and its requisition closed so the desk never offers it. The merge
 * refuses the reverse order (code requisition_po); this is the same rule seen
 * from the tick. Returns the held, still-owed lines (rejected lines owe
 * nothing and are skipped by the caller). Empty for every requisition no
 * merged PO touches — the tick is then exactly what it always was.
 */
export function mergedPoHolds(db: PoDb, reqItemIds: readonly string[]): Array<{ req_item_id: string; po_id: string; po_number: string; status: string }> {
  const out: Array<{ req_item_id: string; po_id: string; po_number: string; status: string }> = [];
  for (const [id, st] of requisitionLinePoState(db, reqItemIds)) {
    if (st.held_by && st.held_by.source === 'merge') {
      out.push({ req_item_id: id, po_id: st.held_by.po_id, po_number: st.held_by.po_number, status: st.held_by.status });
    }
  }
  return out;
}

/* ── 1. WHICH REQUISITION LINES CAN GO ON A PO ─────────────────────────── */

/** Why a requisition line cannot go on a merged PO. */
export type MergeBlockCode =
  | 'not_with_store'      // requisition is not at a store-stage status
  | 'other_outlet'        // requisition belongs to another outlet
  | 'rejected'            // chef- or store-rejected line
  | 'routed'              // rulings #45/#74: a Direct Issue department sends it from its own stock (its To send list)
  | 'nothing_owed'        // fully issued (THE RULE, lineIssueComplete), or owes less than one printed step
  | 'requisition_po'      // the requisition already has its own vendor PO (the tick)
  | 'on_po'               // the line is already on a live PO
  | 'store_mapped'        // liquor / store-mapped: bought on its store's ledger, never on a central PO
  | 'unit_unresolved';    // the line's unit cannot be read (blank on a packed material, or unrecognised)

export interface ReqLineCandidate {
  req_item_id: string;
  requisition_id: string;
  req_number: string;
  req_date: string;
  req_status: string;
  purpose: 'internal' | 'party';
  event_name: string;
  event_date: string | null;
  department_id: string | null;
  department_name: string;
  department_code: string;
  material_id: string;
  material_name: string;
  material_sku: string;
  material_category: string;
  /** requisition_items.unit as stored ('' = legacy, read as recipe). */
  line_unit: string;
  recipe_unit: string;
  purchase_unit: string;
  /** raw_materials.pack_size as stored (recipe units per purchase unit). */
  pack_size: number;
  /** packFactor() — 1 when there is no real pack conversion. */
  pack_factor: number;
  /** Line units, as the department asked. */
  qty_approved: number;
  qty_issued: number;
  owed_line: number;
  /** PURCHASE units — the figure a PO line counts in (3 dp, as the desks print). */
  owed_purchase: number;
  deferred_until: string | null;
  defer_reason: string;
  /** Central stock right now, PURCHASE units (the desks' "In store" figure). */
  central_stock_purchase: number;
  /** The same central balance in RECIPE units (raw_materials.current_stock). */
  current_stock: number;
  /** Set when the line cannot be merged. */
  blocked: { code: MergeBlockCode; reason: string } | null;
  on_po: ReqLineOnPo | null;
}

/** One row of evaluateRequisitionLines' SELECT, exactly as SQLite returns it. */
interface EvalRow {
  req_item_id: string; requisition_id: string; req_number: string | null; req_date: string | null;
  req_status: string | null; purpose: string | null; event_name: string | null; event_date: string | null;
  outlet_id: string | null; linked_po_id: string | null; req_po_number: string | null; req_po_status: string | null;
  department_id: string | null; department_name: string | null; department_code: string | null;
  material_id: string; material_name: string | null; material_sku: string | null; material_category: string | null;
  line_unit: string | null; recipe_unit: string | null; raw_purchase_unit: string | null; purchase_unit: string | null;
  pack_size: number | null; current_stock: number | null;
  quantity_requested: number | null; chef_approved_qty: number | null; quantity_issued: number | null;
  shelf_emptied_qty: number | null; is_rejected: number | null; store_rejected: number | null;
  deferred_until: string | null; defer_reason: string | null;
  /** Rulings #45/#74: '' unless the line is routed (always '' without the column). */
  routed_department_id: string | null; routed_department_name: string | null;
}

interface EvalOptions {
  /** Restrict to these requisition_items.id. Omit for "every owed line at the store". */
  ids?: readonly string[];
  /** The session outlet. A requisition stamped with another outlet is refused. */
  outletId: string | null;
}

/**
 * Read requisition lines and judge each one against the merge rule.
 *
 * Without `ids` it lists every line a store-stage requisition still owes
 * (the candidate feed, cheapest filter in SQL first). With `ids` it reads
 * exactly those lines whatever their state, so the merge can say precisely
 * why each refused line was refused. Lines are returned oldest requisition
 * first (date, req_number), which is also the order a merged PO hands
 * arrivals out in.
 */
export function evaluateRequisitionLines(db: PoDb, opts: EvalOptions): ReqLineCandidate[] {
  const atStore = storeStageCheck(db);
  // ROUTED LINES (rulings #45/#74): the sending department, when the column
  // exists; '' otherwise, so the SELECT is unchanged in meaning.
  const routed = routedSchema(db).lineCol;
  const routedSel = routed
    ? `COALESCE(ri.routed_department_id, '') AS routed_department_id, COALESCE(rtd.name, '') AS routed_department_name`
    : `'' AS routed_department_id, '' AS routed_department_name`;
  const routedJoin = routed ? `
      LEFT JOIN departments rtd ON rtd.id = ri.routed_department_id` : '';
  const select = `
    SELECT ri.id AS req_item_id, ri.req_id AS requisition_id,
           r.req_number, r.date AS req_date, r.status AS req_status,
           COALESCE(NULLIF(TRIM(r.purpose), ''), 'internal') AS purpose,
           COALESCE(r.event_name, '') AS event_name, r.event_date, r.outlet_id,
           r.linked_po_id, lpo.po_number AS req_po_number, lpo.status AS req_po_status,
           COALESCE(ri.department_id, r.department_id) AS department_id,
           COALESCE(d.name, '') AS department_name, COALESCE(d.code, '') AS department_code,
           ri.material_id, rm.name AS material_name, COALESCE(rm.sku, '') AS material_sku,
           COALESCE(rm.category, '') AS material_category,
           COALESCE(ri.unit, '') AS line_unit, rm.unit AS recipe_unit, rm.purchase_unit AS raw_purchase_unit,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS purchase_unit,
           COALESCE(rm.pack_size, 1) AS pack_size, rm.current_stock,
           ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued, ri.shelf_emptied_qty,
           COALESCE(ri.is_rejected, 0) AS is_rejected, COALESCE(ri.store_rejected, 0) AS store_rejected,
           ri.deferred_until, COALESCE(ri.defer_reason, '') AS defer_reason,
           ${routedSel}
      FROM requisition_items ri
      JOIN requisitions r    ON r.id  = ri.req_id
      JOIN raw_materials rm  ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(ri.department_id, r.department_id)
      LEFT JOIN purchase_orders lpo ON lpo.id = r.linked_po_id${routedJoin}`;
  const ORDER = `ORDER BY r.date, r.req_number, ri.created_at, ri.rowid`;
  let rows: EvalRow[] = [];
  if (opts.ids) {
    const ids = [...new Set(opts.ids.map(x => String(x || '').trim()).filter(Boolean))];
    for (const part of chunked(ids)) {
      rows.push(...(db.prepare(`${select} WHERE ri.id IN (${part.map(() => '?').join(',')}) ${ORDER}`).all(...part) as EvalRow[]));
    }
    rows.sort((a, b) =>
      String(a.req_date).localeCompare(String(b.req_date))
      || String(a.req_number).localeCompare(String(b.req_number)));
  } else {
    const where = [
      `r.status IN ('chef_approved', 'mgmt_approved', 'store_processed')`,
      `COALESCE(ri.is_rejected, 0) = 0`,
      `COALESCE(ri.store_rejected, 0) = 0`,
      `COALESCE(ri.quantity_issued, 0) < COALESCE(ri.chef_approved_qty, ri.quantity_requested, 0)`,
    ];
    const params: unknown[] = [];
    if (opts.outletId) { where.push('(r.outlet_id = ? OR r.outlet_id IS NULL)'); params.push(opts.outletId); }
    rows = db.prepare(`${select} WHERE ${where.join(' AND ')} ${ORDER}`).all(...params) as EvalRow[];
  }

  const state = requisitionLinePoState(db, rows.map(r => String(r.req_item_id)));
  const out: ReqLineCandidate[] = [];
  for (const r of rows) {
    const meta = { unit: r.recipe_unit, purchase_unit: r.raw_purchase_unit, pack_size: r.pack_size };
    const pf = packFactor(meta);
    const eff = (r.chef_approved_qty != null ? Number(r.chef_approved_qty) : Number(r.quantity_requested)) || 0;
    const issued = Number(r.quantity_issued) || 0;
    const owedLine = r6(Math.max(0, eff - issued));
    const { factor, needsReview } = lineFactor(r.line_unit, meta);
    const owedPurchase = needsReview ? 0 : shownPurchaseQty(owedLine * factor, meta);
    const st = state.get(String(r.req_item_id)) || EMPTY_STATE();
    const complete = lineIssueComplete({
      quantity_issued: r.quantity_issued, chef_approved_qty: r.chef_approved_qty,
      quantity_requested: r.quantity_requested, line_unit: r.line_unit,
      unit: r.recipe_unit, purchase_unit: r.raw_purchase_unit, pack_size: r.pack_size,
      shelf_emptied_qty: r.shelf_emptied_qty,
    });
    let storeMapped: string | null = null;
    try { storeMapped = centralFlowBlock(db, String(r.material_id)); } catch { storeMapped = null; }

    let blocked: ReqLineCandidate['blocked'] = null;
    const purpose = String(r.purpose) === 'party' ? 'party' : 'internal';
    if (!atStore(String(r.req_status), purpose)) {
      blocked = { code: 'not_with_store', reason: `${r.req_number} is "${r.req_status}" — only requisitions waiting on the store can go on a PO.` };
    } else if (opts.outletId && r.outlet_id && String(r.outlet_id) !== String(opts.outletId)) {
      blocked = { code: 'other_outlet', reason: `${r.req_number} belongs to another outlet.` };
    } else if (Number(r.is_rejected) === 1 || Number(r.store_rejected) === 1) {
      blocked = { code: 'rejected', reason: `${r.material_name} on ${r.req_number} was rejected, so nothing is owed on it.` };
    } else if (String(r.routed_department_id || '') !== '') {
      // RULINGS #45/#74. A Direct Issue rule sends this material straight to
      // the routed department, which hands this line over from its own books
      // by department transfer; a central PO would buy it a second time, into
      // a store that never holds it. createMergedPo re-checks through here.
      const D = String(r.routed_department_name || '') || 'the Direct Issue department';
      blocked = {
        code: 'routed',
        reason: `${r.material_name} on ${r.req_number} is on ${D}'s To send list — ${D} sends it from its own stock (Direct Issue). Buy for ${D} on ${D}'s own requisition.`,
      };
    } else if (r.linked_po_id && String(r.req_po_status || '') !== PO_DEAD && r.req_po_number) {
      // The tick's PO completes the WHOLE requisition (po-requisition-fulfil.ts
      // marks it fulfilled with no per-line check), which would strand any line
      // of it that sat on a merged PO. So a requisition with its own live PO is
      // served by that PO alone.
      blocked = { code: 'requisition_po', reason: `${r.req_number} already has its own vendor PO (${r.req_po_number}, ${r.req_po_status}), raised with "Also raise a vendor PO" — its lines are bought on that PO.` };
    } else if (st.held_by) {
      blocked = { code: 'on_po', reason: `${r.material_name} on ${r.req_number} is already on ${st.held_by.po_number} (${st.held_by.status}).` };
    } else if (storeMapped) {
      blocked = { code: 'store_mapped', reason: `${r.material_name} is bought on its store's own ledger, never on a central PO. ${storeMapped}` };
    } else if (needsReview) {
      blocked = { code: 'unit_unresolved', reason: `${r.material_name} on ${r.req_number} is recorded in "${r.line_unit || '(no unit)'}", which cannot be read as ${r.recipe_unit} or ${r.purchase_unit} — fix the line's unit before ordering it.` };
    } else if (complete || !(owedPurchase > 0)) {
      blocked = { code: 'nothing_owed', reason: `${r.material_name} on ${r.req_number} has nothing left to buy.` };
    }

    out.push({
      req_item_id: String(r.req_item_id),
      requisition_id: String(r.requisition_id),
      req_number: String(r.req_number || ''),
      req_date: String(r.req_date || ''),
      req_status: String(r.req_status || ''),
      purpose,
      event_name: String(r.event_name || ''),
      event_date: r.event_date || null,
      department_id: r.department_id || null,
      department_name: String(r.department_name || ''),
      department_code: String(r.department_code || ''),
      material_id: String(r.material_id),
      material_name: String(r.material_name || ''),
      material_sku: String(r.material_sku || ''),
      material_category: String(r.material_category || ''),
      line_unit: String(r.line_unit || ''),
      recipe_unit: String(r.recipe_unit || ''),
      purchase_unit: String(r.purchase_unit || ''),
      pack_size: Number(r.pack_size) || 1,
      pack_factor: pf,
      qty_approved: r6(eff),
      qty_issued: r6(issued),
      owed_line: owedLine,
      owed_purchase: owedPurchase,
      deferred_until: String(r.deferred_until || '').trim() || null,
      defer_reason: String(r.defer_reason || ''),
      central_stock_purchase: shownPurchaseQty(Number(r.current_stock) || 0, meta),
      current_stock: Number(r.current_stock) || 0,
      blocked,
      on_po: st.on_po,
    });
  }
  return out;
}

/** Vendor suggestion + last rates for the candidate feed, per material. */
export interface MaterialBuyHint {
  material_id: string;
  /** Vendors mapped to supply this material (vendor_materials), active first. */
  mapped_vendors: Array<{ id: string; name: string; is_active: boolean; last_rate: number | null; last_rate_date: string | null }>;
  /** The suggested vendor: the last vendor actually bought from (if still
   *  mapped and active), else the material's primary vendor (if mapped and
   *  active), else the only mapped active vendor. Null when none applies. */
  default_vendor: { id: string; name: string; source: 'last_purchase' | 'primary_vendor' | 'only_mapped' } | null;
  /** ₹ per PURCHASE unit on the default vendor's own last purchase of this
   *  material. Null when that vendor has never billed it — never another
   *  vendor's rate under this vendor's name. */
  default_vendor_last_rate: number | null;
  /** The latest purchase of this material from anyone, ₹ per PURCHASE unit. */
  last_purchase: { rate: number; vendor_name: string; date: string } | null;
}

export function materialBuyHints(db: PoDb, materialIds: readonly string[]): Map<string, MaterialBuyHint> {
  const out = new Map<string, MaterialBuyHint>();
  const resolve = vendorResolver(db);
  // purchases.unit_price is ₹ per PURCHASE unit (purchase rows are booked in
  // purchase units) — the same source the PO composer seeds its rate from
  // (/api/inventory's last_purchase_price alias). raw_materials.last_purchase_price
  // is NOT used: it is mixed-basis on live data.
  const lastAny = db.prepare(`
    SELECT unit_price, COALESCE(vendor, '') AS vendor, date FROM purchases
     WHERE material_id = ? ORDER BY date DESC, created_at DESC LIMIT 1`);
  const lastFrom = db.prepare(`
    SELECT unit_price, date FROM purchases
     WHERE material_id = ? AND LOWER(TRIM(vendor)) = LOWER(TRIM(?))
     ORDER BY date DESC, created_at DESC LIMIT 1`);
  const primary = db.prepare(`SELECT COALESCE(primary_vendor, '') AS pv FROM raw_materials WHERE id = ?`);
  for (const mid of new Set(materialIds)) {
    const pairs = vendorsForMaterial(db, mid);
    const mapped = pairs
      .map(p => {
        const lr = lastFrom.get(mid, p.vendor_name) as { unit_price: number; date: string } | undefined;
        const rate = lr && Number.isFinite(Number(lr.unit_price)) && Number(lr.unit_price) > 0 ? r2(Number(lr.unit_price)) : null;
        return { id: p.vendor_id, name: p.vendor_name, is_active: Number(p.vendor_is_active) === 1, last_rate: rate, last_rate_date: rate != null ? String(lr!.date || '') : null };
      })
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name));
    const usable = mapped.filter(v => v.is_active);
    const la = lastAny.get(mid) as { unit_price: number; vendor: string; date: string } | undefined;
    const last_purchase = la && Number(la.unit_price) > 0
      ? { rate: r2(Number(la.unit_price)), vendor_name: String(la.vendor || ''), date: String(la.date || '') }
      : null;
    let def: MaterialBuyHint['default_vendor'] = null;
    if (la?.vendor) {
      const v = resolve({ vendor: la.vendor });
      const hit = v.status === 'known' ? usable.find(u => u.id === v.id) : undefined;
      if (hit) def = { id: hit.id, name: hit.name, source: 'last_purchase' };
    }
    if (!def) {
      const pv = String((primary.get(mid) as { pv?: string } | undefined)?.pv || '').trim();
      if (pv) {
        const v = resolve({ vendor: pv });
        const hit = v.status === 'known' ? usable.find(u => u.id === v.id) : undefined;
        if (hit) def = { id: hit.id, name: hit.name, source: 'primary_vendor' };
      }
    }
    if (!def && usable.length === 1) def = { id: usable[0].id, name: usable[0].name, source: 'only_mapped' };
    out.set(mid, {
      material_id: mid,
      mapped_vendors: mapped,
      default_vendor: def,
      default_vendor_last_rate: def ? (mapped.find(m => m.id === def!.id)?.last_rate ?? null) : null,
      last_purchase,
    });
  }
  return out;
}

/* ── 2. BUILDING THE MERGED PO ─────────────────────────────────────────── */

export interface MergeRequest {
  requisition_item_ids?: unknown;
  lines?: unknown;
  notes?: unknown;
  expected_date?: unknown;
  date?: unknown;
}

export type MergeOutcome =
  | { ok: true; po: Record<string, unknown>; items: Array<Record<string, unknown>>; links: Array<Record<string, unknown>>; merged_from: Array<{ requisition_id: string; req_number: string; department_name: string; purpose: string }> }
  | { ok: false; status: number; code: string; error: string; details?: unknown };

class MergeRefusal extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * POST /api/purchase-orders/merge — ONE DRAFT PO from many requisition lines.
 *
 *   requisition_item_ids  the requisition lines being bought for (any
 *                         departments, internal and party)
 *   lines                 ONE per material among them:
 *                         { material_id, vendor_id, rate (₹/purchase unit),
 *                           qty_purchase (purchase units; omitted = the lines'
 *                           owed total) }
 *   notes, expected_date  one expected date per PO (ruling #70 default)
 *   date                  the PO date, default today (IST)
 *
 * The caller (route) owns auth: store manager or admin (ruling #65).
 *
 * WHAT IT WRITES: purchase_orders (status 'draft', merged = 1, requisition_id
 * NULL), purchase_order_items (one per material, vendor per line,
 * req_item_id NULL — the link table is THE link), po_requisition_lines (one per
 * requisition line, its owed share in purchase AND line units, oldest
 * requisition first), the stock-at-raise snapshot, and one audit event.
 * It writes NOTHING to requisitions or requisition_items.
 *
 * REFUSES (nothing written): an unknown line; a line that is not owed by the
 * store (see MergeBlockCode); a material with no PO line or a PO line for a
 * material nobody asked for; two lines for one material; a vendor not in the
 * master, inactive, or not mapped to the item; a negative/non-numeric rate; a
 * non-positive quantity; a malformed expected date or one before the PO date.
 * A 0 rate is allowed on the draft, as on every other draft — the zero-rate
 * gate at submit/approve refuses it before the vendor ships.
 */
export function createMergedPo(
  db: PoDb,
  body: MergeRequest,
  ctx: { actor: string; outletId: string | null },
): MergeOutcome {
  try {
    // ── shape ──
    const rawIds = Array.isArray(body?.requisition_item_ids) ? body.requisition_item_ids : null;
    if (!rawIds || rawIds.length === 0) throw new MergeRefusal(400, 'no_lines', 'Pick at least one requisition line to put on the PO.');
    const ids = rawIds.map(x => String(x ?? '').trim());
    if (ids.some(x => !x)) throw new MergeRefusal(400, 'bad_line_id', 'A requisition line id is blank. Reload the list and try again.');
    if (new Set(ids).size !== ids.length) throw new MergeRefusal(400, 'duplicate_line', 'The same requisition line was picked twice. Reload the list and try again.');
    const rawLines = Array.isArray(body?.lines) ? body.lines as Array<Record<string, unknown> | null> : null;
    if (!rawLines || rawLines.length === 0) throw new MergeRefusal(400, 'no_po_lines', 'The PO needs one line per item, with a vendor and a rate.');

    const isoDate = (() => {
      const s = typeof body?.date === 'string' ? body.date.trim() : '';
      if (!s) return todayIST();
      if (!isIsoDate(s)) throw new MergeRefusal(400, 'bad_date', `PO date must be a real date (YYYY-MM-DD) — got "${s}".`);
      return s;
    })();
    const deliveryDate = (() => {
      const s = typeof body?.expected_date === 'string' ? body.expected_date.trim() : '';
      if (!s) return null;
      if (!isIsoDate(s)) throw new MergeRefusal(400, 'bad_expected_date', `Expected delivery date must be a real date (YYYY-MM-DD) — got "${s}".`);
      if (s < isoDate) throw new MergeRefusal(400, 'expected_before_po', `Expected delivery date ${s} is before the PO date ${isoDate} — a vendor cannot deliver before the order is placed.`);
      return s;
    })();
    const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';

    // ── the requisition lines ──
    const judged = evaluateRequisitionLines(db, { ids, outletId: ctx.outletId });
    const found = new Set(judged.map(j => j.req_item_id));
    const unknown = ids.filter(x => !found.has(x));
    if (unknown.length) throw new MergeRefusal(400, 'unknown_line', `${unknown.length} picked requisition line${unknown.length === 1 ? ' no longer exists' : 's no longer exist'}. Reload the list and try again.`, { req_item_ids: unknown });
    const refused = judged.filter(j => j.blocked);
    if (refused.length) {
      const first = refused[0].blocked!;
      const status = refused.some(j => j.blocked!.code === 'on_po' || j.blocked!.code === 'requisition_po') ? 409 : 400;
      throw new MergeRefusal(status, first.code,
        refused.length === 1 ? first.reason : `${first.reason} (${refused.length - 1} more line${refused.length - 1 === 1 ? '' : 's'} cannot go on this PO either — see the list.)`,
        { refused: refused.map(j => ({ req_item_id: j.req_item_id, req_number: j.req_number, material_name: j.material_name, code: j.blocked!.code, reason: j.blocked!.reason })) });
    }

    // ── one PO line per material ──
    // Names for the messages below, so a refusal says "SPAGHETTI", never an id.
    const nameOf = (() => {
      const stmt = db.prepare('SELECT name FROM raw_materials WHERE id = ?');
      const cache = new Map<string, string>();
      return (mid: string): string => {
        if (!cache.has(mid)) cache.set(mid, String((stmt.get(mid) as { name?: string } | undefined)?.name || '').trim());
        return cache.get(mid) || '';
      };
    })();
    const dup = duplicateLineErrorRule(rawLines.map(l => {
      const mid = String(l?.material_id ?? '').trim();
      return { material_id: mid, material_name: mid ? nameOf(mid) : '', quantity: l?.qty_purchase };
    }));
    if (dup) throw new MergeRefusal(400, 'duplicate_material', dup);
    const byMaterial = new Map<string, ReqLineCandidate[]>();
    for (const j of judged) {
      const arr = byMaterial.get(j.material_id) || [];
      arr.push(j);
      byMaterial.set(j.material_id, arr);
    }
    const lineByMaterial = new Map<string, Record<string, unknown> | null>();
    for (const l of rawLines) lineByMaterial.set(String(l?.material_id ?? '').trim(), l);
    for (const [mid, reqs] of byMaterial) {
      if (!lineByMaterial.has(mid)) throw new MergeRefusal(400, 'missing_po_line', `${reqs[0].material_name} is on the picked requisition lines but has no PO line — give it a vendor and a rate.`, { material_id: mid });
    }
    for (const [mid] of lineByMaterial) {
      if (!byMaterial.has(mid)) {
        const label = !mid ? 'A PO line has no item' : `${nameOf(mid) || `Item ${mid}`} is on the PO lines but none of the picked requisition lines asks for it`;
        throw new MergeRefusal(400, 'line_not_requested', `${label}. A merged PO only carries what the departments asked for — remove that line, or tick the requisition line it is for.`, { material_id: mid });
      }
    }

    // ── vendor, rate, quantity per line ──
    const resolve = vendorResolver(db);
    const activeStmt = db.prepare('SELECT is_active FROM vendors WHERE id = ?');
    type Built = { material_id: string; material_name: string; purchase_unit: string; vendor_id: string; vendor: string; qty: number; rate: number; total: number; reqs: ReqLineCandidate[] };
    const built: Built[] = [];
    const ordered = [...byMaterial.entries()];   // oldest requisition's material first
    for (let i = 0; i < ordered.length; i++) {
      const [mid, reqs] = ordered[i];
      const raw = lineByMaterial.get(mid);
      const label = reqs[0].material_name;
      const vid = String(raw?.vendor_id ?? '').trim();
      if (!vid) throw new MergeRefusal(400, 'vendor_required', `${label}: pick a vendor — every line of a merged PO names its own vendor.`, { material_id: mid });
      const v = resolve({ vendor_id: vid });
      if (v.status !== 'known') throw new MergeRefusal(400, 'vendor_unknown', `${label}: the vendor is not in the Vendor master. Pick the vendor from the list.`, { material_id: mid });
      const act = activeStmt.get(v.id) as { is_active?: number } | undefined;
      if (Number(act?.is_active ?? 1) !== 1) throw new MergeRefusal(400, 'vendor_inactive', `${label}: ${v.name} is marked inactive in the Vendor master, so a new PO cannot be placed with them.`, { material_id: mid });
      const rate = Number(raw?.rate);
      if (raw?.rate == null || raw?.rate === '' || !Number.isFinite(rate)) throw new MergeRefusal(400, 'rate_required', `${label}: the rate is not a number.`, { material_id: mid });
      if (rate < 0) throw new MergeRefusal(400, 'rate_negative', `${label}: the rate cannot be negative (got ${rate}).`, { material_id: mid });
      const owedTotal = Math.round(reqs.reduce((s, q) => s + q.owed_purchase, 0) * 1000) / 1000;
      const qtyRaw = raw?.qty_purchase;
      const qty = qtyRaw == null || qtyRaw === '' ? owedTotal : Number(qtyRaw);
      if (!Number.isFinite(qty)) throw new MergeRefusal(400, 'qty_not_number', `${label}: the quantity is not a number.`, { material_id: mid });
      if (!(qty > 0)) throw new MergeRefusal(400, 'qty_not_positive', `${label}: the quantity must be greater than 0 ${reqs[0].purchase_unit} (got ${qty}).`, { material_id: mid });
      built.push({ material_id: mid, material_name: label, purchase_unit: reqs[0].purchase_unit, vendor_id: v.id!, vendor: v.name, qty: r6(qty), rate, total: r2(qty * rate), reqs });
    }
    // STRICT VENDOR ↔ ITEM MAPPING — the same rule every PO writer runs.
    const badPair = vendorMappingError(db, built.map(b => ({ material_id: b.material_id, vendor_id: b.vendor_id, vendor: b.vendor })));
    if (badPair) throw new MergeRefusal(400, 'vendor_not_mapped', badPair);

    const hdr = headerVendorFromLines(db, built.map(b => ({ vendor_id: b.vendor_id, vendor: b.vendor })));
    // Outside the write lock, exactly as POST /api/purchase-orders does.
    const stockAtRaise = stockOnHandBulk(db, built.map(b => b.material_id));

    const reqNumbers = [...new Map(judged.map(j => [j.requisition_id, j])).values()];
    const deptCount = new Set(judged.map(j => j.department_id || '')).size;
    const autoNote = `Merged from ${reqNumbers.length} requisition${reqNumbers.length === 1 ? '' : 's'} (${judged.length} line${judged.length === 1 ? '' : 's'}, ${deptCount} department${deptCount === 1 ? '' : 's'}): ${reqNumbers.map(r => r.req_number).join(', ')}`;
    const poNotes = notes ? `${notes}\n${autoNote}` : autoNote;

    const poId = generateId();
    let poNumber = '';
    const txn = db.transaction(() => {
      // RE-CHECK INSIDE THE LOCK: another merge (or the tick) may have taken a
      // line between the read above and here.
      const again = evaluateRequisitionLines(db, { ids, outletId: ctx.outletId }).filter(j => j.blocked);
      if (again.length) {
        throw new MergeRefusal(409, again[0].blocked!.code, `${again[0].blocked!.reason} Reload the list — it changed while you were building the PO.`,
          { refused: again.map(j => ({ req_item_id: j.req_item_id, code: j.blocked!.code, reason: j.blocked!.reason })) });
      }
      poNumber = nextPoNumber(db, isoDate);
      db.prepare(`
        INSERT INTO purchase_orders (id, po_number, date, delivery_date, vendor_id, vendor, status, notes, drafted_by, outlet_id, merged, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(poId, poNumber, isoDate, deliveryDate, hdr.vendor_id, hdr.vendor || '', poNotes, ctx.actor, ctx.outletId);
      const insItem = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes, req_item_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      const insLink = db.prepare(`
        INSERT INTO po_requisition_lines (id, po_id, po_item_id, requisition_id, req_item_id, department_id,
                                          qty_purchase, qty_line, line_unit, is_party, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      let total = 0;
      for (const b of built) {
        const poItemId = generateId();
        // The department breakdown, in PURCHASE units, so the internal sheet and
        // the PO page can say who each kilo is for without another query.
        const lineNote = b.reqs
          .map(q => `${q.req_number}${q.department_name ? ` ${q.department_name}` : ''}${q.purpose === 'party' ? ' (party)' : ''} ${q.owed_purchase} ${b.purchase_unit}`)
          .join('; ');
        insItem.run(poItemId, poId, b.material_id, b.qty, b.rate, b.total, b.vendor, b.vendor_id, `For ${lineNote}`);
        total += b.total;
        // Oldest requisition first — the order arrivals are handed out in.
        for (const q of b.reqs) {
          insLink.run(generateId(), poId, poItemId, q.requisition_id, q.req_item_id, q.department_id,
                      q.owed_purchase, q.owed_line, q.line_unit, q.purpose === 'party' ? 1 : 0, ctx.actor);
        }
      }
      snapshotPoLines(db, poId, { takenBy: ctx.actor, source: 'po_create', precomputed: stockAtRaise });
      db.prepare(`UPDATE purchase_orders SET total_cost = ?, updated_at = datetime('now') WHERE id = ?`).run(r2(total), poId);
      logAuditEvent(db, {
        event_type: 'po.merge',
        entity_type: 'purchase_order',
        entity_id: poId,
        actor_email: ctx.actor,
        outlet_id: ctx.outletId,
        after: {
          po_number: poNumber, status: 'draft', merged: 1, vendor: hdr.vendor, total_cost: r2(total),
          lines: built.map(b => ({ material_id: b.material_id, vendor: b.vendor, qty_purchase: b.qty, rate: b.rate })),
          requisition_lines: judged.map(j => ({ req_item_id: j.req_item_id, req_number: j.req_number, department: j.department_name, qty_purchase: j.owed_purchase })),
        },
        note: autoNote,
      });
    });
    txn();

    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId) as Record<string, unknown>;
    const items = db.prepare(`
      SELECT poi.*, rm.name AS material_name,
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit
        FROM purchase_order_items poi JOIN raw_materials rm ON rm.id = poi.material_id
       WHERE poi.po_id = ? ORDER BY poi.rowid`).all(poId) as Array<Record<string, unknown>>;
    const links = db.prepare(`SELECT * FROM po_requisition_lines WHERE po_id = ? ORDER BY created_at, rowid`).all(poId) as Array<Record<string, unknown>>;
    return {
      ok: true, po, items, links,
      merged_from: reqNumbers.map(r => ({ requisition_id: r.requisition_id, req_number: r.req_number, department_name: r.department_name, purpose: r.purpose })),
    };
  } catch (e) {
    if (e instanceof MergeRefusal) return { ok: false, status: e.status, code: e.code, error: e.message, details: e.details };
    throw e;
  }
}
