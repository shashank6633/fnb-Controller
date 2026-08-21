import type { Database } from 'better-sqlite3';
import { todayIST } from '@/lib/format-date';
import { packFactor, type PackMeta } from '@/lib/pack-units';
import { lineFactor } from '@/lib/issue-stock';
import { centralFlowBlock } from '@/lib/store-engine';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ RETURNS — THE PURE DOMAIN LAYER (owner spreadsheet rows 72-79)           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Vocabularies, the RET-YYYY-NNNN generator, the requirement-75 PO return
 * window, the requirement-72 GRN-line lookup, and the unit/eligibility guards
 * every returns route has to agree on. NOTHING HERE WRITES. No auth, no stock,
 * no ledger row, no settings write — one file the whole module can read from
 * without wondering whether reading it moved something.
 *
 * ── TWO THINGS EVERY READER OF THIS MODULE MUST KNOW ───────────────────────
 *
 * 1. STOCK MOVES ONLY ON STORE ACCEPT. Raising a return moves nothing.
 *    Department-Head approval moves nothing. A rejected return — rejected by
 *    the HOD or rejected per line by the store — leaves every gram exactly
 *    where it already was. The single moment any balance changes is inside the
 *    store-verify transaction in src/lib/return-stock.ts, and it is one atomic
 *    commit guarded by a single-shot status claim so a replay cannot move the
 *    same kilogram twice. That is the module's whole promise: a returned
 *    kilogram leaves the department exactly once and re-enters the store
 *    exactly once. Do not add a stock write to a route earlier in the chain,
 *    however convenient it looks — an "optimistic" credit at approval time is
 *    a second rail, and a second rail is how a gram gets counted twice.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK. They are not two flavours of one movement:
 *
 *      INTERNAL (req 77)  department -> central store. Goods stay in the
 *                         building. Department stock DOWN, central stock UP.
 *                         This is the shape requirement 76 describes when it
 *                         says accepted returns are "added back to Store stock".
 *      VENDOR   (req 72)  central store -> out of the building, back to the
 *                         supplier. Central stock DOWN. There is NO department
 *                         leg at all, and central must NOT be credited — the
 *                         goods have physically left. The money is a credit
 *                         note, recorded only on the ticket header.
 *
 *    material_returns.kind carries that fork, is set at creation and is never
 *    updated by any route. Reading requirement 76's words literally onto a
 *    vendor return would credit central for goods that are on the vendor's
 *    lorry, i.e. invent inventory. Anything in this file that behaves
 *    differently per kind says which kind it means, in the name or on the line.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────────────
 * It does not re-derive the pack rule (resolveLineUnits delegates to
 * lineFactor / packFactor), it does not re-derive store ownership
 * (canReturnMaterial delegates to centralFlowBlock), and it never reads
 * raw_materials.last_purchase_price, which is stored in MIXED bases on live
 * data and may not be valued. Rates come off the GRN line the goods actually
 * arrived on.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE VOCABULARIES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * THE FORK (see the header). Immutable on a ticket: set at creation, never
 * updated, CHECK-constrained in the schema, and dispatched to two separately
 * named movers so no single code path can take the wrong branch on a bad flag.
 */
export const RETURN_KINDS = ['internal', 'vendor'] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

/**
 * The approval chain, in order. Mirrors the SHAPE of the requisition lifecycle
 * — same per-stage (at, by, note) triplets, same one-route-per-verb layout —
 * but it is its own vocabulary in its own tables on purpose. Reusing the
 * requisition statuses would entangle the two lifecycles and put return tickets
 * in front of store-issue's status gates.
 *
 *   draft        raised by the department, not yet visible to anyone else
 *   submitted    awaiting the Department Head / Manager   (req 73)
 *   hod_approved approved, now at the store counter       (req 74)
 *                THIS IS ALSO THE HOLDING STATE. The goods are physically at
 *                the counter and no stock has moved. Requirement 76's implied
 *                "inspect before it is sellable" is this status plus the Store
 *                Verify step — which is exactly why there is no second stock
 *                bucket for "Returned Stock".
 *   verified     the store accepted and/or rejected each line. TERMINAL.
 *                THE ONLY STATUS WHOSE TRANSITION MOVES STOCK.
 *   hod_rejected rejected by the HOD, with a mandatory reason. Nothing moved.
 *   cancelled    withdrawn before approval. Nothing moved.
 */
export const RETURN_STATUSES = [
  'draft',
  'submitted',
  'hod_approved',
  'verified',
  'hod_rejected',
  'cancelled',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Statuses a ticket can never leave. Nothing may re-open one. */
export const RETURN_TERMINAL_STATUSES: readonly ReturnStatus[] = ['verified', 'hod_rejected', 'cancelled'];

/**
 * Requirement 78, and it is a DISPOSITION CODE, not a second ledger.
 *
 * 'disposal' is not a distinct economic event anywhere in this codebase:
 * kitchen-production/[id]/dispose already defines wasted and disposed as
 * siblings and its own dashboard and reports SUM THEM TOGETHER under "Waste &
 * Disposal". So it rides on the return LINE and steers the movement, rather
 * than opening a parallel write-off table.
 *
 *   reusable   goes back into the pool. INTERNAL: department down, central up.
 *   wastage    unusable. INTERNAL: department DOWN ONLY, posted on the
 *   disposal   canonical 'wastage' dept-ledger type — the same rail
 *              /api/wastage's own department branch posts on. NO central
 *              credit, ever: unusable goods must never re-enter the sellable
 *              pool, so they never become "Returned Stock" at all.
 */
export const RETURN_DISPOSITIONS = ['reusable', 'wastage', 'disposal'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

/** True when this disposition writes the goods off instead of restocking them. */
export function isWriteOffDisposition(d: unknown): boolean {
  return d === 'wastage' || d === 'disposal';
}

export function isReturnKind(v: unknown): v is ReturnKind {
  return typeof v === 'string' && (RETURN_KINDS as readonly string[]).includes(v);
}
export function isReturnStatus(v: unknown): v is ReturnStatus {
  return typeof v === 'string' && (RETURN_STATUSES as readonly string[]).includes(v);
}
export function isReturnDisposition(v: unknown): v is ReturnDisposition {
  return typeof v === 'string' && (RETURN_DISPOSITIONS as readonly string[]).includes(v);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE TICKET NUMBER
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * RET-YYYY-NNNN, the same shape and the same derivation as nextReqNumber in
 * /api/requisitions (REQ-YYYY-NNNN) and the GRN generator in the receive route
 * (GRN-YYYY-NNNN): read the highest number for the year and add one.
 *
 * Zero-padding to 4 is what makes ORDER BY ret_number DESC agree with numeric
 * order, so the padding is load-bearing, not decoration. Call this INSIDE the
 * same transaction as the INSERT — read-then-insert across a transaction
 * boundary is how two tickets get the same number, and ret_number is UNIQUE, so
 * the loser is a 500 rather than a duplicate. (The uniqueness constraint is the
 * real guard; this function only has to be right under that.)
 */
export function nextReturnNumber(db: Database, isoDate: string): string {
  const year = String(isoDate || todayIST()).slice(0, 4);
  const lastRow = db.prepare(`
    SELECT ret_number FROM material_returns
    WHERE ret_number LIKE 'RET-' || ? || '-%'
    ORDER BY ret_number DESC LIMIT 1
  `).get(year) as { ret_number?: string } | undefined;
  const last = lastRow?.ret_number ? parseInt(lastRow.ret_number.split('-').pop() || '0', 10) : 0;
  return `RET-${year}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. REQUIREMENT 75 — THE PO RETURN WINDOW
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * "Add a setting to keep the PO open for returns for a configurable number of
 * days, or close it automatically."
 *
 * THIS IS A READ-TIME REFUSAL AND NOTHING ELSE. It writes no status, runs on no
 * schedule, and has no boot migration behind it. Three measured reasons:
 *
 *  - Today "open" means exactly purchase_orders.status = 'approved'. There is
 *    no closed status and no closed_at column. Adding one would break the
 *    receive route's `status !== 'approved'` refusal and its in-transaction
 *    atomic claim — i.e. it would make live POs unreceivable.
 *  - Nothing in scheduler/cron touches purchase_orders, so an auto-close would
 *    be a brand-new unattended writer over real approved POs.
 *  - An unattended job that retroactively shuts POs on deploy is precisely the
 *    silent change to committed behaviour the owner has forbidden.
 *
 * DEFAULT 0 = NO LIMIT, and 0 is what an absent key reads as. The key is NOT
 * seeded, so on every existing database this preserves today's behaviour
 * exactly: POs are open for returns forever until an admin says otherwise.
 *
 * Shape copied from getBackdateLimitDays in src/lib/purchase-guard.ts —
 * parseInt over the settings KV, floored at 0, try/catch to a safe default —
 * so the two windows cannot drift into two different parsing habits.
 */
export const PO_RETURN_WINDOW_KEY = 'po_return_window_days';

/** Configured window in days. 0 (and any absent / unparseable value) = no limit. */
export function getPoReturnWindowDays(db: Database): number {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(PO_RETURN_WINDOW_KEY) as
      | { value?: string }
      | undefined;
    const n = parseInt(String(r?.value ?? '0'), 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  } catch {
    // A settings read that throws must not silently CLOSE the window on every
    // PO — the safe direction here is today's behaviour, which is no limit.
    return 0;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Subtract `days` from a YYYY-MM-DD string. UTC math on a date-only value, as purchase-guard does. */
function subtractDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export type ReturnWindowCheck = { ok: true } | { ok: false; error: string };

/**
 * Is this GRN still inside the configured return window?
 *
 * MEASURED FROM goods_receipt_notes.date — NOT purchase_orders.received_at.
 * received_at stays NULL while a multi-vendor PO is only part-delivered, so a
 * window measured from it would stay open indefinitely and then slam shut the
 * moment the last vendor finally delivers. The GRN date is when these
 * particular goods actually arrived, which is the date the window is about.
 *
 * "Today" is todayIST(), never UTC, so the day boundary matches the rest of the
 * app; same-format YYYY-MM-DD strings compare correctly lexicographically. The
 * cutoff is INCLUSIVE, matching checkPurchaseDate: with a 7-day window, a GRN
 * dated exactly 7 days ago still passes and 8 days ago does not.
 *
 * Call this at ticket CREATION only. Re-checking it at approve or accept time
 * would let a ticket that was legitimately raised inside the window die in the
 * queue because the approver went home for the weekend.
 */
export function checkReturnWindow(db: Database, grnDate: unknown): ReturnWindowCheck {
  const days = getPoReturnWindowDays(db);
  if (days <= 0) return { ok: true }; // no limit configured — today's behaviour

  const s = typeof grnDate === 'string' ? grnDate.trim() : '';
  if (!s || !DATE_RE.test(s)) {
    // Only reachable when a window IS configured. We cannot prove an unknown
    // date is inside a window, and quietly passing it would make the setting a
    // decoration on exactly the rows with the worst provenance.
    return {
      ok: false,
      error: `A ${days}-day return window is configured, so the receipt (GRN) date is required and must be YYYY-MM-DD.`,
    };
  }

  const cutoff = subtractDays(todayIST(), days);
  if (s < cutoff) {
    return {
      ok: false,
      error: `The return window for this receipt has closed. Goods received on ${s} are older than the ${days}-day window (returns allowed on or after ${cutoff}). An admin can widen the window in Settings → Returns.`,
    };
  }
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. REQUIREMENT 72 — "auto-fill PO No. & GRN No."
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A VENDOR return is raised FROM A GRN LINE, and the user must CHOOSE which
 * one. The system never guesses, and this is the measured reason why:
 *
 *   Sugar arrived on 5 GRNs. FOUR of them are ad-hoc with NO purchase order at
 *   all. Defaulting to "the latest GRN for this material" would file a Sugar
 *   return at Rs 10 against no PO when the goods actually came in at Rs 200 on
 *   PO-2026-0002 — a credit note wrong by a factor of twenty, on the document
 *   the vendor is going to be billed from.
 *
 * So the picker lists candidates and the ticket anchors on grn_item_id. From
 * that one row the join yields grn_number, po_number, the vendor, the accepted
 * quantity and the rate the goods actually arrived at — requirement 72's
 * auto-fill is then a real join, not a nearest match.
 *
 * INTERNAL returns get NOTHING from here. department_material_transactions
 * carries no grn_id and no purchase_id, and 2,134 of 2,165 purchases rows have
 * no grn_id, so any PO/GRN we printed on an internal ticket would be a
 * fabrication. Those fields stay blank and the report prints them blank,
 * honestly. (purchase_order_items.req_item_id does link a department line to a
 * PO, but it names the SHORTFALL PO — goods the store did NOT have and had to
 * buy — not the PO the issued grams came from, so it must not be offered as
 * the source of a departmental return.)
 */
export interface VendorReturnCandidateFilters {
  /** Restrict to one GRN. */
  grnId?: string;
  /** Restrict to one purchase order. */
  poId?: string;
  /** Restrict to one vendor (matches the GRN's vendor_id). */
  vendorId?: string;
  /** Restrict to one material. */
  materialId?: string;
  /** Case-insensitive LIKE over material name / GRN no. / PO no. / vendor / invoice no. */
  search?: string;
  /** GRN date range, YYYY-MM-DD inclusive. */
  dateFrom?: string;
  dateTo?: string;
  /** Hard cap; defaults to 500 and is clamped to 2,000. */
  limit?: number;
}

export interface VendorReturnCandidate {
  grn_item_id: string;
  grn_id: string;
  grn_number: string;
  grn_date: string;
  invoice_number: string;
  po_id: string | null;
  /** '' on an ad-hoc GRN with no purchase order — 9 of 29 live GRNs. Print it blank. */
  po_number: string;
  po_item_id: string | null;
  vendor_id: string | null;
  vendor: string;
  material_id: string;
  material_name: string;
  category: string;
  /** RECIPE unit (g / ml) — raw_materials.unit. */
  unit: string;
  /** PURCHASE unit (kg / L / BTL). Screens LEAD with this. */
  purchase_unit: string;
  pack_size: number;
  /** PURCHASE units, by canon (goods_receipt_note_items has no unit column). */
  quantity_accepted: number;
  /** Rs per PURCHASE unit, by canon. Pairs with quantity_accepted, same basis. */
  unit_price: number;
}

const CANDIDATE_LIMIT_DEFAULT = 500;
const CANDIDATE_LIMIT_MAX = 2000;

/**
 * GRN lines a vendor return could be raised against.
 *
 * This returns CANDIDATES, not entitlements. It deliberately does NOT subtract
 * what has already been returned and does NOT apply the requirement-75 window —
 * those are alreadyReturnedByGrnItem() and checkReturnWindow(), called by the
 * route, because a picker that silently hides a line is indistinguishable from
 * a picker that is broken. Show the line, show why it is unavailable.
 *
 * Store-mapped (liquor) lines are excluded here as well as refused at creation:
 * they never entered central stock in the first place, so there is nothing on
 * the central rail for a return to take back out. See canReturnMaterial.
 */
export function vendorReturnCandidates(
  db: Database,
  filters: VendorReturnCandidateFilters = {},
): VendorReturnCandidate[] {
  // A VOIDED GRN IS NOT A RETURNABLE DELIVERY, and this predicate is a stock
  // guard, not a tidy-up of the picker.
  //
  // Voiding a GRN (DELETE /api/grn/[id]) reverses the stock it added and deletes
  // its cost rows, but KEEPS the header and the line items — the document is the
  // record of what arrived. Those kept lines still have quantity_accepted > 0,
  // so without this they stayed on offer here, and a vendor return raised
  // against one took the SAME goods out of central stock a SECOND time when the
  // store verified it (src/lib/return-stock.ts's
  // `current_stock = current_stock - ?`, whose own balance guard passes whenever
  // any other stock of that material exists — i.e. nearly always). It also
  // claimed a vendor credit note for a receipt the venue had already erased.
  //
  // The void route guards the other direction (it refuses to void a GRN that
  // already has a return ticket); this is the missing half — a return raised
  // AFTER the void.
  const where: string[] = ['gi.quantity_accepted > 0', `g.status <> 'void'`];
  const params: unknown[] = [];

  const grnId = String(filters.grnId || '').trim();
  if (grnId) { where.push('g.id = ?'); params.push(grnId); }

  const poId = String(filters.poId || '').trim();
  if (poId) { where.push('g.po_id = ?'); params.push(poId); }

  const vendorId = String(filters.vendorId || '').trim();
  if (vendorId) { where.push('g.vendor_id = ?'); params.push(vendorId); }

  const materialId = String(filters.materialId || '').trim();
  if (materialId) { where.push('gi.material_id = ?'); params.push(materialId); }

  const dateFrom = String(filters.dateFrom || '').trim();
  if (DATE_RE.test(dateFrom)) { where.push('g.date >= ?'); params.push(dateFrom); }

  const dateTo = String(filters.dateTo || '').trim();
  if (DATE_RE.test(dateTo)) { where.push('g.date <= ?'); params.push(dateTo); }

  const search = String(filters.search || '').trim();
  if (search) {
    where.push(`(
      rm.name           LIKE ? COLLATE NOCASE OR
      g.grn_number      LIKE ? COLLATE NOCASE OR
      po.po_number      LIKE ? COLLATE NOCASE OR
      g.vendor          LIKE ? COLLATE NOCASE OR
      g.invoice_number  LIKE ? COLLATE NOCASE
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const rawLimit = Number(filters.limit);
  const limit = Math.min(
    CANDIDATE_LIMIT_MAX,
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : CANDIDATE_LIMIT_DEFAULT,
  );

  const rows = db.prepare(`
    SELECT
      gi.id                                            AS grn_item_id,
      g.id                                             AS grn_id,
      g.grn_number                                     AS grn_number,
      g.date                                           AS grn_date,
      COALESCE(g.invoice_number, '')                   AS invoice_number,
      g.po_id                                          AS po_id,
      COALESCE(po.po_number, '')                       AS po_number,
      gi.po_item_id                                    AS po_item_id,
      g.vendor_id                                      AS vendor_id,
      COALESCE(NULLIF(TRIM(g.vendor), ''),
               NULLIF(TRIM(poi.vendor), ''),
               NULLIF(TRIM(po.vendor), ''), '')        AS vendor,
      gi.material_id                                   AS material_id,
      rm.name                                          AS material_name,
      COALESCE(rm.category, '')                        AS category,
      COALESCE(rm.unit, '')                            AS unit,
      COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit, '') AS purchase_unit,
      COALESCE(rm.pack_size, 1)                        AS pack_size,
      gi.quantity_accepted                             AS quantity_accepted,
      gi.unit_price                                    AS unit_price
    FROM goods_receipt_note_items gi
    JOIN goods_receipt_notes  g   ON g.id   = gi.grn_id
    JOIN raw_materials        rm  ON rm.id  = gi.material_id
    LEFT JOIN purchase_orders po  ON po.id  = g.po_id
    LEFT JOIN purchase_order_items poi ON poi.id = gi.po_item_id
    WHERE ${where.join(' AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM store_category_map scm
        JOIN store_locations sl ON sl.id = scm.store_id
        WHERE sl.is_active = 1
          AND REPLACE(REPLACE(LOWER(TRIM(scm.category)), '-', ' '), '_', ' ')
            = REPLACE(REPLACE(LOWER(TRIM(rm.category)),  '-', ' '), '_', ' ')
      )
    ORDER BY g.date DESC, g.grn_number DESC, rm.name ASC
    LIMIT ?
  `).all(...params, limit) as VendorReturnCandidate[];

  return rows.map((r) => ({
    ...r,
    pack_size: Number(r.pack_size) || 1,
    quantity_accepted: Number(r.quantity_accepted) || 0,
    unit_price: Number(r.unit_price) || 0,
  }));
}

/**
 * The credit-note value of a vendor return line.
 *
 * rate-basis: purchase — quantity is in PURCHASE units (goods_receipt_note_items
 * has no unit column; quantity_accepted is purchase units by canon) and the rate
 * is goods_receipt_note_items.unit_price, Rs per PURCHASE unit. Both halves are
 * purchase basis, so the product is correct. NEVER pass a recipe-unit quantity
 * in here, and never source the rate from average_price (Rs/recipe-unit) or from
 * last_purchase_price (mixed basis, may not be read at all).
 *
 * RECORDED ONLY. This number belongs on the ticket header as the credit note the
 * vendor owes. It must not reach updateMaterialPrice, a purchases row, or any
 * recipe cost — a negative purchases row makes the return itself become the
 * material's latest price and cascades into every sub-recipe.
 */
export function vendorReturnLineValue(purchaseQty: number, unitPricePerPurchaseUnit: number): number {
  const q = Number(purchaseQty) || 0;
  const r = Number(unitPricePerPurchaseUnit) || 0;
  return Math.round(q * r * 100) / 100;
}

/**
 * How much of each GRN line has ALREADY been returned.
 *
 * DERIVED, never stored. There is deliberately no returned_qty column on
 * goods_receipt_note_items: decrementing quantity_accepted (or adding a flag
 * beside it) would change receivedPoItemIds() and therefore whether a purchase
 * order counts as complete — a returns action would silently reopen a closed PO
 * or close an open one. Same discipline receivedPoItemIds() itself follows.
 *
 * Only VERIFIED tickets count. A draft, a submitted ticket or one sitting at
 * hod_approved has moved nothing (see the header), so counting it here would
 * block a legitimate return against goods that are still on the shelf.
 *
 * TWO BASES, BOTH RETURNED, BECAUSE THE COMPARISON IS THE TRAP:
 *   returned_recipe_qty    RECIPE units — sums accepted_recipe_qty, which is
 *                          what actually moved.
 *   returned_purchase_qty  PURCHASE units — each row reversed with the
 *                          pack_factor SNAPSHOTTED ON THAT ROW, not with
 *                          today's pack_size. That is the same discipline
 *                          requisition_issue_ledger.pack_factor exists for: a
 *                          later Unit Audit rebase changes a material's factor,
 *                          and the reversal has to use the factor the movement
 *                          was actually made with.
 * Compare against goods_receipt_note_items.quantity_accepted using
 * returned_purchase_qty — quantity_accepted is PURCHASE units. Comparing it
 * against the recipe figure over-counts by the pack size (1,000x on a 1 kg pack)
 * and would refuse every second return.
 *
 * NO try/catch. If material_return_items is missing the deployment is broken,
 * and swallowing that would report "nothing returned yet" for every line —
 * which is the one wrong answer that lets the same goods be returned twice.
 */
export interface ReturnedAgainstGrnLine {
  returned_recipe_qty: number;
  returned_purchase_qty: number;
  lines: number;
}

export function alreadyReturnedByGrnItem(
  db: Database,
  grnItemIds: string[],
): Map<string, ReturnedAgainstGrnLine> {
  const out = new Map<string, ReturnedAgainstGrnLine>();
  const ids = Array.from(new Set((grnItemIds || []).map((s) => String(s || '').trim()).filter(Boolean)));
  if (ids.length === 0) return out;

  // Chunked so a large picker page cannot blow SQLite's variable limit (999).
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`
      SELECT
        ri.grn_item_id                                              AS grn_item_id,
        COALESCE(SUM(ri.accepted_recipe_qty), 0)                    AS returned_recipe_qty,
        COALESCE(SUM(ri.accepted_recipe_qty
                     / NULLIF(ri.pack_factor, 0)), 0)               AS returned_purchase_qty,
        COUNT(*)                                                    AS lines
      FROM material_return_items ri
      JOIN material_returns r ON r.id = ri.return_id
      WHERE r.status = 'verified'
        AND ri.store_rejected = 0
        AND ri.grn_item_id IN (${slice.map(() => '?').join(',')})
      GROUP BY ri.grn_item_id
    `).all(...slice) as Array<{
      grn_item_id: string;
      returned_recipe_qty: number;
      returned_purchase_qty: number;
      lines: number;
    }>;
    for (const r of rows) {
      out.set(String(r.grn_item_id), {
        returned_recipe_qty: Number(r.returned_recipe_qty) || 0,
        returned_purchase_qty: Number(r.returned_purchase_qty) || 0,
        lines: Number(r.lines) || 0,
      });
    }
  }
  return out;
}

export interface VendorReturnCandidateWithRemaining extends VendorReturnCandidate {
  /** PURCHASE units. Each prior row reversed with ITS OWN snapshotted pack_factor. */
  already_returned_purchase_qty: number;
  /** RECIPE units — what actually moved on the prior tickets. */
  already_returned_recipe_qty: number;
  /** PURCHASE units, floored at 0. Compare a purchase-unit request against THIS. */
  remaining_purchase_qty: number;
  /** RECIPE units, floored at 0. Compare a recipe-unit request against THIS. */
  remaining_recipe_qty: number;
  /** False when nothing is left to return. The row is still LISTED, not hidden. */
  returnable: boolean;
}

/**
 * The picker payload: candidates paired with what has already gone back.
 *
 * ONE ROUND TRIP, not one per row, and the netting happens here rather than in
 * each route so two screens cannot disagree about what "remaining" means.
 *
 * THE FIELD NAMES CARRY THEIR BASIS ON PURPOSE. A bare `remaining_qty` beside a
 * `quantity_accepted` in purchase units and an `accepted_recipe_qty` in recipe
 * units is the exact shape of a pack-size error: the reader has a 50/50 chance
 * of comparing it against the wrong half, and on a 1 kg pack that is wrong by
 * 1,000x. Both bases are returned; pick the one matching the quantity you are
 * validating, and never mix them in a single comparison.
 *
 * Rows with nothing left are RETURNED, not filtered out, with returnable=false.
 * A picker that silently omits a line is indistinguishable from a broken one —
 * show the line and show why it is unavailable.
 */
export function vendorReturnCandidatesWithRemaining(
  db: Database,
  filters: VendorReturnCandidateFilters = {},
): VendorReturnCandidateWithRemaining[] {
  const rows = vendorReturnCandidates(db, filters);
  const returned = alreadyReturnedByGrnItem(db, rows.map((r) => r.grn_item_id));
  const EPS = 1e-9;
  return rows.map((r) => {
    const prior = returned.get(r.grn_item_id);
    const donePurchase = prior?.returned_purchase_qty ?? 0;
    const doneRecipe = prior?.returned_recipe_qty ?? 0;
    // quantity_accepted is PURCHASE units by canon, so the recipe ceiling is
    // scaled by the MATERIAL's pack factor (both-halves guarded) — never by a
    // line factor, which is 1 whenever the user typed the recipe unit.
    const pf = packFactor({ unit: r.unit, purchase_unit: r.purchase_unit, pack_size: r.pack_size });
    const remPurchase = Math.max(0, r.quantity_accepted - donePurchase);
    const remRecipe = Math.max(0, r.quantity_accepted * pf - doneRecipe);
    return {
      ...r,
      already_returned_purchase_qty: donePurchase,
      already_returned_recipe_qty: doneRecipe,
      remaining_purchase_qty: remPurchase,
      remaining_recipe_qty: remRecipe,
      returnable: remPurchase > EPS,
    };
  });
}

/**
 * The one-line form, for a route validating a single GRN line rather than
 * painting a picker. Same query, same "verified tickets only" rule.
 *
 * RECIPE UNITS. Compare it against a recipe-unit figure, and get that figure by
 * scaling quantity_accepted (PURCHASE units) by the MATERIAL's pack factor —
 * ResolvedLineUnits.materialPackFactor — NOT by the LINE factor. The two differ
 * exactly when the user typed the recipe unit: lineFactor then answers 1, and
 * multiplying a purchase-unit receipt by 1 silently treats kilograms as grams.
 * Use returnedPurchaseQtyForGrnItem if you would rather stay in purchase units.
 */
export function returnedRecipeQtyForGrnItem(db: Database, grnItemId: string): number {
  return alreadyReturnedByGrnItem(db, [grnItemId]).get(String(grnItemId || '').trim())?.returned_recipe_qty ?? 0;
}

/** As above, in PURCHASE units — each row reversed with its own snapshotted pack_factor. */
export function returnedPurchaseQtyForGrnItem(db: Database, grnItemId: string): number {
  return alreadyReturnedByGrnItem(db, [grnItemId]).get(String(grnItemId || '').trim())?.returned_purchase_qty ?? 0;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. UNITS — ONE CONVERSION, AT THE BOUNDARY
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ResolvedLineUnits {
  /** RECIPE units per LINE unit. 1 when there is no real pack conversion. */
  packFactor: number;
  /** quantity x packFactor — RECIPE units. THE ONLY NUMBER STOCK EVER MOVES BY. */
  recipeQty: number;
  /**
   * TRUE means REFUSE, not "convert anyway and hope". The line unit is blank or
   * unrecognised on a packed material, so we cannot know the basis.
   */
  needsReview: boolean;
  /** Why it needs review — for the 400 the route returns. '' when clean. */
  reviewReason: string;
  /** The line unit, trimmed. */
  unit: string;
  /** The material's recipe unit (g / ml). */
  materialUnit: string;
  /** The material's purchase unit (kg / L / BTL) — what the screen leads with. */
  purchaseUnit: string;
  /** Recipe units per PURCHASE unit, both-halves guarded. Display layer only. */
  materialPackFactor: number;
}

/**
 * LINE unit -> RECIPE units for a return line, Option B.
 *
 * The screen leads with the PURCHASE unit (owner rule) but postDeptLedger and
 * inventory_transactions take RECIPE units ONLY and dept-ledger refuses to
 * convert on your behalf. So the conversion happens ONCE, here, at the
 * boundary, and the caller stores the factor it got — material_return_items
 * .pack_factor — so the movement can later be reversed with the factor actually
 * used rather than with whatever pack_size says next month.
 *
 * The pack rule is NOT re-derived here. lineFactor (src/lib/issue-stock.ts) is
 * imported, and it in turn imports packFactor from pack-units, which carries the
 * BOTH-HALVES GUARD:
 *
 *     pack_size > 1  AND  lower(trim(unit)) !== lower(trim(purchase_unit))
 *
 * Every hand-rolled local copy in this repo has dropped the second half, and the
 * live casualty is PICKLED GINGER 1.5KG (unit kg, purchase_unit kg, pack 1.5):
 * a short guard turns a 6 kg return into "4 kg". Through here it converts by 1,
 * correctly, because its two units are the same word.
 *
 * A BLANK OR UNRECOGNISED UNIT ON A PACKED MATERIAL IS A REFUSAL. dept-stock
 * reads a blank as the purchase basis while party-fulfillment reads it as
 * recipe; picking a side would be silently wrong on somebody's screen by a
 * factor of 750. applyIssueDelta answers that by SKIPPING the stock write and
 * still recording the hand-over — right for an issue, wrong here. A return
 * whose whole promise is "stock moves on Accept" must not quietly accept and
 * move nothing, so the route refuses the line UP FRONT, at ticket creation,
 * before anyone approves anything.
 */
export function resolveLineUnits(
  db: Database,
  materialId: string,
  unit: string | null | undefined,
  quantity: number,
): ResolvedLineUnits {
  const m = db.prepare(`
    SELECT id, name, unit, purchase_unit, pack_size
    FROM raw_materials WHERE id = ?
  `).get(String(materialId || '').trim()) as ReturnLineMaterial | undefined;
  return resolveLineUnitsFor(m, unit, quantity);
}

/** The material fields resolveLineUnitsFor needs. Any SELECT carrying these will do. */
export interface ReturnLineMaterial {
  name?: string | null;
  unit?: string | null;
  purchase_unit?: string | null;
  pack_size?: number | null;
}

/**
 * resolveLineUnits without the lookup, for a caller that already holds the
 * material row — every returns route SELECTs it anyway to validate the line, and
 * re-reading it here would be one extra query per line on a 40-line ticket.
 * resolveLineUnits is a thin wrapper over this, so there is still exactly ONE
 * implementation of the conversion and the two can never disagree.
 */
export function resolveLineUnitsFor(
  m: ReturnLineMaterial | null | undefined,
  unit: string | null | undefined,
  quantity: number,
): ResolvedLineUnits {
  const lineUnit = String(unit ?? '').trim();
  const qty = Number(quantity) || 0;

  if (!m) {
    return {
      packFactor: 1,
      recipeQty: 0,
      needsReview: true,
      reviewReason: 'Unknown material — a return line must name a material that exists.',
      unit: lineUnit,
      materialUnit: '',
      purchaseUnit: '',
      materialPackFactor: 1,
    };
  }

  const meta: PackMeta = { unit: m.unit, purchase_unit: m.purchase_unit, pack_size: m.pack_size };
  const { factor, needsReview } = lineFactor(lineUnit, meta);
  const materialUnit = String(m.unit || '').trim();
  const purchaseUnit = String(m.purchase_unit || m.unit || '').trim();

  let reviewReason = '';
  if (needsReview) {
    const label = String(m.name || 'This material');
    reviewReason = lineUnit
      ? `"${label}" is a packed material (1 ${purchaseUnit} = ${packFactor(meta)} ${materialUnit}) and "${lineUnit}" is neither its purchase unit nor its recipe unit, so the quantity cannot be converted. Choose ${purchaseUnit} or ${materialUnit}.`
      : `"${label}" is a packed material (1 ${purchaseUnit} = ${packFactor(meta)} ${materialUnit}) and the line has no unit, so the quantity is ambiguous. Choose ${purchaseUnit} or ${materialUnit}.`;
  }

  return {
    packFactor: factor,
    // Left at 0 when the basis is unknown: a recipeQty computed from a factor we
    // do not trust is exactly the number that would get moved by mistake.
    recipeQty: needsReview ? 0 : qty * factor,
    needsReview,
    reviewReason,
    unit: lineUnit,
    materialUnit,
    purchaseUnit,
    materialPackFactor: packFactor(meta),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. ELIGIBILITY
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a material may NOT be returned through this module, or null if it may.
 * Mirrors centralFlowBlock's shape (message-or-null) so a route can hand the
 * string straight back as its 400.
 *
 * STORE-MAPPED (LIQUOR) MATERIALS ARE REFUSED FOR BOTH KINDS, and for the same
 * underlying reason in each direction: those goods never travel on the central
 * rail at all. Their stock lives in store_stock_ledger via the Liquor Store's
 * own procure / transfer / adjust screens, and raw_materials.current_stock is
 * not their truth. So:
 *   - a VENDOR return would debit a central balance that never held them, and
 *   - an INTERNAL return would credit one.
 * Either way we would be inventing or destroying inventory in the central
 * ledger to record a movement that belongs to the store ledger. Liquor goes
 * back through Inventory → Liquor Store, exactly as its purchases do.
 *
 * The store-ownership rule itself is NOT re-derived here — centralFlowBlock
 * (src/lib/store-engine.ts) owns it, including the deactivated-store carve-out
 * (a deactivated store releases its categories back to Central behaviour) and
 * the stable ORDER BY that stops two case-variant category rows naming
 * different stores on different calls.
 */
export function returnMaterialBlock(db: Database, materialId: string): string | null {
  const id = String(materialId || '').trim();
  if (!id) return 'A return line must name a material.';
  const blocked = centralFlowBlock(db, id);
  if (blocked) {
    return `${blocked} Returns for store materials are recorded there too, not on this ticket.`;
  }
  return null;
}

/** True when this material can be returned through the central-store rail. */
export function canReturnMaterial(db: Database, materialId: string): boolean {
  return returnMaterialBlock(db, materialId) === null;
}
