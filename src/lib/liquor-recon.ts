/**
 * LIQUOR PURCHASE RECONCILIATION — SHARED CONTRACT (phase L0, foundation).
 *
 * Plan: docs/liquor-reconciliation-plan.md. Tables: the `lq_*` block at the end
 * of initializeSchema() in src/lib/db.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE HAS NO IMPLEMENTATION AND NO RUNTIME BEHAVIOUR, ON PURPOSE.
 *
 * Phases L1-L5 are five separate builds over the same tables. Left to
 * themselves each would invent its own spelling of 'staff welfare', its own
 * landed-cost formula and its own row types, and the module would disagree with
 * itself in five places. So L0 fixes the VOCABULARY and the SHAPES here, and
 * each phase adds the function it owns, in this file, where the others can see
 * it. What is written below is types, frozen token lists, and the CONTRACTS the
 * shared functions must satisfy — the bodies belong to the phases.
 *
 * A phase implementing one of these: keep the contract comment above your
 * function, and delete its line from the "not yet built" list at the bottom.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TWO RULES THAT OUTRANK ANY CONVENIENCE IN A LATER PHASE
 *
 * 1. NOTHING HERE CHANGES VALUATION. Plan decision 1(a): the TGBCL levies stay
 *    RECORDED-ONLY. Landed cost is an analytics figure that lives inside this
 *    module. It must never be written to raw_materials.average_price,
 *    raw_materials.last_purchase_price or store_stock_ledger.unit_cost —
 *    pour costs, recipe costs and every variance value hang off those.
 *
 * 2. NOTHING DERIVED IS STORED. The wallet balance is SUM(amount); the uplift
 *    factors, effective TCS, cess per case, MRP rounding per bottle and average
 *    landed cost per bottle are computed from recorded lines, exactly as the
 *    workbook computes them. The only stored "figure we did not compute" is an
 *    OBSERVED portal amount in lq_portal_checks, which is what checks A and B
 *    compare against.
 */

/* Imports arrived with phase L1 (the file was types-only before it). Kept at
 * the top of the module rather than beside the L1 block, so the next phase does
 * not have to hunt for where the file's dependencies live. */
import type { Database } from 'better-sqlite3';
import { packFactor } from '@/lib/pack-units';
import { parseMaterialVolumeMl } from '@/lib/db';

/* ── Frozen vocabularies ─────────────────────────────────────────────────────
 * These are the exact tokens the CHECK constraints in db.ts accept. An import
 * or a form that produces anything else fails loudly at INSERT — deliberately,
 * because a second spelling would silently split every category total in the
 * Summary. Normalise at the edge (importer / API), never by loosening a CHECK.
 */

/* ── The other constraints a phase will meet, so none of them is a surprise ──
 * All of these THROW rather than storing something quietly wrong. Nothing here
 * is a type the compiler can check for you.
 *
 *   lq_brand_map.bottles_per_case   NOT NULL and > 0. It has no default: every
 *     landed cost divides by it, and SQLite returns NULL (not an error) for
 *     division by zero — the same value landedCostPerBottle() reserves for
 *     "not mapped". A Brand Master import MUST supply it per row.
 *     size_ml is NOT constrained; 0 means "unknown", so guard size_ml > 0
 *     before any per-ml arithmetic.
 *   lq_wallet_txns.amount           signed BY TYPE: opening/deposit >= 0,
 *     indent_debit <= 0, adjustment free (it is the ± correction row). A
 *     history import that writes debits unsigned will fail here, loudly, which
 *     is the point — the balance is SUM(amount).
 *   lq_wallet_txns.reference        an indent_debit MUST carry one.
 *   lq_wallet_txns                  ONE opening per outlet
 *     (uq_lq_wallet_opening); ONE debit per (outlet, reference)
 *     (uq_lq_wallet_indent_debit); ONE debit per source_ref
 *     (uq_lq_wallet_debit_source — source_ref is store_bill_charges.id and is
 *     the auto-debit's real identity, because outlet_id can be NULL).
 *     An UPSERT against a PARTIAL index must repeat its WHERE in the conflict
 *     target or SQLite refuses to match the constraint at all.
 *   lq_retail_flags.date            NOT NULL, no default (a dateless flag is
 *     invisible to every §E date-range total).
 *   lq_withdrawals.qty_recipe_units >= 0 — POSITIVE here, the sign belongs to
 *     the store_stock_ledger row postWithdrawalStock writes.
 *   lq_withdrawals                  0 <= recovered <= recoverable, so the
 *     generated `outstanding` can never go negative against §H.
 */

/** lq_brand_map.product_type — the workbook's own three spellings, verbatim. */
export const LQ_PRODUCT_TYPES = ['BEER', 'IML', 'Duty Paid'] as const;
export type LqProductType = (typeof LQ_PRODUCT_TYPES)[number];

/** lq_wallet_txns.type. `indent_debit` rows are machine-written from a recorded
 *  indent; the other three are entered by a person. */
export const LQ_WALLET_TXN_TYPES = ['opening', 'deposit', 'indent_debit', 'adjustment'] as const;
export type LqWalletTxnType = (typeof LQ_WALLET_TXN_TYPES)[number];

/** lq_wallet_txns.bank_match — meaningful on a DEPOSIT row only. Summary check
 *  C (bank-unconfirmed deposits) is type='deposit' AND bank_match='pending'. */
export const LQ_BANK_MATCH = ['pending', 'verified'] as const;
export type LqBankMatch = (typeof LQ_BANK_MATCH)[number];

/** lq_retail_flags.reimbursement_status. 'claimed_pending' is closed by a petty
 *  cash payout, which sets petty_cash_id (see the FK: deleting that payout sets
 *  the link back to NULL and the claim reopens). */
export const LQ_REIMBURSEMENT_STATUS = ['not_required', 'claimed_pending', 'reimbursed', 'rejected'] as const;
export type LqReimbursementStatus = (typeof LQ_REIMBURSEMENT_STATUS)[number];

/** lq_withdrawals.category — the workbook's Stock Withdrawals split (Summary §H). */
export const LQ_WITHDRAWAL_CATEGORIES = [
  'management_personal', 'staff_welfare', 'marketing_sampling', 'breakage_spoilage', 'transfer',
] as const;
export type LqWithdrawalCategory = (typeof LQ_WITHDRAWAL_CATEGORIES)[number];

/** lq_withdrawals.recovery_basis — what `recoverable` was calculated from. */
export const LQ_RECOVERY_BASIS = ['none', 'landed', 'mrp', 'custom'] as const;
export type LqRecoveryBasis = (typeof LQ_RECOVERY_BASIS)[number];

/** lq_portal_checks.kind — which Summary check the observation feeds
 *  ('wallet_balance' → check A, 'indent_value' → check B). */
export const LQ_PORTAL_CHECK_KINDS = ['wallet_balance', 'indent_value'] as const;
export type LqPortalCheckKind = (typeof LQ_PORTAL_CHECK_KINDS)[number];

/* ── Row shapes — one per lq_ table, column-for-column ────────────────────── */

export interface LqBrandMap {
  id: string;
  material_id: string;
  tgbcl_brand_code: string;
  /** TGBCL pack letter(s) — PP, NN, QQ … One material maps to several rows when
   *  it is bought in several packs, so the key is (code, size_code). */
  size_code: string;
  size_ml: number;
  bottles_per_case: number;
  /** ₹ per CASE (TGBCL issue price). Rate per bottle is derived, never stored. */
  rate_per_case_master: number;
  product_type: LqProductType;
  is_active: number;
  note: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LqWalletTxn {
  id: string;
  outlet_id: string | null;
  date: string;
  type: LqWalletTxnType;
  /** challan no (deposit) | indent/invoice ref (indent_debit). */
  reference: string;
  /** SIGNED ₹: + into the wallet, − spent. The running balance is SUM(amount)
   *  and is NEVER stored — see the db.ts comment before adding a balance field. */
  amount: number;
  payment_mode: string;
  bank_debit_date: string;
  bank_amount: number;
  bank_match: LqBankMatch;
  portal_status: string;
  /** store_bill_charges.id when the row was auto-created from a recorded indent. */
  source_ref: string;
  remarks: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LqRetailFlag {
  id: string;
  /** The purchases row this annotates — one flag per purchase LINE. */
  purchase_id: string;
  bill_ref: string;
  date: string;
  shop_name: string;
  shop_licence_no: string;
  bottles: number;
  rate_paid_per_bottle: number;
  /** Depot landed cost per bottle AT ENTRY. Frozen: depot cost moves with every
   *  later indent, and silently re-pricing last quarter's emergency buy would
   *  make the "price of running out" unreadable. */
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
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export interface LqWithdrawal {
  id: string;
  /** WD-YYYY-### — the human handle, UNIQUE. */
  ref: string;
  date: string;
  store_id: string;
  material_id: string;
  category: LqWithdrawalCategory;
  cases: number;
  bottles: number;
  /** What the store_stock_ledger row actually moved, held POSITIVE — the sign
   *  belongs to the ledger row, which is signed. */
  qty_recipe_units: number;
  landed_unit_cost: number;
  landed_value: number;
  mrp_unit_value: number;
  mrp_value: number;
  taken_by: string;
  authorised_by: string;
  recovery_basis: LqRecoveryBasis;
  recoverable: number;
  recovered: number;
  /** GENERATED in SQLite as (recoverable − recovered). READ-ONLY: an INSERT or
   *  UPDATE that names this column fails. */
  readonly outstanding: number;
  excise_register: number;
  ledger_id: string;
  wastage_id: string;
  remarks: string;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * The INSERT shape. `outstanding` is a GENERATED column: naming it in an INSERT
 * or UPDATE fails with "cannot INSERT into generated column", so the read shape
 * above — which requires it — cannot be used to build a row literal. Use this
 * for writes and `LqWithdrawal` for reads.
 */
export type LqWithdrawalInsert = Omit<LqWithdrawal, 'outstanding'>;

export interface LqPortalCheck {
  id: string;
  outlet_id: string | null;
  kind: LqPortalCheckKind;
  as_of_date: string;
  reference: string;
  /** ₹ AS SHOWN by TGBCL. Observed, never computed — this is the figure our own
   *  computation is checked against. */
  portal_amount: number;
  source: string;
  observed_by: string;
  note: string;
  created_at: string;
  updated_at: string;
}

/* ── Shared helpers — CONTRACTS ───────────────────────────────────────────────
 *
 * These four are the pieces more than one phase needs. They live here, not in a
 * phase's own file, so the module has ONE landed cost and ONE wallet balance.
 * Each phase implements the ones it needs, in this file, keeping the contract.
 *
 * BUILT ELSEWHERE — the two below were implemented by their own phases in
 * their own libs rather than here (walletBalanceAsOf → src/lib/liquor-wallet.ts,
 * postWithdrawalStock → src/lib/liquor-withdrawals.ts, both verified present
 * 2026-08-28). The CONTRACTS below still bind them; only the address moved, so
 * a reader looking for the module's ONE wallet balance is sent to it rather
 * than concluding it does not exist and writing a second one.
 *
 * walletBalanceAsOf(db, { outletId, date })
 *   → { balance, lastTxnDate, depositTotal, debitTotal }
 *   Owner: L2. Read by L5 (§A wallet reconciliation, §A2 top-up planner).
 *   CONTRACT: SUM(amount) over lq_wallet_txns up to and including `date`,
 *   nothing stored, nothing cached. Signed amounts, so the sum IS the balance.
 *
 * postWithdrawalStock(db, withdrawal)
 *   → { ledgerId }
 *   Owner: L4. CONTRACT: one signed NEGATIVE store_stock_ledger row, written in
 *   the SAME transaction as the lq_withdrawals row, its id stored in
 *   ledger_id. If the ledger write cannot happen, the register row must not
 *   exist either — a withdrawal that did not move stock is a phantom that turns
 *   up later as an unexplained variance against a bar.
 *
 * BUILT BY L1 — landedCostPerBottle and rateVarianceForIndent, below, each
 * under its own contract comment.
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * L1 IMPLEMENTATION — brand master mapping, rate-vs-master variance, landed
 * cost per bottle. Built 2026-08-28.
 *
 * NOTHING BELOW WRITES. Every function here is a pure read over recorded rows
 * (store_stock_ledger, store_bill_charges, lq_brand_map, raw_materials). The
 * ONE write in phase L1 — accepting an indent rate into the master — lives in
 * the route (src/app/api/liquor/brand-map/variance/route.ts) where it is
 * gated and AUDITED, per the rateVarianceForIndent contract: "accepting a new
 * rate into the master is a separate, AUDITED write ... never a side effect of
 * reading."
 * ═══════════════════════════════════════════════════════════════════════════ */

/** ₹, 2dp. Same rounding as the deployed inward register (store-engine.ts). */
const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
/** ₹ per bottle, 4dp — a per-bottle rate divided out of a case must not be
 *  rounded to paise before it is multiplied back up by the bottle count. */
const r4 = (n: number): number => Math.round((Number(n) || 0) * 1e4) / 1e4;

/** Bill key: the deployed register groups lines by TRIM(ref) lower-cased and
 *  getBillChargesForStore keys store_bill_charges the same way. Mirrored here
 *  so a bill can never be one thing to the register and another to this file. */
export const lqBillKey = (ref: string | null | undefined): string =>
  String(ref ?? '').trim().toLowerCase();

/* ── Allocation bases ───────────────────────────────────────────────────────
 * The workbook's Indent Lines sheet allocates the four bill-level TGBCL levies
 * across the bill's lines on TWO different bases, and they are not
 * interchangeable:
 *
 *   MRP ROUNDING      → BY BOTTLES.    It is a per-bottle rounding of MRP, so a
 *                       cheap 650 ml beer carries the same rounding as a
 *                       premium single malt. Allocating it by value would push
 *                       it onto the expensive lines, which is backwards.
 *   TURNOVER TAX      → BY LINE VALUE. Ad-valorem levies.
 *   SPECIAL EXCISE CESS
 *   TCS
 *
 * ⚠️ THE DEPLOYED INWARD REGISTER DOES NOT DO THIS. getStoreInwardRegister()
 * in src/lib/store-engine.ts (deployed f732956) allocates ALL FOUR by line
 * value (`share = ln.subtotal / billTot`), including MRP rounding. Verified by
 * reading the code, 2026-08-28. Per-BILL totals are identical either way — only
 * the per-LINE split differs — so the Net Indent check (Summary §B) is
 * unaffected, and the register was NOT changed here: it is deployed, the change
 * would silently move every historical line's `mrp_round_off` column, and that
 * is the owner's call, not this phase's. This file follows the WORKBOOK, which
 * is what the L0 contract names, and the inward-register route reports BOTH so
 * the difference is visible instead of argued about.
 */
export const LQ_ALLOCATION_BASIS = {
  mrp_rounding: 'bottles',
  excise_turnover_tax: 'line_value',
  special_excise_cess: 'line_value',
  tcs: 'line_value',
} as const;

/** The four bill-level TGBCL levies, as stored on store_bill_charges. */
export interface LqBillLevies {
  mrp_rounding: number;
  excise_turnover_tax: number;
  special_excise_cess: number;
  tcs: number;
}

/** One recorded indent LINE, with its share of the bill's levies. */
export interface LqIndentLine {
  /** store_stock_ledger.id — the line's identity. */
  ledgerId: string;
  storeId: string;
  materialId: string;
  materialName: string;
  category: string;
  /** The date the line was recorded (YYYY-MM-DD). */
  inwardDate: string;
  supplier: string;
  invoiceRef: string;
  /** Bottles (purchase units) on this line — quantity ÷ packFactor. */
  bottles: number;
  /** ₹ per BOTTLE actually recorded on the indent (unit_cost × packFactor). */
  indentRatePerBottle: number;
  /** bottles × indentRatePerBottle, 2dp — the line's own value. */
  subtotal: number;
  /** This line's share of each bill-level levy, on the bases above. Signed:
   *  MRP rounding is a signed correction and is routinely negative. */
  allocated: LqBillLevies;
  /** Σ of the four, 2dp. */
  leviesLine: number;
  /** leviesLine ÷ bottles. */
  leviesPerBottle: number;
  /** The PER-LINE charges recorded on the ledger row itself
   *  (cgst + sgst + delivery − discount). NOT part of `leviesLine`: the L0
   *  contract names only the four bill-level levies, and on a TGBCL indent
   *  these are normally zero. Carried so a caller that needs the full cost of
   *  the line can see them rather than assume them away. */
  lineCharges: number;
  lineChargesPerBottle: number;
}

/** A whole recorded bill, allocated. */
export interface LqIndentAllocation {
  storeId: string;
  invoiceRef: string;
  /** null when no store_bill_charges row exists — the bill was recorded with
   *  no TGBCL levies, so every allocated share is 0 (not "unknown"). */
  levies: LqBillLevies | null;
  billBottles: number;
  billSubtotal: number;
  lines: LqIndentLine[];
}

const ZERO_LEVIES: LqBillLevies = {
  mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0,
};

/**
 * Read one recorded indent (store + invoice ref) and allocate its bill-level
 * levies across its lines, on the workbook's two bases.
 *
 * WHOLE BILL, ALWAYS. The date range a screen is showing never enters here: a
 * bill's shares must add up to the bill, and allocating across only the lines
 * that happen to fall inside a filter would silently mis-split every levy on a
 * bill that straddles the range boundary. (The deployed register does allocate
 * within its filtered set — noted, not copied.)
 *
 * REMAINDER TO THE LAST LINE, so the parts sum to the recorded amount EXACTLY
 * and a bill can never gain or lose a paisa to rounding. Same technique as the
 * deployed register; the ordering is matched to it too (created_at DESC,
 * rowid DESC) so the three value-based shares land on the same lines there and
 * here.
 */
export function allocateIndentBill(
  db: Database, storeId: string, invoiceRef: string,
): LqIndentAllocation {
  const key = lqBillKey(invoiceRef);
  const rows = db.prepare(`
    ${INDENT_LINE_SELECT}
    WHERE l.store_id = ? AND l.txn_type = 'purchase'
      AND lower(TRIM(l.ref)) = ?
    ORDER BY l.created_at DESC, l.rowid DESC
  `).all(storeId, key) as any[];

  // ORDER BY rowid, LIMIT 1 — the SAME tie-break billLeviesForKeys uses. The
  // UNIQUE on store_bill_charges is (store_id, invoice_ref) CASE-SENSITIVELY
  // while every reader keys on lower(TRIM(...)), so "ind-1" and "IND-1" can
  // both exist. Without an ORDER BY, .get() returns whichever row the query
  // plan reached first, and the per-bill read and the batched read could then
  // allocate DIFFERENT levies over the same lines — which would have made the
  // "byte-identical to the per-bill path" claim on rateMovementForStore false.
  const bc = db.prepare(`
    SELECT mrp_rounding, excise_turnover_tax, special_excise_cess, tcs
    FROM store_bill_charges
    WHERE store_id = ? AND lower(TRIM(invoice_ref)) = ?
    ORDER BY rowid
    LIMIT 1
  `).get(storeId, key) as any;

  return allocateFromRows(storeId, invoiceRef, rows, shapeLevies(bc));
}

/** The columns every allocation reads. One spelling, so the per-bill read and
 *  the batched read below can never diverge in what they select. */
const INDENT_LINE_SELECT = `
  SELECT l.id, l.store_id, l.material_id, l.quantity, l.unit_cost,
         l.discount, l.cgst, l.sgst, l.delivery_charges,
         substr(l.created_at, 1, 10) AS inward_date, TRIM(l.ref) AS invoice_ref,
         l.supplier,
         rm.name AS material_name, rm.category, rm.unit, rm.purchase_unit,
         rm.pack_size, rm.case_size
  FROM store_stock_ledger l
  JOIN raw_materials rm ON rm.id = l.material_id
`;

/** A store_bill_charges row → the four levies, or null when there is no row. */
function shapeLevies(bc: any): LqBillLevies | null {
  return bc ? {
    mrp_rounding:        Number(bc.mrp_rounding) || 0,
    excise_turnover_tax: Number(bc.excise_turnover_tax) || 0,
    special_excise_cess: Number(bc.special_excise_cess) || 0,
    tcs:                 Number(bc.tcs) || 0,
  } : null;
}

/**
 * The allocation itself — PURE, so the same arithmetic serves one bill read on
 * its own and a whole store read in one pass. `rows` must already be in the
 * bill's own order (created_at DESC, rowid DESC): the remainder lands on the
 * LAST line, so the order decides which line carries it.
 */
function allocateFromRows(
  storeId: string, invoiceRef: string, rows: any[], levies: LqBillLevies | null,
): LqIndentAllocation {
  const L = levies || ZERO_LEVIES;

  const base = rows.map(r => {
    const pf = packFactor(r);
    const qty = Number(r.quantity) || 0;
    const uc = Number(r.unit_cost) || 0;
    const bottles = pf > 1 ? qty / pf : qty;
    const ratePerBottle = pf > 1 ? uc * pf : uc;
    return { r, bottles, ratePerBottle, subtotal: r2(qty * uc) };
  });

  const billBottles = base.reduce((s, b) => s + b.bottles, 0);
  const billSubtotal = r2(base.reduce((s, b) => s + b.subtotal, 0));

  // Running allocations, remainder to the LAST line of the bill.
  const acc = { mrp_rounding: 0, excise_turnover_tax: 0, special_excise_cess: 0, tcs: 0 };
  const n = base.length;
  const lines: LqIndentLine[] = base.map((b, i) => {
    const isLast = i === n - 1;
    const alloc = (total: number, k: keyof LqBillLevies, byBottles: boolean): number => {
      if (n === 0) return 0;
      if (isLast) return r2(total - acc[k]);
      const denom = byBottles ? billBottles : billSubtotal;
      const numer = byBottles ? b.bottles : b.subtotal;
      const v = denom > 0 ? r2(total * (numer / denom)) : r2(total / n);
      acc[k] += v;
      return v;
    };
    // ORDER MATTERS ONLY INSIDE A KEY (each has its own accumulator), but the
    // bases differ per key — that is the whole point of this block.
    const mrp  = alloc(L.mrp_rounding,        'mrp_rounding',        true);
    const turn = alloc(L.excise_turnover_tax, 'excise_turnover_tax', false);
    const cess = alloc(L.special_excise_cess, 'special_excise_cess', false);
    const tcs  = alloc(L.tcs,                 'tcs',                 false);
    const leviesLine = r2(mrp + turn + cess + tcs);
    const lineCharges = r2(
      (Number(b.r.cgst) || 0) + (Number(b.r.sgst) || 0) +
      (Number(b.r.delivery_charges) || 0) - (Number(b.r.discount) || 0),
    );
    return {
      ledgerId: String(b.r.id),
      storeId: String(b.r.store_id),
      materialId: String(b.r.material_id),
      materialName: String(b.r.material_name || ''),
      category: String(b.r.category || ''),
      inwardDate: String(b.r.inward_date || ''),
      supplier: String(b.r.supplier || ''),
      invoiceRef: String(b.r.invoice_ref || ''),
      bottles: b.bottles,
      indentRatePerBottle: r4(b.ratePerBottle),
      subtotal: b.subtotal,
      allocated: { mrp_rounding: mrp, excise_turnover_tax: turn, special_excise_cess: cess, tcs },
      leviesLine,
      leviesPerBottle: b.bottles > 0 ? r4(leviesLine / b.bottles) : 0,
      lineCharges,
      lineChargesPerBottle: b.bottles > 0 ? r4(lineCharges / b.bottles) : 0,
    };
  });

  return { storeId, invoiceRef: String(invoiceRef || '').trim(), levies, billBottles, billSubtotal, lines };
}

/* ── Brand-map resolution ──────────────────────────────────────────────────── */

/** A brand-map row joined to the material it maps. */
export interface LqBrandMapRow extends LqBrandMap {
  material_name: string;
  material_unit: string;
  material_purchase_unit: string;
  material_pack_size: number;
  material_case_size: number;
  /** rate_per_case_master ÷ bottles_per_case, 4dp. DERIVED, never stored. */
  rate_per_bottle_master: number;
}

const BRAND_MAP_SELECT = `
  SELECT bm.*, rm.name AS material_name, rm.unit AS material_unit,
         rm.purchase_unit AS material_purchase_unit,
         rm.pack_size AS material_pack_size, rm.case_size AS material_case_size
  FROM lq_brand_map bm
  JOIN raw_materials rm ON rm.id = bm.material_id
`;

function shapeBrandMap(r: any): LqBrandMapRow {
  const bpc = Number(r.bottles_per_case) || 0;
  return {
    ...r,
    size_ml: Number(r.size_ml) || 0,
    bottles_per_case: bpc,
    rate_per_case_master: Number(r.rate_per_case_master) || 0,
    is_active: Number(r.is_active) || 0,
    material_pack_size: Number(r.material_pack_size) || 0,
    material_case_size: Number(r.material_case_size) || 0,
    // bottles_per_case is CHECKed > 0 by the schema, so this divide is safe on
    // any row that came out of the table. The guard is for a hand-built object.
    rate_per_bottle_master: bpc > 0 ? r4((Number(r.rate_per_case_master) || 0) / bpc) : 0,
  } as LqBrandMapRow;
}

/** Every brand-map row for one material (a material may hold several packs). */
export function brandMapsForMaterial(
  db: Database, materialId: string, opts?: { includeInactive?: boolean },
): LqBrandMapRow[] {
  const rows = db.prepare(
    `${BRAND_MAP_SELECT} WHERE bm.material_id = ?
     ${opts?.includeInactive ? '' : 'AND bm.is_active = 1'}
     ORDER BY bm.tgbcl_brand_code, bm.size_code`,
  ).all(materialId) as any[];
  return rows.map(shapeBrandMap);
}

/** One brand-map row by its id (active or not — an id is an explicit choice). */
export function brandMapById(db: Database, id: string): LqBrandMapRow | null {
  const r = db.prepare(`${BRAND_MAP_SELECT} WHERE bm.id = ?`).get(id) as any;
  return r ? shapeBrandMap(r) : null;
}

/** Why a brand map could not be picked for a material. */
export type LqMapReason =
  /** Mapped, unambiguously. */
  | 'ok'
  /** No active lq_brand_map row for this material at all. */
  | 'not_mapped'
  /** Several packs map to this material and nothing in the request or in the
   *  material's own pack metadata chooses between them. NEVER guessed: two pack
   *  sizes of one brand differ in rate by the size ratio, so picking the wrong
   *  one produces a confident, plausible, wrong number. */
  | 'ambiguous_pack'
  /** The material IS mapped — just not under the size_code the caller asked
   *  for. Kept distinct from 'not_mapped' because the operator's fix is a
   *  different one (a mistyped pack code, not an unmapped brand) and because
   *  this reason travels: L3 puts it in DepotLandedResolved.detail. The packs
   *  that DO exist come back in `candidates`. */
  | 'pack_not_mapped'
  /** Mapped, but rate_per_case_master is not > 0 — the pack is mapped and the
   *  TGBCL rate has not been filled in yet (the importer allows exactly this,
   *  with a warning, and the column has no CHECK). Priceable as soon as a rate
   *  is entered or accepted; not priceable now. */
  | 'no_master_rate';

export interface LqBrandMapPick {
  row: LqBrandMapRow | null;
  reason: LqMapReason;
  /** The candidates, when the answer was 'ambiguous_pack' — so a screen can
   *  ask the human which pack this line was, instead of silently blanking. */
  candidates: LqBrandMapRow[];
}

/**
 * Pick THE brand-map row for a material.
 *
 * Order, most explicit first — and it stops rather than guessing:
 *   1. an explicit size_code,
 *   2. the only active row,
 *   3. the row whose size_ml equals the material's own bottle size (pack_size
 *      when the pack rule really applies, else the ml parsed from the name),
 *   4. narrowed further by bottles_per_case == the material's case_size,
 *   5. otherwise 'ambiguous_pack'.
 */
export function pickBrandMap(
  db: Database,
  materialId: string,
  opts?: { sizeCode?: string; brandMapId?: string },
): LqBrandMapPick {
  if (opts?.brandMapId) {
    const row = brandMapById(db, opts.brandMapId);
    return row
      ? { row, reason: 'ok', candidates: [row] }
      : { row: null, reason: 'not_mapped', candidates: [] };
  }
  return pickFromBrandMaps(brandMapsForMaterial(db, materialId), opts);
}

/**
 * The choosing half of pickBrandMap, over rows already in hand — same rules,
 * no query. `all` must be one material's ACTIVE rows in the order
 * brandMapsForMaterial returns them (tgbcl_brand_code, size_code): rule 3 and
 * rule 4 below read all[0] for the material's own pack metadata.
 */
function pickFromBrandMaps(
  all: LqBrandMapRow[], opts?: { sizeCode?: string },
): LqBrandMapPick {
  if (all.length === 0) return { row: null, reason: 'not_mapped', candidates: [] };

  const wanted = String(opts?.sizeCode || '').trim().toUpperCase();
  if (wanted) {
    const hit = all.find(r => String(r.size_code || '').trim().toUpperCase() === wanted);
    // 'pack_not_mapped', NOT 'not_mapped': we got here past `all.length === 0`,
    // so the material IS mapped — the requested PACK is the thing that is not.
    // Saying "not mapped" sent an operator to add a mapping that already exists.
    return hit
      ? { row: hit, reason: 'ok', candidates: all }
      : { row: null, reason: 'pack_not_mapped', candidates: all };
  }
  if (all.length === 1) return { row: all[0], reason: 'ok', candidates: all };

  const m = all[0];
  const pf = packFactor({
    unit: m.material_unit, purchase_unit: m.material_purchase_unit,
    pack_size: m.material_pack_size, case_size: m.material_case_size,
  });
  const ml = pf > 1 ? pf : (parseMaterialVolumeMl(m.material_name) ?? 0);
  let narrowed = ml > 0 ? all.filter(r => r.size_ml > 0 && Math.abs(r.size_ml - ml) < 1e-6) : all;
  if (narrowed.length === 1) return { row: narrowed[0], reason: 'ok', candidates: all };
  const cs = Number(m.material_case_size) || 0;
  if (cs > 1) {
    const byCase = narrowed.filter(r => r.bottles_per_case === cs);
    if (byCase.length === 1) return { row: byCase[0], reason: 'ok', candidates: all };
    if (byCase.length > 1) narrowed = byCase;
  }
  return { row: null, reason: 'ambiguous_pack', candidates: narrowed.length ? narrowed : all };
}

/* ── landedCostPerBottle — CONTRACT (L0) ─────────────────────────────────────
 *
 * landedCostPerBottle(db, { brandMapId | materialId+billRef, asOf })
 *   → { ratePerBottle, allocatedLevies, landedPerBottle } | null
 *   Owner: L1. Read by L3 (depot rate to compare a wine-shop price against),
 *   L4 (the value frozen onto a withdrawal) and L5 (§D avg landed/bottle).
 *   CONTRACT: computed from RECORDED lines only — the RATE PAID on the indent
 *   line (owner decision 2, 2026-08-31; the L0 text said "the master rate for
 *   the pack", and the owner settled that the other way) plus that line's share
 *   of the recorded levies (MRP rounding allocated BY BOTTLES, tax/cess/TCS BY
 *   LINE VALUE, matching the workbook and the deployed inward register). The
 *   master is the YARDSTICK only (ratePerBottleVariance, §G). No rate may be
 *   hardcoded, and nothing may be written back to raw_materials or
 *   store_stock_ledger — see rule 1 in the header.
 *   Returns null when the material has no brand map row: the caller shows "not
 *   mapped", never a zero, which would read as "free". bottles_per_case is
 *   CHECKed > 0 in the schema precisely so a mapped row can never divide to
 *   NULL and impersonate that answer.
 *
 * ── THREE THINGS A READER MUST KNOW BEFORE TRUSTING THIS NUMBER ─────────────
 *
 * 1. IT IS BUILT ON THE RATE PAID (owner decision 2, 2026-08-31). When an indent
 *    rate differs from the Brand Master, the figures are built on what was
 *    ACTUALLY PAID, and the master is kept as the yardstick only. So
 *    `ratePerBottle` is the indent line's own rate (unit_cost × packFactor) —
 *    the same basis the workbook's Indent Lines!T/U and L5 §C/§D use
 *    (liquor-summary.ts: `bkt.landedValue += ln.subtotal + ln.levies`), so the
 *    module now answers "landed cost" ONE way. It used to be the master
 *    (rate_per_case_master ÷ bottles_per_case), which understated every landed
 *    figure by exactly the §G drift while a master was stale — and L3 and L4
 *    FREEZE this figure onto money records (the wine-shop excess baseline; a
 *    "landed" recovery billed to a named person). Measured on the decisions
 *    probe: master ₹4,200, paid ₹4,500, levies ₹280.1342 → ₹4,480.13 where the
 *    paid basis is ₹4,780.13, i.e. a wine-shop excess overstated by ₹300 a
 *    bottle and a recovery under-billed by ₹300.
 *    The master is used for the rate in ONE case only: there is no recorded
 *    line (basis 'master_only'), or the line recorded no rate (a ₹0 line).
 *    `rateSource` says which, `masterRatePerBottle` and `ratePerBottleVariance`
 *    carry the yardstick, and accepting a moved rate into the master (the §G
 *    card) never re-prices anything already FROZEN on lq_retail_flags or
 *    lq_withdrawals — that freezing is deliberate and stays.
 *
 * 2. THE RATE AND THE LEVIES NOW COME FROM ONE LINE; THE PACK IS CHOSEN
 *    SEPARATELY. The brand-map row (the PACK) decides whether the material is
 *    priceable at all and supplies the master yardstick; the rate and the levies
 *    both come from the newest recorded store_stock_ledger line for the
 *    MATERIAL. That row carries no pack identity — store_stock_ledger has
 *    material_id and nothing else to filter on — so a material mapped to two
 *    packs of DIFFERENT ml is served whichever line was recorded last, whatever
 *    pack it was. Per bottle here means per bottle of the MATERIAL's own pack
 *    (packFactor), which is also how L3 and L4 read the figure back (L4 divides
 *    it by packFactor to freeze ₹/ml), so rate and levies are at least on one
 *    basis with each other and with their callers. Fixing the pack identity
 *    needs a pack column on the ledger, which is a schema change and not L1's to
 *    make; it is recorded here rather than left for the next reader to
 *    rediscover.
 *
 * 3. THE LEVIES BELONG TO THE BILL REF, AND A store_bill_charges ROW CAN COVER
 *    MORE REFS THAN ITS OWN. /procure-bulk records a register CSV's lines under
 *    their own inward_no refs while writing ONE charges row under the header
 *    ref whose invoice_value spans all of them; allocateIndentBill (like the
 *    deployed getStoreInwardRegister it mirrors) matches lines by the header ref
 *    alone, so those levies land entirely on the header-ref lines. Same
 *    behaviour as the deployed register — not introduced here — but it is what
 *    this figure inherits.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LqLandedBasis =
  /** Levies came from the bill named in `billRef`. */
  | 'named_bill'
  /** Levies came from the most recent recorded indent at or before `asOf`. */
  | 'latest_indent'
  /** Mapped, but nothing has ever been recorded for it — levies are 0 and the
   *  landed cost is the master rate. Honest: no recorded levy, no uplift. */
  | 'master_only';

/** Which rate `ratePerBottle` is (owner decision 2): the rate PAID on the
 *  indent line, or the master — the latter only when there is no recorded line
 *  or the line recorded no rate. */
export type LqLandedRateSource = 'paid' | 'master';

export interface LqLandedCost {
  /** ₹ per bottle the landed figure is BUILT ON. Owner decision 2: the RATE
   *  PAID on the indent line (= indentRatePerBottle) whenever one was recorded;
   *  the master (rate_per_case_master ÷ bottles_per_case) only when nothing was
   *  paid — see rateSource. */
  ratePerBottle: number;
  /** 'paid' | 'master' — which rate ratePerBottle is. */
  rateSource: LqLandedRateSource;
  /** The master yardstick, ₹ per bottle — null when the pack has no master rate
   *  yet (rate_per_case_master 0). Never the basis of landedPerBottle while a
   *  paid rate exists. */
  masterRatePerBottle: number | null;
  /** ₹ per bottle of allocated BILL-LEVEL levies. SIGNED — MRP rounding is a
   *  signed correction, so this can be negative. */
  allocatedLevies: number;
  /** ratePerBottle + allocatedLevies. */
  landedPerBottle: number;

  /* ── everything below is extra context, not part of the L0 contract ───── */
  basis: LqLandedBasis;
  brandMapId: string;
  materialId: string;
  tgbclBrandCode: string;
  sizeCode: string;
  bottlesPerCase: number;
  ratePerCaseMaster: number;
  /** The indent line the levies were taken from ('' when basis is master_only). */
  ledgerId: string;
  invoiceRef: string;
  inwardDate: string;
  /** ₹ per bottle actually paid on that line — null when there is no line.
   *  Kept beside the master rate so a caller never has to guess which is which. */
  indentRatePerBottle: number | null;
  /** indentRatePerBottle − masterRatePerBottle (the §G drift), null when there
   *  is no line or no master rate. */
  ratePerBottleVariance: number | null;
  /** Per-LINE charges per bottle (cgst+sgst+delivery−discount). Excluded from
   *  `allocatedLevies` by contract; see LqIndentLine.lineCharges. */
  lineChargesPerBottle: number;
  /** landedPerBottle + lineChargesPerBottle — the full recorded cost of a
   *  bottle on that line. Offered, never substituted for landedPerBottle. */
  landedWithLineChargesPerBottle: number;
}

export interface LqLandedCostOpts {
  /** Exact pack. Wins over materialId/sizeCode. */
  brandMapId?: string;
  materialId?: string;
  /** Disambiguates a material that maps to several packs. */
  sizeCode?: string;
  /** Take the levies from THIS recorded bill. */
  billRef?: string;
  /** Scope the bill / the latest-indent search to one store. */
  storeId?: string;
  /** YYYY-MM-DD. Without billRef, the newest recorded indent at or before this
   *  date supplies the levies. Omitted = no upper bound. */
  asOf?: string;
}

/** landedCostPerBottle with the REASON attached, for screens that must say why
 *  a figure is missing. `landedCostPerBottle` is this, minus the reason. */
export function landedCostPerBottleExplained(
  db: Database, opts: LqLandedCostOpts,
): { value: LqLandedCost | null; reason: LqMapReason; candidates: LqBrandMapRow[] } {
  // A BAD asOf MUST NOT LOOK LIKE "NEVER INDENTED". SQLite's date() returns
  // NULL for an unrecognised format, `date(created_at) <= NULL` is NULL, no
  // line matches, and this function used to answer with the bare master rate
  // and reason 'ok' — a wrong number wearing the shape of a right one, which
  // L3 then freezes onto lq_retail_flags. Every caller today passes a date the
  // route already validated (isRealDate / checkPurchaseDate), so this is a belt
  // rather than a live fault; L4 catches it and falls back to the store average.
  if (opts.asOf != null && String(opts.asOf).trim() !== ''
      && !/^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf).trim())) {
    throw new Error(`landedCostPerBottle: asOf must be YYYY-MM-DD, got "${opts.asOf}".`);
  }
  const materialId = String(opts.materialId || '').trim();
  let pick: LqBrandMapPick;
  if (opts.brandMapId) {
    pick = pickBrandMap(db, '', { brandMapId: opts.brandMapId });
  } else if (materialId) {
    pick = pickBrandMap(db, materialId, { sizeCode: opts.sizeCode });
  } else {
    return { value: null, reason: 'not_mapped', candidates: [] };
  }
  const bm = pick.row;
  // NOT MAPPED (or ambiguous) → null, never 0. A zero here reads as "free".
  if (!bm) return { value: null, reason: pick.reason, candidates: pick.candidates };
  if (!(bm.bottles_per_case > 0)) {
    // Cannot happen through the schema (CHECK bottles_per_case > 0) — this is
    // the belt for a row that arrived some other way.
    return { value: null, reason: 'not_mapped', candidates: pick.candidates };
  }
  // The master YARDSTICK for this pack — null when the pack has no rate yet.
  // rate_per_case_master is `NOT NULL DEFAULT 0` with no CHECK (unlike
  // bottles_per_case), and the importer deliberately stores 0 with a warning
  // ("the row maps, the rate is filled in later"), so a rateless row is a
  // normal, expected state.
  const masterRate: number | null = bm.rate_per_case_master > 0 ? bm.rate_per_bottle_master : null;

  // Find the recorded line whose RATE (owner decision 2) and levies apply.
  const where: string[] = ["l.txn_type = 'purchase'", 'l.material_id = ?'];
  const args: any[] = [bm.material_id];
  if (opts.storeId) { where.push('l.store_id = ?'); args.push(opts.storeId); }
  if (opts.billRef) { where.push('lower(TRIM(l.ref)) = ?'); args.push(lqBillKey(opts.billRef)); }
  if (opts.asOf)    { where.push('date(l.created_at) <= date(?)'); args.push(opts.asOf); }
  const line = db.prepare(`
    SELECT l.id, l.store_id, TRIM(l.ref) AS invoice_ref
    FROM store_stock_ledger l
    WHERE ${where.join(' AND ')}
    ORDER BY l.created_at DESC, l.rowid DESC
    LIMIT 1
  `).get(...args) as any;

  // The line, allocated over its WHOLE bill. `undefined` when nothing was ever
  // recorded, or (should be unreachable — the line was found by the same
  // predicate the allocation reads) when it is missing from its own bill; both
  // degrade to master-only rather than to a wrong number.
  const ln: LqIndentLine | undefined = line
    ? allocateIndentBill(db, String(line.store_id), String(line.invoice_ref))
        .lines.find(x => x.ledgerId === String(line.id))
    : undefined;

  // OWNER DECISION 2 — VALUE AT THE RATE PAID. The rate is the line's own
  // indent rate whenever one was recorded; the master only when nothing was
  // paid (no line, or a ₹0 line). See note 1 in the block above.
  const paid = ln && ln.indentRatePerBottle > 0 ? ln.indentRatePerBottle : null;

  // A PACK WITH NOTHING TO PRICE IT ON IS NOT A LANDED COST. With no rate paid
  // AND no master rate, the only figure left is made ENTIRELY of allocated
  // levies: small, plausible, non-zero, and therefore invisible to every `> 0`
  // guard downstream (L3's resolveDepotLanded, L4's freeze,
  // retailExcessSummary). Measured on the fixture: ₹94.13 where the truth was
  // ≈ ₹1,094 — 91% low, reported as source 'landed'. null is this module's
  // honest answer for "cannot be priced". (A rateless master WITH a paid line
  // is priced on the rate paid — the master is only the yardstick now.)
  //
  // NOT applied to the §G rate-movement watch (varianceRowsFrom below): there a
  // master of 0 against a real indent rate is the SIGNAL, and its Accept button
  // is how the rate gets filled in. Refusing to compute it there would hide the
  // one row an admin needs to act on.
  if (paid == null && masterRate == null) {
    return { value: null, reason: 'no_master_rate', candidates: pick.candidates };
  }
  const ratePerBottle = (paid ?? masterRate) as number;
  const rateSource: LqLandedRateSource = paid != null ? 'paid' : 'master';

  const shell = {
    basis: 'master_only' as LqLandedBasis,
    brandMapId: bm.id, materialId: bm.material_id,
    tgbclBrandCode: bm.tgbcl_brand_code, sizeCode: bm.size_code,
    bottlesPerCase: bm.bottles_per_case, ratePerCaseMaster: bm.rate_per_case_master,
    rateSource, masterRatePerBottle: masterRate,
  };

  if (!ln) {
    return {
      value: {
        ...shell,
        ratePerBottle,
        allocatedLevies: 0,
        landedPerBottle: ratePerBottle,
        ledgerId: '', invoiceRef: '', inwardDate: '',
        indentRatePerBottle: null, ratePerBottleVariance: null,
        lineChargesPerBottle: 0,
        landedWithLineChargesPerBottle: ratePerBottle,
      },
      reason: 'ok', candidates: pick.candidates,
    };
  }

  const allocatedLevies = ln.leviesPerBottle;
  const landedPerBottle = r4(ratePerBottle + allocatedLevies);
  return {
    value: {
      ...shell,
      basis: opts.billRef ? 'named_bill' : 'latest_indent',
      ratePerBottle,
      allocatedLevies,
      landedPerBottle,
      ledgerId: ln.ledgerId,
      invoiceRef: ln.invoiceRef,
      inwardDate: ln.inwardDate,
      indentRatePerBottle: ln.indentRatePerBottle,
      ratePerBottleVariance: masterRate == null ? null : r4(ln.indentRatePerBottle - masterRate),
      lineChargesPerBottle: ln.lineChargesPerBottle,
      landedWithLineChargesPerBottle: r4(landedPerBottle + ln.lineChargesPerBottle),
    },
    reason: 'ok',
    candidates: pick.candidates,
  };
}

/** THE contract function. null = "not mapped" (or "which pack?"), never 0. */
export function landedCostPerBottle(db: Database, opts: LqLandedCostOpts): LqLandedCost | null {
  return landedCostPerBottleExplained(db, opts).value;
}

/* ── rateVarianceForIndent — CONTRACT (L0) ───────────────────────────────────
 *
 * rateVarianceForIndent(db, { invoiceRef })
 *   → Array<{ materialId, indentRate, masterRate, variance }>
 *   Owner: L1. Read by L5 (§G rate-movement watch).
 *   CONTRACT: read-only. Accepting a new rate into the master is a separate,
 *   AUDITED write that belongs to L1's route, never a side effect of reading.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LqRateVarianceRow {
  materialId: string;
  /** ₹ per bottle recorded on the indent line. */
  indentRate: number;
  /** ₹ per bottle from the master — NULL when the material is not mapped (or
   *  maps to several packs and nothing chooses). Never 0-for-unknown. */
  masterRate: number | null;
  /** indentRate − masterRate, null when masterRate is null. */
  variance: number | null;

  /* ── context, beyond the L0 contract ─────────────────────────────────── */
  ledgerId: string;
  storeId: string;
  invoiceRef: string;
  inwardDate: string;
  supplier: string;
  materialName: string;
  category: string;
  bottles: number;
  /** variance × bottles — what the difference is worth on this line. */
  varianceValue: number | null;
  brandMapId: string;
  tgbclBrandCode: string;
  sizeCode: string;
  bottlesPerCase: number | null;
  ratePerCaseMaster: number | null;
  /** What accepting this rate would write into rate_per_case_master:
   *  indentRate × bottles_per_case. null when unmapped. */
  proposedRatePerCase: number | null;
  mapReason: LqMapReason;

  /* ── The line's allocated levies, on the WORKBOOK's bases (MRP rounding by
   *    BOTTLES, the other three by LINE VALUE) — see LQ_ALLOCATION_BASIS and
   *    the warning there about the deployed register's single basis. ─────── */
  allocated: LqBillLevies;
  leviesLine: number;
  leviesPerBottle: number;
  lineChargesPerBottle: number;
  /** indentRate + leviesPerBottle — the landed cost of a bottle on this line,
   *  built on the RATE PAID (owner decision 2; it used to be masterRate +
   *  levies, which understated it by exactly `variance`). The master is used
   *  only for a ₹0 line, the same rule as landedCostPerBottle. null when
   *  unmapped (or nothing to price it on), never 0: a zero would read as
   *  "free". ANALYTICS ONLY (plan decision 1(a)); nothing writes it back to a
   *  valuation column. */
  landedPerBottle: number | null;
  /** landedPerBottle × bottles. null when unmapped. */
  landedValue: number | null;
}

/**
 * Rate-vs-master variance for every line of one recorded indent.
 *
 * READ ONLY. Nothing here writes, and in particular nothing "helpfully" updates
 * the master to match what arrived — that is the audited route.
 */
export function rateVarianceForIndent(
  db: Database, args: { invoiceRef: string; storeId?: string },
): LqRateVarianceRow[] {
  const key = lqBillKey(args.invoiceRef);
  if (!key) return [];
  // Which store(s) hold this invoice ref. Scoped when the caller says so.
  const stores = args.storeId
    ? [args.storeId]
    : (db.prepare(`
        SELECT DISTINCT store_id FROM store_stock_ledger
        WHERE txn_type = 'purchase' AND lower(TRIM(ref)) = ?
      `).all(key) as any[]).map(r => String(r.store_id));

  const out: LqRateVarianceRow[] = [];
  for (const storeId of stores) {
    const alloc = allocateIndentBill(db, storeId, args.invoiceRef);
    out.push(...varianceRowsFrom(alloc, mid => pickBrandMap(db, mid)));
  }
  return out;
}

/**
 * One allocated bill → its variance rows. Pure but for `pickFor`, which is how
 * the per-bill read (a query per material) and the batched store read (one
 * preloaded map) produce IDENTICAL rows from the same arithmetic.
 */
function varianceRowsFrom(
  alloc: LqIndentAllocation, pickFor: (materialId: string) => LqBrandMapPick,
): LqRateVarianceRow[] {
  const out: LqRateVarianceRow[] = [];
  for (const ln of alloc.lines) {
    const pick = pickFor(ln.materialId);
    const bm = pick.row;
    const masterRate = bm ? bm.rate_per_bottle_master : null;
    const variance = masterRate == null ? null : r4(ln.indentRatePerBottle - masterRate);
    // Owner decision 2: landed on the RATE PAID; the master is the yardstick
    // (`variance`), and stands in for the rate only on a ₹0 line — exactly the
    // rule landedCostPerBottleExplained applies, so the Rate Movement card, the
    // register's recon block and the figure L3/L4 freeze cannot disagree.
    const landedRate = !bm ? null
      : (ln.indentRatePerBottle > 0 ? ln.indentRatePerBottle
        : (masterRate != null && masterRate > 0 ? masterRate : null));
    const landedPerBottle = landedRate == null ? null : r4(landedRate + ln.leviesPerBottle);
    out.push({
      allocated: ln.allocated,
      leviesLine: ln.leviesLine,
      leviesPerBottle: ln.leviesPerBottle,
      lineChargesPerBottle: ln.lineChargesPerBottle,
      landedPerBottle,
      landedValue: landedPerBottle == null ? null : r2(landedPerBottle * ln.bottles),
      materialId: ln.materialId,
      indentRate: ln.indentRatePerBottle,
      masterRate,
      variance,
      ledgerId: ln.ledgerId,
      storeId: ln.storeId,
      invoiceRef: ln.invoiceRef,
      inwardDate: ln.inwardDate,
      supplier: ln.supplier,
      materialName: ln.materialName,
      category: ln.category,
      bottles: ln.bottles,
      varianceValue: variance == null ? null : r2(variance * ln.bottles),
      brandMapId: bm ? bm.id : '',
      tgbclBrandCode: bm ? bm.tgbcl_brand_code : '',
      sizeCode: bm ? bm.size_code : '',
      bottlesPerCase: bm ? bm.bottles_per_case : null,
      ratePerCaseMaster: bm ? bm.rate_per_case_master : null,
      proposedRatePerCase: bm ? r2(ln.indentRatePerBottle * bm.bottles_per_case) : null,
      mapReason: pick.reason,
    });
  }
  return out;
}

/**
 * Every indent line in a store over a date range, with its variance — the
 * Summary §G "rate movement watch" feed, and what the Rate Movement tab of
 * /inventory/liquor-brand-map renders.
 *
 * The date range selects WHICH BILLS to report; each selected bill is then
 * allocated WHOLE (see allocateIndentBill), so a bill straddling the boundary
 * still splits its levies correctly.
 *
 * ⚠️ READ IN BATCHES, NOT BILL BY BILL. `lower(TRIM(l.ref)) = ?` is an
 * expression no index can serve, so one call to allocateIndentBill scans the
 * whole store ledger — outward rows included. Calling it once per bill made
 * this function O(bills × ledger rows): on a 24,006-row ledger with 1,003
 * bills it took 5.8s, and adding 20,000 pour-out rows the report never shows
 * made it 31× slower than the same read before this module existed. So the
 * three reads are hoisted — lines, bill charges and brand maps, in chunks —
 * and the SAME pure allocateFromRows / pickFromBrandMaps run over them. The
 * output is byte-identical to the per-bill path (proved over 4,006 lines); the
 * ORDER BY inside each chunk is the bill order allocateIndentBill uses, which
 * is what decides where the rounding remainder lands.
 */
export function rateMovementForStore(
  db: Database, storeId: string, from?: string, to?: string,
): LqRateVarianceRow[] {
  const where: string[] = ["txn_type = 'purchase'", 'store_id = ?', "TRIM(ref) != ''"];
  const a: any[] = [storeId];
  if (from) { where.push('date(created_at) >= date(?)'); a.push(from); }
  if (to)   { where.push('date(created_at) <= date(?)'); a.push(to); }
  const refs = db.prepare(`
    SELECT TRIM(ref) AS invoice_ref, MAX(created_at) AS newest
    FROM store_stock_ledger
    WHERE ${where.join(' AND ')}
    GROUP BY lower(TRIM(ref))
    ORDER BY newest DESC
  `).all(...a) as any[];
  if (refs.length === 0) return [];

  const keys = refs.map(r => lqBillKey(r.invoice_ref));
  const linesByKey = billLinesForKeys(db, storeId, keys);
  const leviesByKey = billLeviesForKeys(db, storeId, keys);
  const mapsByMaterial = activeBrandMapsByMaterial(db);
  const picked = new Map<string, LqBrandMapPick>();
  const pickFor = (materialId: string): LqBrandMapPick => {
    let p = picked.get(materialId);
    if (!p) {
      p = pickFromBrandMaps(mapsByMaterial.get(materialId) ?? []);
      picked.set(materialId, p);
    }
    return p;
  };

  const out: LqRateVarianceRow[] = [];
  for (const r of refs) {
    const key = lqBillKey(r.invoice_ref);
    const alloc = allocateFromRows(
      storeId, String(r.invoice_ref), linesByKey.get(key) ?? [], leviesByKey.get(key) ?? null,
    );
    out.push(...varianceRowsFrom(alloc, pickFor));
  }
  return out;
}

/** SQLite's compile-time parameter floor is 999; stay well under it. */
const KEY_CHUNK = 400;

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Every line of the named bills, grouped by bill key, each group in the bill's
 *  own order. Chunks are disjoint by key, so grouping across them is safe. */
function billLinesForKeys(db: Database, storeId: string, keys: string[]): Map<string, any[]> {
  const byKey = new Map<string, any[]>();
  for (const part of chunk([...new Set(keys)], KEY_CHUNK)) {
    const rows = db.prepare(`
      ${INDENT_LINE_SELECT}
      WHERE l.store_id = ? AND l.txn_type = 'purchase'
        AND lower(TRIM(l.ref)) IN (${part.map(() => '?').join(',')})
      ORDER BY l.created_at DESC, l.rowid DESC
    `).all(storeId, ...part) as any[];
    for (const row of rows) {
      const k = lqBillKey(row.invoice_ref);
      const g = byKey.get(k);
      if (g) g.push(row); else byKey.set(k, [row]);
    }
  }
  return byKey;
}

/** The bill-level levies of the named bills. First row wins on a duplicate ref,
 *  which is what the single-bill read's .get() returns. */
function billLeviesForKeys(db: Database, storeId: string, keys: string[]): Map<string, LqBillLevies | null> {
  const byKey = new Map<string, LqBillLevies | null>();
  for (const part of chunk([...new Set(keys)], KEY_CHUNK)) {
    const rows = db.prepare(`
      SELECT lower(TRIM(invoice_ref)) AS k,
             mrp_rounding, excise_turnover_tax, special_excise_cess, tcs
      FROM store_bill_charges
      WHERE store_id = ? AND lower(TRIM(invoice_ref)) IN (${part.map(() => '?').join(',')})
      ORDER BY rowid
    `).all(storeId, ...part) as any[];
    for (const row of rows) if (!byKey.has(String(row.k))) byKey.set(String(row.k), shapeLevies(row));
  }
  return byKey;
}

/** All ACTIVE brand maps, grouped by material, each group in the order
 *  brandMapsForMaterial returns (tgbcl_brand_code, size_code) — pickFromBrandMaps
 *  reads the first row of a group for the material's pack metadata. */
function activeBrandMapsByMaterial(db: Database): Map<string, LqBrandMapRow[]> {
  const rows = db.prepare(
    `${BRAND_MAP_SELECT} WHERE bm.is_active = 1
     ORDER BY bm.material_id, bm.tgbcl_brand_code, bm.size_code`,
  ).all() as any[];
  const byMaterial = new Map<string, LqBrandMapRow[]>();
  for (const r of rows) {
    const shaped = shapeBrandMap(r);
    const g = byMaterial.get(shaped.material_id);
    if (g) g.push(shaped); else byMaterial.set(shaped.material_id, [shaped]);
  }
  return byMaterial;
}
