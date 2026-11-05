# Liquor Purchase Reconciliation — Port Plan (PLAN ONLY, nothing built)

Source: `~/Downloads/Liquor_Purchase_Reconciliation (1).xlsx` (8 sheets), read
2026-08-17. Owner instruction: prepare the plan; build only on the owner's word.

## What the workbook does (verified against its live data)

Two purchase routes plus two leak ledgers, reconciled in a Summary with four
named checks:

| Sheet | What it holds |
|---|---|
| Brand Master | TGBCL brand code + size code keyed master: bottles/case, size ml, rate/case (issue price), derived rate/bottle + LANDED cost/bottle. Same brand in two pack sizes = two rows (9740-PP vs 9740-NN). |
| Portal Wallet | TGBCL wallet ledger: opening balance, challan deposits, indent debits, running balance, bank-match status per deposit, portal-vs-computed verification. |
| Indent Register | One row per indent: cases/bottles, invoice value, + MRP rounding + turnover tax + special excise cess + TCS = NET indent value, computed-vs-portal Value Check, previous/closing wallet balance chain, beer vs spirit case split. |
| Indent Lines | Per-line: qty, amount, rate-vs-master VARIANCE, allocated share of each bill-level levy (MRP rounding BY BOTTLES; tax/cess/TCS BY LINE VALUE), landed value + landed cost/bottle. |
| Wine Shop Purchases | Emergency retail buys when depot stock runs out: rate paid vs depot landed cost → EXCESS cost per bottle/total/%, who fronted the money, reimbursement status, approver. |
| Stock Withdrawals | Non-sale issues at landed cost: management/director personal use, staff welfare, marketing, breakage — recovery basis, amount recoverable/recovered/outstanding, excise-register flag. |
| Summary | A: wallet reconciliation (computed vs portal, working capital parked, deposits-utilised %), A2: next top-up planner (shortfall → challan rounded to ₹10k), B: purchase totals + Value Check vs portal PDFs, C: beer/spirit split, D: derived factors (uplift beer 1.187 / spirits 1.104, effective TCS, cess/case, MRP rounding/bottle, avg landed/bottle), E: wine-shop excess + unreimbursed staff spend, F: total liquor cost, G: rate-movement watch (indent rate ≠ master), H: non-sale issues split + % of purchases + recoverable outstanding. |

## What the platform ALREADY has (do not duplicate)

- **Indent Lines ≈ the Liquor Store Inward Register** (deployed f732956): per-line
  charges + 4 bill-level charges allocated per line → Net Indent. The port
  must EXTEND this, never build a parallel indent register. (Verify at build
  time that its allocation bases match the sheet: MRP rounding by bottles,
  tax/cess/TCS by line value.)
- **TGBCL bill charges** on Liquor Store purchases (deployed 3a67ac9): signed
  MRP rounding / excise / cess / TCS → Net Indent, recorded-only; forgiving
  Bill CSV upload with line-level dup guard; vendor auto-learn.
- **Pack machinery**: cases+bottles ('cb') mode, per-size materials,
  parseMaterialVolumeMl. Wine-shop bottles can land in stock as normal
  purchases today.
- **Petty cash** (staff fronting money) and **wastage** (breakage) exist as
  separate rails the new ledgers must integrate with, not replace.

## What is genuinely NEW (the build, in phases)

### Phase L1 — Brand master mapping + rate-movement watch
- New table `lq_brand_map`: material_id ↔ {tgbcl_brand_code, size_code,
  bottles_per_case, rate_per_case_master, product_type (BEER|IML|Duty Paid)}.
  A material may map to multiple codes (pack variants) — UNIQUE(brand_code,
  size_code).
- Inward register lines gain rate-vs-master variance (computed, shown red when
  ≠ 0) + a "Rate Movement" card (Summary §G): lines where indent rate ≠ master,
  one-tap "accept new rate into master" (audited).
- Admin UI: mapping editor inside the Liquor Store section + CSV import of the
  Brand Master sheet itself (one-time migration path).

### Phase L2 — TGBCL Portal Wallet ledger + top-up planner
- New table `lq_wallet_txns`: date, type (opening|deposit|indent_debit|
  adjustment), reference (challan no / indent no), amount signed, payment_mode,
  bank_debit_date, bank_amount, bank_match (pending|verified), portal_status,
  remarks. Running balance computed, never stored.
- Indent debits AUTO-CREATED from the inward register's Net Indent (same
  transaction), so the wallet can never disagree with recorded indents;
  deposits entered manually (challan) with a bank-confirmation checklist.
- Page `/inventory/liquor-wallet` (or a tab on the Liquor Store): ledger,
  computed-vs-portal balance check (owner types the portal figure; difference
  highlighted — Summary check A), working-capital-parked and
  deposits-utilised% cards, and the A2 top-up planner: planned next indent
  value → shortfall → recommended challan rounded UP to a configurable ₹10k.

### Phase L3 — Emergency wine-shop purchases
- These are REAL purchases (stock must move): entered through the existing
  purchase flow with vendor = the wine shop, PLUS a `lq_retail_flags` side
  record: shop licence no, rate paid vs depot landed (auto from L1 landed
  cost), excess/bottle + total + %, paid_by, payment_mode, reimbursement
  status (petty-cash integration: 'Claimed – pending' → petty cash payout
  closes it), reason, approved_by.
- Report card (Summary §E): excess cost of buying retail ("the price of
  running out"), wine-shop share of liquor spend, unreimbursed staff spend.

### Phase L4 — Stock withdrawals (non-sale issues)
- New table `lq_withdrawals`: date, ref (WD-YYYY-###), category (management
  personal | staff welfare | marketing/sampling | breakage/spoilage |
  transfer), material_id, cases+bottles, landed cost value (frozen at issue),
  MRP value, taken_by, authorised_by, recovery basis, recoverable/recovered/
  outstanding, excise-register flag, remarks.
- MOVES STOCK: deducts from the liquor store ledger in the same transaction
  (like wastage, but with recoverable tracking). Breakage category can
  optionally co-write the existing wastage rail — decide at build.
- Admin-only page + Summary §H cards: split by category, % of purchases,
  recoverable outstanding (the director-use ledger stays visible, never
  buried in consumption).

### Phase L5 — The Reconciliation Summary page
- `/inventory/liquor-reconciliation` (mgmt/admin): the workbook's Summary as a
  live page over a date range — sections A/A2/B/C/D/E/F/G/H with the four
  CHECKS as pass/fail cards (A wallet balance, B per-indent value vs portal,
  C bank-unconfirmed deposits, D retail excess) + CSV export per section.
  Derived factors (uplift by category, effective TCS, cess/case, MRP
  rounding/bottle, avg landed/bottle) computed from recorded lines — never
  hardcoded rates, matching the sheet's own "computed, not assumed" stance.

## Decisions needed from the owner BEFORE build

1. **Landed cost vs today's convention.** The sheet bakes levies into a landed
   cost/bottle; the platform's charges are deliberately RECORDED-ONLY (they do
   not move average_price). Options: (a) keep valuation as-is and show landed
   cost only inside this module's analytics (recommended — zero risk to
   recipe costing), or (b) switch liquor valuation to landed (system-wide
   ripple: pour costs, variance values). Plan assumes (a).
2. **Wallet data entry**: manual challan entry (plan) or also a TGBCL portal
   PDF/CSV importer (add later once we see the portal's export format).
3. **Withdrawals ↔ wastage**: separate ledger that also writes breakage into
   wastage, or fully separate. Plan assumes separate ledger, breakage co-write
   optional toggle.
4. Where the pages live: inside the existing Liquor Store section (plan) vs a
   new sidebar section.

## Touchpoints & sizing

- Committed files touched: db.ts (new lq_ block), page-catalog + Sidebar
  (2–3 entries), the liquor inward register page/route (variance columns +
  wallet auto-debit hook). Everything else new files.
- Estimated: ~5 tables, ~6 routes, 3 pages + 2 extended, 1 report lib.
  One build fleet (~10–12 agents) + verify pass; comparable to the closing-
  stock or bill-charges efforts, smaller than HRMS by an order of magnitude.
- Migration: one-time CSV imports for Brand Master and Portal Wallet history
  so the sheet retires with its data intact.
