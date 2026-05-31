# SOP: Mutton Carcass → Meat Cuts → Yield Tracking

**Owner:** Head Chef / Butcher
**Frequency:** Every time a whole / half carcass is received from the vendor
**Why this matters:** Carcass cost is paid per kg of whole animal. Selling items consume specific cuts (leg, chops, mince, etc.). Without yield tracking we can't:
- Know the true cost-per-kg of each cut
- Spot vendor shortages (under-weight delivery)
- Catch butchering loss (waste % too high)
- Cost a biryani / kebab correctly

---

## 1. Roles

| Role | Responsibility |
|---|---|
| **Receiving clerk** | Weighs whole carcass on arrival, logs vendor + invoice |
| **Butcher** | Breaks down carcass; weighs each cut + waste before storing |
| **Head Chef** | Verifies the breakdown sheet, signs off, enters into system |
| **Store Manager** | Spot-checks 1 carcass / week against the SOP yield table |

---

## 2. Equipment

- Digital platform scale (0–50 kg, 10 g accuracy) — calibrated weekly
- Digital tabletop scale (0–10 kg, 1 g accuracy) — for small cuts
- Labelled trays / tubs, one per cut category
- **Carcass Breakdown Sheet** (paper form, see Appendix A)
- Permanent marker for date + batch ID labels

---

## 3. The Process

### Step 1 — Receive the carcass (Receiving clerk)
1. Park the platform scale, **tare it to zero**.
2. Weigh the whole carcass **as delivered** (with skin off, gut removed — i.e. dressed weight).
3. Cross-check against the vendor invoice. Tolerance: **±2%**.
4. If variance > 2%, do **not** sign the invoice. Call the vendor and the store manager.
5. Assign a **Batch ID** in this format:
   `MUT-YYYYMMDD-<vendor-code>-<seq>`
   Example: `MUT-20260520-RAJBR-01`
6. Tag the carcass with the Batch ID on a sticker.
7. Fill rows 1–4 of the Carcass Breakdown Sheet (date, vendor, batch ID, gross weight).
8. Move carcass to butcher's table within **30 minutes** of arrival.

### Step 2 — Break down the carcass (Butcher)
Cut the carcass into the **standard 7 cuts** in this order. Weigh each on the tabletop scale **before** moving to its storage tray:

| # | Cut name | Inventory SKU | Notes |
|---|---|---|---|
| 1 | **Leg (raan)**       | MEAT-MUT-LEG    | Boneless preferred; if bone-in, note "bone-in" |
| 2 | **Shoulder**         | MEAT-MUT-SHLD   | Used for curries, biryani |
| 3 | **Chops (chaap)**    | MEAT-MUT-CHOP   | Rib + loin chops, count + weigh |
| 4 | **Ribs**             | MEAT-MUT-RIB    | For shorba / soups |
| 5 | **Mince (keema)**    | MEAT-MUT-MINCE  | Trimmings + neck meat ground together |
| 6 | **Offal**            | MEAT-MUT-OFFAL  | Liver, kidney, heart (if accepted) |
| 7 | **Bones (for stock)**| MEAT-MUT-BONE   | Save what kitchen will use |

**Waste streams** (weigh separately, do NOT mix into cuts above):

| Waste type | Why we weigh it |
|---|---|
| **Fat / suet**       | Some used for nihari fat; rest discarded |
| **Sinew / silver-skin** | Trimmed and discarded |
| **Discarded bone**   | Bones not going to stock |
| **Spoilage / unfit** | Any portion rejected for quality |

### Step 3 — Reconcile the breakdown (Butcher + Head Chef)
1. Sum all cut weights + all waste weights.
2. Compare against the **gross weight from Step 1**.
3. Acceptable reconciliation gap: **≤ 1.5%** (moisture loss + scale drift).
4. If gap > 1.5%, find it now — likely an unweighed tray.
5. Head Chef signs the bottom of the Breakdown Sheet.

### Step 4 — Compute yields (Head Chef)
For every cut: `yield_% = (cut_weight / gross_weight) × 100`

Compare against the **AKAN Standard Yield Table**:

| Cut       | Standard Yield % | Alert if outside |
|-----------|------------------|------------------|
| Leg       | 24 – 28          | <22 or >30       |
| Shoulder  | 16 – 19          | <14 or >21       |
| Chops     | 12 – 14          | <10 or >16       |
| Ribs      | 7 – 9            | <5 or >11        |
| Mince     | 14 – 17          | <12 or >19       |
| Offal     | 4 – 6            | <3 or >7         |
| Bones     | 8 – 10           | <6 or >12        |
| **Waste** | **6 – 10**       | **>12 = investigate butcher** |

If any cut is outside the alert range, write the reason on the sheet (e.g. *"Animal smaller than standard, leg %)* and notify Store Manager.

### Step 5 — Enter into system (Head Chef, within 1 hour)
On the F&B Controller app:

1. Go to **GRN** screen
2. Receive vendor invoice as `MEAT-MUT-CARCASS` (raw whole) at gross weight × invoice rate
3. Then go to **Production / Butchering** screen *(see system design below)*
4. Pick batch ID, click "Break down carcass"
5. Enter weight of each cut + waste category
6. Click Save → system:
   - **Debits** `MEAT-MUT-CARCASS` by gross weight
   - **Credits** each cut SKU by its weight
   - Auto-distributes the carcass cost across cuts pro-rata by weight (so leg cost/kg ≈ shoulder cost/kg — they all share the carcass rate). *Optional weighted variant: assign a "value coefficient" to each cut so premium cuts absorb more cost.*
   - Logs waste in `wastage` table for the daily wastage report

### Step 6 — Storage + labelling (Butcher)
1. Each cut goes into its labelled tray with this sticker:
   ```
   Cut:        Leg (MEAT-MUT-LEG)
   Batch:      MUT-20260520-RAJBR-01
   Cut on:     20-05-2026 / 11:40 AM
   Weight in:  6.85 kg
   Use by:     22-05-2026
   ```
2. Trays go directly into the meat chiller (≤ 4°C).
3. Bones for stock → freezer if not used same day.

---

## 4. Daily / Weekly Checks

### Daily (Head Chef, end of day)
- All carcasses received today have a completed Breakdown Sheet
- All sheets are signed
- All breakdowns are entered into the system

### Weekly (Store Manager)
- Run the **Butchering Yield Report** (Reports → Yield → Mutton)
  - Avg yield % per cut for the week vs. standard table
  - Total waste % for the week — target ≤ 8%
  - Variance by butcher (if multiple butchers)
- Investigate any cut consistently outside the standard band for 3+ batches in a row
- Spot-check one live butchering session per week

### Monthly (Store Manager + Finance)
- Pull butchering cost summary for the month
- Compare implied cost/kg of cuts against menu costing
- If a cut's actual cost/kg has drifted >10% from menu cost, flag for menu re-cost

---

## 5. Red Flags

| Red flag | Likely cause | Action |
|---|---|---|
| Gross weight short by >2% repeatedly from one vendor | Vendor under-delivering | Switch to weigh-before-accept; consider penalty clause |
| Waste % > 12% repeatedly | Poor butchering / dull knives / animal quality | Retrain butcher; check knife sharpening schedule; talk to vendor |
| Leg / chop yield consistently low | Butcher diverting prime cuts | Audit; CCTV review of butchering area |
| Reconciliation gap > 1.5% repeatedly | Scale drift OR missing tray | Recalibrate scale; re-train Step 3 |
| Cut weight on sticker ≠ system entry | Manual entry error | Add a 2nd-person verification step |

---

## Appendix A — Carcass Breakdown Sheet (paper form)

```
═══════════════════════════════════════════════════════════════
       AKAN — MUTTON CARCASS BREAKDOWN SHEET
═══════════════════════════════════════════════════════════════
Date:          _______________   Batch ID: _____________________
Vendor:        _______________   Invoice #: ____________________
Received by:   _______________   Butcher:   ____________________

(1) Gross dressed weight (kg):  _______ . _____
(2) Invoice weight (kg):        _______ . _____
(3) Variance (1 − 2):           _______ . _____   (must be ≤ ±2%)

───────────────── CUTS ─────────────────────────────────────────
Leg          (MEAT-MUT-LEG)    _____._____ kg   yield ___ . __ %
Shoulder     (MEAT-MUT-SHLD)   _____._____ kg   yield ___ . __ %
Chops        (MEAT-MUT-CHOP)   _____._____ kg   yield ___ . __ %
Ribs         (MEAT-MUT-RIB)    _____._____ kg   yield ___ . __ %
Mince        (MEAT-MUT-MINCE)  _____._____ kg   yield ___ . __ %
Offal        (MEAT-MUT-OFFAL)  _____._____ kg   yield ___ . __ %
Bones        (MEAT-MUT-BONE)   _____._____ kg   yield ___ . __ %

───────────────── WASTE ────────────────────────────────────────
Fat / suet                     _____._____ kg
Sinew / silver-skin            _____._____ kg
Discarded bone                 _____._____ kg
Spoilage / unfit               _____._____ kg

───────────────── RECONCILE ────────────────────────────────────
Sum of cuts + waste:           _____._____ kg
Gap vs gross weight:           _____._____ kg   (must be ≤ 1.5%)

───────────────── SIGN-OFF ─────────────────────────────────────
Butcher signature:    _____________________
Head Chef signature:  _____________________
Entered in system:    ☐ Yes   GRN #: __________
═══════════════════════════════════════════════════════════════
```

---

## How this maps to the F&B Controller system

A new **Production / Butchering** module is needed. High-level schema:

```
butchering_batches (
  id, batch_id, source_material_id (=MEAT-MUT-CARCASS),
  vendor_id, grn_id, gross_weight, invoice_weight,
  butcher, head_chef, status,
  created_at, completed_at
)

butchering_outputs (
  id, batch_id, output_type ('cut' | 'waste'),
  material_id (NULL for waste categories),
  waste_category (NULL for cuts),
  weight, cost_allocated, yield_pct
)
```

**Transaction flow when a batch is saved:**
1. Reduce `raw_materials.current_stock` for `MEAT-MUT-CARCASS` by gross weight
2. For each cut: increase `raw_materials.current_stock` for that cut SKU by its weight
3. Allocate total carcass cost across cuts (default: pro-rata by weight; optional: by value coefficient)
4. Write a row to `inventory_transactions` for each movement (so audit log is preserved)
5. Write waste-category rows to `wastage` table so daily wastage rolls up correctly

**New screen:** `/butchering` (under Store section in sidebar)
- List of recent batches with status (open / closed)
- "New Batch" button → wizard that mirrors the SOP steps
- Yield report (weekly + monthly)

**Want me to build the Butchering module next?** It would take roughly the same effort as the Party P&L feature you just got: ~1 DB table, 2 API routes, 1 page with a wizard + a report. Reply *"yes, build butchering"* and I'll plan + ship it.
