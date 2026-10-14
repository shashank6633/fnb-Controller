/**
 * LIQUOR STOCK WITHDRAWALS — non-sale issues (phase L4).
 *
 * Plan: docs/liquor-reconciliation-plan.md §L4. Contract: src/lib/liquor-recon.ts
 * (frozen vocabularies, row shapes, and the four shared-helper CONTRACTS). Table:
 * the `lq_withdrawals` block in initializeSchema() in src/lib/db.ts.
 *
 * WHAT A WITHDRAWAL IS: a bottle (or case) that leaves the liquor store WITHOUT a
 * sale — management/director personal use, staff welfare, marketing/sampling,
 * breakage/spoilage, or a transfer out. It is like a wastage in that it MOVES
 * STOCK, and unlike a wastage in that some of it is RECOVERABLE (billed back to a
 * named person). This module is the register the workbook's "Stock Withdrawals"
 * sheet is, plus the stock movement that sheet never made.
 *
 * TWO INVARIANTS INHERITED FROM THE L0 CONTRACT (rules 1 & 2 in liquor-recon.ts):
 *
 *  1. LANDED COST IS ANALYTICS ONLY (owner decision 1a). The frozen
 *     landed_unit_cost / landed_value on the row are a RECORD of what the issue
 *     cost the night it left. They are NEVER written to raw_materials.average_price,
 *     raw_materials.last_purchase_price, or store_stock_ledger.unit_cost. The
 *     ledger row this posts carries unit_cost 0 precisely so no landed figure can
 *     leak into store valuation (storeStock weights INFLOW rows only, so a
 *     zero-cost OUTWARD row changes no average anyway — but 0 makes it provable).
 *
 *  2. NOTHING DERIVED IS STORED THAT CAN BE COMPUTED. `outstanding` is a SQLite
 *     GENERATED column (recoverable − recovered); this file NEVER names it in an
 *     INSERT/UPDATE (that throws "cannot INSERT into generated column"), only
 *     reads it. Section-H totals are computed live, never cached.
 *
 * ATOMICITY (the reason postWithdrawalStock and the row INSERT share one txn):
 * a withdrawal that moved stock but wrote no register row is money that vanished
 * with no paper; a register row whose stock never moved is a phantom that surfaces
 * later as an unexplained variance against a bar. createWithdrawal() writes BOTH
 * inside ONE db.transaction, so either both land or neither does.
 */

import type Database from 'better-sqlite3';
import { generateId, logAuditEvent } from '@/lib/db';
import { postLedger, getStoreById } from '@/lib/store-engine';
import { packFactor, caseFactor, tripleToRecipe, type PackMeta } from '@/lib/pack-units';
import { materialRate } from '@/lib/closing-valuation';
import { todayIST } from '@/lib/format-date';
import {
  LQ_WITHDRAWAL_CATEGORIES, LQ_RECOVERY_BASIS,
  type LqWithdrawal, type LqWithdrawalCategory, type LqRecoveryBasis,
} from '@/lib/liquor-recon';
// L1 owns landedCostPerBottle() in liquor-recon.ts. It may not be present yet:
// this phase reads it defensively (see landedUnitCostFromL1 below) rather than
// static-importing a symbol that would fail `tsc` until L1 lands. When L1 ships
// its implementation, this file picks it up with no edit.
import * as recon from '@/lib/liquor-recon';

/* ── Material meta the maths needs ───────────────────────────────────────── */
export interface WithdrawalMaterial extends PackMeta {
  id: string;
  name: string;
  category: string;
  unit: string;
  average_price?: number | null;
}

/* ── Ref minting — WD-YYYY-### unique under concurrency ───────────────────────
 * MIRRORS mintCashVoucherNo / mintInvoiceId IN SHAPE AND CONCURRENCY POSTURE:
 * MAX(numeric tail)+1, then WALK FORWARD past any ref already on the books, read
 * inside the caller's transaction so a second create in the same synchronous
 * process cannot take the same number. The ref lives in exactly ONE column
 * (lq_withdrawals.ref, UNIQUE), so that one column is the whole search space —
 * unlike PCV, which had to scan three. The UNIQUE(ref) constraint is the ultimate
 * guarantee; createWithdrawal re-mints and retries if a cross-process race ever
 * beats the walk-forward to it.
 *
 * THE YEAR COMES FROM THE BUSINESS DATE, not the server clock. A withdrawal
 * recorded on 2 Jan for 31 Dec belongs to the OLD year's register, and on a UTC
 * host the IST window 00:00–05:30 on 1 January would otherwise mint last year's
 * prefix onto a row dated this year — the same business-day skew '+330 minutes'
 * exists elsewhere to fix. Falls back to the server year only for a date this
 * function was handed without validation (createWithdrawal validates first). */
export function mintWithdrawalRef(db: Database.Database, businessDate?: string): string {
  const d = String(businessDate || '');
  const y = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Number(d.slice(0, 4)) : new Date().getFullYear();
  const prefix = `WD-${y}-`;
  const like = `${prefix}%`;
  const maxRow = db.prepare(`
    SELECT MAX(CAST(substr(ref, ?) AS INTEGER)) AS n
    FROM lq_withdrawals WHERE ref LIKE ?
  `).get(prefix.length + 1, like) as { n: number | null } | undefined;
  const taken = db.prepare('SELECT 1 AS hit FROM lq_withdrawals WHERE ref = ?');
  let n = (Number(maxRow?.n) || 0) + 1;
  // Belt on the braces: MAX()+1 is already free in every ordinary case. 100k caps
  // a corrupted row (a hand-typed 'WD-2026-99999999') from spinning.
  for (let i = 0; i < 100_000; i++) {
    const candidate = `${prefix}${String(n).padStart(3, '0')}`;
    if (!taken.get(candidate)) break;
    n++;
  }
  return `${prefix}${String(n).padStart(3, '0')}`;
}

/* ── Landed cost, frozen at issue ─────────────────────────────────────────────
 * Contract: L4 FREEZES the landed cost onto the withdrawal. The true landed cost
 * (master rate + this line's share of the recorded TGBCL levies) is L1's
 * landedCostPerBottle(); we do NOT reimplement it. Until L1 lands, or for a
 * material with no brand-map row, we fall back to the store's ordinary cost basis
 * (the same weighted-average the ledger already uses) — which is NOT landed cost
 * and is NOT levy allocation, just the best-known unit cost — and record which
 * source was used so the freeze is auditable. Whatever value is resolved is
 * STORED on the row and never recomputed, so a later rate change cannot move it. */
export type LandedCostSource = 'manual' | 'l1_landed' | 'store_avg' | 'last_purchase' | 'none';

/** Ask L1 for the landed cost per bottle, converted to ₹/recipe-unit, or null. */
function landedUnitCostFromL1(
  db: Database.Database,
  args: { materialId: string; mat: WithdrawalMaterial; asOf: string; billRef?: string; storeId?: string },
): number | null {
  const fn = (recon as any).landedCostPerBottle as
    | ((db: Database.Database, a: { materialId?: string; brandMapId?: string; billRef?: string; asOf?: string; storeId?: string }) =>
        { ratePerBottle: number; allocatedLevies: number; landedPerBottle: number } | null)
    | undefined;
  if (typeof fn !== 'function') return null;                 // L1 not built yet
  let res: { landedPerBottle: number } | null = null;
  try {
    res = fn(db, { materialId: args.materialId, billRef: args.billRef, asOf: args.asOf, storeId: args.storeId });
  } catch { return null; }                                   // never let analytics break an issue
  if (!res || !Number.isFinite(res.landedPerBottle)) return null;
  const pf = packFactor(args.mat) || 1;                      // ₹/bottle → ₹/recipe-unit
  const v = res.landedPerBottle / pf;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Weighted-average ₹/recipe-unit from this store's INFLOW ledger rows — the
 *  same basis storeStock() uses. Returns 0 when the store has no priced inflow;
 *  the caller then falls through to the last purchase price. */
function storeAvgUnitCost(db: Database.Database, storeId: string, materialId: string): number {
  const r = db.prepare(`
    SELECT SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity * unit_cost ELSE 0 END) AS v,
           SUM(CASE WHEN quantity > 0 AND unit_cost > 0 THEN quantity ELSE 0 END)            AS q
    FROM store_stock_ledger WHERE store_id = ? AND material_id = ?
  `).get(storeId, materialId) as { v: number | null; q: number | null } | undefined;
  const q = Number(r?.q) || 0;
  return q > 0 ? (Number(r?.v) || 0) / q : 0;
}

/** ₹/recipe-unit from the material's LAST PURCHASE price, or 0.
 *
 *  WHY NOT raw_materials.average_price. This database stores per-unit rates in
 *  MIXED bases — see src/lib/closing-valuation.ts, which exists for exactly this
 *  reason, and the measured case here: HENDRICKS GIN (unit ml, pack 700) carries
 *  average_price 5641.83, which is ₹ per BOTTLE, not ₹ per ml. Read as ₹/ml it
 *  freezes one bottle at ₹3,949,281 — 700× — and that frozen figure is what §H
 *  totals and what a 'landed' recovery bills to a named person.
 *
 *  materialRate()'s FIRST leg (purchases.unit_price, ₹ per PURCHASE unit by
 *  canon, "authoritative and unambiguous") is trustworthy, so that is the only
 *  leg taken here; its average_cost leg is the trap above and is deliberately
 *  NOT accepted. With no purchase history and no priced store inflow this
 *  function returns 0 and resolveLandedUnitCost reports source 'none' — the
 *  admin types the figure rather than the register inventing one. */
function lastPurchaseUnitCost(db: Database.Database, mat: WithdrawalMaterial): number {
  let rate;
  try { rate = materialRate(db, mat); } catch { return 0; }
  if (!rate || rate.source !== 'last_purchase') return 0;
  const pf = packFactor(mat) || 1;                        // ₹/purchase-unit → ₹/recipe-unit
  const v = Number(rate.ratePerPurchaseUnit) / pf;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Resolve the ₹/recipe-unit to FREEZE onto the withdrawal, with its source.
 * Order: explicit admin value → L1 landed cost → store weighted-avg → last
 * purchase price → none (0, and the caller must be told).
 */
export function resolveLandedUnitCost(
  db: Database.Database,
  args: {
    storeId: string; materialId: string; mat: WithdrawalMaterial;
    explicitPerRecipeUnit?: number | null; asOf: string; billRef?: string;
  },
): { value: number; source: LandedCostSource } {
  const ex = args.explicitPerRecipeUnit;
  if (ex !== undefined && ex !== null && Number.isFinite(Number(ex)) && Number(ex) >= 0) {
    return { value: Number(ex), source: 'manual' };
  }
  const l1 = landedUnitCostFromL1(db, { materialId: args.materialId, mat: args.mat, asOf: args.asOf, billRef: args.billRef, storeId: args.storeId });
  if (l1 !== null) return { value: l1, source: 'l1_landed' };
  const storeAvg = storeAvgUnitCost(db, args.storeId, args.materialId);
  if (storeAvg > 0) return { value: storeAvg, source: 'store_avg' };
  const lastPurchase = lastPurchaseUnitCost(db, args.mat);
  return lastPurchase > 0
    ? { value: lastPurchase, source: 'last_purchase' }
    : { value: 0, source: 'none' };
}

/** Current on-hand (recipe units) for one material in one store. */
export function storeMaterialOnHand(db: Database.Database, storeId: string, materialId: string): number {
  const r = db.prepare(
    'SELECT COALESCE(SUM(quantity), 0) AS q FROM store_stock_ledger WHERE store_id = ? AND material_id = ?',
  ).get(storeId, materialId) as { q: number };
  return Number(r?.q) || 0;
}

/* ── postWithdrawalStock — the L0 contract's shared helper (owner: L4) ─────────
 * ONE signed NEGATIVE store_stock_ledger row. Called INSIDE createWithdrawal's
 * transaction, never on its own, so it shares the register row's fate. unit_cost
 * is 0 by rule 1 (landed cost must not touch the ledger). Returns the ledger id
 * the register row records in ledger_id.
 *
 * txn_type IS 'adjustment', NOT 'outward' — measured, not stylistic. The
 * deployed bar reconciliation defines ACTUAL in ledger mode
 * (tm_floor_autodeduct=1) as Σ |rows WHERE txn_type='outward' AND quantity<0|,
 * documented at store-engine.ts:1655 as "pours only" and at :1520 as "which
 * never includes an 'adjustment'". An 'outward' row here made every authorised,
 * named withdrawal read as a SALE POUR: measured 3,000 ml of ACTUAL and
 * ₹7,621.20 of unbilled leak on a zero-sales day. 'adjustment' is what the
 * house's other non-sale store reduction already posts (/api/stores/empties
 * breakage, /api/stores/[id]/adjust), and it changes nothing about the movement
 * itself: on-hand is SUM(quantity) regardless of type, the inflow leg counts
 * `quantity > 0 OR txn_type='transfer'` (a negative adjustment is excluded
 * exactly as a negative outward was), and the physical-mode opening/closing
 * fallbacks sum every type. Only the ledger-mode "was this a pour?" test
 * changes — which is the defect. */
export function postWithdrawalStock(
  db: Database.Database,
  w: {
    store_id: string; material_id: string; qty_recipe_units: number;
    ref: string; category: LqWithdrawalCategory; recorded_by: string; note?: string;
  },
): { ledgerId: string } {
  const qty = Number(w.qty_recipe_units);
  if (!Number.isFinite(qty) || qty <= 0) {
    // POSITIVE in, NEGATIVE out: the register holds the magnitude, the ledger the
    // sign. A non-positive magnitude here would flip the movement into an inflow.
    throw new Error('qty_recipe_units must be a positive number');
  }
  const ledgerId = postLedger(db, {
    store_id: w.store_id,
    material_id: w.material_id,
    txn_type: 'adjustment',   // a non-sale reduction, NOT a pour (see above)
    quantity: -qty,           // OUT of the store
    unit_cost: 0,             // rule 1: no landed cost on the ledger
    ref: w.ref,
    notes: w.note || `Withdrawal ${w.ref} (${w.category})`,
    created_by: w.recorded_by,
  });
  return { ledgerId };
}

/* ── Create — atomic ref + ledger + optional wastage co-write + register row ── */
export interface CreateWithdrawalInput {
  store_id: string;
  material_id: string;
  date: string;                       // YYYY-MM-DD (business date)
  category: LqWithdrawalCategory;
  cases?: number;
  bottles?: number;
  /** Explicit ₹/recipe-unit to freeze; when omitted the landed cost is resolved. */
  landed_unit_cost?: number | null;
  /** MRP ₹/recipe-unit (0 when unknown). */
  mrp_unit_value?: number | null;
  taken_by?: string;
  authorised_by?: string;
  recovery_basis?: LqRecoveryBasis;
  /** ₹ recoverable when recovery_basis = 'custom'. */
  recoverable_custom?: number | null;
  recovered?: number | null;
  excise_register?: boolean;
  /** Breakage/spoilage only: also write a (record-only) row on the wastage rail. */
  co_write_wastage?: boolean;
  remarks?: string;
  recorded_by: string;
  /** Set false to allow issuing below the recorded on-hand (default: block). */
  allow_negative?: boolean;
  outlet_id?: string | null;
  /** Record even though an identical issue was filed seconds ago (see the
   *  duplicate guard). Only a human should ever set this. */
  confirm_duplicate?: boolean;
}

/** Cases / bottles are things you count off a shelf: whole, and never negative.
 *  REFUSE, never clamp — `Math.max(0, …)` silently recorded "0 cases" for a
 *  typed "−3", and 0.3 of a bottle is a count nobody can take. */
function wholeCount(v: unknown, label: string): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a whole number (0 or more)`);
  if (n < 0) throw new Error(`${label} cannot be negative — enter 0 or more`);
  if (!Number.isInteger(n)) throw new Error(`${label} must be a whole number — a part-${label === 'Cases' ? 'case' : 'bottle'} cannot leave the shelf`);
  return n;
}

const UNIQUE_REF_RE = /UNIQUE constraint failed: lq_withdrawals\.ref/i;

/** Stamped on the register row (and shown in the CSV) when `allow_negative` was
 *  used AND the issue really did exceed the recorded on-hand. */
export const FORCED_BELOW_ON_HAND_TAG = '[forced below on-hand]';

/** The co-written wastage row's `reason`. MUST be a member of the wastage rail's
 *  own VALID_REASONS (src/app/api/wastage/route.ts) — a free-text reason is
 *  invisible to that page's filter chips and gives the analyst by-reason report
 *  one bucket per row. 'damage' is the rail's word for a broken bottle. */
export const CO_WRITE_WASTAGE_REASON = 'damage';

/* ── ⚠ KNOWN HAZARD OF THE WASTAGE CO-WRITE (opt-in, default OFF) ─────────────
 * DELETE /api/wastage credits stock back for any row whose `department_id` is
 * blank: `UPDATE raw_materials SET current_stock = current_stock + qty`. That is
 * right for every row that rail creates (its POST debited central first) and
 * WRONG for a co-written row, whose movement is the store_stock_ledger row this
 * file posts. Deleting one from /wastage's Trash button ("Delete + credit stock
 * back") therefore INVENTS central stock — measured: 100 PIPERS (750ML)
 * current_stock 4020 → 4770 ml, with the liquor deduction still standing.
 *
 * It cannot be closed from inside phase L4: setting `department_id` only moves
 * the invented credit onto a department ledger, and the delete handler is not
 * this phase's file. The one-line owner fix, for when this lands:
 *
 *   -- in DELETE /api/wastage, before either stock branch:
 *   const coWritten = db.prepare('SELECT 1 FROM lq_withdrawals WHERE wastage_id = ?').get(id);
 *   -- if coWritten: delete the row and return; credit NOTHING.
 *
 * Until then the toggle stays OFF by default, the UI warns beside it, and every
 * co-written row carries the warning in its `notes`. Do not enable it by
 * default and do not remove the warnings without that guard in place. */

export function createWithdrawal(
  db: Database.Database,
  input: CreateWithdrawalInput,
  mat: WithdrawalMaterial,
): LqWithdrawal {
  // ── Validate the shape BEFORE the transaction, with friendly messages. The
  //    schema CHECKs are the backstop; these are the readable front door.
  const category = String(input.category || '') as LqWithdrawalCategory;
  if (!LQ_WITHDRAWAL_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${LQ_WITHDRAWAL_CATEGORIES.join(', ')}`);
  }
  const basis = String(input.recovery_basis || 'none') as LqRecoveryBasis;
  if (!LQ_RECOVERY_BASIS.includes(basis)) {
    throw new Error(`recovery_basis must be one of: ${LQ_RECOVERY_BASIS.join(', ')}`);
  }
  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  // A withdrawal is a record of stock that HAS LEFT. The stock movement it posts
  // is stamped now, so a future business date books the register in a period the
  // ledger will never reach. Backdating stays open (recording yesterday's bottle
  // is the normal case) and is documented as a period-basis caveat on §H.
  if (date > todayIST()) {
    throw new Error(`date ${date} is in the future — a withdrawal records stock that has already left`);
  }

  const store = getStoreById(db, input.store_id);
  if (!store) throw new Error('Unknown store location');

  const cases = wholeCount(input.cases, 'Cases');
  const bottles = wholeCount(input.bottles, 'Bottles');
  // cases + bottles → recipe units via the SAME house pack machinery procure uses
  // (cases × case_size × pack + bottles × pack). No brand-map dependency here —
  // the quantity is the deployed convention; only the landed COST touches L1.
  const qtyRecipe = tripleToRecipe(cases, bottles, 0, mat);
  if (!(qtyRecipe > 0)) throw new Error('Enter a quantity to withdraw — cases and/or bottles');

  // Stock guard: you cannot issue what the book does not show, unless explicitly
  // overridden. Keeps a fat-fingered "10 cases" from silently driving a bar
  // negative and manufacturing a variance.
  const onHand = storeMaterialOnHand(db, input.store_id, input.material_id);
  const belowOnHand = qtyRecipe > onHand + 1e-9;
  if (belowOnHand && !input.allow_negative) {
    const pf = packFactor(mat) || 1;
    throw new Error(
      `Not enough stock: ${store.name} holds ${Math.round((onHand / pf) * 1000) / 1000} ${mat.purchase_unit || mat.unit}`
      + ` of ${mat.name}, tried to withdraw ${Math.round((qtyRecipe / pf) * 1000) / 1000}. `
      + `Record the missing receipt first, or set allow_negative to override.`,
    );
  }
  // The override was used AND it actually bit. Stamp the row, not just the audit
  // log: a later reader of the register must be able to tell a forced issue from
  // a data error without cross-referencing /audit.
  const forcedBelowOnHand = belowOnHand && !!input.allow_negative;

  // Duplicate guard (the statement; it RUNS inside the transaction below, where
  // IMMEDIATE serialises a second process behind us — checking out here would
  // let two concurrent retries both pass). A retried POST — flaky tablet Wi-Fi,
  // a submit that beat the UI's `disabled={busy}` — deducted stock twice and
  // minted two refs: measured WD-…-038 and WD-…-039, on-hand −1,500 ml for one
  // issue. Same store + material + business date + category + counts + person,
  // filed inside two minutes, is a retry until a human says otherwise.
  const dupeStmt = db.prepare(`
    SELECT ref FROM lq_withdrawals
     WHERE store_id = ? AND material_id = ? AND date = ? AND category = ?
       AND cases = ? AND bottles = ? AND COALESCE(taken_by,'') = ?
       AND created_at >= datetime('now','-120 seconds')
     ORDER BY created_at DESC LIMIT 1
  `);

  // Frozen landed cost (₹/recipe-unit) + value.
  const landed = resolveLandedUnitCost(db, {
    storeId: input.store_id, materialId: input.material_id, mat,
    explicitPerRecipeUnit: input.landed_unit_cost, asOf: date,
  });
  // Per-recipe-unit costs are STORED at 4dp — the app's convention for a unit
  // rate (storeStock avg_cost, raw_materials.average_price are 4dp) — so that
  // unit × qty reconstructs the 2dp value for ml-priced liquor (₹2.5404/ml
  // rounded to ₹2.54 would drop ₹4 on a case). VALUES stay 2dp (rupees).
  //
  // The VALUE is computed from the UNROUNDED rate, not from the stored 4dp one.
  // The admin types ₹/bottle and the page divides by the pack, so 4dp on the
  // per-ml rate is a rounding the operator never made: 15 bottles at ₹1905.29
  // stored ₹28,579.50 against an exact ₹28,579.35 (≈₹0.01/bottle, always
  // upward, ≈₹12 per 100 cases). This figure is billed to a named person, so
  // it is derived at full precision and rounded once, at the end.
  const landedUnitCost = round4(landed.value);
  const landedValue = round2(qtyRecipe * landed.value);

  const mrpRate = Math.max(0, Number(input.mrp_unit_value) || 0);
  const mrpUnit = round4(mrpRate);
  const mrpValue = round2(qtyRecipe * mrpRate);

  // Recoverable from the chosen basis; 'custom' takes the typed figure.
  //
  // A TYPED FIGURE IS NEVER SILENTLY DROPPED, and a recoverable of ₹0 on a row
  // that says money is owed is refused outright. Both were reachable: basis
  // 'mrp' with the MRP field blank (labelled "optional") created a row reading
  // "At MRP" with ₹0 recoverable that NOTHING could then correct — the UI hides
  // the recovery control on `recoverable > 0`, PATCH refuses any recovery
  // against ₹0, `recoverable_custom` is honoured only on a 'custom' row, and
  // there is no delete or void. §H then under-reports what is owed, forever.
  const customTyped = input.recoverable_custom !== undefined && input.recoverable_custom !== null;
  if (customTyped && basis !== 'custom') {
    throw new Error('A recoverable amount was entered but the recovery basis is not "Custom amount" — choose Custom, or clear the amount');
  }
  let recoverable = 0;
  if (basis === 'landed') recoverable = landedValue;
  else if (basis === 'mrp') recoverable = mrpValue;
  else if (basis === 'custom') {
    const rc = Number(input.recoverable_custom);
    if (!customTyped || !Number.isFinite(rc) || rc < 0) {
      throw new Error('Enter the recoverable amount (₹, 0 or more) for the "Custom amount" basis');
    }
    recoverable = round2(rc);
  }
  if (basis !== 'none' && !(recoverable > 0)) {
    throw new Error(
      basis === 'landed'
        ? `Recovery is set to landed cost but no landed cost resolved for ${mat.name} (source "${landed.source}") — type the Landed ₹/bottle, or set recovery to "Not recoverable"`
        : basis === 'mrp'
          ? 'Recovery is set to MRP but no MRP was entered — type the MRP ₹/bottle, or set recovery to "Not recoverable"'
          : 'A custom recovery of ₹0 recovers nothing — enter an amount, or set recovery to "Not recoverable"',
    );
  }
  const recovered = Math.max(0, round2(Number(input.recovered) || 0));
  if (recovered > recoverable + 1e-9) {
    // The schema CHECK (recovered <= recoverable) would throw a raw SQLite error;
    // this is the readable version. Over-recovery is fixed by raising recoverable,
    // never by letting recovered run past it (keeps `outstanding` from going −ve).
    throw new Error(`Recovered (₹${recovered}) cannot exceed recoverable (₹${recoverable})`);
  }

  const coWrite = !!input.co_write_wastage;
  if (coWrite && category !== 'breakage_spoilage') {
    throw new Error('The wastage co-write is only valid for the breakage/spoilage category');
  }

  // The register's own remarks. A forced issue is stamped ON THE ROW, not only
  // in /audit, so the register itself says why it shows more issued than the
  // book held.
  const remarks = [(input.remarks || '').trim(), forcedBelowOnHand ? FORCED_BELOW_ON_HAND_TAG : '']
    .filter(Boolean).join(' ');

  const insert = db.prepare(`
    INSERT INTO lq_withdrawals
      (id, ref, date, store_id, material_id, category, cases, bottles, qty_recipe_units,
       landed_unit_cost, landed_value, mrp_unit_value, mrp_value,
       taken_by, authorised_by, recovery_basis, recoverable, recovered,
       excise_register, ledger_id, wastage_id, remarks, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWastage = db.prepare(`
    INSERT INTO wastages (id, date, material_id, quantity, reason, recorded_by, notes, outlet_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ── ONE transaction. ref mint + ledger movement + (optional) wastage record +
  //    register row, all-or-nothing. IMMEDIATE takes the write lock at BEGIN so a
  //    second process serialises behind us; UNIQUE(ref) + the retry below is the
  //    belt to that brace. If ANY statement throws, the whole thing rolls back:
  //    no WD row without its stock movement, no stock movement without its WD row.
  const run = db.transaction((): LqWithdrawal => {
    if (!input.confirm_duplicate) {
      const dupe = dupeStmt.get(input.store_id, input.material_id, date, category, cases, bottles,
        (input.taken_by || '').trim()) as { ref: string } | undefined;
      if (dupe) {
        throw new Error(
          `This looks like a duplicate of ${dupe.ref}, recorded moments ago with the same item, `
          + `quantity, date and person. Confirm to record it anyway.`,
        );
      }
    }
    const ref = mintWithdrawalRef(db, date);
    const { ledgerId } = postWithdrawalStock(db, {
      store_id: input.store_id, material_id: input.material_id,
      qty_recipe_units: qtyRecipe, ref, category, recorded_by: input.recorded_by,
      note: `Withdrawal ${ref} — ${category}${input.taken_by ? ` (${input.taken_by})` : ''}`,
    });

    let wastageId = '';
    if (coWrite) {
      // RECORD ONLY — the ledger row above IS the movement. Writing the row here
      // (not via POST /api/wastage) is deliberate: that route re-derives its own
      // stock deduction, which would double-count the issue. This mirrors how
      // return-stock.ts co-writes the wastage rail for visibility without moving
      // stock a second time. Positive quantity (the rail stores magnitudes).
      //
      // `reason` MUST come from the rail's own vocabulary
      // (spoilage|expiry|damage|overcooked|spillage|other — api/wastage/route.ts
      // VALID_REASONS, mirrored by the page's filter chips and REASON_TONE). A
      // per-row string ("Breakage/Spoilage (liquor withdrawal WD-2026-013)")
      // made every co-write its own bucket: measured, the analyst by-reason
      // report returned one bucket per withdrawal and pushed `expiry` and
      // `damage` off its top-10, while /wastage's chips summed ₹600 of a ₹4,200
      // header. The identifier belongs in `notes`, as return-stock.ts does it.
      //
      // department_id is left NULL DELIBERATELY and is NOT a fix waiting to
      // happen: DELETE /api/wastage compensates a departmental row by posting
      // +qty to that department's ledger, which would invent the stock on a
      // department rail instead of the central one. See the WARNING above
      // co_write_wastage for what still bites on the central branch.
      wastageId = generateId();
      insertWastage.run(
        wastageId, date, input.material_id, qtyRecipe,
        CO_WRITE_WASTAGE_REASON,
        input.recorded_by,
        `${ref} · liquor withdrawal, RECORD ONLY — stock already off the ${store.name} ledger`
          + ` (₹${landedValue} landed); deleting this row credits stock that never left central`
          + `${remarks ? ` — ${remarks}` : ''}`,
        input.outlet_id || null,
      );
    }

    const id = generateId();
    insert.run(
      id, ref, date, input.store_id, input.material_id, category,
      cases, bottles, qtyRecipe,
      landedUnitCost, landedValue, mrpUnit, mrpValue,
      (input.taken_by || '').trim(), (input.authorised_by || '').trim(),
      basis, recoverable, recovered,
      input.excise_register ? 1 : 0, ledgerId, wastageId,
      remarks, input.recorded_by,
    );
    return getWithdrawalById(db, id)!;
  });

  // Retry only on a ref collision (the one cross-process race the mint can lose).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const row = run.immediate();
      logAuditEvent(db, {
        event_type: 'liquor.withdrawal.create',
        entity_type: 'lq_withdrawals',
        entity_id: row.id,
        actor_email: input.recorded_by,
        outlet_id: input.outlet_id || null,
        after: {
          ref: row.ref, store_id: row.store_id, store: store.name,
          material_id: row.material_id, material: mat.name, category: row.category,
          cases, bottles, qty_recipe_units: qtyRecipe, recipe_unit: mat.unit,
          landed_unit_cost: landedUnitCost, landed_value: landedValue, landed_source: landed.source,
          mrp_value: mrpValue, recovery_basis: basis, recoverable, recovered,
          excise_register: !!input.excise_register, ledger_id: row.ledger_id,
          wastage_id: row.wastage_id, co_write_wastage: coWrite,
          taken_by: row.taken_by, authorised_by: row.authorised_by,
          // Was the on-hand guard overridden, and did it actually bite?
          allow_negative: !!input.allow_negative,
          forced_below_on_hand: forcedBelowOnHand,
          on_hand_before: onHand,
          confirm_duplicate: !!input.confirm_duplicate,
        },
        note: `${store.name}: withdrawal ${row.ref} — ${qtyRecipe} ${mat.unit} ${mat.name}`
          + ` (${category})${recoverable ? `, ₹${recoverable} recoverable` : ''}`,
      });
      return row;
    } catch (e: any) {
      lastErr = e;
      if (e && typeof e.message === 'string' && UNIQUE_REF_RE.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Could not mint a unique withdrawal ref');
}

/* ── Reads ────────────────────────────────────────────────────────────────── */
export function getWithdrawalById(db: Database.Database, id: string): LqWithdrawal | null {
  const r = db.prepare('SELECT * FROM lq_withdrawals WHERE id = ?').get(id) as LqWithdrawal | undefined;
  return r || null;
}

export interface WithdrawalFilter {
  from?: string;            // YYYY-MM-DD (inclusive, on the business date)
  to?: string;              // YYYY-MM-DD (inclusive)
  category?: LqWithdrawalCategory | '';
  store_id?: string;
  outstanding_only?: boolean;
}

export interface WithdrawalRow extends LqWithdrawal {
  material_name: string;
  material_unit: string;
  material_purchase_unit: string;
  material_pack_size: number;
  material_case_size: number;
  store_name: string;
}

export function listWithdrawals(db: Database.Database, f: WithdrawalFilter = {}): WithdrawalRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (f.from) { where.push('w.date >= ?'); args.push(f.from); }
  if (f.to) { where.push('w.date <= ?'); args.push(f.to); }
  if (f.category) { where.push('w.category = ?'); args.push(f.category); }
  if (f.store_id) { where.push('w.store_id = ?'); args.push(f.store_id); }
  if (f.outstanding_only) where.push('(w.recoverable - w.recovered) > 0');
  const sql = `
    SELECT w.*,
           rm.name AS material_name, rm.unit AS material_unit,
           COALESCE(rm.purchase_unit, rm.unit) AS material_purchase_unit,
           COALESCE(rm.pack_size, 1) AS material_pack_size,
           COALESCE(rm.case_size, 1) AS material_case_size,
           COALESCE(s.name, '') AS store_name
    FROM lq_withdrawals w
    JOIN raw_materials rm ON rm.id = w.material_id
    LEFT JOIN store_locations s ON s.id = w.store_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY w.date DESC, w.created_at DESC
  `;
  return db.prepare(sql).all(...args) as WithdrawalRow[];
}

/* ── Section H — split by category, % of purchases, recoverable outstanding ───
 * Everything here is COMPUTED from recorded rows (rule 2), never stored. The
 * denominator for "% of purchases" is the store INFLOW value over the same window
 * (store_stock_ledger inflow rows), on the IST business date. Note this is a
 * cost-basis purchase figure and is independent of the analytics-only landed
 * cost — the withdrawal numerator is landed value, the ratio is a rough "how much
 * of what we bought walked out unsold" gauge, exactly as the workbook's §H reads.
 *
 * PERIOD BASIS, stated because the two sides differ and cannot be made to agree
 * here: the numerator buckets on lq_withdrawals.date (the BUSINESS date the
 * admin typed), the denominator on store_stock_ledger.created_at (+330 minutes),
 * because the ledger has no business-date column — postLedger stamps `now` and
 * that is a store-rail fact, not an L4 one. Future dates are refused at create,
 * so the drift is bounded to backdating: a bottle recorded today for last month
 * counts in last month's §H while its stock left the ledger today. */
export interface WithdrawalCategoryStat {
  category: LqWithdrawalCategory;
  count: number;
  qty_recipe_units: number;
  landed_value: number;
  mrp_value: number;
  recoverable: number;
  recovered: number;
  outstanding: number;
}
export interface WithdrawalSummary {
  from: string; to: string; store_id: string;
  by_category: WithdrawalCategoryStat[];
  total_landed_value: number;
  total_recoverable: number;
  total_recovered: number;
  total_outstanding: number;
  purchases_value: number;
  /** total_landed_value ÷ purchases_value × 100, or null when purchases = 0. */
  pct_of_purchases: number | null;
}

export function withdrawalSummary(db: Database.Database, f: WithdrawalFilter = {}): WithdrawalSummary {
  const from = f.from || '';
  const to = f.to || '';
  const where: string[] = [];
  const args: any[] = [];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  if (f.store_id) { where.push('store_id = ?'); args.push(f.store_id); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT category,
           COUNT(*) AS count,
           COALESCE(SUM(qty_recipe_units), 0) AS qty_recipe_units,
           COALESCE(SUM(landed_value), 0)     AS landed_value,
           COALESCE(SUM(mrp_value), 0)        AS mrp_value,
           COALESCE(SUM(recoverable), 0)      AS recoverable,
           COALESCE(SUM(recovered), 0)        AS recovered,
           COALESCE(SUM(recoverable - recovered), 0) AS outstanding
    FROM lq_withdrawals ${clause}
    GROUP BY category
  `).all(...args) as any[];

  const byCat = new Map<string, WithdrawalCategoryStat>();
  for (const c of LQ_WITHDRAWAL_CATEGORIES) {
    byCat.set(c, { category: c, count: 0, qty_recipe_units: 0, landed_value: 0, mrp_value: 0, recoverable: 0, recovered: 0, outstanding: 0 });
  }
  let totLanded = 0, totRecoverable = 0, totRecovered = 0, totOutstanding = 0;
  for (const r of rows) {
    const stat: WithdrawalCategoryStat = {
      category: r.category,
      count: Number(r.count) || 0,
      qty_recipe_units: round2(Number(r.qty_recipe_units) || 0),
      landed_value: round2(Number(r.landed_value) || 0),
      mrp_value: round2(Number(r.mrp_value) || 0),
      recoverable: round2(Number(r.recoverable) || 0),
      recovered: round2(Number(r.recovered) || 0),
      outstanding: round2(Number(r.outstanding) || 0),
    };
    byCat.set(r.category, stat);
    totLanded += stat.landed_value;
    totRecoverable += stat.recoverable;
    totRecovered += stat.recovered;
    totOutstanding += stat.outstanding;
  }

  // Denominator: store inflow value over the window, IST business date.
  const pWhere: string[] = ["quantity > 0", "txn_type IN ('purchase','inward')"];
  const pArgs: any[] = [];
  if (f.store_id) { pWhere.push('store_id = ?'); pArgs.push(f.store_id); }
  if (from) { pWhere.push("date(created_at,'+330 minutes') >= ?"); pArgs.push(from); }
  if (to) { pWhere.push("date(created_at,'+330 minutes') <= ?"); pArgs.push(to); }
  const pRow = db.prepare(`
    SELECT COALESCE(SUM(quantity * unit_cost), 0) AS v
    FROM store_stock_ledger WHERE ${pWhere.join(' AND ')}
  `).get(...pArgs) as { v: number };
  const purchases = round2(Number(pRow?.v) || 0);

  return {
    from, to, store_id: f.store_id || '',
    by_category: LQ_WITHDRAWAL_CATEGORIES.map(c => byCat.get(c)!),
    total_landed_value: round2(totLanded),
    total_recoverable: round2(totRecoverable),
    total_recovered: round2(totRecovered),
    total_outstanding: round2(totOutstanding),
    purchases_value: purchases,
    pct_of_purchases: purchases > 0 ? round2((totLanded / purchases) * 100) : null,
  };
}

/* ── Recovery recording ──────────────────────────────────────────────────────
 * Updates recovered / recoverable / remarks. NEVER touches `outstanding`
 * (generated) or the stock movement (a recovery is money, not stock). The
 * recovered <= recoverable invariant is checked here and by the schema CHECK. */
export interface RecoveryUpdate {
  recovered?: number | null;
  /** Only a 'custom'-basis row takes a typed recoverable; sending this for any
   *  other basis is REFUSED (it used to be silently ignored). */
  recoverable_custom?: number | null;
  remarks?: string | null;
  actor_email: string;
}
export function recordRecovery(db: Database.Database, id: string, u: RecoveryUpdate): LqWithdrawal {
  // Read + write inside ONE transaction. The read-modify-write is unreachable
  // as a lost update today (synchronous better-sqlite3, one process, no await
  // between the two), but this is a money field and the transaction costs
  // nothing. `recoverable` is written back only when it actually changed, so a
  // caller sending only `recovered` cannot clobber a concurrent change to it.
  const cur = getWithdrawalById(db, id);
  if (!cur) throw new Error('Withdrawal not found');

  let recoverable = Number(cur.recoverable) || 0;
  if (u.recoverable_custom !== undefined && u.recoverable_custom !== null) {
    // REFUSE rather than ignore. Silently returning 200 with the unchanged row
    // told a caller correcting a money figure that it had worked: measured, a
    // 'landed' row at ₹1,800 patched with recoverable_custom 5 came back 200,
    // still ₹1,800.
    if (cur.recovery_basis !== 'custom') {
      throw new Error(
        `${cur.ref} recovers at "${cur.recovery_basis}", so its recoverable is derived and cannot be typed`
        + ` — only a "Custom amount" row takes a recoverable figure`,
      );
    }
    const rc = Number(u.recoverable_custom);
    if (!Number.isFinite(rc) || rc < 0) throw new Error('recoverable must be a number ≥ 0');
    recoverable = round2(rc);
  }
  let recovered = Number(cur.recovered) || 0;
  if (u.recovered !== undefined && u.recovered !== null) {
    const rv = Number(u.recovered);
    if (!Number.isFinite(rv) || rv < 0) throw new Error('recovered must be a number ≥ 0');
    recovered = round2(rv);
  }
  if (recovered > recoverable + 1e-9) {
    throw new Error(`Recovered (₹${recovered}) cannot exceed recoverable (₹${recoverable})`);
  }
  const remarks = u.remarks !== undefined && u.remarks !== null ? String(u.remarks) : cur.remarks;
  const recoverableChanged = Math.abs(recoverable - (Number(cur.recoverable) || 0)) > 1e-9;

  db.transaction(() => {
    if (recoverableChanged) {
      db.prepare(`
        UPDATE lq_withdrawals
           SET recovered = ?, recoverable = ?, remarks = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(recovered, recoverable, remarks, id);
    } else {
      db.prepare(`
        UPDATE lq_withdrawals
           SET recovered = ?, remarks = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(recovered, remarks, id);
    }
  })();

  const row = getWithdrawalById(db, id)!;
  logAuditEvent(db, {
    event_type: 'liquor.withdrawal.recovery',
    entity_type: 'lq_withdrawals',
    entity_id: id,
    actor_email: u.actor_email,
    before: { recoverable: cur.recoverable, recovered: cur.recovered, outstanding: cur.outstanding },
    after: { recoverable: row.recoverable, recovered: row.recovered, outstanding: row.outstanding },
    note: `Withdrawal ${row.ref}: recovered ₹${row.recovered} of ₹${row.recoverable} (₹${row.outstanding} outstanding)`,
  });
  return row;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function round4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}
