import type Database from 'better-sqlite3';
import { receivedPoItemIds, liveValueSql } from './po-receipts';

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
 * NO-OP ON A DATABASE WITHOUT THE TABLES. Every reader checks sqlite_master
 * first: no link table means there are no links to keep, and no closures table
 * means no vendor is closed — both are TRUE statements, not fallbacks.
 * ══════════════════════════════════════════════════════════════════════════ */

type Db = Database.Database;

const LINKS = 'po_requisition_lines';
const CLOSURES = 'po_vendor_closures';
/** Float noise only — a purchase quantity a person typed is far bigger. */
const QTY_EPS = 1e-6;

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
}

/**
 * RE-DERIVE delivered_direct and vendor_closed for every link on one PO, and
 * write only the rows that differ. Call inside a transaction when the caller
 * has one (po-void, close-vendor); syncPoLinkFlagsAfterCommit otherwise.
 *
 * delivered_direct (ruling 68) — the PO line's LIVE, VALUE-counted receipt
 * (void and awaiting_qc excluded, liveValueSql) booked goods through Direct
 * Issue: its purchases row carries direct_issue_dept_id, the stamp
 * postDirectReceipt writes in the same transaction as the department ledger
 * row. The accepted quantity (PURCHASE units, the GRN line's unit, same as
 * link.qty_purchase) is walked across the line's links in CREATION ORDER
 * (created_at, rowid) — the same order the arrival badge uses — and a link is
 * delivered direct when ANY of that quantity reaches it. ANY, not ALL, on
 * purpose: the goods for that link went to the rule's department, so issuing
 * the link again from central is the double count ruling 68 forbids; a short
 * remainder is a vendor short, exactly as on a central receipt.
 *   A held receipt sets nothing until it is signed (no stock has moved); a void
 *   clears it again (its purchases rows are gone and its status is 'void').
 *
 * vendor_closed (ruling 69) — the link's PO line is in closedPoItemIds().
 */
export function syncPoLinkFlags(db: Db, poId: string): LinkFlagSync {
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

  // Direct-issued, value-counted accepted quantity per PO line. The marker
  // column is added by a guarded migration; without it nothing was ever routed
  // direct, so the honest answer is "none".
  const directByLine = new Map<string, number>();
  if (columnsOf(db, 'purchases').has('direct_issue_dept_id')) {
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
    for (const r of rows) directByLine.set(String(r.po_item_id), Number(r.acc) || 0);
  }
  const closed = closedPoItemIds(db, poId);

  const upd = db.prepare(`UPDATE ${LINKS} SET delivered_direct = ?, vendor_closed = ? WHERE id = ?`);
  const walked = new Map<string, number>();
  for (const l of links) {
    const lineId = String(l.po_item_id ?? '');
    const before = walked.get(lineId) || 0;
    walked.set(lineId, before + (Number(l.qty_purchase) || 0));
    const direct = directByLine.get(lineId) || 0;
    const dd = direct > QTY_EPS && before < direct - QTY_EPS ? 1 : 0;
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
 * THE POST-COMMIT HOOK. Called by receive (after its transaction commits) and
 * by the kitchen QC decision (after its transaction commits) — the two places
 * a Direct Issue receipt becomes real. NEVER THROWS: the receipt it follows is
 * already committed and must not be reported as failed because a flag could
 * not be written. A failure is logged; the next sync on the same PO (another
 * receipt, a void, a close, a QC sign) re-derives and heals it.
 */
export function syncPoLinkFlagsAfterCommit(db: Db, poId: string | null | undefined, where: string): LinkFlagSync | null {
  if (!poId) return null;
  try {
    return db.transaction(() => syncPoLinkFlags(db, String(poId)))();
  } catch (e) {
    console.error(`[po-link-lifecycle] link flag sync failed after ${where} (non-fatal) for PO ${poId}:`, e);
    return null;
  }
}
