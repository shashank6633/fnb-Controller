# Deduct-at-issue: the cutover note

**Setting:** `requisition_deduct_at_issue` — Settings → Purchasing & Stock, third card
(`src/app/settings/purchasing/page.tsx:31`, saved at `:194`, admin-only).
**Shipped value: `0` (off).** Seeded once by `INSERT OR IGNORE` at `src/lib/db.ts:1282`,
so a restart never resets whatever you set.

This note is for the person who decides the day. Read section 2 before you touch the
switch. Nothing here needs a developer.

---

## 1. What changes

Today, `raw_materials.current_stock` falls when a **dish is sold** — the recipe is
exploded and every ingredient is withdrawn from the central store, even though that
ingredient physically left the store days earlier when the kitchen requisitioned it.
Issues to departments record themselves in the Issued Items Log but move no stock.

After the switch, central stock becomes **the store's own holding, and nothing else**:

```
current_stock = purchases + GRN/PO receipts + opening stock
              − issues to departments (requisition)
              − wastage − transfers out − party fulfilment
```

Recipe consumption stops withdrawing anything. It does **not** stop being recorded —
every ingredient still writes its `inventory_transactions` row exactly as today
(`src/lib/db.ts:4772`, `applyDeduct`: only the final central `UPDATE` is skipped; the
transaction row is written by the caller loop and is untouched). That row is the
**theoretical yardstick** you described: what the kitchens *should* have used, given
what was sold.

The gap between the two is the diagnostic:

| | Where it comes from | What it means |
|---|---|---|
| **Recipe consumption** | Sales × recipes | Theoretical. Compare against purchases. |
| **Department consumption** | What the store actually issued | Physical. Who took it. |
| **The gap** | | Where the loss sits, and which kitchen it sits in. |

### Reports that do NOT change — not by a rupee

These read `inventory_transactions` and `requisition_items`, never `current_stock`.
Their numbers are bit-identical before and after.

- **Variance Report** — `src/app/api/variance-report/route.ts:88` computes
  `recipe_to_date` from `inventory_transactions` types `sale | party | staff_meal`.
- **Daily Roll-up** — `src/app/api/daily-rollup/route.ts:76` and `:87`, same types.
- **Closing-stock VALUATION** — `src/lib/closing-valuation.ts:62` / `:115` price a
  *counted* quantity off purchase history. They never read `current_stock`.
- **Department consumption** — `/api/department-consumption` aggregates
  `requisition_items.quantity_issued` directly.
- **Issued Items Log** — written unconditionally by the store-issue and store-process
  routes; the flag has never gated it.
- **`/api/department-stock`** — derives (last closing count + issues since) via
  `src/lib/dept-stock.ts:7`. Never reads `current_stock`.

### Figures that DO change

Every screen that shows `current_stock`. Each of these will read **lower** after the
cutover, because months of issues finally come off:

- **Inventory** — stock column and total stock value
- **Low Stock** list (`src/app/api/inventory/route.ts:12`) and the dashboard count
- **Store Low-Stock Buy List** (`src/app/store-dashboard/page.tsx:149`)
- **Consolidated Stock board** (`src/app/inventory/stock-overview/page.tsx:191`)
- **`days_of_stock`** on the dashboard (`src/app/page.tsx:954`), Purchase Orders
  (`src/app/purchase-orders/page.tsx:3674`) and Smart Reorder (`src/app/crm/reorder/page.tsx:136`)
- **Data Hygiene** — the "Negative stock" blocker (`src/app/api/data-hygiene/route.ts:117`)
- **Inventory CSV export** — the `current_stock` / `current_stock_purchase_unit`
  columns (`src/app/api/inventory/export/route.ts:97`, `:108`)

---

## 2. Preconditions — all four, in this order

**Do not flip the switch until every one of these is done.** They are ordered because
each one can undo the one before it.

### a. Drain the variance-approval queue

Approving a variance writes an **absolute** figure:
`SET current_stock = physical_stock` (`src/lib/variance-approval.ts:229`). A count taken
*before* the cutover and approved *after* it would stamp an old-basis number on top of
the new basis and silently wipe out the re-base you are about to do.

**Do:** go to Variance Approvals and approve or reject **every pending row** first.
Leave the queue empty. Then stop taking new counts until step (c).

### b. Lock the units

Any pack-factor change through Unit Audit **rescales** `current_stock`
(`src/app/api/unit-audit/route.ts:291-292`). If a factor moves after you take your
cutover count, the counted number is silently multiplied.

**Do:** finish and lock Unit Audit. Take the snapshot in step (c) **after** the lock,
never before.

### c. Full central closing count, then re-base — **this is the step that breaks cutovers**

Today's `current_stock` is *purchases minus what the kitchens cooked*, with months of
issues invisible. It is not a credible opening balance for a store-only figure.

Measured on the live database (928 active materials): of the **699 materials issued in
the busiest month (May 2026, 14,144 issued lines)**, **649 would fall below zero** if
that one month's issues were replayed against today's numbers. Restricted to materials
holding stock today, it is **376 of 426**.

Negative stock is not cosmetic — **it blocks the store from issuing.** The store screen
clamps negative stock to zero (`src/app/requisitions/page.tsx`, the `safeStock` line —
`Math.max(0, Number(it.current_stock) || 0)`, currently `:1974`; cited by symbol because
that file moves), so the proposed
issue quantity becomes 0 and the entire department ask reads as a PO shortfall. Flip the
switch without re-basing and the store cannot issue anything the morning after.

**Do:**
1. Physically count the central store — everything, one date.
2. Enter it as opening stock (**Purchases → Opening Stock**). It **increments**
   `current_stock` and applies the pack multiplier (`qty × pack_size`) only when the
   recipe unit differs from the purchase unit — `src/app/api/purchases/opening-stock/route.ts:15`, `:49`.
   Because it increments, zero the material first, or have an admin set the absolute
   figure instead.
3. Reconcile: every counted material should now read exactly what you counted.
4. **Only then** flip the switch.

### d. Re-base `reorder_level`

All **107** materials that have a reorder level are **already below it** (107 of 107,
checked on the live database). After the cutover the level has to mean *"central store
buffer"* — how much the store keeps on its own shelf — not *"whole outlet"*.

Until this is done, the Low Stock list and the Smart Reorder pack suggestion carry no
signal at all; everything is red, so nothing is.

**Do:** for each material with a reorder level, reset it to the quantity the *store*
should hold between deliveries, not the quantity the outlet consumes.

---

## 3. Requisitions half-issued across the boundary

**Nothing to do. This is handled by construction.**

`requisition_issue_ledger.baseline_line_qty` is stamped on the **first** ledger row for a
line, from whatever `quantity_issued` already held (`src/lib/db.ts:1238-1245`). Only the
increment issued *after* the flip moves stock. A requisition issued 5 kg of 7 kg
yesterday and topped up 2 kg tomorrow moves exactly 2 kg, never 7.

All **14,147** historical issued lines are structurally out of scope for the same reason.
The ledger currently holds **0 rows** — as expected, since the flag has never been on.

---

## 4. How to reverse it

**Set the flag back to `0`, then re-anchor with a physical count.**

Say this plainly, because it is the part that surprises people:

> **Flipping the switch back stops new debits. It does NOT put back stock that was
> already removed.** The reverse is *"stop and recount"*, not *"flip it back and the
> numbers return"*.

There is no bulk unwind. The only code path that credits issues back to `current_stock`
is inside the admin reset **delete** flow (`src/app/api/admin/reset/route.ts:411-417`),
which sums the ledger and returns it — but only while it is deleting the requisitions
themselves. That is a data wipe, not a rollback.

So: turn it off, take a fresh physical count of the central store, and re-base with
opening stock exactly as in step 2(c). Budget for the count.

---

## 5. Known gaps that are still open on day one

None of these blocks the cutover. Each one is a place where the new model is not yet
finished, with what to do about it operationally until it is built.

**a. Wastage, staff meals and party items still debit central stock for goods the
department already holds.**
`src/app/api/wastage/route.ts:76`, `src/app/api/staff-meals/items/route.ts:113`,
`src/app/api/parties/items/route.ts:119`, `src/lib/party-fulfillment.ts:78`.
If a kitchen wastes something it was *issued*, central stock is debited a second time
for a gram that already left the store.
**Until fixed:** record wastage against goods still sitting in the central store. For
goods already issued to a kitchen, record the loss through that department's closing
count instead, and note it. Watch for central stock drifting low on the materials your
kitchens waste most.

**b. The liquor / store-mapped rail is a separate pool — and there is a hard rule.**
Store-mapped materials live in `store_stock_ledger`, not `current_stock`. The migration
route moves a material's central stock into a store ledger and **sets `current_stock`
to 0** (`src/app/api/stores/[id]/migrate/route.ts:16-18`).
**HARD RULE: do not run a store migration while the flag is on.** A migration zeroes
central stock; a requisition issue then debits from zero and drives the material
straight negative, which blocks issuing (see 2c). Turn the flag off, migrate, re-count,
turn it back on.

**c. `/api/inventory/fix-negative-stock` becomes a stock-manufacturing button.**
It clamps every negative `current_stock` to 0 (`src/app/api/inventory/fix-negative-stock/route.ts:34-36`).
Under the old model a negative was a data error worth erasing. Under the new model a
negative is usually **real information** — the store issued more than it ever received,
which means a missing purchase entry or a wrong pack size.
**Until fixed:** treat this button as off-limits after the cutover. When a material goes
negative, find the missing GRN or the wrong pack size. Do not clamp it.

**d. `/api/department-materials` and `/api/department-stock` will disagree.**
Two different answers to "what does this kitchen hold". `/api/department-stock` derives
it (last closing count + issues since) and is correct today.
`/api/department-materials` reads a stored running balance,
`department_materials.on_hand` (`src/app/api/department-materials/route.ts:31`, `:43`),
which is written by `creditDepartment()` (`src/lib/issue-stock.ts:269`) — and that
function **only runs while the flag is on**. So the moment you flip the switch, this
second figure starts filling up from zero and will read far lower than the derived one.
**Until fixed:** `/api/department-stock` is the department figure of record. Ignore
`department_materials.on_hand` for at least a full closing cycle after the cutover.

**e. Butchering.**
`src/app/api/butchering/route.ts:332` debits the carcass and `:343` credits the cuts,
both against central `current_stock`. If the carcass is requisitioned out to a butchery
department first, the debit lands on the wrong pool.
**Until fixed:** run butchering **before** the carcass is issued — break it down while
it is still central-store stock, then requisition the cuts. Do not issue a whole carcass
and butcher it on the department's books.

**f. The Data Hygiene blocker text will read wrong.**
The "Negative stock" blocker says *"sales were deducted faster than purchases inwarded"*
(`src/app/api/data-hygiene/route.ts:121`) and suggests fixing it with a closing count.
After the cutover the real cause is almost always **issues** outrunning receipts, not
sales.
**Until reworded:** read that message as *"issues outran receipts"*. The suggested fix —
run a count — is still the right action.

**g. `days_of_stock` will read short across the board.**
It divides a now-smaller `current_stock` by an unchanged consumption rate, so the
dashboard, the PO screen and Smart Reorder will all show fewer days than before.
**Until re-based:** the number is now *"days the central store can keep issuing"*, which
is a useful figure — but it is not the old number, so do not compare it against anything
recorded before the cutover. Re-base your mental thresholds along with `reorder_level`
in step 2(d).

**h. The Inventory CSV `current_stock` column changes meaning.**
`current_stock` and `current_stock_purchase_unit`
(`src/app/api/inventory/export/route.ts:97`, `:108`) become *central store holding*, not
*outlet holding*. The column name does not say so.
**Until relabelled:** any spreadsheet, pivot or external report built on that column
needs its heading and its interpretation updated on cutover day. Do not let a
pre-cutover export and a post-cutover export be compared in the same sheet.

---

## Cutover-day checklist

```
[ ] 2a  Variance-approval queue drained to zero
[ ] 2b  Unit Audit locked
[ ] 2c  Full central physical count taken AND re-based via Opening Stock
[ ] 2c  Spot-check: counted materials read exactly what was counted
[ ] 2d  reorder_level re-based to "central store buffer"
[ ] 5b  No store migration scheduled while the flag is on
[ ] --  Settings → Purchasing & Stock → flip requisition_deduct_at_issue to ON (admin)
[ ] --  Store screen: confirm a test requisition can still be issued
[ ] --  Variance Report: confirm the numbers are unchanged from yesterday
```
