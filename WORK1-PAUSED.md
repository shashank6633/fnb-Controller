# WORK1 — PAUSED (resume with "resume work1")

Paused mid-flight on 2026-07-31, on top of deployed commit `43d6706`.
**Nothing here is committed or deployed.** All 11 files below are uncommitted working-tree edits.

## What Work1 is

The 4 requirements from the owner's spreadsheet screenshot:

| # | Module | Requirement | Status |
|---|---|---|---|
| 1 | Recipe Mgmt / Sub Recipe | Display Sub Recipe UOM in Purchase Price & Qty | built, UNVERIFIED |
| 2 | Purchase Order | Add PO Date & Expected Delivery Date | built, UNVERIFIED |
| 3 | GRN | Display Vendor Name before the item list | built, UNVERIFIED |
| 4 | GRN | Vendor-wise GRN & Bill Number | **already shipped in 43d6706**; only visibility polish here |

## Files touched (all uncommitted)

Foundations I wrote myself (reviewed, tsc-clean):
- `src/lib/db.ts` — added `purchase_orders.delivery_date TEXT` (nullable, no backfill, PRAGMA-guarded)
- `src/lib/pack-units.ts` — header contract now carves sub-recipe INGREDIENT lines out of the
  recipe-unit exemption (the sub-recipe YIELD stays recipe-basis)
- `src/app/api/sub-recipes/route.ts` — all 3 ingredient SELECTs widened with pack meta, AND
  every ingredient row now carries `rate_per_purchase_unit` / `rate_source` / `rate_as_of`
  derived through `src/lib/closing-valuation.ts`

Written by the build fleet (NOT yet verified by me):
- `src/app/api/purchase-orders/route.ts`
- `src/app/api/recipes/export/route.ts`
- `src/app/api/requisitions/[id]/store-process/route.ts`
- `src/app/grn/page.tsx`
- `src/app/purchase-orders/[id]/print/page.tsx`
- `src/app/purchase-orders/page.tsx`
- `src/app/recipes/page.tsx`
- `src/app/requisitions/page.tsx`

## The one finding worth keeping

`average_price × pack_size` is WRONG for **50 of 281** packed materials — they hold the
purchase-unit price in the ₹/recipe-unit column, and all 50 have zero purchase history.
Naive maths gives COCO POWDER ₹846,570/kg. So sub-recipe rates go through the
`closing-valuation.ts` ladder instead: latest `purchases.unit_price` → `average_price × packFactor`
→ none, with `rate_source` travelling alongside so the screen can flag an unverified rate.

Proven on the fixture: Chicken Breast reads ₹340/kg (what we actually paid), not the ₹113.64
the naive formula gives. PICKLED GINGER (kg/kg, pack 1.5 — the both-halves trap) correctly
does NOT convert.

## Test fixture left in the LOCAL db — DELETE BEFORE COMMITTING

Sub-recipe `ZZTEST Bulk Gravy`, id `9e0f6e5b6dc646b0a9af64285871ee9a`, 4 ingredient rows.
It exists because `sub_recipe_ingredients` has ZERO rows locally (the 21-07 data loss), so
requirement 1 is otherwise invisible on screen.

```bash
node -e "const db=require('better-sqlite3')('fnb-controller.db');const id='9e0f6e5b6dc646b0a9af64285871ee9a';db.prepare('DELETE FROM sub_recipe_ingredients WHERE sub_recipe_id=?').run(id);db.prepare('DELETE FROM sub_recipes WHERE id=?').run(id);console.log('fixture removed')"
```

## To resume

1. Read the build fleet's own report (it finished after the pause):
   `/private/tmp/claude-501/-Users-shashankreddy-Desktop-Claude/4e5ab911-b7fe-4b46-b4c9-3846b2556c97/tasks/wq88u2x0r.output`
   and its journal at `.../subagents/workflows/wf_af32f385-4e3/journal.jsonl`
2. Re-point the recipes page at `rate_per_purchase_unit` — the agent was briefed to use the
   naive `purchasePrice(average_price, mat)`; the API now supplies the correct rate and the
   brief was superseded. **This correction has not been applied yet.**
3. Gates: `rm -rf .next/dev/types && npx tsc --noEmit`, `node scripts/check-purchase-units.js`,
   `node scripts/check-boot-migrations.js`, `npx next build`
4. On-screen verify all 4 against the fixture, delete the fixture, then adversarial-verify.
5. Party Manager guard before any deploy: `git ls-files | grep -cE "party-manager|src/lib/pm/"` must be 0.

## Also still open (pre-existing, from earlier today)

- Direct Items row figures are labelled, not repaired — the numbers on a `suggestion_differs`
  row still come from the heuristic material. Real fix is server-side in the enrichment pass.
- 11 vendors have zero item mappings; strict mapping will refuse their PO lines.
- Two boot-time backfills rewrite data on every restart (`db.ts:657`, `db.ts:785`) — pre-existing,
  0 rows affected today.
- Issue-ledger backfill decision: forward-only vs replay from 1 April.
