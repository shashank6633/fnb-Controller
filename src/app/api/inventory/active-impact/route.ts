import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { shownPurchaseQty } from '@/lib/pack-units';
import { lineFactor, lineIssueComplete } from '@/lib/issue-stock';
import { receivedPoItemIds } from '@/lib/po-receipts';
import { closedPoItemIds } from '@/lib/po-link-lifecycle';
import { deliveredDirectCaps } from '@/lib/po-helpers';
import { stockOnHandBulk, type StockOnHand } from '@/lib/dept-stock';

/**
 * WHAT SWITCHING A RAW MATERIAL OFF WOULD LEAVE BEHIND — the warning the Raw
 * Materials page shows BEFORE an admin switches an item off (owner #6 /
 * ruling 78: "warn with its current stock and its open requisition lines /
 * open PO lines"; WHO may switch = ADMIN ONLY, owner 2026-10-28).
 *
 * READ-ONLY. Nothing in this file writes. It does not switch anything; the
 * switch itself is PUT /api/inventory { id, is_active } or
 * POST /api/inventory/bulk-update { field: 'is_active', ... } — both admin-only
 * for that field.
 *
 *   GET  /api/inventory/active-impact?ids=<id>,<id>     (comma list; ids= may repeat)
 *   POST /api/inventory/active-impact  { ids: string[] } (same answer — for a big Bulk
 *        edit selection: a GET URL is capped by the server's header limit,
 *        ~16 KB ≈ 450 ids)
 *
 *   401 no session · 403 not an admin · 400 no ids / more than MAX_IDS
 *
 * 200 — THE CONTRACT (the screens lane renders exactly these names).
 * Core, fixed by the track brief:
 *   { items: [{ id, name, is_active, current_stock, purchase_unit,
 *               stock_purchase_units, open_requisition_lines, open_po_lines }] }
 * Every other field below is ADDITIVE — a reader may ignore it.
 * {
 *   items: [{                               // one per FOUND id, in the order asked
 *     id: string,
 *     name: string,
 *     is_active: 0 | 1,                     // raw_materials.is_active as stored (NULL reads 1)
 *     current_stock: number,                // CENTRAL store holding, RECIPE units
 *                                           //   (raw_materials.current_stock — the same figure
 *                                           //   the Raw Materials "Stock" column shows)
 *     unit: string,                         // recipe unit (additive)
 *     purchase_unit: string,                // purchase unit; falls back to the recipe unit
 *     stock_purchase_units: number,         // current_stock in PURCHASE units, 3 dp — LEAD with this
 *     open_requisition_lines: [{            // requisition lines the central store still owes
 *       req_item_id: string, requisition_id: string, req_number: string,
 *       status: string,                     // draft | submitted | chef_approved | mgmt_approved | store_processed
 *       purpose: string,                    // internal | party
 *       date: string, department: string,
 *       qty_open_purchase_units: number | null, // still owed, PURCHASE units — LEAD with this;
 *                                           //   null when the line's unit cannot be resolved
 *                                           //   (never a guess — the Raw Materials warning then
 *                                           //   prints no amount, only "unit needs review")
 *       qty_open: number,                   // the same in the LINE's own unit (line_unit)
 *       line_unit: string,                  // requisition_items.unit ('' on a legacy line)
 *       delivered_direct_purchase: number,  // additive: PURCHASE units of this line a merged PO
 *                                           //   delivered DIRECT (rulings 68/73) — already NOT
 *                                           //   counted in qty_open; 0 on almost every line
 *     }],
 *     open_po_lines: [{                     // PO lines not yet received / short-closed
 *       po_item_id: string, po_id: string, po_number: string,
 *       status: string,                     // draft | pending | pending_reapproval | approved
 *       date: string, vendor: string,
 *       quantity: number,                   // PURCHASE units (purchase_order_items.quantity)
 *       purchase_unit: string,
 *     }],
 *     open_requisition_count: number,       // TRUE totals (additive); the two arrays above are
 *     open_po_count: number,                //   capped at LINE_CAP rows each
 *     stock_elsewhere: [{                   // additive: stock held OUTSIDE central, each leg its
 *       kind: 'store' | 'department',       //   own labelled pool — NEVER add these to
 *       id: string, name: string,           //   current_stock (the owner's no-double-count law).
 *       qty: number,                        //   Only non-zero legs. RECIPE units here,
 *       stock_purchase_units: number,       //   PURCHASE units here.
 *     }] | null,                            // null = could not be read (unknown, NOT "none")
 *   }],
 *   not_found: string[],                    // ids that are not raw materials (incl. 'sub:' rows)
 * }
 *
 * WHAT "OPEN" MEANS — taken from the rules already in force, not re-invented:
 *   · requisition line: its requisition is still live (draft, submitted,
 *     chef_approved, mgmt_approved, store_processed — the store-queue statuses
 *     po-helpers.ts evaluateRequisitionLines owes, plus the two a department is
 *     still raising), the line is rejected neither by the chef nor by the store,
 *     and it is NOT complete by lineIssueComplete (issue-stock.ts — THE "this
 *     line is done" predicate every desk uses). A line some of which a merged
 *     PO delivered DIRECT (rulings 68/73) owes central only the rest —
 *     deliveredDirectCaps (po-helpers.ts), the same reader both issue routes
 *     refuse by — so qty_open is that rest, and a line whose whole remaining
 *     balance came direct owes central nothing and is not listed.
 *   · PO line: its PO is draft / pending / pending_reapproval / approved (the
 *     set /api/vendor-materials DELETE already calls "open"), and no LIVE
 *     receipt claims it (receivedPoItemIds) and its vendor was not short-closed
 *     on that PO (closedPoItemIds) — so a multi-vendor PO that stays 'approved'
 *     after one vendor delivered does not report the delivered lines.
 *
 * Purely informational: switching off never touches these documents. Open
 * documents keep their lines (the pickers filter search results only, never a
 * line's current value), the stock figure is untouched, reports keep showing
 * the item, and the count lists keep it while the place they count still
 * holds a non-zero balance of it (src/lib/count-list-active.ts).
 */
export const dynamic = 'force-dynamic';

/** Same cap as bulk-update, so "warn for the whole Bulk edit selection" always fits. */
const MAX_IDS = 2000;
/** Rows listed per material per kind; the *_count fields carry the true total. */
const LINE_CAP = 50;

const OPEN_REQ_STATUSES = ['draft', 'submitted', 'chef_approved', 'mgmt_approved', 'store_processed'] as const;
const OPEN_PO_STATUSES = ['draft', 'pending', 'pending_reapproval', 'approved'] as const;

const r3 = (n: number) => { const v = Math.round((Number(n) || 0) * 1000) / 1000; return v === 0 ? 0 : v; };

function parseIdsFromQuery(url: URL): string[] {
  const out: string[] = [];
  for (const v of url.searchParams.getAll('ids')) out.push(...String(v).split(','));
  return out;
}

/** Admin only — the same people who may flip the switch. null = allowed. */
async function gate(): Promise<Response | null> {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (me.role !== 'admin') {
    return Response.json({ error: 'Only an admin can switch raw materials on or off' }, { status: 403 });
  }
  return null;
}

function handle(rawIds: unknown[]): Response {
  const ids: string[] = [...new Set(rawIds.map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) {
    return Response.json({ error: 'ids is required — e.g. ?ids=<material id>,<material id>' }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return Response.json({
      error: `Too many items: ${ids.length}. At most ${MAX_IDS} per call.`,
      cap: MAX_IDS, received: ids.length,
    }, { status: 400 });
  }

  const db = getDb();
  const idsJson = JSON.stringify(ids);

  /* ── the materials ─────────────────────────────────────────────────────── */
  const mats = db.prepare(`
    SELECT id, name, COALESCE(is_active, 1) AS is_active,
           current_stock, unit, purchase_unit, pack_size, case_size
      FROM raw_materials
     WHERE id IN (SELECT value FROM json_each(?))
  `).all(idsJson) as any[];
  const byId = new Map<string, any>(mats.map((m) => [String(m.id), m]));
  const found = ids.filter((id) => byId.has(id));
  const notFound = ids.filter((id) => !byId.has(id));

  /* ── open requisition lines ────────────────────────────────────────────── */
  const reqPh = OPEN_REQ_STATUSES.map(() => '?').join(',');
  const reqRows = found.length === 0 ? [] : db.prepare(`
    SELECT ri.id AS req_item_id, ri.req_id AS requisition_id, ri.material_id,
           r.req_number, r.status, COALESCE(r.purpose, 'internal') AS purpose, r.date,
           COALESCE(d.name, '') AS department,
           ri.quantity_requested, ri.chef_approved_qty, ri.quantity_issued,
           ri.shelf_emptied_qty, COALESCE(ri.unit, '') AS line_unit,
           rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      JOIN requisitions r    ON r.id  = ri.req_id
      JOIN raw_materials rm  ON rm.id = ri.material_id
      LEFT JOIN departments d ON d.id = COALESCE(ri.department_id, r.department_id)
     WHERE ri.material_id IN (SELECT value FROM json_each(?))
       AND r.status IN (${reqPh})
       AND COALESCE(ri.is_rejected, 0) = 0
       AND COALESCE(ri.store_rejected, 0) = 0
     ORDER BY r.date, r.req_number, ri.created_at, ri.rowid
  `).all(idsJson, ...OPEN_REQ_STATUSES) as any[];

  const openReqRows = reqRows.filter((l) => !lineIssueComplete(l));
  // Delivered-direct position of each still-open line (rulings 68/73). Empty
  // for every line no merged PO delivered direct — i.e. every line today.
  const caps = deliveredDirectCaps(db, openReqRows.map((l) => String(l.req_item_id)));

  const reqByMat = new Map<string, any[]>();
  for (const l of openReqRows) {
    const approved = l.chef_approved_qty != null ? Number(l.chef_approved_qty) : Number(l.quantity_requested);
    let open = Math.max(0, (Number(approved) || 0) - (Number(l.quantity_issued) || 0));
    const cap = caps.get(String(l.req_item_id));
    if (cap) {
      // Only the part central may still issue is owed by central.
      if (cap.full) continue;
      open = Math.max(0, Math.min(open, Number(cap.max_add_line) || 0));
      if (!(open > 1e-9)) continue;
    }
    const meta = { unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_size };
    const lf = lineFactor(l.line_unit, meta);
    const list = reqByMat.get(String(l.material_id)) || [];
    list.push({
      req_item_id: String(l.req_item_id),
      requisition_id: String(l.requisition_id),
      req_number: String(l.req_number || ''),
      status: String(l.status || ''),
      purpose: String(l.purpose || 'internal'),
      date: String(l.date || ''),
      department: String(l.department || ''),
      // line units → recipe (lineFactor, THE line rule) → purchase units. A line
      // whose unit cannot be resolved gets null — printing a converted figure
      // for it would be a guess.
      qty_open_purchase_units: lf.needsReview ? null : shownPurchaseQty(open * lf.factor, meta),
      qty_open: r3(open),
      line_unit: String(l.line_unit || ''),
      delivered_direct_purchase: cap ? r3(Number(cap.covered_purchase) || 0) : 0,
    });
    reqByMat.set(String(l.material_id), list);
  }

  /* ── open PO lines ─────────────────────────────────────────────────────── */
  const poPh = OPEN_PO_STATUSES.map(() => '?').join(',');
  const poRows = found.length === 0 ? [] : db.prepare(`
    SELECT poi.id AS po_item_id, poi.po_id, poi.material_id, poi.quantity,
           COALESCE(NULLIF(TRIM(poi.vendor), ''), NULLIF(TRIM(po.vendor), ''), '') AS vendor,
           po.po_number, po.status, po.date,
           COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit, '') AS purchase_unit
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      JOIN raw_materials rm   ON rm.id = poi.material_id
     WHERE poi.material_id IN (SELECT value FROM json_each(?))
       AND po.status IN (${poPh})
     ORDER BY po.date, po.po_number, poi.rowid
  `).all(idsJson, ...OPEN_PO_STATUSES) as any[];

  // Per PO, once: which of its lines a live receipt already claims, and which a
  // vendor short-close took off the order. Only an 'approved' PO can have
  // either (a draft/pending PO has no receipt and cannot be short-closed), so
  // the helpers run on those alone.
  const settled = new Map<string, Set<string>>();
  for (const poId of new Set(poRows.filter((r) => r.status === 'approved').map((r) => String(r.po_id)))) {
    const s = new Set<string>(receivedPoItemIds(db, poId));
    for (const x of closedPoItemIds(db, poId)) s.add(x);
    settled.set(poId, s);
  }
  const poByMat = new Map<string, any[]>();
  for (const l of poRows) {
    if (settled.get(String(l.po_id))?.has(String(l.po_item_id))) continue;
    const list = poByMat.get(String(l.material_id)) || [];
    list.push({
      po_item_id: String(l.po_item_id),
      po_id: String(l.po_id),
      po_number: String(l.po_number || ''),
      status: String(l.status || ''),
      date: String(l.date || ''),
      vendor: String(l.vendor || ''),
      quantity: r3(Number(l.quantity) || 0),
      purchase_unit: String(l.purchase_unit || ''),
    });
    poByMat.set(String(l.material_id), list);
  }

  /* ── stock held outside central (labelled legs, never summed) ──────────── */
  let soh: Map<string, StockOnHand> | null = null;
  try {
    soh = found.length === 0 ? new Map() : stockOnHandBulk(db, found);
  } catch (e: any) {
    // The store rail could not be read. Unknown is reported as null — never as
    // "no stock elsewhere", which would be a confident wrong statement.
    console.warn('[/api/inventory/active-impact] stock-on-hand unavailable:', e?.message);
    soh = null;
  }

  const items = found.map((id) => {
    const m = byId.get(id);
    const meta = { unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size };
    const purchaseUnit = String(m.purchase_unit || '').trim() || String(m.unit || '').trim();
    const reqs = reqByMat.get(id) || [];
    const pos = poByMat.get(id) || [];
    let elsewhere: any[] | null = null;
    if (soh) {
      const s = soh.get(id);
      if (s) {
        elsewhere = [
          ...s.stores.map((l) => ({ kind: 'store' as const, ...l })),
          ...s.depts.map((l) => ({ kind: 'department' as const, ...l })),
        ]
          .filter((l) => Number(l.qty) !== 0)
          .map((l) => ({
            kind: l.kind, id: String(l.id ?? ''), name: String(l.name || ''),
            qty: Number(l.qty), stock_purchase_units: shownPurchaseQty(Number(l.qty), meta),
          }));
      }
      // A material stockOnHandBulk left out has a non-finite central figure —
      // unknown, so null rather than [].
    }
    return {
      id,
      name: String(m.name || ''),
      is_active: Number(m.is_active) === 0 ? 0 : 1,
      current_stock: Number(m.current_stock) || 0,
      unit: String(m.unit || ''),
      purchase_unit: purchaseUnit,
      stock_purchase_units: shownPurchaseQty(Number(m.current_stock) || 0, meta),
      open_requisition_lines: reqs.slice(0, LINE_CAP),
      open_po_lines: pos.slice(0, LINE_CAP),
      open_requisition_count: reqs.length,
      open_po_count: pos.length,
      stock_elsewhere: elsewhere,
    };
  });

  return Response.json({ items, not_found: notFound });
}

export async function GET(request: Request) {
  try {
    const denied = await gate();
    if (denied) return denied;
    return handle(parseIdsFromQuery(new URL(request.url)));
  } catch (e: any) {
    console.error('[/api/inventory/active-impact GET]', e);
    return Response.json({ error: e?.message || 'Could not read the impact' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const denied = await gate();
    if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body?.ids)) {
      return Response.json({ error: 'ids must be an array of material ids' }, { status: 400 });
    }
    return handle(body.ids as unknown[]);
  } catch (e: any) {
    console.error('[/api/inventory/active-impact POST]', e);
    return Response.json({ error: e?.message || 'Could not read the impact' }, { status: 500 });
  }
}
