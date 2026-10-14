import type { Database } from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { materialStoreId, getStoreById, postLedger } from '@/lib/store-engine';
import {
  LQ_REIMBURSEMENT_STATUS,
  landedCostPerBottleExplained,
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
}

export interface WineShopRecordResult {
  /** Always null on a new buy — no central purchases row is written (see header). */
  purchaseId: null;
  flagId: string;
  /** The store_stock_ledger 'inward' row that moved the stock. */
  ledgerId: string;
  /** The store the bottles were booked into (the material's own store). */
  storeId: string;
  storeName: string;
  /** Recipe units added to that store's ledger. */
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
    SELECT f.id, f.bottles, f.rate_paid_per_bottle, f.date, f.bill_ref
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
    throw new RetailError(
      billRef
        ? `"${mat.name}" is already recorded on wine-shop bill ${billRef} from ${shopName || 'this shop'} dated ${input.date} `
          + `— ${dupe.bottles} ${purchaseUnitLabel} at ${fmtRs(toPaise(Number(dupe.rate_paid_per_bottle)))} each. `
          + `Nothing was saved; if you are re-trying after a failed save, that buy is already in.`
        : `An identical wine-shop buy (${bottles} ${purchaseUnitLabel} × "${mat.name}" at ${fmtRs(toPaise(rate))} each from ${shopName || 'this shop'} on ${input.date}) `
          + `was recorded moments ago. Nothing was saved. If the bottles really were bought twice, enter the shop's bill number to record the second run.`,
      409, 'duplicate',
    );
  }

  const flagId = generateId();
  let ledgerId = '';
  const today = todayIST();

  const run = db.transaction(() => {
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
    // BACKDATE, IST-exact. Every IST-day reader of this ledger (floor
    // reconciliation, the §H denominator, depot spend) buckets on
    // date(created_at, '+330 minutes'). A buy keyed in today for yesterday must
    // land on yesterday: the instant is the buy's date at the current IST
    // time-of-day, converted back to UTC, so its IST day is exactly input.date.
    if (input.date !== today) {
      db.prepare(`
        UPDATE store_stock_ledger
           SET created_at = datetime(? || ' ' || strftime('%H:%M:%S', 'now', '+330 minutes'), '-330 minutes')
         WHERE id = ?
      `).run(input.date, ledgerId);
    }

    // 2. THE SIDE RECORD — the flag. The ONLY place the retail ₹ is written. It
    //    names the stock movement (ledger_id) rather than repeating it. The four
    //    excess figures are frozen above.
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
        ledger_id: ledgerId, store_id: input.storeId, store: store.name,
        material_id: input.materialId, material: mat.name, stock_qty: stockQty, recipe_unit: mat.unit,
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
    purchaseId: null, flagId, ledgerId, storeId: input.storeId, storeName: store.name, stockQty,
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
  /** LEGACY anchor only (a flag written by the first version); null on new rows. */
  purchase_id: string | null;
  /** The store_stock_ledger 'inward' row that moved the stock (new rows). */
  ledger_id: string | null;
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
  const rows = db.prepare(`
    SELECT f.id, f.purchase_id, f.ledger_id, f.bill_ref, f.date, f.shop_name, f.shop_licence_no,
           f.bottles, f.rate_paid_per_bottle, f.depot_landed_per_bottle,
           f.excess_per_bottle, f.excess_total, f.excess_pct, f.paid_by, f.payment_mode,
           f.reimbursement_status, f.petty_cash_id, f.reason, f.approved_by,
           COALESCE(f.material_id, p.material_id) AS material_id, rm.name AS material_name,
           COALESCE(f.outlet_id, p.outlet_id)     AS outlet_id
      FROM lq_retail_flags f
      LEFT JOIN purchases p     ON p.id = f.purchase_id
      LEFT JOIN raw_materials rm ON rm.id = COALESCE(f.material_id, p.material_id)
     WHERE f.date >= ? AND f.date <= ?
       ${scoped ? "AND COALESCE(f.outlet_id, p.outlet_id, '') = ?" : ''}
     ORDER BY f.date DESC, f.created_at DESC
  `).all(...(scoped ? [from, to, String(args.outletId)] : [from, to])) as any[];

  // What the outlet filter dropped. A flag recorded with no outlet
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
      id: f.id, purchase_id: f.purchase_id ?? null, ledger_id: f.ledger_id ?? null, bill_ref: f.bill_ref, date: f.date,
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
