# Guest Feedback & Service Recovery — BUILD STATE

Durable state for the module. **Read this file first on every resume.** It survives disconnects,
sleep and context loss. Update §4 and §6 at the end of EVERY lane, not at the end of a phase.

---

## 0. 🛑 THE DEPLOY GATE

Owner, 2026-09-21, verbatim: **"Use another Task to Build this and Deploy after I tell to 'Deploy
Feedback Module'"**

**BUILD ONLY.** Never push, never merge to `main`, never `gh workflow run deploy.yml` with any of this
staged. Only the owner, using those exact words, lifts the gate.

This is the **fifth** concurrent gate. Every carve anywhere in this repo must prove zero paths for:
gated liquor (`lq_`), Akan Party Manager (`src/app/party-manager`, `src/lib/pm/`), FSSAI
(`src/app/fssai`, `src/lib/fssai`, `api/fssai`), Bill Handover, and this module.

**Gate on MODULE PATHS, never a bare word.** Grepping the word `fssai` returns ~20 legitimate hits —
the FSSAI licence number printed on bills — which nearly caused a false gate breach. Ours:
`src/app/feedback`, `src/app/api/feedback`, `src/lib/feedback`, table prefix `gf_`.

---

## 1. HARD RULES

1. **Worktree:** `/Users/shashankreddy/Desktop/Claude/fnb-feedback`, branch `guest-feedback`. NEVER
   touch `/Users/shashankreddy/Desktop/Claude/fnb-controller` — it is the owner's production checkout
   and carries ~94 dirty files of other gated work.
2. **COMMIT AT THE END OF EVERY LANE.** On 2026-09-17 a concurrent agent's `git checkout -- .`
   destroyed 797 uncommitted lines of FSSAI P1; it was recovered only by luck from a Turbopack cache.
   Uncommitted is the one place git cannot protect you.
3. **NEVER** run `git checkout -- .` / `restore` / `reset --hard` / `clean` / bare `git stash` — the
   stash stack is SHARED across worktrees and sessions. Use a WIP commit instead.
4. **NEVER** `npm run predev` or `rm -rf .next` — predev deletes the cache that saved P1.
5. **DON'T CHANGE PRODUCTION MAPPINGS.** Departments, station→department and roles are the owner's to
   set in the app. Read them; never write them.
6. **Schema errors are SWALLOWED SILENTLY** in `initializeSchema()` (`src/lib/db.ts`). There is no
   migration framework. ASSERT every table and column exists after boot — never assume.
7. **DB safety:** snapshot ONLY with `sqlite3 "file:<path>?mode=ro" "VACUUM INTO '<dest>'"`; a plain
   `cp` loses the WAL → *"database disk image is malformed"*. Verify `purchases=2165`,
   `raw_materials=952`. `DB_PATH` is `process.cwd()/fnb-controller.db`, so a server booted here writes
   THIS worktree's db. Never boot one in the production checkout.
8. **`node_modules`:** `rsync -a --link-dest=...` — Turbopack REJECTS a symlinked `node_modules`
   (*"points out of the filesystem root"*).
9. **Auth:** `src/proxy.ts` guards **PAGES, NOT APIs**, and `canAccessPage` **fails open four ways**.
   Every route must gate itself. No path may contain `print` — `proxy.ts:~147`
   `pathname.includes('/print')` makes any such path PUBLICLY UNAUTHENTICATED **and CSRF-exempt**
   (it currently exposes 14 API routes). No path may end `.png/.jpg/.json` (a second carve-out).
   CSRF = cookie `fnb_csrf` + header `x-csrf-token`; add the module's API prefix to
   `CSRF_REQUIRED_PREFIXES` or every write is forgeable. *(Bill Handover shipped without that line and
   a POST with no CSRF header reached app code — measured.)*
10. **Sidebar/catalog drift:** a page is gated by `src/lib/page-catalog.ts` but the nav list lives in
    `src/components/Sidebar.tsx`. Catalog-only = gated but invisible. **Edit BOTH.**
11. **`tsc --noEmit` is the ONLY type gate** — `next.config.ts` sets `ignoreBuildErrors: true`.
12. **Server hygiene (this destroyed three fleets):** stalled agents orphan their Next dev servers
    (0.4–2 GB each). 39 accumulated → load 124 on a 10-CPU box → every new agent stalled with a
    misleading *"no progress for 180000ms"*. Boot **at most one** server on your **assigned port**,
    and **kill it when done**. ⚠️ `ppid=1` alone does NOT mean orphan — `npm exec` wrappers show
    `ppid=1` while perfectly alive. The reliable signal is a worktree path belonging to a **completed**
    fleet. Never kill a server whose path is the production checkout: that is the owner's own preview.
13. **Evidence or it did not happen** — command plus its real output, including HTTP status lines.

---

## 2. WHAT ALREADY EXISTS — measured 2026-09-21, do not re-derive

The module is almost entirely a **read** over existing POS data. The owner's three eligibility
triggers map onto real columns exactly:

**`orders`** — `id · outlet_id · order_number · table_id · status · order_type · bill_type · covers ·
server_id · server_name · subtotal · tax_total · discount · total · payment_method · settled_at ·
voided_at · notes · created_at · updated_at · guest_name · guest_mobile · service_charge ·
service_charge_reason · discount_pct · discount_approved_by · client_ref · origin · **bill_printed_at**
· held_at · booking_id · **bill_requested_at** · **bill_requested_by** · bill_seen_at · bill_seen_by ·
auto_close_reason`

| Owner's trigger | The real column |
|---|---|
| "At least 4–5 food/drink items have been ordered" | `COUNT(order_items)` for the order |
| "Guest has asked for the bill" | `orders.bill_requested_at IS NOT NULL` |
| "Bill has been generated" | `orders.bill_printed_at IS NOT NULL` |
| Pax · Captain · Table Open | `covers` · `server_name` · `created_at` |

**`order_items`** — `id · order_id · menu_item_id · recipe_id · name · **station** · quantity ·
unit_price · tax_value · line_total · status · notes · created_at · kot_id · prep_minutes · fired_at ·
completed_at · recipe_deducted_at · cgst_value · sgst_value · kitchen_sent_at · served_at · scan_code`

`station` is how **Food vs Drinks** is split (bar/beverage stations vs kitchen stations). Station→
department mapping is the owner's production config — **read it, never write it**.

**`restaurant_tables`** — the tables master (NOT `dine_tables`; that name does not exist).

**`roles`** — `id · name · base_role · page_access · is_head_chef · is_store_manager · is_system ·
is_active · sort_order · description · can_request_discount · max_discount_pct ·
can_approve_requisitions`. Note: the tier column is **`base_role`**, not `tier`.

Existing roles: `Administrator · Bar Manager · Captain · Cashier · Floor Manager · Head Chef · Manager
· Staff · Store Manager`.

⚠️ **THERE IS NO "GRE" ROLE.** See §7 Q1 — this is an owner decision, and there is a precedent: for
Bill Handover he said *"You create an 'Accounts' role in Settings → Roles and I gate on it."*

**Patterns to match, not reinvent:** the Captain app (`src/app/captain`) is the mobile-first model the
owner asked this to resemble. `src/lib/api.ts` (`api()`/`apiJson()`) injects the CSRF header on
state-changing methods — every client write must go through it.

---

## 3. THE SPEC — 4 pages, and the owner's own words where they are rulings

**Objective:** ensure the GRE or Floor Manager **visits every eligible table**, records feedback
against the **items actually ordered**, and tracks any dish/drink returned, remade or replaced.

**The cycle:** Table Eligible → GRE Visits → Feedback Taken → Problem Item Selected →
Returned/Remade/Replaced → GRE Revisits → Guest Satisfaction Checked → Issue Closed → Management
Analysis.

### Page 1 — Floor Feedback (mobile, Captain-app-like)
Table cards: Table no · Pax · Captain · Items Ordered · Table Open time · status.
Statuses: `Not Ready · Feedback Due · Feedback Taken · Issue Raised · Follow-Up Required`.

> 🔒 **HARD CONSTRAINT, the owner's own list.** The GRE/Manager may view ordered items but has
> **READ-ONLY ACCESS**. They cannot: *place orders · cancel items · change quantity · modify KOT ·
> modify bill · apply discounts*. **This must be enforced server-side, not merely hidden in the UI.**

### Page 2 — Take Feedback
Overall: `Excellent · Good · Average · Poor`. Categories: `Food · Drinks · Service · Ambience`.
**Not every field mandatory — normal positive feedback must finish in 10–20 seconds** via
**Everything Good** → Submit.

Ordered items shown split Food / Drinks. Tapping an item opens: rating
(`Good · Average · Poor`), issue (`Taste · Too Spicy · Too Salty · Cold · Dry · Overcooked ·
Undercooked · Presentation · Quantity · Delay · Other`), free comment.

**Action taken:** `No Action Required · Item Returned · Same Item Remade · Fresh Item Replaced ·
Different Item Replaced · Item Cancelled`.

**Remade/Replaced ⇒ automatically create `Follow-Up Required`, and the complaint stays OPEN until the
GRE revisits.** On revisit: *"How was the item after replacement/remake?"*
(`Excellent · Good · Average · Still Poor`) then *"Is the Guest Happy Now?"*
(`Yes - Happy · Partially Happy · No - Still Unhappy`). Happy ⇒ close. Still Unhappy ⇒ stays open for
Manager attention.

### Page 3 — Feedback Tracker
Header counts: Active Tables · Feedback Due · Feedback Taken · Issues Raised · Follow-Up Required.
Records per table. Filters: `All · Pending Feedback · Completed · Negative Feedback · Follow-Up
Required · Resolved`, plus Floor · GRE · Manager · Captain.
**GRE/Manager progress table:** Eligible Tables · Feedback Taken · Pending · Coverage %.

### Page 4 — Admin Analytics & Reports (reports live HERE, not a 5th page)
Dashboard counts incl. Coverage %, rating split, negative item feedbacks, Returned/Remade/Replaced,
Guest Happy After Replacement, Still Unhappy, Pending Follow-Ups.
Filters: Today · Yesterday · This Week · This Month · Custom, plus Floor · GRE · Manager · Captain ·
Food/Drinks · Menu Item.
Menu Item Analysis (Sold · Feedbacks · Negative · Returned · Remade · Guest Happy), clickable through
to the real comments. **Must compute Negative Feedback % and Return/Remake Rate** — *"total complaints
alone can be misleading."*
Most Common Problems · Most Complained Items · Most Appreciated Items.
Service Recovery Analysis — what happened AFTER negative feedback.
Downloads (Excel/PDF): Daily · Weekly · Monthly · Menu Item · Returned/Remade · Negative Feedback ·
GRE/Manager Performance · Guest Recovery.

> 🔒 **THE FAIRNESS RULING, in the owner's words.** *"The system should **not** judge GRE performance
> based on positive feedback. A GRE should never avoid recording negative feedback because it affects
> their performance."* Measure only: Feedback Coverage · Tables Visited · Follow-Ups Completed ·
> Issues Properly Recorded · Guest Recovery Follow-Up. **Any metric that makes recording a complaint
> look bad for the recorder is a defect.**

**Mobile UX:** large buttons, quick-select, ordered-item cards, voice-to-text comments where
supported, clear status indicators, sticky Submit. Minimal typing.

---

## 4. PHASES — work the FIRST row that is `PENDING`

| # | Phase | Status | Evidence |
|---|---|---|---|
| P0 | Recon — read-only: POS/order/table/role wiring, Captain-app patterns, export helpers, the read-only enforcement surface | PENDING | |
| P1 | Foundation — `gf_` schema, nav in BOTH files, RBAC, 4 page shells | PENDING | |
| P2 | Page 1 Floor Feedback + the READ-ONLY guarantee, proved server-side | PENDING | |
| P3 | Page 2 Take Feedback + item-level complaints + action + follow-up lifecycle | PENDING | |
| P4 | Page 3 Feedback Tracker + coverage | PENDING | |
| P5 | Page 4 Analytics + the 8 reports | PENDING | |
| P6 | Full adversarial verification + carve-readiness | PENDING | |

**🛑 After P6 the build STOPS and waits for "Deploy Feedback Module".**

---

## 5. RESUME INSTRUCTIONS

1. Read §0 (gate), §1 (rules), §2 (measured facts), §4 (next phase).
2. `cd /Users/shashankreddy/Desktop/Claude/fnb-feedback && git log --oneline -5` to see real progress —
   trust commits over prose.
3. Reap orphaned dev servers from COMPLETED fleets (see rule 12, and its `ppid=1` caveat).
4. Work ONE phase. Commit at the end of EVERY lane. Update §4 and §6 with real command output.

---

## 6. LOG — newest last

- **2026-09-21** — Worktree created at `93962d2` on branch `guest-feedback`, clean. Gate recorded in
  memory. Schema recon done and written into §2: all three of the owner's eligibility triggers map to
  real columns (`bill_requested_at`, `bill_printed_at`, `COUNT(order_items)`); tables master is
  `restaurant_tables`; `roles.base_role` (not `tier`); **no GRE role exists**. P0 queued.

- **2026-09-21 — P1 Lane A (schema · nav · RBAC · CSRF).** Purely additive: +281 lines, 0 deletions,
  across `src/lib/db.ts` (the `gf_` block, last in `initializeSchema`, own try/catch),
  `src/lib/feedback.ts` (NEW — the shared vocabulary, lifecycle rules, gate predicates and row types,
  **zero imports**), `src/lib/page-catalog.ts`, `src/components/Sidebar.tsx`, `src/proxy.ts`.
  - **Schema, asserted after boot** (rule 6 — errors are swallowed silently). `gf_visits` 26/26 cols,
    `gf_item_feedback` 19/19, `gf_follow_ups` 18/18, none unexpected; 14 indexes; all three UNIQUE
    indexes proved to BITE (second insert refused with `UNIQUE constraint failed`).
  - **No regression:** census of the pristine snapshot vs post-boot — tables 213 → 216 (exactly the
    three `gf_`), **0 tables vanished, 0 columns lost** across all 213 pre-existing tables,
    `purchases=2165 raw_materials=952`, `PRAGMA integrity_check` → `ok`.
  - **CSRF line is live** (the one Bill Handover shipped without): valid session + NO `x-csrf-token`
    → **403**; with the double-submit pair → 404 (route not built yet, so CSRF passed). Rule-9 trap
    demonstrated live: a hypothetical `/api/feedback/reports/print` and `/api/feedback/board.json`
    both answered **404 with no session at all** (public!), while `/api/feedback/visits` answered
    **401**. No feedback path may ever contain `print` or end `.json`.
  - **RBAC proved over HTTP:** no session → all four pages 307 → `/login`; STAFF session →
    `/feedback` 200, `/feedback/tracker` 200, `/feedback/analytics` **307 → `/?forbidden=`** (and its
    child `/feedback/analytics/x` too); ADMIN → all 200.
  - **Nav pairing (rule 10):** catalog and Sidebar lists are identical and in the same order —
    `/feedback · /feedback/take · /feedback/tracker · /feedback/analytics` — and each covers a real
    Lane B route file. `npx tsc --noEmit` exit 0, zero output. Server on port 3913 killed, port free.
  - **§7 answers now encoded, still reversible:** Q3 recorded (`replacement_menu_item_id` +
    `replacement_item_name`); Q2/Q4 are code-defaulted settings keys (`feedback_item_threshold` = 4,
    `feedback_settled_grace_minutes` = 30) so an absent key means the default, never "off" — the
    `captain_area_lock` failure mode; Q5 settled in the DDL (**Floor is `restaurant_tables.zone`;
    there is no `floor` column**). **Q1 is the one-line swap:** `GRE_ROLE_NAMES` in
    `src/lib/feedback.ts`, plus `isReadOnlyFeedbackUser()` — inert until the owner creates the role,
    which is what P2 must call inside the ~13 open POS handlers.
  - ⚠️ **ONE THING LEFT UNDONE, deliberately:** `src/app/feedback/enums.ts` (Lane B, `9a8713c`) still
    holds a SECOND copy of the vocabulary. Its own header says it must become
    `export * from '@/lib/feedback';`. Every wire value in `src/lib/feedback.ts` is byte-identical, so
    the repoint is a no-op — but two lists are alive right now and only the `src/lib` one can be
    imported server-side. **P2 must close this.**

---

## 7. OPEN DECISIONS — owner only

1. **There is no GRE role.** Options: (a) he creates a "GRE" role in Settings → Roles and we gate on
   it — the precedent he chose for Bill Handover's "Accounts"; (b) gate on the existing
   `Floor Manager` + `Manager` + `Administrator`; (c) add an `is_gre` flag to `roles` beside
   `is_head_chef`. **Recommendation: (a)**, consistent with his own precedent and it needs no schema
   change. Until settled, build so the gate is a one-line swap.
2. **Eligibility item threshold: 4 or 5?** He wrote "4-5". Recommend making it an admin setting with a
   default of 4, so he tunes it without a deploy.
3. **"Different Item Replaced"** — should the replacement item be *recorded* (which item replaced
   which) or is the action label enough? Recording it costs one column and makes the Menu Item
   Analysis honest about what was given instead.
4. **Does a voided or settled table still accept feedback?** A table settled before the GRE arrives is
   the commonest way coverage is lost. Recommend a short grace window after `settled_at`.
5. **Floor** appears in every filter list but Floor lives on `restaurant_tables` — confirm the field
   and that it is populated before building the filter.
