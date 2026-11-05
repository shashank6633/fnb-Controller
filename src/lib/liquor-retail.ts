import type { Database } from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { materialStoreId, getStoreById, postLedger } from '@/lib/store-engine';
import {
  LQ_REIMBURSEMENT_STATUS,
  landedCostPerBottleExplained,
  landedFromIndentLine,
  type LqReimbursementStatus,
} from '@/lib/liquor-recon';
import { CASH_CATEGORY } from '@/lib/cash-purchase';
import { toPaise, toRupees, fmtRs, outflowWarning, MAX_PAISE } from '@/lib/petty-cash';
import { todayIST } from '@/lib/format-date';
import { vendorParty } from '@/lib/movement-record';
import { packFactor, entryMode } from '@/lib/pack-units';

/** Units that are themselves a COUNT — a fraction of one is not a purchase.
 *  The same list the Liquor Store modal's countedWhole() uses (page.tsx). */
const COUNTED_UNITS = new Set([
  'pcs', 'pc', 'nos', 'no', 'each', 'unit', 'units', 'btl', 'bottle', 'bottles',
  'can', 'cans', 'case', 'cases', 'box', 'boxes', 'pkt', 'packet', 'packets',
  'pack', 'packs', 'tin', 'tins', 'jar', 'jars',
]);

/**
 * LIQUOR PURCHASE RECONCILIATION — phase L3, EMERGENCY WINE-SHOP PURCHASES.
 * Plan: docs/liquor-reconciliation-plan.md §L3. Contract: src/lib/liquor-recon.ts.
 *
 * ── WHAT A WINE-SHOP BUY IS, AND WHY IT NEEDS ITS OWN WRITER ─────────────────
 * When the TGBCL depot runs dry mid-service, staff run to a local wine shop and
 * buy bottles at retail (MRP), well above the depot's landed cost. Those bottles
 * are a REAL receipt: the stock must move so the bar can pour them. The excess
 * over depot landed cost — "the price of running out" — plus who fronted the
 * money and whether they were paid back, are the facts §E of the Summary reports.
 *
 * ── WHERE THE STOCK GOES: WHERE LIQUOR LIVES ────────────────────────────────
 * Liquor stock lives in its store's ledger (store_stock_ledger) — that is what
 * Liquor Store on-hand, withdrawals and closing counts all read. So a wine-shop
 * buy posts ONE store_stock_ledger row into the material's OWN store, and moves
 * nothing central. The row is shaped so it can change NOTHING but the quantity:
 *
 *   · txn_type 'inward', NOT 'purchase'. Every depot reader keys on 'purchase':
 *     L1's landedCostPerBottle (the figure the excess is measured against), the
 *     GRN Inward register, the Rate Movement drift card, the per-invoice levy
 *     checks. A retail buy in any of them would poison exactly the depot record
 *     this module measures against.
 *   · unit_cost 0. Every store valuation (storeStock, consolidatedStock, the
 *     transfer cost map) averages ONLY inflow rows with unit_cost > 0, so the
 *     bottles are valued at the store's EXISTING recorded basis — never at MRP.
 *     The L0 rule says the same thing for landed cost: never written back to
 *     store_stock_ledger.unit_cost.
 *
 * ── WHY THERE IS NO `purchases` ROW ANY MORE ───────────────────────────────
 * The first version wrote a documentary central `purchases` row (is_emergency=1)
 * and moved central current_stock. Measured on a copy: the retail MRP became
 * closing-valuation's rung-#1 rate at once (₹4,299.99 → ₹4,500/BTL, +₹4,800 on
 * 18,000 ml) and average_price on the next Recompute (5.7333 → 6.0 ₹/ml), and
 * the bottles never reached the Liquor Store ledger. Every reader of `purchases`
 * (updateMaterialPrice, materialRate/rateMap, the LPP boot backfill, cost
 * spikes) consumes it with no exclusion, and the store-procure house rule is the
 * same: "store purchases live ONLY in the store ledger. NO purchases row".
 * Owner decision 1 — the retail price is ANALYTICS ONLY — is therefore met by
 * construction: the retail ₹ is written in exactly one place, lq_retail_flags,
 * which no rate, valuation or costing reader touches. closing-valuation.ts is
 * not edited and needs no exclusion, because there is nothing to exclude.
 *
 * ── THE FOUR EXCESS FIGURES ARE FROZEN AT ENTRY ─────────────────────────────
 * depot landed cost moves with every later indent; re-pricing last quarter's
 * emergency buy would make §E unreadable. So depot_landed_per_bottle and the
 * three excess figures are computed once, here, and stored — exactly as the
 * schema comment on lq_retail_flags demands.
 *
 * The only tables this module writes are store_stock_ledger (ONE 'inward' row,
 * unit_cost 0), lq_retail_flags, petty_cash_ledger (a reimbursement payout) and
 * audit_events. It never writes `purchases`, inventory_transactions,
 * raw_materials, or any price column.
 *
 * LEGACY ROWS: a flag written by the first version has purchase_id set and its
 * stock in central current_stock; it stays readable (material and outlet are
 * read off it, backfilled by db.ts from its purchase), and nothing new is ever
 * written that way.
 *
 * ── A BUY THE COUNT ALREADY HOLDS IS COST ONLY (owner ruling 39, 2026-10-14) ─
 * A store count's variance is FROZEN when the count is saved: approveVariance()
 * posts the stored figure, it never re-works it. A wine-shop buy typed AFTER a
 * count that already found its bottles on the shelf (the usual order for an
 * emergency run made during service and keyed in next morning) would land on
 * top of that count's excess and book the same bottles twice. Measured on a
 * copy: count +2 BTL pending, buy typed → book 4500, approve → 6000 against a
 * shelf of 4500; with the auto-apply bar on the count applied itself, the late
 * buy added +2 BTL and the next count wrote off a phantom −2 BTL.
 *
 * So a buy dated ON OR BEFORE a saved count of the same item at the same store
 * whose variance is PENDING or APPLIED (by a person, or by the bar at count
 * time) is refused FOR STOCK and kept as a COST-ONLY record — the same
 * variance_approvals test withdrawals use (liquor-withdrawals.ts countConflict,
 * codes count_pending / count_applied). The money side is untouched: the flag,
 * the rate paid, the frozen excess and the claim are written exactly as for any
 * buy, because the money really was spent. Only the store_stock_ledger row is
 * not written; the bottles reach the book through the count (applied: already
 * there; pending: when approved; rejected afterwards: through the next count
 * that finds them on the shelf).
 *   · A count that MATCHED the book has no approval row and is NOT a conflict.
 *     The shelf held these bottles and the book did not, yet they agreed — so
 *     an equal quantity left unrecorded. Booking the buy is what surfaces that
 *     real loss on the next count; it is not a second copy of the bottles.
 *   · A REJECTED count moved nothing, so it is not a conflict either.
 * The flag still needs an anchor (the lq_retail_flags CHECK: purchase_id, or
 * material_id AND ledger_id). A cost-only buy made no ledger row, so its
 * ledger_id is the COUNT it deferred to — `count:<count date>:<flag id>`
 * (COST_ONLY_ANCHOR_PREFIX). ledger_id has no FK and no reader joins it; every
 * reader in this file reports such a row as cost_only with ledger_id null, so
 * nothing downstream can mistake the anchor for a ledger row.
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n: number) => Math.round((Number(n) || 0) * 1e4) / 1e4;

/** lq_retail_flags.ledger_id on a COST-ONLY buy starts with this — the anchor
 *  is the count the buy deferred to, not a ledger row (see the header). */
export const COST_ONLY_ANCHOR_PREFIX = 'count:';

/** true when a flag's ledger_id is a cost-only anchor (no stock was booked). */
export function isCostOnlyAnchor(ledgerId: unknown): boolean {
  return typeof ledgerId === 'string' && ledgerId.startsWith(COST_ONLY_ANCHOR_PREFIX);
}

/** The count date a cost-only anchor names (`count:<YYYY-MM-DD>:<flag id>`),
 *  or null when the anchor is not a cost-only one / carries no real date. */
export function costOnlyCountDate(ledgerId: unknown): string | null {
  if (!isCostOnlyAnchor(ledgerId)) return null;
  const d = String(ledgerId).slice(COST_ONLY_ANCHOR_PREFIX.length, COST_ONLY_ANCHOR_PREFIX.length + 10);
  return isRealDate(d) ? d : null;
}

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
  const ov = Number(args.override);
  const typed = Number.isFinite(ov) && ov > 0 ? r2(ov) : null;
  if (explained.value && Number.isFinite(explained.value.landedPerBottle) && explained.value.landedPerBottle > 0) {
    // NO INDENT BY THIS DATE + A TYPED FIGURE → THE TYPED FIGURE. The master
    // fallback is TGBCL's ₹ per BOTTLE, and the form tells the operator to type
    // the ₹ per purchase unit instead when a unit of the item is not a single
    // bottle. Throwing that figure away for the master (measured: ₹950 typed,
    // ₹800 used, excess ₹300 not ₹150, nothing said) made the form's advice a
    // lie. A rate PAID on a recorded indent still wins over anything typed.
    if (typed != null && explained.value.basis === 'master_only') {
      return { perBottle: typed, source: 'override', detail: 'manual depot rate (no TGBCL indent of this item is recorded by this date, so the Brand Map master was not used)' };
    }
    return { perBottle: r2(explained.value.landedPerBottle), source: 'landed', detail: explained.value.basis };
  }
  // NO SINGLE BRAND MAP PACK, BUT INDENTED → THE INDENT LINE ALONE, exactly as
  // a withdrawal is priced (resolveLandedUnitCost's 'indent_landed'). The line
  // carries its own rate paid and its own share of the levies; neither needs
  // the Brand Map. Without this the same bottle was ₹85.30 landed on a
  // withdrawal and "unknown" on a wine-shop buy, and dropped out of §E.
  let ind: ReturnType<typeof landedFromIndentLine> = null;
  try {
    ind = landedFromIndentLine(db, { materialId: args.materialId, storeId: args.storeId || undefined, asOf: args.asOf || undefined });
  } catch { ind = null; }
  if (ind && Number.isFinite(ind.landedPerBottle) && ind.landedPerBottle > 0) {
    return { perBottle: r2(ind.landedPerBottle), source: 'landed', detail: 'latest_indent' };
  }
  if (typed != null) {
    return { perBottle: typed, source: 'override', detail: `manual depot rate (L1: ${explained.reason})` };
  }
  return { perBottle: null, source: 'unknown', detail: explained.reason };
}

/* ── Record a wine-shop purchase (store-ledger stock + flag, ONE txn) ────────*/

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
  /**
   * May the DUPLICATE refusal quote the earlier buy's bottles and rate paid?
   * Pass true only for a viewer the register admits (the route passes
   * canReadRetailRegister — management AND a page that shows it, the GET
   * gate's own test). A colleague's retail rate is §E money, read on that
   * register, and the duplicate key (material, shop, bill no., date) is on the
   * store ledger every can_procure user reads — so quoting it handed that money
   * to bar staff. Fail closed: anything but true withholds, except that a
   * caller is always told the figures of a buy THEY recorded (their own input).
   */
  revealOtherBuyFigures?: boolean;
  /**
   * May the COST-ONLY sentence state the count's status and variance? Admin
   * only (pass role === 'admin'): BLIND COUNTS — a count's system figure and
   * variance are admin-only on every surface (stores/[id]/closing returns them
   * as null to everyone else), and a variance in bottles re-derives the system
   * figure. Fail closed.
   */
  revealCountFigures?: boolean;
}

/** Why a buy was kept as COST ONLY (ruling 39) — the count that already holds it. */
export interface WineShopStockRefusal {
  /** The withdrawal rule's own codes: the count is applied, or awaiting approval. */
  code: 'count_applied' | 'count_pending';
  /** The code this VIEWER may be told: the status for an admin, 'counted' otherwise. */
  viewerCode: 'count_applied' | 'count_pending' | 'counted';
  /** The count's business date (YYYY-MM-DD). */
  countDate: string;
  /** When that count was last saved, IST 'YYYY-MM-DD HH:MM' ('' if unknown). */
  countSavedAt: string;
  /** variance_approvals.id of that count. */
  approvalId: string;
  autoApplied: boolean;
  /** Signed variance in purchase units ('+2 BTL'). ADMIN-ONLY — blind counts. */
  varianceText: string;
  /** The sentence for THIS viewer (count status/variance only when revealCountFigures). */
  message: string;
}

export interface WineShopRecordResult {
  /** Always null on a new buy — no central purchases row is written (see header). */
  purchaseId: null;
  flagId: string;
  /** The store_stock_ledger 'inward' row that moved the stock; null on a
   *  COST-ONLY buy (stockBooked false — no ledger row was written). */
  ledgerId: string | null;
  /** The store the bottles were booked into (the material's own store). */
  storeId: string;
  storeName: string;
  /** Recipe units added to that store's ledger (0 on a COST-ONLY buy). */
  stockQty: number;
  /** false → COST ONLY: a saved count already holds these bottles (ruling 39). */
  stockBooked: boolean;
  /** Present exactly when stockBooked is false. */
  stockRefusal?: WineShopStockRefusal;
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
 * excess against a bar; a stock movement with no flag would be an untracked
 * retail buy. better-sqlite3 is synchronous, so the read-then-write inside the
 * transaction is indivisible within this process.
 */
export function recordWineShopPurchase(
  db: Database,
  input: RecordWineShopInput,
  actorEmail: string,
): WineShopRecordResult {
  const mat = db.prepare(
    'SELECT id, name, category, unit, purchase_unit, pack_size, case_size, current_stock FROM raw_materials WHERE id = ?',
  ).get(input.materialId) as any;
  if (!mat) throw new RetailError('Material not found.', 404, 'material_not_found');

  // This route is liquor-only: the whole point is the depot-vs-retail excess.
  // A non-store material has no depot landed cost to compare against and belongs
  // on the ordinary purchase flow.
  if (materialStoreId(db, mat) !== input.storeId) {
    throw new RetailError(`"${mat.name}" is not a material of this liquor store — an emergency wine-shop buy is for a store-mapped liquor item.`, 400, 'not_store_material');
  }
  const store = getStoreById(db, input.storeId);
  if (!store) throw new RetailError('That liquor store no longer exists.', 404, 'store_not_found');
  if (!store.is_active) {
    throw new RetailError(`${store.name} is deactivated — reactivate it before booking stock into it.`, 409, 'store_inactive');
  }

  // NOT YET MIGRATED: an item whose stock still sits in CENTRAL (it predates the
  // store) and has never had a store-ledger row. Booking the wine-shop bottles
  // into the store now would give it "store history", and /api/stores/[id]/migrate
  // skips any item with store history — stranding the central stock, reachable
  // only by a hand Adjustment. Refuse, and name the one-step fix instead.
  const centralQty = Number(mat.current_stock) || 0;
  if (centralQty > 0) {
    const hist = db.prepare(
      'SELECT 1 FROM store_stock_ledger WHERE store_id = ? AND material_id = ? LIMIT 1',
    ).get(input.storeId, input.materialId);
    if (!hist) {
      throw new RetailError(
        `"${mat.name}" still holds ${centralQty} ${String(mat.unit || '').trim() || 'units'} in Central stock and has never been moved into ${store.name}. `
        + `Recording this buy into ${store.name} now would strand that Central stock (Migrate skips any item that already has store history). `
        + `Ask an admin to run Migrate on ${store.name} for this item first, then record the wine-shop buy. Nothing was saved.`,
        409, 'not_migrated',
      );
    }
  }

  const bottles = Number(input.bottles);
  if (!Number.isFinite(bottles) || bottles <= 0) throw new RetailError('bottles must be a number greater than 0.');
  const rate = Number(input.ratePaidPerBottle);
  if (!Number.isFinite(rate) || rate <= 0) throw new RetailError('rate paid per bottle must be a number greater than 0.');
  if (!isRealDate(input.date)) throw new RetailError('date must be a real calendar date in YYYY-MM-DD.');
  // NOT IN THE FUTURE — for anyone, admins included. The route's purchase-date
  // window exempts admins entirely (purchase-guard.ts), and that exemption is
  // for BACKDATING. A wine-shop run is an event that has already happened, and
  // the bottles now land on a store ledger whose row is dated from this field:
  // a future date would put stock on a day that has not arrived, ahead of every
  // IST-day reconciliation. The payout path refuses a future date the same way.
  if (input.date > todayIST()) {
    throw new RetailError(`The buy date ${input.date} is in the future — record a wine-shop buy on the day the bottles were bought. Nothing was saved.`, 400, 'future_date');
  }

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

  // Purchase units → recipe units, the house pack convention (packFactor — the
  // same helper /api/stores/[id]/procure and every DualQty screen use): the
  // store ledger quantity is RECIPE units (ml for a spirit), the bill count is
  // PURCHASE units (BTL).
  const ru = String(mat.unit || '').toLowerCase().trim();
  const pu = String(mat.purchase_unit || mat.unit || '').toLowerCase().trim();
  const stockQty = bottles * packFactor(mat);
  /** The material's OWN purchase-unit label, for any sentence that names a rate. */
  const purchaseUnitLabel = String(mat.purchase_unit || mat.unit || 'unit').trim() || 'unit';

  // A COUNTED VESSEL IS BOUGHT WHOLE. The stock now lands on the store ledger
  // that closing counts are taken against, so half a bottle posted here is half
  // a bottle the count can never find — a manufactured variance. The Liquor
  // Store modal already refuses a fraction for these items (page.tsx
  // countedWhole); this is the server half it asked for, with the SAME test:
  // a pack or a case behind the unit, a container purchase unit, or a unit that
  // is itself a count. kg / g / L / ml lines stay fractional — 2.5 is real there.
  const countedVessel = entryMode(mat) !== 'plain' || ru !== pu || COUNTED_UNITS.has(pu);
  if (countedVessel && !Number.isInteger(bottles)) {
    throw new RetailError(
      `"${mat.name}" is bought by the ${purchaseUnitLabel} — enter a whole number of ${purchaseUnitLabel} (got ${bottles}). Nothing was saved.`,
      400, 'whole_units_only',
    );
  }

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
  // The flag carries its own material/outlet now; a LEGACY flag carries them on
  // its parent purchases row — COALESCE reads either, so a retry of a buy first
  // recorded under the old design is still caught.
  const dupe = db.prepare(`
    SELECT f.id, f.bottles, f.rate_paid_per_bottle, f.date, f.bill_ref, f.recorded_by
      FROM lq_retail_flags f
      LEFT JOIN purchases p ON p.id = f.purchase_id
     WHERE COALESCE(f.material_id, p.material_id) = ?
       AND f.date = ?
       AND COALESCE(f.outlet_id, p.outlet_id, '') = COALESCE(?, '')
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
    // THE EARLIER BUY'S FIGURES ARE QUOTED ONLY TO WHOEVER MAY READ THEM. The
    // bill-number match is keyed on facts every can_procure user reads off the
    // store ledger (material, shop = supplier, bill = ref, date), so quoting the
    // matched row's bottles and rate paid handed a COLLEAGUE's retail price to
    // bar staff outside management — the same leak the PATCH path closed by
    // returning the excess only to a viewer the register admits
    // (retail/[id]/route.ts; both use canReadRetailRegister). The rate paid is
    // §E money, shown on that register. The caller's OWN earlier buy is still
    // quoted: those figures are their own input.
    // (The blank-bill branch below quotes only the caller's own figures — its
    // match requires the same bottles and rate the caller just sent.)
    const ownBuy = String(dupe.recorded_by || '').trim().toLowerCase() === String(actorEmail || '').trim().toLowerCase()
      && String(actorEmail || '').trim() !== '';
    const quoteDupe = input.revealOtherBuyFigures === true || ownBuy;
    throw new RetailError(
      billRef
        ? `"${mat.name}" is already recorded on wine-shop bill ${billRef} from ${shopName || 'this shop'} dated ${input.date}`
          + (quoteDupe
            ? ` — ${dupe.bottles} ${purchaseUnitLabel} at ${fmtRs(toPaise(Number(dupe.rate_paid_per_bottle)))} each. `
            : ' (its bottles and rate paid are on the Wine-shop buys register, which management can open). ')
          + `Nothing was saved; if you are re-trying after a failed save, that buy is already in.`
        : `An identical wine-shop buy (${bottles} ${purchaseUnitLabel} × "${mat.name}" at ${fmtRs(toPaise(rate))} each from ${shopName || 'this shop'} on ${input.date}) `
          + `was recorded moments ago. Nothing was saved. If the bottles really were bought twice, enter the shop's bill number to record the second run.`,
      409, 'duplicate',
    );
  }

  const flagId = generateId();
  let ledgerId = '';
  const today = todayIST();

  /* ── ALREADY COUNTED? (ruling 39 — see the header) ──────────────────────────
   * The statement is prepared here and RUN INSIDE the IMMEDIATE transaction
   * below, exactly as liquor-withdrawals.ts runs its countConflictStmt: a count
   * saved by another process cannot slip in between the check and the write.
   * Same predicate as the withdrawal rule: this store, this item, a count dated
   * ON OR AFTER the buy's date, status pending or approved (approved includes a
   * count the bar applied at save time — auto_applied 1). An applied count is
   * named first: it is the one that already put the bottles on the book. */
  const countConflictStmt = db.prepare(`
    SELECT va.id, va.date, va.status, va.variance, va.auto_applied,
           COALESCE(
             (SELECT strftime('%Y-%m-%d %H:%M', c.created_at, '+330 minutes')
                FROM store_closing_counts c
               WHERE c.store_id = va.store_id AND c.material_id = va.material_id AND c.date = va.date
               LIMIT 1),
             strftime('%Y-%m-%d %H:%M', va.created_at, '+330 minutes'),
             ''
           ) AS saved_at
      FROM variance_approvals va
     WHERE va.source = 'liquor' AND va.store_id = ? AND va.material_id = ? AND va.date >= ?
       AND va.status IN ('pending', 'approved')
     ORDER BY CASE va.status WHEN 'approved' THEN 0 ELSE 1 END, va.date DESC, va.created_at DESC
     LIMIT 1
  `);
  const revealCount = input.revealCountFigures === true;
  const stockRefusalFor = (
    c: { id: string; date: string; status: string; variance: number; auto_applied: number; saved_at: string },
  ): WineShopStockRefusal => {
    const pf = packFactor(mat) || 1;
    const v = Number(c.variance) || 0;
    const varianceText = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round((Math.abs(v) / pf) * 1000) / 1000} ${purchaseUnitLabel}`;
    const code: WineShopStockRefusal['code'] = c.status === 'approved' ? 'count_applied' : 'count_pending';
    const auto = Number(c.auto_applied) === 1;
    const savedAt = String(c.saved_at || '');
    // What the count did — ADMIN ONLY (blind counts: status and variance reveal
    // the system figure). Everyone else is told which count, and when.
    const how = !revealCount
      ? ' The bottles reach the book through that count, never through this buy.'
      : code === 'count_applied'
        ? ` That count has already been applied (${varianceText}${auto ? ', applied at count time under the variance bar' : ''}), `
          + 'so the book was set to what was on the shelf — these bottles included.'
        : ` That count is waiting in Variance Approvals (${varianceText}); approving it puts these bottles on the book. `
          + 'If it is rejected instead, the next count that finds them on the shelf carries them.';
    const message =
      `Recorded as COST ONLY — no stock was added. ${store.name}'s closing count of ${mat.name} for ${c.date}`
      + `${savedAt ? ` (saved ${savedAt} IST)` : ''} already includes these bottles, so adding them to the book as well `
      + `would count them twice.${how} `
      + `The money side — ${fmtRs(toPaise(totalPaid))} paid, who paid it and any claim — is recorded as usual. `
      + `If the bottles were in fact bought after that count was taken, the next count finds them and puts them on the book; `
      + `do not record this buy again.`;
    return {
      code, viewerCode: revealCount ? code : 'counted',
      countDate: String(c.date), countSavedAt: savedAt, approvalId: String(c.id),
      autoApplied: auto, varianceText, message,
    };
  };
  let stockRefusal: WineShopStockRefusal | undefined;

  const run = db.transaction(() => {
    // 0. ALREADY COUNTED → COST ONLY. Decided inside the write lock. Nothing
    //    else about the record changes: the flag, its frozen excess, the claim
    //    and the audit row are written below exactly as for a booked buy.
    const conflict = countConflictStmt.get(input.storeId, input.materialId, input.date) as
      { id: string; date: string; status: string; variance: number; auto_applied: number; saved_at: string } | undefined;
    stockRefusal = conflict ? stockRefusalFor(conflict) : undefined;

    if (stockRefusal) {
      // No ledger row. The anchor names the count the buy deferred to (the
      // lq_retail_flags CHECK needs one); see COST_ONLY_ANCHOR_PREFIX.
      ledgerId = `${COST_ONLY_ANCHOR_PREFIX}${stockRefusal.countDate}:${flagId}`;
    } else {
      // 1. THE STOCK MOVEMENT — ONE row on the store's own ledger, where Liquor
      //    Store on-hand, withdrawals and closing counts read it. 'inward' (not
      //    'purchase', which every DEPOT reader keys on) and unit_cost 0 (so every
      //    store valuation keeps its existing basis) — see the header. Nothing
      //    central moves: no purchases row, no inventory_transactions, no
      //    current_stock, no price column. postLedger is the only door stock uses.
      //
      //    MOVEMENT RECORD: still a VENDOR receipt (the shop is the source, the
      //    store the destination) on the buy's own business date. SPREAD IN, NOT
      //    WRITTEN AS LITERAL KEYS, on purpose: counterparty and txn_date belong to
      //    the store-rail movement-record work in store-engine.ts, which is NOT part
      //    of Liquor Reconciliation and ships on its own. With that work in,
      //    postLedger writes both into the movement columns. Without it
      //    (production store-engine) LedgerEntry has neither field and the rail has
      //    no column for them, so postLedger ignores them and nothing else about
      //    the row changes; the stock DATE never depends on txn_date, because the
      //    backdate below sets created_at itself. As literal keys they failed
      //    type-checking against production store-engine (TS2353 'counterparty'),
      //    which tied a liquor ship to those non-liquor hunks.
      const movementRecord = {
        counterparty: vendorParty(shopName || 'wine shop'),
        txn_date: input.date,
      };
      ledgerId = postLedger(db, {
        store_id: input.storeId,
        material_id: input.materialId,
        txn_type: 'inward',
        quantity: stockQty,
        unit_cost: 0,
        supplier: shopName,
        ref: billRef,
        notes: `Emergency wine-shop buy${shopName ? ` from ${shopName}` : ''} — retail price is on the wine-shop register (lq_retail_flags ${flagId}), never a cost basis`.slice(0, 500),
        created_by: actorEmail,
        ...movementRecord,
      });
      // BACKDATE, on BOTH day boundaries. Every IST-day reader of this ledger
      // (floor reconciliation, the §H denominator, depot spend) buckets on
      // date(created_at, '+330 minutes'); the closing count's system figure is
      // date(created_at) <= count date — the UTC day (stores/[id]/closing
      // asOfStats). A buy keyed in today for yesterday must land on yesterday
      // on both: the instant is the buy's date at the current IST time-of-day,
      // but never earlier than 05:30 IST (00:00 UTC) — the withdrawal's rule
      // (liquor-withdrawals.ts postWithdrawalStock). Without the floor, a buy
      // keyed in between 00:00 and 05:30 IST (right after close, the natural
      // time to key last night's run) sat on the PREVIOUS UTC day, inside the
      // earlier day's count window, and a re-saved count of that day read a
      // false shortage. A buy for TODAY keeps `now`, like every other writer.
      if (input.date !== today) {
        db.prepare(`
          UPDATE store_stock_ledger
             SET created_at = datetime(? || ' ' || MAX('05:30:00', strftime('%H:%M:%S', 'now', '+330 minutes')), '-330 minutes')
           WHERE id = ?
        `).run(input.date, ledgerId);
      }
    }

    // 2. THE SIDE RECORD — the flag. The ONLY place the retail ₹ is written. It
    //    names the stock movement (ledger_id) rather than repeating it — or, on
    //    a COST-ONLY buy, the count that holds the bottles. The four excess
    //    figures are frozen above, for both kinds: the money was spent either way.
    db.prepare(`
      INSERT INTO lq_retail_flags
        (id, purchase_id, material_id, ledger_id, outlet_id, bill_ref, date, shop_name, shop_licence_no, bottles,
         rate_paid_per_bottle, depot_landed_per_bottle, excess_per_bottle,
         excess_total, excess_pct, paid_by, payment_mode, reimbursement_status,
         reason, approved_by, recorded_by)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      flagId, input.materialId, ledgerId, input.outletId ?? null, billRef, input.date,
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
        ledger_id: stockRefusal ? null : ledgerId, store_id: input.storeId, store: store.name,
        material_id: input.materialId, material: mat.name, stock_qty: stockRefusal ? 0 : stockQty, recipe_unit: mat.unit,
        // Ruling 39: the full facts of the count the buy deferred to. /audit is
        // admin-only, so the count's status and variance may be stated here.
        stock_booked: !stockRefusal,
        ...(stockRefusal ? {
          cost_only: {
            anchor: ledgerId, code: stockRefusal.code, count_date: stockRefusal.countDate,
            count_saved_at_ist: stockRefusal.countSavedAt, approval_id: stockRefusal.approvalId,
            auto_applied: stockRefusal.autoApplied, variance: stockRefusal.varianceText,
            bottles_not_booked: bottles, qty_not_booked: stockQty,
          },
        } : {}),
        brand: String(input.brand || '').slice(0, 200) || undefined, notes: String(input.notes || '').slice(0, 500) || undefined,
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
        + (depotPerBottle > 0 ? ` — excess ${fmtRs(toPaise(excess.excessTotal))} (${excess.excessPct}%)` : ' — depot rate unknown')
        + (stockRefusal
          ? ` — COST ONLY, no stock added: ${store.name}'s ${stockRefusal.countDate} count`
            + `${stockRefusal.countSavedAt ? ` (saved ${stockRefusal.countSavedAt} IST)` : ''} already holds these bottles`
            + ` (${stockRefusal.code === 'count_applied' ? 'applied' : 'pending'}, ${stockRefusal.varianceText})`
          : ''),
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
    purchaseId: null, flagId,
    // A cost-only anchor is never handed out as a ledger id.
    ledgerId: stockRefusal ? null : ledgerId,
    storeId: input.storeId, storeName: store.name,
    stockQty: stockRefusal ? 0 : stockQty,
    stockBooked: !stockRefusal,
    ...(stockRefusal ? { stockRefusal } : {}),
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
 * The outlet is the flag's own outlet_id (a legacy flag's was backfilled from
 * its parent purchase). Passing the session outlet let a Main claim be paid out
 * of Branch 2's box while §E, which scopes on the claim's outlet, reported it
 * reimbursed against Main — two books that can never be reconciled.
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
 * way src/lib/cash-purchase.ts writes the GRN money leg. Its link to the claim
 * is lq_retail_flags.petty_cash_id. purchase_id is set only for a LEGACY flag
 * (one anchored on a central purchases row); a new flag has no purchases row,
 * so the payout's purchase_id is NULL.
 */
export function closeReimbursementWithPettyCash(
  db: Database,
  args: {
    flagId: string; actorEmail: string; outletId: string | null; date?: string; notes?: string; amountOverride?: number | null;
    /**
     * May the amount-mismatch refusal say HOW the owed total is made up
     * (bottles × rate paid)? Pass canReadRetailRegister for the caller — the
     * predicate the POST duplicate refusal uses. The reimburse gate admits the
     * petty-cash payer (Management or the Store Manager, with the petty-cash
     * page), who need not be able to read the register, and the rate paid per
     * bottle is register money. The owed TOTAL is always given: it is the
     * figure the payer has to pay. Fail closed.
     */
    revealBreakdown?: boolean;
  },
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
      const breakdown = args.revealBreakdown === true
        ? ` (${flag.bottles} × ${fmtRs(toPaise(Number(flag.rate_paid_per_bottle)))})`
        : '';
      throw new RetailError(
        `A payout closes a wine-shop claim only in full. ${fmtRs(toPaise(owed))} is owed${breakdown}, `
        + `but ${fmtRs(toPaise(r2(asked)))} was sent. `
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

  // The CLAIM's outlet (its own column; a legacy flag's parent purchase as a
  // second source), falling back to the caller's session only when neither
  // carries one (single-outlet installs).
  const outletId: string | null = flag.outlet_id ?? flag.purchase_outlet_id ?? args.outletId ?? null;

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
     *   (a) a payout that is ALREADY THIS CLAIM'S, by its document identity:
     *       · LEGACY flag — any 'out' row pointing at its purchase (exact);
     *       · NEW flag (no purchases row, so `purchase_id = NULL` would match
     *         nothing and the guard would sit there never firing) — an 'out'
     *         row for this bill: same shop as vendor, same bill number as
     *         reference, same amount, ANY date, and not already the payout of
     *         another claim (two lines of one trip share a bill number). Only
     *         when the bill number is known; a paperless run has no identity
     *         to match and is left to (b).
     *   (b) the petty-cash form's own key (date+direction+amount+category+vendor+
     *       reference) inside 90 seconds — the retry/double-click window. */
    const billKey = String(flag.bill_ref || '').trim();
    const linked = (flag.purchase_id
      ? db.prepare(`
          SELECT id, date, amount FROM petty_cash_ledger
           WHERE direction = 'out' AND purchase_id = ? LIMIT 1
        `).get(flag.purchase_id)
      : billKey
        ? db.prepare(`
            SELECT pc.id, pc.date, pc.amount FROM petty_cash_ledger pc
             WHERE pc.direction = 'out'
               AND LOWER(TRIM(COALESCE(pc.vendor, ''))) = LOWER(TRIM(?))
               AND LOWER(TRIM(COALESCE(pc.reference, ''))) = LOWER(?)
               AND CAST(ROUND(pc.amount * 100) AS INTEGER) = ?
               AND NOT EXISTS (SELECT 1 FROM lq_retail_flags o WHERE o.petty_cash_id = pc.id AND o.id <> ?)
             LIMIT 1
          `).get(vendor, billKey, amountPaise, args.flagId)
        : undefined) as any;
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

const readFlag = (db: Database, flagId: string): any => {
  const flag = db.prepare('SELECT * FROM lq_retail_flags WHERE id = ?').get(flagId) as any;
  if (!flag) throw new RetailError('That wine-shop record no longer exists.', 404, 'flag_not_found');
  return flag;
};

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
 *
 * checkBackfill refuses (writing nothing); writeBackfill writes. They are split
 * so correctRetailFlag can run EVERY check of a two-part PATCH before EITHER
 * write — see there.
 */
function checkBackfill(flag: any, depotLandedPerBottle: number): { depot: number; excess: RetailExcess } {
  if (Number(flag.depot_landed_per_bottle) > 0) {
    // THE FIGURE IS NOT QUOTED. This refusal reaches anyone with can_procure on
    // the store, for ANY buy (flag ids are on the store ledger's notes), and a
    // frozen rate resolved from the Brand Map can BE the TGBCL master per bottle
    // — admin-only (see RETAIL_DEPOT_WITHHELD_NOTE).
    // It used to say "already carries a depot rate of ₹760.28": a read-only
    // oracle onto the master, measured for every buy on the copy. Whoever may see
    // the rate sees it on the Wine-shop buys register.
    throw new RetailError(
      'This buy already carries a depot rate, frozen when it was recorded. '
      + 'A frozen rate is never re-priced — that is what keeps §E readable across quarters.',
      409, 'already_priced',
    );
  }
  const depot = Number(depotLandedPerBottle);
  if (!Number.isFinite(depot) || depot <= 0) {
    throw new RetailError('The depot landed cost per bottle must be a number greater than 0.');
  }
  return { depot: r2(depot), excess: computeRetailExcess(Number(flag.rate_paid_per_bottle), r2(depot), Number(flag.bottles)) };
}

/** The backfill's write + audit. Call inside a transaction, after checkBackfill. */
function writeBackfill(db: Database, flag: any, depot: number, excess: RetailExcess, actorEmail: string): void {
  const res = db.prepare(`
    UPDATE lq_retail_flags
       SET depot_landed_per_bottle = ?, excess_per_bottle = ?, excess_total = ?, excess_pct = ?,
           updated_at = datetime('now')
     WHERE id = ? AND COALESCE(depot_landed_per_bottle, 0) <= 0
  `).run(depot, excess.excessPerBottle, excess.excessTotal, excess.excessPct, flag.id);
  if (res.changes !== 1) {
    throw new RetailError('This buy was priced by another action — nothing was changed.', 409, 'raced');
  }
  logAuditEvent(db, {
    event_type: 'liquor_retail.backfill_depot_rate',
    entity_type: 'lq_retail_flags',
    entity_id: flag.id,
    actor_email: actorEmail,
    before: { depot_landed_per_bottle: Number(flag.depot_landed_per_bottle) || 0, excess_total: Number(flag.excess_total) || 0 },
    after: { depot_landed_per_bottle: depot, ...excess },
    note: `Depot rate backfilled for wine-shop bill ${flag.bill_ref || '(no bill no)'} — excess now ${fmtRs(toPaise(excess.excessTotal))} (${excess.excessPct}%)`,
  });
}

export function backfillDepotLanded(
  db: Database,
  args: { flagId: string; depotLandedPerBottle: number; actorEmail: string },
): { flagId: string; depotLandedPerBottle: number; excess: RetailExcess } {
  return db.transaction(() => {
    const flag = readFlag(db, args.flagId);
    const { depot, excess } = checkBackfill(flag, args.depotLandedPerBottle);
    writeBackfill(db, flag, depot, excess, args.actorEmail);
    return { flagId: args.flagId, depotLandedPerBottle: depot, excess };
  }).immediate();
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
 * a real payout (closeReimbursementWithPettyCash), and in the running app it is
 * FINAL. The FK would reopen the claim if the payout row were deleted, but the
 * petty cash book has no DELETE (petty-cash/route.ts: append-only, corrected by
 * a visible entry), and a correcting entry there — a 'return' cash-in, or a
 * Management 'adjustment' — is a separate row that leaves petty_cash_id where
 * it is. So the refusal below must not send anyone to "delete or reverse" a
 * payout: neither reopens the claim. That keeps the invariant the whole design
 * rests on — the settled state always has cash behind it.
 */
function checkStatus(flag: any, status: string): LqReimbursementStatus {
  if (!(LQ_REIMBURSEMENT_STATUS as readonly string[]).includes(status)) {
    throw new RetailError(`reimbursement_status must be one of: ${LQ_REIMBURSEMENT_STATUS.join(', ')}.`);
  }
  if (status === 'reimbursed') {
    throw new RetailError(
      "'reimbursed' is set only by a real petty-cash payout, never typed — use the reimburse action.",
      400, 'reimbursed_not_writable',
    );
  }
  if (flag.reimbursement_status === 'reimbursed' && flag.petty_cash_id) {
    throw new RetailError(
      'This claim was closed by a petty-cash payout, and that is final: the petty cash book has no delete, and a correcting '
      + 'entry there (a "Return / refund" cash-in, or a Management "Adjustment") puts the money back in the box as a separate '
      + 'entry — this claim keeps its payout and stays Reimbursed. The status follows the cash, not the other way round.',
      409, 'payout_backed',
    );
  }
  if (flag.reimbursement_status === status) {
    throw new RetailError(`This claim is already "${status}".`, 409, 'no_change');
  }
  return status as LqReimbursementStatus;
}

/** The status write + audit. Call inside a transaction, after checkStatus. */
function writeStatus(db: Database, flag: any, status: LqReimbursementStatus, actorEmail: string, note?: string): void {
  const res = db.prepare(`
    UPDATE lq_retail_flags
       SET reimbursement_status = ?, updated_at = datetime('now')
     WHERE id = ? AND reimbursement_status = ? AND petty_cash_id IS NULL
  `).run(status, flag.id, flag.reimbursement_status);
  if (res.changes !== 1) {
    throw new RetailError('This claim changed under you — nothing was written.', 409, 'raced');
  }
  logAuditEvent(db, {
    event_type: 'liquor_retail.status',
    entity_type: 'lq_retail_flags',
    entity_id: flag.id,
    actor_email: actorEmail,
    before: { reimbursement_status: flag.reimbursement_status },
    after: { reimbursement_status: status },
    note: `Wine-shop claim ${flag.bill_ref || '(no bill no)'}: ${flag.reimbursement_status} → ${status}`
      + (note ? ` — ${String(note).slice(0, 300)}` : ''),
  });
}

export function setReimbursementStatus(
  db: Database,
  args: { flagId: string; status: LqReimbursementStatus; actorEmail: string; note?: string },
): { flagId: string; from: LqReimbursementStatus; to: LqReimbursementStatus } {
  return db.transaction(() => {
    const flag = readFlag(db, args.flagId);
    const to = checkStatus(flag, args.status);
    writeStatus(db, flag, to, args.actorEmail, args.note);
    return { flagId: args.flagId, from: flag.reimbursement_status as LqReimbursementStatus, to };
  }).immediate();
}

/**
 * One PATCH, both corrections, ALL OR NOTHING.
 *
 * PATCH /api/liquor/retail/[id] takes a depot rate and a claim status in one
 * body. It used to call backfillDepotLanded and then setReimbursementStatus,
 * each in its own transaction, so a request whose STATUS was refused (409
 * no_change / payout_backed, 400 'reimbursed') had already frozen its RATE:
 * the caller was told "refused" and the record had changed (measured on the
 * copy: rate 1,200 + status unchanged → 409, and the flag carried depot 1,200
 * and its excess). Now the flag is read once inside ONE IMMEDIATE transaction,
 * every check of both parts runs, and only then does either write — so a
 * refused request writes nothing, rate and audit row included.
 */
export function correctRetailFlag(
  db: Database,
  args: {
    flagId: string; actorEmail: string;
    depotLandedPerBottle?: number | null;
    status?: string | null; note?: string;
  },
): {
  flagId: string;
  rate: { depotLandedPerBottle: number; excess: RetailExcess } | null;
  status: { from: LqReimbursementStatus; to: LqReimbursementStatus } | null;
} {
  const hasRate = args.depotLandedPerBottle !== undefined && args.depotLandedPerBottle !== null;
  const hasStatus = args.status !== undefined && args.status !== null && String(args.status).trim() !== '';
  if (!hasRate && !hasStatus) throw new RetailError('Nothing to change.', 400, 'nothing_to_change');
  return db.transaction(() => {
    const flag = readFlag(db, args.flagId);
    // EVERY check first …
    const rate = hasRate ? checkBackfill(flag, Number(args.depotLandedPerBottle)) : null;
    const to = hasStatus ? checkStatus(flag, String(args.status)) : null;
    // … then the writes. Neither write touches the column the other's WHERE
    // reads, so the order between them changes nothing.
    if (rate) writeBackfill(db, flag, rate.depot, rate.excess, args.actorEmail);
    if (to) writeStatus(db, flag, to, args.actorEmail, args.note);
    return {
      flagId: args.flagId,
      rate: rate ? { depotLandedPerBottle: rate.depot, excess: rate.excess } : null,
      status: to ? { from: flag.reimbursement_status as LqReimbursementStatus, to } : null,
    };
  }).immediate();
}

/* ── §E DATA for the L5 Reconciliation Summary ──────────────────────────────*/

export interface RetailFlagRow {
  id: string;
  /** LEGACY anchor only (a flag written by the first version); null on new rows. */
  purchase_id: string | null;
  /** The store_stock_ledger 'inward' row that moved the stock (new rows).
   *  null on a COST-ONLY buy — it moved no stock (cost_only). */
  ledger_id: string | null;
  /** true → no stock was booked: a saved count already held these bottles
   *  (ruling 39). The money figures below are recorded as for any buy. */
  cost_only: boolean;
  /** The count date a cost-only buy deferred to; null otherwise. */
  cost_only_count_date: string | null;
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
   *  instead of silently hiding a buy recorded with no outlet. */
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
 * L5 (src/lib/liquor-summary.ts §E/§F) calls this function rather than
 * re-querying lq_retail_flags, so a change to these definitions lands in one
 * place.
 *
 * STORE SCOPE. With `storeId`, the BUYS are that store's too, not only the
 * depot spend: a floor bar's §E used to list every wine-shop buy in the house
 * against the floor bar's own depot spend (₹0 — a floor bar receives by
 * transfer), i.e. 100% "wine-shop share" of buys it never made. A buy belongs
 * to the store it was BOOKED INTO: its store_stock_ledger row's store_id.
 * A buy with no ledger row — COST-ONLY (ruling 39), a LEGACY flag (stock went
 * central), or a ledger cleared by reset-liquor — belongs to its material's own
 * store (materialStoreId), which is the one store recordWineShopPurchase books
 * any buy into. lq_retail_flags has no store column. Without `storeId` every
 * buy is counted, exactly as before.
 *
 * MANAGEMENT-ONLY DATA. The rows name who fronted money and what they are owed,
 * and the totals are depot spend and the price of running out — the same §E the
 * management-only Reconciliation Summary shows. Every route that returns this
 * must gate on management AND a page that shows it (GET /api/liquor/retail's
 * requireRetailView), and must pass it through retailSummaryForViewer: the
 * depot rate and every excess figure are ADMIN-ONLY (they re-derive the TGBCL
 * master rate). This function returns the full figures because the Summary
 * computes §E from them; it is never handed to a browser as it stands.
 */
export function retailExcessSummary(
  db: Database,
  args: { from: string; to: string; outletId?: string | null; storeId?: string | null },
): RetailExcessSummary {
  const from = isRealDate(args.from) ? args.from : '0000-01-01';
  const to = isRealDate(args.to) ? args.to : '9999-12-31';
  const scoped = args.outletId != null && String(args.outletId).trim() !== '';

  // material and outlet are the FLAG's own columns. A new flag has no purchases
  // row, so reading them off one (the first version) returned NULL for every
  // buy: no material name, no outlet, and an outlet-scoped view that hid them
  // all. The purchases join survives only as a second source for a legacy flag.
  // Every join is on a primary key, so no flag is ever counted twice.
  const allRows = db.prepare(`
    SELECT f.id, f.purchase_id, f.ledger_id, f.bill_ref, f.date, f.shop_name, f.shop_licence_no,
           f.bottles, f.rate_paid_per_bottle, f.depot_landed_per_bottle,
           f.excess_per_bottle, f.excess_total, f.excess_pct, f.paid_by, f.payment_mode,
           f.reimbursement_status, f.petty_cash_id, f.reason, f.approved_by,
           COALESCE(f.material_id, p.material_id) AS material_id, rm.name AS material_name,
           rm.category                            AS material_category,
           COALESCE(f.outlet_id, p.outlet_id)     AS outlet_id,
           l.store_id                             AS ledger_store_id
      FROM lq_retail_flags f
      LEFT JOIN purchases p     ON p.id = f.purchase_id
      LEFT JOIN raw_materials rm ON rm.id = COALESCE(f.material_id, p.material_id)
      LEFT JOIN store_stock_ledger l ON l.id = f.ledger_id
     WHERE f.date >= ? AND f.date <= ?
     ORDER BY f.date DESC, f.created_at DESC
  `).all(from, to) as any[];

  // The store each buy was booked into (see STORE SCOPE above).
  const storeScope = args.storeId != null && String(args.storeId).trim() !== '' ? String(args.storeId) : null;
  const ownStore = new Map<string, string | null>();
  const bookedStore = (f: any): string | null => {
    if (f.ledger_store_id) return String(f.ledger_store_id);
    const cat = String(f.material_category ?? '');
    if (!ownStore.has(cat)) ownStore.set(cat, cat ? materialStoreId(db, { category: cat }) : null);
    return ownStore.get(cat) ?? null;
  };
  const storeRows = storeScope ? allRows.filter((f) => bookedStore(f) === storeScope) : allRows;

  // What the outlet filter dropped. A flag recorded with no outlet
  // vanishes from an outlet-scoped view; the caller is told how many, so a screen
  // can offer "show all outlets" instead of quietly under-reporting. Counted
  // inside the store scope: another store's buys are not "another outlet's".
  const rows = scoped
    ? storeRows.filter((f) => String(f.outlet_id ?? '') === String(args.outletId))
    : storeRows;
  const hiddenByOutletCount = Math.max(0, storeRows.length - rows.length);

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
    // A cost-only anchor is reported as what it is, never as a ledger id. A
    // LEGACY row (purchase_id set) is never cost-only — its stock went central.
    const costOnly = !f.purchase_id && isCostOnlyAnchor(f.ledger_id);
    return {
      id: f.id, purchase_id: f.purchase_id ?? null, ledger_id: costOnly ? null : (f.ledger_id ?? null),
      cost_only: costOnly, cost_only_count_date: costOnly ? costOnlyCountDate(f.ledger_id) : null,
      bill_ref: f.bill_ref, date: f.date,
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

/* ── WHO MAY SEE THE DEPOT RATE: the redacted view of §E ────────────────────*/

/**
 * Why a non-admin sees no depot rate and no excess — one sentence, used by the
 * register API, the record/backfill replies and the Summary's §E, so every
 * screen that withholds the figures says the same thing.
 */
export const RETAIL_DEPOT_WITHHELD_NOTE =
  'The depot landed rate and the excess are admin-only: for a brand with no recorded TGBCL indent the depot rate '
  + 'IS the Brand Map master rate per bottle, and a buy does not record which basis its rate was frozen on, so the '
  + 'rate (and the excess, which is the rate paid minus it) would hand over the admin-only master. Bottles, the rate '
  + 'paid, who paid and what is still owed are shown; an admin sees the depot figures on the Wine-shop buys register '
  + 'and in §E of the Reconciliation Summary.';

/** One row of the register as a viewer receives it: the depot-derived figures
 *  are null when withheld, and `priced` says whether a rate is frozen at all (so
 *  a screen can still tell "priced, withheld" from "unknown — price it"). */
export interface RetailFlagRowView extends Omit<RetailFlagRow,
  'depot_landed_per_bottle' | 'excess_per_bottle' | 'excess_total' | 'excess_pct'> {
  depot_landed_per_bottle: number | null;
  excess_per_bottle: number | null;
  excess_total: number | null;
  excess_pct: number | null;
  /** depot_landed_per_bottle > 0 — the SAME test backfillDepotLanded and the
   *  summary use. Never a money figure. */
  priced: boolean;
}

export interface RetailExcessSummaryView extends Omit<RetailExcessSummary, 'excessTotal' | 'rows'> {
  /** null when the depot figures are withheld (it is Σ (rate paid − depot) × bottles). */
  excessTotal: number | null;
  rows: RetailFlagRowView[];
  /** true for an admin; false → every depot-derived figure above is null. */
  depotFiguresVisible: boolean;
  /** When withheld, RETAIL_DEPOT_WITHHELD_NOTE; otherwise null. */
  depotFiguresNote: string | null;
}

/**
 * The register as a given viewer may see it.
 *
 * THE DEPOT RATE IS ADMIN-ONLY, for the same reason §G's master rate is
 * (liquor-summary.ts LqSectionG; brand-map/_lib/guard.ts; inward-register rule
 * b): resolveDepotLanded freezes L1's landedPerBottle. For a brand with no
 * recorded indent line that IS the master ÷ bottles_per_case (basis
 * 'master_only' — measured: Gin 760.28 = the ₹9,123.36 master ÷ 12, returned to
 * the bartender who recorded it). Before owner decision 2 moved L1 onto the rate
 * PAID it was the master plus the latest indent's levies for every brand, and
 * §B hands those levies to the same manager (measured: 4,014.69 − 264.69 =
 * 3,750 = the ₹45,000 master ÷ 12). A flag stores no basis column, so a row
 * cannot say which kind it is — every row is treated alike.
 * Every figure the depot rate can be re-derived from goes with it:
 *   depot_landed_per_bottle — the rate;
 *   excess_per_bottle       — rate paid − depot, and the rate paid is on the row;
 *   excess_total            — excess_per_bottle × bottles;
 *   excess_pct              — (paid − depot) ÷ depot;
 *   excessTotal             — with one buy in range it IS that buy's excess_total.
 * Fail closed: anything but an explicit `revealDepotFigures: true` withholds.
 * retailExcessSummary itself keeps returning the full figures — it is the ONE
 * definition the Summary computes from; only what leaves a route is redacted.
 */
export function retailSummaryForViewer(
  summary: RetailExcessSummary,
  opts: { revealDepotFigures?: boolean },
): RetailExcessSummaryView {
  const reveal = opts.revealDepotFigures === true;
  return {
    ...summary,
    excessTotal: reveal ? summary.excessTotal : null,
    rows: summary.rows.map((r) => ({
      ...r,
      depot_landed_per_bottle: reveal ? r.depot_landed_per_bottle : null,
      excess_per_bottle: reveal ? r.excess_per_bottle : null,
      excess_total: reveal ? r.excess_total : null,
      excess_pct: reveal ? r.excess_pct : null,
      priced: Number(r.depot_landed_per_bottle) > 0,
    })),
    depotFiguresVisible: reveal,
    depotFiguresNote: reveal ? null : RETAIL_DEPOT_WITHHELD_NOTE,
  };
}
