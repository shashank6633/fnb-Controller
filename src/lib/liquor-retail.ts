import type { Database } from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { materialStoreId } from '@/lib/store-engine';
import {
  LQ_REIMBURSEMENT_STATUS,
  landedCostPerBottleExplained,
  type LqReimbursementStatus,
} from '@/lib/liquor-recon';
import { CASH_CATEGORY } from '@/lib/cash-purchase';
import { toPaise, toRupees, fmtRs, outflowWarning, MAX_PAISE } from '@/lib/petty-cash';
import { todayIST } from '@/lib/format-date';
import { postCentralTxn, vendorParty } from '@/lib/movement-record';

/**
 * LIQUOR PURCHASE RECONCILIATION — phase L3, EMERGENCY WINE-SHOP PURCHASES.
 * Plan: docs/liquor-reconciliation-plan.md §L3. Contract: src/lib/liquor-recon.ts.
 *
 * ── WHAT A WINE-SHOP BUY IS, AND WHY IT NEEDS ITS OWN WRITER ─────────────────
 * When the TGBCL depot runs dry mid-service, staff run to a local wine shop and
 * buy bottles at retail (MRP), well above the depot's landed cost. Those bottles
 * are a REAL purchase: the stock must move so the bar can pour them. The excess
 * over depot landed cost — "the price of running out" — plus who fronted the
 * money and whether they were paid back, are the facts §E of the Summary reports.
 *
 * ── THE ONE DESIGN DECISION THIS FILE TURNS ON (read before changing it) ─────
 * lq_retail_flags.purchase_id REFERENCES purchases(id) — the L0 schema anchors
 * the flag to a row in the CENTRAL `purchases` table, not to store_stock_ledger.
 * So a wine-shop buy writes ONE `purchases` row (the document + FK anchor) and
 * moves stock the way a central purchase does — raw_materials.current_stock +
 * ONE inventory_transactions('purchase') row — with THREE deliberate departures:
 *
 *   1. NO updateMaterialPrice(). The retail price is an outlier we must never let
 *      into average_price / last_purchase_price / recipe cost. Plan decision 1(a)
 *      and rule 1 of the L0 header: liquor valuation stays whatever it was. This
 *      is also the proof the owner asked for — "average_price untouched".
 *   2. NOT through store_stock_ledger. L1's landedCostPerBottle() reads that
 *      ledger's txn_type='purchase' rows as TGBCL DEPOT indent lines to derive
 *      the depot landed cost. Writing a RETAIL buy there would poison the very
 *      figure this module measures the excess against. The emergency stock
 *      therefore lands in central current_stock (where this venue's liquor stock
 *      lives) and never in the depot ledger.
 *   3. It BYPASSES centralFlowBlock (which normally keeps store-mapped liquor out
 *      of central purchases). The wine-shop buy is the deliberate exception the
 *      L0 FK was written for; the block still guards /api/purchases itself.
 *
 * Net effect, and what the L3 proof verifies on a copy: ONE purchases row, ONE
 * stock movement (not double-counted), ONE lq_retail_flags side record, and
 * average_price + every other material's stock + the depot ledger all untouched.
 *
 * ── THE FOUR EXCESS FIGURES ARE FROZEN AT ENTRY ─────────────────────────────
 * depot landed cost moves with every later indent; re-pricing last quarter's
 * emergency buy would make §E unreadable. So depot_landed_per_bottle and the
 * three excess figures are computed once, here, and stored — exactly as the
 * schema comment on lq_retail_flags demands.
 *
 * The only tables this module writes are `purchases` (one documentary row, no
 * price cascade), inventory_transactions (the stock movement's audit leg),
 * raw_materials.current_stock (the movement itself), lq_retail_flags,
 * petty_cash_ledger (a reimbursement payout) and audit_events.
 *
 * ── WHAT "average_price UNTOUCHED" DOES AND DOES NOT PROMISE ────────────────
 * AT WRITE TIME it is exact and verified: this file never calls
 * updateMaterialPrice(), so average_price, last_purchase_price, sub-recipe and
 * recipe costs are all byte-identical after a wine-shop buy.
 *
 * IT IS NOT A DURABLE GUARANTEE, and the earlier claim here that "VALUATION IS
 * NOT TOUCHED" overstated it. The documentary row this file must write (L0
 * anchors lq_retail_flags.purchase_id to purchases(id) NOT NULL) is a `purchases`
 * row, and two shared readers consume `purchases` with no exclusion:
 *
 *   · db.ts updateMaterialPrice() averages EVERY purchases row in the calendar
 *     month of MAX(date). /api/admin/recompute-prices and
 *     /api/admin/restore-prices (both buttons on /recipes) run it over the whole
 *     catalogue. MEASURED on a copy of the live DB: one 6-bottle emergency buy
 *     at ₹3,500 MRP moves KAHLUA average_price 3.3063 → 4.6667 ₹/ml (+41.2%,
 *     = 3500 ÷ 750) on the next such run, and cascades into sub-recipe cost.
 *   · closing-valuation.ts materialRate() takes rung #1 = "unit_price on the most
 *     recent purchases row". MEASURED: rate 2,479.74 → 3,500 ₹/BTL, and
 *     valueCount(6,630 ml) 21,920.92 → 30,940 (+₹9,019).
 *
 * THIS CANNOT BE CLOSED FROM INSIDE THIS FILE. There is no shape of the
 * documentary row that is both honest and invisible to those readers:
 * unit_price = 0 makes updateMaterialPrice store average_price = 0 (worse),
 * quantity = 0 destroys the document, and the FK forbids omitting the row. The
 * fix belongs to whoever owns the two readers — ONE predicate each, excluding
 * emergency retail rows on store-mapped materials from the price/valuation
 * basis, e.g. `AND COALESCE(is_emergency, 0) = 0` in updateMaterialPrice()'s
 * two SELECTs and in closing-valuation's `last` lookup. Until that lands, an
 * admin re-price run re-prices liquor from wine-shop MRP — which is exactly what
 * Owner Decision 1 (landed/retail cost is ANALYTICS ONLY) forbids. What this
 * file CAN do, and now does, is stop the row multiplying (duplicate guard) and
 * stop a future-dated row seizing MAX(date) for a whole month's basis (the
 * purchase-date window, enforced at the route).
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;

/**
 * A refusal the CALLER caused, carrying the HTTP status it deserves.
 *
 * Every business refusal in this file used to reach the screen as a bare 500,
 * because the routes catch `Error` and answer 500. On a money route a 500 reads
 * as a crash, invites the retry the duplicate guard then has to refuse, and
 * feeds the admin error-alert pipeline with non-errors. `status` travels with
 * the message so the routes can answer 400 / 404 / 409 truthfully.
 */
export class RetailError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'invalid') {
    super(message);
    this.name = 'RetailError';
    this.status = status;
    this.code = code;
  }
}

/** Map any thrown value to a Response. Structural, not `instanceof`: a module
 *  loaded twice (dev HMR) would break an identity check on the class. */
export function retailErrorResponse(e: unknown, fallback: string): Response {
  const err = e as { message?: string; status?: unknown; code?: unknown };
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  return Response.json(
    { error: err?.message || fallback, ...(typeof err?.code === 'string' ? { code: err.code } : {}) },
    { status },
  );
}

/** A real calendar day in YYYY-MM-DD — the L0 defect this phase closes.
 *  lq_retail_flags.date is NOT NULL, but '' and '2026-02-31' both slip past
 *  NOT NULL and are invisible to every §E `date BETWEEN` total. Require a REAL
 *  date at the edge, the same round-trip the petty-cash ledger uses. */
export function isRealDate(s: unknown): s is string {
  const v = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/* ── Excess arithmetic — pure, frozen at entry ──────────────────────────────*/

export interface RetailExcess {
  /** ₹ paid − depot landed, per bottle. Signed: a below-depot buy is negative. */
  excessPerBottle: number;
  /** excessPerBottle × bottles. */
  excessTotal: number;
  /** excessPerBottle ÷ depot landed × 100. 0 when depot is unknown (≤ 0). */
  excessPct: number;
}

/**
 * The three excess figures, exactly as the workbook's Wine Shop sheet computes
 * them. Pure so the proof can hand-verify it. When depot landed is unknown
 * (≤ 0 — not mapped, or L1 has no recorded line) the figures are 0 and the
 * caller stores depot_landed_per_bottle = 0; retailExcessSummary() then treats
 * that row as "excess not computable" and never folds a 0 into §E, because a 0
 * would read as "no excess", i.e. "the retail run cost us nothing".
 */
export function computeRetailExcess(
  ratePaidPerBottle: number,
  depotLandedPerBottle: number,
  bottles: number,
): RetailExcess {
  const paid = Number(ratePaidPerBottle) || 0;
  const depot = Number(depotLandedPerBottle) || 0;
  const n = Number(bottles) || 0;
  if (!(depot > 0)) return { excessPerBottle: 0, excessTotal: 0, excessPct: 0 };
  const excessPerBottle = r2(paid - depot);
  return {
    excessPerBottle,
    excessTotal: r2(excessPerBottle * n),
    excessPct: r2(((paid - depot) / depot) * 100),
  };
}

/* ── Depot landed cost — from L1, never reinvented ──────────────────────────*/

export interface DepotLandedResolved {
  /** ₹ per bottle, or null when it cannot be resolved (unmapped / no override). */
  perBottle: number | null;
  /** 'landed' (from L1), 'override' (owner-supplied), or 'unknown'. */
  source: 'landed' | 'override' | 'unknown';
  /** L1's own basis / reason, for a screen that must say why a figure is missing. */
  detail: string;
}

/**
 * Resolve the depot landed cost per bottle to freeze the excess against.
 *
 * L1 OWNS THE FORMULA — landedCostPerBottle() / landedCostPerBottleExplained()
 * in liquor-recon.ts. We import it, we do not reimplement it (the contract says
 * so, and a second landed-cost formula is exactly what L0 exists to prevent).
 * It returns null for an unmapped material — never 0, which would read as
 * "free". When it is null we accept an owner-supplied `override` (an emergency
 * at 11pm cannot wait for a brand to be mapped), and otherwise report "unknown"
 * so the caller can store a 0 the summary knows to exclude rather than a 0 that
 * lies.
 */
export function resolveDepotLanded(
  db: Database,
  args: { materialId: string; sizeCode?: string; storeId?: string; asOf?: string; override?: number | null },
): DepotLandedResolved {
  const explained = landedCostPerBottleExplained(db, {
    materialId: args.materialId,
    sizeCode: args.sizeCode || undefined,
    storeId: args.storeId || undefined,
    asOf: args.asOf || undefined,
  });
  // `> 0`, not merely finite. L1's allocatedLevies is SIGNED (MRP rounding is a
  // signed correction), so a landed cost of exactly 0 or below is reachable in
  // principle. Reporting such a row as source 'landed' while retailExcessSummary
  // buckets it as unknown (its test is `depot > 0`) would make the record path
  // and the report path disagree about what the row is. One test, both places.
  if (explained.value && Number.isFinite(explained.value.landedPerBottle) && explained.value.landedPerBottle > 0) {
    return { perBottle: r2(explained.value.landedPerBottle), source: 'landed', detail: explained.value.basis };
  }
  const ov = Number(args.override);
  if (Number.isFinite(ov) && ov > 0) {
    return { perBottle: r2(ov), source: 'override', detail: `manual depot rate (L1: ${explained.reason})` };
  }
  return { perBottle: null, source: 'unknown', detail: explained.reason };
}

/* ── Record a wine-shop purchase (stock + purchases row + flag, ONE txn) ─────*/

export interface RecordWineShopInput {
  materialId: string;
  /** Bottles bought, in PURCHASE units (the count on the shop bill). */
  bottles: number;
  /** ₹ per bottle actually paid at the shop. */
  ratePaidPerBottle: number;
  /** YYYY-MM-DD — REQUIRED and real (the L0 defect this phase closes). */
  date: string;
  shopName: string;
  shopLicenceNo: string;
  paidBy: string;
  paymentMode: string;
  reason: string;
  approvedBy: string;
  reimbursementStatus: LqReimbursementStatus;
  billRef?: string;
  /** Disambiguates a material mapped to several TGBCL packs. */
  sizeCode?: string;
  /** Owner-supplied depot landed ₹/bottle when the brand is not yet L1-mapped. */
  depotLandedOverride?: number | null;
  brand?: string;
  notes?: string;
  outletId: string | null;
  storeId: string;
}

export interface WineShopRecordResult {
  purchaseId: string;
  flagId: string;
  inventoryTxnId: string;
  /** Recipe units added to raw_materials.current_stock. */
  stockQty: number;
  depotLandedPerBottle: number;
  depotSource: DepotLandedResolved['source'];
  depotDetail: string;
  excess: RetailExcess;
  totalPaid: number;
  /** Non-blocking operator notice (e.g. cash was taken straight from the box). */
  notice?: string;
}

/**
 * Record ONE emergency wine-shop purchase. Everything below commits together or
 * not at all — a flag that outlived a rolled-back stock move would be a phantom
 * excess against a bar; a purchases row with no flag would be an untracked
 * retail buy. better-sqlite3 is synchronous, so the read-then-write inside the
 * transaction is indivisible within this process.
 */
export function recordWineShopPurchase(
  db: Database,
  input: RecordWineShopInput,
  actorEmail: string,
): WineShopRecordResult {
  const mat = db.prepare(
    'SELECT id, name, category, unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?',
  ).get(input.materialId) as any;
  if (!mat) throw new RetailError('Material not found.', 404, 'material_not_found');

  // This route is liquor-only: the whole point is the depot-vs-retail excess.
  // A non-store material has no depot landed cost to compare against and belongs
  // on the ordinary purchase flow.
  if (materialStoreId(db, mat) !== input.storeId) {
    throw new RetailError(`"${mat.name}" is not a material of this liquor store — an emergency wine-shop buy is for a store-mapped liquor item.`, 400, 'not_store_material');
  }

  const bottles = Number(input.bottles);
  if (!Number.isFinite(bottles) || bottles <= 0) throw new RetailError('bottles must be a number greater than 0.');
  const rate = Number(input.ratePaidPerBottle);
  if (!Number.isFinite(rate) || rate <= 0) throw new RetailError('rate paid per bottle must be a number greater than 0.');
  if (!isRealDate(input.date)) throw new RetailError('date must be a real calendar date in YYYY-MM-DD.');

  // 'reimbursed' IS NOT A STATE THAT CAN BE TYPED. It is the terminal state of a
  // claim and it means "a petty-cash payout closed this" — a flag born
  // 'reimbursed' has petty_cash_id NULL and no ledger row behind it, yet §E drops
  // it out of "unreimbursed staff spend": the app would report a staff member
  // paid back on the strength of a dropdown. The ONLY writer of 'reimbursed' is
  // closeReimbursementWithPettyCash(), which writes the payout in the same
  // transaction. Everything else may be recorded at entry.
  if (input.reimbursementStatus === 'reimbursed') {
    throw new RetailError(
      "A wine-shop buy cannot be recorded as already 'reimbursed' — that state is set only by a real petty-cash payout. "
      + "Record it as 'claimed_pending' and close it with a payout, or as 'not_required' if nobody is owed anything.",
      400, 'reimbursed_not_recordable',
    );
  }
  if (!(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(input.reimbursementStatus)) {
    throw new RetailError(`reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`);
  }

  // Purchase units → recipe units, the house pack convention (mirrors
  // updateMaterialPrice / /api/purchases): current_stock is RECIPE units.
  const packSize = Number(mat.pack_size) || 1;
  const ru = String(mat.unit || '').toLowerCase().trim();
  const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase().trim();
  const stockQty = (packSize > 1 && ru !== pu) ? bottles * packSize : bottles;
  /** The material's OWN purchase-unit label, for any sentence that names a rate. */
  const purchaseUnitLabel = String(mat.purchase_unit || mat.unit || 'unit').trim() || 'unit';

  // Depot landed cost is READ (read-only) before the write and FROZEN.
  const depot = resolveDepotLanded(db, {
    materialId: input.materialId, sizeCode: input.sizeCode, storeId: input.storeId,
    asOf: input.date, override: input.depotLandedOverride,
  });
  const depotPerBottle = depot.perBottle == null ? 0 : depot.perBottle;
  const excess = computeRetailExcess(rate, depotPerBottle, bottles);
  const totalPaid = r2(bottles * rate);

  const shopName = String(input.shopName || '').slice(0, 200);
  const billRef = String(input.billRef || '').trim().slice(0, 120);

  /* ── DUPLICATE GUARD — the same bill must not book the stock and the money
   * twice. UNIQUE(purchase_id) on lq_retail_flags stops a second FLAG on one
   * purchase; it says nothing about a second purchase+flag PAIR, and every
   * submit mints a fresh purchase id. Measured before this guard existed: two
   * identical calls → 2 purchases rows, +9,000 ml for a 4,500 ml bill, ₹18,000
   * for a ₹9,000 bill and DOUBLE the §E excess. Both neighbouring flows defend
   * exactly this — /api/purchases:496 (409 on material+date+vendor+bill_no+
   * outlet, whose comment names doubled stock as the reason) and
   * /api/stores/[id]/procure-bill:52 (409 on a repeated invoice_ref).
   *
   * TWO KEYS, because a wine-shop run has two shapes:
   *   · WITH a bill number — the document identity. Same material + date + shop
   *     + bill + outlet is the same line, refused outright.
   *   · WITHOUT one — a cash run often has no paper, and two market runs for one
   *     item on one day are two REAL purchases (the same carve-out
   *     /api/purchases documents for a blank bill_no). Refusing them would
   *     destroy a fact, so a blank bill is judged only against the 90-SECOND
   *     window the petty-cash door uses for the identical shape of mistake: a
   *     double-clicked Save or a retry after a timeout.
   *
   * NO RACE: there is no `await` between this read and the synchronous
   * better-sqlite3 transaction below, and the transaction is IMMEDIATE. Keep it
   * that way — an await added here reopens the window. */
  const dupe = db.prepare(`
    SELECT p.id, p.quantity, p.unit_price, p.date, f.bill_ref
      FROM purchases p
      JOIN lq_retail_flags f ON f.purchase_id = p.id
     WHERE p.material_id = ?
       AND p.date = ?
       AND COALESCE(p.outlet_id, '') = COALESCE(?, '')
       AND LOWER(TRIM(COALESCE(f.shop_name, ''))) = ?
       AND ${billRef
         ? "LOWER(TRIM(COALESCE(f.bill_ref, ''))) = ?"
         : "TRIM(COALESCE(f.bill_ref, '')) = '' AND f.bottles = ? AND f.rate_paid_per_bottle = ? AND f.created_at >= datetime('now', '-90 seconds')"}
     ORDER BY f.created_at DESC
     LIMIT 1
  `).get(
    ...(billRef
      ? [input.materialId, input.date, input.outletId, shopName.trim().toLowerCase(), billRef.toLowerCase()]
      : [input.materialId, input.date, input.outletId, shopName.trim().toLowerCase(), bottles, rate]),
  ) as any;
  if (dupe) {
    throw new RetailError(
      billRef
        ? `"${mat.name}" is already recorded on wine-shop bill ${billRef} from ${shopName || 'this shop'} dated ${input.date} `
          + `— ${dupe.quantity} ${purchaseUnitLabel} at ${fmtRs(toPaise(Number(dupe.unit_price)))} each. `
          + `Nothing was saved; if you are re-trying after a failed save, that buy is already in.`
        : `An identical wine-shop buy (${bottles} ${purchaseUnitLabel} × "${mat.name}" at ${fmtRs(toPaise(rate))} each from ${shopName || 'this shop'} on ${input.date}) `
          + `was recorded moments ago. Nothing was saved. If the bottles really were bought twice, enter the shop's bill number to record the second run.`,
      409, 'duplicate',
    );
  }

  const purchaseId = generateId();
  const flagId = generateId();
  const inventoryTxnId = generateId();

  const run = db.transaction(() => {
    // 1. THE DOCUMENTARY purchases ROW. is_emergency=1 marks it; vendor is the
    //    shop; unit_price is the retail ₹/bottle. NO invoice_id/GST/discount —
    //    a wine-shop cash run has no PINV and no input credit. NO
    //    updateMaterialPrice(): the retail rate must not touch average_price.
    db.prepare(`
      INSERT INTO purchases
        (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes,
         is_emergency, payment_mode, emergency_reason, bill_no, outlet_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
    `).run(
      purchaseId, input.materialId, shopName,
      String(input.brand || '').slice(0, 200), bottles, rate, totalPaid, input.date,
      String(input.notes || '').slice(0, 500),
      String(input.paymentMode || '').slice(0, 60),
      String(input.reason || '').slice(0, 500),
      billRef, input.outletId,
    );

    // 2. THE STOCK MOVEMENT — central current_stock + its audit leg. This is the
    //    ONLY place the stock moves; the store ledger is deliberately untouched
    //    (see the header: it would poison L1's depot landed cost).
    db.prepare(
      "UPDATE raw_materials SET current_stock = current_stock + ?, updated_at = datetime('now') WHERE id = ?",
    ).run(stockQty, input.materialId);
    // MOVEMENT RECORD: an emergency wine-shop buy is still a VENDOR receipt —
    // the shop is the source, central the destination — and the purchase's own
    // date is the business date, not the day it was keyed in.
    postCentralTxn(db, {
      id: inventoryTxnId,        // pre-minted: the caller cross-references it
      materialId: input.materialId,
      type: 'purchase',
      quantity: stockQty,
      referenceId: purchaseId,
      notes: `Emergency wine-shop purchase from ${input.shopName || 'wine shop'}`,
      outletId: input.outletId,
      counterparty: vendorParty(input.shopName || 'wine shop'),
      txnDate: input.date,
      actor: actorEmail,
    });

    // 3. THE SIDE RECORD — the flag. Never names the stock or the money twice;
    //    it carries only what the purchase row has nowhere to put. The four
    //    excess figures are frozen above.
    db.prepare(`
      INSERT INTO lq_retail_flags
        (id, purchase_id, bill_ref, date, shop_name, shop_licence_no, bottles,
         rate_paid_per_bottle, depot_landed_per_bottle, excess_per_bottle,
         excess_total, excess_pct, paid_by, payment_mode, reimbursement_status,
         reason, approved_by, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      flagId, purchaseId, billRef, input.date,
      shopName, String(input.shopLicenceNo || '').slice(0, 120),
      bottles, rate, depotPerBottle, excess.excessPerBottle, excess.excessTotal, excess.excessPct,
      String(input.paidBy || '').slice(0, 200), String(input.paymentMode || '').slice(0, 60),
      input.reimbursementStatus, String(input.reason || '').slice(0, 500),
      String(input.approvedBy || '').slice(0, 200), actorEmail,
    );

    logAuditEvent(db, {
      event_type: 'liquor_retail.record',
      entity_type: 'lq_retail_flags',
      entity_id: flagId,
      actor_email: actorEmail,
      outlet_id: input.outletId,
      after: {
        purchase_id: purchaseId, material_id: input.materialId, material: mat.name,
        bottles, rate_paid_per_bottle: rate, total_paid: totalPaid,
        depot_landed_per_bottle: depotPerBottle, depot_source: depot.source,
        excess_per_bottle: excess.excessPerBottle, excess_total: excess.excessTotal,
        excess_pct: excess.excessPct, shop_name: input.shopName, bill_ref: input.billRef,
        paid_by: input.paidBy, reimbursement_status: input.reimbursementStatus,
      },
      // The unit beside the rate comes from the MATERIAL, never from a literal:
      // rate is ₹ per PURCHASE unit, so the label is the material's own
      // purchase_unit (BTL / CASE / …). A hardcoded "/btl" is wrong the day a
      // brand is bought by the case, and scripts/check-rate-basis.js refuses it.
      // rate-basis: purchase   (₹ per purchase unit, beside a purchase-unit qty)
      note: `Emergency wine-shop buy: ${bottles} ${purchaseUnitLabel} × ${mat.name} @ ${fmtRs(toPaise(rate))} per ${purchaseUnitLabel} from ${input.shopName || 'wine shop'}`
        + (depotPerBottle > 0 ? ` — excess ${fmtRs(toPaise(excess.excessTotal))} (${excess.excessPct}%)` : ' — depot rate unknown'),
    });
  });
  // IMMEDIATE, not the default deferred BEGIN — the same rule the two sibling
  // money doors state (petty-cash/route.ts:353, grn/route.ts:2027). The duplicate
  // read above and the stock read-modify-write below are read-then-write: a
  // deferred transaction takes a read lock first and tries to upgrade at the
  // INSERT, so two racing saves are decided after the fact and the loser gets a
  // 500 on a buy that was in fact recordable, with no way to tell whether it
  // landed. IMMEDIATE takes the write lock before the first read.
  run.immediate();

  // Cash taken STRAIGHT from the petty cash box is not debited here — the money
  // leg is written only by a reimbursement payout, and auto-writing one from a
  // free-text payment_mode is exactly how the box gets debited twice. Say so
  // instead of guessing: the operator records the payout on /petty-cash.
  const pm = String(input.paymentMode || '').toLowerCase().replace(/[^a-z]/g, '');
  const notice = (pm.includes('pettycash') || pm === 'petty')
    && input.reimbursementStatus === 'not_required'
    ? `${fmtRs(toPaise(totalPaid))} was recorded as taken from petty cash, but NO petty-cash entry was written — this module only writes the box when it reimburses someone. Record the cash-out on the Petty Cash page so the box balance matches the notes in it.`
    : undefined;

  return {
    purchaseId, flagId, inventoryTxnId, stockQty,
    depotLandedPerBottle: depotPerBottle, depotSource: depot.source, depotDetail: depot.detail,
    excess, totalPaid,
    ...(notice ? { notice } : {}),
  };
}

/* ── Close a reimbursement claim with a petty-cash payout ────────────────────*/

export interface ReimburseResult {
  pettyCashId: string;
  flagId: string;
  amount: number;
  /** The outlet whose cash box was actually debited (the CLAIM's, not the session's). */
  outletId: string | null;
  date: string;
  /** Non-blocking overdraft notice, if the box would go negative. */
  warning?: string;
}

/**
 * Close a pending flag by paying the staff member back out of the petty cash box.
 * ONE transaction: the payout row and the flag's status flip commit together.
 *
 * ── THE PAYOUT MUST EQUAL THE CLAIM ─────────────────────────────────────────
 * This used to accept any positive `amountOverride` "for a partial/negotiated
 * settlement" and flip the flag to 'reimbursed' regardless. lq_retail_flags has
 * NO column for what was actually paid, so the residual simply vanished:
 * measured, a ₹1 payout closed a ₹9,000 claim and §E's "unreimbursed staff
 * spend" — the one number this phase exists to produce — went 9,000 → 0 with
 * ₹8,999 still owed to a named person. The same override had no ceiling either
 * (₹50,00,000 accepted against a ₹500 bill).
 *
 * With nowhere to record a part-payment, a payout closes a claim only IN FULL.
 * `amountOverride`, when given, is therefore a CONFIRMATION of the figure the
 * screen displayed, not a free amount: a mismatch is refused rather than
 * silently redefining the debt. A genuinely negotiated settlement is a business
 * decision the app cannot represent — reject the claim instead, and settle it
 * outside the cash book.
 *
 * ── THE BOX THAT IS DEBITED IS THE CLAIM'S, NOT THE SESSION'S ────────────────
 * The outlet comes from the flag's parent purchase. Passing the session outlet
 * let a Main claim be paid out of Branch 2's box while §E, which scopes on
 * purchases.outlet_id, reported it reimbursed against Main — two books that can
 * never be reconciled against each other.
 *
 * ── A DELETED PAYOUT REOPENS THE CLAIM ──────────────────────────────────────
 * The FK petty_cash_id → petty_cash_ledger is ON DELETE SET NULL, and the L0 DDL
 * comment states the intent: "deleting the petty-cash payout must reopen the
 * claim". The FK nulls a pointer; nothing flipped the status back, so the claim
 * was left permanently 'reimbursed' with no payout behind it, uncloseable and
 * invisible to §E. A flag in that state (reimbursed + petty_cash_id NULL) is
 * therefore treated here as STILL OWED and can be paid again — and
 * retailExcessSummary counts it as unreimbursed for the same reason.
 *
 * The payout is a real petty_cash_ledger 'out' row (category 'cash_purchase' —
 * cash paid out against a voucher, here the wine-shop bill), written the same
 * way src/lib/cash-purchase.ts writes the GRN money leg, and — unlike a normal
 * central purchase — a wine-shop buy is ONE purchases LINE, so the payout can
 * honestly carry purchase_id = the flag's purchase (the one case the petty-cash
 * route's own comment says purchase_id is safe to set).
 */
export function closeReimbursementWithPettyCash(
  db: Database,
  args: { flagId: string; actorEmail: string; outletId: string | null; date?: string; notes?: string; amountOverride?: number | null },
): ReimburseResult {
  const flag = db.prepare(`
    SELECT f.*, p.outlet_id AS purchase_outlet_id
      FROM lq_retail_flags f
      LEFT JOIN purchases p ON p.id = f.purchase_id
     WHERE f.id = ?
  `).get(args.flagId) as any;
  if (!flag) throw new RetailError('That wine-shop record no longer exists.', 404, 'flag_not_found');

  // 'reimbursed' WITH a payout is closed. 'reimbursed' WITHOUT one is a claim
  // whose payout was deleted — reopened, per the L0 FK's stated intent.
  const reopened = flag.reimbursement_status === 'reimbursed' && !flag.petty_cash_id;
  if (flag.petty_cash_id) {
    throw new RetailError('This claim was already closed by a petty-cash payout.', 409, 'already_reimbursed');
  }
  if (flag.reimbursement_status !== 'claimed_pending' && !reopened) {
    throw new RetailError(
      `This claim is "${flag.reimbursement_status}", not "claimed_pending" — only a pending claim is closed by a payout.`,
      409, 'not_pending',
    );
  }

  // The amount owed is what the staff member fronted: bottles × rate paid.
  const owed = r2(Number(flag.bottles) * Number(flag.rate_paid_per_bottle));
  if (!(owed > 0)) {
    throw new RetailError('This claim owes nothing (bottles × rate paid is 0) — there is nothing to pay out.', 400, 'nothing_owed');
  }
  if (args.amountOverride != null) {
    const asked = Number(args.amountOverride);
    if (!Number.isFinite(asked)) throw new RetailError('amount must be a number.');
    if (Math.abs(asked * 100 - Math.round(asked * 100)) > 1e-6) {
      throw new RetailError('Amount cannot be finer than a paisa (2 decimal places).');
    }
    if (r2(asked) !== owed) {
      throw new RetailError(
        `A payout closes a wine-shop claim only in full. ${fmtRs(toPaise(owed))} is owed `
        + `(${flag.bottles} × ${fmtRs(toPaise(Number(flag.rate_paid_per_bottle)))}), but ${fmtRs(toPaise(r2(asked)))} was sent. `
        + `There is nowhere on the record to store a part-payment, so closing it for less would erase the rest of the debt `
        + `from the "unreimbursed staff spend" total. Pay the full amount, or reject the claim and settle it outside the cash book.`,
        400, 'amount_mismatch',
      );
    }
  }
  const amount = owed;
  const amountPaise = toPaise(amount);
  // The absurdity ceiling the other two doors into this ledger enforce
  // (petty-cash/route.ts, cash-purchase.ts). "One rule, one number — a ceiling
  // that differs by door is not a ceiling" (petty-cash.ts:246-259).
  if (amountPaise > MAX_PAISE) {
    throw new RetailError(
      `${fmtRs(amountPaise)} is over the ₹10,00,000 ceiling for a single petty-cash entry — check the bottles and the rate on this record for an extra zero.`,
      400, 'over_ceiling',
    );
  }

  // The payout is dated the day the CASH LEFT THE BOX — today by default, not the
  // day the bottles were bought. Dating it from the purchase back-dates the box's
  // running balance for every day in between and trips the tail-scan hole warning
  // on a hole the app itself dug. A supplied date is validated, never swallowed.
  let date: string;
  if (args.date == null || String(args.date).trim() === '') {
    date = todayIST();
  } else if (!isRealDate(args.date)) {
    throw new RetailError('The payout date must be a real calendar date in YYYY-MM-DD.');
  } else if (String(args.date) > todayIST()) {
    throw new RetailError('The payout date cannot be in the future — cash leaving the box is an event that has already happened.');
  } else {
    date = String(args.date);
  }

  // The CLAIM's outlet, falling back to the caller's session only when the
  // purchase carries none (single-outlet installs).
  const outletId: string | null = flag.purchase_outlet_id ?? args.outletId ?? null;

  const vendor = String(flag.shop_name || '').slice(0, 200);
  const reference = String(flag.bill_ref || '').slice(0, 120);
  const notes = String(args.notes || `Reimbursement to ${flag.paid_by || 'staff'} for emergency wine-shop buy`).slice(0, 500);
  const pettyCashId = generateId();

  let warning: string | undefined;
  const run = db.transaction(() => {
    /* CROSS-DOOR DOUBLE-PAY GUARD. The box has three doors (the petty-cash form,
     * cash-purchase.ts and this one) and only the form's own 90-second guard sees
     * its own writes. A manager who paid Ravi back on the form and then closed the
     * flag here debited the box twice for one claim, with nothing on either
     * surface to say so. Two checks, both inside the write lock:
     *   (a) any 'out' row already pointing at THIS claim's purchase — exact, and
     *       it also catches a payout whose flag link was cleared by a delete;
     *   (b) the petty-cash form's own key (date+direction+amount+category+vendor+
     *       reference) inside 90 seconds — the retry/double-click window. */
    const linked = db.prepare(`
      SELECT id, date, amount FROM petty_cash_ledger
       WHERE direction = 'out' AND purchase_id = ? LIMIT 1
    `).get(flag.purchase_id) as any;
    if (linked) {
      throw new RetailError(
        `A petty-cash payout of ${fmtRs(toPaise(Number(linked.amount)))} on ${linked.date} is already recorded against this wine-shop bill. `
        + `Nothing was recorded — paying again would take the money out of the box twice.`,
        409, 'payout_exists',
      );
    }
    const nearDup = db.prepare(`
      SELECT id FROM petty_cash_ledger
       WHERE date = ? AND direction = 'out' AND category = ?
         AND CAST(ROUND(amount * 100) AS INTEGER) = ?
         AND COALESCE(vendor, '') = ? AND COALESCE(reference, '') = ?
         AND created_at >= datetime('now', '-90 seconds')
       LIMIT 1
    `).get(date, CASH_CATEGORY, amountPaise, vendor, reference) as any;
    if (nearDup) {
      throw new RetailError(
        'An identical cash payment out of the box was recorded moments ago. Nothing was recorded — check the petty cash book before paying again.',
        409, 'duplicate_payout',
      );
    }

    // Overdraft is REPORTED, never enforced — the cash already left the box for
    // the bottles; refusing to record the reimbursement would make the app lie.
    // (Same posture as recordCashPurchase / the petty-cash route.)
    const ov = outflowWarning(db, outletId, date, 'out', amountPaise);
    if (ov.overdrawn) warning = ov.message;

    db.prepare(`
      INSERT INTO petty_cash_ledger
        (id, outlet_id, date, direction, amount, category, purchase_id, vendor, reference, notes, recorded_by)
      VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pettyCashId, outletId, date, toRupees(amountPaise), CASH_CATEGORY, flag.purchase_id,
      vendor, reference, notes, args.actorEmail,
    );

    const res = db.prepare(`
      UPDATE lq_retail_flags
         SET petty_cash_id = ?, reimbursement_status = 'reimbursed', updated_at = datetime('now')
       WHERE id = ? AND petty_cash_id IS NULL
         AND reimbursement_status IN ('claimed_pending', 'reimbursed')
    `).run(pettyCashId, args.flagId);
    // Guard against a racing close: if the row was already flipped, abort so the
    // payout rolls back with it rather than leaving a second unlinked payout.
    if (res.changes !== 1) {
      throw new RetailError('This claim was closed by another action — nothing was recorded.', 409, 'raced');
    }

    logAuditEvent(db, {
      event_type: 'liquor_retail.reimburse',
      entity_type: 'lq_retail_flags',
      entity_id: args.flagId,
      actor_email: args.actorEmail,
      outlet_id: outletId,
      after: {
        petty_cash_id: pettyCashId, amount, date, purchase_id: flag.purchase_id,
        paid_by: flag.paid_by, shop_name: flag.shop_name, bill_ref: flag.bill_ref,
        reimbursement_status: 'reimbursed', reopened_claim: reopened || undefined,
      },
      note: `Reimbursed ${fmtRs(amountPaise)} to ${flag.paid_by || 'staff'} — petty-cash payout for wine-shop bill ${flag.bill_ref || '(no bill no)'}`
        + (reopened ? ' (claim had been reopened by a deleted payout)' : ''),
    });
  });
  // IMMEDIATE for the same reason petty-cash/route.ts:353 and grn/route.ts:2027
  // are: every check above is read-then-write, and the overdraft sentence quotes
  // a balance the storekeeper will act on.
  run.immediate();

  return { pettyCashId, flagId: args.flagId, amount, outletId, date, ...(warning ? { warning } : {}) };
}

/* ── Corrections: the rest of the lifecycle ─────────────────────────────────*/

/**
 * Backfill the depot landed rate on a flag recorded before the brand was mapped.
 *
 * The record path tells the caller "the excess was recorded as 0 and is excluded
 * from the price-of-running-out total UNTIL A RATE IS KNOWN". Nothing could ever
 * make it known: the module shipped GET + POST only, so an unpriced flag stayed
 * at excess 0 for ever and the sentence was a promise no route could keep.
 *
 * Only a flag with NO depot rate can be backfilled. A rate already frozen at
 * entry stays frozen — re-pricing last quarter's emergency buy against today's
 * depot cost is exactly what the freezing rule exists to prevent.
 */
export function backfillDepotLanded(
  db: Database,
  args: { flagId: string; depotLandedPerBottle: number; actorEmail: string },
): { flagId: string; depotLandedPerBottle: number; excess: RetailExcess } {
  const flag = db.prepare('SELECT * FROM lq_retail_flags WHERE id = ?').get(args.flagId) as any;
  if (!flag) throw new RetailError('That wine-shop record no longer exists.', 404, 'flag_not_found');
  if (Number(flag.depot_landed_per_bottle) > 0) {
    throw new RetailError(
      `This buy already carries a depot rate of ${fmtRs(toPaise(Number(flag.depot_landed_per_bottle)))}, frozen when it was recorded. `
      + `A frozen rate is never re-priced — that is what keeps §E readable across quarters.`,
      409, 'already_priced',
    );
  }
  const depot = Number(args.depotLandedPerBottle);
  if (!Number.isFinite(depot) || depot <= 0) {
    throw new RetailError('The depot landed cost per bottle must be a number greater than 0.');
  }
  const excess = computeRetailExcess(Number(flag.rate_paid_per_bottle), r2(depot), Number(flag.bottles));

  const run = db.transaction(() => {
    const res = db.prepare(`
      UPDATE lq_retail_flags
         SET depot_landed_per_bottle = ?, excess_per_bottle = ?, excess_total = ?, excess_pct = ?,
             updated_at = datetime('now')
       WHERE id = ? AND COALESCE(depot_landed_per_bottle, 0) <= 0
    `).run(r2(depot), excess.excessPerBottle, excess.excessTotal, excess.excessPct, args.flagId);
    if (res.changes !== 1) {
      throw new RetailError('This buy was priced by another action — nothing was changed.', 409, 'raced');
    }
    logAuditEvent(db, {
      event_type: 'liquor_retail.backfill_depot_rate',
      entity_type: 'lq_retail_flags',
      entity_id: args.flagId,
      actor_email: args.actorEmail,
      before: { depot_landed_per_bottle: Number(flag.depot_landed_per_bottle) || 0, excess_total: Number(flag.excess_total) || 0 },
      after: { depot_landed_per_bottle: r2(depot), ...excess },
      note: `Depot rate backfilled for wine-shop bill ${flag.bill_ref || '(no bill no)'} — excess now ${fmtRs(toPaise(excess.excessTotal))} (${excess.excessPct}%)`,
    });
  });
  run.immediate();
  return { flagId: args.flagId, depotLandedPerBottle: r2(depot), excess };
}

/**
 * Correct a claim's reimbursement status — the rest of a lifecycle that shipped
 * with exactly one edge (claimed_pending → reimbursed, by payout).
 *
 * A claim keyed in as 'claimed_pending' and settled in cash outside the app
 * inflated §E's "unreimbursed staff spend" for ever; a claim recorded pending in
 * error could never be marked rejected; a rejected claim the owner later
 * approved could never be paid. All three are correctable here.
 *
 * 'reimbursed' IS NOT WRITABLE HERE, in either direction: it is reached only by
 * a real payout (closeReimbursementWithPettyCash) and left only by deleting that
 * payout, which reopens the claim. That keeps the invariant the whole design
 * rests on — the settled state always has cash behind it.
 */
export function setReimbursementStatus(
  db: Database,
  args: { flagId: string; status: LqReimbursementStatus; actorEmail: string; note?: string },
): { flagId: string; from: LqReimbursementStatus; to: LqReimbursementStatus } {
  const flag = db.prepare('SELECT * FROM lq_retail_flags WHERE id = ?').get(args.flagId) as any;
  if (!flag) throw new RetailError('That wine-shop record no longer exists.', 404, 'flag_not_found');
  if (!(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(args.status)) {
    throw new RetailError(`reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`);
  }
  if (args.status === 'reimbursed') {
    throw new RetailError(
      "'reimbursed' is set only by a real petty-cash payout, never typed — use the reimburse action.",
      400, 'reimbursed_not_writable',
    );
  }
  if (flag.reimbursement_status === 'reimbursed' && flag.petty_cash_id) {
    throw new RetailError(
      'This claim was closed by a petty-cash payout. Delete or reverse that payout first — the status follows the cash, not the other way round.',
      409, 'payout_backed',
    );
  }
  if (flag.reimbursement_status === args.status) {
    throw new RetailError(`This claim is already "${args.status}".`, 409, 'no_change');
  }

  const run = db.transaction(() => {
    const res = db.prepare(`
      UPDATE lq_retail_flags
         SET reimbursement_status = ?, updated_at = datetime('now')
       WHERE id = ? AND reimbursement_status = ? AND petty_cash_id IS NULL
    `).run(args.status, args.flagId, flag.reimbursement_status);
    if (res.changes !== 1) {
      throw new RetailError('This claim changed under you — nothing was written.', 409, 'raced');
    }
    logAuditEvent(db, {
      event_type: 'liquor_retail.status',
      entity_type: 'lq_retail_flags',
      entity_id: args.flagId,
      actor_email: args.actorEmail,
      before: { reimbursement_status: flag.reimbursement_status },
      after: { reimbursement_status: args.status },
      note: `Wine-shop claim ${flag.bill_ref || '(no bill no)'}: ${flag.reimbursement_status} → ${args.status}`
        + (args.note ? ` — ${String(args.note).slice(0, 300)}` : ''),
    });
  });
  run.immediate();
  return { flagId: args.flagId, from: flag.reimbursement_status, to: args.status };
}

/* ── §E DATA for the L5 Reconciliation Summary ──────────────────────────────*/

export interface RetailFlagRow {
  id: string;
  purchase_id: string;
  bill_ref: string;
  date: string;
  shop_name: string;
  shop_licence_no: string;
  bottles: number;
  rate_paid_per_bottle: number;
  depot_landed_per_bottle: number;
  excess_per_bottle: number;
  excess_total: number;
  excess_pct: number;
  paid_by: string;
  payment_mode: string;
  reimbursement_status: LqReimbursementStatus;
  petty_cash_id: string | null;
  reason: string;
  approved_by: string;
  material_id: string | null;
  material_name: string | null;
  outlet_id: string | null;
  total_paid: number;
}

export interface RetailExcessSummary {
  from: string;
  to: string;
  /** Σ excess_total over flags WITH a known depot rate (> 0). "Price of running out." */
  excessTotal: number;
  /** Flags whose depot rate is unknown (≤ 0): counted, never folded into excessTotal. */
  unknownDepotCount: number;
  unknownDepotBottles: number;
  /** Σ bottles × rate paid — total retail spent at wine shops. */
  wineShopSpend: number;
  /** TGBCL depot spend from the store ledger (best-effort; 0 if none recorded). */
  depotSpend: number;
  /** How depotSpend was scoped, and on which day boundary — a share of spend
   *  nobody can trace is a share nobody trusts. */
  depotSpendBasis: string;
  /** depotSpend + wineShopSpend. */
  liquorSpend: number;
  /** wineShopSpend ÷ liquorSpend × 100. */
  wineShopSharePct: number;
  /** Σ money still owed to staff who fronted it — pending claims PLUS any claim
   *  whose payout was deleted (reimbursed with no petty_cash_id). */
  unreimbursedStaffSpend: number;
  /** Flags marked 'reimbursed' with no payout behind them (a deleted payout).
   *  Counted in unreimbursedStaffSpend; surfaced so a screen can explain why. */
  reopenedClaimCount: number;
  /** Flags in range dropped by the outlet filter — so a view can say "N not shown"
   *  instead of silently hiding a buy whose purchase carries no outlet. */
  hiddenByOutletCount: number;
  /** Count of flags per reimbursement status. */
  byStatus: Record<LqReimbursementStatus, number>;
  flagCount: number;
  totalBottles: number;
  rows: RetailFlagRow[];
}

/**
 * The §E numbers for the L5 Reconciliation Summary — THE function L5 should call,
 * so "wine-shop excess", "wine-shop share of spend" and "unreimbursed staff
 * spend" have ONE definition. Everything is computed from the recorded flags over
 * [from, to] using the flag's own (required, real) `date` — the column the L0
 * defect made mandatory precisely so this range filter is honest.
 *
 * The excess total EXCLUDES rows with an unknown depot rate (depot ≤ 0) and
 * counts them separately, so a buy we could not price never masquerades as a
 * zero-excess buy and understates the cost of running out.
 *
 * OPEN HANDOFF TO L5 (its file, not this one): src/lib/liquor-summary.ts:607-644
 * re-queries lq_retail_flags and re-derives these figures instead of calling
 * here. The two agree on the simple cases but not on the two rules added since:
 * that query folds unknown-depot rows in as ZERO excess, and it never selects
 * petty_cash_id, so it cannot tell a payout-backed close from a claim whose
 * payout was deleted — it will report ₹0 still owed where this function reports
 * the debt. Any change to these definitions has to land in both places until L5
 * calls this one.
 */
export function retailExcessSummary(
  db: Database,
  args: { from: string; to: string; outletId?: string | null; storeId?: string | null },
): RetailExcessSummary {
  const from = isRealDate(args.from) ? args.from : '0000-01-01';
  const to = isRealDate(args.to) ? args.to : '9999-12-31';
  const scoped = args.outletId != null && String(args.outletId).trim() !== '';

  const rows = db.prepare(`
    SELECT f.id, f.purchase_id, f.bill_ref, f.date, f.shop_name, f.shop_licence_no,
           f.bottles, f.rate_paid_per_bottle, f.depot_landed_per_bottle,
           f.excess_per_bottle, f.excess_total, f.excess_pct, f.paid_by, f.payment_mode,
           f.reimbursement_status, f.petty_cash_id, f.reason, f.approved_by,
           p.material_id AS material_id, rm.name AS material_name, p.outlet_id AS outlet_id
      FROM lq_retail_flags f
      LEFT JOIN purchases p     ON p.id = f.purchase_id
      LEFT JOIN raw_materials rm ON rm.id = p.material_id
     WHERE f.date >= ? AND f.date <= ?
       ${scoped ? "AND COALESCE(p.outlet_id, '') = ?" : ''}
     ORDER BY f.date DESC, f.created_at DESC
  `).all(...(scoped ? [from, to, String(args.outletId)] : [from, to])) as any[];

  // What the outlet filter dropped. A flag whose purchase carries no outlet
  // vanishes from an outlet-scoped view; the caller is told how many, so a screen
  // can offer "show all outlets" instead of quietly under-reporting.
  const inRange = scoped
    ? (db.prepare('SELECT COUNT(*) AS c FROM lq_retail_flags WHERE date >= ? AND date <= ?').get(from, to) as any)?.c ?? 0
    : rows.length;
  const hiddenByOutletCount = Math.max(0, Number(inRange) - rows.length);

  const byStatus: Record<LqReimbursementStatus, number> = {
    not_required: 0, claimed_pending: 0, reimbursed: 0, rejected: 0,
  };
  let excessTotal = 0, unknownDepotCount = 0, unknownDepotBottles = 0;
  let wineShopSpend = 0, unreimbursedStaffSpend = 0, totalBottles = 0, reopenedClaimCount = 0;

  const outRows: RetailFlagRow[] = rows.map((f) => {
    const bottles = Number(f.bottles) || 0;
    const paid = r2(bottles * (Number(f.rate_paid_per_bottle) || 0));
    const depot = Number(f.depot_landed_per_bottle) || 0;
    totalBottles += bottles;
    wineShopSpend += paid;
    if (depot > 0) excessTotal += Number(f.excess_total) || 0;
    else { unknownDepotCount += 1; unknownDepotBottles += bottles; }
    const status = (LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(f.reimbursement_status)
      ? (f.reimbursement_status as LqReimbursementStatus) : 'not_required';
    byStatus[status] += 1;
    // Still owed = a pending claim, OR a claim marked reimbursed with no payout
    // behind it. The second case is a payout that was deleted: the FK nulls
    // petty_cash_id (its DDL comment: "deleting the petty-cash payout must reopen
    // the claim") and the debt is real again. Reporting ₹0 owed on it was the
    // whole point of the leak.
    const reopened = status === 'reimbursed' && !f.petty_cash_id;
    if (reopened) reopenedClaimCount += 1;
    if (status === 'claimed_pending' || reopened) unreimbursedStaffSpend += paid;
    return {
      id: f.id, purchase_id: f.purchase_id, bill_ref: f.bill_ref, date: f.date,
      shop_name: f.shop_name, shop_licence_no: f.shop_licence_no, bottles,
      rate_paid_per_bottle: Number(f.rate_paid_per_bottle) || 0, depot_landed_per_bottle: depot,
      excess_per_bottle: Number(f.excess_per_bottle) || 0, excess_total: Number(f.excess_total) || 0,
      excess_pct: Number(f.excess_pct) || 0, paid_by: f.paid_by, payment_mode: f.payment_mode,
      reimbursement_status: status, petty_cash_id: f.petty_cash_id, reason: f.reason,
      approved_by: f.approved_by, material_id: f.material_id ?? null,
      material_name: f.material_name ?? null, outlet_id: f.outlet_id ?? null, total_paid: paid,
    };
  });

  /* TGBCL DEPOT SPEND — the denominator under "wine-shop share of liquor spend".
   *
   * Three things were wrong with the first version of this query, all of them
   * measured, and all of them in the denominator of a headline figure:
   *   (a) it JOINed store_category_map with NO store predicate, so a category
   *       mapped by two stores multiplied every ledger row (the multi-floor-bar
   *       design adds receiving stores, and UNIQUE(store_id, category) makes two
   *       mappings of `bar` perfectly legal). The ledger row ALREADY carries
   *       store_id — the join was never needed, only the filter.
   *   (b) it counted txn_type 'opening' as spend. An opening balance is the
   *       migrate route's cutover posting of existing stock, not money spent;
   *       one such row added ₹2,479.73 of phantom depot spend on the copy.
   *       Every depot procurement path writes 'purchase' (procure, procure-bill,
   *       procure-bulk) — the same basis L1 derives landed cost from.
   *   (c) it cut days on UTC, where storeStock/floorReconciliation use the IST
   *       business day (store-engine.ts:1700, date(created_at,'+330 minutes')).
   *
   * SCOPE, without a name literal: the stores are the ones the flags' OWN
   * materials belong to (materialStoreId), or an explicit storeId. If neither
   * resolves, depotSpend is 0 and depotSpendBasis says so — honest, not wrong.
   * NOT outlet-scoped: store_stock_ledger has no outlet column. */
  let depotSpend = 0;
  let depotSpendBasis = 'no depot indent lines in range';
  const storeIds = new Set<string>();
  if (args.storeId != null && String(args.storeId).trim() !== '') {
    storeIds.add(String(args.storeId));
  } else {
    for (const mid of new Set(outRows.map((r) => r.material_id).filter(Boolean) as string[])) {
      const m = db.prepare('SELECT category FROM raw_materials WHERE id = ?').get(mid) as any;
      const sid = m ? materialStoreId(db, m) : null;
      if (sid) storeIds.add(sid);
    }
  }
  if (storeIds.size) {
    try {
      const ids = [...storeIds];
      const depotRow = db.prepare(`
        SELECT COALESCE(SUM(l.quantity * l.unit_cost), 0) AS v, COUNT(*) AS n
          FROM store_stock_ledger l
         WHERE l.store_id IN (${ids.map(() => '?').join(',')})
           AND l.txn_type = 'purchase' AND l.quantity > 0
           AND date(l.created_at, '+330 minutes') >= date(?)
           AND date(l.created_at, '+330 minutes') <= date(?)
      `).get(...ids, from, to) as any;
      depotSpend = r2(Number(depotRow?.v) || 0);
      depotSpendBasis = `store_stock_ledger txn_type='purchase' over ${ids.length} store(s), `
        + `${Number(depotRow?.n) || 0} line(s), IST day on created_at (the ledger has no date column)`;
    } catch { depotSpend = 0; depotSpendBasis = 'depot spend unavailable'; }
  } else {
    depotSpendBasis = 'no liquor store resolved from the flags in range — depot spend not counted';
  }

  wineShopSpend = r2(wineShopSpend);
  const liquorSpend = r2(depotSpend + wineShopSpend);
  return {
    from, to,
    excessTotal: r2(excessTotal),
    unknownDepotCount, unknownDepotBottles: r4(unknownDepotBottles),
    wineShopSpend, depotSpend, depotSpendBasis, liquorSpend,
    wineShopSharePct: liquorSpend > 0 ? r2((wineShopSpend / liquorSpend) * 100) : 0,
    unreimbursedStaffSpend: r2(unreimbursedStaffSpend),
    reopenedClaimCount, hiddenByOutletCount,
    byStatus, flagCount: outRows.length, totalBottles: r4(totalBottles), rows: outRows,
  };
}
