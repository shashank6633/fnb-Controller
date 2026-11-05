import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { receivedPoItemIds, liveValueSql } from './po-receipts';
import { lineFactor, lineIssueComplete } from './issue-stock';
import { packFactor, shownPurchaseQty } from './pack-units';

/* ══════════════════════════════════════════════════════════════════════════
 * MERGED-PO REQUISITION LINKS ACROSS THE PO LIFECYCLE (rulings 63, 68, 69).
 *
 * SERVER ONLY. Every writer here runs INSIDE the caller's db.transaction()
 * except syncPoLinkFlagsAfterCommit, which is the post-commit wrapper.
 *
 * po_requisition_lines ties ONE PO line (one material) to the MANY requisition
 * lines it buys for. Three things in the PO's life move under those rows, and
 * this file is the one place that answers for each:
 *
 *   1. LINE REWRITES. PUT /api/purchase-orders (drafts) and
 *      POST …/[id]/edit-approved both DELETE and re-insert every
 *      purchase_order_items row, so every line gets a NEW id.
 *      po_requisition_lines.po_item_id is ON DELETE CASCADE and foreign_keys is
 *      ON (db.ts), so that DELETE silently takes every link with it. The links
 *      are captured BEFORE the delete and written back, re-keyed BY MATERIAL to
 *      the new line ids — one material is one line on a PO (line-dedupe.ts), so
 *      the mapping is exact. A material the edit REMOVED drops its links, which
 *      frees those requisition lines to be ordered again; nothing else is
 *      dropped, ever.
 *
 *   2. SHORT-CLOSING ONE VENDOR (ruling 69). po_vendor_closures holds one row
 *      per (PO, vendor). A closed vendor's lines that no LIVE receipt claims are
 *      "not delivered": receive no longer offers or owes them, and the PO
 *      completes without them. DERIVED, not stamped per line, because the PO
 *      line ids change on every rewrite (1 above) and purchase_order_items may
 *      not grow a column (receive/route.ts doctrine) — a vendor-level record
 *      survives both.
 *
 *   3. THE TWO LINK FLAGS the requisition screens read —
 *      delivered_direct (ruling 68) and vendor_closed (ruling 69). Both are
 *      DERIVED from the receipt ledger and the closures and re-written by
 *      syncPoLinkFlags(); nothing else should set them. Being derived, a sync is
 *      idempotent and self-healing: any later call on the same PO puts them
 *      right, whatever happened in between.
 *
 *   4. DELIVERED DIRECT BY QUANTITY, AND THE LINE THAT CLOSES BY ITSELF
 *      (rulings 68 + 73). Only the quantity that actually landed direct is
 *      "delivered direct": a short Direct Issue receipt is handed to the PO
 *      line's links in creation order, VALUE-based, in PURCHASE units; the rest
 *      of a department's line stays owed (issuable from central, or on a later
 *      bill). A requisition line whose whole remaining balance was delivered
 *      direct is CLOSED by the system right after the receipt commits, with the
 *      store desk's own reject semantics (store_rejected = 1, what was already
 *      issued is kept) and the reason "Delivered direct to <dept> on <PO>
 *      (<GRN>)"; a void of that receipt re-opens it. Party lines are never
 *      closed here (a party reject zeroes quantity_issued and can fire the party
 *      transfer) — the issue routes refuse their covered part instead.
 *
 * NO-OP ON A DATABASE WITHOUT THE TABLES. Every reader checks sqlite_master
 * first: no link table means there are no links to keep, and no closures table
 * means no vendor is closed — both are TRUE statements, not fallbacks.
 * ══════════════════════════════════════════════════════════════════════════ */

type Db = Database.Database;

const LINKS = 'po_requisition_lines';
const CLOSURES = 'po_vendor_closures';

function hasTable(db: Db, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  } catch {
    return false;
  }
}

function columnsOf(db: Db, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => String(c.name)));
  } catch {
    return new Set();
  }
}

/** The vendor a PO line is filed under — BYTE-IDENTICAL to receive/route.ts
 *  lineVendorName (module-local there). Receive groups, owes and books by this
 *  name, so a closure must find the same lines receive would. */
export const lineVendorName = (it: { vendor?: unknown }, po: { vendor?: unknown }): string => {
  const own = it.vendor ? String(it.vendor).trim() : '';
  return own || String(po.vendor || '');
};
/** Case/space-insensitive vendor identity — receive/route.ts vendorKeyOf. */
export const vendorKeyOf = (name: unknown): string => String(name || '').trim().toLowerCase();

/* ───────────────────────────────────────────────────────────────────────────
 * 1. RE-KEYING LINKS ACROSS A LINE REWRITE
 * ─────────────────────────────────────────────────────────────────────────── */

export interface CapturedLinks {
  /** false when the link table does not exist — restore is then a no-op. */
  ready: boolean;
  /** Every link row on the PO, verbatim, in creation order, each with the
   *  material its PO line was for (`__material_id`, never written back). */
  rows: Array<Record<string, unknown>>;
}

/**
 * Read every link on the PO BEFORE its lines are deleted. Call inside the
 * caller's transaction, after its claim and before `DELETE FROM
 * purchase_order_items`. The material comes from the PO line the link points
 * at; the requisition line's own material is the fallback for a link whose PO
 * line is somehow gone (it can only be the same material — the merge route
 * builds one PO line per material from those very requisition lines).
 */
export function captureRequisitionLinks(db: Db, poId: string): CapturedLinks {
  if (!hasTable(db, LINKS)) return { ready: false, rows: [] };
  const rows = db.prepare(`
    SELECT l.*, COALESCE(NULLIF(TRIM(poi.material_id), ''), ri.material_id) AS __material_id
      FROM ${LINKS} l
      LEFT JOIN purchase_order_items poi ON poi.id = l.po_item_id
      LEFT JOIN requisition_items ri ON ri.id = l.req_item_id
     WHERE l.po_id = ?
     ORDER BY l.created_at, l.rowid
  `).all(poId) as Array<Record<string, unknown>>;
  return { ready: true, rows };
}

export interface RestoredLinks {
  kept: number;
  /** Links whose material is no longer on the PO — those requisition lines are
   *  free to be ordered again. Returned for the caller's audit trail. */
  dropped: Array<{ link_id: string; requisition_id: string; req_item_id: string; material_id: string; department_id: string; qty_purchase: number }>;
}

/**
 * Write the captured links back against the PO's NEW lines, by material. Call
 * inside the same transaction, AFTER the re-insert of purchase_order_items.
 *
 * Every column the link table has is carried over verbatim (id, created_at,
 * created_by, the flags, the quantities) — only po_item_id moves — so a column
 * another part of the build adds later is preserved too, rather than silently
 * reset by a hand-written column list.
 *
 * Whatever the DELETE's cascade did or did not remove, the PO's link set is
 * cleared first and replaced by exactly the captured set minus the dropped
 * materials: correct with foreign_keys ON (cascade already removed them) and
 * with it OFF (they would otherwise collide on the primary key).
 */
export function restoreRequisitionLinks(db: Db, poId: string, captured: CapturedLinks): RestoredLinks {
  const out: RestoredLinks = { kept: 0, dropped: [] };
  if (!captured.ready || captured.rows.length === 0) return out;

  const lineByMaterial = new Map<string, string>();
  for (const r of db.prepare(`SELECT id, material_id FROM purchase_order_items WHERE po_id = ?`).all(poId) as any[]) {
    const m = String(r.material_id ?? '').trim();
    // First line wins — unreachable in practice, duplicateLineError refuses a
    // repeated material on every path that rewrites lines.
    if (m && !lineByMaterial.has(m)) lineByMaterial.set(m, String(r.id));
  }

  const cols = [...columnsOf(db, LINKS)];
  db.prepare(`DELETE FROM ${LINKS} WHERE po_id = ?`).run(poId);
  if (cols.length === 0) return out;
  const ins = db.prepare(
    `INSERT INTO ${LINKS} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );

  for (const row of captured.rows) {
    const material = String(row.__material_id ?? '').trim();
    const newLine = material ? lineByMaterial.get(material) : undefined;
    if (!newLine) {
      out.dropped.push({
        link_id: String(row.id ?? ''),
        requisition_id: String(row.requisition_id ?? ''),
        req_item_id: String(row.req_item_id ?? ''),
        material_id: material,
        department_id: String(row.department_id ?? ''),
        qty_purchase: Number(row.qty_purchase) || 0,
      });
      continue;
    }
    ins.run(...cols.map(c => (c === 'po_item_id' ? newLine : (row[c] === undefined ? null : row[c]))));
    out.kept += 1;
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────────
 * 2. VENDOR CLOSURES
 * ─────────────────────────────────────────────────────────────────────────── */

export interface PoVendorClosure {
  id: string;
  po_id: string;
  vendor_id: string;
  /** The name the closed lines were filed under when the vendor was closed
   *  (what receive groups by), else the vendors master's name. */
  vendor_name: string;
  /** The vendors master's CURRENT name ('' when the row is gone). */
  master_name: string;
  reason: string;
  closed_by: string;
  closed_at: string;
}

/** The closures on one PO, oldest first. [] when the table does not exist. */
export function poVendorClosures(db: Db, poId: string): PoVendorClosure[] {
  if (!hasTable(db, CLOSURES)) return [];
  const rows = db.prepare(`
    SELECT c.id, c.po_id, COALESCE(c.vendor_id, '') AS vendor_id,
           COALESCE(NULLIF(TRIM(c.vendor_name), ''), v.name, '') AS vendor_name,
           COALESCE(v.name, '') AS master_name,
           COALESCE(c.reason, '') AS reason, COALESCE(c.closed_by, '') AS closed_by,
           COALESCE(c.closed_at, '') AS closed_at
      FROM ${CLOSURES} c
      LEFT JOIN vendors v ON v.id = c.vendor_id
     WHERE c.po_id = ?
     ORDER BY c.closed_at, c.rowid
  `).all(poId) as any[];
  return rows.map(r => ({
    id: String(r.id), po_id: String(r.po_id), vendor_id: String(r.vendor_id ?? ''),
    vendor_name: String(r.vendor_name ?? ''), master_name: String(r.master_name ?? ''),
    reason: String(r.reason ?? ''), closed_by: String(r.closed_by ?? ''), closed_at: String(r.closed_at ?? ''),
  }));
}

/** Does this PO line belong to this closed vendor? By id OR by a name receive
 *  files it under — the union, because receive groups by NAME while the
 *  closure also records the vendor ID, and a vendor renamed in the master after
 *  the PO was raised still matches by id (and by the name stored at close). */
export function lineIsClosure(
  line: { vendor?: unknown; vendor_id?: unknown },
  po: { vendor?: unknown },
  closure: Pick<PoVendorClosure, 'vendor_id' | 'vendor_name' | 'master_name'>,
): boolean {
  const lineId = String(line.vendor_id ?? '').trim();
  if (lineId && closure.vendor_id && lineId === closure.vendor_id) return true;
  const key = vendorKeyOf(lineVendorName(line, po));
  if (!key) return false;
  const named = vendorKeyOf(closure.vendor_name);
  const master = vendorKeyOf(closure.master_name);
  return (!!named && key === named) || (!!master && key === master);
}

/**
 * The PO lines a short-close took off the order: lines of a closed vendor that
 * NO LIVE receipt claims. Read under the caller's lock when it decides
 * anything with it. Empty when nothing is closed — the byte-identical path for
 * every PO that has never been short-closed.
 *
 * A live claim (a GRN held for QC included) means the goods came, so that line
 * is RECEIVED, not closed — and a short receipt of it stays a short receipt
 * (ruling 70: short-delivery balance as today).
 */
export function closedPoItemIds(db: Db, poId: string): Set<string> {
  const closures = poVendorClosures(db, poId);
  if (closures.length === 0) return new Set();
  const po = db.prepare(`SELECT vendor FROM purchase_orders WHERE id = ?`).get(poId) as any;
  if (!po) return new Set();
  const lines = db.prepare(`SELECT id, vendor, vendor_id FROM purchase_order_items WHERE po_id = ?`).all(poId) as any[];
  const claimed = receivedPoItemIds(db, poId);
  const out = new Set<string>();
  for (const l of lines) {
    const id = String(l.id);
    if (claimed.has(id)) continue;
    if (closures.some(c => lineIsClosure(l, po, c))) out.add(id);
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────────
 * 3. THE LINK FLAGS
 * ─────────────────────────────────────────────────────────────────────────── */

export interface LinkFlagSync {
  links: number;
  delivered_direct: number;
  vendor_closed: number;
  /** Rows whose stored flags this call actually changed. */
  changed: number;
  /** Requisition lines this sync closed by itself (section 4) / re-opened.
   *  PRESENT ONLY WHEN NON-ZERO, so every response that carries this object
   *  reads exactly as before on every PO where nothing was delivered direct. */
  direct_lines_closed?: number;
  direct_lines_reopened?: number;
}

/**
 * Direct-issued, value-counted ACCEPTED quantity per PO line (PURCHASE units —
 * the GRN line's unit, the same basis as link.qty_purchase). The PO line's
 * LIVE receipt (void and awaiting_qc excluded, liveValueSql) booked its goods
 * through Direct Issue: its purchases row carries direct_issue_dept_id, the
 * stamp postDirectReceipt writes in the same transaction as the department
 * ledger row. The marker column is added by a guarded migration; without it
 * nothing was ever routed direct, so the honest answer is "none".
 *   A held receipt counts nothing until it is signed (no stock has moved); a
 *   void counts nothing again (its purchases rows are gone, its status 'void').
 */
function directAcceptedByLine(db: Db, poId: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!columnsOf(db, 'purchases').has('direct_issue_dept_id')) return out;
  const rows = db.prepare(`
    SELECT gi.po_item_id AS po_item_id, COALESCE(SUM(gi.quantity_accepted), 0) AS acc
      FROM goods_receipt_note_items gi
      JOIN goods_receipt_notes g ON g.id = gi.grn_id
     WHERE g.po_id = ? AND ${liveValueSql('g')}
       AND gi.po_item_id IS NOT NULL AND TRIM(gi.po_item_id) != ''
       AND EXISTS (
         SELECT 1 FROM purchases p
          WHERE p.grn_id = g.id AND p.material_id = gi.material_id
            AND COALESCE(TRIM(p.direct_issue_dept_id), '') <> ''
       )
     GROUP BY gi.po_item_id
  `).all(poId) as any[];
  for (const r of rows) out.set(String(r.po_item_id), Number(r.acc) || 0);
  return out;
}

/** The flags alone — section 3 without section 4's requisition writes. */
function syncFlagsOnly(db: Db, poId: string): LinkFlagSync {
  const out: LinkFlagSync = { links: 0, delivered_direct: 0, vendor_closed: 0, changed: 0 };
  if (!poId || !hasTable(db, LINKS)) return out;
  const links = db.prepare(`
    SELECT id, po_item_id, qty_purchase,
           COALESCE(delivered_direct, 0) AS delivered_direct,
           COALESCE(vendor_closed, 0) AS vendor_closed
      FROM ${LINKS} WHERE po_id = ?
     ORDER BY created_at, rowid
  `).all(poId) as any[];
  out.links = links.length;
  if (links.length === 0) return out;

  const cover = poLinkDirectCover(db, poId);
  const closed = closedPoItemIds(db, poId);

  const upd = db.prepare(`UPDATE ${LINKS} SET delivered_direct = ?, vendor_closed = ? WHERE id = ?`);
  for (const l of links) {
    const lineId = String(l.po_item_id ?? '');
    const dd = cover.get(String(l.id))?.full ? 1 : 0;
    const vc = closed.has(lineId) ? 1 : 0;
    if (dd) out.delivered_direct += 1;
    if (vc) out.vendor_closed += 1;
    if (Number(l.delivered_direct) !== dd || Number(l.vendor_closed) !== vc) {
      upd.run(dd, vc, String(l.id));
      out.changed += 1;
    }
  }
  return out;
}

/**
 * RE-DERIVE delivered_direct and vendor_closed for every link on one PO, write
 * only the rows that differ, and then (section 4) close by itself every
 * requisition line on the PO whose whole remaining balance was delivered
 * direct — or re-open one the system closed whose delivery no longer stands
 * (a void). Call inside a transaction when the caller has one (po-void,
 * close-vendor); syncPoLinkFlagsAfterCommit otherwise.
 *
 * delivered_direct (rulings 68 + 73) — the PO line's direct-routed accepted
 * quantity (directAcceptedByLine) is walked across the line's links in
 * CREATION ORDER (created_at, rowid) — the same order the arrival badge uses —
 * and a link is delivered direct when that quantity covers its WHOLE share.
 * ONLY THE QUANTITY THAT LANDED DIRECT IS DELIVERED DIRECT (ruling 73): a
 * share the walk reaches only in part is NOT flagged — its covered quantity
 * is read through poLinkDirectCover / reqLineDirectState, the issue routes
 * refuse that covered part, and the rest of the department's line stays owed.
 * (Until 2026-10-23 ANY coverage flagged the link, which also refused the
 * uncovered rest — the "choice (b)" the owner overruled.)
 *
 * vendor_closed (ruling 69) — the link's PO line is in closedPoItemIds().
 */
export function syncPoLinkFlags(db: Db, poId: string): LinkFlagSync {
  const out = syncFlagsOnly(db, poId);
  if (out.links === 0) return out;
  const rec = reconcileDeliveredDirectLines(db, { poId }, { advanceRequisition: true });
  if (rec.closed.length > 0) out.direct_lines_closed = rec.closed.length;
  if (rec.reopened.length > 0) out.direct_lines_reopened = rec.reopened.length;
  return out;
}

/**
 * THE POST-COMMIT HOOK. Called by receive (after its transaction commits) and
 * by the kitchen QC decision (after its transaction commits) — the two places
 * a Direct Issue receipt becomes real. NEVER THROWS: the receipt it follows is
 * already committed and must not be reported as failed because a flag could
 * not be written. A failure is logged; the next sync on the same PO (another
 * receipt, a void, a close, a QC sign) re-derives and heals it.
 *
 * TWO TRANSACTIONS, not one: the flags, then the requisition closes. A fault
 * in closing a requisition line must not also cost the PO its flags.
 */
export function syncPoLinkFlagsAfterCommit(db: Db, poId: string | null | undefined, where: string): LinkFlagSync | null {
  if (!poId) return null;
  let out: LinkFlagSync | null = null;
  try {
    out = db.transaction(() => syncFlagsOnly(db, String(poId)))();
  } catch (e) {
    console.error(`[po-link-lifecycle] link flag sync failed after ${where} (non-fatal) for PO ${poId}:`, e);
  }
  if (out && out.links === 0) return out;
  try {
    const rec = db.transaction(() => reconcileDeliveredDirectLines(db, { poId: String(poId) }, { advanceRequisition: true }))();
    if (out && rec.closed.length > 0) out.direct_lines_closed = rec.closed.length;
    if (out && rec.reopened.length > 0) out.direct_lines_reopened = rec.reopened.length;
  } catch (e) {
    console.error(`[po-link-lifecycle] delivered-direct close failed after ${where} (non-fatal) for PO ${poId}:`, e);
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────────
 * 4. DELIVERED DIRECT BY QUANTITY, AND THE LINE THAT CLOSES BY ITSELF
 *    (rulings 68 + 73, 2026-10-23)
 * ─────────────────────────────────────────────────────────────────────────── */

/** The actor every close / re-open this section makes is recorded under
 *  (audit_events.actor_email; requisitions.fulfilled_by / store_processed_by
 *  when such a close is what completes a requisition). Never a person. */
export const DIRECT_CLOSE_ACTOR = 'system:delivered-direct';

/** Coverage tolerance in PURCHASE units — float dust from summing 3-dp shares. */
const COVER_EPS = 1e-6;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** Where the store still owes a requisition goods: the store desk's own window
 *  (store-issue okStatuses without the reversal-only 'fulfilled'). */
const STORE_STAGES = new Set(['chef_approved', 'mgmt_approved', 'store_processed']);
const SQL_CHUNK = 400;
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += SQL_CHUNK) out.push(list.slice(i, i + SQL_CHUNK));
  return out;
}

export interface LinkDirectCover {
  link_id: string;
  po_id: string;
  po_item_id: string;
  req_item_id: string;
  /** The link's share of its PO line, PURCHASE units. */
  share: number;
  /** PURCHASE units of that share the PO line's direct-routed accepted
   *  quantity reaches, handed out in creation order. 0 when none. */
  covered: number;
  /** covered reaches the whole share. */
  full: boolean;
}

/**
 * THE WALK, per link, for one PO: the direct-routed accepted quantity of each
 * PO line handed to its links in creation order (created_at, rowid) — the
 * first department to ask is the first covered, exactly as the arrival badge
 * and the flags read it. Empty for a PO with no links.
 */
export function poLinkDirectCover(db: Db, poId: string): Map<string, LinkDirectCover> {
  const out = new Map<string, LinkDirectCover>();
  if (!poId || !hasTable(db, LINKS)) return out;
  const links = db.prepare(`
    SELECT id, po_item_id, req_item_id, qty_purchase
      FROM ${LINKS} WHERE po_id = ?
     ORDER BY created_at, rowid
  `).all(poId) as any[];
  if (links.length === 0) return out;
  const direct = directAcceptedByLine(db, poId);
  const walked = new Map<string, number>();
  for (const l of links) {
    const lineId = String(l.po_item_id ?? '');
    const share = Math.max(0, Number(l.qty_purchase) || 0);
    const before = walked.get(lineId) || 0;
    walked.set(lineId, before + share);
    const got = direct.get(lineId) || 0;
    const raw = r6(Math.max(0, Math.min(share, got - before)));
    const covered = raw > COVER_EPS ? raw : 0;
    out.set(String(l.id), {
      link_id: String(l.id), po_id: poId, po_item_id: lineId, req_item_id: String(l.req_item_id ?? ''),
      share, covered, full: share > COVER_EPS && covered + COVER_EPS >= share,
    });
  }
  return out;
}

/** The columns directLineVerdict (and lineIssueComplete) read off a line:
 *  requisition_items' quantities + unit, the material's pack meta. */
export interface DirectLineRow {
  quantity_requested: number | null;
  chef_approved_qty: number | null;
  quantity_issued: number | null;
  line_unit: string | null;
  unit: string | null;
  purchase_unit: string | null;
  pack_size: number | null;
  shelf_emptied_qty?: number | null;
}

export interface DirectLineVerdict {
  /** PURCHASE units of this line delivered direct (0 = none). */
  covered_purchase: number;
  /** The same in the LINE's own unit; null when the line's unit cannot be read. */
  covered_line: number | null;
  approved_line: number;
  issued_line: number;
  /** The line's WHOLE remaining balance (approved − issued) was delivered
   *  direct, so nothing more of it may be issued from central — "fully
   *  delivered direct" (ruling 73). False whenever nothing was. */
  full: boolean;
  /** The most quantity_issued may reach while the delivered-direct part stays
   *  unissued (LINE units). = issued_line when full or unreadable. */
  max_issued_line: number;
  /** max_issued_line − issued_line, never below 0 (LINE units / PURCHASE). */
  max_add_line: number;
  max_add_purchase: number;
  unit_unresolved: boolean;
}

/**
 * WHAT A DIRECT DELIVERY LEAVES A REQUISITION LINE OWING. The covered quantity
 * (PURCHASE units) converts to the line's unit through THE line rule
 * (issue-stock.ts lineFactor) and the pack (packFactor); the line still owes
 * central approved − issued − covered, and is FULL when what it owes, as the
 * desks print it (shownPurchaseQty), is no more than what was delivered direct.
 *
 * A line whose unit cannot be read (blank on a packed material — the merge
 * refuses those, so this is a guard, not a path) never takes anything more
 * from central once anything was delivered direct, and is full only when its
 * whole linked share was covered. Never a guessed conversion.
 */
export function directLineVerdict(line: DirectLineRow, coveredPurchase: number, sharePurchase: number): DirectLineVerdict {
  const meta = { unit: line.unit, purchase_unit: line.purchase_unit, pack_size: line.pack_size };
  const pf = packFactor(meta);
  const { factor, needsReview } = lineFactor(line.line_unit, meta);
  const approved = (line.chef_approved_qty != null ? Number(line.chef_approved_qty) : Number(line.quantity_requested)) || 0;
  const issued = Number(line.quantity_issued) || 0;
  const covered = coveredPurchase > COVER_EPS ? r6(coveredPurchase) : 0;
  if (needsReview) {
    const full = covered > 0 && covered + COVER_EPS >= sharePurchase;
    const maxAdd = covered > 0 ? 0 : r6(Math.max(0, approved - issued));
    return {
      covered_purchase: covered, covered_line: null, approved_line: approved, issued_line: issued,
      full, max_issued_line: r6(issued + maxAdd), max_add_line: maxAdd, max_add_purchase: maxAdd, unit_unresolved: true,
    };
  }
  const coveredLine = r6((covered * pf) / factor);
  const owedPurchase = shownPurchaseQty(Math.max(0, approved - issued) * factor, meta);
  const full = covered > 0 && owedPurchase <= covered + COVER_EPS;
  const maxAdd = full ? 0 : r6(Math.max(0, approved - coveredLine - issued));
  return {
    covered_purchase: covered, covered_line: coveredLine, approved_line: approved, issued_line: issued,
    full, max_issued_line: r6(issued + maxAdd), max_add_line: maxAdd,
    max_add_purchase: shownPurchaseQty(maxAdd * factor, meta), unit_unresolved: false,
  };
}

export interface ReqLineDirectState {
  req_item_id: string;
  requisition_id: string;
  req_number: string;
  req_status: string;
  is_party: boolean;
  material_name: string;
  is_rejected: boolean;
  store_rejected: boolean;
  store_reject_reason: string;
  /** store_rejected AND the latest reject/unreject record of the line is this
   *  file's close (DIRECT_CLOSE_ACTOR) — the system closed it, not a person.
   *  False on every open line. */
  closed_by_system: boolean;
  line: DirectLineRow;
  /** Σ shares of the line's live merge links, PURCHASE units. */
  share_purchase: number;
  /** Σ of what those links' direct deliveries cover, PURCHASE units. */
  covered_purchase: number;
  /** link id → covered (PURCHASE units), for every live merge link of the line. */
  link_cover: Map<string, number>;
  /** The POs, bills and departments the covered goods came on / went to —
   *  only those that actually cover this line, oldest first. */
  po_numbers: string[];
  grn_numbers: string[];
  grn_ids: string[];
  dept_names: string[];
  verdict: DirectLineVerdict;
  /** "to <dept> on <PO> (<GRN>)" — '' when nothing was delivered direct. */
  where: string;
}

/**
 * THE ONE READER of "how much of this requisition line was delivered direct,
 * and what does that leave it owing" — for every line that sits on a live
 * merged PO (a po_requisition_lines row on a PO that is not cancelled). Lines
 * with no such link are absent: nothing was delivered direct for them, and
 * every caller treats absent as exactly that. The badge reader
 * (po-helpers.ts requisitionLinePoState), both issue routes' guards and the
 * close below all read it, so the refusal, the badge and the close can never
 * disagree.
 */
export function reqLineDirectState(db: Db, reqItemIds: readonly string[]): Map<string, ReqLineDirectState> {
  const out = new Map<string, ReqLineDirectState>();
  const ids = [...new Set(reqItemIds.map(x => String(x || '').trim()).filter(Boolean))];
  if (ids.length === 0 || !hasTable(db, LINKS)) return out;

  type L = { link_id: string; po_id: string; po_item_id: string; req_item_id: string; qty_purchase: number; po_number: string };
  const links: L[] = [];
  for (const part of chunks(ids)) {
    links.push(...(db.prepare(`
      SELECT prl.id AS link_id, prl.po_id, prl.po_item_id, prl.req_item_id, prl.qty_purchase,
             COALESCE(po.po_number, '') AS po_number
        FROM ${LINKS} prl
        JOIN purchase_orders po ON po.id = prl.po_id
       WHERE prl.req_item_id IN (${part.map(() => '?').join(',')})
         AND COALESCE(po.status, '') <> 'cancelled'
       ORDER BY prl.created_at, prl.rowid
    `).all(...part) as L[]));
  }
  if (links.length === 0) return out;

  const coverByPo = new Map<string, Map<string, LinkDirectCover>>();
  for (const poId of new Set(links.map(l => String(l.po_id)))) coverByPo.set(poId, poLinkDirectCover(db, poId));
  const coverOf = (l: L) => coverByPo.get(String(l.po_id))?.get(String(l.link_id))?.covered || 0;

  // Where the covered goods went, and the bill they came on — the purchases
  // rows postDirectReceipt stamped, under a live value-counted receipt.
  const coveredItems = [...new Set(links.filter(l => coverOf(l) > 0).map(l => String(l.po_item_id)))];
  const whereByItem = new Map<string, { grns: Array<{ id: string; number: string }>; depts: string[] }>();
  if (coveredItems.length > 0 && columnsOf(db, 'purchases').has('direct_issue_dept_id')) {
    for (const part of chunks(coveredItems)) {
      const rows = db.prepare(`
        SELECT gi.po_item_id AS po_item_id, g.id AS grn_id, COALESCE(g.grn_number, '') AS grn_number,
               COALESCE(NULLIF(TRIM(d.name), ''), p.direct_issue_dept_id) AS dept_name
          FROM goods_receipt_note_items gi
          JOIN goods_receipt_notes g ON g.id = gi.grn_id
          JOIN purchases p ON p.grn_id = g.id AND p.material_id = gi.material_id
                          AND COALESCE(TRIM(p.direct_issue_dept_id), '') <> ''
          LEFT JOIN departments d ON d.id = p.direct_issue_dept_id
         WHERE gi.po_item_id IN (${part.map(() => '?').join(',')})
           AND ${liveValueSql('g')}
         ORDER BY g.date, g.created_at, g.rowid
      `).all(...part) as Array<{ po_item_id: string; grn_id: string; grn_number: string; dept_name: string | null }>;
      for (const r of rows) {
        const key = String(r.po_item_id);
        const w = whereByItem.get(key) || { grns: [], depts: [] };
        if (!w.grns.some(g => g.id === String(r.grn_id))) w.grns.push({ id: String(r.grn_id), number: String(r.grn_number || '') });
        const dn = String(r.dept_name || '').trim();
        if (dn && !w.depts.includes(dn)) w.depts.push(dn);
        whereByItem.set(key, w);
      }
    }
  }

  const hasShelf = columnsOf(db, 'requisition_items').has('shelf_emptied_qty');
  type Row = {
    id: string; req_id: string; quantity_requested: number | null; chef_approved_qty: number | null;
    quantity_issued: number | null; line_unit: string | null; is_rejected: number | null; store_rejected: number | null;
    store_reject_reason: string | null; shelf_emptied_qty: number | null;
    unit: string | null; purchase_unit: string | null; pack_size: number | null; material_name: string | null;
    req_number: string | null; req_status: string | null; purpose: string | null;
  };
  const rows: Row[] = [];
  const lineIds = [...new Set(links.map(l => String(l.req_item_id)))];
  for (const part of chunks(lineIds)) {
    rows.push(...(db.prepare(`
      SELECT ri.id, ri.req_id, ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued,
             ri.unit AS line_unit, COALESCE(ri.is_rejected, 0) AS is_rejected,
             COALESCE(ri.store_rejected, 0) AS store_rejected, COALESCE(ri.store_reject_reason, '') AS store_reject_reason,
             ${hasShelf ? 'ri.shelf_emptied_qty' : 'NULL'} AS shelf_emptied_qty,
             rm.unit, rm.purchase_unit, rm.pack_size, COALESCE(rm.name, '') AS material_name,
             r.req_number, r.status AS req_status, COALESCE(NULLIF(TRIM(r.purpose), ''), 'internal') AS purpose
        FROM requisition_items ri
        JOIN requisitions r ON r.id = ri.req_id
        LEFT JOIN raw_materials rm ON rm.id = ri.material_id
       WHERE ri.id IN (${part.map(() => '?').join(',')})
    `).all(...part) as Row[]));
  }

  // Who closed a store-closed line: the latest reject/unreject record.
  const hasAudit = hasTable(db, 'audit_events');
  const lastCloser = hasAudit ? db.prepare(`
    SELECT event_type, actor_email FROM audit_events
     WHERE entity_type = 'requisition_item' AND entity_id = ?
       AND event_type IN ('req_item.store_reject', 'req_item.store_unreject')
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `) : null;

  const linksOf = new Map<string, L[]>();
  for (const l of links) {
    const arr = linksOf.get(String(l.req_item_id)) || [];
    arr.push(l);
    linksOf.set(String(l.req_item_id), arr);
  }
  for (const row of rows) {
    const mine = linksOf.get(String(row.id)) || [];
    const linkCover = new Map<string, number>();
    let share = 0;
    let covered = 0;
    const poNumbers: string[] = [];
    const grnNumbers: string[] = [];
    const grnIds: string[] = [];
    const depts: string[] = [];
    for (const l of mine) {
      const c = coverOf(l);
      linkCover.set(String(l.link_id), c);
      share += Math.max(0, Number(l.qty_purchase) || 0);
      covered += c;
      if (c <= 0) continue;
      if (l.po_number && !poNumbers.includes(l.po_number)) poNumbers.push(l.po_number);
      const w = whereByItem.get(String(l.po_item_id));
      for (const g of w?.grns || []) {
        if (!grnIds.includes(g.id)) { grnIds.push(g.id); if (g.number) grnNumbers.push(g.number); }
      }
      for (const d of w?.depts || []) if (!depts.includes(d)) depts.push(d);
    }
    const line: DirectLineRow = {
      quantity_requested: row.quantity_requested, chef_approved_qty: row.chef_approved_qty,
      quantity_issued: row.quantity_issued, line_unit: row.line_unit,
      unit: row.unit, purchase_unit: row.purchase_unit, pack_size: row.pack_size,
      shelf_emptied_qty: row.shelf_emptied_qty,
    };
    const coveredP = r6(covered);
    const verdict = directLineVerdict(line, coveredP, r6(share));
    const where = coveredP > COVER_EPS
      ? `to ${depts.length > 0 ? depts.join(', ') : 'a department'}`
        + `${poNumbers.length > 0 ? ` on ${poNumbers.join(', ')}` : ''}`
        + `${grnNumbers.length > 0 ? ` (${grnNumbers.join(', ')})` : ''}`
      : '';
    out.set(String(row.id), {
      req_item_id: String(row.id), requisition_id: String(row.req_id),
      req_number: String(row.req_number || ''), req_status: String(row.req_status || ''),
      is_party: String(row.purpose) === 'party', material_name: String(row.material_name || ''),
      is_rejected: Number(row.is_rejected) === 1, store_rejected: Number(row.store_rejected) === 1,
      store_reject_reason: String(row.store_reject_reason || ''),
      closed_by_system: Number(row.store_rejected) === 1 && !!lastCloser && (() => {
        const e = lastCloser.get(String(row.id)) as { event_type: string; actor_email: string } | undefined;
        return !!e && e.event_type === 'req_item.store_reject' && e.actor_email === DIRECT_CLOSE_ACTOR;
      })(),
      line, share_purchase: r6(share), covered_purchase: coveredP, link_cover: linkCover,
      po_numbers: poNumbers, grn_numbers: grnNumbers, grn_ids: grnIds, dept_names: depts,
      verdict, where,
    });
  }
  return out;
}

export interface DirectReconcile {
  closed: Array<{ req_item_id: string; requisition_id: string; req_number: string; material: string; reason: string; kept_issued: number }>;
  reopened: Array<{ req_item_id: string; requisition_id: string; req_number: string; material: string }>;
  /** Requisitions a close completed (advanceRequisition only). */
  requisitions_fulfilled: string[];
  /** Requisitions a re-open took back out of 'fulfilled' (advanceRequisition only). */
  requisitions_reopened: string[];
}

/**
 * THE LINE THAT CLOSES BY ITSELF (ruling 73: "a FULLY delivered-direct line
 * CLOSES BY ITSELF"; ruling 68: "close that line"). INSIDE THE CALLER'S
 * TRANSACTION. For every requisition line in scope:
 *
 *   CLOSE — an internal line, not rejected by the chef or the store, at a
 *   store stage, not already complete by THE RULE (lineIssueComplete), whose
 *   whole remaining balance was delivered direct (directLineVerdict.full).
 *   The STORE DESK'S OWN REJECT, statement for statement (store-issue
 *   updReject / updRejectKeep): store_rejected = 1 with the reason
 *   "Delivered direct to <dept> on <PO> (<GRN>)", the defer pair cleared, and
 *   what was already issued KEPT — a line that issued nothing writes exactly
 *   the row a store reject of it writes. quantity_issued never changes, so no
 *   stock moves and applyIssueDelta has nothing to mirror. THE RULE
 *   (central-debit-clamp.ts / desk-rule.ts) is NOT touched: a store_rejected
 *   line already counts as done in every completion test, so the requisition
 *   completes when its other lines do. One audit row per line,
 *   'req_item.store_reject' by DIRECT_CLOSE_ACTOR, written in this same
 *   transaction (so the close and its record commit together, and the re-open
 *   below can always find what the system closed).
 *
 *   PARTY LINES ARE NEVER CLOSED HERE. A party reject zeroes quantity_issued
 *   (store-issue keeps the old zeroing on the party rail) and a reject that
 *   completes a party requisition fires the party transfer — neither may run
 *   behind the store's back. The issue routes refuse a party line's covered
 *   part instead; the store closes it with Reject.
 *
 *   NOT AGAIN AFTER A PERSON RE-OPENED IT. A line the system closed and a
 *   person then un-rejected is left open while the same bills still cover it
 *   (a new bill — a re-received one after a void — closes it again).
 *
 *   RE-OPEN — a line whose latest reject/unreject record is this close, and
 *   which the direct deliveries no longer fully cover (the GRN was voided):
 *   store_rejected = 0, reason cleared (the store desk's unreject, which moves
 *   no stock), audit 'req_item.store_unreject' by DIRECT_CLOSE_ACTOR. A line a
 *   PERSON rejected is never re-opened here.
 *
 * advanceRequisition (the receipt / QC / void / close-vendor path — no store
 * gesture is running): a requisition every line of which is now done becomes
 * 'fulfilled' with the store desk's own fulfilment UPDATE (its store-processed
 * stamps left alone — the store did not process it); a requisition a re-open makes
 * owing again leaves 'fulfilled' — back to exactly what it was when the system
 * completed it if nothing has re-fulfilled it since, else to 'store_processed'
 * with the fulfilment stamp cleared (the store desk's demotion). The issue
 * routes pass false: their own auto-advance decides, after their own takes.
 */
export function reconcileDeliveredDirectLines(
  db: Db,
  scope: { poId?: string | null; reqItemIds?: readonly string[] | null },
  opts: { advanceRequisition: boolean },
): DirectReconcile {
  const out: DirectReconcile = { closed: [], reopened: [], requisitions_fulfilled: [], requisitions_reopened: [] };
  if (!hasTable(db, LINKS) || !hasTable(db, 'audit_events')) return out;
  let ids: string[] = [];
  if (scope.poId) {
    ids = (db.prepare(`SELECT DISTINCT req_item_id FROM ${LINKS} WHERE po_id = ?`).all(String(scope.poId)) as any[])
      .map(r => String(r.req_item_id));
  }
  if (scope.reqItemIds) ids.push(...scope.reqItemIds.map(x => String(x || '')));
  ids = [...new Set(ids.map(x => x.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const states = reqLineDirectState(db, ids);
  if (states.size === 0) return out;

  const lastEvent = db.prepare(`
    SELECT event_type, actor_email, after_json FROM audit_events
     WHERE entity_type = 'requisition_item' AND entity_id = ?
       AND event_type IN ('req_item.store_reject', 'req_item.store_unreject')
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `);
  const lastSystemClose = db.prepare(`
    SELECT after_json FROM audit_events
     WHERE entity_type = 'requisition_item' AND entity_id = ?
       AND event_type = 'req_item.store_reject' AND actor_email = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `);
  const insAudit = db.prepare(`
    INSERT INTO audit_events
      (id, event_type, entity_type, entity_id, actor_email, outlet_id, before_json, after_json, note, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'))
  `);
  // store-issue's updReject (nothing handed over) and updRejectKeep (something
  // was), verbatim, plus a WHERE that refuses to act on a row that changed
  // under us — the zeroing form can then never zero a real quantity.
  const updReject = db.prepare(`
    UPDATE requisition_items
    SET store_rejected = 1, store_reject_reason = ?,
        quantity_issued = 0, issued_at = NULL, issued_by = NULL,
        deferred_until = NULL, defer_reason = '',
        issue_history = '[]'
    WHERE id = ? AND COALESCE(store_rejected, 0) = 0 AND COALESCE(quantity_issued, 0) = 0
  `);
  const updRejectKeep = db.prepare(`
    UPDATE requisition_items
    SET store_rejected = 1, store_reject_reason = ?,
        deferred_until = NULL, defer_reason = ''
    WHERE id = ? AND COALESCE(store_rejected, 0) = 0
  `);
  const updUnreject = db.prepare(`
    UPDATE requisition_items
    SET store_rejected = 0, store_reject_reason = ''
    WHERE id = ? AND COALESCE(store_rejected, 0) = 1
  `);
  const selDefer = db.prepare(`SELECT deferred_until, COALESCE(defer_reason, '') AS defer_reason FROM requisition_items WHERE id = ?`);
  const parse = (s: unknown): any => { try { return JSON.parse(String(s || '')) || {}; } catch { return {}; } };
  const sameSet = (a: unknown, b: string[]) => {
    const x = Array.isArray(a) ? a.map(String) : [];
    return x.length === b.length && [...x].sort().join('|') === [...b].sort().join('|');
  };

  const closedReqs = new Set<string>();
  const reopenedReqs = new Set<string>();
  for (const st of states.values()) {
    const last = lastEvent.get(st.req_item_id) as { event_type: string; actor_email: string; after_json: string | null } | undefined;
    const lastIsSystemClose = !!last && last.event_type === 'req_item.store_reject' && last.actor_email === DIRECT_CLOSE_ACTOR;

    if (st.store_rejected) {
      // ── RE-OPEN: only what THIS close made, only when no longer covered ──
      if (!lastIsSystemClose || st.verdict.full) continue;
      const was = parse(last!.after_json);
      if (updUnreject.run(st.req_item_id).changes !== 1) continue;
      const bills: string[] = Array.isArray(was.grn_numbers) ? was.grn_numbers.map(String) : [];
      insAudit.run(
        randomUUID(), 'req_item.store_unreject', 'requisition_item', st.req_item_id, DIRECT_CLOSE_ACTOR,
        JSON.stringify({ store_rejected: 1, store_reject_reason: st.store_reject_reason }),
        JSON.stringify({
          store_rejected: 0, store_reject_reason: '', reopened_by: 'delivered_direct',
          delivered_direct_purchase: st.covered_purchase, closed_on_grn_numbers: bills,
        }),
        `${st.material_name}: re-opened by itself — the Direct Issue delivery it was closed on`
          + `${bills.length > 0 ? ` (${bills.join(', ')})` : ''} no longer covers it, so the line is owed again`,
      );
      out.reopened.push({ req_item_id: st.req_item_id, requisition_id: st.requisition_id, req_number: st.req_number, material: st.material_name });
      reopenedReqs.add(st.requisition_id);
      continue;
    }

    // ── CLOSE ──
    if (st.is_party || st.is_rejected || !st.verdict.full) continue;
    if (!STORE_STAGES.has(st.req_status)) continue;
    if (lineIssueComplete(st.line)) continue;
    if (last && last.event_type === 'req_item.store_unreject' && last.actor_email !== DIRECT_CLOSE_ACTOR) {
      const sys = lastSystemClose.get(st.req_item_id, DIRECT_CLOSE_ACTOR) as { after_json: string | null } | undefined;
      if (sys && sameSet(parse(sys.after_json).grn_ids, st.grn_ids)) continue;
    }
    const reason = `Delivered direct ${st.where}`;
    const issued = Number(st.line.quantity_issued) || 0;
    const keep = issued > 0;
    const before = selDefer.get(st.req_item_id) as { deferred_until: string | null; defer_reason: string } | undefined;
    const res = (keep ? updRejectKeep : updReject).run(reason, st.req_item_id);
    if (res.changes !== 1) continue;
    insAudit.run(
      randomUUID(), 'req_item.store_reject', 'requisition_item', st.req_item_id, DIRECT_CLOSE_ACTOR,
      JSON.stringify({
        quantity_issued: issued, deferred_until: before?.deferred_until ?? null, defer_reason: before?.defer_reason ?? '',
        store_rejected: 0, store_reject_reason: st.store_reject_reason,
      }),
      JSON.stringify({
        store_rejected: 1, store_reject_reason: reason, quantity_issued: keep ? issued : 0,
        closed_by: 'delivered_direct', delivered_direct_purchase: st.covered_purchase,
        po_numbers: st.po_numbers, grn_numbers: st.grn_numbers, grn_ids: st.grn_ids, departments: st.dept_names,
      }),
      `${st.material_name}: closed by itself — ${reason}; the delivered-direct part is not issued from central`
        + `${keep ? ` (what was already issued, ${issued} ${String(st.line.line_unit || '').trim() || 'as recorded'}, stays issued)` : ''}`,
    );
    out.closed.push({
      req_item_id: st.req_item_id, requisition_id: st.requisition_id, req_number: st.req_number,
      material: st.material_name, reason, kept_issued: keep ? issued : 0,
    });
    closedReqs.add(st.requisition_id);
  }

  if (!opts.advanceRequisition || (closedReqs.size === 0 && reopenedReqs.size === 0)) return out;

  const hasShelf = columnsOf(db, 'requisition_items').has('shelf_emptied_qty');
  const selLines = db.prepare(`
    SELECT ri.is_rejected, ri.store_rejected, ri.quantity_requested, ri.chef_approved_qty,
           ri.quantity_issued, ri.deferred_until, ${hasShelf ? 'ri.shelf_emptied_qty' : 'NULL'} AS shelf_emptied_qty,
           ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      LEFT JOIN raw_materials rm ON rm.id = ri.material_id
     WHERE ri.req_id = ?
  `);
  // store-issue's own "is every line done" — either rejection is done, a
  // deferred line never is, otherwise THE RULE.
  const everyLineDone = (reqId: string) => (selLines.all(reqId) as any[]).every(it => {
    if (it.is_rejected) return true;
    if (it.store_rejected) return true;
    return lineIssueComplete(it) && !it.deferred_until;
  });
  const selReq = db.prepare(`
    SELECT id, req_number, status, COALESCE(NULLIF(TRIM(purpose), ''), 'internal') AS purpose,
           fulfilled_at, fulfilled_by, store_processed_at, store_processed_by
      FROM requisitions WHERE id = ?
  `);
  const stampOf = (r: any) => ({
    status: r?.status ?? null, fulfilled_at: r?.fulfilled_at ?? null, fulfilled_by: r?.fulfilled_by ?? null,
    store_processed_at: r?.store_processed_at ?? null, store_processed_by: r?.store_processed_by ?? null,
  });

  for (const reqId of closedReqs) {
    const r = selReq.get(reqId) as any;
    if (!r || r.purpose === 'party' || !STORE_STAGES.has(String(r.status))) continue;
    if (!everyLineDone(reqId)) continue;
    // store-issue's fulfilment UPDATE MINUS THE STORE'S OWN STAMPS: no store
    // gesture ran, so store_processed_at/by (which /requisitions prints as
    // "Store processed: <when> by <who>") are left exactly as they are, and no
    // store note is written. fulfilled_by names the system (an empty default
    // counts as unset), so the record says who completed it.
    const res = db.prepare(`
      UPDATE requisitions
      SET status = 'fulfilled',
          fulfilled_at = COALESCE(fulfilled_at, datetime('now')),
          fulfilled_by = COALESCE(NULLIF(fulfilled_by, ''), ?),
          updated_at = datetime('now')
      WHERE id = ? AND status = ?
    `).run(DIRECT_CLOSE_ACTOR, reqId, String(r.status));
    if (res.changes !== 1) continue;
    const now = selReq.get(reqId) as any;
    const n = out.closed.filter(c => c.requisition_id === reqId).length;
    insAudit.run(
      randomUUID(), 'requisition.delivered_direct_fulfil', 'requisition', reqId, DIRECT_CLOSE_ACTOR,
      JSON.stringify(stampOf(r)), JSON.stringify(stampOf(now)),
      `${r.req_number}: fulfilled — every line is done; the last open ${n === 1 ? 'line was' : 'lines were'} `
        + `delivered direct and closed without a store issue`,
    );
    out.requisitions_fulfilled.push(reqId);
  }

  const lastFulfil = db.prepare(`
    SELECT before_json, after_json FROM audit_events
     WHERE entity_type = 'requisition' AND entity_id = ? AND event_type = 'requisition.delivered_direct_fulfil'
       AND actor_email = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `);
  for (const reqId of reopenedReqs) {
    const r = selReq.get(reqId) as any;
    if (!r || String(r.status) !== 'fulfilled') continue;
    if (everyLineDone(reqId)) continue;
    const sys = lastFulfil.get(reqId, DIRECT_CLOSE_ACTOR) as { before_json: string | null; after_json: string | null } | undefined;
    const a = sys ? parse(sys.after_json) : null;
    const b = sys ? parse(sys.before_json) : null;
    const ownFulfilment = !!a && !!b && a.status === 'fulfilled' && a.fulfilled_at != null
      && String(a.fulfilled_at) === String(r.fulfilled_at ?? '') && STORE_STAGES.has(String(b.status));
    let res;
    if (ownFulfilment) {
      // Nobody has re-fulfilled it since the system did: put back exactly the
      // stage and stamps it had (a requisition the management desk had not yet
      // processed goes back to that desk).
      res = db.prepare(`
        UPDATE requisitions
        SET status = ?, fulfilled_at = ?, fulfilled_by = ?,
            store_processed_at = ?, store_processed_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'fulfilled'
      `).run(String(b.status), b.fulfilled_at ?? null, b.fulfilled_by ?? null,
        b.store_processed_at ?? null, b.store_processed_by ?? null, reqId);
    } else {
      // store-issue's demotion, verbatim.
      res = db.prepare(`
        UPDATE requisitions
        SET status = 'store_processed',
            fulfilled_at = NULL,
            fulfilled_by = NULL,
            store_processed_at = COALESCE(store_processed_at, datetime('now')),
            store_processed_by = COALESCE(store_processed_by, ?),
            updated_at = datetime('now')
        WHERE id = ? AND status = 'fulfilled'
      `).run(DIRECT_CLOSE_ACTOR, reqId);
    }
    if (res.changes !== 1) continue;
    const now = selReq.get(reqId) as any;
    insAudit.run(
      randomUUID(), 'requisition.delivered_direct_reopen', 'requisition', reqId, DIRECT_CLOSE_ACTOR,
      JSON.stringify(stampOf(r)), JSON.stringify(stampOf(now)),
      `${r.req_number}: no longer fulfilled — a line closed as delivered direct is owed again (its Direct Issue delivery no longer stands)`,
    );
    out.requisitions_reopened.push(reqId);
  }
  return out;
}
