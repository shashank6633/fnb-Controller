# Liquor Reconciliation — the walkthrough

**What this is.** How to run the TGBCL liquor reconciliation module day to day: what each screen
is for, what you do on it, how the money moves from an indent to the wallet, the four checks and
what to do when one of them fails. Written against the code as it stands on 2026-08-31.

**State.** The module is BUILT and UNCOMMITTED. It ships only when you say "Deploy Liquor
Reconciliation". Nothing in it is live yet, so nothing below has been exercised against your real
indents — the local database copy has **zero** rows in every `lq_` table and zero rows in the
liquor store ledger. Every number in the worked example is arithmetic I computed with the
module's own formulas, using real brands, real pack sizes and real rates from your database. The
screens are described from their code, not from a browser session (see *Provenance* at the end).

**What it replaces.** The `Liquor_Purchase_Reconciliation.xlsx` workbook — Brand Master, Portal
Wallet, Indent Register, Indent Lines, Wine Shop Purchases, Stock Withdrawals and Summary — as
live pages over your recorded indents. It does **not** replace the Liquor Store inward register
or the TGBCL bill charges you already ship (f732956, 3a67ac9); it extends them.

---

## 1. The five phases, in one line each

| Phase | Screen | What it solves |
|---|---|---|
| **L1** | `/inventory/liquor-brand-map` (Admin) | Ties your item to its TGBCL brand code + pack, holds the master rate per case, and watches every indent line for a rate that has moved |
| **L2** | `/inventory/liquor-wallet` (Management) | The TGBCL portal wallet: opening balance, challan deposits, automatic indent debits, portal check, and how big the next challan should be |
| **L3** | *No page of its own* — the **Wine-shop Purchase** button on `/inventory/liquor-store` | Emergency retail buys when the depot is dry: the bottles, the premium over depot cost, who fronted the cash and whether they got it back |
| **L4** | `/inventory/liquor-withdrawals` (Admin) | Bottles that leave without a sale — management/director use, staff welfare, marketing, breakage — priced, recoverable, and actually deducted from stock |
| **L5** | `/inventory/liquor-reconciliation` (Management) | The workbook's Summary as a live page: sections A–H plus the four checks, each with its own CSV |

Access is re-checked on the server for every route, not just in the sidebar: Brand Map and
Withdrawals are **admin only**, Wallet and Reconciliation are **management** (admin / manager /
HOD), and the wine-shop button follows the ordinary liquor purchase permission (`can_procure` on
the liquor store).

---

## 2. Day 0 — the one-time setup

### 2a. Fill the Brand Map (L1)

Open **Inventory → Liquor Brand Map**. Three tabs: **Map**, **Rate Movement**, **Import**.

- The picker offers only items whose category is mapped to an active store — on your database
  that is **127 items** out of ~900.
- Today the table has **0 rows**. Until a brand is mapped, that brand has no master rate, no
  landed cost, no beer/spirit classification and no rate-drift watch. The Summary says so on the
  section instead of showing a zero.

Fastest route is the **Import** tab: download the template header, paste your Brand Master sheet
into it, upload, read the **preview** (it writes nothing), then commit.

```
material,material_id,sku,tgbcl_brand_code,size_code,size_ml,bottles_per_case,rate_per_case_master,product_type,is_active,note
```

- Required per row: `tgbcl_brand_code`, `bottles_per_case`, `product_type`, plus one of
  `material` / `material_id` / `sku` to say which item it is.
- **Hard errors (row is skipped):** item not found or matching two items; missing/unknown
  `product_type`; `bottles_per_case` missing, zero or not a whole number; the same
  (brand code, size code) twice in one file.
- **Warnings (row still imports):** no `rate_per_case_master` (stored ₹0 — map now, price later);
  no `size_ml`; a second pack added under a brand code that already maps this item; a mapping that
  MOVES to a different item (the old item silently loses its master rate, so this is called out by
  name with from → to).
- Re-importing the same file is an **update, not a duplicate**. The key is
  (brand code, size code) — that is how 9740-PP and 9740-NN stay two rows of one brand.
- A column your file does not carry is left alone on an existing row. A file that only pushes new
  TGBCL rates cannot wipe your sizes, notes or retired packs.

**One thing to fix in the item master while you are here.** Of your 126 active bar items, only
**2** carry `case_size > 1` (100 PIPERS and DEWAR'S 15 YRS). `bottles_per_case` in the Brand Map
prices a bottle; it does **not** teach the app that the item arrives in cases. Section C/D counts
"cases" only from `raw_materials.case_size`, so with today's data almost your whole indent reads
as **loose bottles** and "cess per case" is computed over a handful of lines. Set `case_size` on
each item you buy by the case.

### 2b. Open the wallet (L2)

Open **Inventory → Liquor Wallet → Record a wallet movement**.

1. Type **Opening** with the balance TGBCL showed on the day you start. There can only ever be
   **one** opening row — a second is refused, because it would silently double the balance every
   portal check is measured against. Correct a wrong opening with an **Adjustment**, never a
   second opening.
2. Set the top-up rounding step if ₹10,000 is not what you want (the pencil beside §A2).

The ledger is **append-only**, like the cash box. There is no edit and no delete of a wallet
movement. A wrong figure is corrected by an `Adjustment` row (which demands a remark, because it
moves money with no challan and no indent behind it).

---

## 3. The money trail, end to end

```
 TGBCL indent (what you keyed on the Liquor Store bill screen or the Bill CSV)
   │
   ├─ per LINE, on the ledger row:   bottles × ₹/bottle = line value
   │                                  (+ any discount / CGST / SGST / delivery on that line;
   │                                   on a TGBCL indent these are normally zero)
   │
   ├─ per BILL, on the charges row:  MRP Rounding (SIGNED, usually negative)
   │                                 Bar Excise Turnover Tax   (≥ 0)
   │                                 Special Excise Cess       (≥ 0)
   │                                 TCS                       (≥ 0)
   │
   ├─ NET INDENT = invoice value + MRP rounding + turnover tax + cess + TCS
   │                                 (store_bill_charges.net_indent_value)
   │
   └─ WALLET DEBIT = −Net Indent, written in the SAME transaction as the indent
                                   (lq_wallet_txns, type indent_debit)
```

Two things follow from "same transaction", and they are the point of the whole design:

- If the wallet debit cannot be written, **the bill does not save**. You get a sentence saying
  why. There is no moment where an indent exists without its debit.
- Re-saving a bill (a corrected levy, a re-uploaded CSV) **re-derives the one debit**. It never
  adds a second.

### How the four bill-level levies are split across the lines

| Levy | Split on | Why |
|---|---|---|
| MRP Rounding | **bottles** | It is a per-bottle rounding. A ₹150 beer carries the same rounding as a single malt; splitting it by value would push it onto the expensive lines |
| Bar Excise Turnover Tax | **line value** | Ad-valorem |
| Special Excise Cess | **line value** | Ad-valorem |
| TCS | **line value** | Ad-valorem |

The **last line of the bill takes the remainder**, so the parts add up to the recorded amount to
the paisa. Bills are always split **whole** — a bill that straddles your date filter still splits
correctly.

> **Known difference, deliberate, and it does not affect any total.** The deployed inward register
> (`getStoreInwardRegister`, shipped f732956) splits **all four** levies by line value, including
> MRP rounding. The new module splits MRP rounding by bottles, per the workbook. **Per-bill totals
> are identical either way** — only the per-line `MRP Round Off` column differs. The register was
> deliberately not changed, because that would silently move that column on every historical line.
> The `recon` block on the register API reports both so the difference is visible rather than
> argued about. In the worked example below the same bill splits MRP rounding as
> −75.36 / −120.57 / −15.07 (module) and −128.29 / −19.74 / −62.97 (register CSV). Both add to
> −211.00.

---

## 4. A fully worked indent — every figure, with the arithmetic

**Indent IND/2026/0812, LIQUOR STORE, 12 Aug 2026.** Three lines, using real items from your
database (100 PIPERS 750ML — ml/BTL, pack 750, case 12; BUDWEISER 650ML — pcs/BTL; CHIVAS REGAL
12YRS 750ML — ml/BTL, pack 750).

### 4a. The lines (purchase units — bottles, as they read on your indent)

| Item | Qty | ₹ / bottle | Line value |
|---|---:|---:|---:|
| 100 PIPERS (750ML) | 5 cases × 12 = **60 btl** | 1,581.00 | **94,860.00** |
| BUDWEISER (650ML) | **96 btl** | 152.00 | **14,592.00** |
| CHIVAS REGAL 12YRS (750ML) | **12 btl** | 3,880.00 | **46,560.00** |
| | **168 btl** | | **1,56,012.00** |

### 4b. The bill-level levies as recorded on the bill screen

| MRP Rounding | Turnover Tax | Special Excise Cess | TCS |
|---:|---:|---:|---:|
| **−211.00** | **1,560.12** | **9,240.00** | **1,560.12** |

### 4c. The split, line by line

MRP rounding is by bottles: `−211.00 × 60/168 = −75.36`, `−211.00 × 96/168 = −120.57`, and the
last line takes the remainder `−211.00 − (−195.93) = −15.07`.

The other three are by line value: e.g. cess on 100 Pipers = `9,240.00 × 94,860.00 ÷ 1,56,012.00 =
5,618.20`; the last line again takes the remainder.

| Item | MRP round | Turnover | Cess | TCS | **Levies on the line** | **₹ / bottle** |
|---|---:|---:|---:|---:|---:|---:|
| 100 PIPERS | −75.36 | 948.60 | 5,618.20 | 948.60 | **7,440.04** | 124.0007 |
| BUDWEISER | −120.57 | 145.92 | 864.23 | 145.92 | **1,035.50** | 10.7865 |
| CHIVAS 12 | −15.07 | 465.60 | 2,757.57 | 465.60 | **3,673.70** | 306.1417 |
| **Σ** | **−211.00** | **1,560.12** | **9,240.00** | **1,560.12** | **12,149.24** | |

Each column adds back to exactly the recorded levy. Good.

### 4d. Net Indent and the wallet

```
Net Indent = 1,56,012.00 − 211.00 + 1,560.12 + 9,240.00 + 1,560.12 = ₹1,68,161.24
Cross-check: invoice 1,56,012.00 + Σ line levies 12,149.24            = ₹1,68,161.24  ✓
```

Wallet, assuming a ₹2,00,000 challan was deposited first:

| Date | Type | Reference | Amount | Running balance |
|---|---|---|---:|---:|
| 10 Aug | opening / deposit | challan no | +2,00,000.00 | 2,00,000.00 |
| 12 Aug | indent_debit *(auto)* | IND/2026/0812 | **−1,68,161.24** | **31,838.76** |

### 4e. §A2 — how big the next challan should be

You plan a ₹2,50,000 indent next week:

```
shortfall            = 2,50,000.00 − 31,838.76 = 2,18,161.24
recommended challan  = round UP to the ₹10,000 step  = ₹2,20,000
rounding adds                                        = ₹1,838.76
balance after challan and indent                     = ₹1,838.76
```

If the wallet already covers the plan, it recommends ₹0 and reports the surplus — it never invents
a "minimum top-up".

### 4f. §D — the derived factors this indent produces

| Factor | Value | How |
|---|---:|---|
| Bottles | 168 | Σ line bottles |
| Cases (case-packed lines only) | 5 | only 100 PIPERS carries `case_size` 12 |
| Loose bottles | 108 | Budweiser + Chivas, because their `case_size` is 1 today |
| Uplift overall | **1.0779** | landed 1,68,161.24 ÷ invoice 1,56,012.00 |
| Uplift — BEER | 1.0710 | (14,592.00 + 1,035.50) ÷ 14,592.00 |
| Uplift — spirits (IML + Duty Paid) | 1.0786 | 1,52,533.74 ÷ 1,41,420.00 |
| Effective TCS % | 1.0000 | 1,560.12 ÷ 1,56,012.00 × 100 |
| Cess per case | ₹1,123.64 | case-packed cess ÷ case-packed cases (both halves on one basis) |
| Cess per bottle | ₹55.00 | 9,240.00 ÷ 168 |
| MRP rounding per bottle | −₹1.2560 | −211.00 ÷ 168 |
| Avg landed per bottle | ₹1,000.9598 | 1,68,161.24 ÷ 168 |

Nothing above is a stored or assumed rate. Every one is computed from the recorded lines, exactly
as the workbook does it.

### 4g. §G — the one line whose rate moved

Say the Brand Map holds Budweiser 650 at **₹1,776.00 per case of 12 = ₹148.00 a bottle**, and this
indent charged **₹152.00**:

```
variance         = 152.00 − 148.00               = +₹4.00 per bottle
worth            = 4.00 × 96 bottles             = +₹384.00 on this line
proposed master  = 152.00 × 12 bottles per case  = ₹1,824.00 per case
```

The Rate Movement tab shows the row in red with an **Accept into master** button. Accepting:

- re-reads the line server-side and writes exactly the rate shown (a crafted request cannot set an
  arbitrary price);
- refuses if the mapping is for a different item, or for a different **pack** of the same brand;
- writes `rate_per_case_master = ₹1,824.00` and an audit event naming the old rate, the new rate,
  the indent, the date and the bottles;
- **changes no valuation.** Recipe cost, pour cost, average price and the stock ledger are all
  untouched. What the bar paid was already recorded on the line; this only updates the yardstick.

A rate counts as "moved" when it has moved by at least a **paisa per bottle**; the page and the
Summary use the identical test, so the two screens can never disagree about whether a row is red.

### 4h. §E — an emergency wine-shop run

Depot dry on a Saturday, so somebody buys **6 bottles of ABSOLUT (750ML)** at **₹2,900** each from
a wine shop, and the frozen depot landed cost for that pack was **₹2,236.19**:

```
excess per bottle = 2,900.00 − 2,236.19 = ₹663.81
excess total      = 663.81 × 6          = ₹3,982.86
excess %          = 663.81 ÷ 2,236.19   = 29.68%
spend             = 2,900.00 × 6        = ₹17,400.00
```

The depot rate is **frozen at entry**. Later indents move the depot cost; re-pricing last
quarter's emergency buy would make "the price of running out" unreadable.

### 4i. §F — total liquor cost for the window

```
depot Net Indent   ₹1,68,161.24
wine-shop spend    ₹   17,400.00
total              ₹1,85,561.24     retail share 9.38%
```

> **Careful — two "shares" on one screen.** §F's retail share (9.38%) divides retail spend by
> depot **Net Indent** (levies included). §E's own "wine-shop share of liquor spend" divides by
> the depot **line value** (levies excluded, ₹1,56,012.00), giving **10.03%**. Both are honest;
> they are different measurements. Quote §F when you talk about total cost.

### 4j. §H — a bottle that left without a sale

One bottle of 100 PIPERS taken for management use, recorded on the Withdrawals page:

```
landed cost frozen at issue  ₹1,705.0007 per bottle  →  stored ₹2.2733 per ml (4dp)
landed value = 750 ml × the UNROUNDED rate                 = ₹1,705.00
recovery basis "landed"      → recoverable ₹1,705.00, recovered ₹0, outstanding ₹1,705.00
% of purchases (§H)          = 1,705.00 ÷ 1,68,161.24      = 1.01%
```

The stock actually moves: one **negative** store-ledger row for 750 ml, written in the same
transaction as the register row, typed as an **adjustment** and not an outward — so an authorised
withdrawal never reads as a sale pour in the bar reconciliation.

> **Careful — the Withdrawals page and §H use different denominators.** The Withdrawals page's own
> "% of purchases" divides by the store **inflow value** (₹1,56,012.00 here → **1.09%**); §H on the
> Reconciliation page divides by **Net Indent** (₹1,68,161.24 → **1.01%**). Same numerator, two
> denominators. Nothing is wrong; just do not quote the two figures side by side.

---

## 5. What you do on each screen

### L1 · Liquor Brand Map (Admin)

- **Map tab** — search your item, add its TGBCL brand code, pack code (PP / NN / QQ), ml, bottles
  per case, ₹ per case, and BEER / IML / Duty Paid. One item can hold several packs; the key is
  (brand code, pack code), never the item.
- **Rate Movement tab** — pick a store and a date range, tick *Only lines where the rate moved*.
  Four cards: inward lines, rate moved, worth (Σ |difference × bottles|), not mapped. Accept a new
  rate into the master line by line.
- **Import tab** — the Brand Master CSV, preview then commit, as in §2a.

### L2 · Liquor Wallet (Management)

- **Check A card** — type what the TGBCL portal shows today and press save. It records an
  observation (never a movement — a reading can never move the balance it exists to check) and
  answers with the difference *in words*: either "the PORTAL holds ₹X more than the ledger
  accounts for — look for a deposit we have not recorded, or an indent TGBCL has not charged yet",
  or "the LEDGER claims ₹X more than the portal shows — look for a challan that never reached
  TGBCL, or an indent we have not recorded". Re-typing today's figure corrects today's reading
  rather than stacking a second one (and it tells you what it replaced).
- **§A2 planner** — type the planned next indent, press Plan.
- **Record a wallet movement** — Deposit (challan no, payment mode, bank debit date, bank amount,
  bank match) / Adjustment (remark required) / Opening (once only). Indent debits are machine
  written and marked `auto`; you cannot type one from the form.
- **Ledger** — date window, running balance per row, CSV download.
- **Integrity panel** — appears only when something needs you. It lists: recorded indents with no
  wallet debit; recorded liquor purchases with **no indent record at all** (nothing was debited);
  debits no longer equal to their Net Indent; debits whose indent no longer exists; indents with a
  non-positive Net Indent (deliberately not debited); and debits from a store that is not the
  liquor store.

### L3 · Wine-shop Purchase (on the Liquor Store page)

Button labelled **Wine-shop Purchase**. Fill: item, bottles, ₹ per bottle paid, date, shop name
(the duplicate guard keys on it), shop licence no, bill no if there is one, who paid, payment
mode, reason, approved by, and the reimbursement state — **Not required** or **Claimed – pending**.

- **"Reimbursed" cannot be typed.** It is reached only by a real petty-cash payout. Otherwise the
  app would report a staff member paid back on the strength of a dropdown.
- If the brand is not mapped yet, you can type a depot rate for this one buy; if you leave it
  blank the buy is recorded with the excess **excluded** from the price-of-running-out total (never
  folded in as a zero), and the reply tells you how to supply the rate later.
- Recording it moves stock and writes one documentary purchase row. **It does not debit petty
  cash.** If the cash came straight out of the box, record that on the Petty Cash page — the reply
  says so.
- **Reimburse** closes a pending claim with a real petty-cash payout, in full only (there is
  nowhere on the record to store a part payment, and closing a ₹9,000 claim with ₹1 would erase
  ₹8,999 of a real debt from §E). The box that is debited is the **claim's** outlet, not your
  session's. If that payout is later deleted, the claim **reopens** and §E counts it as owed again.

### L4 · Liquor Withdrawals (Admin)

Record: date, store, item, cases + bottles, category (management personal / staff welfare /
marketing sampling / breakage-spoilage / transfer), landed ₹ per bottle (leave blank to let the
app resolve it), MRP if you want the MRP value, taken by, authorised by, recovery basis
(none / landed / MRP / custom), excise-register flag, remarks.

- Refuses to issue more than the store's book shows unless you deliberately override — and when
  you override, the row itself is stamped `[forced below on-hand]`, not just the audit log.
- A repeat of the same item / quantity / date / person within two minutes is treated as a retry
  and refused until you confirm. That is the flaky-tablet double-submit that once deducted stock
  twice.
- Recovery is recorded later with the money control on the row; recovered can never exceed
  recoverable, so outstanding can never go negative.
- The wastage co-write (breakage only) is **off by default** and should stay off — see the
  follow-up list, item 8.

### L5 · Liquor Reconciliation (Management)

Pick store, from, to, optionally a planned indent, and read down: the four **checks** as cards,
then A (wallet), A2 (top-up), B (per-indent totals), C (beer/spirit), D (factors), E (wine shop),
F (total cost), G (rate movement), H (non-sale issues). Each section has its own CSV.

Two banners to trust:

- **A "pending" banner names the phase that owes the data** — e.g. "Indents recorded, but no brand
  is mapped yet". A section with nothing behind it says so; it never shows a fabricated zero.
- **The basis note** appears when §B and §C/§D disagree: §B reads whole recorded **bills**, §C/§D
  sum the ledger **lines** inside your dates. It names the bills that straddle the range edge and
  any purchase line carrying no invoice ref. "Neither figure is wrong; they are different
  measurements. Reconcile a month against §B."

---

## 6. The four checks, and what to do when one fails

| Check | Passes when | Where the number comes from |
|---|---|---|
| **A — Wallet balance vs portal** | The portal figure you typed equals the computed balance to the paisa | Newest portal reading at or before your `to` date, against SUM of every wallet movement to that date |
| **B — Per-indent value vs portal** | Every per-indent portal reading in range equals that indent's Net Indent | `lq_portal_checks` rows of kind `indent_value` |
| **C — Bank-unconfirmed deposits** | No deposit is still `pending` | Every recorded deposit, not bounded by your dates |
| **D — Retail excess** | No premium was paid over depot in range | §E excess total |

**When A fails.** The card tells you which way round the difference runs. Then:
1. Open the wallet **integrity panel**. "Recorded indents with NO wallet debit" and "recorded
   liquor purchases with NO indent record" are the two usual causes — the second is the CSV door:
   a register uploaded with the four levy fields blank writes no charges row, so no Net Indent was
   ever computed and nothing was debited. Fix by entering that bill's charges.
2. Check the "debits no longer equal to their Net Indent" list — a bill whose charges were edited
   by hand after a debit was adopted from a manual row shows up here rather than silently.
3. Look for a **challan you deposited but never recorded**, and for movements dated in the future
   (the ledger flags them: they sit inside the headline balance but outside every as-at figure,
   check A included).
4. Only when you know the cause, correct with an **Adjustment** carrying the reason. Never a second
   opening balance, never an edit.

**When B says "no data".** That is today's normal state — see follow-up item 5: nothing in the app
records a per-indent portal reading yet. When readings exist, a **fail** means the portal charged
something different from what you recorded: compare the indent's four levies against the portal
PDF and re-save the bill (the wallet debit re-derives itself). A **warn** means a reading names an
indent this store has no record of — usually a mistyped indent number.

**When C warns.** Deposits you have recorded but not yet ticked off against the bank statement.
Open the bank statement, and for each challan record the bank debit date and amount, then mark it
verified. The app refuses to mark a deposit verified without the bank debit date, and it flags a
verified deposit whose bank amount differs from the challan amount.

**When D warns.** You paid retail. That is not a bug — it is the cost of running dry, and the
number is the point. Read §E: which brands, which shops, how much premium, and whether staff are
still out of pocket. Then fix the indent plan for those brands.

---

## 7. The four decisions — settled

### Decision 1 — Landed cost: BOTH bases, behind a toggle

A setting chooses whether **reports** value at landed cost (rate + that line's share of the TGBCL
levies) or at the platform's existing **recorded-only** basis. **Recipe costing and pour costs stay
on the existing basis by default.** The toggle is opt-in and never touches
`raw_materials.average_price`, `raw_materials.last_purchase_price` or
`store_stock_ledger.unit_cost`.

Where the code stands: the *recorded-only* half is honoured everywhere in the module (nothing in
L1–L5 writes a valuation column) and landed cost is computed and displayed as analytics. **The
toggle itself does not exist** — the module's only setting is the wallet's rounding step — and the
default basis is **not actually protected** from the wine-shop path. See follow-up items 1 and 2.

### Decision 2 — Rate basis: value at the RATE PAID, and surface every drift

When an indent rate differs from the Brand Master, the figures are built on **what you actually
paid**. The master is kept as the yardstick, the difference is shown on the **Rate Movement** card,
and one tap accepts the new rate into the master with an audit trail. Never an automatic rewrite.

**The exact guide — which number is used where.** Using the Budweiser line above
(paid ₹152.00, master ₹148.00 = ₹1,776.00 per case ÷ 12, levies ₹10.7865 a bottle, 96 bottles):

| Figure | Rate it uses | This line | Status in the code |
|---|---|---|---|
| Line value on the indent / register | **paid** | 96 × 152.00 = ₹14,592.00 | matches |
| Net Indent, and therefore the wallet debit | **paid** (+ levies) | inside ₹1,68,161.24 | matches |
| §B per-indent totals, §F total liquor cost | **paid** | ₹14,592.00 | matches |
| §C/§D landed value and uplift | **paid** + levies | 14,592.00 + 1,035.50 = ₹15,627.50 | matches |
| §G variance | paid − master | +₹4.00/btl, ₹384.00 | matches |
| Accepting the rate writes | paid × bottles per case | 152.00 × 12 = **₹1,824.00 per case** | matches |
| **Landed cost per bottle** (L1's figure) | **should be paid** + levies = 152.00 + 10.7865 = **₹162.7865** | ₹15,627.50 for the line | **does NOT match — uses master**: 148.00 + 10.7865 = ₹158.7865, ₹15,243.50 for the line |
| §E depot rate an emergency buy is compared against | should be **paid**-based landed | | inherits the master-based figure |
| §H landed value frozen on a withdrawal, and a "landed" recovery billed to a person | should be **paid**-based landed | | inherits the master-based figure |

The gap between the two bases is exactly the rate variance: **₹15,627.50 − ₹15,243.50 = ₹384.00**,
the same figure §G reports. So while a master is stale, today's landed cost, the wine-shop excess
baseline and any amount recovered "at landed cost" are **understated by the drift** — here ₹4.00 a
bottle, and it would be a much larger number on a spirit whose master has not been touched in a
year.

After you accept the rate (master → ₹1,824.00 per case = ₹152.00 a bottle) the two bases converge
and the §G row clears. Accepting does **not** re-price anything already frozen: an emergency buy
recorded last month keeps the depot rate it was frozen against, and a withdrawal keeps the landed
value it was issued at. That freezing is deliberate and stays.

Follow-up item 3 is the code change this decision requires.

### Decision 3 — Vendor near-duplicates: leave them separate, flag names that are nearly the same

Two vendor rows whose IDs genuinely differ stay two vendors. Nothing merges them. **Additionally**,
when two vendor NAMES differ by only about 2–3 characters, raise a **review flag** — a flag, never
an automatic merge.

Where the code stands: nothing in this module (or anywhere in the tree) merges vendors — that half
matches. **The review flag does not exist**; there is no name-similarity check anywhere. Your live
data already has the case it is for:

| Distance | Vendor A | Vendor B |
|---:|---|---|
| **2** | VINITH FOODS & BEVERAGES PRIVATE LIMITED `20502b6f…` | VINT FOODS & BEVERAGES PRIVATE LIMITED `98004e77…` |
| 2 | ZZTEST VENDOR | TEST VENDOR *(test rows)* |
| 3 | QA LIQ | QA INJ *(test rows)* |
| 3 | ZZSeed | ZZ Old *(test rows)* |

(59 vendor master rows, 42 distinct free-text vendor spellings on `purchases`.) One caveat worth
knowing: `/api/purchases/vendor-rates` groups purchase history by `lower(trim(vendor))` when it
seeds a bill line's rate. That folds **case and trailing spaces of one name** — it is not an
identity merge and it writes nothing, but it is the closest thing in the batch to treating two
spellings as one vendor. Measured today: 42 spellings, 42 after normalising, so nothing collapses
right now. Follow-up item 4.

### Decision 4 — CSV import and category case: keep the file's spelling on the item, and warn

An import must **not silently fold case**. Keep what the file says on the item, and say so in the
preview when it differs from what is stored.

Where the code stands:

- **The item's own spelling is safe.** The Brand Master import writes `lq_brand_map` and
  `audit_events` and nothing else — it never rewrites `raw_materials.name` or
  `raw_materials.category`. Matching an item by name or SKU case-insensitively is a *match*, not a
  rewrite, and stays.
- **The bill CSV on the Liquor Store** refuses an item whose category is not mapped to the store,
  matching case/space/dash-insensitively, and rewrites nothing. Consistent with the decision.
- **Two silent folds remain**, and both should warn instead:
  1. `product_type` (your sheet's *category* column maps to it) is folded to one of BEER / IML /
     Duty Paid with **no warning** when the file's spelling differs — 'Beer' stores as 'BEER'
     silently. An unrecognised value already errors the row, which is right.
  2. TGBCL brand codes and pack codes are silently **upper-cased** — `9740/pp` stores as
     `9740/PP`. This one has a real reason (the uniqueness index is case-sensitive, so without it
     one pack becomes two master rows), so keep the fold and add the warning line.

  Follow-up item 6.

---

## 8. What is NOT automated — this still needs you

1. **Typing what the portal shows.** There is no TGBCL portal import. You read the balance off the
   portal and type it on the wallet's Check A card. Same for a challan: the deposit row is manual.
2. **Bank matching.** Ticking a deposit against the bank statement is a human act (date + amount +
   verified).
3. **Populating the Brand Map** and keeping master rates current — including pressing *Accept into
   master* when a rate has genuinely moved. The app never rewrites a master by itself.
4. **`case_size` on the item master**, so cases read as cases (see §2a).
5. **Recording the wine-shop run** and, separately, the **petty-cash side** if cash left the box
   directly. The module writes the box only when it reimburses a claim.
6. **Recording withdrawals.** Nothing infers a director's bottle; somebody has to key it, with the
   authoriser's name.
7. **Recovering money.** Marking a withdrawal recovered is manual, and part-payments are not
   representable — either it is recovered in full or the balance stays outstanding.
8. **The excise register.** The flag on a withdrawal is a flag; no excise return is generated.
9. **Deciding when a check failure matters.** No alert, e-mail or WhatsApp fires on a failed check
   — you look at the page. The four cards are the whole alerting story today.
10. **Migrating the workbook's history.** Brand Master has a CSV path; the Portal Wallet history
    does not — those rows are typed, one at a time, honouring the sign rules (deposits positive,
    indent debits negative, one opening only).

---

## 9. Where the built code does NOT yet match the decisions — the follow-up list

Precise, so it can be worked straight through. Nothing on this list was changed while writing this
document.

1. **The landed/recorded toggle does not exist (Decision 1).** The module's only setting is
   `lq_wallet_topup_step`. There is no setting and no report-level switch; §B always shows
   recorded bill figures and §C/§D/§F always show landed. *Work:* one setting, default = existing
   recorded-only basis, plus a "value at" switch on §C/§D/§F/§H and the register's recon block.

2. **The default basis is not protected from the wine-shop path (Decision 1).** L3 must write a
   documentary `purchases` row (its side record is anchored to `purchases.id`), and two shared
   readers consume `purchases` with no exclusion:
   - `updateMaterialPrice()` in `src/lib/db.ts:8239` averages **every** purchases row in the
     calendar month of `MAX(date)`, and `/api/admin/recompute-prices` + `/api/admin/restore-prices`
     run it across the whole catalogue;
   - `materialRate()` in `src/lib/closing-valuation.ts` takes rung 1 = the unit price on the most
     recent purchases row.

   So one emergency buy at MRP can re-price a liquor item's recipe cost and its closing valuation
   — which is exactly what Decision 1 forbids by default. On your live data KAHLUA LIQUEUR (750ML)
   sits at `average_price` 3.3063 ₹/ml with the latest purchase at ₹2,479.7417/BTL (16 Apr 2026)
   and 6,630 ml on hand; a 6-bottle emergency buy at ₹3,500 would move it to 4.6667 ₹/ml
   (= 3,500 ÷ 750, **+41%**) on the next recompute, and the closing value of that stock from
   ₹21,920.71 to ₹30,940.00 (**+₹9,019**). *Work, as named in the code:* one predicate each —
   `AND COALESCE(is_emergency, 0) = 0` in `updateMaterialPrice()`'s two SELECTs and in
   `closing-valuation.ts`'s `last` lookup and `rateMap`. Both files are **committed** code outside
   this module, so this is your call, not the module's.

3. **Landed cost is built on the MASTER rate, not the rate paid (Decision 2).**
   `landedCostPerBottleExplained()` in `src/lib/liquor-recon.ts` (≈ line 844,
   `const ratePerBottle = bm.rate_per_bottle_master`) and `varianceRowsFrom()`'s `landedPerBottle`
   (≈ line 1023) both use the master. §C/§D already use the rate paid
   (`liquor-summary.ts`: `landedValue += ln.subtotal + ln.levies`). The file's own header names
   this divergence and says it is the owner's to settle — you have now settled it. *Work:* switch
   the L1 figure to `indentRatePerBottle + leviesPerBottle`, keep the master purely as the §G
   yardstick, and re-check the three consumers: L3 `resolveDepotLanded`, L4
   `resolveLandedUnitCost` (its `l1_landed` rung), and the register's `recon` block. Figures
   already frozen on `lq_retail_flags` / `lq_withdrawals` must stay frozen.

4. **No vendor near-duplicate review flag (Decision 3).** Nothing computes name similarity
   anywhere in the tree. *Work:* a flag-only review surface over `vendors` (and optionally the
   free-text `purchases.vendor` spellings) at an edit distance of 2–3, never an auto-merge. Your
   live pair to test against: VINITH vs VINT FOODS & BEVERAGES PRIVATE LIMITED, distance 2, two
   different IDs, both legitimate.

5. **Check B can never pass today.** Nothing in the app writes a `lq_portal_checks` row of kind
   `indent_value`; the wallet page records the wallet-balance reading only. The Summary says so
   honestly ("this check waits on an indent-value reading"), but the check is inert. *Work:* a
   per-indent portal figure on the bill screen or the wallet page.

6. **Two silent case folds in the CSV import (Decision 4).** `normProductType()` and `normCode()`
   in `src/app/api/liquor/brand-map/_lib/rows.ts` fold quietly. *Work:* keep both folds, add a
   preview warning whenever the stored value differs from what the file typed
   ("row 14: product type 'Beer' stored as 'BEER'", "row 14: code '9740/pp' stored as '9740/PP'").

7. **The four pages are still flagged `unbuilt: true` in `src/lib/page-catalog.ts`** (lines 244,
   248, 253, 257) although all four `page.tsx` files exist. Consequence: they are skipped by the
   automatic landing-page resolution, so a user whose only granted page is one of these lands on
   `/login` instead of the page. The sidebar shows them and clicking works. *Work:* delete the four
   `unbuilt: true` flags (and the caveat paragraph above them) in the same commit that ships the
   pages.

8. **The wastage co-write has a live hazard, so it stays off.** `DELETE /api/wastage` credits stock
   back for any row with a blank department — right for rows that rail created, wrong for a
   co-written liquor row whose movement is on the store ledger. Deleting one from the Trash button
   invents central stock. The one-line guard is written out in
   `src/lib/liquor-withdrawals.ts` (≈ line 302). Until it lands, leave the toggle off.

9. **Stale note, no behaviour change:** `src/lib/liquor-retail.ts` (≈ lines 908–917) still says L5
   re-derives the §E figures instead of calling `retailExcessSummary`. L5 now calls it
   (`liquor-summary.ts:784`). Just a comment to delete.

---

## 10. Things I noticed that are outside this module (reported, not touched)

- **`raw_materials.last_purchase_price` / `average_price` hold mixed bases.** HENDRICKS GIN carries
  `average_price` 5641.83 in a ₹/ml column (it is ₹ per bottle — 700× out). Known trap, already
  documented; every liquor figure in this module goes through `closing-valuation.ts` or the pack
  layer for exactly this reason.
- **`store_category_map` has one row with an empty `id`** (category `bar`, created 2026-07-29).
  Harmless today; it will surprise anything that keys that table by id.
- Your liquor category mapping covers 23 categories on the one active LIQUOR STORE, giving the
  Brand Map its 127-item universe.

---

## Provenance — what I verified, and what I did not

- **Read in full:** the plan (`docs/liquor-reconciliation-plan.md`), `src/lib/liquor-recon.ts`,
  `liquor-wallet.ts`, `liquor-retail.ts`, `liquor-withdrawals.ts`, `liquor-summary.ts`, every route
  under `src/app/api/liquor/`, the brand-map guard/rows helpers, `vendor-rates`, the working-tree
  diffs of `store-engine.ts`, the inward-register route, `page-catalog.ts`, `Sidebar.tsx`, and the
  `lq_` schema block in `db.ts`. Pages were read as code.
- **Verified against a scratch copy of your database** (copied with its `-wal` and `-shm`; the
  original was only ever read): item names, units, pack sizes, case sizes, average prices; the
  127-item Brand Map universe; 2 of 126 bar items case-packed; 59 vendors and their edit distances;
  KAHLUA's stock, average price and latest purchase price. All `lq_` tables and the liquor store
  ledger are **empty** locally, so no screen was driven with real liquor data.
- **Arithmetic:** every figure in §4 was computed with the module's own formulas (allocation bases,
  remainder-to-last-line, the wallet and planner rules) and cross-checked to add back to the
  recorded totals.
- **Not done — say so plainly:** no browser test, no dev server, no screenshots. Timings and
  leak measurements quoted from code comments (5.8 s recon reads, the KAHLUA re-price, the doubled
  debits) are the build's own measurements — I verified their **mechanism** by reading the code and
  the inputs in your database, not by re-running them. **UNPROVEN:** that the five screens render
  correctly end to end on live liquor data.
- **Gates run at the time of writing:** `npx tsc --noEmit` → 0 errors; `npm test` → 76 passed /
  0 failed; `node scripts/check-boot-migrations.js` → CLEAN. No liquor file was modified; this
  document is the only new file.
