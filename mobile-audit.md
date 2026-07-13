# Mobile Audit — 375×812 (iPhone-class), all catalog pages

**Date:** 2026-07-13 · **Method:** every page in `src/lib/page-catalog.ts` walked logged-in as admin at 375×812 in dev (:3001); DOM measured for horizontal overflow, clipped tables, off-screen buttons, modal height/reachability, tap targets, fixed widths; primary add/edit modals opened & cancelled (nothing saved); findings cross-checked against source. `/dine-in/order` skipped (prefix-only). `/captain` and `/print/agent` have their own standalone layouts — both render correctly at 375px.

**Audit-only pass — no fixes applied.**

**Root-cause pattern (drives most defects):** list/detail `<table className="w-full">` rendered directly inside a `rounded-xl` card that is often `overflow-hidden`, with **no `overflow-x-auto` wrapper**. At 375px the table's natural width (400–950px) is hard-clipped — right-hand columns and row-action buttons are invisible and unreachable (no sideways scroll possible). Second pattern: add/edit **modals with no `max-h` + internal scroll + sticky footer**, so Save/Cancel sit 150–620px below the fold. "Latent" = table code is unwrapped but the dev DB had no rows to render; it will clip in production where data exists.

---

## P0 — Unusable on phone (primary actions unreachable)

| Page | Defect | Severity | Suggested fix pattern |
|---|---|---|---|
| `/users` | 9-col users table renders 798px wide, hard-clipped at 375px: Position/Pages/Last-login columns AND the row action icon buttons (edit / deactivate) are fully off-screen with no horizontal scroll — user admin impossible on phone (confirmed visually + DOM: 5 action buttons at x≥375) | P0 | Wrap table in `div.overflow-x-auto`; better: `hidden sm:block` table + mobile card list (name/role + kebab actions), as `/crm/guests` already does |
| `/departments` | 7-col table renders 551px, clipped: Members/Open-Reqs/Status cols and edit/delete/HOD action buttons off-screen, unreachable (6 buttons at x≥375) — departments can't be edited on phone | P0 | Same: `overflow-x-auto` wrapper or responsive card list; actions into leading column/kebab |
| `/admin/data-hygiene` | Issues table (448px+) clipped inside card; the **"Fix" links — the page's entire purpose — are fully off-screen** (6 measured at x≥375); Issue text truncates mid-word | P0 | `overflow-x-auto`; on mobile stack each issue as a card with Fix link below text |
| `/settings/categories` | 11 unwrapped tables 505–534px: mapping/rename columns clipped, inline rename `input.w-48` renders past right edge (right=514), action buttons off-screen — category manager unusable | P0 | `overflow-x-auto` per table; make rename input `w-full min-w-0`; stack mapping rows on mobile |

## P1 — Painful (data hidden, long-scroll modals, will-break-with-data)

| Page | Defect | Severity | Suggested fix pattern |
|---|---|---|---|
| `/audit` | 6-col log table renders 945px, clipped: only When + Event visible; actor / entity / details unreadable, no h-scroll | P1 | `overflow-x-auto`; or 2-line stacked rows on mobile (event+actor top, details below) |
| `/department-consumption` | Summary (465px/8-col) and date-register (424px/7-col) tables clipped inside `overflow-hidden` cards — value/qty columns invisible | P1 | `overflow-x-auto` on both table wrappers |
| `/department-consumption` | Filter row: Material select label measures 516px wide and runs past the right screen edge (right=549) | P1 | Filter container `grid-cols-1` on mobile; `w-full max-w-full min-w-0` on selects |
| `/grn` | "New Ad-hoc GRN" modal panel is 1397px tall — Save sits ~620px below the fold; no `max-h`/internal scroll/sticky footer (reachable only via long scroll, easy to think the form is broken) | P1 | Modal shell: `max-h-[90dvh] overflow-y-auto` + sticky footer (`sticky bottom-0 bg-white border-t`) |
| `/grn` | Latent: GRN list table is 11-col and detail tables 8/6-col, all unwrapped inside `overflow-hidden` cards (empty in dev DB; will hard-clip in production) | P1 | `overflow-x-auto` wrappers (grn/page.tsx:110, 198, 502) |
| `/menu-items` | "New Item" modal 1197px tall; Save/Cancel at y=1255 (~445px below fold), no sticky footer | P1 | Same modal shell pattern |
| `/users` | "New User" modal 1029px tall; Save ~385px below fold | P1 | Same modal shell pattern |
| `/departments` | "New Department" modal 1082px tall; Save at y=1265 | P1 | Same modal shell pattern |
| `/purchase-orders` | "New PO" modal 995px tall; Save ~220px below fold | P1 | Same modal shell pattern |
| `/purchase-orders` | Latent: PO list table 11-col and detail 6-col unwrapped (purchase-orders/page.tsx:539, 919) | P1 | `overflow-x-auto` wrappers |
| `/party-events` | Latent: 5 unwrapped tables incl. 10-col fulfilment grid inside `overflow-hidden` cards (page.tsx:218, 277, 361, 443, 1111) — will clip badly once party data loads | P1 | `overflow-x-auto` wrappers |
| `/party-requisitions` | Latent: 11-col list table unwrapped (page.tsx:352); 6-col detail (471) | P1 | `overflow-x-auto` wrappers |
| `/party-approvals` | Latent: 7–8-col expanded approval tables unwrapped (page.tsx:454, 609) | P1 | `overflow-x-auto` wrappers |
| `/contracts` | Latent: 8-col contracts table unwrapped (page.tsx:148) | P1 | `overflow-x-auto` wrapper |
| `/butchering` | Latent: 9-col batches table unwrapped (page.tsx:108); 5-col at 577 | P1 | `overflow-x-auto` wrappers |
| `/wastage` | Latent: 8-col wastage log table unwrapped (page.tsx:194) | P1 | `overflow-x-auto` wrapper |
| `/requisitions` | Latent: admin detail-view line table ~10-col unwrapped (page.tsx:747) — approving/reviewing req lines on phone will clip qty/price columns | P1 | `overflow-x-auto`; plain-staff 3-col view is fine |
| `/food-consumption` | Latent: per-event items table (5-col) inside `overflow-hidden` card (page.tsx:230) | P1 | `overflow-x-auto` wrapper |

## P2 — Cosmetic / preventive

| Page | Defect | Severity | Suggested fix pattern |
|---|---|---|---|
| all modals (global) | Body scroll is not locked while a modal is open (`body{overflow:visible}` measured) — background page scrolls behind the dialog | P2 | Add `overflow-hidden` to body while open (or `overscroll-contain` on panel) |
| table pages (global) | Row-action icon buttons are `p-1` + 16px icon ≈ 24×24px (< 32px tap target) — /users, /departments, /settings/categories, /inventory, etc. | P2 | `p-2` / `min-w-8 min-h-8` on icon-only buttons |
| `/vendors` | "New Vendor" modal 926px tall — Save ~115px below fold (short scroll) | P2 | Same modal shell pattern |
| `/receiving-variance` | Vendor filter label/select 357px wide, runs ~19px past viewport edge (right=394) — clipped look, still tappable | P2 | `min-w-0 w-full max-w-full` on the label/select |
| `/settings/page-access` | Mono path badge span (108px) overflows its card edge (right=428) | P2 | `truncate max-w-full` on span; `min-w-0` on flex parent |
| `/units` | 3 unwrapped 4-col tables at 333px — fits 375 today with zero headroom (longer unit names will clip) | P2 | Preventive `overflow-x-auto` (units/page.tsx:120) |
| `/outlets` | 5-col table 340px unwrapped — near edge, no headroom (outlets/page.tsx:53) | P2 | Preventive `overflow-x-auto` |
| `/sales` | Two 317px summary tables unwrapped in `overflow-hidden` card (sales/page.tsx:1637) — fits today | P2 | Preventive `overflow-x-auto` |
| `/vendors/materials` | Unmatched-vendors panel table unwrapped (page.tsx:372), 3-col — fits today | P2 | Preventive `overflow-x-auto` |
| `/party-pnl` | Latent: 5-col recorded-consumption table in `overflow-hidden` card (page.tsx:342) | P2 | `overflow-x-auto` wrapper |
| `/store-requisitions` | History modal 4-col table unwrapped (page.tsx:997) — container scrolls y only | P2 | `overflow-x-auto` wrapper |
| `/requisitions` | Chef-approve modal line table unwrapped (page.tsx:1334); sample-transfers preview at 10px font (523) | P2 | `overflow-x-auto`; bump preview font on mobile |
| `/settings/roles` | "New role" expands a 3113px-tall inline form (Save is visible; reviewing the page-checklist is a very long scroll) | P2 | Collapse page-access sections into accordions on mobile |
| sidebar (global) | Drawer close button 20×20px tap target | P2 | `p-2` → ≥36px hit area |

---

## Counts

| Severity | Count |
|---|---|
| **P0 — unusable** | **4** |
| **P1 — painful** | **18** |
| **P2 — cosmetic/preventive** | **14** |
| **Total** | **36** |

## 10 worst pages (fix in this order)

1. `/users` — P0 table + P1 modal
2. `/departments` — P0 table + P1 modal
3. `/settings/categories` — P0, 11 clipped tables with inline inputs
4. `/admin/data-hygiene` — P0, Fix actions unreachable
5. `/grn` — P1 giant modal + 3 latent 6–11-col tables
6. `/department-consumption` — P1, 2 clipped tables + broken filter
7. `/audit` — P1, 60% of log table invisible
8. `/purchase-orders` — P1 modal + latent 11-col table
9. `/party-events` — P1, 5 latent unwrapped tables (10-col worst)
10. `/menu-items` — P1 modal (page list itself is fine)

## ALREADY CLEAN at 375px (verified — do not re-touch)

`/` (dashboard), `/dine-in/floor`, `/dine-in/requests`, `/dine-in/kitchen`, `/dine-in/offline-print`, `/dine-in/tables`, `/captain` (standalone tablet layout, adapts to phone), `/print/agent` (standalone), `/menu-items` (list page itself — table wrapped), `/recipes` (page + Add Recipe modal), `/direct-items`, `/dine-in/reconciliation`, `/parties`, `/purchases` (page + full-screen Add Purchase modal), `/inventory` (page + Add Raw Material modal fits), `/store-dashboard`, `/closing-stock`, `/daily-rollup`, `/unit-audit`, `/department-materials`, `/kitchen-production`, `/kitchen-production/dashboard`, `/kitchen-production/scan`, `/kitchen-production/reports` (screen UI; print output is desktop-by-design), `/reports`, `/menu-engineering` (720px table properly in scroller), `/variance-report`, `/staff-meals` (incl. modal), `/dine-in/kot-analytics`, `/dine-in/captain-performance`, `/eod`, all 9 `/crm/*` pages (incl. `/crm/guests` responsive card switch — the reference pattern), `/settings/print-design`, `/settings/integrations`, `/settings/qr-standees`, `/settings/customer-menu`, `/admin/reset`, `/login`, `/units` + `/outlets` + `/sales` pages render fine today (P2 preventive only).

**Also verified good:** `MaterialTypeahead` dropdown is mobile-safe (`max-w-[min(480px,calc(100vw-1.5rem))]`); CRM fixed-width tables all sit in `overflow-x-auto`; `/purchases` unit-audit warning table is inside a scroll container.

## Suggested fix batches

- **Batch 1 (P0):** add `overflow-x-auto` (or card-list switch) on /users, /departments, /admin/data-hygiene, /settings/categories.
- **Batch 2 (modal shell):** one shared pattern — `max-h-[90dvh] overflow-y-auto` + sticky footer + body scroll lock — applied to menu-items, users, departments, grn, purchase-orders, vendors modals.
- **Batch 3 (table wrappers):** mechanical `overflow-x-auto` sweep over the 17 latent/confirmed unwrapped tables (file:line references above).
- **Batch 4 (P2 polish):** filter-control widths, tap targets, page-access badge, roles accordion.
