# Department stock: the cutover runbook

**There is no switch any more.** The old `requisition_deduct_at_issue` setting has been
removed from the code. The app now *always* takes stock off the central store the moment
the store issues it, and *always* takes recipe consumption off the receiving department.
Nothing you do on a Settings page turns that on or off.

What is still a decision — and the only decision left — is **when you count the shelves**.
Department balances start from a physical count. Until that count is recorded, every
department screen says "not counted yet" instead of showing a number. This document is
how you take that count and switch the building over.

**Who this is for:** the owner and whoever runs the count. No developer needed for the
count itself. One step — section 6 — currently needs a line pasted into the browser
console, because the cut-over screen has not been built yet. It is written out in full
there, and called out as an open handoff.

> **Note on the settings row.** `settings.requisition_deduct_at_issue` still exists in the
> database and is deliberately left there, inert. Deleting admin-owned state inside a
> deploy is not something this change does. Nothing reads it. Do not re-add a reader, and
> do not "restore" the toggle — a switch that writes a key nothing consults is worse than
> no switch, because you flip it, see the toast, and believe something changed.

---

## 1. What the app does now

```
  PURCHASE / GRN / PO receipt / Opening Stock
                  |
                  v
        [ CENTRAL STORE ]  raw_materials.current_stock
                  |
                  |  requisition issue  -> central loses the grams HERE, once
                  v
        [ DEPARTMENT ]     department_material_transactions (signed ledger)
                  |
                  |  recipe consumption at KOT-complete / comp / NC
                  v
                CONSUMED
```

Three rules hold the whole thing up.

**Every gram leaves central exactly once — at the issue.** Recipe consumption no longer
touches central at all. If you ever see a change that makes both happen, it removes every
gram twice.

**A department balance is one number, derived one way.** Latest physical count (or the
cut-over opening row, whichever is later), plus every signed ledger movement since. There
is no second derivation anywhere in the codebase, and there must never be one.

**When the app cannot name the kitchen, it moves nothing and says so.** A dish sold on a
station that is not mapped to a department (today: `sushi`, `terracegrill`, and any blank
station) does not guess a kitchen. It records a skip, names the station, and shows a
warning. Debiting the wrong kitchen silently reads as theft on the very report this whole
change exists to produce.

### What is NOT on this rail

| | Where it lives instead |
|---|---|
| **Liquor / store-mapped materials** | The TGBCL store ledger (`store_stock_ledger`, Inventory → Liquor Store). Skipped by *both* the central debit and the department credit. It is never department stock. |
| **Party requisitions** (`purpose = 'party'`) | Their own fulfilment rail, unchanged. The issue rail skips them entirely. |
| **Butchering** | A central-store operation from end to end. Since this change it *refuses* to close a batch on a carcass a department is holding — see section 10. |

---

## 2. Before you start — four preconditions, in this order

Each one can undo the one before it. Do them in order.

### 2a. Empty the variance-approval queue

**Inventory → Variance Approvals.** Approve or reject every pending row, then stop taking
counts until step 4.

Approving a variance posts the **count-time delta** (`physical − system-as-counted`) on
top of whatever the material holds now. A count taken before the cutover and approved
after it applies an old-basis delta to a new-basis balance. Clear the queue and the only
pending rows left afterwards are the cutover counts themselves, which is what you want.

Verify it is empty:

```sql
SELECT COUNT(*) AS pending FROM variance_approvals WHERE status = 'pending';
-- must be 0
```

### 2b. Lock the units

**Inventory → Unit Audit.** Finish it and lock it *before* you count anything.

A pack-factor change rescales stock. It now also posts a signed `adjustment` row to every
department that holds the material, so the department balance moves with it — but if a
factor changes *after* your count, the counted number is silently multiplied. Lock first,
count second. Never the other way round.

### 2c. Check the station → department map

**Settings → Station → Department Map** (admin only).

Thirteen rows are seeded: the twelve stations that appear on the menu today, plus the
blank-station sentinel. Nine are mapped to a department; four are deliberately left
unmapped, and you should understand why before you change any of them:

| Station | Menu items | Mapped to |
|---|---|---|
| continental | 46 | Akan Continental |
| pan-asian | 45 | Akan Pan Asian |
| indian | 44 | Akan  Indian |
| tandoor | 28 | Akan Tandoori |
| pizza | 21 | Akan Pizza |
| bakery | 17 | Akan - Bakery |
| bar / cocktail / mocktail | 2 / 76 / 27 | Akan Bar (all three, one physical bar) |
| **sushi** | 23 | **unmapped — you choose, or leave it** |
| **terracegrill** | 6 | **unmapped — you choose, or leave it** |
| **liquor** | 293 | **never map this.** Liquor is on the TGBCL store rail. |
| **kitchen** | 0 | **never map this.** It is the blank-station sentinel: the KOT writer turns an empty station into the literal word `kitchen`, and "Kitchen" is a real department. Mapping it would debit the main kitchen for every station-less item sold. |

The seed runs exactly once, guarded by `settings.station_dept_seed_v1`, so a mapping you
delete stays deleted across deploys.

**Read this before you expect the report to accuse anyone.** Only **18 of 628** menu items
have a recipe attached. Recipe consumption therefore fires for 18 dishes. And **Akan Main
Kitchen — the largest receiver in the building, 250 materials, 4,335 issued lines — has no
station pointing at it at all.** The Department Variance report knows this: it prints
"No recipe attached yet" or "Station not mapped yet" rather than a difference. It will not
call anything a loss until the data supports it. Attaching recipes is the work that makes
this report mean something, and it is not part of the cutover.

### 2d. Understand what central is about to look like

Central will read far lower, and on many materials it will read negative. This is not a
bug and it must not be "fixed".

Measured on the live database today:

```
$ sqlite3 fnb-controller.db "
  SELECT COUNT(*) FROM (SELECT DISTINCT material_id m FROM requisition_items
                         WHERE COALESCE(quantity_issued,0) > 0) x
    JOIN raw_materials rm ON rm.id = x.m
   WHERE COALESCE(rm.current_stock,0) <= 0;"
274        -- of 701 issued materials, already at or below zero BEFORE the cutover
```

Recorded issues have historically run several times recorded purchases (CHICKEN LEG
BONELESS: 1,309 kg bought against 4,471 kg issued). That gap is missing purchase history,
not missing food. Two things follow, and both are deliberate:

- **The store screen no longer clamps the issue to zero.** When the book balance is at or
  below zero, the storekeeper is seeded with the full approved demand and types what he
  physically hands over. The negative is printed in red on the row. We show the deficit;
  we do not act on it. (The old clamp made the default issue 0 and pushed the whole ask
  into a purchase order — real vendor spend for goods already in the building.)
- **Do not press "fix negative stock".** It now writes an audited `adjustment` row for
  every gram it invents, so at least the invention is on the record — but lifting a
  negative to zero asserts "the shelf is empty", which is almost never true. The honest
  correction is a count, or entering the missing purchases.

The counted figure in step 5 is what makes central credible again.

---

## 3. The order of operations on cutover day

```
  1. Empty the variance-approval queue                 (2a)
  2. Lock Unit Audit                                   (2b)
  3. Review the station map                            (2c)
  ------------------------------------------------ counting starts
  4. Count each DEPARTMENT   -> record on the Department Closing Sheet
  5. Count the CENTRAL store -> record as a Store/Overall closing count
  6. Adopt each department's count as its OPENING      (the cut-over call)
  7. Approve the CENTRAL count; REJECT the department ones
  8. Prove it landed                                   (the drift check)
```

Steps 4 and 5 should happen on the same day, and ideally before service. Departments can
be cut over on different days if you must — the first one to be adopted sets the
building's boundary date, and later ones simply anchor later.

---

## 4. Step 4 — count each department

**The sheet.** Inventory → **Department Closing Sheet** (`/inventory/closing-sheet`) is
the entry surface. It spans every active department and a department's own staff can
record their own counts.

**What to count.** Everything the department has ever been issued, excluding liquor. This
is the exact SQL that produces the count sheet — it is read-only and safe to run:

```sql
-- COUNT SHEET, per department. Read-only.
-- 'count_in' is the unit to count in (the purchase unit — the owner rule).
-- 'per_purchase_unit' is how many recipe units are in one of those.
SELECT d.name                        AS department,
       rm.sku,
       rm.name                       AS material,
       rm.purchase_unit              AS count_in,
       rm.unit                       AS recipe_unit,
       COALESCE(rm.pack_size, 1)     AS per_purchase_unit,
       ''                            AS counted_qty
FROM   requisition_items ri
JOIN   requisitions   r  ON r.id  = ri.req_id
JOIN   raw_materials  rm ON rm.id = ri.material_id
JOIN   departments    d  ON d.id  = COALESCE(NULLIF(TRIM(ri.department_id), ''), r.department_id)
WHERE  COALESCE(ri.quantity_issued, 0) > 0
  AND  COALESCE(r.purpose, '') <> 'party'          -- parties are their own rail
  AND  NOT EXISTS (                                 -- LIQUOR CARVE-OUT
         SELECT 1 FROM store_category_map m
         JOIN store_locations s ON s.id = m.store_id
         WHERE s.is_active = 1
           AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(m.category)), ' ', ''), '-', ''), '_', '')
             = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)), ' ', ''), '-', ''), '_', ''))
GROUP BY d.id, rm.id
ORDER BY d.name, rm.name;
```

Run today, that is **1,080 department x material pairs**:

```
Akan Main Kitchen     250      Akan - Bakery          71
Akan Bar              127      Akan - Staff Room      55
Akan Continental      112      Akan Perishables Bar   38
Akan  Indian          111      Akan Service           27
Akan Pan Asian        105      Akan Office            13
Akan Tandoori          89      Akan Security           4
Akan  Housekeeping     75      Akan Pizza / Valet / Stationery  1 each
```

**Counted zero is a real answer.** Record it as 0 on the sheet. It anchors the balance at
nil, which is different from "never counted" and is what you want for a material the
kitchen genuinely does not hold. (A zero cannot be written as an *opening ledger row* —
the ledger refuses a zero-quantity movement, because a zero row teaches the audit that a
department received nothing. The closing count of 0 is the correct instrument.)

**Do not count liquor into a department.** If a liquor line reaches the cut-over call it
fails the whole request by design — a silent skip would leave you believing the bar was
cut over when nothing of the sort happened. Liquor is counted on Inventory → Liquor Store
→ Record Closing Stock, on its own ledger.

---

## 5. Step 5 — count the central store and re-base it

Same day. **Inventory → Closing Stock**, with no department selected (the Store/Overall
count).

```sql
-- CENTRAL COUNT SHEET. Read-only. Same liquor carve-out.
SELECT rm.sku,
       rm.name                      AS material,
       rm.purchase_unit             AS count_in,
       rm.unit                      AS recipe_unit,
       COALESCE(rm.pack_size, 1)    AS per_purchase_unit,
       ROUND(rm.current_stock, 3)   AS book_recipe_units,
       ''                           AS counted_qty
FROM   raw_materials rm
WHERE  COALESCE(rm.is_active, 1) = 1
  AND  NOT EXISTS (
         SELECT 1 FROM store_category_map m
         JOIN store_locations s ON s.id = m.store_id
         WHERE s.is_active = 1
           AND REPLACE(REPLACE(REPLACE(LOWER(TRIM(m.category)), ' ', ''), '-', ''), '_', '')
             = REPLACE(REPLACE(REPLACE(LOWER(TRIM(rm.category)), ' ', ''), '-', ''), '_', ''))
ORDER BY rm.category, rm.name;
-- 803 materials today
```

**Use the closing count, not Opening Stock, to re-base central.** Both would move the
number, but they are not equivalent:

- A **closing count**, once approved, posts a signed `adjustment` to
  `inventory_transactions` and moves `current_stock` by the delta. The Central Store
  variance report deliberately excludes `adjustment` from its theoretical, so re-basing is
  neutral there. This is the right instrument.
- **Purchases → Opening Stock** writes a `purchases` row. That inflates
  `purchases_to_date`, and therefore the theoretical, by the whole counted quantity. Use
  it to seed a brand-new material, not to re-base an existing one.

---

## 6. Step 6 — adopt each department's count as its opening

This is the cut-over itself: it writes one `opening` row per (department, material) and
stamps the building's boundary date.

**There is no screen for this yet — this is the one open handoff in the cutover.** The API
exists and is admin-gated; the button does not. Until it is built, an **admin** does it
from the browser: sign in, open any page of the app, press F12 for the developer console,
and paste one call per department. The call uses your existing signed-in session; nothing
is typed anywhere else, and no credential is involved.

> **Handoff:** build a cut-over screen that wraps `GET`/`POST
> /api/department-ledger/cutover` — the checklist, the dry-run preview and the per-department
> Run button. The route already returns everything such a screen needs, including a full
> dry-run plan. Settings → Purchasing links to this doc in the meantime.

**First, get the checklist and the department ids.** This is a plain read:

```js
await fetch('/api/department-ledger/cutover').then(r => r.json()).then(console.log);
```

It returns, per department: `id`, `name`, `status` (`not_started` / `partial` / `done`),
`materials_awaiting_opening`, `last_closing_count_date` and `pending_variance_approvals`.
It also returns `cutover_at` — blank until the first department is cut over.

**Second, dry-run one department.** This writes nothing and tells you exactly what would
happen:

```js
await fetch('/api/department-ledger/cutover', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    department_id: 'PASTE-THE-DEPARTMENT-UUID',
    cutover_date:  '2026-08-06',   // the date the count was taken, YYYY-MM-DD
    adopt_count:   true,           // use the count already recorded for that date
    dry_run:       true
  })
}).then(r => r.json()).then(console.log);
```

Read `would_open` (what will be written, in recipe units), `already_open`, `skipped` and
`warnings`. When it looks right, **remove the `dry_run` line and run it again.** The real
run answers with `opened`, each row carrying `on_hand_after` read back through the same
function every screen uses — so the response proves the opening landed rather than
asserting it.

Then re-run the checklist. Work down it until every department reads `done` with
`materials_awaiting_opening` at 0.

**If you would rather type the quantities than adopt a recorded count**, send `lines`
instead of `adopt_count`:

```js
body: JSON.stringify({
  department_id: '...', cutover_date: '2026-08-06',
  lines: [
    { material_id: '...', quantity: 12,  unit: 'kg' },   // unit is REQUIRED on packed
    { material_id: '...', quantity: 750, unit: 'ml' }    // materials. It will not guess.
  ]
})
```

### The refusals, and why each one is right

The call refuses loudly rather than doing something approximately correct. All of these
are answers, not errors to work around:

| It says | It means | What to do |
|---|---|---|
| `MOVED_SINCE_COUNT` | The department has issued or cooked since that count, so adopting it now would drop those movements out of the balance for good. | Take a fresh count dated today and adopt that, or send `lines` with what is on the shelf right now. |
| `OPENING_EXISTS` | This department already has an opening for some of those materials. One opening per material, ever. | Send `skip_existing: true` to finish the remainder, or record a closing count to re-base the ones already open. |
| `STORE_MAPPED_MATERIAL` | A liquor line is in the list. | Remove it. Count liquor on the store ledger. |
| `CUTOVER_DATE_BACKWARDS` / `CUTOVER_BEFORE_STAMP` | The date is earlier than an opening this department already has, or earlier than the building's boundary. | Use a date on or after the boundary. |
| `unit_required` on a line | The material has a real pack factor and a bare number is genuinely ambiguous. | Say `kg` or `BTL` explicitly. This guard is what stops a 1,000x error. |

### What the stamp does

The first successful run writes `settings.dept_ledger_cutover_at` once, from that first
opening row's own timestamp. That is the boundary. It is:

- **A hard floor on every balance.** No movement dated before it enters any department
  balance, even if someone later backdates a count past it.
- **The date every "history excluded" label on screen reads.**
- **Never re-stamped.** Departments cut over later simply anchor later. Moving the floor
  forward would retroactively delete movement from whichever department went first.

---

## 7. Step 7 — settle the approval queue, then prove it

**The central count: approve it.** It posts the delta and re-bases `current_stock`.

**The department counts: reject them.** The screen will tell you why —
*"<department>'s balance is already anchored on a closing count, so this count has ALREADY
moved the department's stock on its own. Approving would take the difference off a second
time."* The count *is* the anchor. Rejecting changes nothing; it just closes the row.

**Then prove the rail is consistent** (admin, read-only, writes nothing):

```js
await fetch('/api/department-ledger/check').then(r => r.json()).then(console.log);
```

It asserts that the cached `department_materials.on_hand` still equals the raw signed sum
of the ledger, flags any negative balance, flags any liquor row that has leaked onto the
department rail, and checks the audit chain. Tiny differences are labelled
`within_rounding_noise` — that is float dust from two writers rounding differently, not a
lost gram. Anything else is a defect to diagnose, not a number to tidy: this endpoint has
no repair button on purpose, because snapping the cache back to the sum would erase the
only evidence of whatever split them.

Then open **Reports → Department Variance** and **Inventory → Department Stock** and
confirm the departments read their counted figures.

---

## 8. Requisitions half-issued across the boundary

**Leave them alone. Do not reverse and re-issue.** This is handled by construction, and
the alternative is actively wrong.

**Why leaving it works.** The issue ledger stamps `baseline_line_qty` on the *first* row it
ever writes for a line, from whatever `quantity_issued` already held. Only the increment
issued *after* the cutover moves stock. Worked through:

> A line requested 7 kg. The store issued 5 kg yesterday (before the cutover). Today you
> count the kitchen — the 5 kg is physically on its shelf, so it is in the opening
> balance. You also count central — the 5 kg is not on the store's shelf, so the re-based
> central figure already excludes it. Tomorrow the store issues the remaining 2 kg:
> central −2, department +2. Department ends at 7. Central lost 2. Both correct.

**Why "reverse and re-issue" is wrong.** Undoing that line moves nothing (see section 9),
but it does zero `quantity_issued`, so the line reappears in the store queue as unissued.
Re-issuing the full 7 kg then debits central 7 and credits the department 7 — on top of
the 5 kg the department's opening count already contains. The department reads 12 for 7 kg
of food, and central is charged for 5 kg that left the building before the cutover.

**So the rule is: never undo a line that was issued before the cutover.** If you undo one
by accident, do not re-issue it. Leave `quantity_issued` at 0 and, if the department is
genuinely short, raise a fresh requisition for the quantity actually being handed over now.

---

## 9. Reversing an issue

### Reversing a PRE-cutover issue moves nothing and records nothing

All **14,149** historic issued lines were imported with a `quantity_issued` value and have
no issue-ledger row. There are **1,620** requisitions sitting at `fulfilled`.

Undo one of them and: central gets nothing back, the department is credited nothing, no
ledger row is written, and no error is shown. `quantity_issued` goes to 0 and that is all.

**This is correct, not a gap.** The reversal is clamped to what this rail actually took
from central for that line — which is nothing, because the rail did not exist yet. Giving
grams back would manufacture stock that never left the store. (Measured: on ALMOND, a
g/kg material with pack 1000, removing that clamp took `current_stock` from 4,000 to 5,000
and the department balance to −1,000.) It is the no-backfill rule doing its job.

### Reversing a POST-cutover issue can be REFUSED, and does not clamp

Undo and store-Reject pull goods back from a department to central. If the kitchen already
cooked them, there is nothing to hand back. The server **refuses** with a message naming
the material, the kitchen and the quantity:

> *Cannot reverse 4 of PANEER: Akan Continental holds only 1.5 of PANEER (2.5 has since
> been cooked). Reverse 1.5 or less, or record a department count first.*

(The quantities are in recipe units — grams, millilitres, pieces — and the screen converts
them to purchase units before it shows them to the storekeeper.)

The refusal appears inline on the line on the Store Requisitions screen. Nothing is saved
— the whole action rolls back, and `quantity_issued` stays exactly as it was.

It refuses rather than quietly reversing what it can, because the route writes
`quantity_issued` *before* it asks stock to move. A silent clamp would commit a line
reading "0 issued" against grams that never came back, and the two rails would disagree
with nothing on screen to show it.

**The limit is per material, not per requisition.** Without lot tracking, requisition A's
flour and requisition B's flour are the same flour, so A's consumption can legitimately
block B's reversal. That is physically true, which is why the message says "the department
holds only X" and never "you consumed this line".

**A fulfilled requisition can be reversed.** Undo and reject accept `fulfilled`; issue and
defer still do not. Without this, the ordinary mistake — the storekeeper issues the last
line, the requisition auto-fulfils, he immediately sees the quantity was wrong — would have
no in-app correction on 1,620 of 1,630 requisitions.

**Party requisitions cannot be reversed here** even when fulfilled. Their stock moved on
the party rail, which this one skips entirely; zeroing `quantity_issued` would strand the
party transfer with no way to re-fire it.

---

## 10. Day-one behaviour changes

### Numbers that change

| What | How it changes |
|---|---|
| **Central stock, everywhere** | Falls, often below zero. It now means "what the store itself holds", not "what the outlet holds". Inventory, Stock Overview, Low Stock, the dashboard count, total stock value, the Inventory CSV. |
| **Central Store variance report** | Renamed, and the formula changed: `theoretical = purchases − requisition issues − central wastage − party − staff meals`. Recipe consumption is **out** of the central formula (it no longer touches central) and is reported alongside as a diagnostic instead. Left as it was, the first count after cutover would have called every gram ever issued to a kitchen shrinkage. **This is a shipped report whose numbers change — look at it before you trust the first one.** |
| **Days of cover / Smart Reorder** | Now compares central stock against central *outflow* (issues), not against kitchen consumption. Without this fix the same event would have lowered the numerator and been the denominator: materials tripping "under 7 days" went 38 → 97 in simulation, with 46 going negative, and those rows draft straight into a purchase order. |
| **Department Stock** (`/inventory/department-stock`) | Ledger-backed. A material with no count and no opening reads **"not counted yet"**, not 0 — the old "received in the last 30 days" fallback is gone, because it looked like a balance and was not one. Pre-cutover issues appear as a separate greyed, non-additive column: *"Issued before <date> (not in this balance)"*. |
| **Inventory CSV** | The `current_stock` column now means central holding. A banner sentence in the export states the cutover date and says so. Do not put a pre-cutover and a post-cutover export in the same sheet. |
| **`reorder_level`** | Unchanged by the code, but its *meaning* has changed to "central store buffer" rather than "whole outlet". All 107 materials that carry one are already below it, so until you re-base them the Low Stock list has no signal — everything is red, so nothing is. |

### New behaviour you will notice

- **A void is refused once food has been cooked.** If any line on the order carries a
  recipe-deduction stamp, the void is blocked and names the kitchen. A void after service
  would otherwise leave a permanent, unexplained department debit that reads as theft.
  A compensating credit is deliberately *not* built: that is a second movement path with
  its own guards, and it does not belong inside a cutover.
- **Butchering refuses a department-held carcass.** A carcass issued on a requisition is
  already on the kitchen's shelf; closing a batch on it would debit central a second time
  for the gross weight and credit the cuts into the wrong pool. Break the carcass down
  while it is still central-store stock, then requisition the cuts.
- **Wastage and staff meals can now be recorded against a department.** Set the department
  and the grams come off *that department's* ledger. Leave it blank and central is debited,
  as before — because the store genuinely does find rotten stock on its own shelf. Both
  tables held zero rows at the time of the change, so there is no history to reinterpret.
  Use the department option for anything the kitchen was already holding; otherwise the
  gram is removed from central a second time and that kitchen's apparent variance is
  inflated by exactly the wasted quantity.
- **Requisition edits are less likely to dead-end.** The "has stock moved" guard on cancel,
  edit and chef-reject now tests the *net* movement rather than "did a record ever exist".
  A line that was issued and fully undone is no longer permanently frozen with advice
  ("undo the issued lines first") that could never have worked.
- **The Purchase-to-Issue Log tells the truth about skips.** A consumption that moved
  nothing shows as `stock_moved 0` with its reason, and gets its own "CONSUMPTION
  (skipped)" stage naming the station. It used to print `1` over all of them.
- **Settings → Purchasing** shows a read-only status line where the switch used to be:
  whether the department opening balances have been recorded, and when.

### Reports that do NOT change — re-verified against the shipped code

Each of these was re-read after the change, not carried forward from the old note.

- **Sales vs Purchase / Sales vs Consumption.** Zero diff, and it is structural: the
  `inventory_transactions` row for every consumed ingredient is written by the caller loop
  *outside* the branch that changed, on every path including the skips. Both write sites
  carry a comment saying so. Gating that row would collapse recipe-to-date to zero and
  report the whole purchase history as shrinkage.
- **Daily Roll-up.** Untouched file. Reads `inventory_transactions` types
  `sale / party / staff_meal / wastage`, all of which are written exactly as before —
  including department wastage, which still records its `inventory_transactions` row so the
  wastage does not vanish from the audit.
- **Department Consumption** (`/department-consumption`). Untouched file. Aggregates
  `requisition_items.quantity_issued` directly and never reads a stock balance.
- **Closing-stock valuation.** Untouched file. Prices a *counted* quantity off purchase
  history; it has never read `current_stock`.
- **Issued Items Log.** Written on every issue regardless of whether stock moved, and it
  always was — the old flag never gated it.
- **Liquor / TGBCL store reports.** The store rail is carved out of both legs of this
  change and posts nothing to it.

---

## 11. Two gaps left open on purpose

Neither blocks the cutover. Both are recorded here rather than half-fixed inside it.

### a. A sub-recipe inherits the parent dish's department

The department is resolved once per sale, from the sold line's station, and every
sub-recipe ingredient under that dish is charged to the same department.

That is right while a sauce is made in the same kitchen that plates the dish. It is wrong
the moment a shared prep kitchen makes it for several stations: the consuming station's
department is debited, not the one that actually held the goods.

**Harmless today** — `recipe_sub_recipes` holds zero rows. It will first bite in Kitchen
Production, where a batch is produced in one department and drawn by others. Fixing it
means resolving a department per sub-recipe rather than per sale.

**Until then:** if you start using sub-recipes across kitchens, expect the prep kitchen to
look like it under-consumed and the plating kitchen to look like it over-consumed by the
same amount. Reconcile them at the count.

### b. The PO-receive party duplicate is untouched

`src/app/api/purchase-orders/[id]/receive/route.ts` contains a third implementation of
party consumption — it debits central and writes a `party_consumption` row when a PO tied
to a party requisition is received. The party rail already has two other implementations,
all deduping on `inventory_transactions.type = 'party_consumption'`.

**It is deliberately not fixed here.** Parties are out of scope for department stock by
decision, and quietly rewriting a shipped path that the owner has not asked about would
break the no-undo rule. It is a follow-up, not a cutover item.

**Until then:** the existing dedupe on `party_consumption` is what keeps it from
double-debiting today. If a party's central consumption ever looks doubled, this is the
first place to look.

---

## 12. What "reversing the cutover" actually means

**There is no switch to flip back.** Say this plainly, because it is the part that
surprises people:

> Turning this off is a **code change and a deploy**, not a setting. And even then, it does
> not put back stock that has already moved. The reverse is *"stop and recount"*, never
> *"flip it back and the numbers return"*.

The two edits that made central lose the gram at issue and the department lose it at
consumption **cannot be split**. All **131 of 131** direct recipe-ingredient materials are
also requisition-issued, so shipping half of a revert removes every gram twice.

```sql
-- measured, read-only
WITH ing AS (SELECT DISTINCT material_id m FROM recipe_ingredients WHERE COALESCE(is_default,1) = 1)
SELECT (SELECT COUNT(*) FROM ing) AS recipe_ingredient_materials,
       (SELECT COUNT(*) FROM ing
         WHERE m IN (SELECT material_id FROM requisition_items
                      WHERE COALESCE(quantity_issued,0) > 0)) AS also_requisition_issued;
-- 131 | 131
```

If you ever need to unwind it: revert both edits together, then take a fresh full physical
count of central *and* of every department, and re-base from the counts. Budget for the
count. There is no bulk unwind, and the department ledger is deliberately append-only —
nothing rewrites history.

---

## 13. Cutover-day checklist

```
[ ] 2a  Variance-approval queue drained to zero
[ ] 2b  Unit Audit finished and locked
[ ] 2c  Station -> Department map reviewed; sushi/terracegrill decided;
        liquor and kitchen left UNMAPPED
[ ] 2d  Everyone who reads a stock screen has been told central will read low

[ ] 4   Every department physically counted, recorded on the Department
        Closing Sheet (counted zeroes recorded as 0, liquor excluded)
[ ] 5   Central physically counted, recorded as a Store/Overall closing count

[ ] 6   Dry-run the cutover for each department; read would_open
[ ] 6   Run it for real; repeat until GET /api/department-ledger/cutover
        shows every department 'done' and materials_awaiting_opening 0
[ ] 6   cutover_at is stamped (Settings -> Purchasing shows the date)

[ ] 7   Central variance row APPROVED
[ ] 7   Department variance rows REJECTED (the screen explains why)
[ ] 7   GET /api/department-ledger/check is clean (or only rounding noise)

[ ] 8   Department Stock reads the counted figures
[ ] 8   Department Variance loads and shows its data-gap labels, not accusations
[ ] 8   Test requisition: issue 1 unit -> central falls by 1, that department
        rises by 1, Issued Items Log shows the line
[ ] 8   Undo that same test line -> central rises by 1, department falls by 1
[ ] 8   Central Store variance report: read it, and compare the new formula
        against what you expect BEFORE relying on it
```

---

## 14. Where this lives in the code

Cited by file and symbol rather than line number, because these files move. Every entry
below was checked against the working tree with the command in the right-hand column.

| What | Where | Check it with |
|---|---|---|
| Central debit at issue; the reversal refusal | `src/lib/issue-stock.ts` — `applyIssueDelta` | `grep -n "export function applyIssueDelta" src/lib/issue-stock.ts` |
| Net-movement guards on cancel / edit / reject | `src/lib/issue-stock.ts` — `lineHasMovedStock`, `requisitionHasMovedStock` | `grep -n "export function lineHasMovedStock\|export function requisitionHasMovedStock" src/lib/issue-stock.ts` |
| The department ledger: post, balance, caps | `src/lib/dept-ledger.ts` — `postDeptLedger`, `deptOnHand`, `assertReversible`, `DeptReversalBlocked`, `cutoverAt` | `grep -n "export function postDeptLedger\|export function deptOnHand\|export function assertReversible\|export class DeptReversalBlocked\|export function cutoverAt" src/lib/dept-ledger.ts` |
| Station → department resolution; skip recording | `src/lib/dept-ledger.ts` — `resolveStationDepartment`, `recordConsumptionSkip` | `grep -n "export function resolveStationDepartment\|export function recordConsumptionSkip" src/lib/dept-ledger.ts` |
| Recipe consumption debits the department | `src/lib/db.ts` — `deductInventoryForSale`, its inner `applyDeduct` | `grep -n "export function deductInventoryForSale\|const applyDeduct =" src/lib/db.ts` |
| Department balance screen data | `src/lib/dept-stock.ts` — `computeDeptStock`, `getDeptLedgerCutoverAt` | `grep -n "export function computeDeptStock\|export function getDeptLedgerCutoverAt" src/lib/dept-stock.ts` |
| The cut-over call (GET checklist / POST openings) | `src/app/api/department-ledger/cutover/route.ts` | `grep -n "export async function GET\|export async function POST" src/app/api/department-ledger/cutover/route.ts` |
| The drift check | `src/app/api/department-ledger/check/route.ts` | `grep -n "export async function GET" src/app/api/department-ledger/check/route.ts` |
| Station map API and screen | `src/app/api/settings/station-departments/route.ts`, `src/app/settings/station-departments/page.tsx` | `ls src/app/settings/station-departments/page.tsx` |
| Department Variance report and page | `src/app/api/department-variance/route.ts`, `src/app/department-variance/page.tsx` | `grep -n "export async function GET" src/app/api/department-variance/route.ts` |
| Central Store variance formula | `src/app/api/variance-report/route.ts` — `REPORT_TITLE`, `central_outflow_to_date` | `grep -n "REPORT_TITLE = \|central_outflow_to_date =" src/app/api/variance-report/route.ts` |
| Count approval: delta, not absolute set | `src/lib/variance-approval.ts` — `varianceApprovalBlock`, `approveVariance` | `grep -n "export function varianceApprovalBlock" src/lib/variance-approval.ts` |
| Void refused after cooking | `src/app/api/dine-in/orders/[id]/void/route.ts` | `grep -n "recipe_deducted_at IS NOT NULL" src/app/api/dine-in/orders/\[id\]/void/route.ts` |
| Butchering refuses a department-held carcass | `src/app/api/butchering/route.ts` | `grep -n "DEPARTMENT-HELD CARCASS" src/app/api/butchering/route.ts` |
| Wastage / staff meal department routing | `src/app/api/wastage/route.ts`, `src/app/api/staff-meals/items/route.ts` | `grep -n "department_id" src/app/api/wastage/route.ts \| head -3` |
| Unit Audit posts an adjustment, never a rewrite | `src/app/api/unit-audit/route.ts` | `grep -n "type: 'adjustment'" src/app/api/unit-audit/route.ts` |
| Store screen no longer clamps the issue to zero | `src/app/requisitions/page.tsx` | `grep -n "bookStock > 0 ? Math.min" src/app/requisitions/page.tsx` |
| Fulfilled is reversible, not issuable | `src/app/api/requisitions/[id]/store-issue/route.ts` — `okStatuses` | `grep -n "okStatuses" src/app/api/requisitions/\[id\]/store-issue/route.ts` |
| The refusal shown to the storekeeper | `src/app/store-requisitions/page.tsx` — `BLOCKED_CODE` | `grep -n "BLOCKED_CODE" src/app/store-requisitions/page.tsx` |
| Days-of-cover basis fix | `src/lib/crm-analyst-data.ts` — `outlet_on_hand` | `grep -n "outlet_on_hand" src/lib/crm-analyst-data.ts \| head -3` |
| Ledger schema, indexes, station seed, skips table | `src/lib/db.ts` — `department_material_transactions`, `station_dept_seed_v1`, `consumption_skips` | `grep -n "department_material_transactions ADD COLUMN\|station_dept_seed_v1\|CREATE TABLE IF NOT EXISTS consumption_skips" src/lib/db.ts` |
| The settings row left inert | `src/lib/db.ts` | `grep -n "requisition_deduct_at_issue" src/lib/db.ts` |
| Untouched: PO-receive party duplicate (gap b) | `src/app/api/purchase-orders/[id]/receive/route.ts` | `grep -n "'party_consumption'" src/app/api/purchase-orders/\[id\]/receive/route.ts` |

**To re-verify the whole table in one go**, run every command in the right-hand column;
each must print at least one line. A reference that prints nothing is a reference that has
rotted — fix the document, do not delete the row.
