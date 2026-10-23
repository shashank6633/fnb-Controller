// TYPE-ONLY db import, like vendor-mapping.ts and po-receipts.ts: this module is
// handed the caller's handle and never opens (or migrates) the database itself.
import type { getDb } from '@/lib/db';
import { vendorResolver } from '@/lib/vendor-mapping';
import { liveValueSql } from '@/lib/po-receipts';

/* ══════════════════════════════════════════════════════════════════════════
 * A VENDOR'S PURCHASE ORDERS, COUNTED FROM THE LINES — NOT THE HEADER.
 *
 * /vendors shows, per vendor, "POs" and "Lifetime ₹". Until the merged PO those
 * came from purchase_orders.vendor_id alone, and that column is a SUMMARY of the
 * lines, not the truth:
 *
 *   - a PO whose lines span several vendors has vendor_id NULL and the header
 *     "Mixed (N vendors)" (vendor-mapping.ts headerVendorFromLines), so it was
 *     credited to NO vendor — every supplier on a merged PO lost the PO and all
 *     of its spend;
 *   - a header that was never re-derived after an edit (edit-approved does not
 *     re-derive it) names one vendor over lines that belong to others, so that
 *     one vendor was credited with the others' money.
 *
 * WHAT THIS FILE DOES. It finds the "split" purchase orders — the ones whose
 * LINES resolve to vendor master rows other than exactly {the header's
 * vendor_id} — and works out each line vendor's own share of each of them. The
 * vendors route keeps today's header query for every OTHER purchase order, so a
 * PO whose lines are all its header's vendor (every single-vendor PO there has
 * ever been) contributes exactly what it contributed before, byte for byte.
 *
 * WHICH VENDOR A LINE BELONGS TO is the vendor the receive route files it
 * under: the line's own vendor, or the header's when the line names none
 * (receive/route.ts groups by COALESCE(line vendor, header vendor)). Resolved by
 * the same strict resolver the PO writers store with (vendorResolver: id first,
 * then name), so a vendor spelled two ways is one vendor and a line naming a
 * vendor the master does not know is credited to nobody — as it was before.
 *
 * A VENDOR'S SHARE OF ONE SPLIT PO, mirroring what the header query means for a
 * whole single-vendor PO:
 *
 *   PO count   — 1 for every vendor with a line on it (any status, as today).
 *   Spend      — only while the PO is 'approved' or 'received' (as today), and
 *                the same switch the header figure makes, made per VENDOR:
 *                  · not finished with this PO → what was ORDERED from it
 *                    (Σ its lines' total_price — the figure recalcTotal sums
 *                    into an approved PO's total_cost);
 *                  · finished → what it actually DELIVERED: Σ accepted × rate −
 *                    discount over its live receipts, the exact sum
 *                    receive/route.ts stamps into total_cost when a PO
 *                    completes (VALUE predicate: void and held-for-QC bills
 *                    carry no money).
 *                "Finished" = every line of the vendor is claimed by a receipt
 *                that is neither void nor still held for a quality check, OR
 *                the vendor was short-closed on this PO (po_vendor_closures,
 *                when that table exists). A held bill therefore keeps the
 *                ORDER on the books until the kitchen signs — never a
 *                transient Rs 0 for goods nobody has decided on yet.
 *   Last received — the PO date (today's column is MAX(po.date) over received
 *                POs) when the PO is 'received' AND this vendor delivered on
 *                it (a live receipt of its own). A vendor that was closed and
 *                never delivered did not "receive" on this PO.
 * ══════════════════════════════════════════════════════════════════════════ */

type Db = ReturnType<typeof getDb>;

export interface VendorPoShare {
  po_count: number;
  lifetime_spend: number;
  /** MAX(po.date) of received split POs this vendor delivered on; null if none. */
  last_received: string | null;
}

export interface SplitPoVendorStats {
  /** POs whose credit is decided here; the header query must EXCLUDE them. */
  splitPoIds: string[];
  /** vendor master id → that vendor's summed share of the split POs. */
  byVendor: Map<string, VendorPoShare>;
}

const SPEND_STATUSES = new Set(['approved', 'received']);
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const s = (v: unknown) => String(v ?? '').trim();

function tableExists(db: Db, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  } catch { return false; }
}

export function splitPoVendorStats(db: Db): SplitPoVendorStats {
  const resolve = vendorResolver(db);
  const memo = new Map<string, string | null>();
  /** vendor master id for a {vendor, vendor_id} ref, or null when unknown/empty. */
  const idOf = (vendor: unknown, vendorId: unknown): string | null => {
    const key = `${s(vendorId)}\u0000${s(vendor).toLowerCase()}`;
    if (memo.has(key)) return memo.get(key)!;
    const v = resolve({ vendor: s(vendor), vendor_id: s(vendorId) || null });
    const id = v.status === 'known' ? v.id : null;
    memo.set(key, id);
    return id;
  };

  const lines = db.prepare(`
    SELECT po.id AS po_id, COALESCE(po.status, '') AS status, po.date AS date,
           COALESCE(po.vendor, '') AS h_vendor, COALESCE(po.vendor_id, '') AS h_vendor_id,
           poi.id AS poi_id, COALESCE(poi.vendor, '') AS vendor, COALESCE(poi.vendor_id, '') AS vendor_id,
           COALESCE(poi.total_price, poi.quantity * poi.unit_price, 0) AS ordered
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.po_id
  `).all() as any[];

  type Po = { status: string; date: string; header: string; lineVendor: Map<string, string | null>; ordered: Map<string, number> };
  const pos = new Map<string, Po>();
  for (const ln of lines) {
    let po = pos.get(ln.po_id);
    if (!po) {
      po = { status: s(ln.status), date: s(ln.date), header: s(ln.h_vendor_id), lineVendor: new Map(), ordered: new Map() };
      pos.set(ln.po_id, po);
    }
    // The vendor receive files this line under: its own, else the header's.
    const blank = !s(ln.vendor) && !s(ln.vendor_id);
    const vid = blank ? idOf(ln.h_vendor, ln.h_vendor_id) : idOf(ln.vendor, ln.vendor_id);
    po.lineVendor.set(String(ln.poi_id), vid);
    if (vid) po.ordered.set(vid, (po.ordered.get(vid) || 0) + (Number(ln.ordered) || 0));
  }

  const split = new Map<string, Po>();
  for (const [poId, po] of pos) {
    const ids = [...po.ordered.keys()];
    if (ids.length === 0) continue;                                   // no known line vendor: header rules, as today
    if (ids.length === 1 && ids[0] === po.header) continue;           // a single-vendor PO: header rules, as today
    split.set(poId, po);
  }
  const byVendor = new Map<string, VendorPoShare>();
  if (split.size === 0) return { splitPoIds: [], byVendor };

  const splitIds = [...split.keys()];
  const idsJson = JSON.stringify(splitIds);

  // Receipt lines of those POs. Every non-void receipt line is listed with its
  // status, so "finished" (claimed by a non-held, non-void receipt) and the
  // money (VALUE predicate) are read off one result.
  const receipts = db.prepare(`
    SELECT g.id AS grn_id, g.po_id AS po_id, COALESCE(g.status, '') AS status,
           COALESCE(g.vendor, '') AS g_vendor, COALESCE(g.vendor_id, '') AS g_vendor_id,
           COALESCE(gi.po_item_id, '') AS po_item_id,
           CASE WHEN ${liveValueSql('g')} THEN 1 ELSE 0 END AS counts_value,
           ROUND(gi.quantity_accepted * gi.unit_price, 2) - COALESCE(gi.discount, 0) AS net
    FROM goods_receipt_note_items gi
    JOIN goods_receipt_notes g ON g.id = gi.grn_id
    WHERE g.po_id IN (SELECT value FROM json_each(?))
      AND COALESCE(g.status, '') <> 'void'
  `).all(idsJson) as any[];

  const closed = new Set<string>();
  if (tableExists(db, 'po_vendor_closures')) {
    try {
      const rows = db.prepare(`
        SELECT po_id, vendor_id FROM po_vendor_closures
        WHERE po_id IN (SELECT value FROM json_each(?))
      `).all(idsJson) as any[];
      for (const r of rows) {
        const vid = idOf('', r.vendor_id) || s(r.vendor_id);
        if (vid) closed.add(`${r.po_id}\u0000${vid}`);
      }
    } catch { /* a closure table this code cannot read closes nothing */ }
  }

  for (const [poId, po] of split) {
    const value = new Map<string, number>();
    const delivered = new Set<string>();
    const settledLines = new Set<string>();   // claimed by a live, non-held receipt
    for (const r of receipts) {
      if (r.po_id !== poId) continue;
      const lineVid = r.po_item_id ? po.lineVendor.get(String(r.po_item_id)) : undefined;
      const vid = lineVid || idOf(r.g_vendor, r.g_vendor_id);
      if (Number(r.counts_value) === 1) {
        if (r.po_item_id) settledLines.add(String(r.po_item_id));
        if (vid) {
          value.set(vid, (value.get(vid) || 0) + (Number(r.net) || 0));
          delivered.add(vid);
        }
      }
    }
    for (const vid of po.ordered.keys()) {
      const share = byVendor.get(vid) || { po_count: 0, lifetime_spend: 0, last_received: null };
      share.po_count += 1;
      if (SPEND_STATUSES.has(po.status)) {
        const isClosed = closed.has(`${poId}\u0000${vid}`);
        let finished = isClosed;
        if (!finished) {
          finished = true;
          for (const [poiId, lv] of po.lineVendor) {
            if (lv === vid && !settledLines.has(poiId)) { finished = false; break; }
          }
        }
        share.lifetime_spend += finished ? (value.get(vid) || 0) : (po.ordered.get(vid) || 0);
      }
      if (po.status === 'received' && delivered.has(vid) && po.date) {
        if (!share.last_received || po.date > share.last_received) share.last_received = po.date;
      }
      byVendor.set(vid, share);
    }
  }
  for (const v of byVendor.values()) v.lifetime_spend = r2(v.lifetime_spend);
  return { splitPoIds: splitIds, byVendor };
}
