# Requisition Print — build state

Branch `req-print-1110`, worktree `~/Desktop/Claude/fnb-reqprint`, based on origin/main af05b8f.
Owner's words: "Start a New TASK Give Print Option For the All Requisitions made to Store."

## 2026-11-10 ~14:30 IST — discovery (read-only) finished

- Data: `GET /api/requisitions?id=X` returns one requisition + every line (requested,
  chef_approved_qty, quantity_issued, issue_history, unit, material purchase unit/pack),
  filtered by `requisitionVisibility` (dept-hierarchy.ts). The list form takes
  `inbox=store`, `status`, `department_id`, `from`, `to`, `purpose`. The store desk
  (`/store-requisitions`) already loads `inbox=store` + every detail with `?id=`.
- So a print page that calls these SAME APIs shows exactly what the viewer can already
  see — no new access rule needed.
- Page access: a sub-path such as `/requisitions/print` or `/store-requisitions/print`
  inherits its parent's grant (canAccessPage prefix rule) → no new catalog/Sidebar row.
- Existing print pattern: `/grn/print/[id]`, `/purchase-orders/[id]/print` — client page,
  fetch API, `@media print { @page A4 }`, `.no-print`, auto `window.print()`.
- 80 mm bridge (`public/print-bridge.mjs` 2.8.1): doc types bill / kot / tspl|raw only.
  Per-machine (localhost:9920) — the Store PC would need its own bridge + thermal printer.
- Store desk shows NO money (issue log with ₹ is mgmtOnly) → print carries no ₹.
- Units: lead with PURCHASE unit (lineUnits() on store desk; line qty is in ri.unit).
- Local data: avg 10 lines per requisition, max 101.

## ~15:10 IST — owner decided (ruling #126 in memory rulings file)
Slip + Print all · A4/PDF · Store desk + Requisitions detail panel · anyone who can see it.

## ~15:40 IST — built (uncommitted, branch req-print-1110)
- NEW `src/app/store-requisitions/print/RequisitionPrintSheet.tsx` — the slip (shared).
- NEW `src/app/store-requisitions/print/page.tsx` — `?ids=…&ctx=…` (Store desk prints).
- NEW `src/app/requisitions/print/page.tsx` — `?ids=…` (detail panel print).
- NEW `src/app/api/requisitions/print-people/route.ts` — email→name for visible reqs only.
- EDIT `src/app/store-requisitions/page.tsx` — Printer import; `printAllHref` memo;
  "Print all (N)" in the filter bar; card header wrapped in a flex div + Print link.
- EDIT `src/app/requisitions/page.tsx` — Printer import; Print link in detail action row
  (~line 1700; fnb-approvalextras edits ~845-855 only → no overlap).
- tsc exit 0. check-purchase-units CLEAN, and PROVED to scan the slip (a planted
  grams cell in a scratch copy fails it).

## ~16:00 IST — verified on a COPY (scratchpad/rp, :3951; production-code baseline scratchpad/base, :3952)
- Seeded 5 reqs via real APIs (part-issued w/ HOD trim + HOD-rejected line + defer;
  submitted; approved; draft; 2-dept party fulfilled). seed.mjs / tokens.json in rp/.
- Access matrix 9 real users: slip loads == own list for all; print page open/blocked ==
  parent screen for all ("ALL MATCH"); signed-out → /login; print-people 401 signed out.
- Real Chrome PDF (Page.printToPDF): one slip per page, purchase units, watermark on
  not-approved, names not emails. Screens 1280 + 375 checked.
- FIX: card Print first sat beside the header → wrapped REQ numbers (3 lines @1280,
  4 @375; production 1 / 2). Moved to its own slim row under the header → now
  IDENTICAL to production line counts (geom.mjs vs geom-base.mjs).
- FIX: slip header req number nowrap; phone hint "Slide the table sideways…".
- Clicks in real Chrome open new tabs: Print all (6 slips), Print slip (1), detail Print (1).

## ~16:00 IST — gate (copy of gate.sh: scratchpad/gate/rpgate.sh) — mine == production baseline
tsc 0 · all suites same as base (run-tests 74/2 SAME 2 failures on base; report-builder
crashes on base too) · routed-requisition 74/74 both (run from harness/reqprint/) ·
desk-rule 744,117 both · next build OK both.

## ~16:00 — 2 adversarial reviewers → fixed
- statusWords 'fulfilled' now = desk deliveryState (store cuts only; "Closed" not
  "nothing issued"); store_processed with nothing issued → "With Store — nothing issued yet".
- Issued-by: history names + store_processed_by when store-process left no history;
  time labelled "Last hand-over" / "Store processed" / none; system: stamps never print.
- Cancelled → Balance "—", no "Promised for" remark.
- Delivered-direct closed line → desk wording, not "Rejected by store"; part delivered direct remark.
- Mgmt gate ON + party chef_approved → "HOD approved — waiting for Management" + AWAITING
  MANAGEMENT watermark.
- Failures: 404 vs other counted apart; no auto-print when anything is left out; paper note.
- MAX_PRINT_IDS 120 (src/lib/requisition-print.ts) — nginx 8 KB request line; desk label
  "Print first 120 of N" beyond it. ctx capped at 80 chars. Watermark anchored near top.
- Card Print row pointer-events fix (6 px overlap).
Re-verified: real scenarios F/G/H/I + crafted J/K/L/M (Chrome Fetch interception) +
matrix/parity + layout = production.

## 2026-11-10 — owner said "Deploy"
origin/main still af05b8f (nothing new to merge). Re-checked before the commit: tsc 0 ·
check-purchase-units CLEAN · check-boot-migrations CLEAN · no db/seed/migration/roles/
page-catalog/Sidebar file touched · public/preview.html not tracked.
This commit is the deployed one: confirm with https://fnb.akanhyd.com/api/build-info.
